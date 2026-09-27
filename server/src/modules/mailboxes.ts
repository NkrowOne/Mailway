import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { generateMailboxPassword, randomId } from '../core/crypto';
import { badRequest, conflict, notFound } from '../core/errors';
import { getEngine } from '../engine';
import { audit } from './audit';
import { requireAuth, requireClientAccess, type AuthedUser } from './auth';
import { assertWithinLimit, getClient, getClientUsage, getPlan } from './clients';
import { getDomain, type DomainRecord } from './domains';
import { alCambiarContrasenaBuzon } from './portal';

export interface Mailbox {
  id: string;
  domainId: string;
  domain: string;
  localPart: string;
  email: string;
  displayName: string;
  quotaMb: number;
  status: 'active' | 'suspended';
  createdAt: number;
  /** Bytes ocupados según el motor (caché de hasta 10 min); null = sin dato. */
  usedBytes: number | null;
  usageCheckedAt: number | null;
  clientId: string;
  clientName: string;
}

interface MailboxRow {
  id: string;
  domain_id: string;
  local_part: string;
  display_name: string;
  quota_mb: number;
  status: 'active' | 'suspended';
  created_at: number;
  used_bytes: number | null;
  usage_checked_at: number | null;
  domain: string;
  client_id: string;
  client_name: string;
}

const MAILBOX_SELECT = `SELECT m.*, d.domain, d.client_id, c.name AS client_name
  FROM mailboxes m
  JOIN domains d ON d.id = m.domain_id
  JOIN clients c ON c.id = d.client_id`;

function toMailbox(row: MailboxRow): Mailbox {
  return {
    id: row.id,
    domainId: row.domain_id,
    domain: row.domain,
    localPart: row.local_part,
    email: `${row.local_part}@${row.domain}`,
    displayName: row.display_name,
    quotaMb: row.quota_mb,
    status: row.status,
    createdAt: row.created_at,
    usedBytes: row.used_bytes ?? null,
    usageCheckedAt: row.usage_checked_at ?? null,
    clientId: row.client_id,
    clientName: row.client_name,
  };
}

export function getMailbox(id: string): Mailbox {
  const row = db.prepare(`${MAILBOX_SELECT} WHERE m.id = ?`).get(id) as MailboxRow | undefined;
  if (!row) throw notFound('Buzón no encontrado.');
  return toMailbox(row);
}

/* ------------------------------ Ocupación -------------------------------- */

/** La ocupación cambia despacio: basta con leerla del motor cada 10 minutos. */
const USAGE_MAX_AGE_MS = 10 * 60_000;
/** Lo que el listado espera al motor antes de servir los valores guardados. */
const USAGE_WAIT_MS = 2_500;
/** Tras un intento (bueno o malo), no se vuelve a preguntar antes de esto. */
const USAGE_RETRY_MS = 60_000;

let usageRefresh: Promise<void> | null = null;
let lastUsageAttempt = 0;

/**
 * Pide al motor la ocupación de TODOS los buzones en una sola consulta y la
 * guarda. Las peticiones simultáneas comparten la misma consulta; si el motor
 * tarda, la consulta sigue en segundo plano y el siguiente listado ya la ve.
 */
function refreshUsage(): Promise<void> {
  if (usageRefresh) return usageRefresh;
  lastUsageAttempt = now();
  usageRefresh = (async () => {
    const usage = await getEngine().getMailboxUsage();
    const t = now();
    const rows = db
      .prepare('SELECT m.id, m.local_part, d.domain FROM mailboxes m JOIN domains d ON d.id = m.domain_id')
      .all() as { id: string; local_part: string; domain: string }[];
    const update = db.prepare('UPDATE mailboxes SET used_bytes = ?, usage_checked_at = ? WHERE id = ?');
    db.transaction(() => {
      for (const row of rows) {
        // Un buzón ausente del mapa es «desconocido», no «vacío»: se deja
        // el último valor conocido.
        const bytes = usage.get(`${row.local_part}@${row.domain}`.toLowerCase());
        if (bytes !== undefined) update.run(bytes, t, row.id);
      }
    })();
  })()
    // Sin motor o con el motor caído, el listado sigue con los valores
    // guardados: la ocupación es informativa y nunca debe tumbar la página.
    .catch(() => undefined)
    .finally(() => {
      usageRefresh = null;
    });
  return usageRefresh;
}

/**
 * Olvida el último intento de lectura de ocupación. Solo para las pruebas:
 * sin esto, la espera de un minuto entre intentos impediría comprobar el
 * refresco y la caída del motor en el mismo proceso.
 */
export function resetUsageRefreshState(): void {
  lastUsageAttempt = 0;
}

/** true si se intentó refrescar (y conviene volver a leer las filas). */
async function ensureFreshUsage(rows: MailboxRow[]): Promise<boolean> {
  const t = now();
  const stale = rows.some((r) => !r.usage_checked_at || t - r.usage_checked_at > USAGE_MAX_AGE_MS);
  if (!stale) return false;
  if (!usageRefresh && t - lastUsageAttempt < USAGE_RETRY_MS) return false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, USAGE_WAIT_MS);
  });
  await Promise.race([refreshUsage(), timeout]);
  clearTimeout(timer);
  return true;
}

/**
 * Buzones filtrados por cliente y/o dominio, con la ocupación al día (o la
 * última conocida si el motor no responde a tiempo). La usan el listado del
 * panel y las integraciones.
 */
export async function listMailboxes(filter: { clientId?: string; domainId?: string } = {}): Promise<Mailbox[]> {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.clientId) {
    where.push('d.client_id = ?');
    params.push(filter.clientId);
  }
  if (filter.domainId) {
    where.push('m.domain_id = ?');
    params.push(filter.domainId);
  }
  const sql = `${MAILBOX_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY d.domain, m.local_part`;
  const read = () => db.prepare(sql).all(...params) as MailboxRow[];
  let rows = read();
  if (rows.length > 0 && (await ensureFreshUsage(rows))) rows = read();
  return rows.map(toMailbox);
}

/* ------------------------------ Utilidades -------------------------------- */

const LOCAL_PART_RE = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;
const LOCAL_PART_HELP =
  'El nombre del buzón solo puede contener letras sin tilde, números, puntos, guiones y guiones bajos, y no puede empezar ni terminar por un símbolo.';

function localPartError(local: string): string | null {
  if (!LOCAL_PART_RE.test(local)) return LOCAL_PART_HELP;
  if (local.includes('..')) return 'El nombre del buzón no puede contener dos puntos seguidos.';
  return null;
}

function normalizeLocalPart(input: string): string {
  const local = input.trim().toLowerCase();
  const error = localPartError(local);
  if (error) throw badRequest(error, 'invalid_local_part');
  return local;
}

export function requireMailboxAccess(
  req: FastifyRequest,
  mailboxId: string,
): { user: AuthedUser; mailbox: Mailbox; domain: DomainRecord } {
  const mailbox = getMailbox(mailboxId);
  const domain = getDomain(mailbox.domainId);
  const user = requireClientAccess(req, domain.clientId);
  return { user, mailbox, domain };
}

function mailboxExists(domainId: string, localPart: string): boolean {
  return Boolean(
    db.prepare('SELECT 1 FROM mailboxes WHERE domain_id = ? AND local_part = ?').get(domainId, localPart),
  );
}

function aliasExists(domainId: string, localPart: string): boolean {
  return Boolean(
    db.prepare('SELECT 1 FROM aliases WHERE domain_id = ? AND local_part = ?').get(domainId, localPart),
  );
}

const passwordSchema = z
  .string()
  .min(10, 'La contraseña debe tener al menos 10 caracteres.')
  .max(200, 'La contraseña no puede superar los 200 caracteres.');

const quotaSchema = z
  .number({ invalid_type_error: 'La cuota debe ser un número de MB.' })
  .int('La cuota debe ser un número entero de MB.')
  .min(64, 'La cuota mínima es de 64 MB.')
  .max(1048576, 'La cuota no puede superar 1 TB (1048576 MB).');

const displayNameSchema = z
  .string()
  .trim()
  .max(80, 'El nombre visible no puede superar los 80 caracteres.');

const createSchema = z.object({
  domainId: z.string({ required_error: 'Seleccione un dominio.' }).min(1, 'Seleccione un dominio.'),
  localPart: z
    .string({ required_error: 'Indique el nombre del buzón (lo que va antes de la @).' })
    .min(1, 'Indique el nombre del buzón (lo que va antes de la @).'),
  displayName: displayNameSchema.optional().default(''),
  password: passwordSchema.optional(),
  quotaMb: quotaSchema.optional(),
});

const bulkSchema = z.object({
  domainId: z.string({ required_error: 'Seleccione un dominio.' }).min(1, 'Seleccione un dominio.'),
  entries: z
    .array(
      z.object({
        localPart: z.string({ required_error: 'Falta el nombre del buzón.' }).max(200),
        displayName: displayNameSchema.optional().default(''),
      }),
      { required_error: 'Añada al menos una dirección.' },
    )
    .min(1, 'Añada al menos una dirección.')
    .max(100, 'Se pueden crear como máximo 100 buzones por lote.'),
  quotaMb: quotaSchema.optional(),
  /** true = solo validar y devolver la previsión, sin crear nada. */
  dryRun: z.boolean().optional().default(false),
});

/**
 * Crea un buzón en el motor y en la base. Comprueba el plan justo antes de
 * crear: en un alta masiva protege frente a altas simultáneas.
 */
async function createMailboxRecord(input: {
  domain: DomainRecord;
  localPart: string;
  displayName: string;
  password?: string;
  quotaMb?: number;
}): Promise<{ mailbox: Mailbox; password: string }> {
  const { domain, localPart } = input;
  assertWithinLimit(domain.clientId, 'mailboxes');
  const email = `${localPart}@${domain.domain}`;
  if (mailboxExists(domain.id, localPart)) throw conflict(`El buzón ${email} ya existe.`, 'mailbox_exists');
  if (aliasExists(domain.id, localPart)) {
    throw conflict(`Ya existe un alias ${email}. Elija otro nombre.`, 'alias_exists');
  }

  const plan = getPlan(getClient(domain.clientId).planId);
  const quotaMb = Math.min(input.quotaMb ?? plan.mailboxQuotaMb, plan.mailboxQuotaMb);
  const password = input.password || generateMailboxPassword();

  const engine = getEngine();
  await engine.createMailbox({
    email,
    password,
    displayName: input.displayName,
    quotaBytes: quotaMb * 1024 * 1024,
  });

  const id = randomId('mbx');
  const t = now();
  try {
    // Un buzón recién creado está vacío: así el listado no tiene que
    // consultar al motor solo por él.
    db.prepare(
      `INSERT INTO mailboxes (id, domain_id, local_part, display_name, quota_mb, created_at,
         used_bytes, usage_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(id, domain.id, localPart, input.displayName, quotaMb, t, t);
  } catch (err) {
    // El INSERT falló (p. ej. el dominio se borró en paralelo → FK, o
    // colisión de unicidad): deshacemos el buzón en el motor para no dejar
    // un principal huérfano que impediría recrear esa dirección.
    await engine.deleteMailbox(email).catch(() => undefined);
    throw err;
  }
  return { mailbox: getMailbox(id), password };
}

/* ------------------------------ Alias: destinos ---------------------------- */

interface AliasRow {
  id: string;
  domain_id: string;
  local_part: string;
  destinations_json: string;
  created_at: number;
  domain: string;
  client_id: string;
  client_name: string;
}

const ALIAS_SELECT = `SELECT a.*, d.domain, d.client_id, c.name AS client_name
  FROM aliases a
  JOIN domains d ON d.id = a.domain_id
  JOIN clients c ON c.id = d.client_id`;

function parseDestinations(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function splitEmail(email: string): { local: string; domain: string } {
  const at = email.lastIndexOf('@');
  return { local: email.slice(0, at), domain: email.slice(at + 1) };
}

function isInstanceMailbox(email: string): boolean {
  const { local, domain } = splitEmail(email.toLowerCase());
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM mailboxes m JOIN domains d ON d.id = m.domain_id
         WHERE d.domain = ? AND m.local_part = ?`,
      )
      .get(domain, local),
  );
}

/**
 * Separa y valida los destinos de un alias:
 * - internos: buzones de esta instancia, y SOLO del mismo cliente (un cliente
 *   no puede desviar correo a los buzones de otro);
 * - externos: direcciones de dominios que esta instancia no gestiona.
 * Una dirección de un dominio gestionado aquí que no es un buzón (otro alias,
 * una errata) se rechaza en lugar de salir a Internet como «externa».
 */
function classifyDestinations(
  clientId: string,
  aliasEmail: string,
  destinations: string[],
): { all: string[]; internal: string[]; external: string[] } {
  const all = [...new Set(destinations.map((d) => d.trim().toLowerCase()))];
  const internal: string[] = [];
  const external: string[] = [];
  for (const dest of all) {
    if (dest === aliasEmail) throw badRequest('Un alias no puede reenviarse a sí mismo.', 'alias_loop');
    const { local, domain } = splitEmail(dest);
    const domainRow = db.prepare('SELECT id, client_id FROM domains WHERE domain = ?').get(domain) as
      | { id: string; client_id: string }
      | undefined;
    if (!domainRow) {
      external.push(dest);
      continue;
    }
    if (domainRow.client_id !== clientId) {
      throw badRequest(
        `${dest} no es un buzón de este cliente. Los destinos de esta plataforma deben ser buzones del mismo cliente.`,
        'destination_other_client',
      );
    }
    if (!mailboxExists(domainRow.id, local)) {
      throw badRequest(
        `${dest} no es un buzón existente. Cree antes el buzón o indique otra dirección.`,
        'destination_not_found',
      );
    }
    internal.push(dest);
  }
  return { all, internal, external };
}

function toAlias(row: AliasRow) {
  const destinations = parseDestinations(row.destinations_json);
  return {
    id: row.id,
    domainId: row.domain_id,
    domain: row.domain,
    localPart: row.local_part,
    email: `${row.local_part}@${row.domain}`,
    destinations,
    // Clasificación al leer: lo que no es un buzón de la instancia sale fuera.
    externalDestinations: destinations.filter((d) => !isInstanceMailbox(d)),
    clientId: row.client_id,
    clientName: row.client_name,
    createdAt: row.created_at,
  };
}

function getAliasRow(id: string): AliasRow {
  const row = db.prepare(`${ALIAS_SELECT} WHERE a.id = ?`).get(id) as AliasRow | undefined;
  if (!row) throw notFound('Alias no encontrado.');
  return row;
}

const destinationsSchema = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .max(254, 'Cada destino debe ser una dirección de correo válida.')
      .email('Cada destino debe ser una dirección de correo válida.'),
    { required_error: 'Añada al menos un destino.' },
  )
  .min(1, 'Añada al menos un destino.')
  .max(20, 'Un alias admite como máximo 20 destinos.');

/* --------------------------------- Rutas ---------------------------------- */

/** Altas masivas en curso por cliente: dos lotes a la vez podrían saltarse el plan. */
const bulkInProgress = new Set<string>();

export function registerMailboxRoutes(app: FastifyInstance): void {
  app.get('/api/mailboxes', async (req) => {
    const user = requireAuth(req);
    const { domainId, clientId } = req.query as { domainId?: string; clientId?: string };
    const scope = user.role === 'client' ? user.clientId! : clientId;
    return { mailboxes: await listMailboxes({ clientId: scope, domainId }) };
  });

  app.post('/api/mailboxes', async (req) => {
    const body = createSchema.parse(req.body);
    const domain = getDomain(body.domainId);
    requireClientAccess(req, domain.clientId);
    const localPart = normalizeLocalPart(body.localPart);
    const { mailbox, password } = await createMailboxRecord({
      domain,
      localPart,
      displayName: body.displayName,
      password: body.password,
      quotaMb: body.quotaMb,
    });
    audit(req, 'mailbox.created', { id: mailbox.id, email: mailbox.email }, domain.clientId);
    // La contraseña solo se devuelve en esta respuesta; no se guarda en claro.
    return { mailbox, password: body.password ? undefined : password };
  });

  /**
   * Alta masiva: valida el lote entero y comprueba el plan para TODOS los
   * buzones nuevos antes de crear ninguno (no se queda a medias por el
   * límite). Después crea uno a uno y devuelve el resultado de cada línea.
   */
  app.post('/api/mailboxes/bulk', async (req) => {
    const body = bulkSchema.parse(req.body);
    const domain = getDomain(body.domainId);
    requireClientAccess(req, domain.clientId);
    const client = getClient(domain.clientId);
    if (client.suspended) {
      throw badRequest(
        'Este cliente está suspendido. No es posible crear recursos hasta que se reactive.',
        'client_suspended',
      );
    }

    const seen = new Set<string>();
    const checked = body.entries.map((entry) => {
      const localPart = entry.localPart.trim().toLowerCase();
      const email = `${localPart}@${domain.domain}`;
      let error = localPartError(localPart);
      if (!error && seen.has(localPart)) error = 'La dirección está repetida en la lista.';
      if (!error && mailboxExists(domain.id, localPart)) error = 'El buzón ya existe.';
      if (!error && aliasExists(domain.id, localPart)) error = 'Ya existe un alias con esa dirección.';
      seen.add(localPart);
      return { localPart, email, displayName: entry.displayName, error };
    });
    const valid = checked.filter((c) => !c.error);
    const plan = getPlan(client.planId);
    const usage = getClientUsage(client.id);
    const capacity = {
      used: usage.mailboxes,
      max: plan.maxMailboxes,
      remaining: Math.max(0, plan.maxMailboxes - usage.mailboxes),
    };

    if (body.dryRun) {
      return {
        dryRun: true,
        capacity,
        valid: valid.length,
        exceedsPlan: valid.length > capacity.remaining,
        results: checked.map((c) => ({
          localPart: c.localPart,
          email: c.email,
          displayName: c.displayName,
          ok: !c.error,
          error: c.error ?? undefined,
        })),
      };
    }

    if (valid.length === 0) {
      throw badRequest('Ninguna dirección de la lista es válida. Revise la lista e inténtelo de nuevo.', 'bulk_empty');
    }
    assertWithinLimit(client.id, 'mailboxes', valid.length);
    if (bulkInProgress.has(client.id)) {
      throw conflict('Ya hay un alta masiva en curso para este cliente. Espere a que termine.', 'bulk_in_progress');
    }

    bulkInProgress.add(client.id);
    const results: {
      localPart: string;
      email: string;
      displayName: string;
      ok: boolean;
      error?: string;
      mailbox?: Mailbox;
      password?: string;
    }[] = [];
    try {
      for (const entry of checked) {
        if (entry.error) {
          results.push({ localPart: entry.localPart, email: entry.email, displayName: entry.displayName, ok: false, error: entry.error });
          continue;
        }
        try {
          const created = await createMailboxRecord({
            domain,
            localPart: entry.localPart,
            displayName: entry.displayName,
            quotaMb: body.quotaMb,
          });
          results.push({
            localPart: entry.localPart,
            email: entry.email,
            displayName: entry.displayName,
            ok: true,
            mailbox: created.mailbox,
            password: created.password,
          });
        } catch (err) {
          results.push({
            localPart: entry.localPart,
            email: entry.email,
            displayName: entry.displayName,
            ok: false,
            error: (err as Error).message || 'No se ha podido crear el buzón.',
          });
        }
      }
    } finally {
      bulkInProgress.delete(client.id);
    }

    const createdEmails = results.filter((r) => r.ok).map((r) => r.email);
    audit(req, 'mailbox.bulk_created', {
      domain: domain.domain,
      clientId: client.id,
      count: createdEmails.length,
      failed: results.length - createdEmails.length,
      emails: createdEmails,
    });
    return {
      results,
      created: createdEmails.length,
      failed: results.length - createdEmails.length,
      capacity: { ...capacity, used: capacity.used + createdEmails.length, remaining: Math.max(0, capacity.remaining - createdEmails.length) },
    };
  });

  app.patch('/api/mailboxes/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { mailbox, domain } = requireMailboxAccess(req, id);
    const body = z
      .object({
        displayName: displayNameSchema.optional(),
        quotaMb: quotaSchema.optional(),
        status: z
          .enum(['active', 'suspended'], { errorMap: () => ({ message: 'Estado del buzón no válido.' }) })
          .optional(),
      })
      .parse(req.body ?? {});

    const client = getClient(domain.clientId);
    if (body.status === 'active' && client.suspended) {
      throw conflict(
        'El cliente está suspendido: sus buzones permanecen suspendidos hasta que se reactive el cliente.',
        'client_suspended',
      );
    }
    // Igual que al crear: la cuota nunca supera la del plan del cliente
    // (antes un usuario de cliente podía subirla hasta 1 TB).
    const plan = getPlan(client.planId);
    const quotaMb = body.quotaMb !== undefined ? Math.min(body.quotaMb, plan.mailboxQuotaMb) : undefined;

    const patch = {
      displayName: body.displayName !== undefined && body.displayName !== mailbox.displayName ? body.displayName : undefined,
      quotaBytes: quotaMb !== undefined && quotaMb !== mailbox.quotaMb ? quotaMb * 1024 * 1024 : undefined,
      suspended: body.status !== undefined && body.status !== mailbox.status ? body.status === 'suspended' : undefined,
    };
    if (patch.displayName !== undefined || patch.quotaBytes !== undefined || patch.suspended !== undefined) {
      await getEngine().updateMailbox(mailbox.email, patch);
    }

    db.prepare(
      `UPDATE mailboxes SET display_name = COALESCE(?, display_name),
         quota_mb = COALESCE(?, quota_mb), status = COALESCE(?, status)
       WHERE id = ?`,
    ).run(body.displayName ?? null, quotaMb ?? null, body.status ?? null, id);

    const changes: Record<string, unknown> = {};
    if (patch.displayName !== undefined) changes.displayName = patch.displayName;
    if (patch.quotaBytes !== undefined) changes.quotaMb = quotaMb;
    if (patch.suspended !== undefined) changes.status = body.status;
    audit(req, 'mailbox.updated', { id, email: mailbox.email, ...changes }, domain.clientId);
    return { mailbox: getMailbox(id) };
  });

  /** Restablece la contraseña: genera una nueva o aplica la indicada. */
  app.post('/api/mailboxes/:id/password', async (req) => {
    const { id } = req.params as { id: string };
    const { mailbox, domain } = requireMailboxAccess(req, id);
    const body = z.object({ password: passwordSchema.optional() }).parse(req.body ?? {});
    const password = body.password || generateMailboxPassword();
    // El motor conserva las contraseñas de aplicación: solo cambia la principal.
    await getEngine().setMailboxPassword(mailbox.email, password);
    // La contraseña anterior deja de valer: se borra de los enlaces de
    // configuración que la llevaban y se cierran las sesiones de «Mi buzón».
    alCambiarContrasenaBuzon(id);
    audit(req, 'mailbox.password_reset', { id, email: mailbox.email, generated: !body.password }, domain.clientId);
    return { password: body.password ? undefined : password, ok: true };
  });

  app.delete('/api/mailboxes/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { mailbox, domain } = requireMailboxAccess(req, id);
    const keyCount = (
      db
        .prepare('SELECT COUNT(*) AS c FROM api_keys WHERE sender_mailbox_id = ? AND revoked_at IS NULL')
        .get(id) as { c: number }
    ).c;
    if (keyCount > 0) {
      throw conflict(
        `Este buzón es el remitente de ${keyCount === 1 ? '1 clave' : `${keyCount} claves`} de API activas. Revoque esas claves antes de eliminarlo.`,
        'mailbox_in_use',
      );
    }

    const engine = getEngine();
    const email = mailbox.email.toLowerCase();
    // Los alias que reenvían a este buzón se actualizan ANTES de borrarlo (en
    // el motor, los miembros de una lista deben existir). Cada alias se
    // guarda en la base justo después de cambiarlo en el motor, para que
    // ambos coincidan aunque algo falle a mitad.
    // Sin filtrar por cliente: versiones anteriores permitían destinos de
    // otros clientes y esos alias también deben dejar de apuntar aquí.
    const candidates = db
      .prepare(`${ALIAS_SELECT} WHERE lower(a.destinations_json) LIKE ?`)
      .all(`%${email}%`) as AliasRow[];
    const aliasesUpdated: string[] = [];
    const aliasesDeleted: string[] = [];
    for (const alias of candidates) {
      const destinations = parseDestinations(alias.destinations_json);
      if (!destinations.some((d) => d.toLowerCase() === email)) continue;
      const remaining = destinations.filter((d) => d.toLowerCase() !== email);
      const aliasEmail = `${alias.local_part}@${alias.domain}`;
      if (remaining.length === 0) {
        // Un alias sin destinos no entrega a nadie: se elimina.
        await engine.deleteAlias(aliasEmail);
        db.prepare('DELETE FROM aliases WHERE id = ?').run(alias.id);
        aliasesDeleted.push(aliasEmail);
      } else {
        const internal = remaining.filter((d) => d.toLowerCase() !== email && isInstanceMailbox(d));
        const external = remaining.filter((d) => !internal.includes(d));
        await engine.upsertAlias(aliasEmail, internal, external);
        db.prepare('UPDATE aliases SET destinations_json = ? WHERE id = ?').run(JSON.stringify(remaining), alias.id);
        aliasesUpdated.push(aliasEmail);
      }
    }

    await engine.deleteMailbox(mailbox.email);
    db.prepare('DELETE FROM mailboxes WHERE id = ?').run(id);
    audit(req, 'mailbox.deleted', { id, email: mailbox.email, aliasesUpdated, aliasesDeleted }, domain.clientId);
    return { ok: true, aliasesUpdated, aliasesDeleted };
  });

  /* --------------------------------- Alias -------------------------------- */

  app.get('/api/aliases', async (req) => {
    const user = requireAuth(req);
    const { domainId, clientId } = req.query as { domainId?: string; clientId?: string };
    const where: string[] = [];
    const params: string[] = [];
    const scope = user.role === 'client' ? user.clientId! : clientId;
    if (scope) {
      where.push('d.client_id = ?');
      params.push(scope);
    }
    if (domainId) {
      where.push('a.domain_id = ?');
      params.push(domainId);
    }
    const sql = `${ALIAS_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.domain, a.local_part`;
    const rows = db.prepare(sql).all(...params) as AliasRow[];
    return { aliases: rows.map(toAlias) };
  });

  app.post('/api/aliases', async (req) => {
    const body = z
      .object({
        domainId: z.string({ required_error: 'Seleccione un dominio.' }).min(1, 'Seleccione un dominio.'),
        localPart: z
          .string({ required_error: 'Indique el nombre del alias.' })
          .min(1, 'Indique el nombre del alias.'),
        destinations: destinationsSchema,
      })
      .parse(req.body);
    const domain = getDomain(body.domainId);
    requireClientAccess(req, domain.clientId);
    assertWithinLimit(domain.clientId, 'aliases');

    const localPart = normalizeLocalPart(body.localPart);
    const email = `${localPart}@${domain.domain}`;
    if (mailboxExists(domain.id, localPart)) {
      throw conflict(`Ya existe un buzón ${email}. Elija otro nombre para el alias.`, 'mailbox_exists');
    }
    if (aliasExists(domain.id, localPart)) throw conflict(`El alias ${email} ya existe.`, 'alias_exists');

    const { all, internal, external } = classifyDestinations(domain.clientId, email, body.destinations);
    await getEngine().upsertAlias(email, internal, external);

    const id = randomId('als');
    try {
      // Siempre en minúsculas: el motor las compara así y el panel también.
      db.prepare(
        `INSERT INTO aliases (id, domain_id, local_part, destinations_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, domain.id, localPart, JSON.stringify(all), now());
    } catch (err) {
      await getEngine().deleteAlias(email).catch(() => undefined);
      throw err;
    }
    audit(req, 'alias.created', { id, email, destinations: all.length, external: external.length }, domain.clientId);
    return { ok: true, id, alias: toAlias(getAliasRow(id)) };
  });

  app.patch('/api/aliases/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = getAliasRow(id);
    requireClientAccess(req, row.client_id);
    const body = z.object({ destinations: destinationsSchema }).parse(req.body ?? {});
    const email = `${row.local_part}@${row.domain}`;
    const { all, internal, external } = classifyDestinations(row.client_id, email, body.destinations);
    await getEngine().upsertAlias(email, internal, external);
    db.prepare('UPDATE aliases SET destinations_json = ? WHERE id = ?').run(JSON.stringify(all), id);
    audit(req, 'alias.updated', { id, email, destinations: all.length, external: external.length }, row.client_id);
    return { alias: toAlias(getAliasRow(id)) };
  });

  app.delete('/api/aliases/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = getAliasRow(id);
    requireClientAccess(req, row.client_id);
    const email = `${row.local_part}@${row.domain}`;
    await getEngine().deleteAlias(email);
    db.prepare('DELETE FROM aliases WHERE id = ?').run(id);
    audit(req, 'alias.deleted', { id, email }, row.client_id);
    return { ok: true };
  });
}
