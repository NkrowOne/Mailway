/**
 * Restablece la contraseña de un usuario del panel desde la terminal del
 * servidor (dentro del contenedor del panel, con `docker exec`):
 *
 *   node server/dist/tools/reset-password.js <correo>
 *       genera una contraseña aleatoria y la imprime una sola vez;
 *   printf '%s\n' "$CLAVE" | node server/dist/tools/reset-password.js <correo> -
 *       la lee de la entrada estándar.
 *
 * Así la contraseña no queda en el historial del shell ni a la vista en `ps`
 * (los procesos del contenedor se ven desde el host) mientras corre. Escrita
 * como argumento se sigue admitiendo, con un aviso. Cierra las sesiones de
 * ese usuario y lo anota en la Actividad como «Sistema», sin la contraseña.
 */
// Antes que cualquier otro módulo: deja de ser root antes de abrir la base.
import './usuario-del-panel';
import crypto from 'node:crypto';
import { hashPassword } from '../core/crypto';
import { db } from '../core/db';
import { correoConContrasenaDelEntorno } from '../modules/adminenv';
import { auditSystem } from '../modules/audit';

const USO =
  'Uso: node server/dist/tools/reset-password.js <correo> (genera una contraseña) o, para elegirla, ' +
  "printf '%s\\n' \"$CLAVE\" | node server/dist/tools/reset-password.js <correo> -";

/** Los mismos límites que el asistente y el cambio de contraseña del panel. */
const MIN = 10;
const MAX = 200;
/** Tamaño máximo de la entrada estándar: de sobra para una contraseña. */
const MAX_ENTRADA = 4096;

/** Error de uso o de estado: el mensaje se muestra tal cual y nunca repite la contraseña. */
export class ErrorRestablecer extends Error {}

/** 24 caracteres base64url (144 bits): se escribe y se copia sin problemas. */
export function contrasenaAleatoria(): string {
  return crypto.randomBytes(18).toString('base64url');
}

/**
 * Correos de los administradores, para el mensaje de «no existe»: quien está
 * en la terminal del servidor ya tiene acceso a la base, y sin saber con qué
 * correo se dio de alta no podría restablecer nada.
 */
function correosDeAdministracion(): string[] {
  return (db.prepare(`SELECT email FROM users WHERE role = 'admin' ORDER BY created_at`).all() as { email: string }[]).map(
    (u) => u.email,
  );
}

/**
 * Cambia la contraseña, cierra las sesiones del usuario, quita el bloqueo por
 * intentos fallidos del inicio de sesión (quien lo restablece desde el
 * servidor no debe esperar diez minutos para entrar) y lo anota en la
 * actividad.
 */
export function restablecerContrasena(correo: string, password: string, generada: boolean): string {
  const email = correo.trim().toLowerCase();
  if (password.length < MIN) throw new ErrorRestablecer(`La contraseña debe tener al menos ${MIN} caracteres.`);
  if (password.length > MAX) throw new ErrorRestablecer(`La contraseña no puede superar los ${MAX} caracteres.`);
  if (/[\u0000-\u001f\u007f]/.test(password)) {
    throw new ErrorRestablecer('La contraseña no puede contener saltos de línea ni caracteres de control.');
  }
  return db.transaction(() => {
    const usuario = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
    // Su contraseña la fija la variable del panel: cambiarla aquí duraría
    // hasta el próximo arranque.
    if (usuario && correoConContrasenaDelEntorno() === email) {
      throw new ErrorRestablecer(
        `La contraseña de ${email} la fija la variable MAILWAY_ADMIN_PASSWORD del panel: es la que vale para entrar. Para cambiarla, edita esa variable (en Skyway, las variables del servicio del panel) y vuelve a desplegarlo.`,
      );
    }
    if (!usuario) {
      const admins = correosDeAdministracion();
      throw new ErrorRestablecer(
        `No existe ningún usuario con el correo ${email}.` +
          (admins.length > 0 ? ` Correos de administración: ${admins.join(', ')}.` : ''),
      );
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), usuario.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(usuario.id);
    // El bloqueo por IP (8 intentos) salta antes que el del correo (10), y
    // aquí no se sabe desde qué IP entrará: se retiran los del inicio de
    // sesión del panel (claves sin prefijo) y los de este correo. Los del
    // portal del titular («buzon…») y la puesta en marcha («setup…») no.
    db.prepare(
      "DELETE FROM login_attempts WHERE ip = ? OR (ip NOT LIKE 'email:%' AND ip NOT LIKE 'buzon%' AND ip NOT LIKE 'setup%')",
    ).run(`email:${email}`);
    auditSystem('auth.password_reset', { email, generated: generada, origen: 'terminal' });
    return email;
  })();
}

/** La contraseña por la entrada estándar, sin el salto de línea final. */
async function leerEntradaEstandar(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new ErrorRestablecer(
      `Con «-», la contraseña llega por una tubería, no escrita en el terminal. ${USO}`,
    );
  }
  const trozos: Buffer[] = [];
  let total = 0;
  for await (const trozo of process.stdin) {
    const buf = Buffer.isBuffer(trozo) ? trozo : Buffer.from(String(trozo));
    total += buf.length;
    if (total > MAX_ENTRADA) throw new ErrorRestablecer('La entrada estándar es demasiado larga para ser una contraseña.');
    trozos.push(buf);
  }
  return Buffer.concat(trozos).toString('utf8').replace(/\r?\n$/, '');
}

async function main(): Promise<number> {
  const [correo, fuente, ...resto] = process.argv.slice(2);
  if (!correo || correo.startsWith('-') || resto.length > 0) {
    process.stderr.write(`${USO}\n`);
    return 1;
  }
  try {
    let password: string;
    const generada = fuente === undefined;
    if (generada) {
      password = contrasenaAleatoria();
    } else if (fuente === '-') {
      password = await leerEntradaEstandar();
    } else {
      password = fuente;
      process.stderr.write(
        'Aviso: escrita como argumento, la contraseña queda en el historial del shell y a la vista en «ps» mientras se ejecuta. ' +
          'La próxima vez, omítela (se genera una) o pásala por la entrada estándar con «-».\n',
      );
    }
    const email = restablecerContrasena(correo, password, generada);
    process.stdout.write(
      generada
        ? `Contraseña nueva de ${email}: ${password}\nSe muestra solo esta vez. Se han cerrado las sesiones anteriores y quitado el bloqueo por intentos fallidos.\n`
        : `Contraseña actualizada para ${email}. Se han cerrado las sesiones anteriores y quitado el bloqueo por intentos fallidos.\n`,
    );
    return 0;
  } catch (err) {
    const mensaje = err instanceof ErrorRestablecer ? err.message : `No se pudo restablecer la contraseña: ${(err as Error)?.message || String(err)}`;
    process.stderr.write(`${mensaje}\n`);
    return 1;
  }
}

if (require.main === module) {
  void main().then((codigo) => {
    process.exitCode = codigo;
  });
}
