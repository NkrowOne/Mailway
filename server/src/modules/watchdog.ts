import { config } from '../config';
import { db, now } from '../core/db';
import { checkDnsbl } from '../core/dns';
import { engineConfigured, getEngine } from '../engine';
import { fireAlert, resolveAlert } from './alerts';
import { refreshAutoconfigHosts } from './autoconfig';
import { listDomains, refreshDomainDns, type DomainRecord } from './domains';
import { checkEngineHostname, checkEngineTls } from './engineops';
import { getInstanceSettings } from './settings';
import { getSetting, setSetting } from './settings';
import {
  asegurarWebmailDeDominio,
  listClientDomains,
  refreshClientDomain,
  reintentarWebmailPendiente,
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

async function checkQueue(): Promise<void> {
  if (!engineConfigured()) return;
  try {
    const summary = await getEngine().getQueueSummary();
    if (summary.pending >= QUEUE_ALERT_THRESHOLD) {
      fireAlert({
        severity: 'warning',
        type: 'queue_backed_up',
        dedupeKey: 'queue_backed_up',
        title: `Hay ${summary.pending} mensajes retenidos en la cola de salida`,
        message:
          'Los mensajes se están acumulando sin poder entregarse. Suele indicar que el puerto 25 de salida está bloqueado o que un destino está rechazando los envíos.',
        remedy:
          'Revisa la salud del servidor en Entregabilidad: si la IP está en una lista negra o falta el PTR, esa es la causa más probable.',
      });
    } else {
      resolveAlert('queue_backed_up', { notify: true, what: 'cola de salida retenida' });
    }
  } catch {
    // Si el motor no responde ya lo cubre checkEngine; aquí no se insiste.
  }
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
      remedy:
        'Ejecuta en el servidor: docker logs mailway-webmail y docker compose -f deploy/docker-compose.mail.yml up -d',
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

async function reviewDomainDns(domain: DomainRecord): Promise<void> {
  try {
    const updated = await refreshDomainDns(domain.id);
    const key = `domain_dns:${domain.id}`;
    if (updated.status === 'active') {
      resolveAlert(key, { notify: true, what: `DNS de ${domain.domain}` });
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
  if (!config.webmailAutomatico) return;
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
    // Las tres rápidas son independientes: en serie sumaban sus tiempos de
    // espera y, con el webmail caído, la vuelta tardaba 10 s de más.
    await Promise.allSettled([checkEngine(), checkQueue(), checkWebmail()]);
    // Las lentas van después y ya se autolimitan por frecuencia.
    await paso('listas negras', checkBlacklists, log);
    await paso('dns de dominios', checkDomainDns, log);
    await paso('marca blanca', checkWhitelabelDomains, log);
    await paso('webmail automático', checkWebmailsAutomaticos, log);
    await paso('autoconfiguración', checkAutoconfigHosts, log);
    await paso('certificado del motor', checkTlsDelMotor, log);
    await paso('nombre del motor', checkNombreDelMotor, log);
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
