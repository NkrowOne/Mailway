import { validateMailHostname } from '../core/mail-hostname';
import { getEngine, engineConfigured } from '../engine';
import type { MailEngine } from '../engine/types';
import { db } from '../core/db';
import { getInstanceSettings } from './settings';
import { fireAlert, resolveAlert } from './alerts';

export interface HostnameSyncStatus {
  status: 'pending' | 'synced' | 'error' | 'unconfigured' | 'demo';
  hostname: string;
  detail: string;
  checkedAt: number | null;
}

let state: HostnameSyncStatus | null = null;
let lastEngine: MailEngine | null = null;
let running: Promise<HostnameSyncStatus> | null = null;

export function getHostnameSyncStatus(): HostnameSyncStatus {
  const hostname = getInstanceSettings().mailHostname;
  if (state?.hostname === hostname && engineConfigured() && getEngine() === lastEngine) return state;
  return { status: 'pending', hostname, detail: 'Pendiente de comprobar el hostname en Stalwart.', checkedAt: null };
}

/** Una sola escritura a la vez. Reintenta tras fallos y revisa cambios del motor. */
export async function syncMailHostname(force = false): Promise<HostnameSyncStatus> {
  if (running) {
    await running;
    return syncMailHostname(force);
  }
  const hostname = getInstanceSettings().mailHostname;
  const engine = engineConfigured() ? getEngine() : null;
  if (!force && state?.hostname === hostname && lastEngine === engine && state.checkedAt && Date.now() - state.checkedAt < 60_000) return state;
  lastEngine = engine;
  running = (async (): Promise<HostnameSyncStatus> => {
    const finish = (status: HostnameSyncStatus['status'], detail: string) => {
      state = { status, hostname, detail, checkedAt: Date.now() };
      return state;
    };
    if (!hostname || !engine) return finish('unconfigured', 'Configura el hostname y conecta el motor para sincronizarlo.');
    if (engine.kind === 'demo') return finish('demo', 'Modo demostración: no se ha cambiado ningún servidor real.');
    try {
      validateMailHostname(hostname);
      const result = await engine.syncHostname(hostname);
      if (result.changed) {
        // verified_at conserva el historial: el vigilante debe volver a revisar estos dominios.
        // Un informe medido con la identidad anterior ya no acredita el DNS actual.
        db.prepare("UPDATE domains SET status = 'pending_dns', dns_status_json = '{}', last_checked_at = NULL").run();
        fireAlert({
          severity: 'warning', type: 'hostname_dns_review', dedupeKey: `hostname_dns_review:${hostname}`,
          title: 'Revisa DNS y certificados tras actualizar el servidor de correo',
          message: `Stalwart ya anuncia ${hostname}. Los registros DNS externos no se han modificado.`,
          remedy: 'Vuelve a obtener los MX, CNAME y SRV en Dominios. Revisa A/AAAA, PTR, certificados IMAP/SMTP y el destino de Roundcube. En el stack de correo, mantén MAIL_HOSTNAME alineado con esta identidad.',
          quiet: true,
        });
      }
      resolveAlert('hostname_sync_failed');
      return finish('synced', `Stalwart confirma ${hostname} en los registros que genera.`);
    } catch {
      const detail = 'No se pudo aplicar y verificar el hostname en Stalwart. Comprueba la conexión, los permisos de configuración y los errores de recarga del motor. Mailway volverá a intentarlo.';
      fireAlert({ severity: 'warning', type: 'hostname_sync_failed', dedupeKey: 'hostname_sync_failed',
        title: 'Hostname pendiente de sincronizar', message: detail,
        remedy: 'Revisa Ajustes → Motor y vuelve a pulsar Sincronizar hostname.', quiet: true });
      return finish('error', detail);
    }
  })();
  try { return await running; } finally { running = null; }
}
