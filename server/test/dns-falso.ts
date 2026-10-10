import { Resolver } from 'node:dns/promises';
import type { TestContext } from 'node:test';

/**
 * DNS de mentira para las pruebas que necesitan respuestas concretas (un SPF
 * con «mx» detrás de «all», dos DMARC, un AAAA ajeno…). Sustituye los métodos
 * del resolutor de Node solo durante la prueba y desactiva el modo sin red
 * (MAILWAY_DNS_OFFLINE) mientras dura: nunca sale ninguna consulta real.
 *
 * Un nombre que no está en la zona responde como un resolutor real sin datos
 * (ENODATA), que la aplicación lee como «el registro no existe».
 */
export interface ZonaDns {
  mx?: Record<string, { priority: number; exchange: string }[]>;
  txt?: Record<string, string[]>;
  a?: Record<string, string[]>;
  aaaa?: Record<string, string[]>;
  srv?: Record<string, { priority: number; weight: number; port: number; name: string }[]>;
  cname?: Record<string, string[]>;
  /** Inversos por IP (PTR). */
  ptr?: Record<string, string[]>;
  caa?: Record<string, { critical: number; issue?: string; issuewild?: string; iodef?: string }[]>;
}

function sinDatos(nombre: string): never {
  throw Object.assign(new Error(`queryAny ENODATA ${nombre}`), { code: 'ENODATA' });
}

export function instalarDnsFalso(t: TestContext, zona: ZonaDns): void {
  const previo = process.env.MAILWAY_DNS_OFFLINE;
  process.env.MAILWAY_DNS_OFFLINE = '0';
  t.after(() => {
    if (previo === undefined) delete process.env.MAILWAY_DNS_OFFLINE;
    else process.env.MAILWAY_DNS_OFFLINE = previo;
  });
  const de = <T>(tabla: Record<string, T[]> | undefined, nombre: string): T[] => {
    const valor = tabla?.[nombre.toLowerCase().replace(/\.$/, '')];
    return valor ?? sinDatos(nombre);
  };
  t.mock.method(Resolver.prototype, 'resolveMx', async (n: string) => de(zona.mx, n));
  // Node devuelve cada TXT troceado en cadenas; aquí, una sola por registro.
  t.mock.method(Resolver.prototype, 'resolveTxt', async (n: string) => de(zona.txt, n).map((txt) => [txt]));
  t.mock.method(Resolver.prototype, 'resolve4', async (n: string) => de(zona.a, n));
  t.mock.method(Resolver.prototype, 'resolve6', async (n: string) => de(zona.aaaa, n));
  t.mock.method(Resolver.prototype, 'resolveSrv', async (n: string) => de(zona.srv, n));
  t.mock.method(Resolver.prototype, 'resolveCname', async (n: string) => de(zona.cname, n));
  t.mock.method(Resolver.prototype, 'reverse', async (ip: string) => de(zona.ptr, ip));
  t.mock.method(Resolver.prototype, 'resolveCaa', async (n: string) => de(zona.caa, n));
}
