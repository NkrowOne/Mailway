import net from 'node:net';

/**
 * Nombres de host: una sola definición de qué es un nombre de servidor válido
 * y de qué es un nombre interno. La usan Ajustes y la puesta en marcha, la
 * comprobación DNS de los dominios, el fichero de zona, Cloudflare y el envío
 * por SMTP: si cada uno lo decidiera a su manera, el panel aceptaría un nombre
 * que después la comprobación da por bueno y el fichero de zona publica roto.
 */

/** Forma canónica: sin espacios, en minúsculas y sin punto final (así llegan del DNS). */
export function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

/** Etiqueta DNS: de 1 a 63 letras, dígitos o guiones, sin guion al principio ni al final. */
const ETIQUETA = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * ¿Es un nombre completo (FQDN) que se puede usar como servidor de correo?
 * Al menos dos etiquetas, y la última de dos o más caracteres y no numérica:
 * «203.0.113.10» cumple la sintaxis de las etiquetas, pero una IPv4 no es un
 * nombre y ningún dominio de primer nivel es numérico (RFC 3696 §2). Los de
 * primer nivel internacionalizados (xn--p1ai) son etiquetas normales y valen.
 */
export function isValidHostname(value: string): boolean {
  const host = normalizeHostname(value);
  if (!host || host.length > 253) return false;
  const etiquetas = host.split('.');
  if (etiquetas.length < 2 || !etiquetas.every((e) => ETIQUETA.test(e))) return false;
  const ultima = etiquetas[etiquetas.length - 1]!;
  return ultima.length >= 2 && !/^\d+$/.test(ultima);
}

/**
 * ¿Es un nombre que solo existe dentro de Docker o de una red privada? Un
 * servicio de Docker o el identificador de un contenedor (sin punto),
 * `localhost`, una IP, una última etiqueta numérica o los sufijos reservados
 * para redes locales. Un MX así no recibe correo de Internet aunque el
 * registro «coincida», y un certificado público nunca lo cubre.
 */
export function isInternalHost(host: string): boolean {
  // Una IPv6 puede llegar entre corchetes, como en una URL.
  const h = normalizeHostname(host).replace(/^\[(.*)\]$/, '$1');
  if (!h) return false;
  if (net.isIP(h) !== 0 || h === 'localhost') return true;
  if (!h.includes('.')) return true;
  if (/\.\d+$/.test(h)) return true;
  return /\.(internal|local|localhost|localdomain|lan|docker|home\.arpa)$/.test(h);
}

/**
 * IPv6 en su forma comprimida canónica, para comparar direcciones escritas de
 * forma distinta (2001:0db8:0:0::1 y 2001:db8::1 son la misma). null si no es
 * una IPv6.
 */
export function canonicalIpv6(value: string): string | null {
  const ip = value.trim().replace(/^\[(.*)\]$/, '$1');
  if (!net.isIPv6(ip)) return null;
  try {
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}
