import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { hashPassword, randomId } from '../core/crypto';
import { badRequest, conflict, notFound } from '../core/errors';
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
  };
}

export function getClient(id: string): Client {
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as ClientRow | undefined;
  if (!row) throw notFound('Cliente no encontrado.');
  return toClient(row);
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
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/* --------------------------------- Rutas ---------------------------------- */

const planSchema = z.object({
  name: z.string().trim().min(2).max(60),
  maxDomains: z.number().int().min(1).max(1000),
  maxMailboxes: z.number().int().min(1).max(100000),
  maxAliases: z.number().int().min(0).max(100000),
  mailboxQuotaMb: z.number().int().min(64).max(1048576),
  apiDailyLimit: z.number().int().min(0).max(10000000),
  apiPerMinuteLimit: z.number().int().min(1).max(100000),
  notes: z.string().max(500).optional().default(''),
});

const clientSchema = z.object({
  name: z.string().trim().min(2, 'El nombre es demasiado corto.').max(80),
  contactEmail: z.string().email('Correo de contacto no válido.').or(z.literal('')).default(''),
  planId: z.string().min(1),
  notes: z.string().max(1000).optional().default(''),
});

const clientUserSchema = z.object({
  email: z.string().email('Correo no válido.'),
  name: z.string().trim().min(2).max(80),
  password: z.string().min(10, 'La contraseña debe tener al menos 10 caracteres.'),
});

export function registerClientRoutes(app: FastifyInstance): void {
  /* Planes */
  app.get('/api/plans', async (req) => {
    requireAdmin(req);
    return { plans: listPlans() };
  });

  app.post('/api/plans', async (req) => {
    requireAdmin(req);
    const body = planSchema.parse(req.body);
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
    return { plan: getPlan(id) };
  });

  app.patch('/api/plans/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    getPlan(id);
    const body = planSchema.parse(req.body);
    db.prepare(
      `UPDATE plans SET name = ?, max_domains = ?, max_mailboxes = ?, max_aliases = ?,
         mailbox_quota_mb = ?, api_daily_limit = ?, api_per_minute_limit = ?, notes = ?
       WHERE id = ?`,
    ).run(
      body.name, body.maxDomains, body.maxMailboxes, body.maxAliases,
      body.mailboxQuotaMb, body.apiDailyLimit, body.apiPerMinuteLimit, body.notes, id,
    );
    audit(req, 'plan.updated', { id });
    return { plan: getPlan(id) };
  });

  app.delete('/api/plans/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const inUse = (
      db.prepare('SELECT COUNT(*) AS c FROM clients WHERE plan_id = ?').get(id) as { c: number }
    ).c;
    if (inUse > 0) {
      throw conflict(`No se puede borrar: ${inUse} cliente(s) usan este plan. Cámbialos antes de plan.`);
    }
    db.prepare('DELETE FROM plans WHERE id = ?').run(id);
    audit(req, 'plan.deleted', { id });
    return { ok: true };
  });

  /* Clientes */
  app.get('/api/clients', async (req) => {
    requireAdmin(req);
    const rows = db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all() as ClientRow[];
    return {
      clients: rows.map((row) => ({
        ...toClient(row),
        plan: getPlan(row.plan_id),
        usage: getClientUsage(row.id),
      })),
    };
  });

  app.post('/api/clients', async (req) => {
    requireAdmin(req);
    const body = clientSchema.parse(req.body);
    getPlan(body.planId);
    const id = randomId('cli');
    let slug = slugify(body.name) || id;
    const slugTaken = db.prepare('SELECT 1 FROM clients WHERE slug = ?').get(slug);
    if (slugTaken) slug = `${slug}-${id.slice(-4)}`;
    db.prepare(
      `INSERT INTO clients (id, name, slug, contact_email, plan_id, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, body.name, slug, body.contactEmail, body.planId, body.notes, now());
    audit(req, 'client.created', { id, name: body.name });
    return { client: { ...getClient(id), plan: getPlan(body.planId), usage: getClientUsage(id) } };
  });

  app.get('/api/clients/:id', async (req) => {
    const { id } = req.params as { id: string };
    requireClientAccess(req, id);
    const client = getClient(id);
    const users = db
      .prepare('SELECT id, email, name, disabled, last_login_at FROM users WHERE client_id = ?')
      .all(id) as { id: string; email: string; name: string; disabled: number; last_login_at: number | null }[];
    return {
      client: {
        ...client,
        plan: getPlan(client.planId),
        usage: getClientUsage(id),
        users: users.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          disabled: u.disabled === 1,
          lastLoginAt: u.last_login_at,
        })),
      },
    };
  });

  app.patch('/api/clients/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    getClient(id);
    const body = clientSchema
      .extend({ suspended: z.boolean().optional() })
      .partial()
      .parse(req.body);
    if (body.planId) getPlan(body.planId);
    const current = db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as ClientRow;
    db.prepare(
      `UPDATE clients SET name = ?, contact_email = ?, plan_id = ?, notes = ?, suspended = ?
       WHERE id = ?`,
    ).run(
      body.name ?? current.name,
      body.contactEmail ?? current.contact_email,
      body.planId ?? current.plan_id,
      body.notes ?? current.notes,
      body.suspended === undefined ? current.suspended : body.suspended ? 1 : 0,
      id,
    );
    audit(req, 'client.updated', { id });
    const updated = getClient(id);
    return { client: { ...updated, plan: getPlan(updated.planId), usage: getClientUsage(id) } };
  });

  app.delete('/api/clients/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const client = getClient(id);
    const usage = getClientUsage(id);
    if (usage.domains > 0) {
      throw conflict(
        'Este cliente aún tiene dominios. Borra primero sus dominios (y con ellos sus buzones) para evitar dejar cuentas huérfanas en el motor.',
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
    const existing = db
      .prepare('SELECT 1 FROM users WHERE email = ?')
      .get(body.email.toLowerCase().trim());
    if (existing) throw conflict('Ya existe un usuario con ese correo.');
    const user = createUser({ ...body, role: 'client', clientId: id });
    audit(req, 'client.user_created', { clientId: id, email: user.email });
    return { user };
  });

  app.patch('/api/clients/:id/users/:userId', async (req) => {
    requireAdmin(req);
    const { id, userId } = req.params as { id: string; userId: string };
    getClient(id);
    const body = z
      .object({
        password: z.string().min(10).optional(),
        disabled: z.boolean().optional(),
      })
      .parse(req.body);
    const row = db
      .prepare('SELECT id FROM users WHERE id = ? AND client_id = ?')
      .get(userId, id);
    if (!row) throw notFound('Usuario no encontrado.');
    if (body.password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
        hashPassword(body.password),
        userId,
      );
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
    if (body.disabled !== undefined) {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, userId);
      if (body.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
    audit(req, 'client.user_updated', { clientId: id, userId });
    return { ok: true };
  });

  app.delete('/api/clients/:id/users/:userId', async (req) => {
    requireAdmin(req);
    const { id, userId } = req.params as { id: string; userId: string };
    const row = db.prepare('SELECT 1 FROM users WHERE id = ? AND client_id = ?').get(userId, id);
    if (!row) throw notFound('Usuario no encontrado.');
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    audit(req, 'client.user_deleted', { clientId: id, userId });
    return { ok: true };
  });
}

/** Comprueba que el cliente puede crear un recurso más según su plan. */
export function assertWithinLimit(
  clientId: string,
  resource: 'domains' | 'mailboxes' | 'aliases',
): void {
  const client = getClient(clientId);
  if (client.suspended) throw badRequest('Este cliente está suspendido.', 'client_suspended');
  const plan = getPlan(client.planId);
  const usage = getClientUsage(clientId);
  const limits: Record<typeof resource, { used: number; max: number; label: string }> = {
    domains: { used: usage.domains, max: plan.maxDomains, label: 'dominios' },
    mailboxes: { used: usage.mailboxes, max: plan.maxMailboxes, label: 'buzones' },
    aliases: { used: usage.aliases, max: plan.maxAliases, label: 'alias' },
  };
  const limit = limits[resource];
  if (limit.used >= limit.max) {
    throw badRequest(
      `Has alcanzado el máximo de ${limit.label} de tu plan (${limit.max}). Pide una ampliación a tu proveedor.`,
      'plan_limit_reached',
    );
  }
}
