import { hashPassword, verifyPassword } from '../core/crypto';
import { db } from '../core/db';
import { auditSystem } from './audit';
import { countUsers, createUser } from './auth';
import { ensureDefaultPlans } from './clients';

/** Los mismos límites que el asistente y el cambio de contraseña del panel. */
const MIN = 10;
const MAX = 200;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AdminEnv {
  email?: string;
  password?: string;
  name?: string;
}

export type AdminEnvResult =
  | { action: 'none'; warning?: string }
  | { action: 'created' | 'password_updated' | 'unchanged'; email: string };

/** Correos de los administradores, del más antiguo al más nuevo. */
function correosDeAdministracion(): string[] {
  return (db.prepare(`SELECT email FROM users WHERE role = 'admin' ORDER BY created_at`).all() as { email: string }[]).map(
    (u) => u.email,
  );
}

/**
 * Correo de la cuenta cuya contraseña fija el entorno: MAILWAY_ADMIN_EMAIL o,
 * si solo está MAILWAY_ADMIN_PASSWORD, el único administrador que haya. Así
 * basta con poner la contraseña en las variables del panel. Con varios
 * administradores (o ninguno) hace falta el correo para saber cuál.
 */
function correoDelEntorno(env: AdminEnv): { email: string } | { warning: string } | null {
  const email = (env.email ?? '').trim().toLowerCase();
  const password = env.password ?? '';
  if (!email && !password) return null;
  if (!password) {
    return {
      warning: 'MAILWAY_ADMIN_EMAIL necesita MAILWAY_ADMIN_PASSWORD; no se ha creado ni cambiado ningún administrador.',
    };
  }
  if (email) return { email };
  const admins = correosDeAdministracion();
  if (admins.length === 1) return { email: admins[0]! };
  return {
    warning:
      admins.length === 0
        ? 'MAILWAY_ADMIN_PASSWORD sin MAILWAY_ADMIN_EMAIL: aún no hay ningún administrador; indica su correo para crearlo.'
        : 'MAILWAY_ADMIN_PASSWORD sin MAILWAY_ADMIN_EMAIL: hay varios administradores; indica de cuál es con MAILWAY_ADMIN_EMAIL.',
  };
}

/**
 * Administrador definido en el entorno del panel (`MAILWAY_ADMIN_PASSWORD` y,
 * si hay más de un administrador, `MAILWAY_ADMIN_EMAIL`; nombre opcional en
 * `MAILWAY_ADMIN_NAME`). Mientras la variable exista, es la contraseña de esa
 * cuenta: se aplica en cada arranque y el panel no deja cambiarla (ver
 * correoConContrasenaDelEntorno). Sirve también para recuperar el acceso sin
 * terminal:
 *
 * - Sin ese correo en la base: lo crea como administrador (el primero, con los
 *   planes iniciales, o uno más).
 * - Con ese correo y otra contraseña: la fija y cierra sus sesiones.
 * - Con la misma contraseña: no hace nada, para no cerrar sesiones en cada
 *   arranque.
 *
 * Nunca toca a un usuario que no sea administrador y nunca escribe la
 * contraseña en la Actividad ni en el registro. Un valor no válido se descarta
 * con un aviso en lugar de impedir el arranque.
 */
export function applyAdminFromEnv(env: AdminEnv): AdminEnvResult {
  const password = env.password ?? '';
  const destino = correoDelEntorno(env);
  if (!destino) return { action: 'none' };
  if ('warning' in destino) return { action: 'none', warning: destino.warning };
  const email = destino.email;
  if (email.length > 254 || !EMAIL.test(email)) {
    return { action: 'none', warning: 'El valor de MAILWAY_ADMIN_EMAIL no es un correo válido; no se ha cambiado nada.' };
  }
  if (password.length < MIN || password.length > MAX || /[\u0000-\u001f\u007f]/.test(password)) {
    return {
      action: 'none',
      warning: `El valor de MAILWAY_ADMIN_PASSWORD no es válido (entre ${MIN} y ${MAX} caracteres, sin saltos de línea); no se ha cambiado nada.`,
    };
  }
  const name = (env.name ?? '').trim().slice(0, 80) || 'Administración';

  return db.transaction((): AdminEnvResult => {
    const user = db.prepare('SELECT id, role, password_hash FROM users WHERE email = ?').get(email) as
      | { id: string; role: string; password_hash: string }
      | undefined;
    if (!user) {
      const first = countUsers() === 0;
      createUser({ email, name, password, role: 'admin' });
      if (first) ensureDefaultPlans();
      auditSystem('auth.admin_from_env', { email, first, origen: 'entorno' });
      return { action: 'created', email };
    }
    if (user.role !== 'admin') {
      return {
        action: 'none',
        warning: 'MAILWAY_ADMIN_EMAIL es el correo de un usuario que no es administrador; no se ha cambiado nada.',
      };
    }
    if (verifyPassword(password, user.password_hash)) return { action: 'unchanged', email };
    db.prepare('UPDATE users SET password_hash = ?, disabled = 0 WHERE id = ?').run(hashPassword(password), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    auditSystem('auth.password_reset', { email, generated: false, origen: 'entorno' });
    return { action: 'password_updated', email };
  })();
}

/** El entorno del proceso, leído en cada llamada (las pruebas lo cambian). */
function entornoDelProceso(): AdminEnv {
  return { email: process.env.MAILWAY_ADMIN_EMAIL, password: process.env.MAILWAY_ADMIN_PASSWORD };
}

/**
 * Correo del administrador cuya contraseña fija el entorno, o null. Solo si
 * la contraseña es válida (si no, el arranque la descartó y la cuenta se
 * gestiona como cualquier otra) y la cuenta existe y es de administración.
 *
 * Con él, el panel y la herramienta de terminal no cambian esa contraseña:
 * el siguiente arranque la devolvería a la de la variable y, mientras tanto,
 * la variable diría una cosa y el acceso otra.
 */
export function correoConContrasenaDelEntorno(env: AdminEnv = entornoDelProceso()): string | null {
  const password = env.password ?? '';
  if (password.length < MIN || password.length > MAX || /[\u0000-\u001f\u007f]/.test(password)) return null;
  const destino = correoDelEntorno(env);
  if (!destino || 'warning' in destino) return null;
  const user = db.prepare('SELECT role FROM users WHERE email = ?').get(destino.email) as { role: string } | undefined;
  return user?.role === 'admin' ? destino.email : null;
}

/** Mensaje común: la contraseña de esa cuenta se cambia en las variables, no aquí. */
export const MENSAJE_CONTRASENA_DEL_ENTORNO =
  'La contraseña de esta cuenta la fija la variable MAILWAY_ADMIN_PASSWORD del panel. Para cambiarla, edita esa variable y vuelve a desplegar el panel.';
