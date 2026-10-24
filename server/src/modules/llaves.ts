import crypto from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { decryptSecret, encryptSecret, hashToken, randomId } from '../core/crypto';
import { db, now } from '../core/db';
import { HttpError, badRequest, conflict, notFound, tooMany, unauthorized } from '../core/errors';
import { getEngine } from '../engine';
import { audit } from './audit';
import { createSession, requireSession, type AuthedUser } from './auth';
import { esDeOtroMotor } from './credenciales';
import { loginParaMotor } from './direcciones';
import { exigirSinMantenimiento } from './mantenimiento';
import { getInstanceSettings } from './settings';
import { motorCorreoWebEnServicio } from './webmailmotor';
import { tokenWebmailValido } from './webmailtoken';
import proveedores from './llaves-proveedores.json';

/**
 * Llaves de acceso (passkeys, WebAuthn): entrar sin contraseña con lo que el
 * usuario ya usa para guardar sus claves (Proton Pass, 1Password, Bitwarden,
 * el llavero de iCloud, el gestor de Google, Windows Hello o una llave física).
 *
 * Dos tipos de propietario, con tablas separadas para que cada una borre sus
 * llaves con su fila (ON DELETE CASCADE): los usuarios del panel
 * (user_passkeys) y los titulares de los buzones en «Mi buzón»
 * (mailbox_passkeys). La contraseña sigue valiendo: la llave es otra forma de
 * entrar, no la sustituye.
 *
 * Una llave queda ligada al nombre desde el que se registra (el RP ID de
 * WebAuthn es el host de la petición): una registrada en panel.cliente.es no
 * sirve en el panel de la instancia ni al revés. Por eso cada llave guarda su
 * host y la interfaz lo enseña. Solo se aceptan los nombres del panel (el de
 * la instancia y los de marca blanca activos): en cualquier otro, el
 * navegador ligaría la llave a un nombre que mañana puede no ser nuestro.
 *
 * Se exige verificación del usuario (PIN, huella o cara): sin ella, quien
 * tuviera el dispositivo un momento entraría sin saber nada.
 *
 * Webmail (Roundcube): entra en IMAP con usuario y contraseña, y una llave
 * no es una contraseña. Tras comprobar la llave en «Mi buzón», el panel crea
 * en el motor una contraseña de aplicación temporal solo para esa sesión del
 * webmail y la entrega UNA vez, a cambio de un código de un solo uso, al
 * complemento mailway_llave de Roundcube (de servidor a servidor, con el
 * secreto compartido). Caduca a las 12 horas, al salir del webmail, al
 * cambiar la contraseña del buzón o al borrar la llave.
 */

export type Propietario = 'panel' | 'buzon';

const TABLA: Record<Propietario, string> = { panel: 'user_passkeys', buzon: 'mailbox_passkeys' };
const COLUMNA: Record<Propietario, string> = { panel: 'user_id', buzon: 'mailbox_id' };

/** Más llaves por persona no aportan nada y cada una es una puerta más. */
export const MAX_LLAVES = 10;
const DESAFIO_MS = 5 * 60_000;
/** Lo que tarda el navegador en volver al webmail con el código. */
const CODIGO_WEBMAIL_MS = 2 * 60_000;
/** Vida máxima de una sesión del webmail abierta con llave. */
export const SESION_WEBMAIL_MS = 12 * 3600_000;
/** Sesiones del webmail con llave abiertas a la vez por buzón; al pasar, se cierra la más antigua. */
const MAX_SESIONES_WEBMAIL = 10;
/** Fallos de comprobación de llaves por IP en la ventana (los dos tipos juntos). */
const MAX_FALLOS_IP = 20;
const VENTANA_FALLOS_MS = 10 * 60_000;
/** Las filas ya retiradas del motor se guardan un mes, para la actividad, y luego se borran. */
const RETENCION_SESIONES_MS = 30 * 24 * 3600_000;

const CODIGO_RE = /^[A-Za-z0-9_-]{43}$/;
/** Estado que el webmail genera antes de mandar al titular a «Mi buzón». */
export const ESTADO_RE = /^[A-Za-z0-9_-]{16,64}$/;

/* --------------------------------- Tipos ---------------------------------- */

export interface Llave {
  id: string;
  nombre: string;
  proveedor: string | null;
  host: string;
  creadaEn: number;
  ultimoUso: number | null;
  sincronizada: boolean;
}

interface FilaLlave {
  id: string;
  owner_id: string;
  credential_id: string;
  rp_id: string;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  aaguid: string | null;
  backed_up: number;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

function seleccionLlaves(tipo: Propietario): string {
  return `SELECT id, ${COLUMNA[tipo]} AS owner_id, credential_id, rp_id, public_key, counter, transports,
                 aaguid, backed_up, name, created_at, last_used_at
          FROM ${TABLA[tipo]}`;
}

/** Nombre del gestor por su AAGUID (lista de passkeydeveloper/passkey-authenticator-aaguids). */
export function proveedorDeAaguid(aaguid: string | null | undefined): string | null {
  if (!aaguid) return null;
  return (proveedores as Record<string, string>)[aaguid.toLowerCase()] ?? null;
}

function aLlave(fila: FilaLlave): Llave {
  return {
    id: fila.id,
    nombre: fila.name,
    proveedor: proveedorDeAaguid(fila.aaguid),
    host: fila.rp_id,
    creadaEn: fila.created_at,
    ultimoUso: fila.last_used_at,
    sincronizada: fila.backed_up === 1,
  };
}

function transportesDe(fila: FilaLlave): string[] | undefined {
  if (!fila.transports) return undefined;
  try {
    const lista = JSON.parse(fila.transports) as unknown;
    return Array.isArray(lista) ? lista.filter((t): t is string => typeof t === 'string') : undefined;
  } catch {
    return undefined;
  }
}

/* -------------------------------- Errores --------------------------------- */

function llaveNoValida(): HttpError {
  return unauthorized('No se ha podido comprobar la llave de acceso. Vuelve a intentarlo.', 'passkey_invalid');
}

function llaveDesconocida(tipo: Propietario, deLaOtra: boolean): HttpError {
  // En el mismo nombre conviven las llaves del panel y las de «Mi buzón»: el
  // gestor las ofrece todas y es fácil elegir la que no es.
  if (deLaOtra) {
    return unauthorized(
      tipo === 'panel'
        ? 'Esa llave es la de «Mi buzón». Para el panel de gestión, elige la llave de tu usuario del panel.'
        : 'Esa llave es la del panel de gestión. Para «Mi buzón», elige la llave de tu buzón.',
      'passkey_unknown',
    );
  }
  return unauthorized(
    'Esta llave de acceso no está registrada aquí. Accede con tu contraseña y añádela desde tu cuenta.',
    'passkey_unknown',
  );
}

function desafioCaducado(): HttpError {
  return badRequest('La comprobación ha caducado o ya se ha usado. Vuelve a intentarlo.', 'passkey_challenge');
}

/* ---------------------------- Nombre y origen ------------------------------ */

function hostDe(url: string): string {
  try {
    return url ? new URL(url).hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

/** Nombres del panel en los que se pueden registrar y usar llaves. */
function hostsDelPanel(): Set<string> {
  const hosts = new Set<string>();
  const instancia = hostDe(getInstanceSettings().panelUrl);
  if (instancia) hosts.add(instancia);
  const filas = db
    .prepare("SELECT hostname FROM client_domains WHERE kind = 'panel' AND status = 'active'")
    .all() as { hostname: string }[];
  for (const f of filas) hosts.add(f.hostname.toLowerCase());
  return hosts;
}

const LOCALES = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface OrigenWebauthn {
  rpId: string;
  origin: string;
}

/**
 * RP ID y origen esperados para esta petición. El navegador firma su origen
 * de verdad (clientDataJSON) y solo ofrece las llaves de ese nombre, así que
 * un Host manipulado solo haría fallar la comprobación; la lista de nombres
 * evita registrar llaves en uno que no es del panel.
 */
export function origenWebauthn(req: FastifyRequest): OrigenWebauthn {
  const rpId = (req.hostname || '').toLowerCase();
  const permitidos = hostsDelPanel();
  const local = LOCALES.has(rpId) && !config.isProduction;
  // Sin URL del panel configurada (instalación a medio hacer), el nombre por
  // el que se entra es el único que hay.
  const sinConfigurar = !getInstanceSettings().panelUrl;
  if (!rpId || (!permitidos.has(rpId) && !local && !sinConfigurar)) {
    const instancia = getInstanceSettings().panelUrl;
    throw badRequest(
      instancia
        ? `Las llaves de acceso solo funcionan al acceder desde la dirección del panel (${instancia}).`
        : 'Las llaves de acceso no están disponibles en esta dirección.',
      'passkey_host',
    );
  }
  // WebAuthn solo existe en contextos seguros: https, o http en localhost.
  if (req.protocol !== 'https' && !local) {
    throw badRequest('Las llaves de acceso necesitan una conexión segura (https).', 'passkey_host');
  }
  // URL quita el puerto por defecto, como hace el navegador con su origen.
  return { rpId, origin: new URL(`${req.protocol}://${req.host}`).origin };
}

/* -------------------------------- Desafíos -------------------------------- */

type Proposito = 'panel-acceso' | 'panel-registro' | 'buzon-acceso' | 'buzon-registro';

function guardarDesafio(proposito: Proposito, sujeto: string | null, origen: OrigenWebauthn, desafio: string): string {
  const t = now();
  db.prepare('DELETE FROM webauthn_challenges WHERE expires_at <= ?').run(t);
  const id = randomId('dsf');
  db.prepare(
    `INSERT INTO webauthn_challenges (id, challenge, purpose, subject, rp_id, origin, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, desafio, proposito, sujeto, origen.rpId, origen.origin, t + DESAFIO_MS);
  return id;
}

/**
 * Lee y borra el desafío (un solo uso, también si la comprobación falla). Debe
 * ser del mismo propósito, del mismo nombre y, para registrar, de la misma
 * persona que lo pidió.
 */
function consumirDesafio(id: string, proposito: Proposito, origen: OrigenWebauthn, sujeto: string | null): string {
  const fila = db
    .prepare('SELECT challenge, purpose, subject, rp_id, origin, expires_at FROM webauthn_challenges WHERE id = ?')
    .get(id) as
    | { challenge: string; purpose: string; subject: string | null; rp_id: string; origin: string; expires_at: number }
    | undefined;
  if (fila) db.prepare('DELETE FROM webauthn_challenges WHERE id = ?').run(id);
  if (
    !fila ||
    fila.expires_at <= now() ||
    fila.purpose !== proposito ||
    fila.rp_id !== origen.rpId ||
    fila.origin !== origen.origin ||
    fila.subject !== sujeto
  ) {
    throw desafioCaducado();
  }
  return fila.challenge;
}

/* ------------------------------ Límite de fallos -------------------------- */

function claveFallos(req: FastifyRequest): string {
  return `llave:${req.ip || ''}`;
}

/** Comparte la tabla de intentos del inicio de sesión, con su propia clave y ventana. */
function comprobarLimiteLlaves(req: FastifyRequest): void {
  const desde = now() - VENTANA_FALLOS_MS;
  db.prepare("DELETE FROM login_attempts WHERE ip LIKE 'llave:%' AND attempted_at < ?").run(desde);
  const fallos = (
    db
      .prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND attempted_at >= ?')
      .get(claveFallos(req), desde) as { c: number }
  ).c;
  if (fallos >= MAX_FALLOS_IP) {
    throw tooMany('Se han producido demasiados intentos de acceso. Espera unos minutos y vuelve a intentarlo.');
  }
}

function registrarFalloLlave(req: FastifyRequest): void {
  db.prepare('INSERT INTO login_attempts (ip, attempted_at) VALUES (?, ?)').run(claveFallos(req), now());
}

/* -------------------------------- Registro -------------------------------- */

export interface Persona {
  id: string;
  /** Lo que el gestor enseña al elegir la llave: la dirección de correo. */
  nombreUsuario: string;
  nombreVisible: string;
}

export const respuestaSchema = z.object({ id: z.string().min(1).max(1024) }).passthrough();

export const registroSchema = z.object({
  desafio: z.string().min(1).max(64),
  respuesta: respuestaSchema,
  nombre: z.string().trim().max(60, 'El nombre no puede superar los 60 caracteres.').optional(),
});

export const accesoSchema = z.object({
  desafio: z.string().min(1).max(64),
  respuesta: respuestaSchema,
});

export const nombreLlaveSchema = z.object({
  nombre: z
    .string()
    .trim()
    .min(1, 'Indica un nombre para la llave de acceso.')
    .max(60, 'El nombre no puede superar los 60 caracteres.'),
});

function llavesDe(tipo: Propietario, ownerId: string): FilaLlave[] {
  return db
    .prepare(`${seleccionLlaves(tipo)} WHERE ${COLUMNA[tipo]} = ? ORDER BY created_at ASC`)
    .all(ownerId) as FilaLlave[];
}

export async function opcionesRegistro(
  tipo: Propietario,
  persona: Persona,
  req: FastifyRequest,
): Promise<{ desafio: string; opciones: unknown }> {
  const origen = origenWebauthn(req);
  const existentes = llavesDe(tipo, persona.id);
  if (existentes.length >= MAX_LLAVES) {
    throw conflict(
      `Ya tienes ${MAX_LLAVES} llaves de acceso. Elimina las que ya no uses antes de añadir otra.`,
      'passkey_limit',
    );
  }
  const opciones = await generateRegistrationOptions({
    rpName: getInstanceSettings().brandName || 'Mailway',
    rpID: origen.rpId,
    userName: persona.nombreUsuario,
    userDisplayName: persona.nombreVisible || persona.nombreUsuario,
    // El id de usuario es opaco para el gestor; con el de la fila, volver a
    // registrar en el mismo gestor sustituye la llave en vez de duplicarla.
    userID: new TextEncoder().encode(persona.id),
    attestationType: 'none',
    // Las del mismo nombre: el gestor avisa en lugar de crear una segunda.
    excludeCredentials: existentes
      .filter((l) => l.rp_id === origen.rpId)
      .map((l) => ({ id: l.credential_id, transports: transportesDe(l) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    timeout: DESAFIO_MS,
  });
  const desafio = guardarDesafio(tipo === 'panel' ? 'panel-registro' : 'buzon-registro', persona.id, origen, opciones.challenge);
  return { desafio, opciones };
}

export async function registrarLlave(
  tipo: Propietario,
  ownerId: string,
  cuerpo: z.infer<typeof registroSchema>,
  req: FastifyRequest,
): Promise<Llave> {
  const origen = origenWebauthn(req);
  const esperado = consumirDesafio(cuerpo.desafio, tipo === 'panel' ? 'panel-registro' : 'buzon-registro', origen, ownerId);
  let verificado: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verificado = await verifyRegistrationResponse({
      response: cuerpo.respuesta as unknown as RegistrationResponseJSON,
      expectedChallenge: esperado,
      expectedOrigin: origen.origin,
      expectedRPID: origen.rpId,
      requireUserVerification: true,
    });
  } catch {
    throw llaveNoValida();
  }
  if (!verificado.verified) throw llaveNoValida();
  const info = verificado.registrationInfo;
  if (llavesDe(tipo, ownerId).length >= MAX_LLAVES) {
    throw conflict(`Ya tienes ${MAX_LLAVES} llaves de acceso.`, 'passkey_limit');
  }
  const ya = db
    .prepare('SELECT 1 FROM user_passkeys WHERE rp_id = ? AND credential_id = ? UNION ALL SELECT 1 FROM mailbox_passkeys WHERE rp_id = ? AND credential_id = ?')
    .get(origen.rpId, info.credential.id, origen.rpId, info.credential.id);
  if (ya) throw conflict('Ya has añadido esta llave de acceso.', 'passkey_exists');
  const proveedor = proveedorDeAaguid(info.aaguid);
  const nombre = cuerpo.nombre || proveedor || 'Llave de acceso';
  const id = randomId('psk');
  db.prepare(
    `INSERT INTO ${TABLA[tipo]} (id, ${COLUMNA[tipo]}, credential_id, rp_id, public_key, counter, transports,
                                 aaguid, backed_up, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ownerId,
    info.credential.id,
    origen.rpId,
    Buffer.from(info.credential.publicKey),
    info.credential.counter,
    info.credential.transports ? JSON.stringify(info.credential.transports) : null,
    info.aaguid,
    info.credentialBackedUp ? 1 : 0,
    nombre,
    now(),
  );
  return aLlave(db.prepare(`${seleccionLlaves(tipo)} WHERE id = ?`).get(id) as FilaLlave);
}

/* --------------------------------- Acceso --------------------------------- */

export async function opcionesAcceso(tipo: Propietario, req: FastifyRequest): Promise<{ desafio: string; opciones: unknown }> {
  const origen = origenWebauthn(req);
  comprobarLimiteLlaves(req);
  // Sin lista de llaves: el gestor ofrece las suyas de este nombre (llaves
  // «descubribles») y no se revela qué cuentas existen.
  const opciones = await generateAuthenticationOptions({
    rpID: origen.rpId,
    userVerification: 'required',
    timeout: DESAFIO_MS,
  });
  const desafio = guardarDesafio(tipo === 'panel' ? 'panel-acceso' : 'buzon-acceso', null, origen, opciones.challenge);
  return { desafio, opciones };
}

/** Comprueba la llave y devuelve su propietario. Cada fallo cuenta para el límite por IP. */
export async function comprobarAcceso(
  tipo: Propietario,
  cuerpo: z.infer<typeof accesoSchema>,
  req: FastifyRequest,
): Promise<{ ownerId: string; llaveId: string }> {
  const origen = origenWebauthn(req);
  comprobarLimiteLlaves(req);
  const esperado = consumirDesafio(cuerpo.desafio, tipo === 'panel' ? 'panel-acceso' : 'buzon-acceso', origen, null);
  const fila = db
    .prepare(`${seleccionLlaves(tipo)} WHERE rp_id = ? AND credential_id = ?`)
    .get(origen.rpId, cuerpo.respuesta.id) as FilaLlave | undefined;
  if (!fila) {
    registrarFalloLlave(req);
    const otra = tipo === 'panel' ? 'buzon' : 'panel';
    const deLaOtra = db
      .prepare(`SELECT 1 FROM ${TABLA[otra]} WHERE rp_id = ? AND credential_id = ?`)
      .get(origen.rpId, cuerpo.respuesta.id);
    throw llaveDesconocida(tipo, Boolean(deLaOtra));
  }
  let verificado: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verificado = await verifyAuthenticationResponse({
      response: cuerpo.respuesta as unknown as AuthenticationResponseJSON,
      expectedChallenge: esperado,
      expectedOrigin: origen.origin,
      expectedRPID: origen.rpId,
      credential: {
        id: fila.credential_id,
        publicKey: new Uint8Array(fila.public_key),
        counter: fila.counter,
        transports: transportesDe(fila) as never,
      },
      requireUserVerification: true,
    });
  } catch {
    registrarFalloLlave(req);
    throw llaveNoValida();
  }
  if (!verificado.verified) {
    registrarFalloLlave(req);
    throw llaveNoValida();
  }
  db.prepare(`UPDATE ${TABLA[tipo]} SET counter = ?, backed_up = ?, last_used_at = ? WHERE id = ?`).run(
    verificado.authenticationInfo.newCounter,
    verificado.authenticationInfo.credentialBackedUp ? 1 : 0,
    now(),
    fila.id,
  );
  return { ownerId: fila.owner_id, llaveId: fila.id };
}

/* -------------------------------- Gestión --------------------------------- */

export function listarLlaves(tipo: Propietario, ownerId: string): Llave[] {
  return llavesDe(tipo, ownerId).map(aLlave);
}

function llaveDe(tipo: Propietario, ownerId: string, id: string): FilaLlave {
  const fila = db
    .prepare(`${seleccionLlaves(tipo)} WHERE id = ? AND ${COLUMNA[tipo]} = ?`)
    .get(id, ownerId) as FilaLlave | undefined;
  if (!fila) throw notFound('Llave de acceso no encontrada.');
  return fila;
}

export function renombrarLlave(tipo: Propietario, ownerId: string, id: string, nombre: string): Llave {
  llaveDe(tipo, ownerId, id);
  db.prepare(`UPDATE ${TABLA[tipo]} SET name = ? WHERE id = ?`).run(nombre, id);
  return aLlave(llaveDe(tipo, ownerId, id));
}

export function borrarLlave(tipo: Propietario, ownerId: string, id: string): Llave {
  const fila = llaveDe(tipo, ownerId, id);
  // Lo que se abrió con ella deja de valer con ella.
  if (tipo === 'buzon') retirarSesionesWebmail(ownerId, { llaveId: id });
  db.prepare(`DELETE FROM ${TABLA[tipo]} WHERE id = ?`).run(id);
  return aLlave(fila);
}

/* ----------------------------- Webmail con llave --------------------------- */

interface BuzonWebmail {
  id: string;
  clientId: string;
  domain: string;
  email: string;
  activo: boolean;
}

function buzonWebmail(mailboxId: string): BuzonWebmail | null {
  const fila = db
    .prepare(
      `SELECT m.id, m.local_part, m.status, d.domain, d.client_id, c.suspended
       FROM mailboxes m JOIN domains d ON d.id = m.domain_id JOIN clients c ON c.id = d.client_id
       WHERE m.id = ?`,
    )
    .get(mailboxId) as
    | { id: string; local_part: string; status: string; domain: string; client_id: string; suspended: number }
    | undefined;
  if (!fila) return null;
  return {
    id: fila.id,
    clientId: fila.client_id,
    domain: fila.domain,
    email: `${fila.local_part}@${fila.domain}`,
    activo: fila.status !== 'suspended' && fila.suspended !== 1,
  };
}

/** Panel de marca blanca activo del cliente, o el de la instancia. */
function portalDelCliente(clientId: string | null): string | null {
  if (clientId) {
    const fila = db
      .prepare(
        `SELECT hostname FROM client_domains
         WHERE client_id = ? AND kind = 'panel' AND status = 'active'
         ORDER BY is_primary DESC, activated_at ASC, created_at ASC LIMIT 1`,
      )
      .get(clientId) as { hostname: string } | undefined;
    if (fila) return `https://${fila.hostname.toLowerCase()}`;
  }
  const instancia = getInstanceSettings().panelUrl.replace(/\/+$/, '');
  return instancia || null;
}

/** Webmail Roundcube propios de un cliente en servicio (con el correo web nuevo no hay ninguno). */
function webmailsRoundcubeDelCliente(clientId: string): string[] {
  if (motorCorreoWebEnServicio(clientId) === 'bulwark') return [];
  return (
    db
      .prepare("SELECT hostname FROM client_domains WHERE client_id = ? AND kind = 'webmail' AND status = 'active'")
      .all(clientId) as { hostname: string }[]
  ).map((f) => f.hostname.toLowerCase());
}

/**
 * «Mi buzón» al que el webmail de este nombre manda a entrar con llave, o
 * null si el nombre no es un webmail Roundcube de esta instancia. El de un
 * cliente lleva a su panel de marca blanca (si lo tiene); el general, al de
 * la instancia.
 */
export function portalParaWebmail(host: string): string | null {
  const nombre = host.trim().toLowerCase();
  if (!nombre) return null;
  const fila = db
    .prepare("SELECT client_id FROM client_domains WHERE hostname = ? AND kind = 'webmail' AND status = 'active'")
    .get(nombre) as { client_id: string } | undefined;
  if (fila) return webmailsRoundcubeDelCliente(fila.client_id).includes(nombre) ? portalDelCliente(fila.client_id) : null;
  if (nombre === hostDe(getInstanceSettings().webmailUrl)) return portalDelCliente(null);
  return null;
}

/** Webmail Roundcube por los que puede entrar el titular: los de su cliente y el general. */
function webmailsDelTitular(buzon: BuzonWebmail): Set<string> {
  const hosts = new Set(webmailsRoundcubeDelCliente(buzon.clientId));
  const general = hostDe(getInstanceSettings().webmailUrl);
  if (general) hosts.add(general);
  return hosts;
}

/**
 * Origen de «Mi buzón» desde el que su webmail ofrece entrar con llave (las
 * llaves registradas en otro nombre no sirven allí), o null si el titular no
 * entra por Roundcube.
 */
export function portalCorreoWebDe(mailboxId: string): string | null {
  const buzon = buzonWebmail(mailboxId);
  if (!buzon) return null;
  if (motorCorreoWebEnServicio(buzon.clientId) === 'bulwark') return null;
  const propios = webmailsRoundcubeDelCliente(buzon.clientId);
  if (propios.length > 0) return portalDelCliente(buzon.clientId);
  return getInstanceSettings().webmailUrl ? portalDelCliente(null) : null;
}

/**
 * Abre una sesión del webmail para el titular que acaba de comprobar su llave:
 * crea la contraseña de aplicación temporal en el motor y devuelve la URL de
 * vuelta al webmail con el código de un solo uso. Null si ese webmail no es
 * suyo (el titular entra igualmente en «Mi buzón»).
 */
export async function abrirSesionWebmail(
  mailboxId: string,
  llaveId: string,
  destino: string,
  estado: string,
): Promise<string | null> {
  const host = destino.trim().toLowerCase();
  const buzon = buzonWebmail(mailboxId);
  if (!buzon || !buzon.activo || !webmailsDelTitular(buzon).has(host)) return null;
  exigirSinMantenimiento();
  // Las más antiguas por encima del máximo se cierran: cada una es una
  // contraseña viva en el motor.
  const abiertas = db
    .prepare(
      `SELECT id FROM webmail_passkey_sessions
       WHERE mailbox_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`,
    )
    .all(mailboxId, now()) as { id: string }[];
  for (const s of abiertas.slice(MAX_SESIONES_WEBMAIL - 1)) {
    db.prepare('UPDATE webmail_passkey_sessions SET revoked_at = ? WHERE id = ?').run(now(), s.id);
  }
  const engine = getEngine();
  const login = loginParaMotor(mailboxId);
  const etiqueta = `mw-webmail-llave-${crypto.randomBytes(4).toString('hex')}`;
  const { secret, ref } = await engine.addAppPassword(login, etiqueta, crypto.randomBytes(24).toString('base64url'));
  const api = await engine.detectApi().catch(() => null);
  const codigo = crypto.randomBytes(32).toString('base64url');
  const t = now();
  const id = randomId('wml');
  try {
    db.prepare(
      `INSERT INTO webmail_passkey_sessions (id, mailbox_id, passkey_id, code_hash, code_expires_at, login,
                                             engine_ref, engine_api, secret_enc, webmail_host, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, mailboxId, llaveId, hashToken(codigo), t + CODIGO_WEBMAIL_MS, login, ref, api, encryptSecret(secret), host, t, t + SESION_WEBMAIL_MS);
  } catch (err) {
    await engine.removeAppPassword(login, ref).catch(() => undefined);
    throw err;
  }
  void retirarSesionesWebmailPendientes().catch(() => undefined);
  // El estado vuelve tal cual: el webmail lo guardó antes de mandar aquí al
  // titular y solo canjea el código si coincide (sin él, un enlace preparado
  // por otro haría entrar a la víctima en el buzón de quien lo preparó).
  return `https://${host}/?_task=login&_action=plugin.mailway_llave&_codigo=${codigo}&_estado=${estado}`;
}

interface FilaSesionWebmail {
  id: string;
  mailbox_id: string;
  login: string;
  engine_ref: string;
  engine_api: string | null;
  secret_enc: string | null;
  code_expires_at: number | null;
  expires_at: number;
  exchanged_at: number | null;
  revoked_at: number | null;
}

function codigoNoValido(): HttpError {
  return new HttpError(404, 'El código para acceder a tu correo no es válido o ha caducado. Vuelve a intentarlo.', 'passkey_code_invalid');
}

/** Entrega (una vez) el usuario y la contraseña temporal a cambio del código. */
export function canjearCodigo(codigo: string): { usuario: string; contrasena: string; sesion: string; expira: number; mailboxId: string } {
  if (!CODIGO_RE.test(codigo)) throw codigoNoValido();
  const fila = db
    .prepare('SELECT * FROM webmail_passkey_sessions WHERE code_hash = ?')
    .get(hashToken(codigo)) as FilaSesionWebmail | undefined;
  if (!fila || fila.exchanged_at || fila.revoked_at || !fila.secret_enc || (fila.code_expires_at ?? 0) <= now()) {
    throw codigoNoValido();
  }
  const buzon = buzonWebmail(fila.mailbox_id);
  if (!buzon?.activo) throw codigoNoValido();
  // El secreto sale una sola vez y se borra: la base no guarda una contraseña
  // del buzón recuperable más tiempo del imprescindible.
  db.prepare('UPDATE webmail_passkey_sessions SET exchanged_at = ?, secret_enc = NULL, code_hash = NULL WHERE id = ?').run(now(), fila.id);
  return {
    usuario: fila.login,
    contrasena: decryptSecret(fila.secret_enc),
    sesion: fila.id,
    expira: fila.expires_at,
    mailboxId: fila.mailbox_id,
  };
}

/**
 * Marca para retirar las sesiones del webmail abiertas con llave de un buzón
 * (todas, o las de una llave) y las retira del motor en segundo plano. Lo
 * llaman el cambio de contraseña, el borrado de una llave y la salida.
 */
export function retirarSesionesWebmail(mailboxId: string, opciones: { llaveId?: string; sesionId?: string } = {}): void {
  const condiciones = ['mailbox_id = ?', 'revoked_at IS NULL'];
  const valores: unknown[] = [mailboxId];
  if (opciones.llaveId) {
    condiciones.push('passkey_id = ?');
    valores.push(opciones.llaveId);
  }
  if (opciones.sesionId) {
    condiciones.push('id = ?');
    valores.push(opciones.sesionId);
  }
  const r = db
    .prepare(`UPDATE webmail_passkey_sessions SET revoked_at = ?, secret_enc = NULL, code_hash = NULL WHERE ${condiciones.join(' AND ')}`)
    .run(now(), ...valores);
  if (r.changes > 0) void retirarSesionesWebmailPendientes().catch(() => undefined);
}

let retirando: Promise<void> | null = null;

/**
 * Quita del motor las contraseñas temporales que ya no deben valer: las
 * cerradas, las caducadas y las de un código que nadie canjeó. Lo llama el
 * vigilante en cada vuelta (reintenta lo que falló con el motor caído) y las
 * acciones que cierran sesiones. Nunca dos a la vez.
 */
export function retirarSesionesWebmailPendientes(): Promise<void> {
  if (retirando) return retirando;
  retirando = (async () => {
    const t = now();
    // Un buzón (o su cliente) suspendido no entra: lo que tuviera abierto con
    // llave se cierra y no vuelve a valer si se reactiva.
    db.prepare(
      `UPDATE webmail_passkey_sessions SET revoked_at = ?, secret_enc = NULL, code_hash = NULL
       WHERE revoked_at IS NULL AND mailbox_id IN (
         SELECT m.id FROM mailboxes m JOIN domains d ON d.id = m.domain_id JOIN clients c ON c.id = d.client_id
         WHERE m.status = 'suspended' OR c.suspended = 1)`,
    ).run(t);
    const filas = db
      .prepare(
        `SELECT * FROM webmail_passkey_sessions
         WHERE engine_removed_at IS NULL
           AND (revoked_at IS NOT NULL OR expires_at <= ? OR (exchanged_at IS NULL AND code_expires_at <= ?))`,
      )
      .all(t, t) as FilaSesionWebmail[];
    if (filas.length > 0) {
      const engine = getEngine();
      const actual = await engine.detectApi();
      for (const fila of filas) {
        // Creada con otra versión del motor: allí ya no existe.
        if (!esDeOtroMotor(fila.engine_api, actual)) {
          let login: string;
          try {
            login = loginParaMotor(fila.mailbox_id);
          } catch {
            // Buzón a medio cambiar de usuario: la siguiente vuelta.
            continue;
          }
          try {
            await engine.removeAppPassword(login, fila.engine_ref);
          } catch (err) {
            // Ya no estaba (buzón recreado, motor reinstalado): retirada igual.
            if (!(err instanceof HttpError && err.code === 'engine_not_found')) continue;
          }
        }
        db.prepare(
          'UPDATE webmail_passkey_sessions SET engine_removed_at = ?, revoked_at = COALESCE(revoked_at, ?), secret_enc = NULL, code_hash = NULL WHERE id = ?',
        ).run(now(), now(), fila.id);
      }
    }
    db.prepare('DELETE FROM webmail_passkey_sessions WHERE engine_removed_at IS NOT NULL AND engine_removed_at < ?').run(
      t - RETENCION_SESIONES_MS,
    );
  })().finally(() => {
    retirando = null;
  });
  return retirando;
}

/* --------------------------------- Rutas ---------------------------------- */

interface FilaUsuario {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'client';
  client_id: string | null;
  disabled: number;
}

function aUsuario(fila: FilaUsuario): AuthedUser {
  return { id: fila.id, email: fila.email, name: fila.name, role: fila.role, clientId: fila.client_id };
}

const codigoSchema = z.object({ codigo: z.string().min(1).max(128) });
const salirSchema = z.object({ sesion: z.string().min(1).max(64) });

function exigirTokenWebmail(req: FastifyRequest): void {
  // Sin secreto compartido las rutas no existen, como las demás del webmail.
  if (!config.webmailToken) throw notFound('Ruta no encontrada.');
  if (!tokenWebmailValido(req.headers['x-mailway-token'])) {
    throw unauthorized('El token del webmail no es válido.', 'webmail_token_invalid');
  }
}

/**
 * Rutas del panel (usuarios del panel) y del webmail (Roundcube). Las de
 * «Mi buzón» están en portal.ts, junto a su sesión.
 */
export function registerLlavesRoutes(app: FastifyInstance): void {
  /* --------------------------- Panel: entrar ----------------------------- */

  app.post('/api/auth/llave/opciones', async (req) => {
    z.object({}).parse(req.body ?? {});
    return opcionesAcceso('panel', req);
  });

  app.post('/api/auth/llave/entrar', async (req, reply) => {
    const cuerpo = accesoSchema.parse(req.body);
    const { ownerId, llaveId } = await comprobarAcceso('panel', cuerpo, req);
    const fila = db.prepare('SELECT * FROM users WHERE id = ?').get(ownerId) as FilaUsuario | undefined;
    if (!fila || fila.disabled) {
      registrarFalloLlave(req);
      throw llaveNoValida();
    }
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), fila.id);
    createSession(req, reply, fila.id);
    req.user = aUsuario(fila);
    req.authVia = { kind: 'session' };
    audit(req, 'auth.login', { email: fila.email, via: 'llave', llave: llaveId });
    return { user: aUsuario(fila) };
  });

  /* -------------------------- Panel: gestionar --------------------------- */

  app.get('/api/auth/llaves', async (req, reply) => {
    // Con un token no: quien lo robara podría añadirse una llave y entrar.
    const user = requireSession(req);
    reply.header('Cache-Control', 'no-store');
    return { llaves: listarLlaves('panel', user.id), hostActual: (req.hostname || '').toLowerCase() };
  });

  app.post('/api/auth/llaves/opciones', async (req) => {
    const user = requireSession(req);
    z.object({}).parse(req.body ?? {});
    return opcionesRegistro('panel', { id: user.id, nombreUsuario: user.email, nombreVisible: user.name }, req);
  });

  app.post('/api/auth/llaves', async (req) => {
    const user = requireSession(req);
    const cuerpo = registroSchema.parse(req.body);
    const llave = await registrarLlave('panel', user.id, cuerpo, req);
    audit(req, 'auth.passkey_added', { llave: llave.id, nombre: llave.nombre, host: llave.host }, user.clientId);
    return { llave };
  });

  app.patch('/api/auth/llaves/:id', async (req) => {
    const user = requireSession(req);
    const { id } = req.params as { id: string };
    const { nombre } = nombreLlaveSchema.parse(req.body);
    return { llave: renombrarLlave('panel', user.id, id, nombre) };
  });

  app.delete('/api/auth/llaves/:id', async (req) => {
    const user = requireSession(req);
    const { id } = req.params as { id: string };
    const llave = borrarLlave('panel', user.id, id);
    audit(req, 'auth.passkey_removed', { llave: llave.id, nombre: llave.nombre, host: llave.host }, user.clientId);
    return { ok: true };
  });

  /* ------------------- Webmail (Roundcube, servidor) --------------------- */

  app.get('/api/webmail/llave/portal', async (req, reply) => {
    exigirTokenWebmail(req);
    const { host } = z.object({ host: z.string().min(1).max(253) }).parse(req.query);
    const portal = portalParaWebmail(host);
    if (!portal) throw notFound('Este webmail no admite llaves de acceso.');
    reply.header('Cache-Control', 'no-store');
    return { portal };
  });

  app.post('/api/webmail/llave', async (req, reply) => {
    exigirTokenWebmail(req);
    const { codigo } = codigoSchema.parse(req.body ?? {});
    const { mailboxId, ...datos } = canjearCodigo(codigo);
    const buzon = buzonWebmail(mailboxId);
    if (buzon) {
      db.prepare(
        `INSERT INTO audit_log (user_id, client_id, action, detail, ip, created_at) VALUES (NULL, ?, ?, ?, ?, ?)`,
      ).run(buzon.clientId, 'webmail.login_passkey', JSON.stringify({ email: buzon.email }), req.ip || '', now());
    }
    reply.header('Cache-Control', 'no-store');
    return datos;
  });

  app.post('/api/webmail/llave/salir', async (req) => {
    exigirTokenWebmail(req);
    const { sesion } = salirSchema.parse(req.body ?? {});
    const fila = db.prepare('SELECT mailbox_id FROM webmail_passkey_sessions WHERE id = ?').get(sesion) as
      | { mailbox_id: string }
      | undefined;
    if (fila) retirarSesionesWebmail(fila.mailbox_id, { sesionId: sesion });
    return { ok: true };
  });
}
