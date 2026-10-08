import { db, now } from '../core/db';
import { decryptSecret, encryptSecret, generateMailboxPassword } from '../core/crypto';
import { HttpError, badRequest, conflict } from '../core/errors';
import { withLock } from '../core/locks';
import { getEngine } from '../engine';

/**
 * Remitente de los correos de configuración: la cuenta configuration@<dominio>.
 *
 * Cada dominio tiene una cuenta propia en el motor desde la que el panel envía
 * a los titulares su enlace de configuración. Sale del propio dominio del
 * cliente (y no de una dirección de la instancia) para que el correo pase SPF,
 * DKIM y DMARC con los registros que el cliente ya tiene y para que el titular
 * reconozca de quién viene; el nombre visible es siempre «Configura tu correo».
 *
 * No es un buzón del cliente: no está en `mailboxes`, así que no aparece en
 * ningún listado, no cuenta para el plan y nadie (ni la administración) puede
 * entrar con ella. Su contraseña solo la conoce el panel y nunca se devuelve.
 */

/** Parte local reservada: nadie puede crear un buzón ni un alias con ella. */
export const REMITENTE_CONFIGURACION = 'configuration';

/** Nombre visible de los correos de configuración. */
export const NOMBRE_REMITENTE_CONFIGURACION = 'Configura tu correo';

export const MENSAJE_DIRECCION_RESERVADA =
  'configuration@ está reservada: desde ella se envían las configuraciones de correo.';

/**
 * Cuota de la cuenta: no recibe correo de nadie, pero los rebotes de los
 * envíos (una dirección mal escrita) llegan a ella y no deben poder crecer.
 */
const CUOTA_REMITENTE_BYTES = 25 * 1024 * 1024;

/** La contraseña no la teclea nadie: larga y aleatoria. */
const LONGITUD_CONTRASENA = 32;

export function esDireccionReservada(localPart: string): boolean {
  return localPart.trim().toLowerCase() === REMITENTE_CONFIGURACION;
}

/** Rechaza la parte local reservada (buzones y alias). */
export function assertDireccionNoReservada(localPart: string): void {
  if (esDireccionReservada(localPart)) throw badRequest(MENSAJE_DIRECCION_RESERVADA, 'reserved_address');
}

export function direccionRemitente(domain: string): string {
  return `${REMITENTE_CONFIGURACION}@${domain}`;
}

function claveCerrojo(domainId: string): string {
  return `remitente-config:${domainId}`;
}

/** ¿Hay un buzón o un alias del panel con la dirección reservada (de antes de reservarla)? */
function direccionOcupada(domainId: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM mailboxes WHERE domain_id = ? AND local_part = ?
         UNION ALL
         SELECT 1 FROM aliases WHERE domain_id = ? AND local_part = ?`,
      )
      .get(domainId, REMITENTE_CONFIGURACION, domainId, REMITENTE_CONFIGURACION),
  );
}

/**
 * Deja lista la cuenta remitente del dominio y devuelve sus credenciales.
 * La primera vez la crea en el motor; después solo descifra la contraseña.
 * En fila por dominio: dos envíos simultáneos no crean la cuenta dos veces
 * con contraseñas distintas.
 */
export async function asegurarRemitenteConfiguracion(domain: {
  id: string;
  domain: string;
}): Promise<{ email: string; password: string }> {
  const email = direccionRemitente(domain.domain);
  return withLock(claveCerrojo(domain.id), async () => {
    // Un buzón o alias configuration@ creado antes de reservar la dirección
    // es de alguien: enviar desde él (o cambiarle la contraseña) sería
    // suplantarlo. Se comprueba siempre, también si la cuenta ya existe.
    if (direccionOcupada(domain.id)) {
      throw conflict(
        `${email} ya está en uso como buzón o alias, así que no se puede enviar la configuración desde ella. Copia el enlace y envíalo tú.`,
        'configuration_sender_taken',
      );
    }

    const row = db
      .prepare('SELECT password_enc FROM remitentes_configuracion WHERE domain_id = ?')
      .get(domain.id) as { password_enc: string } | undefined;
    if (row) {
      try {
        return { email, password: decryptSecret(row.password_enc) };
      } catch {
        // Clave maestra cambiada: la contraseña guardada ya no se puede
        // leer. Se le pone una nueva en el motor y se sigue.
        const password = generateMailboxPassword(LONGITUD_CONTRASENA);
        await getEngine().setMailboxPassword(email, password);
        db.prepare('UPDATE remitentes_configuracion SET password_enc = ? WHERE domain_id = ?').run(
          encryptSecret(password),
          domain.id,
        );
        return { email, password };
      }
    }

    const engine = getEngine();
    const password = generateMailboxPassword(LONGITUD_CONTRASENA);
    try {
      await engine.createMailbox({
        email,
        password,
        displayName: NOMBRE_REMITENTE_CONFIGURACION,
        quotaBytes: CUOTA_REMITENTE_BYTES,
      });
    } catch (err) {
      // Ya estaba en el motor (un borrado de dominio a medias, una base
      // restaurada): es la cuenta reservada, se adopta con contraseña nueva.
      if (!(err instanceof HttpError) || err.code !== 'engine_exists') throw err;
      await engine.setMailboxPassword(email, password);
    }
    try {
      db.prepare(
        'INSERT INTO remitentes_configuracion (domain_id, password_enc, created_at) VALUES (?, ?, ?)',
      ).run(domain.id, encryptSecret(password), now());
    } catch (err) {
      // El dominio se ha borrado mientras tanto (clave foránea): no se deja
      // en el motor una cuenta que ya nadie va a usar ni borrar.
      await engine.deleteMailbox(email).catch(() => undefined);
      throw err;
    }
    return { email, password };
  });
}

/**
 * Borra la cuenta remitente al eliminar el dominio, antes de borrar el
 * dominio del motor. Solo si la creó el panel (hay fila): un buzón
 * configuration@ anterior a la reserva lo borra el flujo normal de buzones.
 * Devuelve false si el motor no la ha podido borrar (se queda huérfana, y se
 * adoptará si el dominio vuelve a darse de alta).
 */
export async function borrarRemitenteConfiguracion(domain: { id: string; domain: string }): Promise<boolean> {
  return withLock(claveCerrojo(domain.id), async () => {
    const row = db.prepare('SELECT 1 FROM remitentes_configuracion WHERE domain_id = ?').get(domain.id);
    if (!row) return true;
    try {
      await getEngine().deleteMailbox(direccionRemitente(domain.domain));
    } catch (err) {
      // «No existe» es el resultado buscado. Con cualquier otro fallo la fila
      // se conserva: si después el dominio no llega a borrarse, la cuenta
      // sigue sirviendo con la misma contraseña.
      if (!(err instanceof HttpError) || err.code !== 'engine_not_found') return false;
    }
    // Ya no está en el motor: sin la fila, si el borrado del dominio fallara
    // más adelante, el siguiente envío la crearía de nuevo en lugar de
    // intentar entrar con una cuenta que no existe.
    db.prepare('DELETE FROM remitentes_configuracion WHERE domain_id = ?').run(domain.id);
    return true;
  });
}
