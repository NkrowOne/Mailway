import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { generateMailboxPassword, randomId } from '../core/crypto';
import { badRequest, conflict, notFound } from '../core/errors';
import { getEngine } from '../engine';
import { audit } from './audit';
import { requireAuth, requireClientAccess } from './auth';
import { assertWithinLimit, getClient, getPlan } from './clients';
import { getDomain } from './domains';

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
}

interface MailboxRow {
  id: string;
  domain_id: string;
  local_part: string;
  display_name: string;
  quota_mb: number;
  status: 'active' | 'suspended';
  created_at: number;
  domain?: string;
}

function toMailbox(row: MailboxRow, domainName: string): Mailbox {
  return {
    id: row.id,
    domainId: row.domain_id,
    domain: domainName,
    localPart: row.local_part,
    email: `${row.local_part}@${domainName}`,
    displayName: row.display_name,
    quotaMb: row.quota_mb,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function getMailbox(id: string): Mailbox {
  const row = db
    .prepare(
      `SELECT m.*, d.domain FROM mailboxes m JOIN domains d ON d.id = m.domain_id WHERE m.id = ?`,
    )
    .get(id) as (MailboxRow & { domain: string }) | undefined;
  if (!row) throw notFound('Buzón no encontrado.');
  return toMailbox(row, row.domain);
}

const LOCAL_PART_RE = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;

function normalizeLocalPart(input: string): string {
  const local = input.trim().toLowerCase();
  if (!LOCAL_PART_RE.test(local)) {
    throw badRequest(
      'El nombre del buzón solo puede llevar letras, números, puntos, guiones y guiones bajos (sin empezar ni acabar en símbolo).',
    );
  }
  return local;
}

function requireMailboxAccess(req: FastifyRequest, mailboxId: string) {
  const mailbox = getMailbox(mailboxId);
  const domain = getDomain(mailbox.domainId);
  const user = requireClientAccess(req, domain.clientId);
  return { user, mailbox, domain };
}

const createSchema = z.object({
  domainId: z.string().min(1),
  localPart: z.string().min(1, 'Escribe el nombre del buzón (lo que va antes de la @).'),
  displayName: z.string().trim().max(80).optional().default(''),
  password: z.string().min(10, 'La contraseña debe tener al menos 10 caracteres.').optional(),
  quotaMb: z.number().int().min(64).max(1048576).optional(),
});

export function registerMailboxRoutes(app: FastifyInstance): void {
  app.get('/api/mailboxes', async (req) => {
    const user = requireAuth(req);
    const { domainId, clientId } = req.query as { domainId?: string; clientId?: string };
    let sql = `SELECT m.*, d.domain FROM mailboxes m JOIN domains d ON d.id = m.domain_id`;
    const where: string[] = [];
    const params: string[] = [];
    if (user.role === 'client') {
      where.push('d.client_id = ?');
      params.push(user.clientId!);
    } else if (clientId) {
      where.push('d.client_id = ?');
      params.push(clientId);
    }
    if (domainId) {
      where.push('m.domain_id = ?');
      params.push(domainId);
    }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY d.domain, m.local_part';
    const rows = db.prepare(sql).all(...params) as (MailboxRow & { domain: string })[];
    return { mailboxes: rows.map((r) => toMailbox(r, r.domain)) };
  });

  app.post('/api/mailboxes', async (req) => {
    const body = createSchema.parse(req.body);
    const domain = getDomain(body.domainId);
    requireClientAccess(req, domain.clientId);
    assertWithinLimit(domain.clientId, 'mailboxes');

    const localPart = normalizeLocalPart(body.localPart);
    const email = `${localPart}@${domain.domain}`;
    const existing = db
      .prepare('SELECT 1 FROM mailboxes WHERE domain_id = ? AND local_part = ?')
      .get(domain.id, localPart);
    if (existing) throw conflict(`El buzón ${email} ya existe.`);
    const aliasClash = db
      .prepare('SELECT 1 FROM aliases WHERE domain_id = ? AND local_part = ?')
      .get(domain.id, localPart);
    if (aliasClash) throw conflict(`Ya hay un alias llamado ${email}; usa otro nombre.`);

    const client = getClient(domain.clientId);
    const plan = getPlan(client.planId);
    const quotaMb = Math.min(body.quotaMb ?? plan.mailboxQuotaMb, plan.mailboxQuotaMb);
    const password = body.password || generateMailboxPassword();

    const engine = getEngine();
    await engine.createMailbox({
      email,
      password,
      displayName: body.displayName,
      quotaBytes: quotaMb * 1024 * 1024,
    });

    const id = randomId('mbx');
    try {
      db.prepare(
        `INSERT INTO mailboxes (id, domain_id, local_part, display_name, quota_mb, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, domain.id, localPart, body.displayName, quotaMb, now());
    } catch (err) {
      // El INSERT falló (p. ej. el dominio se borró en paralelo → FK, o
      // colisión de unicidad): deshacemos el buzón en el motor para no dejar
      // un principal huérfano que impediría recrear esa dirección.
      await engine.deleteMailbox(email).catch(() => undefined);
      throw err;
    }
    audit(req, 'mailbox.created', { id, email });

    // La contraseña solo se devuelve en esta respuesta; no se guarda en claro.
    return { mailbox: getMailbox(id), password: body.password ? undefined : password };
  });

  app.patch('/api/mailboxes/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { mailbox } = requireMailboxAccess(req, id);
    const body = z
      .object({
        displayName: z.string().trim().max(80).optional(),
        quotaMb: z.number().int().min(64).max(1048576).optional(),
        status: z.enum(['active', 'suspended']).optional(),
      })
      .parse(req.body);

    const engine = getEngine();
    await engine.updateMailbox(mailbox.email, {
      displayName: body.displayName,
      quotaBytes: body.quotaMb !== undefined ? body.quotaMb * 1024 * 1024 : undefined,
      suspended: body.status !== undefined ? body.status === 'suspended' : undefined,
    });

    db.prepare(
      `UPDATE mailboxes SET display_name = COALESCE(?, display_name),
         quota_mb = COALESCE(?, quota_mb), status = COALESCE(?, status)
       WHERE id = ?`,
    ).run(body.displayName ?? null, body.quotaMb ?? null, body.status ?? null, id);
    audit(req, 'mailbox.updated', { id, email: mailbox.email });
    return { mailbox: getMailbox(id) };
  });

  /** Restablece la contraseña: genera una nueva o aplica la indicada. */
  app.post('/api/mailboxes/:id/password', async (req) => {
    const { id } = req.params as { id: string };
    const { mailbox } = requireMailboxAccess(req, id);
    const body = z
      .object({ password: z.string().min(10).optional() })
      .parse(req.body ?? {});
    const password = body.password || generateMailboxPassword();
    const engine = getEngine();
    await engine.setMailboxPassword(mailbox.email, password);
    audit(req, 'mailbox.password_reset', { id, email: mailbox.email });
    return { password: body.password ? undefined : password, ok: true };
  });

  app.delete('/api/mailboxes/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { mailbox } = requireMailboxAccess(req, id);
    const keyCount = (
      db
        .prepare(
          'SELECT COUNT(*) AS c FROM api_keys WHERE sender_mailbox_id = ? AND revoked_at IS NULL',
        )
        .get(id) as { c: number }
    ).c;
    if (keyCount > 0) {
      throw conflict(
        `Este buzón lo usan ${keyCount} clave(s) de API como remitente. Revoca esas claves antes de borrarlo.`,
      );
    }
    const engine = getEngine();
    await engine.deleteMailbox(mailbox.email);
    db.prepare('DELETE FROM mailboxes WHERE id = ?').run(id);
    audit(req, 'mailbox.deleted', { id, email: mailbox.email });
    return { ok: true };
  });

  /* --------------------------------- Alias -------------------------------- */

  app.get('/api/aliases', async (req) => {
    const user = requireAuth(req);
    const { domainId } = req.query as { domainId?: string };
    let sql = `SELECT a.*, d.domain FROM aliases a JOIN domains d ON d.id = a.domain_id`;
    const where: string[] = [];
    const params: string[] = [];
    if (user.role === 'client') {
      where.push('d.client_id = ?');
      params.push(user.clientId!);
    }
    if (domainId) {
      where.push('a.domain_id = ?');
      params.push(domainId);
    }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY d.domain, a.local_part';
    const rows = db.prepare(sql).all(...params) as {
      id: string;
      domain_id: string;
      local_part: string;
      destinations_json: string;
      created_at: number;
      domain: string;
    }[];
    return {
      aliases: rows.map((r) => ({
        id: r.id,
        domainId: r.domain_id,
        localPart: r.local_part,
        email: `${r.local_part}@${r.domain}`,
        destinations: JSON.parse(r.destinations_json) as string[],
        createdAt: r.created_at,
      })),
    };
  });

  app.post('/api/aliases', async (req) => {
    const body = z
      .object({
        domainId: z.string().min(1),
        localPart: z.string().min(1),
        destinations: z
          .array(z.string().email('Cada destino debe ser un correo válido.'))
          .min(1, 'Añade al menos un destino.')
          .max(20),
      })
      .parse(req.body);
    const domain = getDomain(body.domainId);
    requireClientAccess(req, domain.clientId);
    assertWithinLimit(domain.clientId, 'aliases');

    const localPart = normalizeLocalPart(body.localPart);
    const email = `${localPart}@${domain.domain}`;
    const mailboxClash = db
      .prepare('SELECT 1 FROM mailboxes WHERE domain_id = ? AND local_part = ?')
      .get(domain.id, localPart);
    if (mailboxClash) throw conflict(`Ya existe un buzón llamado ${email}; usa otro nombre.`);
    const existing = db
      .prepare('SELECT 1 FROM aliases WHERE domain_id = ? AND local_part = ?')
      .get(domain.id, localPart);
    if (existing) throw conflict(`El alias ${email} ya existe.`);

    // Los destinos deben ser buzones de esta misma instancia (el motor
    // entrega en local); las redirecciones externas quedan para el roadmap.
    for (const destination of body.destinations) {
      const [destLocal, destDomain] = destination.toLowerCase().split('@');
      const known = db
        .prepare(
          `SELECT 1 FROM mailboxes m JOIN domains d ON d.id = m.domain_id
           WHERE d.domain = ? AND m.local_part = ?`,
        )
        .get(destDomain, destLocal);
      if (!known) {
        throw badRequest(
          `El destino ${destination} no es un buzón de esta plataforma. De momento los alias solo pueden apuntar a buzones propios.`,
        );
      }
    }

    const engine = getEngine();
    await engine.upsertAlias(email, body.destinations.map((d) => d.toLowerCase()));

    const id = randomId('als');
    db.prepare(
      `INSERT INTO aliases (id, domain_id, local_part, destinations_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, domain.id, localPart, JSON.stringify(body.destinations), now());
    audit(req, 'alias.created', { id, email });
    return { ok: true, id };
  });

  app.delete('/api/aliases/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = db
      .prepare(
        `SELECT a.*, d.domain, d.client_id FROM aliases a
         JOIN domains d ON d.id = a.domain_id WHERE a.id = ?`,
      )
      .get(id) as { local_part: string; domain: string; client_id: string } | undefined;
    if (!row) throw notFound('Alias no encontrado.');
    requireClientAccess(req, row.client_id);
    const engine = getEngine();
    await engine.deleteAlias(`${row.local_part}@${row.domain}`);
    db.prepare('DELETE FROM aliases WHERE id = ?').run(id);
    audit(req, 'alias.deleted', { id, email: `${row.local_part}@${row.domain}` });
    return { ok: true };
  });
}
