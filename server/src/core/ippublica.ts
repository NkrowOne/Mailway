import { dnsOffline } from './dns';

/**
 * IP pública con la que el servidor sale a Internet, preguntada a dos
 * servicios independientes: si uno falla o está bloqueado, el otro. La usan
 * el botón «Detectar» del asistente y de Ajustes y la comprobación diaria del
 * vigilante (un cambio de IP que nadie ha anotado en Ajustes).
 *
 * Devuelve '' si ninguno responde con una IPv4 (o en modo sin red, el de
 * las pruebas): nunca lanza.
 */
const FUENTES: (() => Promise<string>)[] = [
  async () => {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(6000) });
    return ((await res.json()) as { ip?: string }).ip || '';
  },
  async () => {
    const res = await fetch('https://ipv4.icanhazip.com', { signal: AbortSignal.timeout(6000) });
    return (await res.text()).trim();
  },
];

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

export async function detectarIpPublica(): Promise<string> {
  if (dnsOffline()) return '';
  for (const fuente of FUENTES) {
    try {
      const ip = (await fuente()).trim();
      if (IPV4_RE.test(ip)) return ip;
    } catch {
      // Se prueba la siguiente.
    }
  }
  return '';
}
