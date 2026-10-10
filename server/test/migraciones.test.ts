import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ejecutarMigraciones } from '../src/core/db';

/*
 * Migraciones 016 y 017: el esquema del cambio de dominio. La rama que lo
 * trajo (1.3.0, sin publicar en main) lo creó con los ids
 * 009-recepcion-externa-y-copias-dns y 011-cambio-de-dominio, que en la 1.4
 * ya eran de otras migraciones. Un servidor que llegó a ejecutar esa rama
 * tiene el esquema y esos ids: al actualizar debe aplicar las de la 1.4 y
 * pasar por 016 y 017 sin errores y sin tocar sus datos. SQL copiado tal cual
 * de la rama.
 */

const SQL_009_RAMA = `
  ALTER TABLE domains ADD COLUMN recepcion_externa INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE cloudflare_copias (
    domain_id TEXT PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
    account_id TEXT,
    zone_id TEXT NOT NULL,
    borrados_json TEXT NOT NULL,
    creados_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

const SQL_011_RAMA = `
  CREATE TABLE domain_migrations (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    from_domain_id TEXT REFERENCES domains(id) ON DELETE SET NULL,
    to_domain_id TEXT REFERENCES domains(id) ON DELETE SET NULL,
    from_domain TEXT NOT NULL,
    to_domain TEXT NOT NULL,
    estado TEXT NOT NULL CHECK (estado IN ('preparando', 'listo', 'pasando', 'pasado', 'volviendo',
      'dando_de_baja', 'dado_de_baja', 'cancelada')),
    paso TEXT NOT NULL DEFAULT '',
    error TEXT,
    origen TEXT NOT NULL DEFAULT 'panel' CHECK (origen IN ('panel', 'skyway')),
    referencia_externa TEXT,
    creo_destino INTEGER NOT NULL DEFAULT 0,
    creo_webmail_id TEXT,
    permitir_instancia INTEGER NOT NULL DEFAULT 0,
    nombres_cloudflare_json TEXT NOT NULL DEFAULT '[]',
    direcciones_at INTEGER,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    listo_at INTEGER,
    pasado_at INTEGER,
    terminado_at INTEGER
  );
  CREATE UNIQUE INDEX idx_dm_from_abierto ON domain_migrations(from_domain)
    WHERE estado NOT IN ('dado_de_baja', 'cancelada');
  CREATE UNIQUE INDEX idx_dm_to_abierto ON domain_migrations(to_domain)
    WHERE estado NOT IN ('dado_de_baja', 'cancelada');
  CREATE INDEX idx_dm_cliente ON domain_migrations(client_id);
  CREATE TABLE domain_migration_items (
    migration_id TEXT NOT NULL REFERENCES domain_migrations(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL CHECK (tipo IN ('buzon', 'alias')),
    item_id TEXT NOT NULL,
    local_part TEXT NOT NULL,
    PRIMARY KEY (migration_id, tipo, item_id)
  );
  CREATE INDEX idx_dmi_item ON domain_migration_items(item_id);
  ALTER TABLE mailboxes ADD COLUMN usuario_motor TEXT;
  ALTER TABLE mailboxes ADD COLUMN usuario_cambiando_a TEXT;
  ALTER TABLE mailboxes ADD COLUMN login_anterior TEXT;
  ALTER TABLE mailboxes ADD COLUMN semilla_perfil TEXT;
  CREATE UNIQUE INDEX idx_mailboxes_usuario_motor ON mailboxes(usuario_motor)
    WHERE usuario_motor IS NOT NULL;
`;

function baseVacia(): Database.Database {
  const base = new Database(':memory:');
  base.pragma('foreign_keys = ON');
  return base;
}

function ids(base: Database.Database): string[] {
  return (base.prepare('SELECT id FROM _migrations ORDER BY id').all() as { id: string }[]).map((f) => f.id);
}

/** Tablas, columnas (nombre, tipo, obligatoria, valor por defecto) e índices, para comparar dos bases. */
function esquema(base: Database.Database): Record<string, unknown> {
  const salida: Record<string, unknown> = {};
  const tablas = base
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  for (const { name } of tablas) {
    const columnas = (base.prepare(`PRAGMA table_info(${name})`).all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[])
      .map((c) => `${c.name} ${c.type} ${c.notnull} ${String(c.dflt_value)} ${c.pk}`)
      .sort();
    salida[`tabla:${name}`] = columnas;
  }
  const indices = base
    .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string; tbl_name: string }[];
  salida.indices = indices.map((i) => `${i.tbl_name}.${i.name}`);
  return salida;
}

function marcar(base: Database.Database, id: string): void {
  base.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(id, Date.now());
}

test('una base nueva llega a 017 y repetir las migraciones no cambia nada', () => {
  const base = baseVacia();
  ejecutarMigraciones(base);
  const aplicadas = ids(base);
  assert.ok(aplicadas.includes('016-recepcion-externa-y-copias-dns'));
  assert.ok(aplicadas.includes('017-cambio-de-dominio'));
  const antes = esquema(base);
  ejecutarMigraciones(base);
  assert.deepEqual(ids(base), aplicadas);
  assert.deepEqual(esquema(base), antes);
});

test('un servidor que ejecutó la rama del cambio de dominio (009 y 011 antiguas) actualiza sin errores ni pérdidas', () => {
  const referencia = baseVacia();
  ejecutarMigraciones(referencia);

  const base = baseVacia();
  ejecutarMigraciones(base, { hasta: '008-reservas-de-cloudflare' });
  base.transaction(() => {
    base.exec(SQL_009_RAMA);
    marcar(base, '009-recepcion-externa-y-copias-dns');
    base.exec(SQL_011_RAMA);
    marcar(base, '011-cambio-de-dominio');
  })();
  // Datos de la rama: un cambio abierto, un buzón con el usuario anterior y
  // un dominio que recibe en otro proveedor.
  const t = Date.now();
  base.prepare("INSERT INTO plans (id, name, created_at) VALUES ('p', 'Plan', ?)").run(t);
  base.prepare("INSERT INTO clients (id, name, slug, plan_id, created_at) VALUES ('c', 'Cliente', 'cliente', 'p', ?)").run(t);
  base.prepare("INSERT INTO domains (id, client_id, domain, created_at, recepcion_externa) VALUES ('d1', 'c', 'viejo.test', ?, 0)").run(t);
  base.prepare("INSERT INTO domains (id, client_id, domain, created_at, recepcion_externa) VALUES ('d2', 'c', 'nuevo.test', ?, 1)").run(t);
  base
    .prepare("INSERT INTO mailboxes (id, domain_id, local_part, created_at, usuario_motor, login_anterior) VALUES ('m', 'd2', 'ana', ?, 'ana@viejo.test', NULL)")
    .run(t);
  base
    .prepare(
      `INSERT INTO domain_migrations (id, client_id, from_domain_id, to_domain_id, from_domain, to_domain, estado, created_at, updated_at)
       VALUES ('dm', 'c', 'd1', 'd2', 'viejo.test', 'nuevo.test', 'pasado', ?, ?)`,
    )
    .run(t, t);
  base.prepare("INSERT INTO domain_migration_items (migration_id, tipo, item_id, local_part) VALUES ('dm', 'buzon', 'm', 'ana')").run();

  ejecutarMigraciones(base);
  const aplicadas = ids(base);
  for (const id of ['009-perfil-de-buzones', '011-invitaciones-de-clientes', '015-correo-web-por-cliente', '016-recepcion-externa-y-copias-dns', '017-cambio-de-dominio']) {
    assert.ok(aplicadas.includes(id), `falta ${id}`);
  }
  // Los ids antiguos se quedan: no estorban y dicen de dónde viene la base.
  assert.ok(aplicadas.includes('009-recepcion-externa-y-copias-dns'));
  assert.ok(aplicadas.includes('011-cambio-de-dominio'));
  // El mismo esquema que una instalación nueva.
  assert.deepEqual(esquema(base), esquema(referencia));
  // Y los datos, intactos.
  assert.deepEqual(base.prepare("SELECT recepcion_externa FROM domains WHERE id = 'd2'").get(), { recepcion_externa: 1 });
  assert.deepEqual(base.prepare("SELECT usuario_motor FROM mailboxes WHERE id = 'm'").get(), { usuario_motor: 'ana@viejo.test' });
  assert.deepEqual(base.prepare("SELECT estado FROM domain_migrations WHERE id = 'dm'").get(), { estado: 'pasado' });
  // El índice único del usuario del motor sigue funcionando.
  base.prepare("INSERT INTO mailboxes (id, domain_id, local_part, created_at) VALUES ('m2', 'd2', 'luis', ?)").run(t);
  assert.throws(() => base.prepare("UPDATE mailboxes SET usuario_motor = 'ana@viejo.test' WHERE id = 'm2'").run(), /UNIQUE/);

  // Repetirlas no hace nada.
  ejecutarMigraciones(base);
  assert.deepEqual(ids(base), aplicadas);
});

test('una rama a medias (solo la 009 antigua) también se completa', () => {
  const referencia = baseVacia();
  ejecutarMigraciones(referencia);
  const base = baseVacia();
  ejecutarMigraciones(base, { hasta: '008-reservas-de-cloudflare' });
  base.exec(SQL_009_RAMA);
  marcar(base, '009-recepcion-externa-y-copias-dns');
  ejecutarMigraciones(base);
  assert.deepEqual(esquema(base), esquema(referencia));
});
