import type { FastifyInstance } from 'fastify';
import { lookupA } from '../core/dns';
import { detectarIpPublica } from '../core/ippublica';
import { fireAlert, resolveAlertsOfType } from './alerts';
import { requireAdmin } from './auth';
import { getInstanceSettings } from './settings';

/**
 * IP pública de Ajustes frente a la IP con la que el servidor sale a
 * Internet. Tras una mudanza (o una IP nueva del proveedor), Ajustes conserva
 * la anterior hasta que alguien la corrige, y con ella Entregabilidad mide el
 * PTR y las listas negras de otra máquina. El vigilante lo comprueba una vez
 * al día y Ajustes lo consulta al abrirse; los dos con la misma regla, para
 * que la banda «Usar esta IP» aparezca exactamente cuando hay aviso.
 */

export const ALERTA_IP = 'public_ip_mismatch';

/**
 * ¿Se ha quedado atrás la IP guardada? Solo si el nombre del servidor de
 * correo ya no resuelve a ella: así no se molesta a un servidor con varias IP
 * (o detrás de NAT) que sale por una distinta de la que publica, y sí se
 * detecta una mudanza (el DNS ya apunta a la IP nueva y Ajustes sigue con la
 * anterior). Sin nombre del servidor no hay más dato que la diferencia.
 *
 * true: proponer la detectada; false: la guardada está bien; null: sin dato
 * (sin IP detectada o sin respuesta del DNS), no se decide nada.
 */
export function ipGuardadaDesfasada(
  detectada: string,
  guardada: string,
  mailHostname: string,
  registroA: string[] | null,
): boolean | null {
  if (!detectada || !guardada) return null;
  if (detectada === guardada) return false;
  if (!mailHostname) return true;
  if (registroA === null) return null;
  return !registroA.includes(guardada);
}

/** Abre, cierra o deja como está el aviso según la IP detectada y el A del servidor. */
export function evaluarIpPublica(detectada: string, registroA: string[] | null): void {
  const { publicIp, mailHostname } = getInstanceSettings();
  const guardada = publicIp.trim();
  const desfasada = ipGuardadaDesfasada(detectada, guardada, mailHostname, registroA);
  if (desfasada === null) return;
  if (!desfasada) {
    // También cuando el nombre vuelve a la IP guardada (DNS corregido hacia
    // atrás): el aviso ya no describe nada pendiente.
    resolveAlertsOfType(ALERTA_IP, { notify: true, what: 'IP pública del servidor' });
    return;
  }
  const clave = `${ALERTA_IP}:${detectada}`;
  resolveAlertsOfType(ALERTA_IP, { except: clave });
  fireAlert({
    severity: 'warning',
    type: ALERTA_IP,
    dedupeKey: clave,
    title: 'La IP pública del servidor ha cambiado',
    message: `El servidor sale a Internet con la IP ${detectada}${
      mailHostname && registroA && registroA.length > 0 ? ` y ${mailHostname} apunta a ${registroA.join(', ')}` : ''
    }, pero en Ajustes figura ${guardada}. Mientras no se corrija, Entregabilidad comprueba el registro inverso (PTR) y las listas negras de ${guardada}, y «DNS de la plataforma» propone registros A hacia ella.`,
    remedy:
      'Abre Ajustes → Identidad del servidor, pulsa «Usar esta IP» y guarda los cambios. Los dominios de webmail de marca blanca apuntados con CNAME al servidor de correo siguen funcionando mientras tanto.',
  });
}

export interface EstadoIpPublica {
  /** IP con la que el servidor sale a Internet ('' si no se ha podido saber). */
  detectada: string;
  guardada: string;
  mailHostname: string;
  /** Registro A del nombre del servidor de correo (null: sin dato). */
  registroA: string[] | null;
  /** La misma decisión que el aviso del vigilante. */
  proponer: boolean;
}

/** Detecta la IP de salida y consulta el A del servidor de correo, sin tocar los avisos. */
export async function medirIpPublica(): Promise<EstadoIpPublica> {
  const { publicIp, mailHostname } = getInstanceSettings();
  const guardada = publicIp.trim();
  const detectada = await detectarIpPublica();
  const registroA = detectada && mailHostname ? await lookupA(mailHostname) : null;
  return {
    detectada,
    guardada,
    mailHostname,
    registroA,
    proponer: ipGuardadaDesfasada(detectada, guardada, mailHostname, registroA) === true,
  };
}

/** Comprobación completa: la del vigilante (diaria) y la de después de guardar Ajustes. */
export async function revisarIpPublica(): Promise<void> {
  if (!getInstanceSettings().publicIp.trim()) return;
  const { detectada, registroA } = await medirIpPublica();
  evaluarIpPublica(detectada, registroA);
}

/**
 * Tras corregir la IP en Ajustes: el aviso abierto describe la IP anterior y
 * se cierra ya, sin esperar a la comprobación diaria. Se vuelve a medir en
 * segundo plano con la IP nueva; si tampoco es la buena, se abre de nuevo.
 */
export function alCambiarIpGuardada(): void {
  resolveAlertsOfType(ALERTA_IP);
  void revisarIpPublica().catch(() => undefined);
}

export function registerIpServidorRoutes(app: FastifyInstance): void {
  /** IP de salida frente a la de Ajustes, para la banda «Usar esta IP». */
  app.get('/api/settings/public-ip', async (req) => {
    requireAdmin(req);
    return await medirIpPublica();
  });
}
