import tls from 'node:tls';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../core/db';
import { decryptSecret } from '../core/crypto';
import { badRequest, HttpError, notFound, upstream } from '../core/errors';
import { isInternalHost, normalizeHostname } from '../core/hostnames';
import { apiDelMotor, engineConfigured, getEngine } from '../engine';
import { motorNoAdmite } from '../engine/errores';
import type {
  EngineApi,
  EngineReloadResult,
  EngineSettings,
  EngineSettingsStatus,
  MailEngine,
  RecommendedInput,
} from '../engine/types';
import { fireAlert, resolveAlert, resolveAlertsOfType } from './alerts';
import { audit } from './audit';
import { requireAdmin } from './auth';
import { rechazarSoloCliente } from './cloudflare';
import { estadoMantenimiento, exigirSinMantenimiento } from './mantenimiento';
import { getEngineSettings, getInstanceSettings, getJsonSetting, setJsonSetting } from './settings';
import { corsPermisivoNecesario } from './webmailmotor';
import { CADUCIDAD_BLOQUEO_MS } from '../engine/stalwart016';

/**
 * Operaciones sobre el servidor de correo: ajustes recomendados del motor
 * (nombre del servidor, confianza en el proxy, rango exento de baneo y, en
 * Stalwart 0.16, lo que trae desactivado o distinto), estado y emisión del
 * certificado TLS. Todo pasa por operaciones del contrato del motor: cada
 * versión de Stalwart lo guarda a su manera (claves en 0.15, objetos en 0.16).
 *
 * Por qué existe: Stalwart arranca con valores que funcionan en un portátil
 * pero no detrás de Traefik y junto a un webmail. Sin nombre fijado, anuncia
 * el identificador del contenedor en sus registros DNS; sin confiar en el
 * proxy, todo lo que llega por Traefik comparte una IP y un escáner la banea;
 * sin exención para el webmail, los fallos de contraseña de los usuarios de
 * Roundcube acaban bloqueando para siempre la IP del webmail.
 */

/** Puerto IMAP con TLS implícito: el que usan los programas de correo. */
const IMAPS_PORT = 993;
const TLS_TIMEOUT_MS = 5000;
/** Días de margen antes de caducar: avisar con tiempo de reaccionar. */
const TLS_WARNING_DAYS = 20;
const TLS_CRITICAL_DAYS = 7;

const LETS_ENCRYPT_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

/**
 * Subred de la red `mailway-internal` del compose. Es fija y poco común a
 * propósito: así el motor puede eximir de su baneo automático SOLO al
 * webmail (y al panel en la instalación autónoma), sin eximir la red del
 * proxy, por la que entra el tráfico de Internet.
 */
export const DEFAULT_TRUSTED_NETWORK = '10.203.53.0/24';

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/([12]?\d|3[0-2]))?$/;
const IPV6 = /^[0-9a-f:]*:[0-9a-f:]*(\/(\d{1,2}|1[01]\d|12[0-8]))?$/i;

/**
 * Rangos que el motor debe tratar como de confianza (sin baneo automático).
 * MAILWAY_ENGINE_TRUSTED_NETWORK admite varios separados por comas; vacío
 * desactiva la exención. Se lee en cada llamada para que las pruebas y un
 * cambio de entorno no dependan del orden de carga de los módulos.
 */
export function trustedEngineNetworks(): string[] {
  const raw = process.env.MAILWAY_ENGINE_TRUSTED_NETWORK ?? DEFAULT_TRUSTED_NETWORK;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && (IPV4.test(s) || IPV6.test(s)));
}

/**
 * Máximo de contraseñas de aplicación por buzón que se pide al motor
 * (Stalwart 0.16 admite 5 por defecto; 0.15 no tiene límite). Cada buzón
 * puede necesitar a la vez:
 * - 25 de dispositivos y servicios de Skyway (MAX_ACTIVE_APP_PASSWORDS);
 * - una credencial SMTP interna por cada formulario que entrega en él: como
 *   mucho 20, el máximo de formularios por cliente (MAX_FORMULARIOS_POR_CLIENTE);
 * - una por cada clave de API que lo usa como remitente, sin tope propio.
 * 100 cubre los dos primeros y deja sitio para 55 claves de API sobre el
 * mismo buzón, mucho más de lo habitual (una o dos por aplicación). Se fija
 * a mano y no se importan las constantes: engineops lo cargan módulos que
 * esos dos importan, y las pruebas comprueban que la cuenta sigue cuadrando.
 */
export const MAX_CONTRASENAS_APLICACION_MOTOR = 100;

/**
 * Lo que Mailway pide al motor para funcionar bien detrás de Traefik. El
 * CORS depende de si algún cliente usa el correo web nuevo
 * (corsPermisivoNecesario); `permissiveCors` lo fija a mano para quien lo
 * aplica justo antes de guardar esa elección (correoweb.ts).
 */
export function recommendedInput(mailHostname: string, opciones: { permissiveCors?: boolean } = {}): RecommendedInput {
  return {
    hostname: mailHostname,
    trustedNetworks: trustedEngineNetworks(),
    maxAppPasswords: MAX_CONTRASENAS_APLICACION_MOTOR,
    permissiveCors: opciones.permissiveCors ?? corsPermisivoNecesario(),
  };
}

/** Descripción legible de lo aplicado (respuesta de la ruta y salida de la herramienta). */
function descripcionAplicados(input: RecommendedInput, api: EngineApi | null): string[] {
  const aplicados = [
    `Nombre del servidor: ${input.hostname}`,
    // Con esto el motor toma la IP real del visitante de X-Forwarded-For: sin
    // él, un escáner que pide /wp-login.php a través de Traefik banea la IP de
    // Traefik y deja fuera de servicio la web del motor para todos.
    'IP real de los visitantes por X-Forwarded-For',
    ...input.trustedNetworks.map((n) => `Red exenta del bloqueo automático: ${n}`),
  ];
  // 0.15 no limita las contraseñas de aplicación ni tiene correo web nuevo:
  // no hay nada de eso que fijar.
  if (api === 'jmap016') {
    aplicados.push(`Máximo de contraseñas de aplicación por buzón: ${input.maxAppPasswords}`);
    aplicados.push(
      `Bloqueo automático por fallos de acceso con caducidad: ${Math.round(CADUCIDAD_BLOQUEO_MS / 60_000)} minutos como máximo`,
    );
    if (input.permissiveCors) aplicados.push('CORS permisivo en la web del motor (lo necesita el correo web nuevo)');
  }
  return aplicados;
}

/**
 * Aplica los ajustes recomendados en el motor indicado (por defecto, el
 * configurado). La puesta en marcha lo usa con el motor que acaba de probar,
 * antes de que quede guardado como el activo, y la herramienta de migración
 * con el motor sin el guardián del mantenimiento.
 */
export async function applyRecommendedEngineSettings(
  mailHostname: string,
  engine: MailEngine = getEngine(),
  opciones: { permissiveCors?: boolean } = {},
): Promise<EngineReloadResult & { applied: string[]; restartRequired: string[]; input: RecommendedInput }> {
  const host = normalizeHostname(mailHostname);
  if (!host) {
    throw badRequest(
      'Indica primero el nombre del servidor de correo (Ajustes → Identidad del servidor).',
      'mail_hostname_missing',
    );
  }
  const input = recommendedInput(host, opciones);
  const result = await engine.applyRecommended(input);
  const api = await engine.detectApi().catch(() => null);
  return {
    ...result,
    restartRequired: result.restartRequired ?? [],
    applied: descripcionAplicados(input, api),
    input,
  };
}

/**
 * Nombre legible de las comprobaciones propias de cada versión del motor
 * (`extra` del estado). Las claves las fija el driver; una desconocida se
 * enseña con un nombre genérico en vez de esconderse.
 */
const ETIQUETAS_COMPROBACIONES: Record<string, string> = {
  submission587: 'Puerto 587 (STARTTLS)',
  maxAppPasswords: 'Límite de contraseñas de aplicación',
  selfServiceBlocked: 'Autoservicio del motor bloqueado',
  defaultDomain: 'Dominio por defecto de la instancia',
  logToStdout: 'Registro del motor en la salida estándar',
  authBanExpiry: 'Caducidad del bloqueo por fallos de acceso',
  permissiveCors: 'CORS del motor para el correo web nuevo',
};

export function etiquetaComprobacion(clave: string): string {
  return ETIQUETAS_COMPROBACIONES[clave] ?? `Comprobación «${clave}»`;
}

/**
 * ¿Están aplicados los ajustes recomendados? Nombre, IP real, redes exentas
 * y las comprobaciones propias de la versión del motor (`extra`).
 */
export function ajustesRecomendadosAplicados(status: EngineSettingsStatus, expectedHostname: string): boolean {
  const esperado = normalizeHostname(expectedHostname);
  return (
    Boolean(esperado) &&
    normalizeHostname(status.hostname ?? '') === esperado &&
    status.forwardedHeaders &&
    trustedEngineNetworks().every((n) => status.trustedNetworks.includes(n)) &&
    Object.values(status.extra).every(Boolean)
  );
}

/* ------------------------------- Estado TLS ------------------------------- */

export interface EngineTlsStatus {
  /** Host al que se conectó (el público, o el interno si el público no respondió). */
  host: string;
  port: number;
  /** Certificado de confianza, del nombre correcto y vigente. */
  ok: boolean;
  issuer: string | null;
  subject: string | null;
  validFrom: string | null;
  validTo: string | null;
  daysLeft: number | null;
  selfSigned: boolean;
  /** El certificado cubre el nombre del servidor de correo. */
  hostnameMatches: boolean | null;
  /** Motivo por el que la cadena no es de confianza (código de OpenSSL). */
  authorizationError: string | null;
  via: 'publico' | 'interno' | null;
  /** Por qué no respondió el nombre público, si se tuvo que ir por dentro. */
  publicError?: string;
  error?: string;
}

function emptyTls(host: string, error: string): EngineTlsStatus {
  return {
    host,
    port: IMAPS_PORT,
    ok: false,
    issuer: null,
    subject: null,
    validFrom: null,
    validTo: null,
    daysLeft: null,
    selfSigned: false,
    hostnameMatches: null,
    authorizationError: null,
    via: null,
    error,
  };
}

function certName(entity: tls.PeerCertificate['issuer'] | undefined): string | null {
  if (!entity) return null;
  const org = (entity as { O?: string | string[] }).O;
  const cn = (entity as { CN?: string | string[] }).CN;
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return pick(org) || pick(cn) || null;
}

const SELF_SIGNED_CODES = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN']);

/**
 * Conecta al puerto 993 y lee el certificado aunque no sea de confianza: el
 * objetivo es diagnosticar (autofirmado, caducado, nombre equivocado), no
 * rechazar la conexión.
 */
function probeTls(host: string, servername: string, via: 'publico' | 'interno'): Promise<EngineTlsStatus> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: EngineTlsStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(status);
    };
    const socket = tls.connect({
      host,
      port: IMAPS_PORT,
      servername,
      rejectUnauthorized: false,
    });
    const timer = setTimeout(
      () => finish(emptyTls(host, `Sin respuesta en ${TLS_TIMEOUT_MS / 1000} s.`)),
      TLS_TIMEOUT_MS,
    );
    socket.once('error', (err: NodeJS.ErrnoException) => {
      finish(emptyTls(host, err.code ? `${err.code}: ${err.message}` : err.message));
    });
    socket.once('secureConnect', () => {
      // Con el detalle se obtiene la cadena: un autofirmado es su propio emisor.
      const cert = socket.getPeerCertificate(true);
      if (!cert || Object.keys(cert).length === 0) {
        finish(emptyTls(host, 'El servidor no presentó ningún certificado.'));
        return;
      }
      const authError = socket.authorizationError ? String(socket.authorizationError) : null;
      const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
      const validFrom = cert.valid_from ? new Date(cert.valid_from) : null;
      const daysLeft =
        validTo && !Number.isNaN(validTo.getTime())
          ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000)
          : null;
      const identity = tls.checkServerIdentity(servername, cert);
      const issuer = certName(cert.issuer);
      const subject = certName(cert.subject);
      const selfSigned =
        (authError !== null && SELF_SIGNED_CODES.has(authError)) ||
        (cert.issuerCertificate !== undefined &&
          cert.issuerCertificate.fingerprint256 === cert.fingerprint256 &&
          !socket.authorized);
      const hostnameMatches = identity === undefined;
      finish({
        host,
        port: IMAPS_PORT,
        ok: socket.authorized && hostnameMatches && daysLeft !== null && daysLeft >= 0,
        issuer,
        subject,
        validFrom: validFrom && !Number.isNaN(validFrom.getTime()) ? validFrom.toISOString() : null,
        validTo: validTo && !Number.isNaN(validTo.getTime()) ? validTo.toISOString() : null,
        daysLeft,
        selfSigned,
        hostnameMatches,
        authorizationError: authError,
        via,
      });
    });
  });
}

/** Host interno del motor a partir de su URL de gestión (http://mailway-mail:8080 → mailway-mail). */
function internalHostOf(settings: EngineSettings | null): string | null {
  if (!settings?.url) return null;
  try {
    return new URL(settings.url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Comprueba el certificado que ven los programas de correo. Primero por el
 * nombre público (lo mismo que hace un móvil); si no responde —desde dentro
 * de Docker a veces no hay «vuelta» a la IP pública—, por la red interna con
 * el mismo SNI, que devuelve el mismo certificado.
 */
export async function probeEngineTls(
  mailHostname: string,
  settings: EngineSettings | null = getEngineSettings(),
): Promise<EngineTlsStatus> {
  const host = normalizeHostname(mailHostname);
  if (!host) return emptyTls('', 'Falta el nombre del servidor de correo.');
  const direct = await probeTls(host, host, 'publico');
  if (!direct.error) return direct;
  const internal = internalHostOf(settings);
  if (!internal || internal === host) return direct;
  const inside = await probeTls(internal, host, 'interno');
  if (inside.error) return direct;
  return { ...inside, publicError: direct.error };
}

/**
 * ¿Recibiría un certificado válido un programa de correo que entrase con otro
 * nombre? Para avisar antes de cambiar el nombre del servidor. Se conecta por
 * dentro (el DNS del nombre nuevo puede no apuntar aún aquí) con ese nombre
 * como SNI: el motor presenta el certificado que tenga para él o, si no
 * tiene ninguno, el que use por defecto. null en `cubre`: no se pudo medir.
 */
export async function certificadoParaNombre(
  nombre: string,
  settings: EngineSettings | null = getEngineSettings(),
): Promise<{ cubre: boolean | null; detalle: string }> {
  if (settings?.kind !== 'stalwart') {
    return { cubre: null, detalle: 'No hay un servidor de correo real cuyo certificado comprobar.' };
  }
  const host = internalHostOf(settings) || normalizeHostname(getInstanceSettings().mailHostname);
  if (!host) return { cubre: null, detalle: 'No se conoce la dirección del servidor de correo.' };
  const estado = await probeTls(host, normalizeHostname(nombre), 'interno');
  if (estado.error) {
    return { cubre: null, detalle: `No se ha podido leer el certificado del servidor de correo (${estado.error}).` };
  }
  return estado.hostnameMatches
    ? { cubre: true, detalle: `El certificado actual (${estado.subject ?? 'sin nombre'}) ya cubre ${nombre}.` }
    : {
        cubre: false,
        detalle: `El certificado actual (${estado.subject ?? 'sin nombre'}) no cubre ${nombre}: los programas de correo rechazarían la conexión hasta emitir uno nuevo.`,
      };
}

/* ------------------------------ Avisos TLS -------------------------------- */

const ALERT_WARNING = 'engine_tls_warning';
const ALERT_CRITICAL = 'engine_tls_critical';

const TLS_REMEDY =
  'En Ajustes → Servidor de correo puedes recargar el certificado actual (y, con Stalwart 0.15, emitir uno de Let’s Encrypt mediante Cloudflare). ' +
  'Si el motor renueva con Cloudflare, comprueba que el token de la cuenta que usa sigue activo en Cloudflare y tiene acceso a la zona del servidor (Conexiones → Cloudflare). ' +
  'Si el certificado lo copia el extractor desde Traefik (perfil tls del compose; siempre con Stalwart 0.16), ' +
  'revisa «docker logs mailway-certs-dumper» o ejecuta «sudo bash deploy/instalar.sh --comprobar».';

/**
 * Traduce el estado del certificado a avisos. Separado de la comprobación
 * para poder probarlo sin red. Un fallo de conexión no abre ni cierra nada:
 * si el motor está caído ya avisa el vigilante del motor, y un aviso de
 * «certificado» sería engañoso.
 */
export function evaluateTlsAlerts(status: EngineTlsStatus, mailHostname: string): void {
  if (status.error) return;
  const host = normalizeHostname(mailHostname);
  const days = status.daysLeft;

  let critical: { title: string; message: string } | null = null;
  if (status.selfSigned) {
    critical = {
      title: 'El servidor de correo usa un certificado autofirmado',
      message: `Los programas de correo (Outlook, iPhone, Thunderbird) muestran un aviso de seguridad al conectar con ${host} por IMAP o SMTP, y algunos se niegan a conectar.`,
    };
  } else if (days !== null && days < 0) {
    critical = {
      title: `El certificado de ${host} ha caducado`,
      message: 'Los programas de correo rechazan la conexión o muestran un aviso de seguridad.',
    };
  } else if (status.hostnameMatches === false) {
    critical = {
      title: `El certificado del servidor de correo no corresponde a ${host}`,
      message: `El motor presenta un certificado para «${status.subject ?? 'otro nombre'}». Los programas de correo muestran un aviso de seguridad.`,
    };
  } else if (status.authorizationError) {
    critical = {
      title: 'El certificado del servidor de correo no es de confianza',
      message: `La cadena del certificado de ${host} no se pudo validar (${status.authorizationError}).`,
    };
  } else if (days !== null && days < TLS_CRITICAL_DAYS) {
    critical = {
      title: `El certificado de ${host} caduca en ${days} ${days === 1 ? 'día' : 'días'}`,
      message: 'La renovación automática no ha funcionado. Al caducar, los programas de correo dejarán de conectar.',
    };
  }

  if (critical) {
    resolveAlert(ALERT_WARNING);
    fireAlert({
      severity: 'critical',
      type: 'engine_tls',
      dedupeKey: ALERT_CRITICAL,
      title: critical.title,
      message: critical.message,
      remedy: TLS_REMEDY,
    });
    return;
  }

  if (days !== null && days < TLS_WARNING_DAYS) {
    resolveAlert(ALERT_CRITICAL);
    fireAlert({
      severity: 'warning',
      type: 'engine_tls',
      dedupeKey: ALERT_WARNING,
      title: `El certificado de ${host} caduca en ${days} días`,
      message:
        'Let’s Encrypt renueva con 30 días de margen: si quedan menos de 20, la renovación no se está aplicando.',
      remedy: TLS_REMEDY,
    });
    return;
  }

  resolveAlert(ALERT_CRITICAL, { notify: true, what: 'certificado del servidor de correo' });
  resolveAlert(ALERT_WARNING, { notify: true, what: 'certificado del servidor de correo' });
}

/**
 * Comprueba el certificado TLS del motor y avisa si caduca. La llama el
 * vigilante a diario. Antes recarga los certificados: si el volcado de
 * Traefik o el ACME del motor dejaron uno nuevo en disco, Stalwart no lo usa
 * hasta que se le pide. Nunca lanza: un fallo aquí no debe parar al vigilante.
 */
export async function checkEngineTls(): Promise<void> {
  try {
    const settings = getEngineSettings();
    if (!settings || settings.kind !== 'stalwart') return;
    const host = normalizeHostname(getInstanceSettings().mailHostname);
    if (!host) return;
    try {
      await getEngine().reloadCertificates();
    } catch {
      // Si el motor no responde ya avisa el vigilante del motor.
    }
    const status = await probeEngineTls(host, settings);
    evaluateTlsAlerts(status, host);
  } catch {
    // Nunca propagar: el vigilante sigue con el resto de comprobaciones.
  }
}

/* ------------------------- Nombre en ejecución ---------------------------- */

/** Tipo de los avisos de nombre: su clave lleva los dos nombres que no coinciden. */
const ALERT_HOSTNAME = 'engine_hostname';

/**
 * Avisa si el motor se anuncia con un nombre distinto del de Ajustes. El
 * nombre en ejecución es con el que el motor genera los registros de los
 * dominios (MX, SRV, autoconfiguración); si no es el de Ajustes, la ficha de
 * cada dominio pide un MX distinto del nombre que figura en los datos de
 * conexión de los titulares, y ese nombre no tiene por qué tener PTR ni
 * certificado.
 *
 * Sin nombre en Ajustes no hay con qué comparar y el aviso se cierra; sin
 * lectura del motor (null) no se abre ni se cierra nada: si el motor está
 * caído ya avisa el vigilante del motor. Lo que mande es siempre lo guardado
 * en Ajustes: aquí solo se avisa, no se cambia ningún nombre.
 */
export function evaluateHostnameAlert(expected: string, running: string | null): void {
  const esperado = normalizeHostname(expected);
  if (!esperado) {
    resolveAlertsOfType(ALERT_HOSTNAME);
    return;
  }
  if (running === null) return;
  const actual = normalizeHostname(running);
  if (actual === esperado) {
    resolveAlertsOfType(ALERT_HOSTNAME, { notify: true, what: 'nombre del servidor de correo' });
    return;
  }
  const clave = `${ALERT_HOSTNAME}:${actual}>${esperado}`;
  // Un aviso de otra pareja de nombres ya no describe la situación.
  resolveAlertsOfType(ALERT_HOSTNAME, { except: clave });
  // Aplicar el nombre nuevo cambia el MX que se exige a TODOS los dominios:
  // se dice cuántos antes de que alguien pulse el botón.
  const dominios = (db.prepare('SELECT COUNT(*) AS c FROM domains').get() as { c: number }).c;
  const consecuencia =
    dominios === 0
      ? ''
      : ` Al aplicar ${esperado} en el motor, ${
          dominios === 1 ? 'el dominio de correo pasará' : `los ${dominios} dominios de correo pasarán`
        } a exigir el MX hacia ${esperado} y ${dominios === 1 ? 'figurará' : 'figurarán'} como pendiente${
          dominios === 1 ? '' : 's'
        } de DNS hasta que se cambie; el nombre ${esperado} necesita además su registro A, el PTR de la IP y un certificado que lo cubra.`;
  // Si el motor se anuncia con el nombre que trae el entorno, lo más probable
  // es que el instalador haya cambiado el dominio de la plataforma y Ajustes
  // conserve el anterior: aplicar los ajustes recomendados devolvería el
  // motor al nombre viejo, así que lo primero que se propone es corregir
  // Ajustes, y el botón queda para el caso contrario.
  const delInstalador = normalizeHostname(config.mailHostnameDefault);
  const primerPaso =
    delInstalador && delInstalador === actual
      ? `${actual} es el nombre que fijó el instalador (MAILWAY_MAIL_HOSTNAME del entorno del panel): si se ha cambiado con él el dominio de la plataforma, corrige el nombre en Ajustes → Identidad del servidor y no apliques los ajustes recomendados, que devolverían el motor a ${esperado}. ` +
        `Si el correcto es ${esperado}, pulsa «Aplicar ajustes recomendados» en Ajustes → Servidor de correo y vuelve a ejecutar el instalador con ese nombre (sección 8.3 de docs/DESPLIEGUE-SKYWAY.md), que es el que usan Traefik y el certificado. `
      : `Si el nombre correcto es ${esperado}, en Ajustes → Servidor de correo pulsa «Aplicar ajustes recomendados» (antes muestra lo que cambia).${
          // El identificador del contenedor nunca es el nombre correcto.
          isInternalHost(actual) ? '' : ` Si el correcto es ${actual}, corrígelo en Ajustes → Identidad del servidor.`
        } `;
  fireAlert({
    severity: 'warning',
    type: ALERT_HOSTNAME,
    dedupeKey: clave,
    title: `El servidor de correo se anuncia como ${actual}, no como ${esperado}`,
    message:
      `El motor genera los registros DNS de los dominios (MX, SRV y autoconfiguración) con el nombre ${actual}, pero en Ajustes figura ${esperado}. ` +
      `La comprobación de cada dominio pide esos registros: el MX apuntaría a un nombre distinto del que usan los titulares en sus datos de conexión.${consecuencia}`,
    remedy:
      primerPaso +
      'Si el motor ya tiene guardado el nombre correcto y sigue anunciándose con otro, ' +
      'lo fija su configuración local (config.toml o las variables del contenedor): corrígela y reinicia el motor. ' +
      'Los dominios se vuelven a medir con la frecuencia habitual del vigilante; para hacerlo ya, pulsa «Medir el DNS ahora» en su ficha.',
  });
}

/**
 * Compara el nombre en ejecución con el de Ajustes y abre o cierra el aviso.
 * La llama el vigilante. Si el nombre cambia, no se toca el estado DNS de los
 * dominios: el vigilante los vuelve a medir con su ritmo normal y cada
 * medición (refreshDomainDns) lee de nuevo los registros del motor. Borrar
 * las mediciones haría pasar por pendientes dominios que siguen recibiendo
 * correo. Nunca lanza.
 */
export async function checkEngineHostname(): Promise<void> {
  try {
    if (!engineConfigured()) return;
    let running: string | null;
    try {
      running = await getEngine().getRunningHostname();
    } catch {
      return; // Motor sin respuesta: ya lo cubre el aviso del motor caído.
    }
    evaluateHostnameAlert(getInstanceSettings().mailHostname, running);
  } catch {
    // Nunca propagar: el vigilante sigue con el resto de comprobaciones.
  }
}

/* ------------------------------ Cloudflare -------------------------------- */

interface CloudflareAccountRow {
  id: string;
  client_id: string | null;
  label: string;
  token_enc: string;
}

interface CloudflareZone {
  id: string;
  name: string;
  status: string;
}

/**
 * Busca la zona que contiene el nombre, del más largo al más corto
 * (mail.a.ejemplo.es → a.ejemplo.es → ejemplo.es). Una zona que el token no
 * ve llega como lista vacía, no como error.
 */
async function findCloudflareZone(token: string, hostname: string): Promise<CloudflareZone | null> {
  const labels = hostname.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    let res: Response;
    try {
      res = await fetch(`${CLOUDFLARE_API}/zones?name=${encodeURIComponent(candidate)}&per_page=5`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw upstream(`No se pudo contactar con Cloudflare: ${(err as Error).message}`, 'cloudflare_unreachable');
    }
    const body = (await res.json().catch(() => null)) as {
      success?: boolean;
      errors?: { code?: number; message?: string }[];
      result?: CloudflareZone[];
    } | null;
    if (!res.ok || !body?.success) {
      const first = body?.errors?.[0];
      const detail = first ? `${first.message ?? ''} (código ${first.code ?? '?'})` : `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403 || first?.code === 1000 || first?.code === 10000) {
        throw badRequest(
          `Cloudflare rechazó el token de esta cuenta: ${detail}. Revisa la cuenta en Conexiones → Cloudflare.`,
          'cloudflare_token_rejected',
        );
      }
      throw upstream(`Cloudflare respondió con un error: ${detail}`, 'cloudflare_error');
    }
    const zone = body.result?.[0];
    if (zone) return { id: zone.id, name: zone.name, status: zone.status };
  }
  return null;
}

/* ------------------------------ Estado ACME ------------------------------- */

interface StoredAcme {
  accountId: string;
  accountLabel: string;
  contact: string;
  zone: string;
  configuredAt: number;
}

/* ---------------------- Cuenta de Cloudflare del ACME ---------------------- */

/**
 * Cuenta de Cloudflare de la instancia cuyo token usa el ACME del motor para
 * renovar su certificado (solo Stalwart 0.15): la que se guardó al emitirlo
 * desde Ajustes o, si lo configuró el instalador (que copia el token en el
 * motor sin pasar por aquí), la que tiene ese mismo token. El token solo se
 * compara aquí dentro; nunca sale en una respuesta. null = no se sabe (motor
 * sin respuesta); undefined = ninguna.
 */
export async function cuentaAcmeDelMotor(): Promise<{ id: string; label: string } | null | undefined> {
  if (!engineConfigured()) return undefined;
  let secreto: string | null;
  try {
    secreto = await getEngine().getAcmeToken();
  } catch {
    return null;
  }
  const stored = getJsonSetting<StoredAcme>('engine_acme');
  if (!secreto && !stored) return undefined;
  const filas = db
    .prepare('SELECT id, client_id, label, token_enc FROM cloudflare_accounts WHERE client_id IS NULL')
    .all() as CloudflareAccountRow[];
  for (const fila of filas) {
    let token = '';
    try {
      token = decryptSecret(fila.token_enc);
    } catch {
      continue;
    }
    if (secreto ? token === secreto : stored?.accountId === fila.id) return { id: fila.id, label: fila.label };
  }
  return undefined;
}

/* -------------------------------- Rutas ----------------------------------- */

const acmeSchema = z.object({
  cloudflareAccountId: z.string().trim().min(1, 'Elige la cuenta de Cloudflare.'),
  email: z.string().trim().email('Indica un correo de contacto válido para Let’s Encrypt.'),
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerEngineOpsRoutes(app: FastifyInstance): void {
  /**
   * Estado del servidor de correo para Ajustes y el final de la puesta en
   * marcha. No falla si el motor no responde: devuelve lo que se pudo medir
   * y el motivo de lo que no.
   */
  app.get('/api/engine/status', async (req) => {
    requireAdmin(req);
    const instance = getInstanceSettings();
    const expected = normalizeHostname(instance.mailHostname);
    const settings = getEngineSettings();
    const kind = settings?.kind ?? null;
    const networks = trustedEngineNetworks();

    let status: EngineSettingsStatus | null = null;
    let engineError: string | null = null;
    // Lo guardado (el nombre del servidor) y lo que el motor usa de verdad
    // pueden no coincidir: se leen las dos cosas, en paralelo.
    let running: string | null = null;
    let runningError: string | null = null;
    let api: EngineApi | null = null;
    if (!settings) {
      engineError = 'El motor de correo aún no está configurado.';
    } else {
      const engine = getEngine();
      const [leido, enEjecucion] = await Promise.allSettled([
        engine.getSettingsStatus({ trustedNetworks: networks, permissiveCors: corsPermisivoNecesario() }),
        engine.getRunningHostname(),
      ]);
      if (leido.status === 'fulfilled') status = leido.value;
      else engineError = errorMessage(leido.reason);
      if (enEjecucion.status === 'fulfilled') running = enEjecucion.value;
      else runningError = errorMessage(enEjecucion.reason);
      // Sin estado se intenta saber al menos qué versión hay detrás.
      api = status?.api ?? (await apiDelMotor());
    }

    const configured = status?.hostname ? normalizeHostname(status.hostname) || null : null;
    const extra = status?.extra ?? {};
    const recommendedApplied = !engineError && status !== null && ajustesRecomendadosAplicados(status, expected);

    const stored = getJsonSetting<StoredAcme>('engine_acme');
    // El instalador configura el ACME sin pasar por aquí: la cuenta se
    // reconoce por su token para que Ajustes diga cuál es.
    const delMotor =
      !stored && status?.acme?.provider === 'cloudflare' ? await cuentaAcmeDelMotor() : undefined;
    const acme = status?.acme
      ? {
          configured: true,
          provider: status.acme.provider,
          challenge: status.acme.challenge,
          contact: status.acme.contact,
          domain: status.acme.domain,
          zone: status.acme.zone,
          accountId: stored?.accountId ?? delMotor?.id ?? null,
          accountLabel: stored?.accountLabel ?? delMotor?.label ?? null,
        }
      : { configured: false, provider: null };
    const mantenimiento = estadoMantenimiento();

    let tlsStatus: EngineTlsStatus;
    if (kind !== 'stalwart') {
      tlsStatus = emptyTls(
        expected,
        kind === 'demo'
          ? 'Modo demostración: no hay servidor de correo real que comprobar.'
          : 'El motor de correo aún no está configurado.',
      );
    } else if (!expected) {
      tlsStatus = emptyTls('', 'Falta el nombre del servidor de correo (Ajustes → Identidad del servidor).');
    } else {
      tlsStatus = await probeEngineTls(expected, settings);
    }

    return {
      engine: { kind, error: engineError },
      // API de gestión detectada: rest015 (Stalwart 0.15), jmap016 (0.16) o demo.
      api,
      hostname: {
        configured,
        expected: expected || null,
        ok: Boolean(expected) && configured === expected,
        // El nombre con el que el motor se anuncia: el destino del MX que genera.
        running,
        runningOk: running && expected ? running === expected : null,
        runningError: engineError ? null : runningError,
      },
      trustedNetworks: networks,
      forwardedHeaders: status?.forwardedHeaders ?? false,
      recommendedApplied,
      // Comprobaciones propias de la versión del motor (en 0.16: puerto 587,
      // límite de contraseñas de aplicación, autoservicio bloqueado…), con su
      // nombre para enseñarlas.
      extra,
      extraChecks: Object.entries(extra).map(([key, ok]) => ({ key, label: etiquetaComprobacion(key), ok })),
      // Cambios guardados que solo se aplican al reiniciar el contenedor del motor.
      restartRequired: status?.restartRequired ?? [],
      tls: tlsStatus,
      acme,
      // En 0.16 el certificado lo pone el extractor de Traefik: no hay ACME del motor.
      acmeSupported: api !== 'jmap016',
      certificateFiles: status?.certificateFiles ?? false,
      maintenance: { active: mantenimiento.activo, until: mantenimiento.hasta },
    };
  });

  /** Nombre del servidor, confianza en el proxy, rango exento de baneo y lo propio de la versión. */
  app.post('/api/engine/recommended', async (req) => {
    requireAdmin(req);
    const host = normalizeHostname(getInstanceSettings().mailHostname);
    const result = await applyRecommendedEngineSettings(host);
    // Tras la recarga, el nombre en ejecución dice si el cambio se ha aplicado
    // de verdad (la configuración local del motor puede fijar otro) y cierra
    // el aviso del vigilante sin esperar a su siguiente vuelta.
    const running = await getEngine()
      .getRunningHostname()
      .catch(() => null);
    evaluateHostnameAlert(host, running);
    audit(req, 'engine.recommended_applied', {
      hostname: host,
      trustedNetworks: trustedEngineNetworks(),
      maxAppPasswords: MAX_CONTRASENAS_APLICACION_MOTOR,
      permissiveCors: result.input.permissiveCors,
      errors: result.errors.length,
      restartRequired: result.restartRequired.length,
    });
    return {
      applied: result.applied,
      hostname: host,
      running,
      errors: result.errors,
      warnings: result.warnings,
      restartRequired: result.restartRequired,
    };
  });

  /**
   * Emisión automática del certificado con el ACME del propio motor, reto
   * DNS-01 en Cloudflare: no depende de Traefik ni del puerto 80, renueva sola
   * y sirve también para IMAP y SMTP. Solo Stalwart 0.15: en 0.16 el ACME del
   * motor exigiría darle la gestión del DNS de un dominio, y el certificado
   * lo pone el extractor de Traefik.
   */
  app.post('/api/engine/acme', async (req) => {
    requireAdmin(req);
    // El reto DNS-01 usa el token de una cuenta de la instancia: nunca en
    // nombre de un cliente, aunque el token de gestión sea de administración.
    rechazarSoloCliente(req.query);
    const body = acmeSchema.parse(req.body);
    // Antes de tocar Cloudflare: en mantenimiento, o con 0.16, no se va a poder.
    exigirSinMantenimiento();
    const engine = getEngine();
    if ((await engine.detectApi()) === 'jmap016') {
      throw motorNoAdmite(
        'Con Stalwart 0.16 el certificado del servidor de correo lo obtiene Traefik y el extractor lo copia al motor: el motor ya no emite certificados por sí mismo. Si el certificado falla, revisa el extractor («docker logs mailway-certs-dumper»).',
      );
    }
    const host = normalizeHostname(getInstanceSettings().mailHostname);
    if (!host) {
      throw badRequest(
        'Indica primero el nombre del servidor de correo (Ajustes → Identidad del servidor).',
        'mail_hostname_missing',
      );
    }
    const row = db
      .prepare('SELECT id, client_id, label, token_enc FROM cloudflare_accounts WHERE id = ?')
      .get(body.cloudflareAccountId) as CloudflareAccountRow | undefined;
    if (!row) throw notFound('La cuenta de Cloudflare no existe.', 'cloudflare_account_not_found');
    if (row.client_id) {
      // El certificado es de la plataforma: usar el token de un cliente
      // mezclaría la infraestructura de la instancia con la de un cliente.
      throw badRequest(
        'Esa cuenta de Cloudflare pertenece a un cliente. Usa una cuenta de la instancia (Conexiones → Cloudflare).',
        'cloudflare_account_not_instance',
      );
    }

    let token: string;
    try {
      token = decryptSecret(row.token_enc);
    } catch {
      throw badRequest(
        'No se pudo leer el token guardado de esa cuenta. Vuelve a conectarla en Conexiones → Cloudflare.',
        'cloudflare_token_unreadable',
      );
    }

    const zone = await findCloudflareZone(token, host);
    if (!zone) {
      throw badRequest(
        `El token de la cuenta «${row.label}» no tiene acceso a la zona DNS de ${host}. ` +
          'Añade esa zona a los permisos del token (Zona: Lectura y DNS: Edición) o conecta otra cuenta.',
        'cloudflare_zone_not_found',
      );
    }

    let result: EngineReloadResult;
    try {
      // La zona explícita evita que el motor la deduzca por la lista de
      // sufijos públicos, que falla con zonas delegadas en un subdominio.
      result = await engine.configureAcme({
        directory: LETS_ENCRYPT_DIRECTORY,
        token,
        contact: body.email,
        hostname: host,
        zone: zone.name,
      });
    } catch (err) {
      // El mensaje del motor nunca incluye el token, pero se asegura igual.
      if (err instanceof HttpError) throw new HttpError(err.status, err.message.split(token).join('•••'), err.code);
      throw err;
    }

    setJsonSetting('engine_acme', {
      accountId: row.id,
      accountLabel: row.label,
      contact: body.email,
      zone: zone.name,
      configuredAt: Date.now(),
    } satisfies StoredAcme);
    audit(req, 'engine.acme_configured', {
      hostname: host,
      cloudflareAccountId: row.id,
      zone: zone.name,
      contact: body.email,
    });
    return {
      acme: {
        configured: true,
        provider: 'cloudflare',
        challenge: 'dns-01',
        contact: body.email,
        domain: host,
        zone: zone.name,
        zoneStatus: zone.status,
        accountId: row.id,
        accountLabel: row.label,
      },
      errors: result.errors.map((e) => e.split(token).join('•••')),
      warnings: result.warnings.map((w) => w.split(token).join('•••')),
    };
  });

  /**
   * ¿Usa el motor el token de esta cuenta de Cloudflare para renovar su
   * certificado? Lo pregunta el diálogo de eliminar la cuenta: revocar ese
   * token haría fallar la siguiente renovación. inUse null = no se sabe.
   */
  app.get('/api/engine/acme/accounts/:id', async (req) => {
    requireAdmin(req);
    rechazarSoloCliente(req.query);
    const { id } = req.params as { id: string };
    const fila = db.prepare('SELECT id, client_id FROM cloudflare_accounts WHERE id = ?').get(id) as
      | { id: string; client_id: string | null }
      | undefined;
    if (!fila) throw notFound('Cuenta de Cloudflare no encontrada.', 'cloudflare_account_not_found');
    // El ACME del motor solo usa cuentas de la instancia.
    if (fila.client_id !== null) return { inUse: false };
    const cuenta = await cuentaAcmeDelMotor();
    return { inUse: cuenta === null ? null : cuenta?.id === id };
  });

  /** Recarga los certificados del motor (tras una renovación) y devuelve el estado nuevo. */
  app.post('/api/engine/reload-certificate', async (req) => {
    requireAdmin(req);
    const settings = getEngineSettings();
    if (!settings) {
      throw badRequest('El motor de correo aún no está configurado.', 'engine_not_configured');
    }
    await getEngine().reloadCertificates();
    audit(req, 'engine.certificate_reloaded', {});
    const host = normalizeHostname(getInstanceSettings().mailHostname);
    const tlsStatus =
      settings.kind === 'stalwart' && host
        ? await probeEngineTls(host, settings)
        : emptyTls(host, 'Modo demostración: no hay servidor de correo real que comprobar.');
    if (settings.kind === 'stalwart' && host) evaluateTlsAlerts(tlsStatus, host);
    return { ok: true, tls: tlsStatus };
  });
}
