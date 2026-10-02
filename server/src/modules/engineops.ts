import tls from 'node:tls';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../core/db';
import { decryptSecret } from '../core/crypto';
import { badRequest, HttpError, notFound, upstream } from '../core/errors';
import { normalizeHostname } from '../core/hostnames';
import { engineConfigured, getEngine } from '../engine';
import type { EngineReloadResult, EngineSettings, MailEngine } from '../engine/types';
import { fireAlert, resolveAlert, resolveAlertsOfType } from './alerts';
import { audit } from './audit';
import { requireAdmin } from './auth';
import { getEngineSettings, getInstanceSettings, getJsonSetting, setJsonSetting } from './settings';

/**
 * Operaciones sobre el servidor de correo: ajustes recomendados del motor
 * (nombre del servidor, confianza en el proxy, rango exento de baneo),
 * estado y emisión del certificado TLS.
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

/** Identificador del proveedor ACME que crea Mailway en el motor. */
const ACME_ID = 'mailway';
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

/** Ajustes que el motor necesita para funcionar bien detrás de Traefik. */
export function recommendedEngineSettings(mailHostname: string): Record<string, string> {
  const values: Record<string, string> = {
    'server.hostname': mailHostname,
    // Con esto Stalwart toma la IP real del visitante de X-Forwarded-For:
    // sin él, un escáner que pide /wp-login.php a través de Traefik banea la
    // IP de Traefik y deja fuera de servicio la web del motor para todos.
    'http.use-x-forwarded': 'true',
  };
  for (const network of trustedEngineNetworks()) values[`server.allowed-ip.${network}`] = '';
  return values;
}

/**
 * Aplica los ajustes recomendados en el motor indicado (por defecto, el
 * configurado). La puesta en marcha lo usa con el motor que acaba de probar,
 * antes de que quede guardado como el activo.
 */
export async function applyRecommendedEngineSettings(
  mailHostname: string,
  engine: MailEngine = getEngine(),
): Promise<EngineReloadResult & { values: Record<string, string> }> {
  const host = normalizeHostname(mailHostname);
  if (!host) {
    throw badRequest(
      'Indica primero el nombre del servidor de correo (Ajustes → Identidad del servidor).',
      'mail_hostname_missing',
    );
  }
  const values = recommendedEngineSettings(host);
  const result = await engine.applyServerSettings(values);
  return { ...result, values };
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

/* ------------------------------ Avisos TLS -------------------------------- */

const ALERT_WARNING = 'engine_tls_warning';
const ALERT_CRITICAL = 'engine_tls_critical';

const TLS_REMEDY =
  'En Ajustes → Servidor de correo puedes emitir un certificado de Let’s Encrypt mediante Cloudflare ' +
  'o recargar el certificado actual. Si el certificado lo copia el extractor desde Traefik (perfil tls ' +
  'del compose), revisa «docker logs mailway-certs-dumper» o ejecuta «sudo bash deploy/instalar.sh --comprobar».';

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
  fireAlert({
    severity: 'warning',
    type: ALERT_HOSTNAME,
    dedupeKey: clave,
    title: `El servidor de correo se anuncia como ${actual}, no como ${esperado}`,
    message:
      `El motor genera los registros DNS de los dominios (MX, SRV y autoconfiguración) con el nombre ${actual}, pero en Ajustes figura ${esperado}. ` +
      'La comprobación de cada dominio pide esos registros: el MX apuntaría a un nombre distinto del que usan los titulares en sus datos de conexión.',
    remedy:
      'En Ajustes → Servidor de correo, pulsa «Aplicar ajustes recomendados». Si el motor ya tiene guardado el nombre correcto y sigue anunciándose con otro, ' +
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

const ACME_KEYS = ['directory', 'challenge', 'provider', 'contact.0', 'domains.0', 'origin'].map(
  (k) => `acme.${ACME_ID}.${k}`,
);
/** Certificado por fichero (volcado de Traefik): se configura con uno de estos dos identificadores. */
const CERT_FILE_KEYS = ['certificate.mailway.cert', 'certificate.default.cert'];

function statusKeys(): string[] {
  const networks = trustedEngineNetworks().map((n) => `server.allowed-ip.${n}`);
  return ['server.hostname', 'http.use-x-forwarded', ...networks, ...ACME_KEYS, ...CERT_FILE_KEYS];
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

    let values: Record<string, string> = {};
    let engineError: string | null = null;
    // Lo guardado (server.hostname) y lo que el motor usa de verdad pueden no
    // coincidir: se leen las dos cosas, en paralelo.
    let running: string | null = null;
    let runningError: string | null = null;
    if (!settings) {
      engineError = 'El motor de correo aún no está configurado.';
    } else {
      const engine = getEngine();
      const [leidos, enEjecucion] = await Promise.allSettled([
        engine.getServerSettings(statusKeys()),
        engine.getRunningHostname(),
      ]);
      if (leidos.status === 'fulfilled') values = leidos.value;
      else engineError = errorMessage(leidos.reason);
      if (enEjecucion.status === 'fulfilled') running = enEjecucion.value;
      else runningError = errorMessage(enEjecucion.reason);
    }

    const configured = values['server.hostname'] ? normalizeHostname(values['server.hostname']) : null;
    const networks = trustedEngineNetworks();
    const recommendedApplied =
      !engineError &&
      Boolean(expected) &&
      configured === expected &&
      values['http.use-x-forwarded'] === 'true' &&
      networks.every((n) => values[`server.allowed-ip.${n}`] !== undefined);

    const acmeProvider = values[`acme.${ACME_ID}.provider`];
    const stored = getJsonSetting<StoredAcme>('engine_acme');
    const acme = values[`acme.${ACME_ID}.directory`]
      ? {
          configured: true,
          provider: acmeProvider || null,
          challenge: values[`acme.${ACME_ID}.challenge`] || null,
          contact: values[`acme.${ACME_ID}.contact.0`] || null,
          domain: values[`acme.${ACME_ID}.domains.0`] || null,
          zone: values[`acme.${ACME_ID}.origin`] || null,
          accountId: stored?.accountId ?? null,
          accountLabel: stored?.accountLabel ?? null,
        }
      : { configured: false, provider: null };

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
      forwardedHeaders: values['http.use-x-forwarded'] === 'true',
      recommendedApplied,
      tls: tlsStatus,
      acme,
      certificateFiles: CERT_FILE_KEYS.some((k) => Boolean(values[k])),
    };
  });

  /** Nombre del servidor, confianza en el proxy y rango exento de baneo. */
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
      errors: result.errors.length,
    });
    return {
      applied: Object.keys(result.values),
      hostname: host,
      running,
      errors: result.errors,
      warnings: result.warnings,
    };
  });

  /**
   * Emisión automática del certificado con el ACME del propio motor, reto
   * DNS-01 en Cloudflare. Es la vía preferida: no depende de Traefik ni del
   * puerto 80, renueva sola y sirve también para IMAP y SMTP.
   */
  app.post('/api/engine/acme', async (req) => {
    requireAdmin(req);
    const body = acmeSchema.parse(req.body);
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

    const prefix = `acme.${ACME_ID}`;
    const values: Record<string, string> = {
      [`${prefix}.directory`]: LETS_ENCRYPT_DIRECTORY,
      [`${prefix}.challenge`]: 'dns-01',
      [`${prefix}.provider`]: 'cloudflare',
      [`${prefix}.secret`]: token,
      [`${prefix}.contact.0`]: body.email,
      [`${prefix}.domains.0`]: host,
      // La zona explícita evita que el motor la deduzca por la lista de
      // sufijos públicos, que falla con zonas delegadas en un subdominio.
      [`${prefix}.origin`]: zone.name,
      [`${prefix}.renew-before`]: '30d',
      // Por defecto también cuando el cliente no envía SNI (algunos móviles).
      [`${prefix}.default`]: 'true',
    };

    let result: EngineReloadResult;
    try {
      result = await getEngine().applyServerSettings(values);
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
