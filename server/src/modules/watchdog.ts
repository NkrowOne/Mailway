import { config } from '../config';
import { db, now } from '../core/db';
import { checkDnsbl } from '../core/dns';
import { engineConfigured, getEngine } from '../engine';
import { fireAlert, resolveAlert } from './alerts';
import { listDomains, refreshDomainDns } from './domains';
import { getInstanceSettings } from './settings';
import { getSetting, setSetting } from './settings';
import { listClientDomains, refreshClientDomain } from './whitelabel';

/**
 * Vigilante de fondo: comprueba periódicamente que todo sigue en pie y abre
 * alertas (con aviso por Discord/Telegram/webhook) cuando algo se rompe.
 *
 * Las comprobaciones caras no se hacen en cada vuelta: las listas negras se
 * consultan una vez al día y el DNS de los dominios una vez por hora, para no
 * castigar a los resolutores ni a los servicios externos.
 */

const HOUR = 3600_000;
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
    message: `Mailway no consigue hablar con el motor de correo. ${detail}`.trim(),
    remedy:
      'Entra por SSH y ejecuta: docker ps (¿está "mailway-mail" en marcha?) y docker logs mailway-mail. Mientras esté caído no se entrega ni se envía correo.',
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
        title: `Hay ${summary.pending} mensajes atascados en la cola de salida`,
        message:
          'Los mensajes se están acumulando sin poder entregarse. Suele significar que el puerto 25 de salida está bloqueado o que un destino nos está rechazando.',
        remedy:
          'Revisa la salud del servidor en Entregabilidad: si la IP está en una lista negra o falta el PTR, esa es la causa más probable.',
      });
    } else {
      resolveAlert('queue_backed_up', { notify: true, what: 'cola de salida atascada' });
    }
  } catch {
    // Si el motor no responde ya lo cubre checkEngine; aquí no insistimos.
  }
}

/* ----------------------------- El webmail --------------------------------- */

async function checkWebmail(): Promise<void> {
  const { webmailUrl } = getInstanceSettings();
  if (!webmailUrl) return;
  let ok = false;
  try {
    const res = await fetch(webmailUrl, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    // Cualquier respuesta HTTP significa que el contenedor está sirviendo.
    ok = res.status < 500;
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
      title: 'El webmail no responde',
      message: `No hay respuesta desde ${webmailUrl}. Tus clientes no pueden leer su correo desde el navegador (los programas de correo y el móvil siguen funcionando).`,
      remedy: 'Ejecuta en el servidor: docker logs mailway-webmail y docker compose -f deploy/docker-compose.mail.yml up -d',
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
    message: `Listas afectadas: ${listed.map((l) => l.label).join(', ')}. Mientras siga ahí, gran parte del correo que envíes acabará en spam o será rechazado.`,
    remedy:
      'Entra en la web de cada lista y solicita la baja. Antes, revisa que ningún buzón esté comprometido enviando spam (mira el historial de envíos).',
  });
}

/* ------------------- DNS de los dominios de correo (horario) -------------- */

async function checkDomainDns(): Promise<void> {
  if (!due('domains', HOUR)) return;
  if (!engineConfigured()) return;
  markRun('domains');

  for (const domain of listDomains()) {
    // Solo vigilamos los que ya llegaron a estar bien: un dominio que nunca
    // se configuró no es una avería, es una tarea pendiente del cliente.
    if (!domain.verifiedAt) continue;
    try {
      const updated = await refreshDomainDns(domain.id);
      const key = `domain_dns:${domain.id}`;
      if (updated.status === 'active') {
        resolveAlert(key, { notify: true, what: `DNS de ${domain.domain}` });
      } else if (updated.status === 'pending_dns') {
        fireAlert({
          severity: 'critical',
          type: 'domain_dns_broken',
          dedupeKey: key,
          clientId: domain.clientId,
          title: `El DNS de ${domain.domain} ha dejado de estar correcto`,
          message:
            'Este dominio estaba verificado y ahora le falta algún registro obligatorio. Es probable que alguien haya tocado el DNS.',
          remedy: `Abre el dominio en el panel y mira qué registro aparece en rojo; la tabla trae el valor exacto que debe tener.`,
        });
      }
    } catch {
      // Un fallo puntual de red no debe abrir una alerta falsa.
    }
  }
}

/* ------------- Dominios de marca blanca atascados (cada 10 min) ----------- */

const STUCK_AFTER_MS = 30 * 60_000;

async function checkWhitelabelDomains(): Promise<void> {
  if (!due('whitelabel', 10 * 60_000)) return;
  markRun('whitelabel');

  for (const domain of listClientDomains()) {
    if (domain.status === 'active') {
      resolveAlert(`whitelabel:${domain.id}`, { notify: false });
      continue;
    }
    if (domain.status !== 'issuing') continue;
    try {
      const updated = await refreshClientDomain(domain.id);
      if (updated.status === 'active') {
        resolveAlert(`whitelabel:${domain.id}`, {
          notify: true,
          what: `certificado de ${domain.hostname}`,
        });
        continue;
      }
      // Lleva demasiado tiempo esperando certificado: algo no encaja.
      if (now() - domain.createdAt > STUCK_AFTER_MS) {
        fireAlert({
          severity: 'warning',
          type: 'whitelabel_stuck',
          dedupeKey: `whitelabel:${domain.id}`,
          clientId: domain.clientId,
          title: `${domain.hostname} lleva más de 30 minutos sin certificado`,
          message: `El DNS apunta bien, pero Traefik no consigue emitir el certificado. Último detalle: ${updated.detail}`,
          remedy:
            'Comprueba que Traefik tiene configurado el sondeo a Mailway (Ajustes → Marca blanca muestra la línea exacta) y que el puerto 80 está abierto: Let\'s Encrypt lo necesita para validar el dominio.',
        });
      }
    } catch {
      // se reintenta en la siguiente vuelta
    }
  }
}

/* ------------------------------ Planificador ------------------------------ */

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function runWatchdogOnce(): Promise<void> {
  if (running) return; // una vuelta lenta no debe solaparse con la siguiente
  running = true;
  try {
    await checkEngine();
    await checkQueue();
    await checkWebmail();
    await checkBlacklists();
    await checkDomainDns();
    await checkWhitelabelDomains();
    // Limpieza: las alertas resueltas hace más de 30 días no aportan nada.
    db.prepare('DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < ?').run(
      now() - 30 * DAY,
    );
  } finally {
    running = false;
  }
}

export function startWatchdog(log: { warn: (msg: string) => void }): void {
  if (config.watchdogDisabled || timer) return;
  const intervalMs = Math.max(30, config.watchdogIntervalSeconds) * 1000;
  timer = setInterval(() => {
    runWatchdogOnce().catch((err) => log.warn(`vigilante: ${(err as Error).message}`));
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
