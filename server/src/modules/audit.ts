import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { requireAuth } from './auth';

const insertStmt = db.prepare(
  `INSERT INTO audit_log (user_id, client_id, action, detail, ip, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

/**
 * Anota una acción en el registro de auditoría.
 *
 * `targetClientId` es el cliente afectado. Sin él, la anotación se atribuía
 * siempre al cliente de quien actúa, así que lo que el administrador hacía
 * sobre un cliente (crearle un buzón, revocarle un token) nunca aparecía en
 * la Actividad de ese cliente. Si no se indica, se deduce de `detail.clientId`
 * cuando existe, para que las llamadas antiguas que ya lo anotaban funcionen.
 *
 * Un usuario de cliente siempre anota en su propio cliente: su acceso ya está
 * limitado a él y así nunca puede escribir en el registro de otro.
 *
 * Si la petición llega con un token de gestión, se añade `via: 'token:<nombre>'`
 * al detalle: distingue lo que hizo una persona de lo que hizo una integración.
 * El secreto del token nunca pasa por aquí.
 */
export function audit(
  req: FastifyRequest,
  action: string,
  detail: Record<string, unknown> = {},
  targetClientId?: string | null,
): void {
  const user = req.user;
  const inferred = typeof detail.clientId === 'string' ? detail.clientId : undefined;
  let clientId: string | null;
  if (user?.role === 'client') {
    clientId = user.clientId;
  } else if (targetClientId !== undefined) {
    clientId = targetClientId;
  } else {
    clientId = inferred ?? user?.clientId ?? null;
  }
  const via = req.authVia;
  const payload = via?.kind === 'token' ? { ...detail, via: `token:${via.name}` } : detail;
  insertStmt.run(
    user?.id ?? null,
    clientId,
    action,
    JSON.stringify(payload),
    req.ip || '',
    now(),
  );
}

/**
 * Anota una acción que no llega por una petición (una herramienta de terminal
 * como la de emparejado con Skyway): sin usuario ni IP, así que la Actividad
 * la muestra como hecha por el «Sistema». Igual que `audit`, nunca con
 * secretos en el detalle.
 */
export function auditSystem(
  action: string,
  detail: Record<string, unknown> = {},
  targetClientId: string | null = null,
): void {
  insertStmt.run(null, targetClientId, action, JSON.stringify(detail), '', now());
}

export interface AuditActor {
  name: string;
  /** Solo se muestra el correo de usuarios del propio cliente o a un administrador. */
  email: string | null;
  role: 'admin' | 'client';
}

export interface AuditEntry {
  id: number;
  userId: string | null;
  clientId: string | null;
  action: string;
  detail: Record<string, unknown>;
  ip: string;
  createdAt: number;
  actor: AuditActor | null;
  clientName: string | null;
}

interface AuditRow {
  id: number;
  user_id: string | null;
  client_id: string | null;
  action: string;
  detail: string;
  ip: string;
  created_at: number;
  actor_name: string | null;
  actor_email: string | null;
  actor_role: 'admin' | 'client' | null;
  client_name: string | null;
}

function toEntry(row: AuditRow, viewerIsAdmin: boolean): AuditEntry {
  let detail: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.detail) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      detail = parsed as Record<string, unknown>;
    }
  } catch {
    // se ignora un detalle corrupto
  }
  let actor: AuditActor | null = null;
  if (row.actor_role && row.actor_name !== null) {
    // Un cliente ve que actuó la administración del servicio, pero no la
    // dirección personal de quien administra la instancia.
    const showEmail = viewerIsAdmin || row.actor_role === 'client';
    actor = {
      name: row.actor_name,
      email: showEmail ? row.actor_email : null,
      role: row.actor_role,
    };
  }
  // Lo mismo con la IP: un cliente ve las de sus propios usuarios y las de
  // los titulares de sus buzones (sin usuario de panel), pero no la de la
  // administración ni la de un usuario que ya no existe (podía serlo).
  const showIp = viewerIsAdmin || row.actor_role === 'client' || row.user_id === null;
  return {
    id: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    action: row.action,
    detail,
    ip: showIp ? row.ip : '',
    createdAt: row.created_at,
    actor,
    clientName: row.client_name,
  };
}

export const AUDIT_DEFAULT_LIMIT = 100;
export const AUDIT_MAX_LIMIT = 500;

/**
 * Página del registro, de la anotación más reciente hacia atrás. La
 * paginación va por id (`before`) y no por desplazamiento: mientras se lee,
 * entran anotaciones nuevas y un OFFSET repetiría o saltaría filas.
 */
export function listAudit(opts: {
  clientId?: string;
  limit?: number;
  before?: number;
  viewerIsAdmin?: boolean;
}): AuditEntry[] {
  const limit = Math.max(1, Math.min(opts.limit ?? AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT));
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.clientId) {
    where.push('a.client_id = ?');
    params.push(opts.clientId);
  }
  if (opts.before !== undefined) {
    where.push('a.id < ?');
    params.push(opts.before);
  }
  const sql = `
    SELECT a.*, u.name AS actor_name, u.email AS actor_email, u.role AS actor_role,
           c.name AS client_name
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN clients c ON c.id = a.client_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.id DESC
    LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit) as AuditRow[];
  return rows.map((row) => toEntry(row, opts.viewerIsAdmin ?? false));
}

const auditQuerySchema = z.object({
  clientId: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce
    .number({ invalid_type_error: 'El límite debe ser un número.' })
    .int('El límite debe ser un número entero.')
    .min(1, 'El límite mínimo es 1.')
    .max(AUDIT_MAX_LIMIT, `El límite máximo es ${AUDIT_MAX_LIMIT}.`)
    .optional(),
  before: z.coerce
    .number({ invalid_type_error: 'El parámetro «before» debe ser un número.' })
    .int()
    .positive()
    .optional(),
});

export function registerAuditRoutes(app: FastifyInstance): void {
  app.get('/api/audit', async (req) => {
    const user = requireAuth(req);
    const query = auditQuerySchema.parse(req.query ?? {});
    const isAdmin = user.role === 'admin';
    // Un usuario de cliente solo ve su cliente, diga lo que diga la consulta.
    const clientId = isAdmin ? query.clientId : user.clientId ?? '';
    if (!isAdmin && !clientId) return { entries: [], nextBefore: null };
    const limit = query.limit ?? AUDIT_DEFAULT_LIMIT;
    const entries = listAudit({ clientId, limit, before: query.before, viewerIsAdmin: isAdmin });
    // Si la página viene llena puede haber más; la siguiente empieza antes del último id.
    const nextBefore = entries.length === limit ? entries[entries.length - 1]!.id : null;
    return { entries, nextBefore };
  });
}
