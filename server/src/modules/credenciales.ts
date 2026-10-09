import crypto from 'node:crypto';
import { db, now } from '../core/db';
import { decryptSecret, encryptSecret } from '../core/crypto';
import { HttpError } from '../core/errors';
import { withLock } from '../core/locks';
import { sha512Crypt, verifySha512Crypt } from '../core/sha512crypt';
import { engineConfigured, getEngine } from '../engine';
import type { EngineApi, MailEngine } from '../engine/types';
import { runLimited } from './clients';
import { mantenimientoActivo } from './mantenimiento';

/**
 * Credenciales de los buzones en el panel.
 *
 * Por qué: el panel comprueba las contraseñas de los titulares («Mi buzón»,
 * enlaces de configuración, cambio de contraseña del webmail) SIN pedirle al
 * motor que autentique, porque cada fallo contaría para su bloqueo
 * automático de IPs y unos cuantos errores tecleando dejarían fuera la IP del
 * proxy o del webmail. Hasta Stalwart 0.15 bastaba con leer el hash $6$ que
 * guarda el motor; 0.16 los devuelve enmascarados. Por eso el panel guarda su
 * propia copia:
 *
 * - del hash $6$ de la contraseña principal de cada buzón, cifrado con la
 *   clave maestra (credenciales_buzon). Lo calcula el panel una sola vez al
 *   dar de alta el buzón o cambiar su contraseña, y es el mismo que recibe el
 *   motor; los buzones anteriores se copian de Stalwart 0.15 (captura
 *   perezosa al comprobar una contraseña y captura masiva al arrancar, en el
 *   vigilante y con `tools/motor.ts capturar`);
 * - de un verificador ($6$ del secreto, irreversible) de cada contraseña de
 *   aplicación de dispositivo, para seguir reconociéndolas en «Mi buzón»,
 *   donde no sirven.
 *
 * La suspensión sale de la base del panel (el buzón o su cliente), no del
 * motor: es la fuente de verdad, y tras migrar a 0.16 los buzones suspendidos
 * vuelven activos hasta que la provisión los suspende de nuevo.
 */

/**
 * Hash con el que se compara cuando la dirección no es de ningún buzón: así
 * una dirección inexistente cuesta lo mismo que una contraseña incorrecta.
 */
const HASH_FICTICIO = sha512Crypt(crypto.randomBytes(18).toString('base64url'));

/** El hash $6$ (sha512-crypt) que reciben el motor y la copia del panel. */
export function cifrarContrasena(password: string): string {
  return sha512Crypt(password);
}

/* ------------------------------ Copia local ------------------------------- */

interface FilaCopia {
  password_hash_enc: string;
  updated_at: number;
}

interface CopiaLocal {
  hash: string;
  updatedAt: number;
}

function descifrarCopia(fila: FilaCopia | undefined): CopiaLocal | null {
  if (!fila) return null;
  try {
    const hash = decryptSecret(fila.password_hash_enc);
    return hash.startsWith('$6$') ? { hash, updatedAt: fila.updated_at } : null;
  } catch {
    // Clave maestra cambiada: la copia ya no sirve; se vuelve a capturar o
    // se restablece la contraseña.
    return null;
  }
}

function filaCopia(mailboxId: string): FilaCopia | undefined {
  return db
    .prepare('SELECT password_hash_enc, updated_at FROM credenciales_buzon WHERE mailbox_id = ?')
    .get(mailboxId) as FilaCopia | undefined;
}

function leerCopia(mailboxId: string): CopiaLocal | null {
  return descifrarCopia(filaCopia(mailboxId));
}

/** Hash local de la contraseña principal del buzón, o null si el panel no lo tiene. */
export function leerHashBuzon(mailboxId: string): string | null {
  return leerCopia(mailboxId)?.hash ?? null;
}

/** Guarda (o sustituye) la copia local del hash del buzón. */
export function guardarHashBuzon(mailboxId: string, hash: string, source: 'panel' | 'motor'): void {
  db.prepare(
    `INSERT INTO credenciales_buzon (mailbox_id, password_hash_enc, source, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(mailbox_id) DO UPDATE SET
       password_hash_enc = excluded.password_hash_enc, source = excluded.source, updated_at = excluded.updated_at`,
  ).run(mailboxId, encryptSecret(hash), source, now());
}

/**
 * Guarda el hash copiado del motor solo si la copia local no ha cambiado
 * desde que se leyó: si entretanto el panel cambió la contraseña, su hash es
 * más reciente que el que se acaba de leer del motor y no se pisa.
 */
function guardarCopiaDelMotor(mailboxId: string, hash: string, leidaEn: number | null): boolean {
  try {
    if (leidaEn === null) {
      return (
        db
          .prepare(
            `INSERT INTO credenciales_buzon (mailbox_id, password_hash_enc, source, updated_at)
             VALUES (?, ?, 'motor', ?) ON CONFLICT(mailbox_id) DO NOTHING`,
          )
          .run(mailboxId, encryptSecret(hash), now()).changes > 0
      );
    }
    return (
      db
        .prepare(
          `UPDATE credenciales_buzon SET password_hash_enc = ?, source = 'motor', updated_at = ?
           WHERE mailbox_id = ? AND updated_at = ?`,
        )
        .run(encryptSecret(hash), now(), mailboxId, leidaEn).changes > 0
    );
  } catch {
    // El buzón se ha borrado mientras tanto (clave foránea): nada que guardar.
    return false;
  }
}

/* --------------------------- Alta y cambio -------------------------------- */

/**
 * Alta de un buzón en el motor con la contraseña cifrada una sola vez.
 * Devuelve el hash: quien llama lo guarda con `guardarHashBuzon` junto con
 * la fila del buzón (que aún no existe cuando se habla con el motor).
 */
export async function crearBuzonEnMotor(
  input: { email: string; password: string; displayName?: string; quotaBytes?: number },
  engine: MailEngine = getEngine(),
): Promise<string> {
  const passwordHash = cifrarContrasena(input.password);
  await engine.createMailbox({
    email: input.email,
    passwordHash,
    displayName: input.displayName,
    quotaBytes: input.quotaBytes,
  });
  return passwordHash;
}

/**
 * Cambia la contraseña principal en el motor (conserva las de aplicación) y
 * después la copia local. En ese orden: si el motor falla, la copia sigue
 * diciendo lo mismo que él. En fila por buzón, para que dos cambios
 * simultáneos no dejen la copia con el hash del que perdió en el motor.
 */
export async function cambiarContrasenaBuzon(
  buzon: { id: string; email: string },
  password: string,
  engine: MailEngine = getEngine(),
): Promise<void> {
  await withLock(`credenciales:${buzon.id}`, async () => {
    const passwordHash = cifrarContrasena(password);
    await engine.setMailboxPassword(buzon.email, passwordHash);
    guardarHashBuzon(buzon.id, passwordHash, 'panel');
  });
}

/* ----------------------------- Comprobación ------------------------------- */

/**
 * Resultado de comprobar una contraseña de buzón:
 * - `principal`: es la contraseña principal;
 * - `aplicacion`: es una contraseña de aplicación de dispositivo activa (el
 *   motor la acepta para IMAP y SMTP, pero no sirve para gestionar la cuenta);
 * - `incorrecta`: no es ninguna, o el buzón (o su cliente) está suspendido, o
 *   no existe;
 * - `sin_copia`: el panel no tiene copia del hash y el motor no la puede dar
 *   (Stalwart 0.16): solo se arregla restableciendo la contraseña;
 * - `sin_respuesta`: sin copia y sin poder preguntar al motor ahora mismo.
 */
export type ResultadoComprobacion = 'principal' | 'aplicacion' | 'incorrecta' | 'sin_copia' | 'sin_respuesta';

interface FilaBuzon {
  id: string;
  email: string;
  status: 'active' | 'suspended';
  client_suspended: number;
}

function datosBuzon(mailboxId: string): FilaBuzon | null {
  const fila = db
    .prepare(
      `SELECT m.id, m.local_part || '@' || d.domain AS email, m.status, c.suspended AS client_suspended
       FROM mailboxes m JOIN domains d ON d.id = m.domain_id JOIN clients c ON c.id = d.client_id
       WHERE m.id = ?`,
    )
    .get(mailboxId) as FilaBuzon | undefined;
  return fila ?? null;
}

/** El $6$ que va dentro de una referencia de 0.15 ($app$<etiqueta>$<hash>), si lo es. */
function hashDeReferenciaLegada(ref: string): string | null {
  if (!ref.startsWith('$app$')) return null;
  const fin = ref.indexOf('$', 5);
  const hash = fin >= 0 ? ref.slice(fin + 1) : '';
  return hash.startsWith('$6$') ? hash : null;
}

function coincideConAplicacion(mailboxId: string, password: string, incluirInvalidadas: boolean): boolean {
  const filas = db
    .prepare(
      `SELECT verifier, stored_secret FROM app_passwords
       WHERE mailbox_id = ? AND revoked_at IS NULL ${incluirInvalidadas ? '' : 'AND invalidated_at IS NULL'}`,
    )
    .all(mailboxId) as { verifier: string | null; stored_secret: string }[];
  for (const fila of filas) {
    // Las anteriores a la copia local no tienen verificador: su referencia
    // de Stalwart 0.15 lleva el hash dentro.
    const verificador = fila.verifier ?? hashDeReferenciaLegada(fila.stored_secret);
    if (verificador && verifySha512Crypt(password, verificador)) return true;
  }
  return false;
}

/**
 * ¿Es una contraseña de aplicación del buzón (aunque ya no funcione)? Para
 * rechazarla donde hace falta la principal: quien encuentre el móvil perdido
 * no debe poder adueñarse del buzón con la contraseña guardada.
 */
export function esContrasenaDeAplicacion(mailboxId: string, password: string): boolean {
  return coincideConAplicacion(mailboxId, password, true);
}

/**
 * Comprueba la contraseña de un buzón en el panel, sin pedir al motor que
 * autentique. `mailboxId` null (la dirección no es de ningún buzón) cuesta lo
 * mismo que una contraseña incorrecta.
 *
 * Si el panel no tiene copia del hash, o la que tiene no coincide, y el
 * motor puede dar el suyo (Stalwart 0.15), se lee y se guarda: así se llena
 * la copia de los buzones anteriores sin esperar a la captura masiva, y un
 * cambio hecho fuera del panel (el autoservicio de Stalwart) no deja al
 * titular fuera. Solo se lee: el motor nunca ve la contraseña.
 */
export async function comprobarContrasenaBuzon(
  mailboxId: string | null,
  password: string,
  engine?: MailEngine,
): Promise<ResultadoComprobacion> {
  const buzon = mailboxId ? datosBuzon(mailboxId) : null;
  if (!buzon) {
    verifySha512Crypt(password, HASH_FICTICIO);
    return 'incorrecta';
  }
  // El efectivo es «suspendido si lo está el buzón o su cliente» (clients.ts).
  if (buzon.status === 'suspended' || buzon.client_suspended === 1) return 'incorrecta';

  const fila = filaCopia(buzon.id);
  const copia = descifrarCopia(fila);
  if (copia && verifySha512Crypt(password, copia.hash)) return 'principal';
  if (coincideConAplicacion(buzon.id, password, false)) return 'aplicacion';

  let delMotor: string | null = null;
  try {
    const motor = engine ?? (engineConfigured() ? getEngine() : null);
    const leidas = motor ? await motor.readMailboxCredentials(buzon.email) : null;
    delMotor = leidas?.passwordHash ?? null;
  } catch (err) {
    // El motor dice que no existe: no puede entrar con ninguna contraseña.
    if (err instanceof HttpError && err.code === 'engine_not_found') return 'incorrecta';
    return copia ? 'incorrecta' : 'sin_respuesta';
  }
  if (!delMotor) return copia ? 'incorrecta' : 'sin_copia';
  if (copia && delMotor === copia.hash) return 'incorrecta';
  // Una copia ilegible (otra clave maestra) se sustituye igual que una distinta.
  guardarCopiaDelMotor(buzon.id, delMotor, fila?.updated_at ?? null);
  return verifySha512Crypt(password, delMotor) ? 'principal' : 'incorrecta';
}

/**
 * Versión booleana para quien solo necesita saber si entra: true (principal
 * o de aplicación), false (incorrecta) o null (no se puede comprobar).
 */
export async function verificarContrasenaBuzon(
  mailboxId: string,
  password: string,
  engine?: MailEngine,
): Promise<boolean | null> {
  const resultado = await comprobarContrasenaBuzon(mailboxId, password, engine);
  if (resultado === 'principal' || resultado === 'aplicacion') return true;
  return resultado === 'incorrecta' ? false : null;
}

/* ------------------------------- Captura ---------------------------------- */

export interface ResultadoCaptura {
  /** Buzones del panel. */
  total: number;
  /** Copias nuevas o actualizadas con lo que guarda el motor. */
  capturados: number;
  /** Buzones cuya copia ya coincidía con el motor (o que ya la tenían, si solo se buscaban las que faltan). */
  yaEstaban: number;
  /** Direcciones que no se han podido copiar (no existen en el motor, no tienen un $6$ o no hubo respuesta). */
  fallidos: string[];
}

interface FilaCaptura {
  id: string;
  email: string;
  password_hash_enc: string | null;
  updated_at: number | null;
}

/**
 * Copia en el panel el hash de la contraseña principal de cada buzón tal y
 * como lo guarda el motor. Solo Stalwart 0.15 lo expone: hay que hacerlo
 * antes de migrar a 0.16. Con `soloFaltantes` solo pregunta por los buzones
 * sin copia; si no, también refresca las que difieran del motor (la verdad
 * mientras el motor sea 0.15).
 */
export async function capturarCredenciales(
  opciones: { engine?: MailEngine; soloFaltantes?: boolean } = {},
): Promise<ResultadoCaptura> {
  const engine = opciones.engine ?? getEngine();
  const filas = db
    .prepare(
      `SELECT m.id, m.local_part || '@' || d.domain AS email, c.password_hash_enc, c.updated_at
       FROM mailboxes m JOIN domains d ON d.id = m.domain_id
       LEFT JOIN credenciales_buzon c ON c.mailbox_id = m.id
       ORDER BY d.domain, m.local_part`,
    )
    .all() as FilaCaptura[];
  const resultado: ResultadoCaptura = { total: filas.length, capturados: 0, yaEstaban: 0, fallidos: [] };
  const objetivo: FilaCaptura[] = [];
  for (const fila of filas) {
    const tiene = fila.password_hash_enc !== null && descifrarCopia(fila as FilaCopia) !== null;
    if (opciones.soloFaltantes && tiene) resultado.yaEstaban += 1;
    else objetivo.push(fila);
  }
  // Pocas a la vez: el motor es un servidor compartido y esto no corre prisa.
  await runLimited(objetivo, 4, async (fila) => {
    const copia = fila.password_hash_enc !== null ? descifrarCopia(fila as FilaCopia) : null;
    let hash: string | null;
    try {
      hash = (await engine.readMailboxCredentials(fila.email))?.passwordHash ?? null;
    } catch {
      hash = null;
    }
    if (!hash) {
      resultado.fallidos.push(fila.email);
      return;
    }
    if (copia && copia.hash === hash) {
      resultado.yaEstaban += 1;
      return;
    }
    // Una copia ilegible (otra clave maestra) se sustituye igual que una
    // distinta; si el panel la cambió entretanto, su hash es el bueno.
    if (guardarCopiaDelMotor(fila.id, hash, fila.updated_at)) resultado.capturados += 1;
    else resultado.yaEstaban += 1;
  });
  resultado.fallidos.sort();
  return resultado;
}

/**
 * Captura oportunista (al arrancar y en el vigilante): solo con Stalwart 0.15
 * y fuera del mantenimiento. Así los servidores en producción llenan la copia
 * mucho antes de cualquier migración. Devuelve null si no tocaba.
 */
export async function capturarSiProcede(opciones: { todas?: boolean } = {}): Promise<ResultadoCaptura | null> {
  if (!engineConfigured() || mantenimientoActivo()) return null;
  const engine = getEngine();
  if ((await engine.detectApi()) !== 'rest015') return null;
  return capturarCredenciales({ engine, soloFaltantes: !opciones.todas });
}

/* ------------------- Credenciales y versión del motor --------------------- */

/**
 * API del motor en que se creó una contraseña de aplicación o una credencial
 * SMTP interna. Las anteriores a esta versión no la guardan (NULL): hasta
 * entonces Mailway solo gestionaba Stalwart 0.15.
 */
export function apiDeCredencial(api: string | null): string {
  return api ?? 'rest015';
}

/**
 * ¿La credencial es de otro motor que el actual? Entonces no existe en él:
 * Stalwart 0.16 descarta al migrar todas las contraseñas de aplicación de
 * 0.15, y al volver atrás tampoco están las creadas en 0.16. Retirarla es
 * solo cosa del panel, y su referencia no significa nada para este motor.
 */
export function esDeOtroMotor(api: string | null, actual: EngineApi): boolean {
  return apiDeCredencial(api) !== actual;
}

/* ------------------------------ Recuentos --------------------------------- */

export interface RecuentoCopias {
  total: number;
  conHash: number;
  sinHash: number;
}

/** Buzones con y sin copia local del hash (una copia ilegible cuenta como sin). */
export function recuentoCopias(): RecuentoCopias {
  const total = (db.prepare('SELECT COUNT(*) AS c FROM mailboxes').get() as { c: number }).c;
  const sinHash = buzonesSinCopia().length;
  return { total, conHash: total - sinHash, sinHash };
}

/** Direcciones de los buzones sin copia local utilizable del hash. */
export function buzonesSinCopia(): string[] {
  const filas = db
    .prepare(
      `SELECT m.local_part || '@' || d.domain AS email, c.password_hash_enc, c.updated_at
       FROM mailboxes m JOIN domains d ON d.id = m.domain_id
       LEFT JOIN credenciales_buzon c ON c.mailbox_id = m.id
       ORDER BY d.domain, m.local_part`,
    )
    .all() as { email: string; password_hash_enc: string | null; updated_at: number | null }[];
  return filas
    .filter((f) => f.password_hash_enc === null || descifrarCopia(f as FilaCopia) === null)
    .map((f) => f.email);
}
