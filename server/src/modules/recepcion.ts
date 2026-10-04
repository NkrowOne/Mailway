import { db, now } from '../core/db';
import { withLock } from '../core/locks';
import { engineConfigured, getEngine } from '../engine';
import type { RemoteDomainsResult } from '../engine/types';
import { fireAlert, resolveAlert } from './alerts';
import { getJsonSetting, setJsonSetting } from './settings';

/**
 * Dominios con la recepción en otro proveedor: su MX público apunta a otro
 * servidor (un traslado en preparación o un dominio que solo envía desde
 * Mailway). Mientras sea así, el motor entrega por ese MX lo que se envía
 * desde aquí a sus direcciones; véase engine/recepcion.ts.
 *
 * La lista sale de la última medición DEFINITIVA del MX de cada dominio
 * (refreshDomainDns): una consulta fallida no la cambia. Si el MX pasa a este
 * servidor, el dominio sale de la lista en la siguiente medición; mientras
 * tanto, lo que salga por MX y vuelva aquí se entrega en local.
 */

const CLAVE_ESTADO = 'motor_recepcion_externa';
const ALERTA_PERSONALIZADA = 'engine_recepcion_personalizada';
const ALERTA_RECARGA = 'engine_recepcion_recarga';

interface EstadoRecepcion {
  dominios: string[];
  /** La última escritura no se aplicó (la recarga del motor falló): se repite. */
  recargaPendiente: boolean;
  at: number;
}

export function dominiosConRecepcionExterna(): string[] {
  return (
    db.prepare('SELECT domain FROM domains WHERE recepcion_externa = 1 ORDER BY domain').all() as { domain: string }[]
  ).map((r) => r.domain);
}

/**
 * Deja el motor con la lista actual. La llaman la medición de un dominio
 * cuando su recepción cambia, el borrado de un dominio y el vigilante (que
 * repara lo que no se pudo aplicar: un motor caído o una recarga fallida).
 * Nunca lanza.
 */
export async function sincronizarRecepcionExterna(): Promise<RemoteDomainsResult | null> {
  if (!engineConfigured()) return null;
  return withLock('motor:recepcion', async () => {
    const dominios = dominiosConRecepcionExterna();
    const previo = getJsonSetting<EstadoRecepcion>(CLAVE_ESTADO);
    let r: RemoteDomainsResult;
    try {
      r = await getEngine().syncRemoteDomains(dominios, { reload: previo?.recargaPendiente === true });
    } catch {
      // Motor caído: ya lo avisa el vigilante del motor; se reintenta después.
      return null;
    }

    if (r.customized) {
      // Sin dominios afectados, la personalización no estorba a nada.
      if (dominios.length > 0) {
        fireAlert({
          severity: 'warning',
          type: 'engine_recepcion',
          dedupeKey: ALERTA_PERSONALIZADA,
          title: 'El servidor de correo tiene personalizada la entrega de los mensajes',
          message:
            `Las reglas session.rcpt.directory, queue.strategy.route o queue.strategy.schedule del motor tienen valores que no ha escrito Mailway, así que no se han modificado. ` +
            `Mientras tanto, lo que se envíe desde este servidor a ${dominios.join(', ')} (dominios cuyo MX apunta a otro proveedor) se entregará en los buzones de aquí o se rechazará si la dirección no existe aquí, en lugar de llegar a su proveedor actual.`,
          remedy:
            'Si esa personalización no es necesaria, elimina esas claves en la administración de Stalwart y Mailway escribirá las suyas en la siguiente comprobación. Si lo es, añade a tus reglas las que se describen en docs/INTEGRACIONES.md («Recepción en otro proveedor»).',
        });
      } else {
        resolveAlert(ALERTA_PERSONALIZADA);
      }
      return r;
    }
    resolveAlert(ALERTA_PERSONALIZADA);

    if (r.errors.length > 0) {
      fireAlert({
        severity: 'warning',
        type: 'engine_recepcion',
        dedupeKey: ALERTA_RECARGA,
        title: 'El servidor de correo no ha aplicado la entrega de los dominios con el correo en otro proveedor',
        message: `La recarga de la configuración del motor ha devuelto errores, y con errores Stalwart no aplica ningún cambio hasta que se reinicia: ${r.errors.slice(0, 5).join(' · ')}`,
        remedy:
          'Corrige esos errores en la administración de Stalwart (o reinicia el contenedor del motor). Mailway vuelve a intentar la recarga en cada comprobación.',
      });
    } else if (r.changed || previo?.recargaPendiente) {
      resolveAlert(ALERTA_RECARGA, { notify: Boolean(previo?.recargaPendiente), what: 'entrega de los dominios con el correo en otro proveedor' });
    }
    setJsonSetting(CLAVE_ESTADO, { dominios, recargaPendiente: r.errors.length > 0, at: now() } satisfies EstadoRecepcion);
    return r;
  });
}
