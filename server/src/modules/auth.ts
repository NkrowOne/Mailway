import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { hashPassword, hashToken, newSessionToken, verifyPassword } from '../core/crypto';
import { db, now } from '../core/db';
import { badRequest, forbidden, tooMany, unauthorized } from '../core/errors';
import { audit } from './audit';

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'client';
  clientId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthedUser;
  }
}

const COOKIE = 'mailway_session';
const MAX_ATTEMPTS_PER_IP = 8;
const MAX_ATTEMPTS_PER_EMAIL = 10;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: 'admin' | 'client';
  client_id: string | null;
  disabled: number;
}

function toAuthed(row: UserRow): AuthedUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    clientId: row.client_id,
  };
}

/* ------------------------------ Sesiones --------------------------------- */

export function createSession(req: FastifyRequest, reply: FastifyReply, userId: string): void {
  const { token, hash } = newSessionToken();
  const createdAt = now();
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    hash,
    userId,
    createdAt,
    createdAt + config.sessionTtlHours * 3600_000,
    req.ip || '',
    String(req.headers['user-agent'] || '').slice(0, 300),
  );
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: config.sessionTtlHours * 3600,
  });
}

export function resolveSession(req: FastifyRequest): AuthedUser | null {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  const session = db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
    .get(hashToken(token)) as { user_id: string; expires_at: number } | undefined;
  if (!session) return null;
  if (session.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id) as
    | UserRow
    | undefined;
  if (!row || row.disabled) return null;
  return toAuthed(row);
}

/** Hook global: añade req.user si hay sesión válida. */
export function sessionHook(req: FastifyRequest, _reply: FastifyReply, done: () => void): void {
  const user = resolveSession(req);
  if (user) req.user = user;
  done();
}

/** Exige sesión iniciada. */
export function requireAuth(req: FastifyRequest): AuthedUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** Exige rol de administrador de la instancia. */
export function requireAdmin(req: FastifyRequest): AuthedUser {
  const user = requireAuth(req);
  if (user.role !== 'admin') throw forbidden('Solo el administrador puede hacer esto.');
  return user;
}

/**
 * Exige acceso a un cliente concreto: o eres administrador, o eres un usuario
 * de ese mismo cliente.
 */
export function requireClientAccess(req: FastifyRequest, clientId: string): AuthedUser {
  const user = requireAuth(req);
  if (user.role === 'admin') return user;
  if (user.clientId !== clientId) throw forbidden();
  return user;
}

/* --------------------------- Límite de intentos --------------------------- */

/**
 * Limita los intentos de login por IP y, sobre todo, por correo objetivo.
 * El límite por correo es imprescindible: con un proxy inverso delante
 * (trustProxy), la IP proviene de X-Forwarded-For y un atacante puede rotarla
 * en cada petición; el contador por correo no depende de la IP, así que la
 * fuerza bruta contra una cuenta concreta sigue topando.
 */
function checkLoginRate(ip: string, email: string): void {
  const since = now() - ATTEMPT_WINDOW_MS;
  db.prepare('DELETE FROM login_attempts WHERE attempted_at < ?').run(since);
  const emailKey = `email:${email}`;
  const ipCount = (
    db
      .prepare('SELECT COUNT(*) AS count FROM login_attempts WHERE ip = ? AND attempted_at >= ?')
      .get(ip, since) as { count: number }
  ).count;
  const emailCount = (
    db
      .prepare('SELECT COUNT(*) AS count FROM login_attempts WHERE ip = ? AND attempted_at >= ?')
      .get(emailKey, since) as { count: number }
  ).count;
  if (ipCount >= MAX_ATTEMPTS_PER_IP || emailCount >= MAX_ATTEMPTS_PER_EMAIL) {
    throw tooMany('Demasiados intentos de inicio de sesión. Espera unos minutos.');
  }
}

function recordLoginAttempt(ip: string, email: string): void {
  const stmt = db.prepare('INSERT INTO login_attempts (ip, attempted_at) VALUES (?, ?)');
  stmt.run(ip, now());
  stmt.run(`email:${email}`, now());
}

/* ------------------------------- Usuarios --------------------------------- */

export function countUsers(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
}

export function createUser(input: {
  email: string;
  name: string;
  password: string;
  role: 'admin' | 'client';
  clientId?: string | null;
}): AuthedUser {
  const id = `usr_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, role, client_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.email.toLowerCase().trim(),
    input.name.trim(),
    hashPassword(input.password),
    input.role,
    input.clientId ?? null,
    now(),
  );
  return {
    id,
    email: input.email.toLowerCase().trim(),
    name: input.name.trim(),
    role: input.role,
    clientId: input.clientId ?? null,
  };
}

/* -------------------------------- Rutas ----------------------------------- */

const loginSchema = z.object({
  email: z.string().email('Introduce un correo válido.'),
  password: z.string().min(1, 'Introduce la contraseña.'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10, 'La nueva contraseña debe tener al menos 10 caracteres.'),
});

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post('/api/auth/login', async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const email = body.email.toLowerCase().trim();
    checkLoginRate(req.ip || '', email);
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
    const valid = row && !row.disabled && verifyPassword(body.password, row.password_hash);
    if (!valid) {
      recordLoginAttempt(req.ip || '', email);
      throw unauthorized('Correo o contraseña incorrectos.', 'bad_credentials');
    }
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), row.id);
    createSession(req, reply, row.id);
    req.user = toAuthed(row);
    audit(req, 'auth.login', { email: row.email });
    return { user: toAuthed(row) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.user) return { user: null };
    return { user: req.user };
  });

  app.post('/api/auth/password', async (req) => {
    const user = requireAuth(req);
    const body = changePasswordSchema.parse(req.body);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as UserRow;
    if (!verifyPassword(body.currentPassword, row.password_hash)) {
      throw badRequest('La contraseña actual no es correcta.');
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      hashPassword(body.newPassword),
      user.id,
    );
    // Cierra el resto de sesiones del usuario por seguridad.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    audit(req, 'auth.password_changed', {});
    return { ok: true };
  });
}
