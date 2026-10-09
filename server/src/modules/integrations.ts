import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { db, now } from '../core/db';
import { randomId } from '../core/crypto';
import { badRequest, conflict, HttpError, notFound } from '../core/errors';
import { apiDelMotor } from '../engine';
import { audit } from './audit';
import { requireAdmin, requireAuth, requireClientAccess } from './auth';
import { getClient, getClientUsage, getPlan } from './clients';
import { getConnectionSettings, publicBaseUrl } from './connection';
import { listDomains } from './domains';
import { listMailboxes } from './mailboxes';
import { getInstanceSettings } from './settings';
import { getTraefikToken, webmailAutomaticoCliente, webmailAutomaticoGlobal, webmailsDelCliente } from './whitelabel';

/**
 * API de integraciones: lo que necesita un sistema externo (Skyway, un
 * script, la CI) para gestionar Mailway sin conocer su modelo interno.
 *
 * - Un cliente se localiza por `externalRef` (p. ej. «skyway:project:<id>»),
 *   así la integración no guarda ids de Mailway y repetir la operación nunca
 *   duplica clientes.
 * - El resumen agrega en una llamada lo que el panel pide en varias.
 *
 * Se autentica con un token de gestión (Bearer mwt_…) o con la sesión, y
 * hereda los permisos del usuario: las rutas de clientes son de
 * administrador; el resumen, de quien tenga acceso a ese cliente.
 */

/* ------------------------------ Referencias ------------------------------- */

const EXTERNAL_REF_RE = /^[a-z0-9][a-z0-9:._-]{2,199}$/i;

const externalRefSchema = z
  .string({ required_error: 'Indica la referencia externa (externalRef).' })
  .trim()
  .regex(
    EXTERNAL_REF_RE,
    'La referencia externa debe tener entre 3 y 200 caracteres: letras, números y los signos «:», «.», «_» y «-», empezando por letra o número.',
  );

function clientIdByRef(externalRef: string): string | null {
  const row = db.prepare('SELECT id FROM clients WHERE external_ref = ?').get(externalRef) as
    | { id: string }
    | undefined;
  return row ? row.id : null;
}

function externalRefOf(clientId: string): string | null {
  const row = db.prepare('SELECT external_ref FROM clients WHERE id = ?').get(clientId) as
    | { external_ref: string | null }
    | undefined;
  return row ? row.external_ref : null;
}

/** El índice único de external_ref es la última garantía contra duplicados. */
function isExternalRefConflict(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    typeof e?.code === 'string' &&
    e.code.startsWith('SQLITE_CONSTRAINT') &&
    String(e.message || '').includes('external_ref')
  );
}

/** Misma forma que devuelve POST /api/clients, más la referencia externa. */
function clientView(id: string) {
  const client = getClient(id);
  return {
    ...client,
    externalRef: externalRefOf(id),
    plan: getPlan(client.planId),
    usage: getClientUsage(id),
  };
}

/* ------------------------------ Alta de cliente --------------------------- */

/** Igual que el slug de clients.ts, para que las URL y nombres coincidan en estilo. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Slug libre con sufijo numérico (acme, acme-2, acme-3…): más legible que
 * el sufijo aleatorio y estable si la integración recrea el mismo nombre.
 */
function uniqueSlug(name: string, id: string): string {
  const base = slugify(name) || id.replace(/_/g, '-');
  const taken = db.prepare('SELECT 1 FROM clients WHERE slug = ?');
  if (!taken.get(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base.slice(0, 36)}-${n}`;
    if (!taken.get(candidate)) return candidate;
  }
  return `${base.slice(0, 30)}-${id.slice(-8)}`;
}

/** Plan por defecto: el primero que se creó (en una instalación nueva, «Básico»). */
function defaultPlanId(): string {
  const row = db.prepare('SELECT id FROM plans ORDER BY created_at ASC, rowid ASC LIMIT 1').get() as
    | { id: string }
    | undefined;
  if (!row) {
    throw conflict(
      'No hay ningún plan definido. Crea un plan en Mailway antes de dar de alta clientes.',
      'no_plans',
    );
  }
  return row.id;
}

const ensureSchema = z.object({
  externalRef: externalRefSchema,
  name: z
    .string({ required_error: 'Indica el nombre del cliente.' })
    .trim()
    .min(2, 'El nombre del cliente es demasiado corto.')
    .max(80, 'El nombre del cliente no puede superar los 80 caracteres.'),
  contactEmail: z
    .string()
    .trim()
    .email('El correo electrónico de contacto no es válido.')
    .or(z.literal(''))
    .optional(),
  planId: z.string().trim().min(1).max(64).optional(),
});

const linkSchema = z.object({ externalRef: externalRefSchema });

/* -------------------------------- Resumen --------------------------------- */

interface SummaryMailbox {
  id: string;
  domainId: string;
  domain: string;
  localPart: string;
  email: string;
  displayName: string;
  quotaMb: number;
  status: 'active' | 'suspended';
  createdAt: number;
  usedBytes: number | null;
}

interface SummaryApiKey {
  id: string;
  clientId: string;
  name: string;
  prefix: string;
  senderMailboxId: string;
  senderEmail: string;
  dailyLimit: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  usedToday: number;
}

interface SummaryAppPassword {
  id: string;
  mailboxId: string;
  email: string;
  name: string;
  createdAt: number;
  revokedAt: number | null;
  /** Dejó de funcionar al cambiar de versión el servidor de correo (ms); null si sigue valiendo. */
  invalidatedAt: number | null;
}

/*
 * Los listados del resumen se leen con una consulta por tipo en vez de
 * llamar a los helpers por elemento (N consultas por buzón o por clave).
 * Las formas coinciden con las de /api/mailboxes, /api/apikeys y
 * /api/mailboxes/:id/app-passwords.
 */

/**
 * Buzones del resumen con la ocupación al día: se leen con listMailboxes, que
 * la refresca del motor si está caducada (con espera acotada). Leerla tal
 * cual de la base dejaba en «0 B» para siempre los buzones que nadie abría
 * en el panel.
 */
async function summaryMailboxes(clientId: string): Promise<SummaryMailbox[]> {
  const mailboxes = await listMailboxes({ clientId });
  return mailboxes.map((m) => ({
    id: m.id,
    domainId: m.domainId,
    domain: m.domain,
    localPart: m.localPart,
    email: m.email,
    displayName: m.displayName,
    quotaMb: m.quotaMb,
    status: m.status,
    createdAt: m.createdAt,
    usedBytes: m.usedBytes,
  }));
}

function summaryApiKeys(clientId: string): SummaryApiKey[] {
  // Mismo criterio de día que el cupo de /v1/send (UTC, AAAA-MM-DD).
  const today = new Date(now()).toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT k.id, k.client_id, k.name, k.prefix, k.sender_mailbox_id, k.daily_limit,
              k.last_used_at, k.revoked_at, k.created_at,
              m.local_part, d.domain, COALESCE(u.count, 0) AS used_today
       FROM api_keys k
       LEFT JOIN mailboxes m ON m.id = k.sender_mailbox_id
       LEFT JOIN domains d ON d.id = m.domain_id
       LEFT JOIN api_usage u ON u.api_key_id = k.id AND u.day = ?
       WHERE k.client_id = ?
       ORDER BY k.created_at DESC`,
    )
    .all(today, clientId) as {
    id: string;
    client_id: string;
    name: string;
    prefix: string;
    sender_mailbox_id: string;
    daily_limit: number | null;
    last_used_at: number | null;
    revoked_at: number | null;
    created_at: number;
    local_part: string | null;
    domain: string | null;
    used_today: number;
  }[];
  return rows.map((row) => ({
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    prefix: row.prefix,
    senderMailboxId: row.sender_mailbox_id,
    senderEmail:
      row.local_part && row.domain ? `${row.local_part}@${row.domain}` : '(buzón eliminado)',
    dailyLimit: row.daily_limit,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    usedToday: row.used_today,
  }));
}

function summaryAppPasswords(clientId: string): SummaryAppPassword[] {
  // Nunca se seleccionan stored_secret ni verifier: no salen del servidor.
  const rows = db
    .prepare(
      `SELECT ap.id, ap.mailbox_id, ap.name, ap.created_at, ap.revoked_at, ap.invalidated_at, m.local_part, d.domain
       FROM app_passwords ap
       JOIN mailboxes m ON m.id = ap.mailbox_id
       JOIN domains d ON d.id = m.domain_id
       WHERE d.client_id = ?
       ORDER BY (ap.revoked_at IS NOT NULL), ap.created_at DESC`,
    )
    .all(clientId) as {
    id: string;
    mailbox_id: string;
    name: string;
    created_at: number;
    revoked_at: number | null;
    invalidated_at: number | null;
    local_part: string;
    domain: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    mailboxId: row.mailbox_id,
    email: `${row.local_part}@${row.domain}`,
    name: row.name,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    invalidatedAt: row.invalidated_at ?? null,
  }));
}

/**
 * Hay Cloudflare utilizable si existe alguna cuenta conectada que este
 * usuario pueda usar: el administrador, cualquiera; un cliente, solo las
 * suyas. Las de la instancia no cuentan para un cliente porque el plan y la
 * aplicación del DNS se las niegan: anunciarlas llevaba a un «DNS en un clic»
 * que después fallaba.
 */
function cloudflareAvailable(user: { role: 'admin' | 'client'; clientId: string | null }): boolean {
  const row =
    user.role === 'admin'
      ? db.prepare('SELECT 1 FROM cloudflare_accounts LIMIT 1').get()
      : db.prepare('SELECT 1 FROM cloudflare_accounts WHERE client_id = ? LIMIT 1').get(user.clientId ?? '');
  return Boolean(row);
}

/* --------------------------------- Rutas ---------------------------------- */

export function registerIntegrationRoutes(app: FastifyInstance): void {
  /**
   * Punto de partida de una integración: comprueba el token y devuelve todo
   * lo que se necesita para configurar servicios (servidores, webmail, URL
   * del panel) sin preguntar nada más al usuario.
   */
  app.get('/api/integrations/info', async (req) => {
    const user = requireAuth(req);
    const instance = getInstanceSettings();
    // Un cliente con webmail de marca propia lo recibe en lugar del global.
    const settings = getConnectionSettings('', user.role === 'client' ? user.clientId : null);
    // La API del motor (null si no hay motor o no responde a tiempo): cuando
    // cambia (Stalwart 0.15 → 0.16), las contraseñas de aplicación anteriores
    // dejan de funcionar y quien integra debe volver a conectar sus servicios.
    const api = await apiDelMotor();
    return {
      version: config.version,
      brandName: instance.brandName,
      mailHostname: instance.mailHostname,
      webmailUrl: settings.webmailUrl,
      panelUrl: publicBaseUrl(req),
      imap: settings.imap,
      smtp: settings.smtp,
      submission: settings.smtpAlt,
      user,
      engine: { api },
      features: {
        cloudflare: cloudflareAvailable(user),
        autoconfig: Boolean(config.traefik.panelBackend),
        portal: true,
        // Compromiso para quien integra (Skyway solo pide el DNS automático
        // del correo si lo ve): el alta con `autoDns` y el registro de marca
        // blanca con `soloCrear` solo crean lo que falta, nunca modifican un
        // registro existente, y la cuenta de Cloudflare de la instancia
        // asociada a un dominio nunca se usa en nombre de un cliente.
        cloudflareSoloCrear: true,
        // Interruptor general del webmail automático (webmail.<dominio> de
        // cada dominio). Que exista la clave dice que Mailway lo admite.
        webmailAutomatico: webmailAutomaticoGlobal(),
        // Enlaces de bienvenida del cliente (`/api/clients/:id/invites`):
        // Skyway solo ofrece «Enviar configuración inicial» si lo ve.
        invites: true,
        // Las contraseñas de aplicación llevan `invalidatedAt` cuando dejan de
        // funcionar porque el motor ha cambiado de versión: Skyway detecta
        // así las de sus servicios y las vuelve a crear.
        appPasswordInvalidation: true,
      },
      // El token de Traefik es un secreto de instancia: solo para administradores.
      traefik:
        user.role === 'admin' ? { configPath: '/api/traefik/config', token: getTraefikToken() } : null,
    };
  });

  /**
   * Alta idempotente: si ya hay un cliente con esa referencia se devuelve tal
   * cual (sin modificarlo: su nombre o plan pueden haberse cambiado a mano en
   * Mailway); si no, se crea. Repetir la llamada nunca duplica clientes.
   */
  app.post('/api/integrations/clients/ensure', async (req) => {
    requireAdmin(req);
    const body = ensureSchema.parse(req.body ?? {});

    const existing = clientIdByRef(body.externalRef);
    if (existing) return { client: clientView(existing), created: false };

    let planId: string;
    if (body.planId) {
      const found = db.prepare('SELECT id FROM plans WHERE id = ?').get(body.planId);
      if (!found) throw badRequest('El plan indicado no existe.', 'plan_not_found');
      planId = body.planId;
    } else {
      planId = defaultPlanId();
    }

    const id = randomId('cli');
    // Comprobar y crear en la misma transacción: sin await entre medias, dos
    // llamadas simultáneas no pueden crear el mismo cliente dos veces.
    const createOnce = db.transaction((): { id: string; created: boolean } => {
      const again = clientIdByRef(body.externalRef);
      if (again) return { id: again, created: false };
      db.prepare(
        `INSERT INTO clients (id, name, slug, contact_email, plan_id, notes, created_at, external_ref)
         VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
      ).run(
        id,
        body.name,
        uniqueSlug(body.name, id),
        body.contactEmail ?? '',
        planId,
        now(),
        body.externalRef,
      );
      return { id, created: true };
    });

    let result: { id: string; created: boolean };
    try {
      result = createOnce();
    } catch (err) {
      const winner = isExternalRefConflict(err) ? clientIdByRef(body.externalRef) : null;
      if (!winner) throw err;
      result = { id: winner, created: false };
    }

    if (result.created) {
      audit(
        req,
        'client.created',
        { id: result.id, name: body.name, externalRef: body.externalRef },
        result.id,
      );
    }
    return { client: clientView(result.id), created: result.created };
  });

  /** Vincula un cliente existente (creado a mano) con la referencia externa. */
  app.put('/api/integrations/clients/:id/link', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const client = getClient(id);
    const body = linkSchema.parse(req.body ?? {});

    const owner = clientIdByRef(body.externalRef);
    if (owner && owner !== id) {
      const other = getClient(owner);
      throw conflict(
        `La referencia externa ya está vinculada a otro cliente («${other.name}»). Desvincúlala antes de asignarla a este.`,
        'external_ref_in_use',
      );
    }

    const previous = externalRefOf(id);
    if (previous !== body.externalRef) {
      try {
        db.prepare('UPDATE clients SET external_ref = ? WHERE id = ?').run(body.externalRef, id);
      } catch (err) {
        if (isExternalRefConflict(err)) {
          throw conflict('La referencia externa ya está vinculada a otro cliente.', 'external_ref_in_use');
        }
        throw err;
      }
      audit(
        req,
        'client.external_linked',
        { id, name: client.name, externalRef: body.externalRef, previous },
        id,
      );
    }
    return { client: clientView(id) };
  });

  app.delete('/api/integrations/clients/:id/link', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const client = getClient(id);
    const previous = externalRefOf(id);
    // Desvinculación condicional: si la integración indica qué referencia
    // espera, solo se borra si sigue siendo esa. Así un proyecto de Skyway
    // que se desactiva no puede quitarle el cliente a otro que lo reclamó
    // entre su comprobación y esta llamada.
    const { externalRef: expected } = (req.query ?? {}) as { externalRef?: string };
    if (expected !== undefined && previous !== null && previous !== expected) {
      throw conflict(
        'El cliente está vinculado a otra referencia externa; no se ha modificado.',
        'external_ref_mismatch',
      );
    }
    if (previous !== null) {
      db.prepare('UPDATE clients SET external_ref = NULL WHERE id = ?').run(id);
      audit(req, 'client.external_unlinked', { id, name: client.name, externalRef: previous }, id);
    }
    return { client: clientView(id) };
  });

  app.get('/api/integrations/clients/by-ref', async (req) => {
    requireAdmin(req);
    const query = z.object({ externalRef: externalRefSchema }).parse(req.query ?? {});
    const id = clientIdByRef(query.externalRef);
    if (!id) {
      throw notFound('No hay ningún cliente vinculado a esa referencia externa.', 'client_not_found');
    }
    return { client: clientView(id) };
  });

  /**
   * Todo lo de un cliente en una llamada. El acceso se comprueba ANTES de
   * leer el cliente: así un usuario de otro cliente recibe 403 tanto si el id
   * existe como si no, y no puede sondear qué ids existen.
   */
  app.get('/api/integrations/clients/:id/summary', async (req) => {
    const { id } = req.params as { id: string };
    requireClientAccess(req, id);
    let client;
    try {
      client = getClient(id);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        throw notFound('Cliente no encontrado.', 'client_not_found');
      }
      throw err;
    }
    const settings = getConnectionSettings('', id);
    return {
      client: {
        id: client.id,
        name: client.name,
        slug: client.slug,
        externalRef: externalRefOf(id),
        suspended: client.suspended,
        webmailAutomatico: webmailAutomaticoCliente(id),
      },
      // Los webmail del cliente (los automáticos y los dados de alta a mano).
      webmailDomains: webmailsDelCliente(id),
      plan: getPlan(client.planId),
      usage: getClientUsage(id),
      domains: listDomains(id),
      mailboxes: await summaryMailboxes(id),
      apiKeys: summaryApiKeys(id),
      appPasswords: summaryAppPasswords(id),
      connection: {
        imap: settings.imap,
        smtp: settings.smtp,
        submission: settings.smtpAlt,
        webmailUrl: settings.webmailUrl,
      },
    };
  });
}
