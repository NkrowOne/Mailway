import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { generateMailboxPassword, hashPassword, randomId } from '../core/crypto';
import { badRequest, conflict, notFound } from '../core/errors';
import { getEngine } from '../engine';
import { audit } from './audit';
import { createUser, requireAdmin, requireClientAccess } from './auth';

/* --------------------------------- Planes -------------------------------- */

export interface Plan {
  id: string;
  name: string;
  maxDomains: number;
  maxMailboxes: number;
  maxAliases: number;
  mailboxQuotaMb: number;
  apiDailyLimit: number;
  apiPerMinuteLimit: number;
  notes: string;
}

interface PlanRow {
  id: string;
  name: string;
  max_domains: number;
  max_mailboxes: number;
  max_aliases: number;
  mailbox_quota_mb: number;
  api_daily_limit: number;
  api_per_minute_limit: number;
  notes: string;
}

function toPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    name: row.name,
    maxDomains: row.max_domains,
    maxMailboxes: row.max_mailboxes,
    maxAliases: row.max_aliases,
    mailboxQuotaMb: row.mailbox_quota_mb,
    apiDailyLimit: row.api_daily_limit,
    apiPerMinuteLimit: row.api_per_minute_limit,
    notes: row.notes,
  };
}

export function getPlan(id: string): Plan {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined;
  if (!row) throw notFound('Plan no encontrado.');
  return toPlan(row);
}

export function listPlans(): Plan[] {
  return (db.prepare('SELECT * FROM plans ORDER BY max_mailboxes').all() as PlanRow[]).map(toPlan);
}

/** Planes de ejemplo la primera vez que arranca la instancia. */
export function ensureDefaultPlans(): void {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM plans').get() as { c: number }).c;
  if (count > 0) return;
  const insert = db.prepare(
    `INSERT INTO plans (id, name, max_domains, max_mailboxes, max_aliases, mailbox_quota_mb,
       api_daily_limit, api_per_minute_limit, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const t = now();
  insert.run('plan_basico', 'Básico', 1, 5, 10, 2048, 500, 30, 'Para empezar: un dominio y 5 buzones.', t);
  insert.run('plan_negocio', 'Negocio', 3, 25, 50, 5120, 5000, 120, 'Varios dominios y equipo mediano.', t);
  insert.run('plan_agencia', 'Agencia', 10, 100, 200, 10240, 20000, 300, 'Para agencias con muchos clientes finales.', t);
}

function clientCountOfPlan(planId: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS c FROM clients WHERE plan_id = ?').get(planId) as { c: number }
  ).c;
}

/* -------------------------------- Clientes -------------------------------- */

export interface Client {
  id: string;
  name: string;
  slug: string;
  contactEmail: string;
  planId: string;
  suspended: boolean;
  notes: string;
  createdAt: number;
  /** Referencia en un sistema externo (p. ej. "skyway:project:<id>"), o null. */
  externalRef: string | null;
}

interface ClientRow {
  id: string;
  name: string;
  slug: string;
  contact_email: string;
  plan_id: string;
  suspended: number;
  notes: string;
  created_at: number;
  external_ref: string | null;
}

function toClient(row: ClientRow): Client {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    contactEmail: row.contact_email,
    planId: row.plan_id,
    suspended: row.suspended === 1,
    notes: row.notes,
    createdAt: row.created_at,
    externalRef: row.external_ref ?? null,
  };
}

/**
 * El cliente tal y como lo puede ver quien pregunta. Las notas son internas
 * de la administración (acuerdos, incidencias, precios): un usuario del
 * propio cliente no debe leerlas.
 */
export function clientForViewer(client: Client, viewerIsAdmin: boolean): Client | Omit<Client, 'notes'> {
  if (viewerIsAdmin) return client;
  const { notes: _notas, ...visible } = client;
  return visible;
}

/**
 * Un cliente suspendido no crea nada: ni recursos del plan ni credenciales
 * nuevas (claves de API, contraseñas de aplicación) que seguirían vivas al
 * reactivarlo sin que nadie las hubiera pedido con el cliente en regla.
 */
export function assertClientActive(clientId: string): void {
  if (getClient(clientId).suspended) {
    throw badRequest(
      'Este cliente está suspendido. No es posible crear recursos ni credenciales hasta que se reactive.',
      'client_suspended',
    );
  }
}

export function getClient(id: string): Client {
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as ClientRow | undefined;
  if (!row) throw notFound('Cliente no encontrado.');
  return toClient(row);
}

export function listClients(): Client[] {
  return (db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all() as ClientRow[]).map(
    toClient,
  );
}

export interface ClientUsage {
  domains: number;
  mailboxes: number;
  aliases: number;
  apiKeys: number;
  messagesLast30d: number;
}

export function getClientUsage(clientId: string): ClientUsage {
  const domains = (
    db.prepare('SELECT COUNT(*) AS c FROM domains WHERE client_id = ?').get(clientId) as { c: number }
  ).c;
  const mailboxes = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM mailboxes m JOIN domains d ON d.id = m.domain_id
         WHERE d.client_id = ?`,
      )
      .get(clientId) as { c: number }
  ).c;
  const aliases = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM aliases a JOIN domains d ON d.id = a.domain_id
         WHERE d.client_id = ?`,
      )
      .get(clientId) as { c: number }
  ).c;
  const apiKeys = (
    db
      .prepare('SELECT COUNT(*) AS c FROM api_keys WHERE client_id = ? AND revoked_at IS NULL')
      .get(clientId) as { c: number }
  ).c;
  const messagesLast30d = (
    db
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE client_id = ? AND created_at >= ?')
      .get(clientId, now() - 30 * 24 * 3600_000) as { c: number }
  ).c;
  return { domains, mailboxes, aliases, apiKeys, messagesLast30d };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function formatMbText(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  return `${mb} MB`;
}

function contar(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/**
 * Qué parte del uso actual de un cliente no cabe en un plan. Vacío = cabe.
 * Se comprueba al cambiar de plan: bajar a un plan menor que lo que ya se usa
 * dejaría al cliente «por encima» de su límite sin que nadie lo decidiera.
 */
export function planExcess(clientId: string, plan: Plan): string[] {
  const usage = getClientUsage(clientId);
  const excess: string[] = [];
  if (usage.domains > plan.maxDomains) {
    excess.push(
      `el cliente tiene ${contar(usage.domains, 'dominio', 'dominios')} y el plan permite ${plan.maxDomains}`,
    );
  }
  if (usage.mailboxes > plan.maxMailboxes) {
    excess.push(
      `el cliente tiene ${contar(usage.mailboxes, 'buzón', 'buzones')} y el plan permite ${plan.maxMailboxes}`,
    );
  }
  if (usage.aliases > plan.maxAliases) {
    excess.push(`el cliente tiene ${usage.aliases} alias y el plan permite ${plan.maxAliases}`);
  }
  // La ocupación real (no la cuota asignada) es lo que no se puede recortar
  // sin que el buzón deje de recibir correo.
  const overQuota = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM mailboxes m JOIN domains d ON d.id = m.domain_id
         WHERE d.client_id = ? AND m.used_bytes > ?`,
      )
      .get(clientId, plan.mailboxQuotaMb * 1024 * 1024) as { c: number }
  ).c;
  if (overQuota > 0) {
    excess.push(
      `${contar(overQuota, 'buzón ocupa', 'buzones ocupan')} más de la cuota por buzón del plan (${formatMbText(plan.mailboxQuotaMb)})`,
    );
  }
  return excess;
}

/** Ejecuta tareas asíncronas con un máximo de `limit` a la vez. */
async function runLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await task(item);
    }
  });
  await Promise.all(workers);
}

export interface SuspensionResult {
  /** Buzones cuyo estado se ha aplicado en el motor. */
  updated: number;
  /** Buzones suspendidos individualmente: se quedan como están. */
  skipped: number;
  failed: { email: string; error: string }[];
}

/**
 * Lleva la suspensión (o la reactivación) de un cliente a sus buzones en el
 * motor. Sin esto, suspender un cliente solo bloqueaba el panel y la API: sus
 * buzones seguían recibiendo y enviando correo.
 *
 * El estado propio de cada buzón (mailboxes.status) NO se toca: un buzón que
 * ya estaba suspendido individualmente sigue suspendido al reactivar el
 * cliente, y el efectivo es «suspendido si lo está el buzón o su cliente».
 * Es idempotente: repetir la operación reintenta los buzones que fallaron.
 */
export async function applyClientSuspension(
  clientId: string,
  suspended: boolean,
): Promise<SuspensionResult> {
  const rows = db
    .prepare(
      `SELECT m.local_part, m.status, d.domain FROM mailboxes m JOIN domains d ON d.id = m.domain_id
       WHERE d.client_id = ?`,
    )
    .all(clientId) as { local_part: string; status: 'active' | 'suspended'; domain: string }[];
  const result: SuspensionResult = { updated: 0, skipped: 0, failed: [] };
  const targets = rows.filter((row) => row.status === 'active');
  result.skipped = rows.length - targets.length;
  if (targets.length === 0) return result;
  const engine = getEngine();
  // Varias a la vez, pero pocas: el motor es un único servidor compartido.
  await runLimited(targets, 5, async (row) => {
    const email = `${row.local_part}@${row.domain}`;
    try {
      await engine.updateMailbox(email, { suspended });
      result.updated += 1;
    } catch (err) {
      result.failed.push({ email, error: (err as Error).message });
    }
  });
  return result;
}

/* ------------------------------- Validación ------------------------------- */

function entero(nombre: string, min: number, max: number) {
  const Nombre = nombre.charAt(0).toUpperCase() + nombre.slice(1);
  return z
    .number({
      required_error: `Indique ${nombre}.`,
      invalid_type_error: `${Nombre} debe ser un número.`,
    })
    .int(`${Nombre} debe ser un número entero.`)
    .min(min, `${Nombre} debe ser como mínimo ${min}.`)
    .max(max, `${Nombre} no puede superar ${max}.`);
}

const planFields = {
  name: z
    .string({ required_error: 'Indique el nombre del plan.' })
    .trim()
    .min(2, 'El nombre del plan debe tener al menos 2 caracteres.')
    .max(60, 'El nombre del plan no puede superar los 60 caracteres.'),
  maxDomains: entero('el máximo de dominios', 1, 1000),
  maxMailboxes: entero('el máximo de buzones', 1, 100000),
  maxAliases: entero('el máximo de alias', 0, 100000),
  mailboxQuotaMb: entero('la cuota por buzón (en MB)', 64, 1048576),
  apiDailyLimit: entero('el límite diario de envíos por API', 0, 10000000),
  apiPerMinuteLimit: entero('el límite de envíos por minuto', 1, 100000),
  notes: z.string().max(500, 'Las notas no pueden superar los 500 caracteres.'),
};

const planCreateSchema = z.object({ ...planFields, notes: planFields.notes.optional().default('') });
const planPatchSchema = z.object(planFields).partial();

const emailSchema = (message: string) =>
  z.string({ required_error: message }).trim().toLowerCase().max(254, message).email(message);

const contactEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'El correo de contacto no es válido.')
  .refine((v) => v === '' || z.string().email().safeParse(v).success, 'El correo de contacto no es válido.');

const clientFields = {
  name: z
    .string({ required_error: 'Indique el nombre del cliente.' })
    .trim()
    .min(2, 'El nombre del cliente debe tener al menos 2 caracteres.')
    .max(80, 'El nombre del cliente no puede superar los 80 caracteres.'),
  contactEmail: contactEmailSchema,
  planId: z.string({ required_error: 'Seleccione un plan.' }).min(1, 'Seleccione un plan.'),
  notes: z.string().max(1000, 'Las notas no pueden superar los 1000 caracteres.'),
};

const passwordSchema = z
  .string()
  .min(10, 'La contraseña debe tener al menos 10 caracteres.')
  .max(200, 'La contraseña no puede superar los 200 caracteres.');

const userFields = {
  email: emailSchema('El correo del usuario no es válido.'),
  name: z
    .string({ required_error: 'Indique el nombre del usuario.' })
    .trim()
    .min(2, 'El nombre del usuario debe tener al menos 2 caracteres.')
    .max(80, 'El nombre del usuario no puede superar los 80 caracteres.'),
  // Sin contraseña se genera una y se devuelve una sola vez.
  password: passwordSchema.optional(),
};

const clientCreateSchema = z.object({
  ...clientFields,
  contactEmail: contactEmailSchema.optional().default(''),
  notes: clientFields.notes.optional().default(''),
  /** Primer usuario de acceso al panel, en la misma operación. */
  user: z.object(userFields).optional(),
});

const clientPatchSchema = z
  .object({ ...clientFields, suspended: z.boolean({ invalid_type_error: 'Estado no válido.' }) })
  .partial();

const clientUserSchema = z.object(userFields);

const userPatchSchema = z.object({
  name: userFields.name.optional(),
  password: passwordSchema.optional(),
  /** true = generar una contraseña nueva y devolverla una sola vez. */
  generatePassword: z.boolean().optional(),
  disabled: z.boolean().optional(),
});

function assertUserEmailFree(email: string): void {
  const existing = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
  if (existing) throw conflict('Ya existe un usuario con ese correo.', 'user_exists');
}

function assertPlanNameFree(name: string, exceptId?: string): void {
  const taken = db
    .prepare('SELECT 1 FROM plans WHERE lower(name) = lower(?) AND id != ?')
    .get(name, exceptId ?? '');
  if (taken) throw conflict(`Ya existe un plan llamado «${name}».`, 'plan_exists');
}

interface ClientUserView {
  id: string;
  email: string;
  name: string;
  disabled: boolean;
  lastLoginAt: number | null;
}

function listClientUsers(clientId: string): ClientUserView[] {
  const rows = db
    .prepare(
      'SELECT id, email, name, disabled, last_login_at FROM users WHERE client_id = ? ORDER BY created_at',
    )
    .all(clientId) as { id: string; email: string; name: string; disabled: number; last_login_at: number | null }[];
  return rows.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    disabled: u.disabled === 1,
    lastLoginAt: u.last_login_at,
  }));
}

/* --------------------------------- Rutas ---------------------------------- */

export function registerClientRoutes(app: FastifyInstance): void {
  /* Planes */
  app.get('/api/plans', async (req) => {
    requireAdmin(req);
    // clientCount permite al editor de planes explicar por qué uno no se
    // puede eliminar sin una consulta por plan.
    const counts = new Map(
      (
        db.prepare('SELECT plan_id, COUNT(*) AS c FROM clients GROUP BY plan_id').all() as {
          plan_id: string;
          c: number;
        }[]
      ).map((r) => [r.plan_id, r.c]),
    );
    return { plans: listPlans().map((plan) => ({ ...plan, clientCount: counts.get(plan.id) ?? 0 })) };
  });

  app.post('/api/plans', async (req) => {
    requireAdmin(req);
    const body = planCreateSchema.parse(req.body);
    assertPlanNameFree(body.name);
    const id = randomId('plan');
    db.prepare(
      `INSERT INTO plans (id, name, max_domains, max_mailboxes, max_aliases, mailbox_quota_mb,
         api_daily_limit, api_per_minute_limit, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, body.name, body.maxDomains, body.maxMailboxes, body.maxAliases,
      body.mailboxQuotaMb, body.apiDailyLimit, body.apiPerMinuteLimit, body.notes, now(),
    );
    audit(req, 'plan.created', { id, name: body.name });
    return { plan: { ...getPlan(id), clientCount: 0 } };
  });

  app.patch('/api/plans/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const current = getPlan(id);
    // Se admite un cambio parcial: lo no enviado conserva su valor.
    const next = { ...current, ...planPatchSchema.parse(req.body ?? {}) };
    if (next.name !== current.name) assertPlanNameFree(next.name, id);
    db.prepare(
      `UPDATE plans SET name = ?, max_domains = ?, max_mailboxes = ?, max_aliases = ?,
         mailbox_quota_mb = ?, api_daily_limit = ?, api_per_minute_limit = ?, notes = ?
       WHERE id = ?`,
    ).run(
      next.name, next.maxDomains, next.maxMailboxes, next.maxAliases,
      next.mailboxQuotaMb, next.apiDailyLimit, next.apiPerMinuteLimit, next.notes, id,
    );
    audit(req, 'plan.updated', { id, name: next.name });
    return { plan: { ...getPlan(id), clientCount: clientCountOfPlan(id) } };
  });

  app.delete('/api/plans/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const plan = getPlan(id);
    const inUse = clientCountOfPlan(id);
    if (inUse > 0) {
      throw conflict(
        `No es posible eliminar el plan «${plan.name}»: lo ${inUse === 1 ? 'usa 1 cliente' : `usan ${inUse} clientes`}. Asígneles otro plan antes de eliminarlo.`,
        'plan_in_use',
      );
    }
    const total = (db.prepare('SELECT COUNT(*) AS c FROM plans').get() as { c: number }).c;
    if (total <= 1) {
      // Sin planes no se podría dar de alta ningún cliente (tampoco desde
      // las integraciones, que usan el primero disponible).
      throw conflict('No es posible eliminar el único plan de la instancia.', 'last_plan');
    }
    db.prepare('DELETE FROM plans WHERE id = ?').run(id);
    audit(req, 'plan.deleted', { id, name: plan.name });
    return { ok: true };
  });

  /* Clientes */
  app.get('/api/clients', async (req) => {
    requireAdmin(req);
    return {
      clients: listClients().map((client) => ({
        ...client,
        plan: getPlan(client.planId),
        usage: getClientUsage(client.id),
      })),
    };
  });

  app.post('/api/clients', async (req) => {
    requireAdmin(req);
    const body = clientCreateSchema.parse(req.body);
    getPlan(body.planId);
    // Se comprueba ANTES de crear el cliente: el alta guiada no debe dejar
    // un cliente a medias si el correo del usuario ya está en uso.
    if (body.user) assertUserEmailFree(body.user.email);

    const id = randomId('cli');
    let slug = slugify(body.name) || id;
    const slugTaken = db.prepare('SELECT 1 FROM clients WHERE slug = ?').get(slug);
    if (slugTaken) slug = `${slug}-${id.slice(-4)}`;
    const userPassword = body.user ? body.user.password || generateMailboxPassword() : null;

    const created = db.transaction(() => {
      db.prepare(
        `INSERT INTO clients (id, name, slug, contact_email, plan_id, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, body.name, slug, body.contactEmail, body.planId, body.notes, now());
      return body.user && userPassword
        ? createUser({
            email: body.user.email,
            name: body.user.name,
            password: userPassword,
            role: 'client',
            clientId: id,
          })
        : null;
    })();

    audit(req, 'client.created', { id, name: body.name }, id);
    if (created) audit(req, 'client.user_created', { clientId: id, email: created.email });
    return {
      client: { ...getClient(id), plan: getPlan(body.planId), usage: getClientUsage(id) },
      user: created ? { id: created.id, email: created.email, name: created.name } : undefined,
      // Solo si se generó: la que eligió el administrador ya la conoce.
      password: created && !body.user?.password ? userPassword : undefined,
    };
  });

  app.get('/api/clients/:id', async (req) => {
    const { id } = req.params as { id: string };
    const user = requireClientAccess(req, id);
    const client = getClient(id);
    const plan = getPlan(client.planId);
    const usage = getClientUsage(id);
    const users = listClientUsers(id);
    // La forma histórica anida plan/uso/usuarios en `client`; el contrato de
    // integraciones los espera también en la raíz. Se sirven ambas.
    return { client: { ...clientForViewer(client, user.role === 'admin'), plan, usage, users }, plan, usage, users };
  });

  app.patch('/api/clients/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const current = getClient(id);
    const body = clientPatchSchema.parse(req.body ?? {});

    if (body.planId && body.planId !== current.planId) {
      const nextPlan = getPlan(body.planId);
      const excess = planExcess(id, nextPlan);
      if (excess.length > 0) {
        throw conflict(
          `No es posible asignar el plan «${nextPlan.name}»: ${excess.join('; ')}. Reduzca el uso o elija un plan con más capacidad.`,
          'plan_below_usage',
        );
      }
    }

    db.prepare(
      `UPDATE clients SET name = ?, contact_email = ?, plan_id = ?, notes = ?, suspended = ?
       WHERE id = ?`,
    ).run(
      body.name ?? current.name,
      body.contactEmail ?? current.contactEmail,
      body.planId ?? current.planId,
      body.notes ?? current.notes,
      body.suspended === undefined ? (current.suspended ? 1 : 0) : body.suspended ? 1 : 0,
      id,
    );

    // La suspensión se aplica también a los buzones en el motor. Se hace
    // aunque el valor no cambie: así, repetir la petición reintenta los
    // buzones que hubieran fallado la primera vez.
    let suspension: SuspensionResult | undefined;
    if (body.suspended !== undefined) {
      suspension = await applyClientSuspension(id, body.suspended);
      if (body.suspended !== current.suspended) {
        audit(req, body.suspended ? 'client.suspended' : 'client.resumed', {
          id,
          name: current.name,
          mailboxes: suspension.updated,
          failed: suspension.failed.map((f) => f.email),
        }, id);
      }
    }

    const changed = (['name', 'contactEmail', 'planId', 'notes'] as const).filter(
      (key) => body[key] !== undefined && body[key] !== current[key],
    );
    if (changed.length > 0) {
      audit(req, 'client.updated', {
        id,
        fields: changed,
        ...(changed.includes('planId') ? { planFrom: current.planId, planTo: body.planId } : {}),
      }, id);
    }

    const updated = getClient(id);
    return {
      client: { ...updated, plan: getPlan(updated.planId), usage: getClientUsage(id) },
      suspension,
    };
  });

  app.delete('/api/clients/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const client = getClient(id);
    const usage = getClientUsage(id);
    if (usage.domains > 0) {
      throw conflict(
        'No es posible eliminar un cliente con dominios. Elimine antes sus dominios (y con ellos sus buzones) para no dejar cuentas huérfanas en el motor.',
        'client_has_domains',
      );
    }
    db.prepare('DELETE FROM clients WHERE id = ?').run(id);
    audit(req, 'client.deleted', { id, name: client.name });
    return { ok: true };
  });

  /* Usuarios de un cliente (acceso al panel) */
  app.post('/api/clients/:id/users', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    getClient(id);
    const body = clientUserSchema.parse(req.body);
    assertUserEmailFree(body.email);
    const password = body.password || generateMailboxPassword();
    const user = createUser({ email: body.email, name: body.name, password, role: 'client', clientId: id });
    audit(req, 'client.user_created', { clientId: id, email: user.email });
    return { user, password: body.password ? undefined : password };
  });

  app.patch('/api/clients/:id/users/:userId', async (req) => {
    requireAdmin(req);
    const { id, userId } = req.params as { id: string; userId: string };
    getClient(id);
    const body = userPatchSchema.parse(req.body ?? {});
    const row = db
      .prepare('SELECT id, email FROM users WHERE id = ? AND client_id = ?')
      .get(userId, id) as { id: string; email: string } | undefined;
    if (!row) throw notFound('Usuario no encontrado.');

    const newPassword = body.password || (body.generatePassword ? generateMailboxPassword() : null);
    if (newPassword) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
      // Una contraseña restablecida cierra las sesiones abiertas con la anterior.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
    if (body.name !== undefined) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(body.name, userId);
    }
    if (body.disabled !== undefined) {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, userId);
      if (body.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
    audit(req, 'client.user_updated', {
      clientId: id,
      userId,
      email: row.email,
      passwordReset: Boolean(newPassword),
      disabled: body.disabled,
    });
    return {
      ok: true,
      password: body.generatePassword && !body.password ? (newPassword ?? undefined) : undefined,
    };
  });

  app.delete('/api/clients/:id/users/:userId', async (req) => {
    requireAdmin(req);
    const { id, userId } = req.params as { id: string; userId: string };
    getClient(id);
    const row = db
      .prepare('SELECT email FROM users WHERE id = ? AND client_id = ?')
      .get(userId, id) as { email: string } | undefined;
    if (!row) throw notFound('Usuario no encontrado.');
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    audit(req, 'client.user_deleted', { clientId: id, userId, email: row.email });
    return { ok: true };
  });
}

/**
 * Comprueba que el cliente puede crear `adding` recursos más según su plan.
 * Las altas masivas lo comprueban para el lote entero ANTES de crear nada.
 */
export function assertWithinLimit(
  clientId: string,
  resource: 'domains' | 'mailboxes' | 'aliases',
  adding = 1,
  viewerIsAdmin = false,
): void {
  assertClientActive(clientId);
  const client = getClient(clientId);
  const plan = getPlan(client.planId);
  const usage = getClientUsage(clientId);
  const limits: Record<typeof resource, { used: number; max: number; label: string }> = {
    domains: { used: usage.domains, max: plan.maxDomains, label: 'dominios' },
    mailboxes: { used: usage.mailboxes, max: plan.maxMailboxes, label: 'buzones' },
    aliases: { used: usage.aliases, max: plan.maxAliases, label: 'alias' },
  };
  const limit = limits[resource];
  if (limit.used + adding > limit.max) {
    const remaining = Math.max(0, limit.max - limit.used);
    throw badRequest(
      adding === 1
        ? // El administrador no tiene a quién pedir la ampliación: la hace él.
          `Se ha alcanzado el máximo de ${limit.label} del plan «${plan.name}» (${limit.max}). ${
            viewerIsAdmin ? 'Amplíe el plan del cliente en su ficha.' : 'Solicite una ampliación del plan.'
          }`
        : `El plan «${plan.name}» permite ${limit.max} ${limit.label} y ya hay ${limit.used}: no es posible crear ${adding} más (quedan ${remaining}). No se ha creado ninguno.`,
      'plan_limit_reached',
    );
  }
}
