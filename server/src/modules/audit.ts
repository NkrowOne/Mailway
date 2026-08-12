import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db, now } from '../core/db';
import type { AuthedUser } from './auth';

const insertStmt = db.prepare(
  `INSERT INTO audit_log (user_id, client_id, action, detail, ip, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

export function audit(
  req: FastifyRequest,
  action: string,
  detail: Record<string, unknown> = {},
): void {
  const user = (req as FastifyRequest & { user?: AuthedUser }).user;
  insertStmt.run(
    user?.id ?? null,
    user?.clientId ?? null,
    action,
    JSON.stringify(detail),
    req.ip || '',
    now(),
  );
}

export interface AuditEntry {
  id: number;
  userId: string | null;
  clientId: string | null;
  action: string;
  detail: Record<string, unknown>;
  ip: string;
  createdAt: number;
}

interface AuditRow {
  id: number;
  user_id: string | null;
  client_id: string | null;
  action: string;
  detail: string;
  ip: string;
  created_at: number;
}

function toEntry(row: AuditRow): AuditEntry {
  let detail: Record<string, unknown> = {};
  try {
    detail = JSON.parse(row.detail);
  } catch {
    // se ignora un detalle corrupto
  }
  return {
    id: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    action: row.action,
    detail,
    ip: row.ip,
    createdAt: row.created_at,
  };
}

export function listAudit(opts: { clientId?: string; limit?: number }): AuditEntry[] {
  const limit = Math.min(opts.limit ?? 100, 500);
  const rows = opts.clientId
    ? (db
        .prepare('SELECT * FROM audit_log WHERE client_id = ? ORDER BY id DESC LIMIT ?')
        .all(opts.clientId, limit) as AuditRow[])
    : (db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as AuditRow[]);
  return rows.map(toEntry);
}

export function registerAuditRoutes(app: FastifyInstance): void {
  app.get('/api/audit', async (req) => {
    const user = (req as FastifyRequest & { user?: AuthedUser }).user!;
    if (user.role === 'admin') {
      const { clientId } = req.query as { clientId?: string };
      return { entries: listAudit({ clientId, limit: 200 }) };
    }
    return { entries: listAudit({ clientId: user.clientId!, limit: 200 }) };
  });
}
