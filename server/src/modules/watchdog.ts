import { config } from '../config';
import { db, now } from '../core/db';
import { checkDnsbl } from '../core/dns';
import { comprobarPuerto25, type ResultadoPuerto25 } from '../core/puerto25';
import { engineConfigured, getEngine } from '../engine';
import type { QueueSummary } from '../engine/types';
import { alertaAbierta, fireAlert, resolveAlert, resolveAlertsOfType } from './alerts';
import { conciliarUsuariosEnCambio } from './direcciones';
import { vigilarCambiosDeDominio } from './domainmigrations';
import { refreshAutoconfigHosts } from './autoconfig';
import { vigilarCorreoWebNuevo } from './correoweb';
import { capturarSiProcede } from './credenciales';
import { listDomains, refreshDomainDns, type DomainRecord } from './domains';
import { checkEngineHostname, checkEngineTls } from './engineops';
import { revisarIpPublica } from './ipservidor';
import { mantenimientoActivo } from './mantenimiento';
import { sincronizarRecepcionExterna } from './recepcion';
import { getEngineSettings, getInstanceSettings } from './settings';
import { getSetting, setSetting } from './settings';
import { repararSuspensiones } from './suspensiones';
import { tokensConCaducidadCercana } from './tokens';
import {
  asegurarWebmailDeDominio,
  listClientDomains,
  refreshClientDomain,
  reintentarWebmailPendiente,
  webmailAutomaticoGlobal,
  type ClientDomain,
} from './whitelabel';

/**
 * Vigilante de fondo: comprueba periódicamente que todo sigue en pie y abre
 * alertas (con aviso por Discord/Telegram/webhook) cuando algo se rompe.
 *
 * Las comprobaciones caras no se hacen en cada vuelta: las listas negras y el
 * certificado del motor se consultan una vez al día, y el DNS de los dominios
 * con una frecuencia que depende de si se espera un cambio, para no castigar
 * a los resolutores ni a los servicios externos.
 *
 * Durante el mantenimiento del motor (su cambio de versión) no se hace nada
 * que dependa de él ni del webmail: se paran a propósito, y avisar de «motor
 * caído» o medir el DNS contra un motor a medio migrar solo daría sustos.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Marca de tiempo de la última ejecución de una comprobación lenta. */
function lastRun(key: string): number {
  return Number(getSetting(`watchdog_last_${key}`) || 0);
}

function markRun(key: string): void {
  setSetting(`watchdog_last_${key}`, String(now()));
}

function due(key: string, everyMs: number): boolean {
  return now() - lastRun(key) >= everyMs;
}

/* ------------------------------ El motor ---------------------------------- */

async function checkEngine(): Promise<void> {
  if (!engineConfigured()) return;
  let ok = false;
  let detail = '';
  try {
    const health = await getEngine().ping();
    ok = health.ok;
    detail = health.detail || '';
  } catch (err) {
    ok = false;
    detail = (err as Error).message;
  }

  if (ok) {
    resolveAlert('engine_down', { notify: true, what: 'servidor de correo caído' });
    return;
  }
  fireAlert({
    severity: 'critical',
    type: 'engine_down',
    dedupeKey: 'engine_down',
    title: 'El servidor de correo no responde',
    message: `Mailway no consigue comunicarse con el motor de correo. ${detail}`.trim(),
    remedy:
      'Accede al servidor por SSH y ejecuta: docker ps (comprueba que «mailway-mail» está en marcha) y docker logs mailway-mail. Mientras esté detenido no se entrega ni se envía correo.',
  });
}

/* --------------------------- La cola de salida ---------------------------- */

const QUEUE_ALERT_THRESHOLD = 50;

/**
 * Antigüedad del mensaje más viejo de la cola a partir de la que se avisa
 * aunque sean pocos: un servidor pequeño con el puerto 25 bloqueado nunca
 * llega a 50 mensajes, y sus primeros envíos se quedaban días en la cola sin
 * ningún aviso. Una hora deja margen a los reintentos normales (listas
 * grises, un destino con una caída breve).
 */
export const QUEUE_AGE_THRESHOLD_S = 3600;

/** Aviso por volumen: 50 mensajes o más en la cola. */
const ALERTA_COLA = 'queue_backed_up';
/**
 * Aviso por antigüedad, con su propio tipo y su propia clave: si compartiera
 * la del volumen, un solo mensaje diferido lo dejaba abierto y, como un aviso
 * abierto no se vuelve a emitir, una acumulación posterior de cientos de
 * mensajes ya no avisaba a nadie.
 */
const ALERTA_COLA_ANTIGUA = 'queue_stale';

/** Solo Stalwart sale a Internet: en demostración no hay nada que medir. */
function motorReal(): boolean {
  return engineConfigured() && getEngineSettings()?.kind === 'stalwart';
}

/**
 * Abre o cierra los avisos de la cola según su estado. El del volumen dice si
 * el puerto 25 está bloqueado, que es la causa más habitual y la única que se
 * arregla en el proveedor del servidor.
 *
 * El de la antigüedad solo se abre si el puerto 25 no está comprobado como
 * abierto. Con el puerto abierto, un mensaje que lleva horas reintentándose
 * es un destino caído o que aplaza los envíos (buzón lleno, lista gris): en
 * un servidor con tráfico casi siempre hay alguno, el motor lo reintenta
 * durante días y avisa al remitente, y el aviso se quedaría abierto para
 * siempre sin que la administración pueda hacer nada.
 */
export function evaluarCola(summary: QueueSummary, puerto25: ResultadoPuerto25 | null): void {
  const porVolumen = summary.pending >= QUEUE_ALERT_THRESHOLD;
  const bloqueado = puerto25?.estado === 'bloqueado';

  if (!porVolumen) {
    resolveAlert(ALERTA_COLA, { notify: true, what: 'cola de salida retenida' });
  } else {
    fireAlert({
      severity: 'warning',
      type: ALERTA_COLA,
      dedupeKey: ALERTA_COLA,
      title: `Hay ${summary.pending} mensajes retenidos en la cola de salida`,
      message: bloqueado
        ? 'El puerto 25 de salida está bloqueado: el servidor no puede entregar correo a otros servidores y los mensajes se acumulan en la cola.'
        : `Los mensajes se están acumulando sin poder entregarse. ${
            puerto25?.estado === 'abierto'
              ? 'El puerto 25 de salida está abierto, así que lo más probable es que un destino esté rechazando o aplazando los envíos.'
              : 'Suele indicar que el puerto 25 de salida está bloqueado o que un destino está rechazando los envíos.'
          }`,
      remedy: bloqueado
        ? 'Solicita al proveedor del servidor la apertura del puerto 25 de salida (OVH, Hetzner y AWS, entre otros, lo bloquean por defecto). Los mensajes retenidos se envían solos en los siguientes reintentos.'
        : 'Revisa la salud del servidor en Entregabilidad: si la IP está en una lista negra o falta el PTR, esa es la causa más probable.',
    });
  }

  const antigua = summary.oldestSeconds !== null && summary.oldestSeconds >= QUEUE_AGE_THRESHOLD_S;
  if (!antigua || puerto25?.estado === 'abierto') {
    resolveAlertsOfType(ALERTA_COLA_ANTIGUA, { notify: true, what: 'correo retenido en la cola de salida' });
    return;
  }
  // Con 50 mensajes o más ya avisa el del volumen: no se abre un segundo
  // aviso por lo mismo (uno abierto de antes se conserva hasta que se vacíe).
  if (porVolumen) return;
  const causa = puerto25?.estado ?? 'sin-medir';
  // La clave lleva la causa: si cambia (el DNS vuelve y el puerto resulta
  // bloqueado), el texto del aviso abierto ya no la describe.
  const clave = `${ALERTA_COLA_ANTIGUA}:${causa}`;
  resolveAlertsOfType(ALERTA_COLA_ANTIGUA, { except: clave });
  fireAlert({
    severity: 'warning',
    type: ALERTA_COLA_ANTIGUA,
    dedupeKey: clave,
    title: 'Hay correo retenido en la cola de salida desde hace más de una hora',
    message:
      causa === 'bloqueado'
        ? 'El puerto 25 de salida está bloqueado: el servidor no puede entregar correo a otros servidores y los mensajes se quedan en la cola hasta que caducan.'
        : causa === 'desconocido'
          ? `${puerto25!.detalle} Sin resolver nombres, el servidor tampoco puede encontrar los servidores de destino y los mensajes se quedan en la cola.`
          : 'Algún mensaje lleva más de una hora sin poder entregarse. Suele indicar que el puerto 25 de salida está bloqueado o que un destino está rechazando los envíos. El motor sigue reintentándolo y, si no lo consigue, devuelve el mensaje al remitente.',
    remedy:
      causa === 'bloqueado'
        ? 'Solicita al proveedor del servidor la apertura del puerto 25 de salida (OVH, Hetzner y AWS, entre otros, lo bloquean por defecto). Los mensajes retenidos se envían solos en los siguientes reintentos.'
        : causa === 'desconocido'
          ? 'Comprueba en el servidor que el DNS responde (por ejemplo, con getent hosts gmail-smtp-in.l.google.com) y revisa la configuración de resolutores del sistema y de Docker.'
          : 'Revisa la salud del servidor en Entregabilidad: el puerto 25 de salida, el PTR y las listas negras.',
  });
}

async function checkQueue(): Promise<void> {
  if (!engineConfigured()) return;
  let summary: QueueSummary;
  try {
    summary = await getEngine().getQueueSummary();
  } catch {
    // Si el motor no responde ya lo cubre checkEngine; aquí no se insiste.
    return;
  }
  const porVolumen = summary.pending >= QUEUE_ALERT_THRESHOLD;
  const antigua = summary.oldestSeconds !== null && summary.oldestSeconds >= QUEUE_AGE_THRESHOLD_S;
  // El puerto solo se mide si hay algo retenido, y la medición se reutiliza
  // durante una hora: no hay que salir a Internet en cada vuelta. Con correo
  // antiguo se mide siempre, porque de ella depende abrir o cerrar su aviso.
  const medir = motorReal() && (antigua || (porVolumen && !alertaAbierta(ALERTA_COLA)));
  const puerto25 = medir ? await comprobarPuerto25({ vigenciaMs: HOUR }) : null;
  evaluarCola(summary, puerto25);
}

/* ------------------------ Puerto 25 de salida (diario) -------------------- */

const ALERTA_PUERTO25 = 'smtp_port_blocked';

export function evaluarPuerto25(resultado: ResultadoPuerto25): void {
  if (resultado.estado === 'abierto') {
    resolveAlert(ALERTA_PUERTO25, { notify: true, what: 'puerto 25 de salida bloqueado' });
    return;
  }
  // Sin DNS no se sabe nada del puerto: ni se abre ni se cierra el aviso.
  if (resultado.estado !== 'bloqueado') return;
  fireAlert({
    severity: 'critical',
    type: ALERTA_PUERTO25,
    dedupeKey: ALERTA_PUERTO25,
    title: 'El puerto 25 de salida está bloqueado',
    message: `${resultado.detalle} Sin él no se entrega correo a otros servidores: los mensajes se quedan en la cola hasta que caducan.`,
    remedy:
      'Solicita al proveedor del servidor la apertura del puerto 25 de salida: OVH, Hetzner y AWS, entre otros, lo bloquean por defecto. Mientras el aviso siga abierto se vuelve a medir cada hora y se cierra solo en cuanto el puerto responda.',
  });
}

async function checkPuerto25(): Promise<void> {
  if (!motorReal()) return;
  // Una vez al día; cada hora mientras está bloqueado, para cerrar el aviso
  // poco después de que el proveedor lo abra.
  if (!due('smtp_port', alertaAbierta(ALERTA_PUERTO25) ? HOUR : DAY)) return;
  markRun('smtp_port');
  evaluarPuerto25(await comprobarPuerto25({ sinCache: true }));
}

/* ------------------------- IP pública (diario) ---------------------------- */

/** La regla (y el aviso) viven en ipservidor.ts: Ajustes usa la misma. */
async function checkIpPublica(): Promise<void> {
  if (!due('public_ip', DAY)) return;
  if (!getInstanceSettings().publicIp.trim()) return;
  markRun('public_ip');
  await revisarIpPublica();
}

/* ------------------ Caducidad de los tokens de gestión -------------------- */

/** Antelación del aviso: la misma con la que la lista los marca «Caduca pronto». */
const AVISO_TOKEN_MS = 14 * DAY;
/** Tras caducar, el aviso sigue abierto una semana; después se cierra solo. */
const TRAS_CADUCAR_MS = 7 * DAY;

function fechaLarga(ms: number): string {
  return new Date(ms).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Avisa de los tokens de gestión en uso que caducan en menos de 14 días o
 * acaban de caducar: al caducar, la integración que lo usa (Skyway, un
 * script) empieza a recibir 401 y nadie lo nota hasta que algo falla. Los de
 * un cliente se le muestran en su panel, sin enviarse a los canales de la
 * administración.
 */
export function revisarCaducidadTokens(ahora = now()): void {
  const vigentes = new Set<string>();
  for (const token of tokensConCaducidadCercana(ahora, AVISO_TOKEN_MS, TRAS_CADUCAR_MS)) {
    const caducado = token.expiresAt! <= ahora;
    const clave = `${caducado ? 'token_expired' : 'token_expiring'}:${token.id}`;
    vigentes.add(clave);
    const deAdministracion = token.ownerRole === 'admin';
    const remedy = deAdministracion
      ? 'Crea un token nuevo en Conexiones → Tokens de gestión, sustitúyelo en la integración (en Skyway, Ajustes → Correo) y revoca el anterior. Para Skyway, «sudo bash deploy/instalar.sh --emparejar» crea uno sin caducidad y lo configura.'
      : 'Crea un token nuevo en Conexiones → Tokens de gestión, sustitúyelo en el script o la integración que lo usa y revoca el anterior.';
    const comun = {
      dedupeKey: clave,
      clientId: token.ownerClientId,
      quiet: !deAdministracion,
      remedy,
    };
    if (caducado) {
      resolveAlert(`token_expiring:${token.id}`);
      fireAlert({
        ...comun,
        severity: 'critical',
        type: 'token_expired',
        title: `El token de gestión «${token.name}» ha caducado`,
        message: `Caducó el ${fechaLarga(token.expiresAt!)}. Las integraciones que lo usan (Skyway, scripts, procesos de integración continua) reciben un error de autenticación desde entonces.`,
      });
    } else {
      fireAlert({
        ...comun,
        severity: 'warning',
        type: 'token_expiring',
        title: `El token de gestión «${token.name}» caduca el ${fechaLarga(token.expiresAt!)}`,
        message: `Las integraciones que lo usan (Skyway, scripts, procesos de integración continua) recibirán un error de autenticación a partir de esa fecha. Se usó por última vez el ${fechaLarga(token.lastUsedAt!)}.`,
      });
    }
  }
  // Revocado, renovado o caducado hace más de una semana: el aviso ya no
  // describe nada pendiente y se cierra sin notificar.
  const abiertas = db
    .prepare(
      `SELECT DISTINCT dedupe_key FROM alerts
       WHERE type IN ('token_expiring', 'token_expired') AND resolved_at IS NULL AND dedupe_key IS NOT NULL`,
    )
    .all() as { dedupe_key: string }[];
  for (const { dedupe_key: clave } of abiertas) {
    if (!vigentes.has(clave)) resolveAlert(clave);
  }
}

async function checkTokens(): Promise<void> {
  if (!due('tokens', HOUR)) return;
  markRun('tokens');
  revisarCaducidadTokens();
}

/* ----------------------------- El webmail --------------------------------- */

export async function checkWebmail(): Promise<void> {
  const { webmailUrl } = getInstanceSettings();
  if (!webmailUrl) return;
  let ok = false;
  let status: number | null = null;
  try {
    const res = await fetch(webmailUrl, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    // Solo una respuesta 2xx o una redirección (la del inicio de sesión)
    // acreditan que el webmail atiende. Un 404 o un 403 son la página de
    // error de Traefik o de otra aplicación: el webmail no está detrás.
    status = res.status;
    ok = res.status >= 200 && res.status < 400;
  } catch {
    ok = false;
  }
  if (ok) {
    resolveAlert('webmail_down', { notify: true, what: 'webmail caído' });
  } else {
    fireAlert({
      severity: 'warning',
      type: 'webmail_down',
      dedupeKey: 'webmail_down',
      title: 'El webmail no está disponible',
      message: `${
        status === null ? `No hay respuesta desde ${webmailUrl}.` : `${webmailUrl} responde con un error (HTTP ${status}).`
      } Los clientes no pueden leer su correo desde el navegador (los programas de correo y el móvil siguen funcionando).`,
      // El compose depende del modo de la instalación (junto a Skyway o
      // autónoma) y la ruta, de la carpeta: el instalador elige el bueno
      // según deploy/.env, desde cualquier sitio.
      remedy:
        'Revisa su registro en el servidor con «docker logs mailway-webmail». Después, en la carpeta de Mailway, «sudo bash deploy/instalar.sh --comprobar» lo diagnostica y «sudo bash deploy/instalar.sh --actualizar» lo vuelve a levantar con la configuración de la instalación (junto a Skyway o autónoma).',
    });
  }
}

/* --------------------------- Listas negras (diario) ----------------------- */

async function checkBlacklists(): Promise<void> {
  if (!due('dnsbl', DAY)) return;
  const { publicIp } = getInstanceSettings();
  if (!publicIp) return;
  markRun('dnsbl');

  const results = await checkDnsbl(publicIp);
  const listed = results.filter((r) => r.status === 'listed');
  if (listed.length === 0) {
    resolveAlert('dnsbl_listed', { notify: true, what: 'IP en lista negra' });
    return;
  }
  fireAlert({
    severity: 'critical',
    type: 'dnsbl_listed',
    dedupeKey: 'dnsbl_listed',
    title: `La IP del servidor está en ${listed.length} lista(s) negra(s)`,
    message: `Listas afectadas: ${listed.map((l) => l.label).join(', ')}. Mientras siga en ellas, gran parte del correo enviado se clasificará como spam o se rechazará.`,
    remedy:
      'Solicita la baja en la web de cada lista. Antes, comprueba que ningún buzón comprometido esté enviando spam (consulta el historial de envíos).',
  });
}

/* --------------------------- DNS de los dominios -------------------------- */

/** Ventanas en las que se espera que el DNS cambie: se mide más a menudo. */
const TRAS_APLICAR_MS = 48 * HOUR;
const DOMINIO_NUEVO_MS = 7 * DAY;
const FRECUENTE_MS = 10 * MINUTE;

/**
 * Cada cuánto se vuelve a medir un dominio. Uno pendiente al que se le acaba
 * de aplicar el DNS (o recién dado de alta) se mide cada 10 minutos, para
 * que pase a activo sin que nadie tenga que pulsar «Medir»; el resto, cada
 * hora. Cada medición de un dominio con la propiedad pendiente la comprueba
 * también (refreshDomainDns).
 */
export function intervaloDeMedicion(domain: DomainRecord, ahora = now()): number {
  if (domain.status === 'active') return HOUR;
  const aplicadoHace = domain.dnsAppliedAt ? ahora - domain.dnsAppliedAt : Infinity;
  const creadoHace = ahora - domain.createdAt;
  if (aplicadoHace <= TRAS_APLICAR_MS || creadoHace <= DOMINIO_NUEVO_MS) return FRECUENTE_MS;
  return HOUR;
}

/** Mide un dominio y abre o resuelve su alerta de DNS (exportada para las pruebas). */
export async function reviewDomainDns(domain: DomainRecord): Promise<void> {
  try {
    const updated = await refreshDomainDns(domain.id);
    const key = `domain_dns:${domain.id}`;
    if (updated.status === 'active') {
      resolveAlert(key, { notify: true, what: `DNS de ${domain.domain}` });
      return;
    }
    // El dominio anterior de un cambio ya pasado deja de recibir aquí a
    // propósito: la baja exige que su MX apunte a otro sitio, y el correo ya
    // sale con el dominio nuevo. Avisar de que «su DNS ha dejado de ser
    // correcto» llevaría a aplicarlo otra vez, devolver el MX a este servidor
    // y bloquear la baja.
    const cambio = updated.migracion;
    if (cambio?.rol === 'origen' && (cambio.estado === 'pasado' || cambio.estado === 'dando_de_baja')) {
      resolveAlert(key);
      return;
    }
    // Solo es una avería si el dominio llegó a estar bien: uno que nunca se
    // configuró es una tarea pendiente del cliente, no una incidencia.
    if (updated.status === 'pending_dns' && domain.verifiedAt) {
      fireAlert({
        severity: 'critical',
        type: 'domain_dns_broken',
        dedupeKey: key,
        clientId: domain.clientId,
        title: `El DNS de ${domain.domain} ha dejado de ser correcto`,
        message:
          'Este dominio estaba verificado y ahora le falta algún registro obligatorio. Es probable que se haya modificado su DNS.',
        remedy: domain.cloudflare
          ? 'Abre el dominio en el panel y aplica de nuevo el DNS en Cloudflare, o revisa qué registro aparece fuera de rango: la tabla indica el valor exacto que debe tener.'
          : 'Abre el dominio en el panel y revisa qué registro aparece fuera de rango: la tabla indica el valor exacto que debe tener.',
      });
    }
  } catch {
    // Un fallo puntual de red no debe abrir una alerta falsa.
  }
}

async function checkDomainDns(): Promise<void> {
  // La vuelta se evalúa cada 10 minutos; cada dominio decide si le toca.
  if (!due('domains', FRECUENTE_MS)) return;
  if (!engineConfigured()) return;
  markRun('domains');

  const ahora = now();
  const pendientes = listDomains().filter(
    (d) => !d.lastCheckedAt || ahora - d.lastCheckedAt >= intervaloDeMedicion(d, ahora) - MINUTE,
  );
  // En lotes: son consultas de red y en serie la vuelta tardaría minutos.
  for (let i = 0; i < pendientes.length; i += 4) {
    await Promise.allSettled(pendientes.slice(i, i + 4).map((d) => reviewDomainDns(d)));
  }
}

/* ------------- Dominios de marca blanca atascados (cada 10 min) ----------- */

const STUCK_AFTER_MS = 30 * MINUTE;

/**
 * Dominios propios que el vigilante vuelve a medir: los que emiten
 * certificado, los activos y los que alguna vez estuvieron activos. Uno que
 * nunca llegó a funcionar y espera DNS es una tarea pendiente del cliente,
 * que lo comprueba desde su ficha.
 */
export function debeVigilarse(domain: ClientDomain): boolean {
  if (domain.status === 'issuing' || domain.status === 'active') return true;
  return domain.status === 'pending_dns' && domain.activatedAt !== null;
}

async function checkWhitelabelDomains(): Promise<void> {
  if (!due('whitelabel', 10 * MINUTE)) return;
  markRun('whitelabel');

  // Se refrescan también los ya activos: un dominio verificado puede
  // romperse (le cambian el DNS, caduca el certificado) y si solo se miraran
  // los que están emitiendo, esa regresión sería invisible. Y los que
  // estuvieron activos y cayeron a «pendiente de DNS»: fuera de Traefik nadie
  // los volvería a medir y seguirían caídos aunque el DNS ya estuviera bien.
  const vigilados = listClientDomains().filter(debeVigilarse);
  // En lotes: son sondas de red y en serie el ciclo se bloquea minutos.
  for (let i = 0; i < vigilados.length; i += 6) {
    await Promise.allSettled(vigilados.slice(i, i + 6).map((d) => reviewWhitelabelDomain(d)));
  }
}

/* ----------- Webmail automático de cada dominio (cada hora) --------------- */

/**
 * El webmail de marca de cada dominio con la propiedad comprobada
 * (asegurarWebmailDeDominio): cubre los dominios que ya existían antes de
 * esta función y los que no se pudieron preparar al comprobarse (Cloudflare
 * sin respuesta, cuenta conectada después). Y los webmail que siguen
 * esperando al DNS sin haber funcionado nunca: se reintenta crear su
 * registro y se miden, por si el DNS se puso a mano.
 */
export async function checkWebmailsAutomaticos(): Promise<void> {
  if (!webmailAutomaticoGlobal()) return;
  if (!due('webmail-automatico', HOUR)) return;
  markRun('webmail-automatico');
  const dominios = db
    .prepare('SELECT id FROM domains WHERE owner_verified_at IS NOT NULL ORDER BY created_at')
    .all() as { id: string }[];
  // En serie: cada uno puede llamar a Cloudflare y crear un registro.
  for (const d of dominios) await asegurarWebmailDeDominio(d.id).catch(() => null);
  const pendientes = listClientDomains().filter(
    (d) => d.kind === 'webmail' && d.status === 'pending_dns' && d.activatedAt === null,
  );
  for (const d of pendientes) await reintentarWebmailPendiente(d.id).catch(() => null);
}

async function reviewWhitelabelDomain(domain: ClientDomain): Promise<void> {
  try {
    const updated = await refreshClientDomain(domain.id);
    if (updated.status === 'active') {
      resolveAlert(`whitelabel:${domain.id}`, {
        notify: true,
        what: `certificado de ${domain.hostname}`,
      });
      return;
    }
    // Un dominio que ESTABA activo y ha dejado de estarlo es una avería en
    // producción: el webmail de ese cliente ya no responde.
    if (domain.status === 'active') {
      fireAlert({
        severity: 'critical',
        type: 'whitelabel_broken',
        dedupeKey: `whitelabel:${domain.id}`,
        clientId: domain.clientId,
        title: `${domain.hostname} ha dejado de funcionar`,
        message: `Este dominio funcionaba y ahora no responde. ${updated.detail}`,
        remedy:
          'Lo más habitual es que se haya modificado el DNS del dominio. Comprueba en el panel qué registro requiere y que siga apuntando al servidor.',
      });
      return;
    }
    // Lleva demasiado tiempo esperando certificado: algo no encaja. Solo con
    // el DNS ya correcto; uno pendiente de DNS es tarea del cliente.
    if (updated.status === 'issuing' && now() - domain.createdAt > STUCK_AFTER_MS) {
      fireAlert({
        severity: 'warning',
        type: 'whitelabel_stuck',
        dedupeKey: `whitelabel:${domain.id}`,
        clientId: domain.clientId,
        title: `${domain.hostname} lleva más de 30 minutos sin certificado`,
        message: `El DNS apunta correctamente, pero Traefik no consigue emitir el certificado. Último detalle: ${updated.detail}`,
        remedy:
          'Comprueba que Traefik tiene configurado el sondeo a Mailway (Ajustes → Marca blanca muestra la línea exacta) y que el puerto 80 está abierto: Let\'s Encrypt lo necesita para validar el dominio.',
      });
    }
  } catch {
    // se reintenta en la siguiente vuelta
  }
}

/* ----------------- Autoconfiguración (cada hora) y TLS (diario) ----------- */

async function checkAutoconfigHosts(): Promise<void> {
  if (!due('autoconfig', HOUR)) return;
  markRun('autoconfig');
  await refreshAutoconfigHosts();
}

async function checkTlsDelMotor(): Promise<void> {
  if (!due('engine_tls', DAY)) return;
  markRun('engine_tls');
  await checkEngineTls();
}

/**
 * Nombre con el que se anuncia el motor (cada 10 minutos). Si difiere del de
 * Ajustes abre un aviso; los dominios no se tocan: checkDomainDns los vuelve
 * a medir con su frecuencia habitual contra los registros que genere el motor.
 */
async function checkNombreDelMotor(): Promise<void> {
  if (!due('engine_hostname', 10 * MINUTE)) return;
  markRun('engine_hostname');
  await checkEngineHostname();
}

/* ------------------ Copia de las contraseñas (cada hora) ------------------ */

/**
 * Mientras el motor sea Stalwart 0.15, copia en el panel el hash de los
 * buzones que aún no lo tienen (cada hora) y refresca todos (a diario): así
 * la copia está completa mucho antes de migrar a 0.16, que ya no los da.
 */
async function checkCopiaDeContrasenas(): Promise<void> {
  if (!engineConfigured()) return;
  const todas = due('credenciales_todas', DAY);
  if (!todas && !due('credenciales', HOUR)) return;
  markRun('credenciales');
  if (todas) markRun('credenciales_todas');
  await capturarSiProcede({ todas });
}

/**
 * Reglas de entrega de los dominios con el correo en otro proveedor (cada 10
 * minutos): repara lo que no se pudo aplicar al medir (motor caído, recarga
 * con errores) y lo que se haya perdido en el motor (una reinstalación).
 */
async function checkRecepcionExterna(): Promise<void> {
  if (!due('recepcion_externa', 10 * MINUTE)) return;
  markRun('recepcion_externa');
  await sincronizarRecepcionExterna();
}

/**
 * Cambios de dominio, cada 2 minutos:
 * - avanza la preparación de los que esperan al DNS de dominio2.es (la
 *   propiedad, la pre-recepción y las compuertas para pasar), también con el
 *   asistente cerrado;
 * - tras pasar, convierte en principal el webmail nuevo en cuanto está activo;
 * - concilia los cambios de usuario del motor que quedaron a medias (motor
 *   caído a mitad de un renombrado): sin esto, la marca bloquearía ese buzón
 *   hasta el siguiente arranque del panel.
 */
async function tickCambiosDeDominio(log?: (msg: string) => void): Promise<void> {
  if (!due('cambios_de_dominio', 2 * MINUTE)) return;
  markRun('cambios_de_dominio');
  await vigilarCambiosDeDominio(log);
  const conMarca = db.prepare('SELECT 1 FROM mailboxes WHERE usuario_cambiando_a IS NOT NULL LIMIT 1').get();
  if (conMarca) await conciliarUsuariosEnCambio();
}

/* ------------------------------ Planificador ------------------------------ */

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Ejecuta un paso sin que su fallo detenga los demás: una comprobación rota
 * (un módulo con un error, un servicio externo caído) no puede dejar sin
 * vigilancia al resto del sistema.
 */
async function paso(nombre: string, fn: () => Promise<void>, log?: (msg: string) => void): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log?.(`vigilante (${nombre}): ${(err as Error).message}`);
  }
}

export async function runWatchdogOnce(log?: (msg: string) => void): Promise<void> {
  if (running) return; // una vuelta lenta no debe solaparse con la siguiente
  running = true;
  try {
    // El motor (y el webmail, que se para con él) se están cambiando de
    // versión: nada de lo que dependa de ellos se comprueba ni avisa.
    const mantenimiento = mantenimientoActivo();
    // Las tres rápidas son independientes: en serie sumaban sus tiempos de
    // espera y, con el webmail caído, la vuelta tardaba 10 s de más.
    if (!mantenimiento) await Promise.allSettled([checkEngine(), checkQueue(), checkWebmail()]);
    // La corrección única de lo que dejó la suspensión anterior, si el
    // arranque no pudo hacerla (motor sin responder); hecha una vez, no
    // vuelve a tocar el motor. Nunca con el motor en mantenimiento.
    if (!mantenimiento) {
      await paso('buzones suspendidos', async () => {
        await repararSuspensiones();
      }, log);
    }
    // Las lentas van después y ya se autolimitan por frecuencia.
    await paso('listas negras', checkBlacklists, log);
    if (!mantenimiento) await paso('dns de dominios', checkDomainDns, log);
    await paso('marca blanca', checkWhitelabelDomains, log);
    await paso('webmail automático', checkWebmailsAutomaticos, log);
    await paso('autoconfiguración', checkAutoconfigHosts, log);
    if (!mantenimiento) {
      await paso('certificado del motor', checkTlsDelMotor, log);
      await paso('nombre del motor', checkNombreDelMotor, log);
      await paso('copia de las contraseñas', checkCopiaDeContrasenas, log);
      // El correo web nuevo (Bulwark), si está configurado: su salud y la
      // marca y la política pendientes. Se para con el motor, como el webmail.
      await paso('correo web nuevo', vigilarCorreoWebNuevo, log);
      // Lo que escribe en el motor también espera al final del mantenimiento.
      await paso('recepción en otro proveedor', checkRecepcionExterna, log);
      await paso('cambios de dominio', () => tickCambiosDeDominio(log), log);
    }
    await paso('puerto 25 de salida', checkPuerto25, log);
    await paso('IP pública', checkIpPublica, log);
    await paso('caducidad de los tokens', checkTokens, log);
    // Limpieza: las alertas resueltas hace más de 30 días no aportan nada.
    await paso('limpieza', async () => {
      db.prepare('DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < ?').run(
        now() - 30 * DAY,
      );
    }, log);
  } finally {
    running = false;
  }
}

export function startWatchdog(log: { warn: (msg: string) => void }): void {
  if (config.watchdogDisabled || timer) return;
  const intervalMs = Math.max(30, config.watchdogIntervalSeconds) * 1000;
  const aviso = (msg: string) => log.warn(msg);
  timer = setInterval(() => {
    runWatchdogOnce(aviso).catch((err) => log.warn(`vigilante: ${(err as Error).message}`));
  }, intervalMs);
  // No mantiene vivo el proceso si es lo único que queda.
  timer.unref?.();
}

export function stopWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
