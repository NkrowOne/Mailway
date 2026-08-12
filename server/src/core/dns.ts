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
  try {
    const records = await publicResolver().resolveMx(domain);
    return records.sort((a, b) => a.priority - b.priority);
  } catch (err) {
    return isNoData(err) ? [] : null;
  }
}

export async function lookupTxt(name: string): Promise<string[] | null> {
  try {
    const chunks = await publicResolver().resolveTxt(name);
    return chunks.map((parts) => parts.join(''));
  } catch (err) {
    return isNoData(err) ? [] : null;
  }
}

export async function lookupA(name: string): Promise<string[] | null> {
  try {
    return await publicResolver().resolve4(name);
  } catch (err) {
    return isNoData(err) ? [] : null;
  }
}

export async function lookupCname(name: string): Promise<string[] | null> {
  try {
    return await publicResolver().resolveCname(name);
  } catch (err) {
    return isNoData(err) ? [] : null;
  }
}

export async function lookupSrv(
  name: string,
): Promise<{ priority: number; weight: number; port: number; name: string }[] | null> {
  try {
    return await publicResolver().resolveSrv(name);
  } catch (err) {
    return isNoData(err) ? [] : null;
  }
}

/** PTR inverso de una IP (imprescindible para enviar por el puerto 25). */
export async function lookupPtr(ip: string): Promise<string[] | null> {
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
