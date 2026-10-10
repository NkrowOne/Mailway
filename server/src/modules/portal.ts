import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { db, now } from '../core/db';
import {
  decryptSecret,
  encryptSecret,
  generateMailboxPassword,
  hashToken,
  newSessionToken,
  randomId,
} from '../core/crypto';
import { HttpError, badRequest, conflict, notFound, tooMany, unauthorized } from '../core/errors';
import { buzonLockKey, withLock } from '../core/locks';
import { getEngine } from '../engine';
import { audit } from './audit';
import {
  actualizarUsuario,
  appsSkywayDe,
  datosWebmail,
  loginDe,
  loginParaMotor,
  resolverBuzon,
} from './direcciones';
import { requireAdmin, requireAdminSession, requireAuth, requireClientAccess } from './auth';
import { getClient, runLimited } from './clients';
import { cambiarContrasenaBuzon, comprobarContrasenaBuzon, type ResultadoComprobacion } from './credenciales';
import { exigirSinMantenimiento } from './mantenimiento';
import {
  contrasenasInvalidadas,
  createAppPassword,
  listAppPasswords,
  revokeAppPassword,
  variablesContrasenaAplicacion,
} from './apppasswords';
import {
  MOBILECONFIG_CONTENT_TYPE,
  getConnectionSettings,
  mobileconfigFilename,
  mobileconfigPlist,
  publicBaseUrl,
  thunderbirdAndroidQrPayload,
  webmailPropio,
  type ConnectionSettings,
} from './connection';
import {
  borrarFoto,
  cambiarNombreVisible,
  enviarFoto,
  fechaFoto,
  fotoSchema,
  guardarFoto,
  leerFoto,
  nombreSchema,
} from './perfil';
import { motorCorreoWebEnServicio } from './webmailmotor';

/**
 * Portal del titular del buzón y enlaces de configuración de dispositivos.
 *
 * El titular (un empleado del cliente, sin cuenta en el panel) configura su
 * móvil u ordenador de dos formas:
 * - con un ENLACE DE CONFIGURACIÓN que le envía quien administra el correo
 *   (sin iniciar sesión; opcionalmente con la contraseña recién generada);
 * - entrando en «Mi buzón» con su dirección y la contraseña del buzón, donde
 *   además cambia su contraseña y gestiona contraseñas de aplicación.
 *
 * Las contraseñas del buzón se comprueban SIEMPRE en el panel, contra su
 * copia del hash (modules/credenciales.ts): si se le pidiera al motor que
 * autenticase, cada fallo contaría para su baneo automático de IPs y un par
 * de errores tecleando bloquearían la IP del proxy para todos los clientes.
 *
 * Cambio de dominio: la dirección del buzón (titular.email) y el usuario con
 * el que entran sus dispositivos (titular.login) pueden no coincidir hasta
 * que el titular pulsa «Actualizar mis dispositivos». Se entra con cualquiera
 * de los dos (y con la dirección del dominio pareja), los datos de conexión
 * enseñan el usuario y toda llamada al motor usa loginParaMotor().
 */

const COOKIE_BUZON = 'mailway_buzon';
/** La cookie del titular solo viaja a las rutas del portal: nada más la necesita. */
const RUTA_COOKIE = '/api/portal';
const SESION_HORAS = 12;

/** Prefijo de las contraseñas de aplicación que crea Skyway (ver appsSkywayDe). */
const PREFIJO_SKYWAY = 'skyway:';

const VENTANA_INTENTOS_MS = 15 * 60_000;
const MAX_FALLOS_POR_BUZON = 5;
const MAX_FALLOS_POR_IP = 20;
/**
 * Contraseñas que no coinciden al crear un enlace con contraseña. Sin tope,
 * la ruta (400 «no coincide» frente a 200) serviría para probar contraseñas
 * del buzón sin límite desde el panel o con un token.
 */
const MAX_FALLOS_ENLACE = 5;

const MIN_CONTRASENA = 10;

/** Los enlaces caducados se conservan un mes (para el historial) y luego se borran. */
const RETENCION_ENLACES_MS = 30 * 24 * 3600_000;

/* ------------------------------- Errores ---------------------------------- */

function enlaceNoValido(): HttpError {
  return new HttpError(
    404,
    'Este enlace de configuración no es válido o ha caducado. Solicita uno nuevo a la persona que administra tu correo.',
    'setup_link_invalid',
  );
}

function buzonSuspendido(): HttpError {
  return new HttpError(
    403,
    'Este buzón está suspendido. Ponte en contacto con la persona que administra tu correo.',
    'mailbox_suspended',
  );
}

function sinComprobacion(): HttpError {
  return new HttpError(
    503,
    'No se ha podido comprobar la contraseña en este momento. Vuelve a intentarlo en unos minutos.',
    'engine_unreachable',
  );
}

/**
 * El panel no tiene copia del hash de este buzón y el motor ya no la da
 * (Stalwart 0.16): reintentar no sirve, hay que restablecer la contraseña.
 */
function sinCopia(): HttpError {
  return new HttpError(
    409,
    'No se puede comprobar la contraseña de este buzón. Pide a la persona que administra tu correo que la restablezca.',
    'password_unverifiable',
  );
}

function credencialesIncorrectas(): HttpError {
  // Mismo mensaje exista o no el buzón: no se revela qué direcciones hay.
  return unauthorized('La dirección de correo o la contraseña no son correctas.', 'bad_credentials');
}

function contrasenaDeAplicacion(): HttpError {
  return badRequest(
    'Has introducido una contraseña de aplicación. Aquí es necesaria la contraseña principal del buzón.',
    'app_password_not_allowed',
  );
}

/**
 * 409 mailbox_used_by_app para el titular. El mensaje general (el del panel)
 * ofrece revocar las contraseñas de aplicación «skyway:…»; el titular podría
 * hacerlo desde «Mi buzón» y la aplicación dejaría de enviar, así que a él se
 * le pide que lo actualice quien gestiona la web. Mismo código que el general.
 */
function errorUsadoPorAppTitular(apps: string[]): HttpError {
  const nombres = [...new Set(apps.map((a) => a.slice(PREFIJO_SKYWAY.length)).filter(Boolean))];
  const cuales = nombres.length > 0 ? ` (${nombres.join(', ')})` : '';
  return conflict(
    `Este buzón lo usa una aplicación para enviar${cuales}. Pide a quien gestiona la web que lo actualice desde Skyway.`,
    'mailbox_used_by_app',
  );
}

/**
 * Nombre de contraseña de aplicación reservado. Skyway marca las suyas con
 * «skyway:» y de ese prefijo dependen el 409 mailbox_used_by_app y la baja del
 * dominio anterior: una creada por el titular con ese nombre bloquearía su
 * propia actualización y la baja de todo el dominio.
 */
function nombreReservado(): HttpError {
  return badRequest(
    'Los nombres que empiezan por «skyway:» están reservados para las aplicaciones de Skyway. Elige otro nombre.',
    'app_password_name_reserved',
  );
}

/* ------------------------------- Titular ---------------------------------- */

interface FilaBuzon {
  id: string;
  local_part: string;
  display_name: string;
  quota_mb: number;
  status: 'active' | 'suspended';
  used_bytes: number | null;
  usage_checked_at: number | null;
  usuario_motor: string | null;
  semilla_perfil: string | null;
  usuario_cambiando_a: string | null;
  domain_id: string;
  domain: string;
  client_id: string;
  client_suspended: number;
}

/** Buzón visto desde el portal: con su cliente, para saber si puede entrar. */
export interface Titular {
  id: string;
  email: string;
  displayName: string;
  domainId: string;
  domain: string;
  clientId: string;
  quotaMb: number;
  /** El buzón está activo y su cliente no está suspendido. */
  activo: boolean;
  suspendido: boolean;
  usedBytes: number | null;
  usageCheckedAt: number | null;
  /** Usuario del motor: con el que entran los dispositivos (usuario_motor ?? dirección). */
  login: string;
  /** Pendiente de actualizar dispositivos tras un cambio de dominio. */
  loginPending: boolean;
  /** Hay un cambio de usuario a medias (usuario_cambiando_a): lo resuelve el conciliador. */
  actualizando: boolean;
  /**
   * Dirección con la que nació el perfil de Apple (semilla_perfil). Sus UUID
   * salen de ella: así el perfil nuevo sustituye al instalado antes del
   * cambio de dominio en vez de añadir una segunda cuenta.
   */
  semilla: string | null;
  /** Contraseñas de aplicación activas de Skyway («skyway:…»): solo Skyway cambia su usuario. */
  appsSkyway: string[];
}

const SELECT_BUZON = `
  SELECT m.id, m.local_part, m.display_name, m.quota_mb, m.status, m.used_bytes,
         m.usage_checked_at, m.usuario_motor, m.semilla_perfil, m.usuario_cambiando_a,
         d.id AS domain_id, d.domain, d.client_id,
         c.suspended AS client_suspended
  FROM mailboxes m
  JOIN domains d ON d.id = m.domain_id
  JOIN clients c ON c.id = d.client_id`;

function aTitular(row: FilaBuzon): Titular {
  const suspendido = row.status === 'suspended' || row.client_suspended === 1;
  return {
    id: row.id,
    email: `${row.local_part}@${row.domain}`,
    displayName: row.display_name,
    domainId: row.domain_id,
    domain: row.domain,
    clientId: row.client_id,
    quotaMb: row.quota_mb,
    activo: !suspendido,
    suspendido,
    usedBytes: row.used_bytes,
    usageCheckedAt: row.usage_checked_at,
    login: loginDe(row),
    loginPending: row.usuario_motor !== null,
    actualizando: row.usuario_cambiando_a !== null,
    semilla: row.semilla_perfil,
    appsSkyway: appsSkywayDe(row.id),
  };
}

function buzonPorId(id: string): Titular | null {
  const row = db.prepare(`${SELECT_BUZON} WHERE m.id = ?`).get(id) as FilaBuzon | undefined;
  return row ? aTitular(row) : null;
}

/**
 * Buzón por lo que teclea el titular: su dirección, su usuario del motor (la
 * dirección anterior, mientras no actualiza sus dispositivos) o, durante un
 * cambio de dominio con la pre-recepción hecha, la dirección del dominio pareja.
 */
function buzonPorDireccion(email: string): Titular | null {
  const resuelto = resolverBuzon(email);
  return resuelto ? buzonPorId(resuelto.mailboxId) : null;
}

/** Buzón de una ruta del panel, con el control de acceso de su cliente. */
export function buzonDelPanel(req: FastifyRequest, mailboxId: string): Titular {
  // Primero la sesión: a un anónimo no se le confirma qué ids existen.
  requireAuth(req);
  const titular = buzonPorId(mailboxId);
  if (!titular) throw notFound('Buzón no encontrado.');
  requireClientAccess(req, titular.clientId);
  return titular;
}

/**
 * ¿Entra el titular al correo web por el nuevo (Bulwark)? Su cliente lo usa y
 * su webmail es uno propio en servicio (la dirección general sigue en Roundcube).
 */
function usaCorreoWebNuevo(titular: Titular): boolean {
  return motorCorreoWebEnServicio(titular.clientId) === 'bulwark' && webmailPropio(titular.clientId, titular.domain) !== null;
}

/** Datos de conexión en la forma de GET /api/mailboxes/:id/connection. */
function datosConexion(titular: Titular): {
  settings: ConnectionSettings;
  connection: {
    email: string;
    username: string;
    imap: ConnectionSettings['imap'];
    smtp: ConnectionSettings['smtp'];
    smtpAlt: ConnectionSettings['smtpAlt'];
    webmailUrl: string;
  };
} {
  const settings = getConnectionSettings(titular.domain, titular.clientId);
  return {
    settings,
    connection: {
      email: titular.email,
      // El usuario es una dirección completa (lo que más confunde): la del
      // buzón o, tras un cambio de dominio, la anterior hasta que el titular
      // actualiza sus dispositivos.
      username: titular.login,
      imap: settings.imap,
      smtp: settings.smtp,
      smtpAlt: settings.smtpAlt,
      webmailUrl: settings.webmailUrl,
    },
  };
}

/**
 * Registro de actividad de acciones del titular. No usa audit(): allí el
 * actor sale de la sesión del panel, y el titular no tiene; además, si en el
 * mismo navegador hubiera una sesión de administración abierta, la acción se
 * le atribuiría a quien no la hizo. Se anota con el cliente del buzón para
 * que el cliente la vea en su actividad.
 */
function auditTitular(
  req: FastifyRequest,
  clientId: string,
  action: string,
  detail: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO audit_log (user_id, client_id, action, detail, ip, created_at)
     VALUES (NULL, ?, ?, ?, ?, ?)`,
  ).run(clientId, action, JSON.stringify(detail), req.ip || '', now());
}

/* ------------------------- Buzón configurado ------------------------------ */

/**
 * El titular ha demostrado que tiene acceso al buzón: terminó el enlace de
 * configuración, descargó el perfil de Apple o entró en «Mi buzón» o en el
 * webmail. Se guarda el primer momento; la puesta en marcha del cliente lo
 * usa para saber qué buzones siguen sin configurar.
 */
export function marcarBuzonConfigurado(mailboxId: string): void {
  db.prepare('UPDATE mailboxes SET configured_at = COALESCE(configured_at, ?) WHERE id = ?').run(
    now(),
    mailboxId,
  );
}

/**
 * El panel ha dejado los dispositivos del titular sin acceso (contraseña
 * nueva, reinicio): el buzón vuelve a estar «sin configurar». No se llama
 * cuando es el propio titular quien cambia su contraseña, porque él sigue
 * teniendo acceso.
 */
export function olvidarBuzonConfigurado(mailboxId: string): void {
  db.prepare('UPDATE mailboxes SET configured_at = NULL WHERE id = ?').run(mailboxId);
}

/* ------------------------- Límite de intentos ------------------------------ */

/*
 * Los fallos se guardan en login_attempts (sobreviven a un reinicio, así que
 * no basta con tumbar el proceso para reiniciar la cuenta) con claves propias.
 * El contador por buzón es el que de verdad protege: tras un proxy la IP
 * viene de X-Forwarded-For y se puede falsear.
 *
 * La clave del buzón es su id cuando lo que se teclea lo identifica: durante
 * un cambio de dominio se entra con la dirección vieja, la nueva o el usuario,
 * y alternarlas no debe multiplicar los intentos. Lo que no identifica ningún
 * buzón cuenta por el texto tecleado.
 */
function contarFallos(clave: string): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND attempted_at >= ?')
      .get(clave, now() - VENTANA_INTENTOS_MS) as { c: number }
  ).c;
}

/** Retira los fallos del portal ya fuera de su ventana (claves «buzon…»). */
function purgarFallos(): void {
  db.prepare("DELETE FROM login_attempts WHERE attempted_at < ? AND ip LIKE 'buzon%'").run(
    now() - VENTANA_INTENTOS_MS,
  );
}

/** Clave del contador por buzón: su id si se conoce; si no, lo tecleado. */
function claveDeFallos(tecleado: string, titular: Titular | null): string {
  return titular ? titular.id : tecleado;
}

function comprobarLimite(clave: string, ip: string | null): void {
  purgarFallos();
  const porBuzon = contarFallos(`buzon:${clave}`);
  const porIp = ip === null ? 0 : contarFallos(`buzon-ip:${ip}`);
  if (porBuzon >= MAX_FALLOS_POR_BUZON || porIp >= MAX_FALLOS_POR_IP) {
    throw tooMany(
      'Se han producido demasiados intentos fallidos. Espera 15 minutos antes de volver a intentarlo.',
    );
  }
}

function registrarFallo(clave: string, ip: string | null): void {
  const stmt = db.prepare('INSERT INTO login_attempts (ip, attempted_at) VALUES (?, ?)');
  stmt.run(`buzon:${clave}`, now());
  if (ip !== null) stmt.run(`buzon-ip:${ip}`, now());
}

/**
 * Límite en memoria para las rutas públicas de los enlaces: el token tiene
 * 256 bits, así que no protege de adivinarlo, sino de que alguien use la
 * ruta para cargar el servidor.
 */
function crearLimitador(max: number, ventanaMs: number): (clave: string) => boolean {
  const cuentas = new Map<string, { desde: number; n: number }>();
  return (clave) => {
    const t = now();
    if (cuentas.size > 5000) {
      for (const [k, v] of cuentas) if (t - v.desde >= ventanaMs) cuentas.delete(k);
    }
    const actual = cuentas.get(clave);
    if (!actual || t - actual.desde >= ventanaMs) {
      cuentas.set(clave, { desde: t, n: 1 });
      return true;
    }
    actual.n += 1;
    return actual.n <= max;
  };
}

/* ----------------------- Comprobación de contraseñas ----------------------- */

/**
 * Comprueba la contraseña PRINCIPAL del titular, con límite de fallos.
 * Devuelve normalmente o lanza el error adecuado para la interfaz.
 */
async function comprobarContrasenaPrincipal(
  titular: Titular,
  password: string,
  ip: string | null,
  errorSiIncorrecta: () => HttpError,
): Promise<void> {
  comprobarLimite(titular.id, ip);
  const resultado = await comprobarContrasenaBuzon(titular.id, password);
  if (resultado === 'sin_respuesta') throw sinComprobacion();
  if (resultado === 'sin_copia') throw sinCopia();
  if (resultado === 'incorrecta') {
    registrarFallo(titular.id, ip);
    throw errorSiIncorrecta();
  }
  // El motor también la acepta, pero gestionar la cuenta exige la principal.
  if (resultado === 'aplicacion') throw contrasenaDeAplicacion();
}

/* --------------------------- Enlaces: utilidades --------------------------- */

export interface FilaEnlace {
  id: string;
  token_hash: string;
  mailbox_id: string;
  password_enc: string | null;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  last_opened_at: number | null;
  revoked_at: number | null;
  token_enc: string | null;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * Limpieza oportunista: la contraseña de un enlace caducado o revocado no
 * debe seguir en la base ni un minuto más de lo necesario, aunque nadie
 * vuelva a abrirlo. Se hace en cada uso en vez de con un temporizador.
 */
export function purgarEnlaces(): void {
  const t = now();
  // Lo mismo con el token cifrado: un enlace muerto no se vuelve a enviar.
  db.prepare(
    `UPDATE setup_links SET password_enc = NULL, token_enc = NULL
     WHERE (password_enc IS NOT NULL OR token_enc IS NOT NULL) AND (expires_at <= ? OR revoked_at IS NOT NULL)`,
  ).run(t);
  db.prepare('DELETE FROM setup_links WHERE expires_at < ?').run(t - RETENCION_ENLACES_MS);
}

/**
 * Tras un cambio de contraseña del buzón, la que guardan sus enlaces ya no
 * vale: se borra para que nadie configure un dispositivo con una contraseña
 * antigua (y para no conservar un secreto inútil). También se cierran las
 * sesiones de «Mi buzón», salvo la que hizo el cambio.
 *
 * Exportada para que el restablecimiento desde el panel haga lo mismo.
 */
export function alCambiarContrasenaBuzon(mailboxId: string, sesionQueSeConserva?: string): void {
  db.prepare('UPDATE setup_links SET password_enc = NULL WHERE mailbox_id = ?').run(mailboxId);
  if (sesionQueSeConserva) {
    db.prepare('DELETE FROM mailbox_sessions WHERE mailbox_id = ? AND token_hash <> ?').run(
      mailboxId,
      sesionQueSeConserva,
    );
  } else {
    db.prepare('DELETE FROM mailbox_sessions WHERE mailbox_id = ?').run(mailboxId);
  }
}

function enlacePorToken(token: string): { enlace: FilaEnlace; titular: Titular } {
  purgarEnlaces();
  if (!TOKEN_RE.test(token)) throw enlaceNoValido();
  const enlace = db
    .prepare('SELECT * FROM setup_links WHERE token_hash = ?')
    .get(hashToken(token)) as FilaEnlace | undefined;
  if (!enlace || enlace.revoked_at || enlace.expires_at <= now()) throw enlaceNoValido();
  const titular = buzonPorId(enlace.mailbox_id);
  if (!titular) throw enlaceNoValido();
  if (!titular.activo) throw buzonSuspendido();
  return { enlace, titular };
}

function contrasenaDelEnlace(enlace: FilaEnlace): string | undefined {
  if (!enlace.password_enc) return undefined;
  try {
    return decryptSecret(enlace.password_enc);
  } catch {
    // Clave maestra cambiada: el enlace sigue sirviendo, sin contraseña.
    return undefined;
  }
}

function enviarPerfil(reply: FastifyReply, email: string, plist: string): string {
  reply
    .header('Content-Type', MOBILECONFIG_CONTENT_TYPE)
    .header('Content-Disposition', `attachment; filename="${mobileconfigFilename(email)}"`)
    .header('Cache-Control', 'no-store');
  return plist;
}

export interface EnlaceNuevo {
  id: string;
  url: string;
  expiresAt: number;
  hasPassword: boolean;
}

/**
 * Guarda un enlace de configuración nuevo y devuelve su URL. El token en
 * claro solo existe en la respuesta que lo crea; en la base, su hash.
 */
export function insertarEnlace(
  req: FastifyRequest,
  titular: Titular,
  passwordEnc: string | null,
  ttlHours: number,
): EnlaceNuevo {
  purgarEnlaces();
  const token = crypto.randomBytes(32).toString('base64url');
  const linkId = randomId('stl');
  const createdAt = now();
  const expiresAt = createdAt + ttlHours * 3600_000;
  // Se busca por el hash; el token cifrado solo sirve para que la
  // administración pueda volver a enviar el enlace (GET …/url).
  db.prepare(
    `INSERT INTO setup_links (id, token_hash, mailbox_id, password_enc, created_by, created_at, expires_at, token_enc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    linkId,
    hashToken(token),
    titular.id,
    passwordEnc,
    req.user?.id ?? null,
    createdAt,
    expiresAt,
    encryptSecret(token),
  );
  return {
    id: linkId,
    url: `${publicBaseUrl(req)}/conectar/${token}`,
    expiresAt,
    hasPassword: passwordEnc !== null,
  };
}

/**
 * Enlace con la contraseña recién generada de un buzón, para las altas
 * masivas con enlace (la contraseña acaba de crearse: no hace falta
 * comprobarla con el motor como en POST …/setup-links).
 */
export function enlaceConContrasena(
  req: FastifyRequest,
  mailboxId: string,
  password: string,
  ttlHours: number,
): EnlaceNuevo {
  const titular = buzonPorId(mailboxId);
  if (!titular) throw notFound('Buzón no encontrado.');
  return insertarEnlace(req, titular, encryptSecret(password), ttlHours);
}

function exigirBuzonActivo(titular: Titular): void {
  if (titular.suspendido) {
    throw badRequest(
      'El buzón o su cliente están suspendidos. Reactívalos antes de crear un enlace de configuración.',
      'mailbox_suspended',
    );
  }
}

/**
 * Crea un enlace de configuración SIN contraseña (el cuerpo de
 * POST /api/mailboxes/:id/setup-links). Lo usa también el cambio de dominio
 * («Mensaje para tu equipo»): cada persona abre el suyo y pulsa «Actualizar
 * mis dispositivos». No audita: quien llama tiene la petición y lo hace.
 * 404 si el buzón no existe y 400 mailbox_suspended si está suspendido.
 */
export function crearEnlaceConfiguracion(req: FastifyRequest, mailboxId: string, ttlHours: number): EnlaceNuevo {
  const titular = buzonPorId(mailboxId);
  if (!titular) throw notFound('Buzón no encontrado.');
  exigirBuzonActivo(titular);
  return insertarEnlace(req, titular, null, ttlHours);
}

/** Perfil de Apple del titular: con su usuario del motor y la semilla de su primer perfil. */
function perfilDelTitular(titular: Titular, settings: ConnectionSettings, password?: string): string {
  return mobileconfigPlist({
    email: titular.email,
    usuario: titular.login,
    semilla: titular.semilla ?? titular.email,
    displayName: titular.displayName || undefined,
    settings,
    password,
  });
}

/** Código QR de Thunderbird para Android, con el usuario del motor. */
function qrDelTitular(titular: Titular, settings: ConnectionSettings): string {
  return thunderbirdAndroidQrPayload(titular.email, titular.displayName, settings, titular.login);
}

/**
 * «Actualizar mis dispositivos» desde el portal o el enlace: el usuario del
 * motor pasa a ser la dirección vigente. El correo y todas las contraseñas se
 * conservan; los dispositivos con el usuario anterior dejan de conectar hasta
 * que se actualizan. Idempotente. Un buzón con el que envía una aplicación de
 * Skyway solo lo actualiza Skyway (409 mailbox_used_by_app): después cambia
 * sus variables y la vuelve a desplegar.
 */
async function actualizarDispositivos(
  req: FastifyRequest,
  titular: Titular,
  por: 'titular' | 'enlace',
): Promise<{ ok: true; login: string }> {
  if (!titular.loginPending && !titular.actualizando) return { ok: true, login: titular.login };
  if (titular.appsSkyway.length > 0) throw errorUsadoPorAppTitular(titular.appsSkyway);
  const cambio = await actualizarUsuario(titular.id);
  if (cambio) {
    auditTitular(req, titular.clientId, 'mailbox.login_updated', {
      id: titular.id,
      de: cambio.de,
      a: cambio.a,
      por,
    });
  }
  return { ok: true, login: buzonPorId(titular.id)?.login ?? titular.email };
}

/* ------------------------ Reinicio de la configuración --------------------- */

/** Todos los buzones de un cliente, de cualquiera de sus dominios. */
function buzonesDelCliente(clientId: string): Titular[] {
  const rows = db
    .prepare(`${SELECT_BUZON} WHERE d.client_id = ? ORDER BY d.domain, m.local_part`)
    .all(clientId) as FilaBuzon[];
  return rows.map(aTitular);
}

export interface ReinicioBuzon {
  /** Contraseña principal nueva, en claro: solo para quien la entrega; no se guarda. */
  password: string;
  linksRemoved: number;
  appPasswordsRevoked: number;
  photoRemoved: boolean;
  /** Enlace nuevo, si se ha pedido. */
  link: EnlaceNuevo | null;
}

interface OpcionesReinicio {
  revokeAppPasswords: boolean;
  /** Crear un enlace nuevo para el titular (el reinicio de un buzón lo hace). */
  enlace?: { includePassword: boolean; ttlHours: number };
}

/**
 * Deja el buzón como recién creado para entregárselo al titular: contraseña
 * nueva, fuera los enlaces anteriores, los correos de configuración, las
 * sesiones de «Mi buzón», la foto, los bloqueos por intentos fallidos y (si
 * se pide) las contraseñas de aplicación, y, si se pide, un enlace nuevo. El
 * correo del buzón no se toca.
 *
 * No comprueba permisos ni el estado del buzón y no anota la actividad: de
 * eso se ocupa cada ruta (el reinicio de un buzón anota el suyo; el de toda
 * la puesta en marcha, un resumen).
 */
export function reiniciarBuzon(
  req: FastifyRequest,
  titular: Titular,
  opts: OpcionesReinicio & { enlace: NonNullable<OpcionesReinicio['enlace']> },
): Promise<ReinicioBuzon & { link: EnlaceNuevo }>;
export function reiniciarBuzon(req: FastifyRequest, titular: Titular, opts: OpcionesReinicio): Promise<ReinicioBuzon>;
export async function reiniciarBuzon(
  req: FastifyRequest,
  titular: Titular,
  opts: OpcionesReinicio,
): Promise<ReinicioBuzon> {
  // En la misma cola que las altas de contraseñas de aplicación y el correo
  // de configuración: una contraseña de aplicación que se creara a mitad del
  // reinicio sobreviviría a él, y un correo en espera debe encontrar ya el
  // enlace nuevo (y reutilizarlo) en vez de cambiar otra vez la contraseña.
  return withLock(`contrasenas-app:${titular.id}`, async () => {
    // Primero lo que depende del motor: si no responde, el buzón queda como
    // estaba (salvo las contraseñas de aplicación ya revocadas) y el reinicio
    // se puede repetir sin más.
    let appPasswordsRevoked = 0;
    if (opts.revokeAppPasswords) {
      const activas = db
        .prepare('SELECT id FROM app_passwords WHERE mailbox_id = ? AND revoked_at IS NULL')
        .all(titular.id) as { id: string }[];
      for (const { id: appId } of activas) {
        await revokeAppPassword(titular.id, appId);
        appPasswordsRevoked += 1;
      }
      // Las ya revocadas solo eran historial de la prueba: desde cero es sin él.
      db.prepare('DELETE FROM app_passwords WHERE mailbox_id = ? AND revoked_at IS NOT NULL').run(titular.id);
    }

    // Contraseña nueva siempre: quien probó el buzón conoce la anterior (o la
    // cambió desde «Mi buzón» o el webmail).
    const password = generateMailboxPassword();
    // En fila con el cambio de usuario del motor del buzón.
    await withLock(buzonLockKey(titular.id), () => cambiarContrasenaBuzon(titular, password));
    alCambiarContrasenaBuzon(titular.id);
    // Con la contraseña nueva ningún dispositivo entra: vuelve a estar sin
    // configurar.
    olvidarBuzonConfigurado(titular.id);

    // Los enlaces anteriores se borran, no solo se revocan: el titular recibe
    // un único enlace (el de este reinicio o el que se le envíe después) y la
    // lista del panel vuelve a empezar. El registro de actividad conserva su
    // rastro.
    const linksRemoved = db.prepare('DELETE FROM setup_links WHERE mailbox_id = ?').run(titular.id).changes;
    // Igual con los correos de configuración enviados: desde cero es sin
    // «último envío» (también dejan de contar para el límite por hora).
    db.prepare('DELETE FROM envios_configuracion WHERE mailbox_id = ?').run(titular.id);
    // La foto es parte del onboarding del titular: la de la prueba se retira.
    // El nombre visible lo puso quien creó el buzón y se conserva.
    const photoRemoved = borrarFoto(titular.id);
    // Los fallos de la prueba no deben bloquear al titular en su primer acceso.
    db.prepare('DELETE FROM login_attempts WHERE ip IN (?, ?, ?)').run(
      `buzon:${titular.id}`,
      `buzon:${titular.email}`,
      `buzon-enlace:${titular.id}`,
    );

    const link = opts.enlace
      ? insertarEnlace(
          req,
          titular,
          opts.enlace.includePassword ? encryptSecret(password) : null,
          opts.enlace.ttlHours,
        )
      : null;
    return { password, linksRemoved, appPasswordsRevoked, photoRemoved, link };
  });
}

/* ----------------------------- Sesión «Mi buzón» --------------------------- */

function crearSesionBuzon(req: FastifyRequest, reply: FastifyReply, mailboxId: string): void {
  const { token, hash } = newSessionToken();
  const creada = now();
  db.prepare('DELETE FROM mailbox_sessions WHERE expires_at <= ?').run(creada);
  db.prepare(
    `INSERT INTO mailbox_sessions (token_hash, mailbox_id, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    hash,
    mailboxId,
    creada,
    creada + SESION_HORAS * 3600_000,
    req.ip || '',
    String(req.headers['user-agent'] || '').slice(0, 300),
  );
  reply.setCookie(COOKIE_BUZON, token, {
    path: RUTA_COOKIE,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: SESION_HORAS * 3600,
  });
}

function sesionBuzon(req: FastifyRequest): { titular: Titular; tokenHash: string } {
  const token = req.cookies?.[COOKIE_BUZON];
  if (!token) throw unauthorized('Inicia sesión en «Mi buzón» para continuar.', 'portal_unauthorized');
  const tokenHash = hashToken(token);
  const row = db
    .prepare('SELECT mailbox_id, expires_at FROM mailbox_sessions WHERE token_hash = ?')
    .get(tokenHash) as { mailbox_id: string; expires_at: number } | undefined;
  if (!row || row.expires_at <= now()) {
    if (row) db.prepare('DELETE FROM mailbox_sessions WHERE token_hash = ?').run(tokenHash);
    throw unauthorized('La sesión ha caducado. Vuelve a iniciar sesión.', 'portal_unauthorized');
  }
  const titular = buzonPorId(row.mailbox_id);
  if (!titular) {
    db.prepare('DELETE FROM mailbox_sessions WHERE token_hash = ?').run(tokenHash);
    throw unauthorized('La sesión ha caducado. Vuelve a iniciar sesión.', 'portal_unauthorized');
  }
  // Suspender el buzón o el cliente corta también las sesiones ya abiertas.
  if (!titular.activo) {
    db.prepare('DELETE FROM mailbox_sessions WHERE mailbox_id = ?').run(titular.id);
    throw buzonSuspendido();
  }
  return { titular, tokenHash };
}

/**
 * Ocupación del buzón. El motor es la fuente, pero preguntarle en cada visita
 * es caro (lista todos los buzones): se reutiliza la última lectura si es
 * reciente y, si no, se consulta y se guarda.
 */
async function ocupacion(titular: Titular): Promise<{ usedBytes: number | null; checkedAt: number | null }> {
  const reciente = titular.usageCheckedAt !== null && now() - titular.usageCheckedAt < 15 * 60_000;
  if (reciente) return { usedBytes: titular.usedBytes, checkedAt: titular.usageCheckedAt };
  try {
    // El motor da la ocupación por el usuario del buzón, no por su dirección.
    const bytes = (await getEngine().getMailboxUsage()).get(titular.login.toLowerCase());
    if (bytes === undefined) return { usedBytes: titular.usedBytes, checkedAt: titular.usageCheckedAt };
    const t = now();
    db.prepare('UPDATE mailboxes SET used_bytes = ?, usage_checked_at = ? WHERE id = ?').run(
      bytes,
      t,
      titular.id,
    );
    return { usedBytes: bytes, checkedAt: t };
  } catch {
    // Sin motor se muestra la última lectura conocida (o «sin dato»).
    return { usedBytes: titular.usedBytes, checkedAt: titular.usageCheckedAt };
  }
}

/** URL de la foto con su fecha (o null si no hay): cambia al cambiar la foto. */
function urlFoto(ruta: string, mailboxId: string): string | null {
  const fecha = fechaFoto(mailboxId);
  return fecha === null ? null : `${ruta}?v=${fecha}`;
}

/* ------------------------------ Webmail ------------------------------------ */

/** Comparación en tiempo constante (también en longitud, gracias al hash). */
function tokenWebmailValido(recibido: unknown): boolean {
  if (typeof recibido !== 'string' || !config.webmailToken) return false;
  const a = crypto.createHash('sha256').update(recibido).digest();
  const b = crypto.createHash('sha256').update(config.webmailToken).digest();
  return crypto.timingSafeEqual(a, b);
}

/* -------------------------------- Esquemas --------------------------------- */

const validezEnlaceSchema = z
  .number()
  .int('La validez debe indicarse en horas enteras.')
  .min(1, 'La validez mínima del enlace es de 1 hora.')
  .max(720, 'La validez máxima del enlace es de 720 horas (30 días).')
  .optional()
  .default(72);

const crearEnlaceSchema = z.object({
  includePassword: z.boolean().optional().default(false),
  password: z.string().min(1).max(200).optional(),
  ttlHours: validezEnlaceSchema,
});

const reinicioSchema = z.object({
  /** Retirar los dispositivos y aplicaciones conectados con contraseñas de aplicación. */
  revokeAppPasswords: z.boolean().optional().default(true),
  /** Guardar la contraseña nueva en el enlace para que el titular no la teclee. */
  includePassword: z.boolean().optional().default(true),
  ttlHours: validezEnlaceSchema,
});

const reinicioClienteSchema = z.object({
  /**
   * Retirar también las contraseñas de aplicación de todos los buzones. Por
   * defecto no: en un cliente entero es fácil que alguna la use una
   * integración que debe seguir enviando.
   */
  revokeAppPasswords: z
    .boolean({ invalid_type_error: 'Indica si se retiran las contraseñas de aplicación (true o false).' })
    .optional()
    .default(false),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Introduce una dirección de correo válida.'),
  password: z.string().min(1, 'Introduce la contraseña.').max(200),
});

const cambioSchema = z.object({
  current: z.string().min(1, 'Introduce la contraseña actual.').max(200),
  next: z
    .string()
    .min(MIN_CONTRASENA, `La nueva contraseña debe tener al menos ${MIN_CONTRASENA} caracteres.`)
    .max(200, 'La nueva contraseña no puede superar los 200 caracteres.'),
});

const appPasswordSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Indica un nombre que identifique el dispositivo, por ejemplo «Móvil».')
    .max(60, 'El nombre no puede superar los 60 caracteres.'),
});

const webmailPerfilSchema = z.object({ user: z.string().trim().toLowerCase().min(3).max(320) });

const webmailFotoSchema = z.object({
  user: z.string().trim().toLowerCase().min(3).max(320),
  email: z.string().trim().toLowerCase().min(3).max(320),
});

const webmailSchema = z.object({
  user: z.string().trim().toLowerCase().min(3).max(320),
  curpass: z.string().min(1).max(200),
  newpass: z.string().max(200),
});

const webmailCuentaSchema = z.object({
  user: z.string().trim().toLowerCase().min(3).max(320),
});

/* --------------------------------- Rutas ----------------------------------- */

export function registerPortalRoutes(app: FastifyInstance): void {
  const limitePublico = crearLimitador(60, 60_000);
  function limitarPublico(req: FastifyRequest): void {
    if (!limitePublico(req.ip || '')) {
      throw tooMany('Se han realizado demasiadas peticiones. Espera un minuto y vuelve a intentarlo.');
    }
  }

  /* ---------------- Enlaces de configuración (panel) ---------------- */

  app.post('/api/mailboxes/:id/setup-links', async (req) => {
    const { id } = req.params as { id: string };
    const titular = buzonDelPanel(req, id);
    const body = crearEnlaceSchema.parse(req.body ?? {});
    exigirBuzonActivo(titular);

    let passwordEnc: string | null = null;
    if (body.includePassword) {
      if (!body.password) {
        throw badRequest(
          'Para incluir la contraseña en el enlace, indica la contraseña que se acaba de generar.',
          'password_required',
        );
      }
      // Se comprueba antes de guardarla: un enlace con una contraseña que no
      // funciona es peor que uno sin contraseña. Los fallos cuentan (por
      // buzón) para que la comprobación no sirva de oráculo de contraseñas.
      purgarFallos();
      const claveFallos = `buzon-enlace:${titular.id}`;
      if (contarFallos(claveFallos) >= MAX_FALLOS_ENLACE) {
        throw tooMany(
          'Se han indicado demasiadas contraseñas que no coinciden con la del buzón. Espera 15 minutos o crea el enlace sin la contraseña.',
        );
      }
      const resultado: ResultadoComprobacion = await comprobarContrasenaBuzon(titular.id, body.password);
      if (resultado === 'sin_respuesta') {
        // Sin comprobarla no se guarda: podría no ser la del buzón.
        throw new HttpError(
          503,
          'No se ha podido comprobar la contraseña con el servidor de correo, así que no se ha incluido en el enlace. Vuelve a intentarlo en unos minutos o crea el enlace sin la contraseña.',
          'engine_unreachable',
        );
      }
      if (resultado === 'sin_copia') {
        throw new HttpError(
          409,
          'El panel no tiene copia de la contraseña de este buzón, así que no puede comprobarla. Restablece la contraseña del buzón o crea el enlace sin ella.',
          'password_unverifiable',
        );
      }
      if (resultado === 'incorrecta') {
        db.prepare('INSERT INTO login_attempts (ip, attempted_at) VALUES (?, ?)').run(claveFallos, now());
        throw badRequest(
          'La contraseña indicada no es la del buzón. Comprueba que es la última que se ha generado.',
          'password_mismatch',
        );
      }
      // Una contraseña de aplicación también «vale», pero el enlace es para
      // la principal: con otra, el titular configuraría su móvil con una
      // credencial que alguien puede revocar sin avisarle.
      if (resultado === 'aplicacion') throw contrasenaDeAplicacion();
      passwordEnc = encryptSecret(body.password);
    }

    const link = insertarEnlace(req, titular, passwordEnc, body.ttlHours);
    audit(req, 'mailbox.setup_link_created', {
      mailboxId: titular.id,
      email: titular.email,
      linkId: link.id,
      hasPassword: link.hasPassword,
      ttlHours: body.ttlHours,
    }, titular.clientId);
    return { link };
  });

  app.get('/api/mailboxes/:id/setup-links', async (req) => {
    const { id } = req.params as { id: string };
    const titular = buzonDelPanel(req, id);
    purgarEnlaces();
    const rows = db
      .prepare('SELECT * FROM setup_links WHERE mailbox_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(titular.id) as FilaEnlace[];
    return {
      links: rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastOpenedAt: row.last_opened_at,
        revokedAt: row.revoked_at,
        hasPassword: row.password_enc !== null,
        // La administración puede volver a verlo y enviarlo (GET …/url).
        recoverable: row.token_enc !== null,
      })),
    };
  });

  /*
   * Volver a enviar un enlace que sigue activo: solo la administración. El
   * cliente gestiona sus buzones pero no recupera enlaces ya entregados (si
   * lo pierde, crea otro, que queda en su actividad); quien administra el
   * servicio sí, porque es quien suele hacer de soporte del titular.
   */
  app.get('/api/mailboxes/:id/setup-links/:linkId/url', async (req, reply) => {
    const { id, linkId } = req.params as { id: string; linkId: string };
    const titular = buzonDelPanel(req, id);
    requireAdmin(req);
    purgarEnlaces();
    const row = db
      .prepare('SELECT * FROM setup_links WHERE id = ? AND mailbox_id = ?')
      .get(linkId, titular.id) as FilaEnlace | undefined;
    if (!row || row.revoked_at || row.expires_at <= now()) throw enlaceNoValido();
    let token: string | null = null;
    try {
      token = row.token_enc ? decryptSecret(row.token_enc) : null;
    } catch {
      // Clave maestra cambiada: el enlace funciona, pero ya no se puede leer.
      token = null;
    }
    if (!token) {
      throw new HttpError(
        409,
        'Este enlace se creó antes de poder volver a enviarse. Crea uno nuevo.',
        'setup_link_not_recoverable',
      );
    }
    audit(req, 'mailbox.setup_link_viewed', { mailboxId: titular.id, email: titular.email, linkId }, titular.clientId);
    reply.header('Cache-Control', 'no-store');
    return {
      link: {
        id: row.id,
        url: `${publicBaseUrl(req)}/conectar/${token}`,
        expiresAt: row.expires_at,
        hasPassword: row.password_enc !== null,
      },
    };
  });

  app.delete('/api/mailboxes/:id/setup-links/:linkId', async (req) => {
    const { id, linkId } = req.params as { id: string; linkId: string };
    const titular = buzonDelPanel(req, id);
    const row = db
      .prepare('SELECT id FROM setup_links WHERE id = ? AND mailbox_id = ?')
      .get(linkId, titular.id) as { id: string } | undefined;
    if (!row) throw notFound('Enlace de configuración no encontrado.');
    db.prepare(
      'UPDATE setup_links SET revoked_at = COALESCE(revoked_at, ?), password_enc = NULL, token_enc = NULL WHERE id = ?',
    ).run(now(), linkId);
    audit(req, 'mailbox.setup_link_revoked', { mailboxId: titular.id, email: titular.email, linkId }, titular.clientId);
    return { ok: true };
  });

  /**
   * Reinicia la configuración del buzón para empezar de cero, normalmente
   * tras haberlo probado quien lo administra: contraseña nueva, fuera los
   * enlaces anteriores, las sesiones de «Mi buzón», los bloqueos por
   * intentos fallidos y (si se pide) las contraseñas de aplicación, y un
   * enlace de configuración nuevo listo para entregar al titular. El correo
   * del buzón no se toca.
   */
  app.post('/api/mailboxes/:id/setup-reset', async (req) => {
    const { id } = req.params as { id: string };
    const titular = buzonDelPanel(req, id);
    const body = reinicioSchema.parse(req.body ?? {});
    exigirBuzonActivo(titular);

    // Lo que el reinicio de toda la puesta en marcha no hace: un enlace nuevo,
    // listo para entregar a este titular.
    const { password, link, linksRemoved, appPasswordsRevoked, photoRemoved } = await reiniciarBuzon(req, titular, {
      revokeAppPasswords: body.revokeAppPasswords,
      enlace: { includePassword: body.includePassword, ttlHours: body.ttlHours },
    });
    audit(req, 'mailbox.setup_reset', {
      mailboxId: titular.id,
      email: titular.email,
      linkId: link.id,
      hasPassword: link.hasPassword,
      ttlHours: body.ttlHours,
      linksRemoved,
      appPasswordsRevoked,
      photoRemoved,
    }, titular.clientId);
    return { password, link, linksRemoved, appPasswordsRevoked, photoRemoved };
  });

  /**
   * Reinicia la puesta en marcha de todo un cliente: cada buzón activo queda
   * como en `setup-reset`, pero sin enlace nuevo. La entrega vuelve a empezar
   * desde la puesta en marcha del cliente (enlace de bienvenida y, desde ella,
   * el correo de configuración de cada titular), no buzón a buzón.
   *
   * Solo la administración y con sesión del panel: cambia de una vez la
   * contraseña de todos los buzones de una empresa, y un token de gestión
   * filtrado no debe bastar para dejar sin correo todos sus dispositivos.
   */
  app.post('/api/clients/:id/onboarding-reset', async (req) => {
    requireAdminSession(req);
    const { id } = req.params as { id: string };
    const client = getClient(id);
    const body = reinicioClienteSchema.parse(req.body ?? {});
    if (client.suspended) {
      throw badRequest(
        'El cliente está suspendido. Reactívalo antes de reiniciar su puesta en marcha.',
        'client_suspended',
      );
    }
    // Sin motor configurado, o con el motor en mantenimiento, fallarían todos
    // los buzones por el mismo motivo: mejor un único error claro antes de
    // tocar nada.
    getEngine();
    exigirSinMantenimiento();

    const titulares = buzonesDelCliente(id);
    const activos = titulares.filter((t) => !t.suspendido);
    const resultado: { reset: number; skipped: number; failed: { email: string; error: string }[] } = {
      // Los suspendidos se quedan como están: su titular no puede entrar, y
      // al reactivarlos conservan su configuración.
      reset: 0,
      skipped: titulares.length - activos.length,
      failed: [],
    };
    // Varios a la vez, pero pocos: el motor es un único servidor compartido.
    // Un buzón que falla no detiene los demás; repetir el reinicio lo reintenta.
    await runLimited(activos, 5, async (titular) => {
      try {
        await reiniciarBuzon(req, titular, { revokeAppPasswords: body.revokeAppPasswords });
        resultado.reset += 1;
      } catch (err) {
        if (!(err instanceof HttpError)) req.log.warn({ err, mailboxId: titular.id }, 'Fallo al reiniciar un buzón');
        resultado.failed.push({
          email: titular.email,
          // Los errores del motor ya vienen redactados para la interfaz; uno
          // inesperado no se enseña tal cual.
          error: err instanceof HttpError ? err.message : 'No se ha podido reiniciar este buzón. Vuelve a intentarlo.',
        });
      }
    });
    resultado.failed.sort((a, b) => a.email.localeCompare(b.email));

    // Una sola anotación para todo el cliente (sin contraseñas ni enlaces):
    // una por buzón inundaría su Actividad.
    audit(req, 'client.onboarding_reset', {
      clientId: id,
      reset: resultado.reset,
      skipped: resultado.skipped,
      failed: resultado.failed.length,
      revokeAppPasswords: body.revokeAppPasswords,
    }, id);
    return resultado;
  });

  /* ------------------ Enlaces de configuración (público) ------------------ */

  app.get('/api/public/setup/:token', async (req, reply) => {
    limitarPublico(req);
    const { token } = req.params as { token: string };
    const { enlace, titular } = enlacePorToken(token);
    db.prepare('UPDATE setup_links SET last_opened_at = ? WHERE id = ?').run(now(), enlace.id);
    const { settings, connection } = datosConexion(titular);
    const base = publicBaseUrl(req);
    const password = contrasenaDelEnlace(enlace);
    reply.header('Cache-Control', 'no-store');
    return {
      email: titular.email,
      // Se calcula al abrir: tras «Actualizar mis dispositivos» el mismo
      // enlace enseña ya el usuario nuevo.
      login: titular.login,
      loginPending: titular.loginPending,
      displayName: titular.displayName,
      brandName: settings.brandName,
      connection,
      password,
      hasPassword: password !== undefined,
      expiresAt: enlace.expires_at,
      portalUrl: `${base}/mi-buzon`,
      // Relativa, como la de «Mi buzón»: la imagen se pide al mismo host que
      // sirvió la página.
      photoUrl: urlFoto(`/api/public/setup/${token}/photo`, titular.id),
      appleProfileUrl: `${base}/api/public/setup/${token}/perfil.mobileconfig`,
      thunderbirdAndroidQr: qrDelTitular(titular, settings),
      // Un buzón con el que envía una aplicación de Skyway solo lo actualiza
      // Skyway: así la página no ofrece un botón que respondería 409.
      usadoPorApp: titular.appsSkyway.length > 0,
    };
  });

  app.get('/api/public/setup/:token/perfil.mobileconfig', async (req, reply) => {
    limitarPublico(req);
    const { token } = req.params as { token: string };
    const { enlace, titular } = enlacePorToken(token);
    db.prepare('UPDATE setup_links SET last_opened_at = ? WHERE id = ?').run(now(), enlace.id);
    // Quien descarga el perfil lo instala en ese momento: es la señal más
    // clara (en iPhone y Mac) de que el titular ya tiene el buzón.
    marcarBuzonConfigurado(titular.id);
    const { settings } = datosConexion(titular);
    // Solo el enlace de bienvenida lleva la contraseña: así el titular no
    // tiene que teclearla en el móvil.
    const plist = perfilDelTitular(titular, settings, contrasenaDelEnlace(enlace));
    return enviarPerfil(reply, titular.email, plist);
  });

  app.post('/api/public/setup/:token/done', async (req) => {
    limitarPublico(req);
    const { token } = req.params as { token: string };
    const { enlace, titular } = enlacePorToken(token);
    // El enlace sigue sirviendo de guía para otros dispositivos, pero ya no
    // tiene por qué guardar la contraseña.
    db.prepare('UPDATE setup_links SET password_enc = NULL WHERE id = ?').run(enlace.id);
    marcarBuzonConfigurado(titular.id);
    return { ok: true };
  });

  // Perfil desde el onboarding: quien tiene el enlace es el titular, así que
  // puede poner su nombre y su foto antes de configurar los dispositivos (el
  // nombre va en el perfil de Apple y en el QR de Thunderbird).
  app.patch('/api/public/setup/:token/profile', async (req) => {
    limitarPublico(req);
    const { token } = req.params as { token: string };
    const { titular } = enlacePorToken(token);
    const body = nombreSchema.parse(req.body ?? {});
    if (await cambiarNombreVisible(titular, body.displayName)) {
      auditTitular(req, titular.clientId, 'portal.profile_updated', { email: titular.email, via: 'setup_link' });
    }
    return { displayName: body.displayName };
  });

  app.get('/api/public/setup/:token/photo', async (req, reply) => {
    limitarPublico(req);
    const { token } = req.params as { token: string };
    const { titular } = enlacePorToken(token);
    return enviarFoto(reply, leerFoto(titular.id));
  });

  app.put('/api/public/setup/:token/photo', async (req) => {
    limitarPublico(req);
    const { token } = req.params as { token: string };
    const { titular } = enlacePorToken(token);
    const body = fotoSchema.parse(req.body ?? {});
    const photoUpdatedAt = guardarFoto(titular.id, body.photo);
    auditTitular(req, titular.clientId, 'portal.photo_updated', { email: titular.email, via: 'setup_link' });
    return { photoUrl: urlFoto(`/api/public/setup/${token}/photo`, titular.id), photoUpdatedAt };
  });

  app.delete('/api/public/setup/:token/photo', async (req) => {
    limitarPublico(req);
    const { token } = req.params as { token: string };
    const { titular } = enlacePorToken(token);
    if (borrarFoto(titular.id)) {
      auditTitular(req, titular.clientId, 'portal.photo_removed', { email: titular.email, via: 'setup_link' });
    }
    return { ok: true };
  });

  /*
   * «Actualizar y continuar» desde el enlace, sin contraseña. Solo cambia el
   * usuario del propio buzón a su dirección vigente (lo mismo que hará la baja
   * del dominio anterior): no da acceso ni revela nada, y quien tiene el
   * enlace —un secreto de 256 bits que crea quien administra el correo— ya ve
   * los datos de conexión. Lo peor posible es que unos dispositivos dejen de
   * conectar antes de tiempo. Ver docs/SEGURIDAD.md.
   */
  app.post('/api/public/setup/:token/login-update', async (req) => {
    limitarPublico(req);
    const { token } = req.params as { token: string };
    const { titular } = enlacePorToken(token);
    z.object({}).parse(req.body ?? {});
    return actualizarDispositivos(req, titular, 'enlace');
  });

  /* ------------------------------ «Mi buzón» ------------------------------ */

  app.post('/api/portal/login', async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const ip = req.ip || '';
    // Dirección, usuario anterior o dirección del dominio pareja: las tres
    // llevan al mismo buzón y a su mismo contador de fallos.
    const titular = buzonPorDireccion(body.email);
    const clave = claveDeFallos(body.email, titular);
    comprobarLimite(clave, ip);
    if (!titular) {
      // Cuesta lo mismo que una contraseña incorrecta: el tiempo de respuesta
      // no dice qué direcciones existen.
      await comprobarContrasenaBuzon(null, body.password);
      registrarFallo(clave, ip);
      throw credencialesIncorrectas();
    }
    if (titular.suspendido) {
      // Cuenta como intento: así no sirve para sondear direcciones deprisa.
      registrarFallo(clave, ip);
      throw buzonSuspendido();
    }
    await comprobarContrasenaPrincipal(titular, body.password, ip, credencialesIncorrectas);
    crearSesionBuzon(req, reply, titular.id);
    // Entrar con la contraseña principal demuestra que el titular la tiene.
    marcarBuzonConfigurado(titular.id);
    auditTitular(req, titular.clientId, 'portal.login', { email: titular.email });
    return { ok: true, email: titular.email };
  });

  app.post('/api/portal/logout', async (req, reply) => {
    const token = req.cookies?.[COOKIE_BUZON];
    if (token) db.prepare('DELETE FROM mailbox_sessions WHERE token_hash = ?').run(hashToken(token));
    reply.clearCookie(COOKIE_BUZON, { path: RUTA_COOKIE });
    return { ok: true };
  });

  app.get('/api/portal/me', async (req, reply) => {
    const { titular } = sesionBuzon(req);
    const { settings, connection } = datosConexion(titular);
    const uso = await ocupacion(titular);
    reply.header('Cache-Control', 'no-store');
    return {
      email: titular.email,
      login: titular.login,
      loginPending: titular.loginPending,
      // Con una aplicación de Skyway, «Mi buzón» no ofrece actualizar: lo hace Skyway.
      usadoPorApp: titular.appsSkyway.length > 0,
      displayName: titular.displayName,
      domain: titular.domain,
      quotaMb: titular.quotaMb,
      usedBytes: uso.usedBytes,
      usageCheckedAt: uso.checkedAt,
      brandName: settings.brandName,
      connection,
      webmailUrl: settings.webmailUrl,
      // Relativa a propósito: la cookie del titular es del host desde el que
      // entró, que puede no ser la URL pública configurada del panel.
      appleProfileUrl: `${RUTA_COOKIE}/mobileconfig`,
      photoUrl: urlFoto(`${RUTA_COOKIE}/photo`, titular.id),
      thunderbirdAndroidQr: qrDelTitular(titular, settings),
      // Contraseñas de aplicación que dejaron de funcionar al actualizar el
      // servidor de correo: «Mi buzón» avisa arriba para que cree otras.
      invalidatedAppPasswords: contrasenasInvalidadas(titular.id),
      // Su webmail es el correo web nuevo (Bulwark): tras cambiar la
      // contraseña hay que cerrarlo y volver a entrar (ver la ruta siguiente).
      newWebmail: usaCorreoWebNuevo(titular),
    };
  });

  app.post('/api/portal/password', async (req) => {
    const { titular, tokenHash } = sesionBuzon(req);
    const body = cambioSchema.parse(req.body);
    if (body.next === body.current) {
      throw badRequest('La nueva contraseña debe ser distinta de la actual.', 'same_password');
    }
    // Con el cerrojo del buzón, como el restablecimiento del panel: un cambio
    // de usuario a la vez dejaría la contraseña en un nombre que ya no existe.
    await withLock(buzonLockKey(titular.id), async () => {
      await comprobarContrasenaPrincipal(titular, body.current, req.ip || '', () =>
        badRequest('La contraseña actual no es correcta.', 'bad_current_password'),
      );
      // Solo cambia la principal: las contraseñas de aplicación (otros
      // dispositivos, integraciones) siguen funcionando.
      await cambiarContrasenaBuzon(titular, body.next);
    });
    alCambiarContrasenaBuzon(titular.id, tokenHash);
    auditTitular(req, titular.clientId, 'portal.password_changed', { email: titular.email });
    // El correo web nuevo no vuelve al acceso al cambiar la contraseña: sigue
    // reintentando con la anterior desde la IP del titular y el motor acaba
    // bloqueándola (deploy/bulwark/README.md, «Riesgos»). «Mi buzón» pide
    // cerrarlo y volver a entrar.
    return { ok: true, reopenWebmail: usaCorreoWebNuevo(titular) };
  });

  app.post('/api/portal/login-update', async (req) => {
    const { titular } = sesionBuzon(req);
    z.object({}).parse(req.body ?? {});
    // La sesión sigue: va por el id del buzón, no por su usuario.
    return actualizarDispositivos(req, titular, 'titular');
  });

  app.get('/api/portal/mobileconfig', async (req, reply) => {
    const { titular } = sesionBuzon(req);
    const { settings } = datosConexion(titular);
    // Sin contraseña: el dispositivo la pide al instalar el perfil.
    return enviarPerfil(reply, titular.email, perfilDelTitular(titular, settings));
  });

  app.patch('/api/portal/profile', async (req) => {
    const { titular } = sesionBuzon(req);
    const body = nombreSchema.parse(req.body ?? {});
    if (await cambiarNombreVisible(titular, body.displayName)) {
      auditTitular(req, titular.clientId, 'portal.profile_updated', { email: titular.email, via: 'portal' });
    }
    return { displayName: body.displayName };
  });

  app.get('/api/portal/photo', async (req, reply) => {
    const { titular } = sesionBuzon(req);
    return enviarFoto(reply, leerFoto(titular.id));
  });

  app.put('/api/portal/photo', async (req) => {
    const { titular } = sesionBuzon(req);
    const body = fotoSchema.parse(req.body ?? {});
    const photoUpdatedAt = guardarFoto(titular.id, body.photo);
    auditTitular(req, titular.clientId, 'portal.photo_updated', { email: titular.email, via: 'portal' });
    return { photoUrl: urlFoto(`${RUTA_COOKIE}/photo`, titular.id), photoUpdatedAt };
  });

  app.delete('/api/portal/photo', async (req) => {
    const { titular } = sesionBuzon(req);
    if (borrarFoto(titular.id)) {
      auditTitular(req, titular.clientId, 'portal.photo_removed', { email: titular.email, via: 'portal' });
    }
    return { ok: true };
  });

  app.get('/api/portal/app-passwords', async (req) => {
    const { titular } = sesionBuzon(req);
    return { appPasswords: listAppPasswords(titular.id) };
  });

  app.post('/api/portal/app-passwords', async (req, reply) => {
    const { titular } = sesionBuzon(req);
    const body = appPasswordSchema.parse(req.body);
    if (body.name.toLowerCase().startsWith(PREFIJO_SKYWAY)) throw nombreReservado();
    // El máximo de activas (el mismo que en el panel, 409) lo aplica createAppPassword.
    const created = await createAppPassword(titular.id, body.name, null);
    auditTitular(req, titular.clientId, 'mailbox.app_password_created', {
      email: titular.email,
      id: created.appPassword.id,
      name: created.appPassword.name,
      via: 'portal',
    });
    reply.header('Cache-Control', 'no-store');
    // La contraseña en claro (y los bloques que la contienen) solo viaja en
    // esta respuesta.
    return { ...created, snippets: variablesContrasenaAplicacion(created.appPassword, created.password) };
  });

  app.delete('/api/portal/app-passwords/:appId', async (req) => {
    const { titular } = sesionBuzon(req);
    const { appId } = req.params as { appId: string };
    await revokeAppPassword(titular.id, appId);
    auditTitular(req, titular.clientId, 'mailbox.app_password_revoked', {
      email: titular.email,
      id: appId,
      via: 'portal',
    });
    return { ok: true };
  });

  /* ------------------ Cambio de contraseña desde el webmail ----------------- */

  // Ámbito encapsulado: el analizador de formularios solo existe para esta
  // ruta (el complemento «password» de Roundcube, driver httpapi, envía
  // application/x-www-form-urlencoded) y no abre ese tipo de cuerpo al resto
  // de la API, que solo acepta JSON.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 16 * 1024 },
      (_req, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      },
    );

    scope.post('/api/webmail/password', async (req, reply) => {
      // Sin secreto compartido la ruta no existe: nadie puede usarla para
      // probar contraseñas.
      if (!config.webmailToken) throw notFound('Ruta no encontrada.');
      // Roundcube solo mira si la respuesta es 2xx: el cuerpo es texto llano.
      const responder = (status: number, texto: 'ok' | 'error') =>
        reply.status(status).type('text/plain; charset=utf-8').send(texto);

      if (!tokenWebmailValido(req.headers['x-mailway-token'])) return responder(401, 'error');
      const parsed = webmailSchema.safeParse(req.body);
      if (!parsed.success) return responder(400, 'error');
      const { user, curpass, newpass } = parsed.data;
      if (newpass.length < MIN_CONTRASENA || newpass === curpass) return responder(400, 'error');

      // «user» es el usuario de la sesión de Roundcube: el del motor, que
      // durante un cambio de dominio puede ser la dirección anterior.
      const titular = buzonPorDireccion(user);
      const clave = claveDeFallos(user, titular);
      // Tras Traefik todas las peticiones llegan con la IP del webmail: solo
      // tiene sentido el límite por buzón.
      try {
        comprobarLimite(clave, null);
      } catch {
        return responder(429, 'error');
      }
      if (!titular) {
        registrarFallo(clave, null);
        return responder(403, 'error');
      }
      if (titular.suspendido) return responder(403, 'error');

      // Con el cerrojo del buzón: un cambio de usuario del motor a la vez
      // dejaría la contraseña en un nombre que ya no existe.
      return withLock(buzonLockKey(titular.id), async () => {
        const resultado = await comprobarContrasenaBuzon(titular.id, curpass);
        if (resultado === 'sin_respuesta') return responder(503, 'error');
        if (resultado === 'sin_copia') return responder(409, 'error');
        if (resultado === 'incorrecta') {
          registrarFallo(titular.id, null);
          return responder(403, 'error');
        }
        if (resultado === 'aplicacion') return responder(403, 'error');

        try {
          await cambiarContrasenaBuzon(titular, newpass);
        } catch (err) {
          // Cambio de usuario a medias: el conciliador lo resuelve en minutos.
          if (err instanceof HttpError && err.code === 'mailbox_login_updating') return responder(409, 'error');
          throw err;
        }
        alCambiarContrasenaBuzon(titular.id);
        auditTitular(req, titular.clientId, 'webmail.password_changed', { email: titular.email });
        return responder(200, 'ok');
      });
    });

    /*
     * Cuenta del webmail (complemento mailway_cuentas de Roundcube). Al entrar,
     * Roundcube pregunta qué usuario corresponde a lo que se ha tecleado (la
     * dirección vieja, la nueva o el usuario) para entrar con el vigente y
     * llevarse a él los contactos, firmas y preferencias del usuario anterior.
     * No comprueba contraseñas, así que no cuenta fallos; exige el secreto
     * compartido del webmail y, sin él configurado, no existe.
     */
    scope.post('/api/webmail/cuenta', async (req, reply) => {
      if (!config.webmailToken) throw notFound('Ruta no encontrada.');
      if (!tokenWebmailValido(req.headers['x-mailway-token'])) {
        throw unauthorized('El token del webmail no es válido.', 'webmail_token_invalid');
      }
      const { user } = webmailCuentaSchema.parse(req.body ?? {});
      const resuelto = resolverBuzon(user);
      if (!resuelto) throw notFound('No hay ningún buzón con esa dirección o ese usuario.', 'not_found');
      // Con un cambio de usuario a medias no se sabe cuál es el vigente: 409
      // mailbox_login_updating, y el complemento entra con lo tecleado en vez de
      // traducirlo a un usuario que quizá ya no exista (ni trasladar filas).
      loginParaMotor(resuelto.mailboxId);
      reply.header('Cache-Control', 'no-store');
      return datosWebmail(resuelto.mailboxId);
    });

    /*
     * Perfil para el complemento mailway_perfil de Roundcube: el nombre con
     * el que crea (y mantiene) la identidad del remitente y si hay foto. Solo
     * con el secreto compartido, como el cambio de contraseña.
     */
    scope.post('/api/webmail/profile', async (req, reply) => {
      if (!config.webmailToken) throw notFound('Ruta no encontrada.');
      if (!tokenWebmailValido(req.headers['x-mailway-token'])) throw unauthorized();
      const parsed = webmailPerfilSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest('Petición no válida.');
      const titular = buzonPorDireccion(parsed.data.user);
      if (!titular) throw notFound('Buzón no encontrado.');
      // Roundcube solo la llama justo después de que el titular haya entrado
      // en el webmail con su contraseña (alta y cada acceso): ya tiene el buzón.
      marcarBuzonConfigurado(titular.id);
      reply.header('Cache-Control', 'no-store');
      return { name: titular.displayName, photo: fechaFoto(titular.id) !== null };
    });

    /*
     * Avatar del remitente en el webmail. Solo entre buzones del mismo
     * cliente: la foto de un empleado no se enseña a quien recibe su correo
     * en otra empresa alojada en la misma instancia.
     */
    scope.post('/api/webmail/photo', async (req, reply) => {
      if (!config.webmailToken) throw notFound('Ruta no encontrada.');
      if (!tokenWebmailValido(req.headers['x-mailway-token'])) throw unauthorized();
      const parsed = webmailFotoSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest('Petición no válida.');
      const quienMira = buzonPorDireccion(parsed.data.user);
      const remitente = buzonPorDireccion(parsed.data.email);
      if (!quienMira || !remitente || quienMira.clientId !== remitente.clientId) {
        throw notFound('Este buzón no tiene foto.', 'photo_not_found');
      }
      return enviarFoto(reply, leerFoto(remitente.id));
    });
  });
}
