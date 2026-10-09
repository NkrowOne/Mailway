import Database from 'better-sqlite3';
import { config } from '../config';

export const db: Database.Database = new Database(config.dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/**
 * Migraciones incrementales: cada entrada se ejecuta una sola vez, en orden.
 * Nunca se edita una migración ya publicada; se añade una nueva.
 */
const migrations: { id: string; sql: string }[] = [
  {
    id: '001-esquema-inicial',
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        max_domains INTEGER NOT NULL DEFAULT 1,
        max_mailboxes INTEGER NOT NULL DEFAULT 5,
        max_aliases INTEGER NOT NULL DEFAULT 10,
        mailbox_quota_mb INTEGER NOT NULL DEFAULT 1024,
        api_daily_limit INTEGER NOT NULL DEFAULT 500,
        api_per_minute_limit INTEGER NOT NULL DEFAULT 30,
        notes TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        contact_email TEXT NOT NULL DEFAULT '',
        plan_id TEXT NOT NULL REFERENCES plans(id),
        suspended INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'client')),
        client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
      );

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ip TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);

      CREATE TABLE domains (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        domain TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending_dns'
          CHECK (status IN ('pending_dns', 'active', 'error')),
        dkim_selector TEXT NOT NULL DEFAULT 'mail',
        dns_status_json TEXT NOT NULL DEFAULT '{}',
        last_checked_at INTEGER,
        verified_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_domains_client ON domains(client_id);

      CREATE TABLE mailboxes (
        id TEXT PRIMARY KEY,
        domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
        local_part TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        quota_mb INTEGER NOT NULL DEFAULT 1024,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
        created_at INTEGER NOT NULL,
        UNIQUE (domain_id, local_part)
      );
      CREATE INDEX idx_mailboxes_domain ON mailboxes(domain_id);

      CREATE TABLE aliases (
        id TEXT PRIMARY KEY,
        domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
        local_part TEXT NOT NULL,
        destinations_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (domain_id, local_part)
      );

      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL UNIQUE,
        key_hash TEXT NOT NULL,
        sender_mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
        smtp_password_enc TEXT NOT NULL,
        daily_limit INTEGER,
        revoked_at INTEGER,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_api_keys_client ON api_keys(client_id);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
        from_address TEXT NOT NULL,
        to_json TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
        error TEXT NOT NULL DEFAULT '',
        smtp_message_id TEXT NOT NULL DEFAULT '',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_messages_client ON messages(client_id, created_at);
      CREATE INDEX idx_messages_key ON messages(api_key_id, created_at);

      CREATE TABLE api_usage (
        api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (api_key_id, day)
      );

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        client_id TEXT,
        action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_audit_created ON audit_log(created_at);

      CREATE TABLE login_attempts (
        ip TEXT NOT NULL,
        attempted_at INTEGER NOT NULL
      );
      CREATE INDEX idx_login_attempts ON login_attempts(ip, attempted_at);
    `,
  },
  {
    id: '002-marca-blanca-y-alertas',
    sql: `
      -- Dominios propios de cada cliente (webmail o panel con su marca).
      -- Traefik los descubre sondeando /api/traefik/config de este panel.
      CREATE TABLE client_domains (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        hostname TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('webmail', 'panel')),
        status TEXT NOT NULL DEFAULT 'pending_dns'
          CHECK (status IN ('pending_dns', 'issuing', 'active', 'error')),
        detail TEXT NOT NULL DEFAULT '',
        last_checked_at INTEGER,
        activated_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_client_domains_client ON client_domains(client_id);

      -- Alertas del vigilante. dedupe_key evita repetir la misma alerta
      -- abierta; al resolverse se marca resolved_at en lugar de borrarla.
      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
        type TEXT NOT NULL,
        client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        remedy TEXT NOT NULL DEFAULT '',
        dedupe_key TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX idx_alerts_open ON alerts(resolved_at, created_at);
      -- Solo puede haber UNA alerta abierta por clave: el índice parcial hace
      -- que el dedupe lo garantice la base de datos, no la lógica.
      CREATE UNIQUE INDEX idx_alerts_dedupe
        ON alerts(dedupe_key) WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL;
    `,
  },
  {
    // Publicada en main antes de la 1.0: va antes que las de esta versión.
    // Los identificadores se comparan completos, así que dos «003-» conviven.
    id: '003-webmail-principal',
    sql: `
      ALTER TABLE client_domains ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0;
      CREATE UNIQUE INDEX idx_client_webmail_primary
        ON client_domains(client_id) WHERE is_primary = 1 AND kind = 'webmail';
    `,
  },
  {
    id: '003-integraciones-y-portal',
    sql: `
      -- Tokens de gestión: acceso por API (Skyway, scripts, agentes) con los
      -- mismos permisos que el usuario que los crea. Solo se guarda el hash.
      CREATE TABLE management_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        last_used_at INTEGER,
        last_used_ip TEXT NOT NULL DEFAULT '',
        revoked_at INTEGER
      );
      CREATE INDEX idx_management_tokens_user ON management_tokens(user_id);

      -- Cuentas de Cloudflare conectadas. client_id NULL = cuenta de la
      -- instancia (del administrador), utilizable para cualquier dominio cuya
      -- zona vea el token. El token va cifrado; token_hint son sus 4 últimos.
      CREATE TABLE cloudflare_accounts (
        id TEXT PRIMARY KEY,
        client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        token_enc TEXT NOT NULL,
        token_hint TEXT NOT NULL DEFAULT '',
        created_by TEXT,
        created_at INTEGER NOT NULL,
        last_verified_at INTEGER,
        last_error TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_cloudflare_accounts_client ON cloudflare_accounts(client_id);

      -- Dónde vive el DNS de cada dominio, cuando Mailway lo gestiona.
      ALTER TABLE domains ADD COLUMN cloudflare_account_id TEXT
        REFERENCES cloudflare_accounts(id) ON DELETE SET NULL;
      ALTER TABLE domains ADD COLUMN cloudflare_zone_id TEXT;
      ALTER TABLE domains ADD COLUMN dns_applied_at INTEGER;

      -- Ocupación de cada buzón, leída del motor (el motor es la fuente).
      ALTER TABLE mailboxes ADD COLUMN used_bytes INTEGER;
      ALTER TABLE mailboxes ADD COLUMN usage_checked_at INTEGER;

      -- Referencia a un sistema externo (p. ej. un proyecto de Skyway), para
      -- que las integraciones localicen «su» cliente sin duplicarlo.
      ALTER TABLE clients ADD COLUMN external_ref TEXT;
      CREATE UNIQUE INDEX idx_clients_external_ref
        ON clients(external_ref) WHERE external_ref IS NOT NULL;

      -- Enlaces de configuración de dispositivos: una URL que se envía al
      -- titular del buzón (o se abre con un QR) para configurar su correo.
      -- password_enc solo existe si se adjuntó la contraseña recién generada;
      -- se borra al caducar o al revocar el enlace.
      CREATE TABLE setup_links (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
        password_enc TEXT,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_opened_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX idx_setup_links_mailbox ON setup_links(mailbox_id);

      -- Sesiones del portal «Mi buzón»: el titular entra con su dirección y
      -- la contraseña del buzón (verificada contra el motor).
      CREATE TABLE mailbox_sessions (
        token_hash TEXT PRIMARY KEY,
        mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ip TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_mailbox_sessions_mailbox ON mailbox_sessions(mailbox_id);

      -- Contraseñas de aplicación de un buzón (móvil, una app de Skyway…):
      -- se revocan una a una sin tocar la contraseña principal. stored_secret
      -- es el secreto tal y como quedó en el motor ($app$…$<hash>), necesario
      -- para retirarlo; la contraseña en claro no se guarda nunca.
      CREATE TABLE app_passwords (
        id TEXT PRIMARY KEY,
        mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        stored_secret TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX idx_app_passwords_mailbox ON app_passwords(mailbox_id);
    `,
  },
  {
    id: '004-propiedad-de-dominios',
    sql: `
      -- Prueba de que el dominio es de quien lo da de alta (MX apuntando a
      -- este servidor o TXT de verificación). Sin ella no se crean buzones
      -- ni alias: si no, un cliente podría dar de alta un dominio ajeno y
      -- quedarse con el correo que otros clientes del servidor le envían.
      ALTER TABLE domains ADD COLUMN owner_verified_at INTEGER;

      -- Los dominios anteriores a esta versión que ya funcionaban o ya
      -- tenían buzones se consideran verificados, para no romper nada.
      UPDATE domains SET owner_verified_at = COALESCE(verified_at, created_at)
        WHERE verified_at IS NOT NULL
           OR id IN (SELECT domain_id FROM mailboxes)
           OR id IN (SELECT domain_id FROM aliases);
    `,
  },
  {
    id: '005-idempotencia-de-envios',
    sql: `
      -- Cabecera Idempotency-Key de /v1/send: la respuesta de cada envío se
      -- guarda 24 h POR CLAVE DE API, para que el reintento de una aplicación
      -- (un corte de red, un timeout) no envíe el mensaje dos veces. Del valor
      -- de la cabecera solo queda su hash; response_json es NULL mientras el
      -- envío está en curso.
      CREATE TABLE send_idempotency (
        api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status_code INTEGER,
        response_json TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (api_key_id, key_hash)
      );
      CREATE INDEX idx_send_idempotency_expires ON send_idempotency(expires_at);
    `,
  },
  {
    id: '006-formularios-web',
    sql: `
      -- Formularios de contacto para webs estáticas. La web publica una
      -- clave pública (mwf_…, no es un secreto) y el panel entrega cada
      -- mensaje en un buzón del propio cliente, con su remitente. Como las
      -- claves de API, cada formulario envía con una contraseña de aplicación
      -- propia del buzón (smtp_password_enc, cifrada). El secreto de
      -- Turnstile va cifrado: hay que recuperarlo para verificar cada envío.
      CREATE TABLE forms (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL UNIQUE,
        recipient_mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
        allowed_origins_json TEXT NOT NULL,
        subject TEXT NOT NULL,
        smtp_password_enc TEXT NOT NULL,
        turnstile_site_key TEXT,
        turnstile_secret_enc TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        submissions_count INTEGER NOT NULL DEFAULT 0,
        last_submission_at INTEGER,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_forms_client ON forms(client_id);

      -- Los mensajes de los formularios cuentan para el cupo diario del plan
      -- como los de la API; form_id dice de qué formulario salieron.
      ALTER TABLE messages ADD COLUMN form_id TEXT REFERENCES forms(id) ON DELETE SET NULL;
    `,
  },
  {
    id: '007-origen-de-los-envios',
    sql: `
      -- Los formularios tienen su propio cupo diario y ya no gastan el de la
      -- API: si lo gastaran, cualquiera que falsee el Origin dejaría al
      -- cliente sin /v1/send hasta el día siguiente. El origen de cada envío
      -- queda en su fila, porque form_id pasa a NULL al eliminar el
      -- formulario y esos mensajes no deben empezar a contar para la API.
      ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'form'));
      UPDATE messages SET source = 'form' WHERE form_id IS NOT NULL;
      CREATE INDEX idx_messages_form ON messages(form_id, created_at);
    `,
  },
  {
    id: '008-reservas-de-cloudflare',
    sql: `
      -- Dominios cuyo DNS de correo escribió el administrador con una cuenta
      -- de Cloudflare de la instancia (sus zonas). Esos registros (MX, TXT de
      -- verificación…) siguen en la zona aunque el dominio se borre, y bastan
      -- para «probar» la propiedad: sin esta reserva, otro cliente podría dar
      -- de alta el dominio y recibir y enviar su correo. Solo el cliente para
      -- el que se escribió (o el administrador) puede volver a darlo de alta.
      -- Sin claves foráneas a propósito: la reserva sobrevive al dominio y al
      -- cliente.
      CREATE TABLE cloudflare_reservas (
        domain TEXT PRIMARY KEY,
        client_id TEXT,
        account_id TEXT,
        zone_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- La 1.0 ya escribía en las zonas del operador (alta con «autoDns» o
      -- «Aplicar» en la ficha con una cuenta de la instancia) sin reservar
      -- nada: sin este relleno, al borrar uno de esos dominios tras actualizar,
      -- su MX y su TXT de verificación seguirían sirviendo a otro cliente. Se
      -- reservan para su cliente los que tienen el DNS aplicado con una
      -- cuenta de la instancia y también los que se quedaron sin cuenta (al
      -- desconectarla, cloudflare_account_id pasa a NULL): no se sabe si era
      -- la del operador, y reservarlo a su propio cliente solo obliga a que
      -- otro lo reciba de manos del administrador. Los dominios borrados antes
      -- de actualizar ya no están en la base y no se pueden reconstruir.
      INSERT OR IGNORE INTO cloudflare_reservas (domain, client_id, account_id, zone_id, created_at, updated_at)
        SELECT d.domain, d.client_id, d.cloudflare_account_id, d.cloudflare_zone_id, d.dns_applied_at, d.dns_applied_at
        FROM domains d
        LEFT JOIN cloudflare_accounts a ON a.id = d.cloudflare_account_id
        WHERE d.dns_applied_at IS NOT NULL
          AND d.cloudflare_zone_id IS NOT NULL
          AND (d.cloudflare_account_id IS NULL OR a.client_id IS NULL);
    `,
  },
  {
    id: '009-perfil-de-buzones',
    sql: `
      -- Foto del buzón: la pone el titular en el onboarding o en «Mi buzón»
      -- (o quien administra) y el webmail la muestra como avatar del
      -- remitente. Tabla aparte para que los listados de buzones no carguen
      -- las imágenes; solo leen updated_at para invalidar la caché.
      CREATE TABLE mailbox_photos (
        mailbox_id TEXT PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
        mime TEXT NOT NULL,
        data BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    id: '010-enlaces-recuperables',
    sql: `
      -- Token del enlace de configuración cifrado con la clave maestra, para
      -- que la administración pueda volver a enviarlo mientras siga activo.
      -- Se sigue buscando por token_hash; este campo se vacía al caducar o
      -- revocar el enlace. Los enlaces anteriores quedan sin él.
      ALTER TABLE setup_links ADD COLUMN token_enc TEXT;
    `,
  },
  {
    id: '011-invitaciones-de-clientes',
    sql: `
      -- Enlace de bienvenida de un cliente: la persona de contacto crea con él
      -- su acceso al panel y hace la puesta en marcha de su correo. Se busca
      -- por el hash del token; la copia cifrada permite a la administración
      -- volver a enviarlo mientras siga pendiente y se borra al usarlo,
      -- revocarlo o caducar.
      CREATE TABLE client_invites (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        token_hash TEXT NOT NULL UNIQUE,
        token_enc TEXT,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        opened_at INTEGER,
        accepted_at INTEGER,
        accepted_user_id TEXT,
        revoked_at INTEGER
      );
      CREATE INDEX idx_client_invites_client ON client_invites(client_id);
    `,
  },
  {
    id: '012-entrega-de-la-configuracion',
    sql: `
      -- Primer momento en que el titular demostró que tiene acceso al buzón
      -- (terminó el enlace de configuración, descargó el perfil de Apple,
      -- entró en «Mi buzón» o en el webmail) o en que se marcó a mano. La
      -- puesta en marcha del cliente lo usa para señalar qué buzones siguen
      -- sin configurar. Se vacía cuando el panel deja sin acceso a sus
      -- dispositivos (contraseña nueva o reinicio), no cuando la cambia el
      -- propio titular, que sigue teniéndolo.
      ALTER TABLE mailboxes ADD COLUMN configured_at INTEGER;

      -- Cuenta oculta configuration@<dominio> de cada dominio, desde la que se
      -- envían los correos de configuración. No es un buzón del cliente: no
      -- figura en mailboxes (ni en sus listados ni en el plan). La contraseña
      -- va cifrada porque hay que recuperarla para autenticarse en el SMTP
      -- del motor; nunca sale del servidor.
      CREATE TABLE remitentes_configuracion (
        domain_id TEXT PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
        password_enc TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- Correos de configuración enviados a los titulares: el último se
      -- enseña en el panel y la última hora cuenta para los límites (por
      -- buzón y por cliente). recipient es la dirección que eligió quien lo
      -- envió; nunca se guardan la URL, el token ni la contraseña.
      CREATE TABLE envios_configuracion (
        id TEXT PRIMARY KEY,
        mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
        error TEXT NOT NULL DEFAULT '',
        link_id TEXT,
        sent_by TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_envios_configuracion_mailbox ON envios_configuracion(mailbox_id, created_at);
      CREATE INDEX idx_envios_configuracion_client ON envios_configuracion(client_id, created_at);
    `,
  },
  {
    id: '013-webmail-automatico',
    sql: `
      -- Webmail de marca que alguien eliminó a mano. El alta automática
      -- (webmail.<dominio> de cada dominio con la propiedad comprobada) no
      -- vuelve a crear estos nombres; darlo de alta a mano lo saca de aquí.
      CREATE TABLE webmail_descartados (
        hostname TEXT PRIMARY KEY,
        client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );

      -- Interruptor por cliente del webmail automático (activado por
      -- defecto). Desactivarlo retira los que se crearon solos.
      ALTER TABLE clients ADD COLUMN webmail_automatico INTEGER NOT NULL DEFAULT 1;

      -- 1 = lo dio de alta el webmail automático, no una persona: son los
      -- que se retiran al desactivar el interruptor del cliente.
      ALTER TABLE client_domains ADD COLUMN automatico INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: '014-credenciales-locales',
    sql: `
      -- Copia propia del hash $6$ de la contraseña principal de cada buzón.
      -- Stalwart 0.16 devuelve los secretos enmascarados: sin esta copia el
      -- panel no podría comprobar contraseñas («Mi buzón», enlaces, webmail)
      -- sin pedirle al motor que autentique, y cada fallo contaría para su
      -- bloqueo automático de IPs. Va cifrada con la clave maestra: un hash
      -- de una contraseña elegida por una persona se puede atacar sin
      -- conexión. source: 'panel' (la fijó el panel) o 'motor' (copiada de
      -- Stalwart 0.15).
      CREATE TABLE credenciales_buzon (
        mailbox_id TEXT PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
        password_hash_enc TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('panel', 'motor')),
        updated_at INTEGER NOT NULL
      );

      -- Contraseñas de aplicación: stored_secret pasa a ser la referencia
      -- opaca con la que el motor la retira (en 0.15, el $app$…$<hash> que
      -- guarda). verifier es el $6$ del secreto, que no se puede revertir:
      -- con él «Mi buzón» reconoce una contraseña de aplicación sin el motor
      -- (las anteriores no lo tienen: el hash va dentro de stored_secret).
      -- engine_api es la API del motor en que se creó (NULL = antes de esta
      -- versión, es decir, Stalwart 0.15) e invalidated_at, cuándo dejó de
      -- funcionar porque el motor cambió de versión. invalidation_notified_at
      -- marca las que ya se avisaron por correo al titular.
      ALTER TABLE app_passwords ADD COLUMN verifier TEXT;
      ALTER TABLE app_passwords ADD COLUMN engine_api TEXT;
      ALTER TABLE app_passwords ADD COLUMN invalidated_at INTEGER;
      ALTER TABLE app_passwords ADD COLUMN invalidation_notified_at INTEGER;

      -- Lo mismo para la credencial SMTP interna de cada clave de API y de
      -- cada formulario: en qué API del motor se creó y, si la migración no
      -- pudo renovarla, desde cuándo no funciona.
      ALTER TABLE api_keys ADD COLUMN smtp_engine_api TEXT;
      ALTER TABLE api_keys ADD COLUMN smtp_invalidated_at INTEGER;
      ALTER TABLE forms ADD COLUMN smtp_engine_api TEXT;
      ALTER TABLE forms ADD COLUMN smtp_invalidated_at INTEGER;
    `,
  },
];

function runMigrations(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT id FROM _migrations').all() as { id: string }[]).map((r) => r.id),
  );
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        Date.now(),
      );
    });
    apply();
  }
}

runMigrations();

export function now(): number {
  return Date.now();
}
