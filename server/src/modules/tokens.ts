import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { hashToken, randomId } from '../core/crypto';
import { conflict, notFound } from '../core/errors';
import { audit } from './audit';
import { requireAuth, requireSession } from './auth';

/**
 * Tokens de gestión: acceso por API (Skyway, scripts, CI, agentes) con los
 * mismos permisos que el usuario que los crea. Viajan como
 * `Authorization: Bearer mwt_<prefijo>_<secreto>`; la verificación en cada
 * petición vive en `auth.ts` (sessionHook), aquí solo su ciclo de vida.
 */

/**
 * Tope de tokens activos por usuario. Un uso normal son unos pocos (Skyway,
 * un script, la CI); el tope evita que un error en una automatización llene
 * la tabla de credenciales vivas que luego nadie sabe revocar.
 */
const MAX_ACTIVE_TOKENS_PER_USER = 25;

export type TokenStatus = 'active' | 'expired' | 'revoked';

export interface ManagementTokenInfo {
  id: string;
  name: string;
  /** Prefijo visible (`mwt_<prefix>_…`) para reconocer el token sin revelarlo. */
  prefix: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastUsedIp: string;
  revokedAt: number | null;
  status: TokenStatus;
  userId: string;
  ownerEmail: string;
  ownerName: string;
  ownerRole: 'admin' | 'client';
  ownerClientId: string | null;
  ownerClientName: string | null;
  /** El token con el que se ha hecho esta misma petición. */
  current: boolean;
}

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  last_used_ip: string;
  revoked_at: number | null;
  owner_email: string;
  owner_name: string;
  owner_role: 'admin' | 'client';
  owner_client_id: string | null;
  owner_client_name: string | null;
}

const SELECT_TOKENS = `
  SELECT t.id, t.user_id, t.name, t.prefix, t.created_at, t.expires_at, t.last_used_at,
         t.last_used_ip, t.revoked_at,
         u.email AS owner_email, u.name AS owner_name, u.role AS owner_role,
         u.client_id AS owner_client_id, c.name AS owner_client_name
  FROM management_tokens t
  JOIN users u ON u.id = t.user_id
  LEFT JOIN clients c ON c.id = u.client_id`;

function statusOf(row: { revoked_at: number | null; expires_at: number | null }, at: number): TokenStatus {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at !== null && row.expires_at <= at) return 'expired';
  return 'active';
}

function toInfo(row: TokenRow, currentTokenId: string | null): ManagementTokenInfo {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    lastUsedIp: row.last_used_ip,
    revokedAt: row.revoked_at,
    status: statusOf(row, now()),
    userId: row.user_id,
    ownerEmail: row.owner_email,
    ownerName: row.owner_name,
    ownerRole: row.owner_role,
    ownerClientId: row.owner_client_id,
    ownerClientName: row.owner_client_name,
    current: row.id === currentTokenId,
  };
}

/** Activos primero (los que importan), luego caducados y revocados; recientes antes. */
function sortTokens(list: ManagementTokenInfo[]): ManagementTokenInfo[] {
  const weight: Record<TokenStatus, number> = { active: 0, expired: 1, revoked: 2 };
  return [...list].sort((a, b) => weight[a.status] - weight[b.status] || b.createdAt - a.createdAt);
}

function getTokenRow(id: string): TokenRow | undefined {
  return db.prepare(`${SELECT_TOKENS} WHERE t.id = ?`).get(id) as TokenRow | undefined;
}

/**
 * Genera un token nuevo. El prefijo es único en la tabla: con 4 bytes una
 * colisión es improbable pero posible, así que se reintenta en lugar de
 * dejar que la restricción UNIQUE devuelva un 500.
 */
function newManagementToken(): { token: string; prefix: string; hash: string } {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const prefix = crypto.randomBytes(4).toString('hex');
    const taken = db.prepare('SELECT 1 FROM management_tokens WHERE prefix = ?').get(prefix);
    if (taken) continue;
    const secret = crypto.randomBytes(32).toString('base64url');
    const token = `mwt_${prefix}_${secret}`;
    return { token, prefix, hash: hashToken(token) };
  }
  throw new Error('No se ha podido generar un prefijo de token libre.');
}

const DAY_MS = 24 * 3600_000;

/**
 * Crea un token de gestión para un usuario, respetando el tope de tokens
 * activos. Devuelve el token completo (solo existe en esta llamada; en la base
 * queda el hash) y su ficha. Quien llama anota la auditoría: la ruta, con la
 * petición; la herramienta de emparejado, como acción del sistema.
 */
export function createManagementToken(input: {
  userId: string;
  name: string;
  expiresAt: number | null;
}): { token: string; info: ManagementTokenInfo } {
  const at = now();
  const active = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM management_tokens
         WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(input.userId, at) as { c: number }
  ).c;
  if (active >= MAX_ACTIVE_TOKENS_PER_USER) {
    throw conflict(
      `Has alcanzado el máximo de ${MAX_ACTIVE_TOKENS_PER_USER} tokens activos. Revoca los que ya no utilices antes de crear otro.`,
      'token_limit',
    );
  }
  const { token, prefix, hash } = newManagementToken();
  const id = randomId('mwt');
  db.prepare(
    `INSERT INTO management_tokens (id, user_id, name, prefix, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.userId, input.name, prefix, hash, at, input.expiresAt);
  return { token, info: toInfo(getTokenRow(id)!, null) };
}

/** Revoca un token (sin comprobar permisos: lo hace quien llama). */
export function revokeManagementToken(id: string): void {
  db.prepare('UPDATE management_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), id);
}

/**
 * Tokens activos (ni revocados ni caducados) con ese nombre exacto cuyo
 * dueño es un administrador. Los de usuarios de cliente nunca entran: un
 * cliente puede llamar «Skyway» a un token suyo y no es asunto de la
 * administración revocarlo.
 */
export function activeAdminTokensNamed(name: string): ManagementTokenInfo[] {
  const rows = db
    .prepare(
      `${SELECT_TOKENS}
       WHERE t.name = ? AND u.role = 'admin' AND t.revoked_at IS NULL
         AND (t.expires_at IS NULL OR t.expires_at > ?)`,
    )
    .all(name, now()) as TokenRow[];
  return rows.map((row) => toInfo(row, null));
}

const createSchema = z.object({
  name: z
    .string({ required_error: 'Indica un nombre para el token.' })
    .trim()
    .min(1, 'Indica un nombre para el token.')
    .max(60, 'El nombre no puede superar los 60 caracteres.'),
  /** Días de validez; null u omitido = sin caducidad. */
  expiresInDays: z
    .number({ invalid_type_error: 'La caducidad debe indicarse en días.' })
    .int('La caducidad debe ser un número entero de días.')
    .min(1, 'La caducidad mínima es de 1 día.')
    .max(3650, 'La caducidad máxima es de 3650 días (10 años).')
    .nullable()
    .optional(),
});

const listQuerySchema = z.object({
  all: z.enum(['0', '1', 'true', 'false']).optional(),
});

export function registerTokenRoutes(app: FastifyInstance): void {
  app.get('/api/tokens', async (req) => {
    const user = requireAuth(req);
    const query = listQuerySchema.parse(req.query ?? {});
    const all = user.role === 'admin' && (query.all === '1' || query.all === 'true');
    const rows = all
      ? (db.prepare(SELECT_TOKENS).all() as TokenRow[])
      : (db.prepare(`${SELECT_TOKENS} WHERE t.user_id = ?`).all(user.id) as TokenRow[]);
    const currentTokenId = req.authVia?.kind === 'token' ? req.authVia.tokenId : null;
    return { tokens: sortTokens(rows.map((row) => toInfo(row, currentTokenId))) };
  });

  app.post('/api/tokens', async (req) => {
    // Solo con sesión del panel: si un token pudiera crear tokens, uno
    // filtrado podría perpetuarse aunque se revocara el original.
    const user = requireSession(req);
    const body = createSchema.parse(req.body ?? {});
    const expiresAt = body.expiresInDays ? now() + body.expiresInDays * DAY_MS : null;
    const { token, info } = createManagementToken({ userId: user.id, name: body.name, expiresAt });
    audit(req, 'token.created', { id: info.id, name: info.name, prefix: info.prefix, expiresAt });
    // El token completo solo viaja en esta respuesta; en la base queda el hash.
    return { token, info };
  });

  app.delete('/api/tokens/:id', async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    const row = getTokenRow(id);
    // A quien no es su dueño ni administrador se le responde igual que si no
    // existiera: no debe poder averiguar ids de tokens ajenos.
    if (!row || (row.user_id !== user.id && user.role !== 'admin')) {
      throw notFound('Token de gestión no encontrado.', 'token_not_found');
    }
    const currentTokenId = req.authVia?.kind === 'token' ? req.authVia.tokenId : null;
    if (row.revoked_at) return { ok: true, token: toInfo(row, currentTokenId) };
    revokeManagementToken(id);
    const detail: Record<string, unknown> = { id, name: row.name, prefix: row.prefix };
    if (row.user_id !== user.id) detail.owner = row.owner_email;
    // Se anota en el cliente del dueño: si el administrador revoca el token de
    // un cliente, el cliente lo ve en su Actividad.
    audit(req, 'token.revoked', detail, row.owner_client_id);
    return { ok: true, token: toInfo(getTokenRow(id)!, currentTokenId) };
  });
}
