import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { hashPassword, hashToken, newSessionToken, randomId, verifyPassword } from '../core/crypto';
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

/**
 * Cómo se ha autenticado la petición. Las rutas que no deben poder usarse
 * desde una máquina (crear tokens, cambiar la contraseña) lo consultan con
 * `requireSession`; la auditoría lo anota para saber qué integración actuó.
 */
export type AuthVia = { kind: 'session' } | { kind: 'token'; tokenId: string; name: string };

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthedUser;
    authVia?: AuthVia;
    /**
     * Motivo concreto por el que unas credenciales presentadas no valen
     * (token revocado, caducado…). Solo se usa para que el 401 de
     * `requireAuth` diga a la integración qué ocurre en lugar de un genérico.
     */
    authError?: { message: string; code: string };
  }
}

const COOKIE = 'mailway_session';
const MAX_ATTEMPTS_PER_IP = 8;
const MAX_ATTEMPTS_PER_EMAIL = 10;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
/**
 * El último uso de un token se anota como mucho una vez por minuto: una
 * integración que hace decenas de llamadas seguidas no debe convertir cada
 * lectura en una escritura en SQLite.
 */
const TOKEN_USAGE_WRITE_INTERVAL_MS = 60_000;

/**
 * Formato de los tokens de gestión: `mwt_<prefijo 8 hex>_<secreto>`, con el
 * secreto de 32 bytes en base64url (43 caracteres). El prefijo viaja en claro
 * para localizar la fila sin recorrer la tabla; el secreto solo existe
 * hasheado en la base de datos.
 */
export const MANAGEMENT_TOKEN_RE = /^mwt_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

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

/** Comparación en tiempo constante; con longitudes distintas no hay nada que comparar. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
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

/* --------------------------- Tokens de gestión ---------------------------- */

interface TokenAuthRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

type TokenResolution =
  | { ok: true; user: AuthedUser; tokenId: string; name: string }
  | { ok: false; message: string; code: string };

const TOKEN_INVALID: Extract<TokenResolution, { ok: false }> = {
  ok: false,
  message: 'El token de gestión no es válido.',
  code: 'invalid_token',
};

/**
 * Resuelve un token de gestión al usuario que lo creó. Se comprueba en cada
 * petición (no se cachea) para que revocar el token, deshabilitar al usuario o
 * cambiarle el rol surta efecto en la siguiente llamada.
 */
export function resolveManagementToken(token: string, ip: string): TokenResolution {
  const match = MANAGEMENT_TOKEN_RE.exec(token);
  if (!match) return TOKEN_INVALID;
  const row = db
    .prepare(
      `SELECT id, user_id, name, token_hash, expires_at, last_used_at, revoked_at
       FROM management_tokens WHERE prefix = ?`,
    )
    .get(match[1]) as TokenAuthRow | undefined;
  if (!row || !safeEqual(row.token_hash, hashToken(token))) return TOKEN_INVALID;
  if (row.revoked_at) {
    return { ok: false, message: 'El token de gestión ha sido revocado.', code: 'token_revoked' };
  }
  const at = now();
  if (row.expires_at !== null && row.expires_at <= at) {
    return {
      ok: false,
      message: 'El token de gestión ha caducado. Cree uno nuevo en Conexiones.',
      code: 'token_expired',
    };
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as
    | UserRow
    | undefined;
  if (!user || user.disabled) {
    return {
      ok: false,
      message: 'El usuario propietario de este token está deshabilitado.',
      code: 'token_user_disabled',
    };
  }
  if (row.last_used_at === null || at - row.last_used_at >= TOKEN_USAGE_WRITE_INTERVAL_MS) {
    db.prepare('UPDATE management_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?').run(
      at,
      ip.slice(0, 64),
      row.id,
    );
  }
  return { ok: true, user: toAuthed(user), tokenId: row.id, name: row.name };
}

/** Credencial de la cabecera `Authorization: Bearer …`, o null si no la hay. */
function bearerCredential(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1]! : null;
}

/**
 * Hook global: identifica al usuario por token de gestión (Bearer mwt_…) o por
 * la cookie de sesión.
 *
 * Con Bearer no se consulta la cookie, aunque venga: una llamada de máquina
 * debe actuar con la identidad de su token, nunca con la de un navegador que
 * casualmente comparta la petición, y un Bearer no válido no debe «caer» a
 * la sesión.
 */
export function sessionHook(req: FastifyRequest, _reply: FastifyReply, done: () => void): void {
  const bearer = bearerCredential(req);
  if (bearer !== null) {
    if (bearer.startsWith('mwt_')) {
      const result = resolveManagementToken(bearer, req.ip || '');
      if (result.ok) {
        req.user = result.user;
        req.authVia = { kind: 'token', tokenId: result.tokenId, name: result.name };
      } else {
        req.authError = { message: result.message, code: result.code };
      }
    } else if (bearer.startsWith('mw_')) {
      // Las claves de envío solo valen en /v1/send, que las valida por su cuenta.
      req.authError = {
        message:
          'Las claves de API (mw_…) solo sirven para enviar correo con /v1/send. Para gestionar Mailway por API, cree un token de gestión (mwt_…) en Conexiones.',
        code: 'api_key_not_allowed',
      };
    } else {
      req.authError = { message: TOKEN_INVALID.message, code: TOKEN_INVALID.code };
    }
    done();
    return;
  }
  const user = resolveSession(req);
  if (user) {
    req.user = user;
    req.authVia = { kind: 'session' };
  }
  done();
}

/** Exige estar autenticado (sesión del panel o token de gestión). */
export function requireAuth(req: FastifyRequest): AuthedUser {
  if (!req.user) {
    throw unauthorized(
      req.authError?.message ?? 'Es necesario iniciar sesión.',
      req.authError?.code ?? 'unauthorized',
    );
  }
  return req.user;
}

/**
 * Exige una sesión iniciada en el panel, no un token de gestión. Se aplica a
 * lo que un token filtrado no debe poder hacer: crear más tokens (se
 * perpetuaría aunque se revocara el original) o cambiar la contraseña.
 */
export function requireSession(req: FastifyRequest): AuthedUser {
  const user = requireAuth(req);
  if (req.authVia?.kind !== 'session') {
    throw forbidden(
      'Esta operación requiere iniciar sesión en el panel; no está disponible con un token de gestión.',
      'session_required',
    );
  }
  return user;
}

/**
 * Administrador con sesión del panel. Para lo que mueve secretos de la
 * instancia hacia fuera (la contraseña del motor, el servidor SMTP que recibe
 * las credenciales de las claves de API): un token de gestión filtrado no
 * debe bastar para redirigirlos a otro servidor.
 */
export function requireAdminSession(req: FastifyRequest): AuthedUser {
  const user = requireSession(req);
  if (user.role !== 'admin') {
    throw forbidden('Esta operación está reservada al administrador de la instancia.');
  }
  return user;
}

/** Exige rol de administrador de la instancia. */
export function requireAdmin(req: FastifyRequest): AuthedUser {
  const user = requireAuth(req);
  if (user.role !== 'admin') {
    throw forbidden('Esta operación está reservada al administrador de la instancia.');
  }
  return user;
}

/**
 * Exige acceso a un cliente concreto: o se es administrador, o un usuario
 * de ese mismo cliente.
 */
export function requireClientAccess(req: FastifyRequest, clientId: string): AuthedUser {
  const user = requireAuth(req);
  if (user.role === 'admin') return user;
  if (user.clientId !== clientId) throw forbidden('No tiene permiso para acceder a este cliente.');
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
  // Solo se purgan las claves de este inicio de sesión: el portal del titular
  // («buzon…») y la puesta en marcha («setup…») cuentan en la misma tabla con
  // ventanas propias, y borrarlas aquí acortaría su bloqueo.
  db.prepare(
    "DELETE FROM login_attempts WHERE attempted_at < ? AND ip NOT LIKE 'buzon%' AND ip NOT LIKE 'setup%'",
  ).run(since);
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
    throw tooMany('Demasiados intentos de inicio de sesión. Espere unos minutos y vuelva a intentarlo.');
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
  const id = randomId('usr');
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

/**
 * Crea el primer administrador de forma atómica.
 *
 * El asistente es público hasta que existe un usuario. Sin la transacción,
 * dos peticiones simultáneas podían superar ambas `countUsers()` y la
 * segunda terminaba como un error 500 de SQLite (o, en el peor caso tras un
 * cambio de esquema, creaba otro administrador). La comprobación y el alta
 * deben ser una sola operación serializada.
 */
export function createInitialAdmin(input: {
  email: string;
  name: string;
  password: string;
}): AuthedUser {
  return db.transaction(() => {
    if (countUsers() > 0) {
      throw forbidden('Ya existe un administrador. Inicie sesión con esa cuenta.', 'admin_exists');
    }
    return createUser({ ...input, role: 'admin' });
  })();
}

/** Conserva la sesión que hizo el cambio de contraseña y revoca las demás. */
export function revokeOtherSessions(userId: string, currentToken?: string): void {
  if (!currentToken) {
    // Es una situación defensiva: una ruta autenticada normalmente siempre
    // tiene cookie. Si no la hay, es más seguro revocarlas todas.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    return;
  }
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(
    userId,
    hashToken(currentToken),
  );
}

/* -------------------------------- Rutas ----------------------------------- */

const loginSchema = z.object({
  email: z.string().email('Introduzca un correo electrónico válido.'),
  password: z.string().min(1, 'Introduzca la contraseña.'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Introduzca la contraseña actual.'),
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
      throw unauthorized('El correo electrónico o la contraseña no son correctos.', 'bad_credentials');
    }
    // Las sesiones caducadas solo se borraban al volver a usarse; el inicio de
    // sesión es un buen momento para retirar las que nadie va a reutilizar.
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), row.id);
    createSession(req, reply, row.id);
    req.user = toAuthed(row);
    req.authVia = { kind: 'session' };
    audit(req, 'auth.login', { email: row.email });
    return { user: toAuthed(row) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[COOKIE];
    // Con un token de gestión la cookie no cuenta (ver sessionHook): cerrar
    // sesión desde una integración no debe tocar la sesión de un navegador.
    if (token && req.authVia?.kind !== 'token') {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
      if (req.authVia?.kind === 'session') audit(req, 'auth.logout');
    }
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.user) return { user: null };
    // `via` permite a una integración comprobar con qué token está hablando.
    const via =
      req.authVia?.kind === 'token'
        ? { kind: 'token' as const, tokenId: req.authVia.tokenId, name: req.authVia.name }
        : { kind: 'session' as const };
    return { user: req.user, via };
  });

  app.post('/api/auth/password', async (req) => {
    // Con un token no: quien lo robara podría dejar fuera al titular.
    const user = requireSession(req);
    const body = changePasswordSchema.parse(req.body);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as UserRow;
    if (!verifyPassword(body.currentPassword, row.password_hash)) {
      throw badRequest('La contraseña actual no es correcta.', 'bad_current_password');
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      hashPassword(body.newPassword),
      user.id,
    );
    // Se cierran las demás sesiones (otro navegador, un equipo olvidado),
    // pero no la actual: quien acaba de demostrar la contraseña sigue dentro.
    // requireSession garantiza que la cookie existe y es válida.
    revokeOtherSessions(user.id, req.cookies?.[COOKIE]);
    audit(req, 'auth.password_changed', {});
    return { ok: true };
  });
}
