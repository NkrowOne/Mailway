import { Resolver } from 'node:dns/promises';

/**
 * Utilidades DNS para el asistente de dominios y el centro de entregabilidad.
 *
 * - Para registros normales (MX, TXT, A...) se usan resolutores públicos, que
 *   reflejan "lo que ve el mundo" y no cachés locales del servidor.
 * - Para listas negras (DNSBL) se usa el resolutor del sistema: Spamhaus y
 *   otros bloquean las consultas hechas a través de resolutores públicos.
 */

const PUBLIC_RESOLVERS = (process.env.MAILWAY_DNS_RESOLVERS || '1.1.1.1,8.8.8.8')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Modo sin red (pruebas): toda consulta devuelve «no se pudo consultar». Así
 * las rutas que verifican DNS se ejercitan sin depender de Internet ni de
 * esperas de varios segundos, y nunca se toma un fallo de red por un «no».
 */
export function dnsOffline(): boolean {
  return process.env.MAILWAY_DNS_OFFLINE === '1';
}

function publicResolver(): Resolver {
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  resolver.setServers(PUBLIC_RESOLVERS);
  return resolver;
}

function systemResolver(): Resolver {
  return new Resolver({ timeout: 5000, tries: 2 });
}

export interface MxRecord {
  priority: number;
  exchange: string;
}

/** null = no se pudo consultar (error de red); [] = el registro no existe. */
export async function lookupMx(domain: string): Promise<MxRecord[] | null> {
  if (dnsOffline()) return null;
  try {
    const records = await publicResolver().resolveMx(domain);
    return records.sort((a, b) => a.priority - b.priority);
  } catch (err) {
    return isNoData(err) ? [] : null;
  }
}

export async function lookupTxt(name: string): Promise<string[] | null> {
  if (dnsOffline()) return null;
  try {
    const chunks = await publicResolver().resolveTxt(name);
    return chunks.map((parts) => parts.join(''));
  } catch (err) {
    return isNoData(err) ? [] : null;
  }
}

export async function lookupA(name: string): Promise<string[] | null> {
  if (dnsOffline()) return null;
  try {
    return await publicResolver().resolve4(name);
  } catch (err) {
    return isNoData(err) ? [] : null;
  }
}

/** Direcciones IPv6 (AAAA). Los servidores que tienen IPv6 la prueban antes que la IPv4. */
export async function lookupAaaa(name: string): Promise<string[] | null> {
  if (dnsOffline()) return null;
  try {
    return await publicResolver().resolve6(name);
  } catch (err) {
    return isNoData(err) ? [] : null;
  }
}

export async function lookupCname(name: string): Promise<string[] | null> {
  if (dnsOffline()) return null;
  try {
    return await publicResolver().resolveCname(name);
  } catch (err) {
    return isNoData(err) ? [] : null;
  }
}

export async function lookupSrv(
  name: string,
): Promise<{ priority: number; weight: number; port: number; name: string }[] | null> {
  if (dnsOffline()) return null;
  try {
    return await publicResolver().resolveSrv(name);
  } catch (err) {
    return isNoData(err) ? [] : null;
  }
}

export interface CaaRecord {
  critical: number;
  issue?: string;
  issuewild?: string;
  iodef?: string;
}

/** Registros CAA del nombre (qué autoridades pueden emitir sus certificados). */
export async function lookupCaa(name: string): Promise<CaaRecord[] | null> {
  if (dnsOffline()) return null;
  try {
    return (await publicResolver().resolveCaa(name)) as CaaRecord[];
  } catch (err) {
    return isNoData(err) ? [] : null;
  }
}

/** Autoridad con la que Traefik (y el ACME del motor) piden los certificados. */
const LETS_ENCRYPT = 'letsencrypt.org';

export interface VeredictoCaa {
  /** ¿Puede Let's Encrypt emitir un certificado para el nombre? */
  permite: boolean;
  /** Nombre donde está el CAA que manda (el propio o un dominio padre), si hay. */
  nombre: string | null;
  /** Valores «issue» de ese CAA, para mostrarlos. */
  emisores: string[];
}

/**
 * ¿Permite el CAA que Let's Encrypt emita el certificado de `host`? Manda el
 * primer conjunto CAA que se encuentra subiendo desde el nombre hacia la raíz
 * (RFC 8659 §3); sin CAA en toda la cadena, o sin ninguna propiedad «issue»
 * en él, cualquier autoridad puede emitir. Un hosting anterior suele dejar
 * «0 issue "sectigo.com"» en el dominio: entonces Let's Encrypt se niega y
 * Traefik sirve su certificado por defecto. null si alguna consulta falla:
 * un corte de red no es un «no».
 */
export async function caaPermiteLetsEncrypt(host: string): Promise<VeredictoCaa | null> {
  const etiquetas = host.trim().toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  for (let i = 0; i < etiquetas.length; i++) {
    const nombre = etiquetas.slice(i).join('.');
    const caa = await lookupCaa(nombre);
    if (caa === null) return null;
    if (caa.length === 0) continue;
    const emisores = caa.filter((r) => typeof r.issue === 'string').map((r) => r.issue!.trim());
    if (emisores.length === 0) return { permite: true, nombre, emisores };
    const permite = emisores.some((v) => v.split(';')[0]!.trim().toLowerCase() === LETS_ENCRYPT);
    return { permite, nombre, emisores };
  }
  return { permite: true, nombre: null, emisores: [] };
}

/** Explicación común (autoconfiguración y marca blanca) de un CAA que no autoriza a Let's Encrypt. */
export function avisoCaa(host: string, v: VeredictoCaa): string {
  return (
    `El DNS de ${host} apunta a este servidor, pero el registro CAA de ${v.nombre} (${v.emisores.map((e) => `issue "${e}"`).join(', ')}) no autoriza a Let's Encrypt a emitir su certificado: ` +
    `sin él, los programas de correo y los navegadores recibirían un certificado que no es de ese nombre. Añade en ${v.nombre} el registro CAA «0 issue "letsencrypt.org"» (sin quitar los que necesites).`
  );
}

/** PTR inverso de una IP (imprescindible para enviar por el puerto 25). */
export async function lookupPtr(ip: string): Promise<string[] | null> {
  if (dnsOffline()) return null;
  try {
    return await systemResolver().reverse(ip);
  } catch (err) {
    return isNoData(err) ? [] : null;
  }
}

export type DnsblStatus = 'clean' | 'listed' | 'inconclusive';

export interface DnsblResult {
  zone: string;
  label: string;
  status: DnsblStatus;
  detail: string;
}

const DNSBL_ZONES: { zone: string; label: string }[] = [
  { zone: 'zen.spamhaus.org', label: 'Spamhaus ZEN' },
  { zone: 'bl.spamcop.net', label: 'SpamCop' },
  { zone: 'b.barracudacentral.org', label: 'Barracuda' },
];

/**
 * Consulta la IP contra las listas negras más relevantes. La consulta se hace
 * con la IP invertida bajo la zona de la lista; una respuesta A significa
 * "listado". Spamhaus devuelve 127.255.255.x cuando rechaza la consulta
 * (resolutor público o límite excedido): eso se marca como no concluyente.
 */
export async function checkDnsbl(ip: string): Promise<DnsblResult[]> {
  if (dnsOffline()) {
    return DNSBL_ZONES.map(({ zone, label }) => ({
      zone,
      label,
      status: 'inconclusive' as const,
      detail: 'Consulta desactivada (modo sin red).',
    }));
  }
  const reversed = ip.split('.').reverse().join('.');
  const resolver = systemResolver();
  return Promise.all(
    DNSBL_ZONES.map(async ({ zone, label }): Promise<DnsblResult> => {
      try {
        const answers = await resolver.resolve4(`${reversed}.${zone}`);
        const codes = answers.join(', ');
        if (zone.includes('spamhaus') && answers.some((a) => a.startsWith('127.255.255.'))) {
          return {
            zone,
            label,
            status: 'inconclusive',
            detail:
              'Spamhaus rechazó la consulta (resolutor público o límite de uso). Comprueba manualmente en check.spamhaus.org.',
          };
        }
        return {
          zone,
          label,
          status: 'listed',
          detail: `La IP aparece en la lista (respuesta ${codes}). Solicita la baja en la web de la lista.`,
        };
      } catch (err) {
        if (isNoData(err)) {
          return { zone, label, status: 'clean', detail: 'La IP no está en esta lista.' };
        }
        return {
          zone,
          label,
          status: 'inconclusive',
          detail: 'No se pudo consultar la lista (error de red o tiempo de espera).',
        };
      }
    }),
  );
}

/** NXDOMAIN / sin datos → el registro no existe (que es distinto de un fallo). */
function isNoData(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOTFOUND' || code === 'ENODATA';
}
