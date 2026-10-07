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

/**
 * Administrador definido en el entorno del panel (`MAILWAY_ADMIN_EMAIL` y
 * `MAILWAY_ADMIN_PASSWORD`, nombre opcional en `MAILWAY_ADMIN_NAME`). Sirve
 * para entrar de nuevo cuando se ha olvidado el acceso, sin terminal:
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
  const email = (env.email ?? '').trim().toLowerCase();
  const password = env.password ?? '';
  if (!email && !password) return { action: 'none' };
  if (!email || !password) {
    return {
      action: 'none',
      warning: 'MAILWAY_ADMIN_EMAIL y MAILWAY_ADMIN_PASSWORD deben definirse juntas; no se ha creado ni cambiado ningún administrador.',
    };
  }
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
