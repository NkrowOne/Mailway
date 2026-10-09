import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { clientLockKey, withLock } from '../core/locks';
import { generateMailboxPassword, randomId } from '../core/crypto';
import { HttpError, badRequest, conflict, isUniqueViolation, notFound } from '../core/errors';
import { getEngine } from '../engine';
import { audit } from './audit';
import { requireAuth, requireClientAccess, type AuthedUser } from './auth';
import {
  DIRECCIONES_OBLIGATORIAS,
  assertClientActive,
  assertWithinLimit,
  esDireccionObligatoria,
  getClient,
  getClientUsage,
  getPlan,
} from './clients';
import { cambiarContrasenaBuzon, crearBuzonEnMotor, guardarHashBuzon } from './credenciales';
import { assertDomainOwnership, getDomain, type DomainRecord } from './domains';
import { exigirSinMantenimiento } from './mantenimiento';
import { alCambiarContrasenaBuzon, enlaceConContrasena, olvidarBuzonConfigurado } from './portal';
import { MENSAJE_DIRECCION_RESERVADA, assertDireccionNoReservada, esDireccionReservada } from './remitente';

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
  /** Última vez que cambió la foto (para invalidar la caché); null = sin foto. */
  photoUpdatedAt: number | null;
  /**
   * Primer momento en que el titular demostró tener acceso (terminó el enlace
   * de configuración, descargó el perfil de Apple, entró en «Mi buzón» o en
   * el webmail) o en que se marcó a mano; null = sin configurar.
   */
  configuredAt: number | null;
  /** Entrega de la configuración al titular. */
  setup: EntregaConfiguracion;
}

export interface EntregaConfiguracion {
  /** Creación del último enlace de configuración (de cualquier estado). */
  lastLinkAt: number | null;
  /** Última vez que se abrió alguno de sus enlaces. */
  lastOpenedAt: number | null;
  /** Último correo de configuración enviado (o intentado). */
  lastEmail: { to: string; at: number; status: 'sent' | 'failed' } | null;
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
  photo_updated_at: number | null;
  configured_at: number | null;
  last_link_at: number | null;
  last_opened_at: number | null;
  last_email_to: string | null;
  last_email_at: number | null;
  last_email_status: 'sent' | 'failed' | null;
}

// La foto solo aporta su fecha: la imagen se sirve aparte. La entrega de la
// configuración sale de subconsultas por buzón que usan los índices por
// mailbox_id: el listado sigue siendo UNA consulta, sin una más por buzón.
const MAILBOX_SELECT = `SELECT m.*, d.domain, d.client_id, c.name AS client_name,
    p.updated_at AS photo_updated_at,
    (SELECT MAX(sl.created_at) FROM setup_links sl WHERE sl.mailbox_id = m.id) AS last_link_at,
    (SELECT MAX(sl.last_opened_at) FROM setup_links sl WHERE sl.mailbox_id = m.id) AS last_opened_at,
    ec.recipient AS last_email_to, ec.created_at AS last_email_at, ec.status AS last_email_status
  FROM mailboxes m
  JOIN domains d ON d.id = m.domain_id
  JOIN clients c ON c.id = d.client_id
  LEFT JOIN mailbox_photos p ON p.mailbox_id = m.id
  LEFT JOIN envios_configuracion ec ON ec.id = (
    SELECT e.id FROM envios_configuracion e WHERE e.mailbox_id = m.id
    ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1
  )`;

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
    photoUpdatedAt: row.photo_updated_at ?? null,
    configuredAt: row.configured_at ?? null,
    setup: {
      lastLinkAt: row.last_link_at ?? null,
      lastOpenedAt: row.last_opened_at ?? null,
      lastEmail:
        row.last_email_at !== null && row.last_email_to !== null && row.last_email_status !== null
          ? { to: row.last_email_to, at: row.last_email_at, status: row.last_email_status }
          : null,
    },
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
  // configuration@ es la cuenta oculta desde la que se envían los correos de
  // configuración de cada dominio: ni buzón ni alias pueden ocuparla.
  assertDireccionNoReservada(local);
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

function mailboxExistsError(email: string): HttpError {
  return conflict(`El buzón ${email} ya existe.`, 'mailbox_exists');
}

/** Motivo por el que no se puede crear nada en el dominio, o null si se puede. */
function ownershipPendingMessage(domainId: string): string | null {
  try {
    assertDomainOwnership(domainId);
    return null;
  } catch (err) {
    if (err instanceof HttpError && err.code === 'domain_ownership_pending') return err.message;
    throw err;
  }
}

function mailboxExists(domainId: string, localPart: string): boolean {
  return Boolean(
    db.prepare('SELECT 1 FROM mailboxes WHERE domain_id = ? AND local_part = ?').get(domainId, localPart),
  );
}

function aliasExistsError(email: string): HttpError {
  return conflict(`El alias ${email} ya existe.`, 'alias_exists');
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
  domainId: z.string({ required_error: 'Selecciona un dominio.' }).min(1, 'Selecciona un dominio.'),
  localPart: z
    .string({ required_error: 'Indica el nombre del buzón (lo que va antes de la @).' })
    .min(1, 'Indica el nombre del buzón (lo que va antes de la @).'),
  displayName: displayNameSchema.optional().default(''),
  password: passwordSchema.optional(),
  quotaMb: quotaSchema.optional(),
});

const bulkSchema = z.object({
  domainId: z.string({ required_error: 'Selecciona un dominio.' }).min(1, 'Selecciona un dominio.'),
  entries: z
    .array(
      z.object({
        localPart: z.string({ required_error: 'Falta el nombre del buzón.' }).max(200),
        displayName: displayNameSchema.optional().default(''),
      }),
      { required_error: 'Añade al menos una dirección.' },
    )
    .min(1, 'Añade al menos una dirección.')
    .max(100, 'Se pueden crear como máximo 100 buzones por lote.'),
  quotaMb: quotaSchema.optional(),
  /** true = solo validar y devolver la previsión, sin crear nada. */
  dryRun: z.boolean().optional().default(false),
  /**
   * Un enlace de configuración por buzón, con su contraseña dentro: quien da
   * de alta al equipo lo envía a cada titular sin copiar contraseñas.
   */
  setupLinks: z
    .object({
      ttlHours: z
        .number()
        .int('La validez debe indicarse en horas enteras.')
        .min(1, 'La validez mínima del enlace es de 1 hora.')
        .max(720, 'La validez máxima del enlace es de 720 horas (30 días).')
        .optional()
        .default(72),
    })
    .optional(),
});

/**
 * Crea un buzón en el motor y en la base. Comprueba el plan y la propiedad
 * del dominio justo antes de crear; quien llama debe tener el cerrojo del
 * cliente (clientLockKey), que es lo que impide que dos altas simultáneas
 * de la misma dirección lleguen a la vez al motor.
 */
async function createMailboxRecord(input: {
  domain: DomainRecord;
  localPart: string;
  displayName: string;
  password?: string;
  quotaMb?: number;
  viewerIsAdmin: boolean;
}): Promise<{ mailbox: Mailbox; password: string }> {
  const { domain, localPart } = input;
  assertWithinLimit(domain.clientId, 'mailboxes', 1, input.viewerIsAdmin);
  assertDomainOwnership(domain.id);
  const email = `${localPart}@${domain.domain}`;
  if (mailboxExists(domain.id, localPart)) throw mailboxExistsError(email);
  if (aliasExists(domain.id, localPart)) {
    throw conflict(`Ya existe un alias ${email}. Elige otro nombre.`, 'alias_exists');
  }

  const plan = getPlan(getClient(domain.clientId).planId);
  const quotaMb = Math.min(input.quotaMb ?? plan.mailboxQuotaMb, plan.mailboxQuotaMb);
  const password = input.password || generateMailboxPassword();

  const engine = getEngine();
  // El hash se calcula una vez: lo recibe el motor y el panel guarda su copia.
  const passwordHash = await crearBuzonEnMotor(
    { email, password, displayName: input.displayName, quotaBytes: quotaMb * 1024 * 1024 },
    engine,
  );

  const id = randomId('mbx');
  const t = now();
  try {
    // La fila y su copia del hash, juntas: un buzón sin copia no podría
    // entrar en «Mi buzón» con el motor 0.16.
    db.transaction(() => {
      // Un buzón recién creado está vacío: así el listado no tiene que
      // consultar al motor solo por él.
      db.prepare(
        `INSERT INTO mailboxes (id, domain_id, local_part, display_name, quota_mb, created_at,
           used_bytes, usage_checked_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(id, domain.id, localPart, input.displayName, quotaMb, t, t);
      guardarHashBuzon(id, passwordHash, 'panel');
    })();
  } catch (err) {
    // Otra petición ya registró esta dirección: el principal del motor es
    // SUYO (con su contraseña). Borrarlo dejaría su buzón en el panel sin
    // cuenta en el motor; se responde 409 y no se toca nada.
    if (isUniqueViolation(err)) throw mailboxExistsError(email);
    // Cualquier otro fallo (p. ej. el dominio se borró en paralelo → FK):
    // se deshace el buzón en el motor para no dejar un principal huérfano
    // que impediría recrear esa dirección.
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
        `${dest} no es un buzón existente. Crea antes el buzón o indica otra dirección.`,
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
    { required_error: 'Añade al menos un destino.' },
  )
  .min(1, 'Añade al menos un destino.')
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
    const user = requireClientAccess(req, domain.clientId);
    const localPart = normalizeLocalPart(body.localPart);
    const { mailbox, password } = await withLock(clientLockKey(domain.clientId), () =>
      createMailboxRecord({
        domain,
        localPart,
        displayName: body.displayName,
        password: body.password,
        quotaMb: body.quotaMb,
        viewerIsAdmin: user.role === 'admin',
      }),
    );
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
    const user = requireClientAccess(req, domain.clientId);
    const viewerIsAdmin = user.role === 'admin';
    const client = getClient(domain.clientId);
    assertClientActive(client.id);
    // Sin propiedad comprobada no se crea ningún buzón; la revisión lo dice
    // en cada línea para que nadie prepare un lote que no se va a crear.
    const ownershipError = ownershipPendingMessage(domain.id);

    const seen = new Set<string>();
    const checked = body.entries.map((entry) => {
      const localPart = entry.localPart.trim().toLowerCase();
      const email = `${localPart}@${domain.domain}`;
      let error = localPartError(localPart);
      if (!error && esDireccionReservada(localPart)) error = MENSAJE_DIRECCION_RESERVADA;
      if (!error && seen.has(localPart)) error = 'La dirección está repetida en la lista.';
      if (!error && mailboxExists(domain.id, localPart)) error = 'El buzón ya existe.';
      if (!error && aliasExists(domain.id, localPart)) error = 'Ya existe un alias con esa dirección.';
      if (!error && ownershipError) error = 'Falta comprobar la propiedad del dominio.';
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
        ownershipPending: ownershipError !== null,
        ownershipError,
        results: checked.map((c) => ({
          localPart: c.localPart,
          email: c.email,
          displayName: c.displayName,
          ok: !c.error,
          error: c.error ?? undefined,
        })),
      };
    }

    if (ownershipError) throw conflict(ownershipError, 'domain_ownership_pending');
    // Cada buzón del lote falla por separado: durante el mantenimiento del
    // motor fallarían todos, mejor un 503 claro antes de empezar.
    exigirSinMantenimiento();
    if (valid.length === 0) {
      throw badRequest('Ninguna dirección de la lista es válida. Revisa la lista e inténtalo de nuevo.', 'bulk_empty');
    }
    // Con el cerrojo del cliente, ninguna otra alta (individual o masiva) se
    // cuela entre la comprobación del plan y la última inserción del lote.
    return withLock(clientLockKey(client.id), async () => {
    assertWithinLimit(client.id, 'mailboxes', valid.length, viewerIsAdmin);
    if (bulkInProgress.has(client.id)) {
      throw conflict('Ya hay un alta masiva en curso para este cliente. Espera a que termine.', 'bulk_in_progress');
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
      setupLink?: { id: string; url: string; expiresAt: number; hasPassword: boolean };
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
            viewerIsAdmin,
          });
          results.push({
            localPart: entry.localPart,
            email: entry.email,
            displayName: entry.displayName,
            ok: true,
            mailbox: created.mailbox,
            password: created.password,
            setupLink:
              body.setupLinks && created.password
                ? enlaceConContrasena(req, created.mailbox.id, created.password, body.setupLinks.ttlHours)
                : undefined,
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
      setupLinks: results.filter((r) => r.setupLink).length,
    });
    return {
      results,
      created: createdEmails.length,
      failed: results.length - createdEmails.length,
      capacity: { ...capacity, used: capacity.used + createdEmails.length, remaining: Math.max(0, capacity.remaining - createdEmails.length) },
    };
    });
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
    // El motor conserva las contraseñas de aplicación: solo cambia la principal
    // (y la copia del panel con la que se comprueba).
    await cambiarContrasenaBuzon(mailbox, password);
    // La contraseña anterior deja de valer: se borra de los enlaces de
    // configuración que la llevaban y se cierran las sesiones de «Mi buzón».
    alCambiarContrasenaBuzon(id);
    // Los dispositivos del titular dejan de entrar: vuelve a estar sin
    // configurar hasta que use la contraseña nueva.
    olvidarBuzonConfigurado(id);
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
        `Este buzón es el remitente de ${keyCount === 1 ? '1 clave' : `${keyCount} claves`} de API activas. Revoca esas claves antes de eliminarlo.`,
        'mailbox_in_use',
      );
    }
    // Igual con los formularios: borrarlo se los llevaría por delante sin aviso
    // y la web seguiría mostrando un formulario que ya no entrega.
    const formCount = (
      db.prepare('SELECT COUNT(*) AS c FROM forms WHERE recipient_mailbox_id = ?').get(id) as { c: number }
    ).c;
    if (formCount > 0) {
      throw conflict(
        `Este buzón recibe ${formCount === 1 ? '1 formulario' : `${formCount} formularios`} de la web. Elimínalos en «Formularios» antes de eliminarlo.`,
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
        domainId: z.string({ required_error: 'Selecciona un dominio.' }).min(1, 'Selecciona un dominio.'),
        localPart: z
          .string({ required_error: 'Indica el nombre del alias.' })
          .min(1, 'Indica el nombre del alias.'),
        destinations: destinationsSchema,
      })
      .parse(req.body);
    const domain = getDomain(body.domainId);
    const user = requireClientAccess(req, domain.clientId);
    return withLock(clientLockKey(domain.clientId), async () => {
    const localPart = normalizeLocalPart(body.localPart);
    // postmaster@ y abuse@ los exigen los estándares: no cuentan para el plan.
    if (esDireccionObligatoria(localPart)) assertClientActive(domain.clientId);
    else assertWithinLimit(domain.clientId, 'aliases', 1, user.role === 'admin');
    assertDomainOwnership(domain.id);

    const email = `${localPart}@${domain.domain}`;
    if (mailboxExists(domain.id, localPart)) {
      throw conflict(`Ya existe un buzón ${email}. Elige otro nombre para el alias.`, 'mailbox_exists');
    }
    if (aliasExists(domain.id, localPart)) throw aliasExistsError(email);

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
      // Igual que con los buzones: si otra petición registró el alias, la
      // lista del motor es la suya y no se borra.
      if (isUniqueViolation(err)) throw aliasExistsError(email);
      await getEngine().deleteAlias(email).catch(() => undefined);
      throw err;
    }
    audit(req, 'alias.created', { id, email, destinations: all.length, external: external.length }, domain.clientId);
    return { ok: true, id, alias: toAlias(getAliasRow(id)) };
    });
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

  /* ------------------------ Direcciones obligatorias ----------------------- */

  app.get('/api/domains/:id/essential-addresses', async (req) => {
    const { id } = req.params as { id: string };
    const domain = getDomain(id);
    requireClientAccess(req, domain.clientId);
    return { addresses: direccionesObligatorias(domain) };
  });

  /**
   * postmaster@ y abuse@ de un dominio en un solo paso (la puesta en marcha
   * del cliente): se crean o se actualizan como alias hacia los destinos
   * indicados. Si ya hay un buzón con ese nombre, ya entrega y se deja.
   */
  app.put('/api/domains/:id/essential-addresses', async (req) => {
    const { id } = req.params as { id: string };
    const domain = getDomain(id);
    const body = z.object({ destinations: destinationsSchema }).parse(req.body ?? {});
    requireClientAccess(req, domain.clientId);
    return withLock(clientLockKey(domain.clientId), async () => {
      assertClientActive(domain.clientId);
      assertDomainOwnership(domain.id);
      const engine = getEngine();
      for (const localPart of DIRECCIONES_OBLIGATORIAS) {
        if (mailboxExists(domain.id, localPart)) continue;
        const email = `${localPart}@${domain.domain}`;
        const { all, internal, external } = classifyDestinations(domain.clientId, email, body.destinations);
        // Motor primero y base después, alias a alias: si algo falla a mitad,
        // cada uno queda igual en los dos sitios y repetir lo completa.
        await engine.upsertAlias(email, internal, external);
        const existing = db
          .prepare('SELECT id FROM aliases WHERE domain_id = ? AND local_part = ?')
          .get(domain.id, localPart) as { id: string } | undefined;
        if (existing) {
          db.prepare('UPDATE aliases SET destinations_json = ? WHERE id = ?').run(JSON.stringify(all), existing.id);
        } else {
          db.prepare(
            `INSERT INTO aliases (id, domain_id, local_part, destinations_json, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(randomId('als'), domain.id, localPart, JSON.stringify(all), now());
        }
      }
      audit(
        req,
        'alias.essential_updated',
        { domain: domain.domain, destinations: body.destinations.length },
        domain.clientId,
      );
      return { addresses: direccionesObligatorias(domain) };
    });
  });
}

/** Estado de postmaster@ y abuse@ de un dominio: alias, buzón o sin crear. */
export function direccionesObligatorias(domain: { id: string; domain: string }): {
  localPart: string;
  email: string;
  kind: 'alias' | 'mailbox' | null;
  destinations: string[];
}[] {
  return DIRECCIONES_OBLIGATORIAS.map((localPart) => {
    const email = `${localPart}@${domain.domain}`;
    if (mailboxExists(domain.id, localPart)) return { localPart, email, kind: 'mailbox' as const, destinations: [] };
    const row = db
      .prepare('SELECT destinations_json FROM aliases WHERE domain_id = ? AND local_part = ?')
      .get(domain.id, localPart) as { destinations_json: string } | undefined;
    return row
      ? { localPart, email, kind: 'alias' as const, destinations: parseDestinations(row.destinations_json) }
      : { localPart, email, kind: null, destinations: [] };
  });
}
