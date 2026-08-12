/**
 * Restablece la contraseña de un usuario del panel desde la terminal.
 * Uso: npm run reset-password -- correo@ejemplo.com nuevaContraseña
 */
import { db } from '../core/db';
import { hashPassword } from '../core/crypto';

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 10) {
  console.error('Uso: npm run reset-password -- <correo> <contraseña de 10+ caracteres>');
  process.exit(1);
}

const result = db
  .prepare('UPDATE users SET password_hash = ? WHERE email = ?')
  .run(hashPassword(password), email.toLowerCase().trim());

if (result.changes === 0) {
  console.error(`No existe ningún usuario con el correo ${email}`);
  process.exit(1);
}
db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)').run(
  email.toLowerCase().trim(),
);
console.log(`Contraseña actualizada para ${email}. Sesiones anteriores cerradas.`);
