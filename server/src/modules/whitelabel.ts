import crypto from 'node:crypto';
import https from 'node:https';
import { domainToUnicode } from 'node:url';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { db, now } from '../core/db';
import { randomId } from '../core/crypto';
import { clientLockKey, withLock } from '../core/locks';
import { avisoCaa, caaPermiteLetsEncrypt, dnsOffline, lookupA, lookupCname } from '../core/dns';
import { badRequest, conflict, notFound } from '../core/errors';
import { resolveAlert } from './alerts';
import { audit, auditSystem } from './audit';
import { requireAdmin, requireAuth, requireClientAccess, type AuthedUser } from './auth';
import {
  autoconfigRoutingAvailable,
  routedAutoconfigHosts,
  runningUnderSkyway,
} from './autoconfig';
import { instanceAutoconfigBase, publicBaseUrl, webmailUrlForClient } from './connection';
import { getInstanceSettings, getSetting, setSetting } from './settings';
import { clientesConBulwarkEnServicio, estadoBulwark, motorCorreoWebDe } from './webmailmotor';

export type DomainKind = 'webmail' | 'panel';
export type DomainStatus = 'pending_dns' | 'issuing' | 'active' | 'error';

export interface ClientDomain {
  id: string;
  clientId: string;
  hostname: string;
  kind: DomainKind;
  status: DomainStatus;
  detail: string;
  lastCheckedAt: number | null;
  activatedAt: number | null;
  createdAt: number;
  isPrimary: boolean;
  /** Lo dio de alta el webmail automático (no una persona). */
  automatico: boolean;
}

interface DomainRow {
  id: string;
  client_id: string;
  hostname: string;
  kind: DomainKind;
  status: DomainStatus;
  detail: string;
  last_checked_at: number | null;
  activated_at: number | null;
  created_at: number;
  is_primary: number;
  automatico: number;
}

function toDomain(row: DomainRow): ClientDomain {
  return {
    id: row.id,
    clientId: row.client_id,
    hostname: row.hostname,
    kind: row.kind,
    status: row.status,
    detail: row.detail,
    lastCheckedAt: row.last_checked_at,
    activatedAt: row.activated_at,
    createdAt: row.created_at,
    isPrimary: row.is_primary === 1,
    automatico: row.automatico === 1,
  };
}

export function getClientDomain(id: string): ClientDomain {
  const row = db.prepare('SELECT * FROM client_domains WHERE id = ?').get(id) as
    | DomainRow
    | undefined;
  if (!row) throw notFound('Dominio no encontrado.');
  return toDomain(row);
}

export function listClientDomains(clientId?: string): ClientDomain[] {
  const rows = clientId
    ? (db
        .prepare('SELECT * FROM client_domains WHERE client_id = ? ORDER BY created_at DESC')
        .all(clientId) as DomainRow[])
    : (db.prepare('SELECT * FROM client_domains ORDER BY created_at DESC').all() as DomainRow[]);
  return rows.map(toDomain);
}

/**
 * Un único destino para todos los accesos del cliente, nunca el de otro
 * cliente. La consulta vive en connection.ts (webmailPropio) para que el
 * inicio, los datos de conexión, la autoconfiguración y el portal digan lo
 * mismo.
 */
export function getClientWebmailUrl(clientId: string): string {
  return webmailUrlForClient(clientId);
}

export function setPrimaryWebmail(id: string): ClientDomain {
  const domain = getClientDomain(id);
  if (domain.kind !== 'webmail' || domain.status !== 'active') {
    throw badRequest('Comprueba primero que este dominio de webmail funciona con HTTPS.', 'webmail_not_active');
  }
  db.transaction(() => {
    db.prepare("UPDATE client_domains SET is_primary = 0 WHERE client_id = ? AND kind = 'webmail'")
      .run(domain.clientId);
    db.prepare('UPDATE client_domains SET is_primary = 1 WHERE id = ?').run(id);
  })();
  return getClientDomain(id);
}

const HOSTNAME_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function normalizeHostname(input: string): string {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
  if (!HOSTNAME_RE.test(host)) {
    throw badRequest(
      'El dominio no es válido. Escribe solo el nombre, por ejemplo: webmail.tuempresa.com',
    );
  }
  return host;
}

/** Backend al que Traefik debe enviar el tráfico de cada tipo de dominio (sin mirar el cliente). */
function backendDelTipo(kind: DomainKind): string {
  return kind === 'webmail' ? config.traefik.webmailBackend : config.traefik.panelBackend;
}

export function kindAvailable(kind: DomainKind): boolean {
  return Boolean(backendDelTipo(kind));
}

/**
 * Servicio y destino de Traefik para un nombre concreto. Los webmail de un
 * cliente con el correo web nuevo van a Bulwark (su pasarela) mientras se
 * pueda servir (`conBulwark`: Bulwark disponible y Stalwart 0.16); si no,
 * a Roundcube, como los de los demás clientes: nunca se quedan sin destino.
 * La dirección general del webmail no pasa por aquí y sigue en Roundcube.
 */
export function backendFor(
  row: { kind: DomainKind; client_id: string },
  conBulwark: ReadonlySet<string>,
): { servicio: string; url: string } | null {
  if (row.kind === 'webmail' && conBulwark.has(row.client_id) && config.bulwark.backendUrl) {
    return { servicio: 'mailway-bulwark', url: config.bulwark.backendUrl };
  }
  const url = backendDelTipo(row.kind);
  return url ? { servicio: `mailway-${row.kind}`, url } : null;
}

/**
 * Un webmail de un cliente con el correo web nuevo ha entrado en servicio o
 * ha salido: su marca en Bulwark tiene que seguirlo (sin esperar al vigilante).
 */
function avisarCorreoWeb(clientId: string): void {
  if (motorCorreoWebDe(clientId) !== 'bulwark') return;
  // Importación diferida: correoweb.ts carga engineops, que acaba cargando este módulo.
  void import('./correoweb').then((m) => m.programarSincronizacionBulwark()).catch(() => undefined);
}

/** Dominios propios por cliente: cada uno supone un certificado y un router más. */
export const MAX_WHITELABEL_PER_CLIENT = 5;

/** Primeras etiquetas que usa la autoconfiguración (las enruta el propio panel). */
const RESERVED_LABELS = new Set(['autoconfig', 'autodiscover', 'mta-sts']);

function hostOf(url: string): string {
  try {
    return url ? new URL(url).hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

/**
 * Un dominio propio solo puede ser un subdominio de un dominio de correo del
 * MISMO cliente ya verificado. Traefik enruta cualquier host que se le
 * publique: sin esta regla, un cliente podría dar de alta el nombre de otra
 * aplicación servida en este servidor (su DNS ya apunta aquí, así que la
 * comprobación pasaría) y quedarse con su tráfico. Que la propiedad del
 * dominio de correo esté comprobada demuestra que el cliente controla su DNS.
 */
export function assertHostnameAllowed(clientId: string, hostname: string): void {
  const firstLabel = hostname.split('.')[0]!;
  if (RESERVED_LABELS.has(firstLabel)) {
    throw badRequest(
      `Los nombres que empiezan por «${firstLabel}.» están reservados para la configuración automática de los programas de correo. Elige otro, por ejemplo webmail.`,
      'reserved_hostname',
    );
  }
  const instance = getInstanceSettings();
  const base = instanceAutoconfigBase(instance.mailHostname);
  const propios = new Set(
    [
      instance.mailHostname.toLowerCase(),
      hostOf(instance.panelUrl),
      hostOf(instance.webmailUrl),
      base ? `autoconfig.${base}` : '',
      base ? `autodiscover.${base}` : '',
    ].filter(Boolean),
  );
  if (propios.has(hostname)) {
    throw badRequest(
      'Ese nombre lo utiliza el propio servidor de correo. Elige un subdominio distinto, por ejemplo webmail.tuempresa.com',
      'reserved_hostname',
    );
  }

  const domains = db
    .prepare('SELECT domain, owner_verified_at FROM domains WHERE client_id = ?')
    .all(clientId) as { domain: string; owner_verified_at: number | null }[];
  // El más específico primero, por si el cliente tiene a la vez un dominio y un subdominio suyo.
  const parent = domains
    .filter((d) => hostname.endsWith(`.${d.domain}`))
    .sort((a, b) => b.domain.length - a.domain.length)[0];
  if (!parent) {
    throw badRequest(
      domains.length === 0
        ? 'Este cliente todavía no tiene dominios de correo. Añade y verifica primero su dominio en «Dominios».'
        : `El nombre debe ser un subdominio de uno de los dominios de correo del cliente (${domains
            .map((d) => d.domain)
            .slice(0, 5)
            .join(', ')}), por ejemplo webmail.${domains[0]!.domain}`,
      'hostname_not_owned',
    );
  }
  // «webmail.cliente.es» escrito como subdominio de cliente.es da
  // webmail.cliente.es.cliente.es: es un subdominio válido, pero nadie va a
  // crear su DNS y gastaría una de las plazas del cliente.
  const prefijo = hostname.slice(0, -(parent.domain.length + 1));
  const repetido = domains.find((d) => prefijo === d.domain || prefijo.endsWith(`.${d.domain}`));
  if (repetido) {
    throw badRequest(
      `El nombre ${hostname} repite el dominio ${domainToUnicode(repetido.domain) || repetido.domain}. Si el webmail debe estar en ${prefijo}, indica ese nombre.`,
      'hostname_repeats_domain',
    );
  }
  // Lo que cuenta es la PROPIEDAD comprobada (MX a este servidor o TXT de
  // verificación), no que el dominio esté activo: es lo que demuestra que el
  // cliente controla el DNS del que cuelga el nombre.
  if (parent.owner_verified_at === null) {
    throw badRequest(
      `Todavía no se ha comprobado la propiedad del dominio de correo ${domainToUnicode(parent.domain) || parent.domain}. Compruébala primero en su ficha, en «Dominios».`,
      'domain_not_verified',
    );
  }
}

/**
 * Configuración exacta de Traefik para sondear este panel directamente (sin
 * el puente de Skyway). Compose sustituye `command` entero, así que se
 * repiten los parámetros con los que Skyway arranca Traefik.
 */
export function traefikOverrideSnippet(endpoint: string, token: string, certResolver: string): string {
  const r = certResolver || 'le';
  return `# docker-compose.override.yml (en la carpeta de Skyway).
# Solo para Skyway anterior a 0.34 o un Traefik propio: con Skyway 0.34 o
# posterior NO lo instales, porque sustituiría el puente que ya incluye.
services:
  traefik:
    command:
      # --- parámetros de Skyway (deben mantenerse) ---
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.docker.network=skyway-edge
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.${r}.acme.email=\${LETSENCRYPT_EMAIL:-noreply@example.com}
      - --certificatesresolvers.${r}.acme.storage=/letsencrypt/acme.json
      - --certificatesresolvers.${r}.acme.httpchallenge=true
      - --certificatesresolvers.${r}.acme.httpchallenge.entrypoint=web
      # --- añadido para Mailway: marca blanca y autoconfiguración ---
      - --providers.http.endpoint=${endpoint}
      - --providers.http.pollInterval=15s
      - --providers.http.pollTimeout=10s
      - --providers.http.headers.X-Mailway-Token=${token}
`;
}

/** URL por la que Traefik llega a /api/traefik/config de este panel. */
function traefikProviderEndpoint(req: FastifyRequest): string {
  const internal = config.traefik.panelBackend.replace(/\/+$/, '');
  if (internal) return `${internal}/api/traefik/config`;
  const pub = publicBaseUrl(req);
  return `${pub || 'http://mailway-panel:4100'}/api/traefik/config`;
}

/* ------------------------- Instrucciones de DNS --------------------------- */

export interface DnsInstruction {
  type: 'A' | 'CNAME';
  name: string;
  value: string;
  recommended: boolean;
  help: string;
}

/**
 * Los dos caminos válidos para apuntar un dominio propio a este servidor.
 * El CNAME es preferible porque si algún día cambia la IP, no hay que tocar
 * el DNS de cada cliente.
 */
export function dnsInstructions(hostname: string): DnsInstruction[] {
  const instance = getInstanceSettings();
  const out: DnsInstruction[] = [];
  if (instance.mailHostname) {
    out.push({
      type: 'CNAME',
      name: hostname,
      value: `${instance.mailHostname}.`,
      recommended: true,
      help: 'Opción recomendada: si algún día se cambia de servidor, no será necesario modificar este registro.',
    });
  }
  if (instance.publicIp) {
    out.push({
      type: 'A',
      name: hostname,
      value: instance.publicIp,
      recommended: !instance.mailHostname,
      help: 'Alternativa: apunta directamente a la IP del servidor. Funciona igual, pero habría que modificarlo si se cambia de servidor.',
    });
  }
  return out;
}

/* --------------------------- Comprobaciones ------------------------------- */

/**
 * Tres estados, no dos. `unknown` («no se pudo consultar») NO es lo mismo que
 * `failed` («el registro no está o apunta a otro sitio»): confundirlos hace
 * que un corte de red pase por avería del cliente.
 */
export interface DnsCheckResult {
  status: 'ok' | 'failed' | 'unknown';
  detail: string;
  /** Apunta aquí a través del proxy de Cloudflare (comprobado con su API). */
  viaCloudflare?: boolean;
}

/**
 * Rangos IPv4 del proxy de Cloudflare (https://www.cloudflare.com/ips-v4).
 * Un nombre que resuelve a ellos tiene la nube naranja: el tráfico llega a
 * Cloudflare y no directamente a este servidor.
 */
const RANGOS_CLOUDFLARE: readonly [string, number][] = [
  ['173.245.48.0', 20], ['103.21.244.0', 22], ['103.22.200.0', 22], ['103.31.4.0', 22],
  ['141.101.64.0', 18], ['108.162.192.0', 18], ['190.93.240.0', 20], ['188.114.96.0', 20],
  ['197.234.240.0', 22], ['198.41.128.0', 17], ['162.158.0.0', 15], ['104.16.0.0', 13],
  ['104.24.0.0', 14], ['172.64.0.0', 13], ['131.0.72.0', 22],
];

function ipANumero(ip: string): number | null {
  const partes = ip.split('.');
  if (partes.length !== 4) return null;
  let n = 0;
  for (const parte of partes) {
    const octeto = Number(parte);
    if (!/^\d{1,3}$/.test(parte) || octeto > 255) return null;
    n = n * 256 + octeto;
  }
  return n;
}

export function esIpDeCloudflare(ip: string): boolean {
  const n = ipANumero(ip);
  if (n === null) return false;
  return RANGOS_CLOUDFLARE.some(([base, bits]) => {
    const tamano = 2 ** (32 - bits);
    const inicio = ipANumero(base)!;
    return n >= inicio && n < inicio + tamano;
  });
}

/**
 * Por qué un dominio de marca blanca resuelve a otras IP. «Apunta a … en
 * lugar de a …» despista en los dos casos más comunes con Cloudflare: que el
 * nombre no tenga registro propio y responda el comodín del dominio (el de
 * la web, casi siempre con proxy), o que tenga el proxy activo y no haya
 * forma de saber adónde apunta. En ninguno de los dos hay un valor que
 * corregir en el registro.
 */
export function detalleIpAjena(opts: {
  hostname: string;
  ips: string[];
  publicIp: string;
  mailHostname: string;
  /** El nombre lo responde un comodín (*.padre), no un registro propio. */
  comodin: boolean;
  /**
   * Con las IP de Cloudflare: si hay una cuenta conectada que ve la zona
   * (entonces se ha comprobado y el registro no apunta aquí) o no la hay.
   */
  cuentaCloudflare?: boolean;
}): string {
  const { hostname, ips, publicIp, mailHostname, comodin, cuentaCloudflare = false } = opts;
  const conProxy = ips.length > 0 && ips.every(esIpDeCloudflare);
  const padre = hostname.split('.').slice(1).join('.');
  const registro = mailHostname
    ? `un registro CNAME para ${hostname} que apunte a ${mailHostname}`
    : `un registro A para ${hostname} con la IP ${publicIp}`;
  if (comodin && conProxy && cuentaCloudflare) {
    return `${hostname} no tiene registro propio: responde el comodín *.${padre}, que tiene activo el proxy de Cloudflare. Crea ${registro}; «Configurar en Cloudflare» lo crea con el proxy activo.`;
  }
  if (comodin && conProxy) {
    return `${hostname} no tiene registro propio: responde el comodín *.${padre}, que tiene activo el proxy de Cloudflare (nube naranja). Crea ${registro} sin proxy (solo DNS, nube gris), o conecta en Conexiones la cuenta de Cloudflare de la zona para usarlo con proxy.`;
  }
  if (comodin) {
    return `${hostname} no tiene registro propio: responde el comodín *.${padre}, que apunta a ${ips.join(', ')}. Crea ${registro}.`;
  }
  if (conProxy && cuentaCloudflare) {
    return `El registro de ${hostname} tiene activo el proxy de Cloudflare, pero no apunta a este servidor: debe ser ${registro}.`;
  }
  if (conProxy) {
    return `El registro de ${hostname} tiene activo el proxy de Cloudflare (nube naranja) y no hay una cuenta de Cloudflare conectada que vea su zona para comprobar adónde apunta. Conéctala en Conexiones o desactiva el proxy (solo DNS, nube gris).`;
  }
  return `El dominio apunta a ${ips.join(', ')} en lugar de a ${publicIp}. Corrige el registro.`;
}

/**
 * ¿Responde un comodín por este nombre? Se pregunta por un nombre hermano
 * que no puede existir: si resuelve a las mismas IP, no hay registro propio.
 * Ante la duda (sin red, nombre de primer nivel) se responde que no.
 */
async function respondeComodin(hostname: string, ips: string[]): Promise<boolean> {
  const padre = hostname.split('.').slice(1).join('.');
  if (!padre.includes('.')) return false;
  const sonda = await lookupA(`mailway-sonda-${crypto.randomBytes(4).toString('hex')}.${padre}`);
  if (!sonda || sonda.length === 0) return false;
  const vistas = new Set(sonda);
  return ips.length === vistas.size && ips.every((ip) => vistas.has(ip));
}

function sinPuntoFinal(nombre: string): string {
  return nombre.trim().toLowerCase().replace(/\.$/, '');
}

// Con un CAA que no autoriza a Let's Encrypt, Traefik no consigue el
// certificado y serviría el suyo por defecto: no se publica hasta corregirlo.
async function conCaa(hostname: string, detalleOk: string): Promise<DnsCheckResult> {
  const caa = await caaPermiteLetsEncrypt(hostname);
  if (caa && !caa.permite) return { status: 'failed', detail: avisoCaa(hostname, caa) };
  return { status: 'ok', detail: detalleOk };
}

/**
 * ¿Apunta el dominio a este servidor? Vale un CNAME al servidor de correo (lo
 * que recomiendan las instrucciones) o un A con una IP del servidor: la IP de
 * Ajustes o cualquiera de las que tiene ahora el nombre del servidor de
 * correo. Así, tras un cambio de IP, un CNAME (o un A ya movido a la IP
 * nueva) sigue siendo correcto aunque Ajustes aún tenga la IP anterior: si
 * dependiera solo de la IP guardada, el vigilante sacaría de Traefik el
 * webmail de marca blanca de todos los clientes en plena mudanza. Con el
 * proxy de Cloudflare resuelve a IP de Cloudflare: entonces se pregunta a
 * Cloudflare adónde apunta el registro (registroProxyApuntaAqui), si se
 * conoce el dominio propio (`domain`).
 *
 * `resolve4` sigue la cadena de CNAME, así que lookupA da las IP finales.
 */
export async function comprobarDnsMarcaBlanca(hostname: string, domain?: ClientDomain): Promise<DnsCheckResult> {
  const instance = getInstanceSettings();
  const servidor = sinPuntoFinal(instance.mailHostname);
  const ipGuardada = instance.publicIp.trim();
  if (!servidor && !ipGuardada) {
    return {
      status: 'unknown',
      detail:
        'Faltan el nombre del servidor de correo y la IP pública en Ajustes: sin ellos no es posible comprobar si el dominio apunta aquí.',
    };
  }
  const [ips, cname, ipsServidor] = await Promise.all([
    lookupA(hostname),
    lookupCname(hostname),
    servidor ? lookupA(servidor) : Promise.resolve([] as string[]),
  ]);
  if (ips === null) {
    return {
      status: 'unknown',
      detail: 'No se ha podido consultar el DNS en este momento. Vuelve a intentarlo en un minuto.',
    };
  }
  if (ips.length === 0) {
    if (cname && cname.length > 0) {
      return {
        status: 'failed',
        detail: `El dominio apunta a ${cname.join(', ')}, pero ese nombre todavía no resuelve a ninguna IP.`,
      };
    }
    return {
      status: 'failed',
      detail: 'El dominio todavía no existe en el DNS. Crea el registro y espera unos minutos.',
    };
  }
  if (servidor && cname?.some((c) => sinPuntoFinal(c) === servidor)) {
    return conCaa(hostname, `El dominio apunta correctamente a ${servidor}.`);
  }
  // Sin el dominio propio (una comprobación suelta) no hay cuenta de
  // Cloudflare que consultar: con el proxy activo no se sabe adónde apunta.
  const destino = domain ?? ({ hostname } as ClientDomain);
  const veredicto = await evaluarIps(
    destino,
    ips,
    { publicIp: ipGuardada, mailHostname: instance.mailHostname, ipsServidor },
    {
      proxyApuntaAqui: async (d) => {
        if (!domain) return null;
        // Importación diferida: cloudflare.ts ya importa este módulo.
        const { registroProxyApuntaAqui } = await import('./cloudflare');
        return registroProxyApuntaAqui(d);
      },
      respondeComodin,
    },
  );
  // Con un CAA que no autoriza a Let's Encrypt, Traefik no consigue el
  // certificado: no se da por bueno. Detrás del proxy de Cloudflare el
  // visitante ve el certificado de Cloudflare y no se mira.
  if (veredicto.status === 'ok' && !veredicto.viaCloudflare) return conCaa(hostname, veredicto.detail);
  return veredicto;
}

/** Comprobación del DNS de un dominio propio, con su cuenta de Cloudflare si hace falta. */
function checkDns(domain: ClientDomain): Promise<DnsCheckResult> {
  return comprobarDnsMarcaBlanca(domain.hostname, domain);
}

/**
 * Veredicto del DNS a partir de las IP a las que resuelve el nombre. Aparte
 * de checkDns para probarlo sin red: las consultas a Cloudflare y al
 * comodín llegan como funciones. Valen la IP de Ajustes y las que tiene
 * ahora el nombre del servidor de correo (`ipsServidor`; null si no se
 * pudieron consultar: entonces, sin coincidencia, no es concluyente).
 */
export async function evaluarIps(
  domain: ClientDomain,
  ips: string[],
  instance: { publicIp: string; mailHostname: string; ipsServidor?: string[] | null },
  deps: {
    proxyApuntaAqui: (domain: ClientDomain) => Promise<boolean | null>;
    respondeComodin: (hostname: string, ips: string[]) => Promise<boolean>;
  },
): Promise<DnsCheckResult> {
  const hostname = domain.hostname;
  const validas = [...new Set([instance.publicIp, ...(instance.ipsServidor ?? [])].map((ip) => ip.trim()).filter(Boolean))];
  const coincide = ips.find((ip) => validas.includes(ip));
  if (coincide) {
    return { status: 'ok', detail: `El dominio apunta correctamente a ${coincide}.` };
  }
  let cuentaCloudflare = false;
  if (ips.length > 0 && ips.every(esIpDeCloudflare)) {
    const apunta = await deps.proxyApuntaAqui(domain);
    if (apunta) {
      return {
        status: 'ok',
        detail: 'El dominio apunta a este servidor a través del proxy de Cloudflare.',
        viaCloudflare: true,
      };
    }
    cuentaCloudflare = apunta === false;
  } else if (instance.ipsServidor === null) {
    // Sin las IP del servidor de correo no se sabe si la del dominio es suya
    // (puede ser la nueva tras un cambio de IP): no concluyente, no un fallo.
    return {
      status: 'unknown',
      detail: `No se ha podido consultar el DNS de ${sinPuntoFinal(instance.mailHostname)} para comparar las IP. Vuelve a intentarlo en un minuto.`,
    };
  }
  return {
    status: 'failed',
    detail: detalleIpAjena({
      hostname,
      ips,
      publicIp: instance.publicIp,
      mailHostname: instance.mailHostname,
      comodin: await deps.respondeComodin(hostname, ips),
      cuentaCloudflare,
    }),
  };
}

/**
 * ¿La redirección lleva a la misma página por HTTPS? Es el síntoma del modo
 * «Flexible» de Cloudflare: le habla a este servidor por HTTP y Traefik lo
 * redirige a HTTPS, que vuelve a llegar por HTTP. Sin esto, el 301 contaría
 * como «responde» y el webmail quedaría en servicio sin poder abrirse.
 */
export function redirigeASiMismo(hostname: string, location: string | null): boolean {
  if (!location) return false;
  try {
    const destino = new URL(location, `https://${hostname}/`);
    // Solo la misma dirección exacta: un salto de «/» a «/?_task=login» es una
    // redirección normal de la aplicación, no un bucle.
    return (
      destino.protocol === 'https:' && destino.hostname === hostname && destino.pathname === '/' && destino.search === ''
    );
  } catch {
    return false;
  }
}

/**
 * Comprueba que Traefik ya sirve el dominio con un certificado válido. Se hace
 * una petición HTTPS real: si el certificado aún no está emitido, falla el
 * handshake y sabemos que sigue en proceso.
 */
export async function checkHttps(hostname: string): Promise<{ ok: boolean; detail: string }> {
  if (dnsOffline()) return { ok: false, detail: 'Comprobación HTTPS desactivada (modo sin red).' };
  try {
    const res = await fetch(`https://${hostname}/`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    if (res.status >= 300 && res.status < 400 && redirigeASiMismo(hostname, res.headers.get('location'))) {
      return {
        ok: false,
        detail:
          'HTTPS redirige a la misma dirección sin fin. Con el proxy de Cloudflare, cambia el modo de cifrado SSL/TLS a «Completo» o «Completo (estricto)»: en «Flexible», Cloudflare llega a este servidor por HTTP y este lo devuelve a HTTPS una y otra vez.',
      };
    }
    if (res.status >= 200 && res.status < 400) {
      return { ok: true, detail: `HTTPS responde correctamente (HTTP ${res.status}).` };
    }
    return {
      ok: false,
      detail: res.status === 404
        ? 'HTTPS responde con 404. Revisa la ruta de este dominio en Skyway y la conexión de Traefik con Mailway en Ajustes.'
        : `HTTPS responde con HTTP ${res.status}. Revisa el servicio y su destino en Skyway.`,
    };
  } catch (err) {
    const message = (err as Error).message || '';
    const cause = String((err as { cause?: unknown }).cause ?? '');
    const text = `${message} ${cause}`.toLowerCase();
    if (text.includes('certificate') || text.includes('altname') || text.includes('tls')) {
      return {
        ok: false,
        detail:
          'El certificado todavía no está emitido. Let\'s Encrypt suele tardar menos de un minuto; vuelve a comprobarlo.',
      };
    }
    if (text.includes('timeout') || text.includes('aborted')) {
      return {
        ok: false,
        detail:
          'No se ha recibido respuesta a tiempo. Si el DNS acaba de cambiar, espera a que se propague y vuelve a intentarlo.',
      };
    }
    return {
      ok: false,
      detail: `Todavía no responde por HTTPS (${message.slice(0, 120)}). Vuelve a intentarlo en un minuto.`,
    };
  }
}

/** Lo que interesa de una respuesta HEAD, o el error si no la hubo. */
export type RespuestaHead =
  | { status: number; location: string | null; mitigada: boolean }
  | { error: Error };

/**
 * HEAD directamente a este servidor (su IP pública), con el nombre en el SNI
 * y en Host: lo que ve Cloudflare al llegar al origen, sin pasar por él. El
 * certificado se valida contra el nombre, como hace Cloudflare en «Completo
 * (estricto)».
 */
export function headAlOrigen(
  hostname: string,
  ip: string,
  // Solo para las pruebas: un servidor local en otro puerto y con su propia CA.
  opciones: { puerto?: number; ca?: string } = {},
): Promise<RespuestaHead> {
  return new Promise((resolve) => {
    let terminado = false;
    const terminar = (r: RespuestaHead) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(limite);
      resolve(r);
    };
    const req = https.request(
      {
        host: ip,
        port: opciones.puerto ?? 443,
        method: 'HEAD',
        path: '/',
        servername: hostname,
        headers: { host: hostname },
        // También mientras conecta, no solo cuando ya hay conexión.
        timeout: 8000,
        ...(opciones.ca ? { ca: opciones.ca } : {}),
      },
      (res) => {
        res.resume();
        const location = res.headers.location;
        terminar({ status: res.statusCode ?? 0, location: typeof location === 'string' ? location : null, mitigada: false });
      },
    );
    // Un tope total, por si el servidor acepta la conexión y no contesta nunca.
    const limite = setTimeout(() => req.destroy(new Error('timeout')), 10_000);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => terminar({ error }));
    req.end();
  });
}

/** HEAD por el camino de cualquier visitante: el DNS público, es decir, Cloudflare. */
async function headPublico(hostname: string): Promise<RespuestaHead> {
  try {
    const res = await fetch(`https://${hostname}/`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    // Cloudflare marca así las respuestas de su protección (desafío o bloqueo).
    return { status: res.status, location: res.headers.get('location'), mitigada: res.headers.has('cf-mitigated') };
  } catch (err) {
    return { error: err as Error };
  }
}

function textoDeError(err: Error): string {
  const cause = String((err as { cause?: unknown }).cause ?? '');
  const code = String((err as { code?: unknown }).code ?? '');
  return `${err.message || ''} ${cause} ${code}`.toLowerCase();
}

/**
 * HTTPS de un dominio detrás del proxy de Cloudflare. Se comprueba primero
 * este servidor directamente: es lo que depende de Mailway (la ruta en
 * Traefik y el certificado). Luego, el camino de los visitantes, solo para
 * lo que añade Cloudflare: el bucle del modo «Flexible» y sus errores 52x.
 * Que Cloudflare desafíe o bloquee a esta comprobación automática (protección
 * contra bots, modo «Bajo ataque») no la hace fallar: si contara, activar la
 * protección sacaría el webmail de servicio y el panel volvería al general.
 */
export async function checkHttpsDetrasDeCloudflare(
  hostname: string,
  publicIp: string,
  deps: {
    origen: (hostname: string, ip: string) => Promise<RespuestaHead>;
    publico: (hostname: string) => Promise<RespuestaHead>;
  } = { origen: headAlOrigen, publico: headPublico },
): Promise<{ ok: boolean; detail: string }> {
  const origen = await deps.origen(hostname, publicIp);
  if ('error' in origen) {
    const texto = textoDeError(origen.error);
    if (texto.includes('certificate') || texto.includes('altname') || texto.includes('cert_') || texto.includes('self-signed') || texto.includes('self signed')) {
      return {
        ok: false,
        detail:
          'El certificado de este servidor para el dominio todavía no está emitido. Let\'s Encrypt suele tardar menos de un minuto; vuelve a comprobarlo.',
      };
    }
    if (texto.includes('timeout') || texto.includes('aborted')) {
      return { ok: false, detail: 'Este servidor no ha respondido a tiempo por HTTPS. Vuelve a intentarlo en un minuto.' };
    }
    return {
      ok: false,
      detail: `Este servidor todavía no responde por HTTPS para el dominio (${origen.error.message.slice(0, 120)}). Vuelve a intentarlo en un minuto.`,
    };
  }
  if (origen.status === 404) {
    return {
      ok: false,
      detail:
        'Este servidor responde con 404 para el dominio: su ruta aún no está publicada. Si acaba de entrar, espera unos segundos; si no, revisa la conexión de Traefik con Mailway en Ajustes.',
    };
  }
  if (origen.status < 200 || origen.status >= 400) {
    return { ok: false, detail: `Este servidor responde con HTTP ${origen.status} para el dominio. Revisa el servicio del webmail.` };
  }

  const publico = await deps.publico(hostname);
  if ('error' in publico) {
    return {
      ok: true,
      detail: 'HTTPS responde en este servidor. No se ha podido comprobar el camino a través de Cloudflare en este momento.',
    };
  }
  if (publico.status >= 300 && publico.status < 400 && redirigeASiMismo(hostname, publico.location)) {
    return {
      ok: false,
      detail:
        'A través de Cloudflare, HTTPS redirige a la misma dirección sin fin. Cambia el modo de cifrado SSL/TLS de la zona a «Completo» o «Completo (estricto)»: en «Flexible», Cloudflare llega a este servidor por HTTP y este lo devuelve a HTTPS una y otra vez.',
    };
  }
  if (publico.status >= 200 && publico.status < 400) {
    return { ok: true, detail: `HTTPS responde correctamente a través de Cloudflare (HTTP ${publico.status}).` };
  }
  if (publico.mitigada || publico.status === 403 || publico.status === 429) {
    return {
      ok: true,
      detail:
        'HTTPS responde en este servidor. Cloudflare aplica su protección a esta comprobación automática, así que no se ha comprobado su camino; los visitantes pasan por esa protección.',
    };
  }
  if (publico.status === 526 || publico.status === 525) {
    return {
      ok: false,
      detail: `Cloudflare no acepta la conexión segura con este servidor (HTTP ${publico.status}). Si el certificado se acaba de emitir, vuelve a comprobarlo en un minuto; si no, revisa el modo SSL/TLS de la zona.`,
    };
  }
  if (publico.status >= 520 && publico.status <= 530) {
    return {
      ok: false,
      detail: `Cloudflare no consigue llegar a este servidor (HTTP ${publico.status}). Revisa que el registro apunte al servidor de correo y el modo SSL/TLS de la zona.`,
    };
  }
  return { ok: false, detail: `A través de Cloudflare, HTTPS responde con HTTP ${publico.status}.` };
}

/**
 * Fallos seguidos que hacen falta para degradar un dominio ACTIVO. Uno solo
 * puede ser transitorio (un NXDOMAIN en caché negativa durante un cambio de
 * servidores de nombres, un HTTPS que tarda más de 8 s): degradarlo a la
 * primera lo sacaría de Traefik y abriría una alerta crítica que se cerraría
 * sola en la vuelta siguiente.
 */
export const FALLOS_PARA_DEGRADAR = 2;

/**
 * Fallos seguidos de cada dominio activo. En memoria: tras un reinicio, como
 * mucho hace falta una comprobación más para degradarlo.
 */
const fallosSeguidos = new Map<string, number>();

/**
 * Siguiente estado de un dominio propio según lo averiguado. Un DNS no
 * concluyente (corte de red, resolutor lento) NO cambia nada: si degradara el
 * dominio, saldría de la configuración de Traefik y el webmail del cliente
 * devolvería 404 por un fallo que no es suyo. Un dominio activo tampoco se
 * degrada por un único fallo (véase FALLOS_PARA_DEGRADAR): `fallos` es el
 * número de fallos seguidos, contando este.
 */
export function nextClientDomainStatus(
  previous: DomainStatus,
  dns: DnsCheckResult['status'],
  httpsOk: boolean,
  fallos = FALLOS_PARA_DEGRADAR,
): DomainStatus {
  if (dns === 'unknown') return previous;
  const siguiente: DomainStatus = dns === 'failed' ? 'pending_dns' : httpsOk ? 'active' : 'issuing';
  if (previous === 'active' && siguiente !== 'active' && fallos < FALLOS_PARA_DEGRADAR) return 'active';
  return siguiente;
}

/**
 * Guarda el resultado de una comprobación. Separado de la consulta de red
 * para poder probar la política («qué se escribe según lo averiguado») sobre
 * la base de datos real sin depender del DNS.
 */
export function applyClientDomainCheck(
  id: string,
  dns: DnsCheckResult,
  https: { ok: boolean; detail: string } | null,
): ClientDomain {
  const domain = getClientDomain(id);
  if (dns.status === 'unknown') {
    db.prepare('UPDATE client_domains SET detail = ?, last_checked_at = ? WHERE id = ?').run(
      dns.detail,
      now(),
      id,
    );
    return getClientDomain(id);
  }
  const funciona = dns.status === 'ok' && (https?.ok ?? false);
  const fallos = funciona ? 0 : (fallosSeguidos.get(id) ?? 0) + 1;
  if (fallos === 0 || domain.status !== 'active') fallosSeguidos.delete(id);
  else fallosSeguidos.set(id, fallos);
  const status = nextClientDomainStatus(domain.status, dns.status, https?.ok ?? false, fallos);
  if (status !== 'active') fallosSeguidos.delete(id);
  const medido = dns.status === 'ok' ? (https?.detail ?? dns.detail) : dns.detail;
  // Activo pese al fallo (periodo de gracia): se dice, para que el detalle
  // no contradiga en silencio el estado «En servicio».
  const detail =
    status === 'active' && !funciona
      ? `${medido} Se volverá a comprobar antes de considerarlo fuera de servicio.`
      : medido;
  const row = db
    .prepare(
      `UPDATE client_domains SET status = ?, detail = ?, last_checked_at = ?,
         activated_at = COALESCE(activated_at, CASE WHEN ? = 'active' THEN ? END)
       WHERE id = ? RETURNING *`,
    )
    .get(status, detail, now(), status, now(), id) as DomainRow;
  if (domain.kind === 'webmail' && (domain.status === 'active') !== (status === 'active')) {
    avisarCorreoWeb(domain.clientId);
  }
  return toDomain(row);
}

/**
 * Dominio de correo del cliente del que cuelga un nombre: el más específico
 * (con un dominio y un subdominio suyos, el subdominio). null si ninguno.
 */
function dominioDelQueCuelga(clientId: string, hostname: string): { id: string; domain: string; owner_verified_at: number | null } | null {
  const propios = db
    .prepare('SELECT id, domain, owner_verified_at FROM domains WHERE client_id = ?')
    .all(clientId) as { id: string; domain: string; owner_verified_at: number | null }[];
  return propios.filter((d) => hostname.endsWith(`.${d.domain}`)).sort((a, b) => b.domain.length - a.domain.length)[0] ?? null;
}

/**
 * Dominios propios (webmail y panel) que cuelgan de un dominio de correo del
 * cliente: al eliminarlo, se eliminan con él. Uno que cuelga de un dominio
 * suyo más específico (webmail.sub.empresa.com con sub.empresa.com) no.
 */
export function dominiosPropiosDe(domainId: string): ClientDomain[] {
  const dominio = db.prepare('SELECT client_id FROM domains WHERE id = ?').get(domainId) as { client_id: string } | undefined;
  if (!dominio) return [];
  return listClientDomains(dominio.client_id).filter((d) => dominioDelQueCuelga(d.clientId, d.hostname)?.id === domainId);
}

/**
 * Retira un dominio propio: deja de publicarse en Traefik en su siguiente
 * sondeo. Con `descartar` (lo eliminó una persona), el webmail automático no
 * vuelve a crear ese nombre; al retirarlo el panel (el borrado de su dominio
 * o un cambio de dominio) no se descarta: si el dominio vuelve, su webmail
 * también.
 */
export function eliminarDominioPropio(id: string, opts: { descartar?: boolean } = {}): void {
  const actual = db.prepare('SELECT * FROM client_domains WHERE id = ?').get(id) as DomainRow | undefined;
  if (!actual) return;
  db.transaction(() => {
    db.prepare('DELETE FROM client_domains WHERE id = ?').run(id);
    if (opts.descartar && actual.kind === 'webmail') {
      db.prepare(
        `INSERT INTO webmail_descartados (hostname, client_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT(hostname) DO UPDATE SET client_id = excluded.client_id, created_at = excluded.created_at`,
      ).run(actual.hostname, actual.client_id, now());
    }
  })();
  fallosSeguidos.delete(id);
  // El vigilante ya no volverá a mirarlo: su alerta quedaría abierta para siempre.
  resolveAlert(`whitelabel:${id}`);
  // El correo web nuevo (Bulwark) deja de servir ese nombre.
  if (actual.kind === 'webmail' && actual.status === 'active') avisarCorreoWeb(actual.client_id);
}

/**
 * Avanza el dominio por sus estados: DNS correcto → Traefik lo publica →
 * certificado emitido → activo. Devuelve el dominio ya actualizado.
 */
export async function refreshClientDomain(id: string): Promise<ClientDomain> {
  const domain = getClientDomain(id);
  // Red de seguridad: un nombre que ya no cuelga de un dominio de correo del
  // cliente con la propiedad comprobada (borrado antes de esta versión, o
  // que pasó a otro cliente) no se vuelve a publicar ni a ofrecer como su
  // webmail: con su marca se serviría un nombre que ya no es suyo.
  const padre = dominioDelQueCuelga(domain.clientId, domain.hostname);
  if (!padre || padre.owner_verified_at === null) {
    fallosSeguidos.delete(id);
    const row = db
      .prepare(
        `UPDATE client_domains SET status = 'pending_dns', detail = ?, last_checked_at = ? WHERE id = ? RETURNING *`,
      )
      .get(
        padre
          ? 'Todavía no se ha comprobado la propiedad del dominio de correo del que cuelga este nombre: no se publica hasta comprobarla.'
          : 'Este nombre ya no cuelga de ningún dominio de correo de este cliente, así que no se publica. Elimínalo o vuelve a dar de alta su dominio de correo.',
        now(),
        id,
      ) as DomainRow;
    // Si estaba en servicio, el correo web nuevo deja de usarlo.
    if (domain.status === 'active') avisarCorreoWeb(domain.clientId);
    return toDomain(row);
  }
  const dns = await checkDns(domain);
  // Solo se prueba HTTPS cuando el DNS ya apunta aquí: antes no puede haber certificado.
  let resultadoHttps: { ok: boolean; detail: string } | null = null;
  if (dns.status === 'ok') {
    resultadoHttps = dns.viaCloudflare
      ? dnsOffline()
        ? { ok: false, detail: 'Comprobación HTTPS desactivada (modo sin red).' }
        : await checkHttpsDetrasDeCloudflare(domain.hostname, getInstanceSettings().publicIp)
      : await checkHttps(domain.hostname);
  }
  return applyClientDomainCheck(id, dns, resultadoHttps);
}

/* ------------------- Webmail automático de cada dominio ------------------ */

/**
 * Interruptor general (Ajustes): lo guardado manda; sin guardar, el valor de
 * MAILWAY_WEBMAIL_AUTOMATICO (por defecto, activado).
 */
export function webmailAutomaticoGlobal(): boolean {
  const guardado = getSetting('webmail_automatico');
  if (guardado === '1') return true;
  if (guardado === '0') return false;
  return config.webmailAutomatico;
}

export function setWebmailAutomaticoGlobal(activo: boolean): void {
  setSetting('webmail_automatico', activo ? '1' : '0');
}

/** Interruptor del cliente (activado por defecto). */
export function webmailAutomaticoCliente(clientId: string): boolean {
  const row = db.prepare('SELECT webmail_automatico FROM clients WHERE id = ?').get(clientId) as
    | { webmail_automatico: number }
    | undefined;
  return row ? row.webmail_automatico === 1 : false;
}

/** Los webmail de un cliente, como los ven Skyway y la ficha del cliente. */
export function webmailsDelCliente(clientId: string): ClientDomain[] {
  return listClientDomains(clientId).filter((d) => d.kind === 'webmail');
}

/**
 * Webmail de marca de cada dominio de correo, sin que nadie lo pida: en
 * cuanto un dominio tiene la propiedad comprobada, webmail.<dominio> se da de
 * alta como webmail de marca blanca de su cliente y su registro se crea en
 * Cloudflare, con proxy. Así funciona para todos los clientes y dominios que
 * se vayan añadiendo, y el vigilante lo repasa cada hora para los que ya
 * existían. Barandillas:
 * - solo si el nombre está libre en Cloudflare (aunque responda un comodín)
 *   o ya apunta aquí: un webmail.<dominio> que el cliente usa para otra cosa
 *   no se toca; sin Cloudflare, solo si su DNS ya apunta a este servidor;
 * - no vuelve a crear un nombre que alguien eliminó (webmail_descartados);
 * - respeta el máximo de dominios propios por cliente y los nombres
 *   reservados (assertHostnameAllowed);
 * - las cuentas de Cloudflare son las que usaría el cliente, más la
 *   excepción de la zona que ya escribió la administración (cloudflare.ts).
 * Devuelve el dominio creado, o null si no corresponde o no se ha podido.
 */
export async function asegurarWebmailDeDominio(domainId: string): Promise<ClientDomain | null> {
  if (!webmailAutomaticoGlobal() || !kindAvailable('webmail')) return null;
  const dominio = db
    .prepare('SELECT client_id, domain, owner_verified_at FROM domains WHERE id = ?')
    .get(domainId) as { client_id: string; domain: string; owner_verified_at: number | null } | undefined;
  if (!dominio || dominio.owner_verified_at === null) return null;
  const hostname = `webmail.${dominio.domain}`;
  if (!HOSTNAME_RE.test(hostname)) return null;
  const clientId = dominio.client_id;
  if (!webmailAutomaticoCliente(clientId)) return null;

  return withLock(clientLockKey(clientId), async () => {
    if (db.prepare('SELECT 1 FROM client_domains WHERE hostname = ?').get(hostname)) return null;
    if (db.prepare('SELECT 1 FROM webmail_descartados WHERE hostname = ?').get(hostname)) return null;
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM client_domains WHERE client_id = ?').get(clientId) as {
      c: number;
    };
    if (c >= MAX_WHITELABEL_PER_CLIENT) return null;
    try {
      assertHostnameAllowed(clientId, hostname);
    } catch {
      return null;
    }

    // Importación diferida: cloudflare.ts ya importa este módulo.
    const { aplicarDnsMarcaBlanca, estadoWebmailEnCloudflare } = await import('./cloudflare');
    const estado = await estadoWebmailEnCloudflare(clientId, hostname);
    if (estado === 'ajeno') return null;
    if (estado === null) {
      // Sin una cuenta de Cloudflare que vea la zona: solo si el registro ya
      // está puesto a mano y apunta aquí. Si no, quedaría pendiente para
      // siempre sin que nadie lo hubiera pedido.
      const ip = getInstanceSettings().publicIp;
      const ips = ip ? await lookupA(hostname) : null;
      if (!ip || !ips || !ips.includes(ip)) return null;
    }

    const id = randomId('wld');
    db.prepare(
      `INSERT INTO client_domains (id, client_id, hostname, kind, automatico, created_at) VALUES (?, ?, ?, 'webmail', 1, ?)`,
    ).run(id, clientId, hostname, now());
    auditSystem('whitelabel.domain_created', { id, hostname, kind: 'webmail', automatico: true }, clientId);

    if (estado !== null) {
      try {
        const r = await aplicarDnsMarcaBlanca(id, { permitirInstancia: false, replaceConflicts: false, soloCrear: true });
        if (r.applied.length > 0) {
          auditSystem('cloudflare.dns_applied', {
            whitelabelDomainId: id,
            hostname,
            zone: r.zone,
            applied: r.applied.length,
            errors: r.errors.length,
            automatico: true,
          }, clientId);
        }
        return r.domain;
      } catch {
        // Cloudflare no ha respondido: queda pendiente y el vigilante lo
        // reintenta (reintentarWebmailPendiente).
      }
    }
    return refreshClientDomain(id).catch(() => getClientDomain(id));
  });
}

/**
 * Al desactivar el webmail automático de un cliente: retira los webmail que
 * se crearon solos (no los que dio de alta una persona). Su registro en
 * Cloudflare se borra si es el que escribió Mailway (retirarRegistroMarcaBlanca);
 * cualquier otro se deja. No los anota como descartados: al volver a
 * activarlo se crean otra vez. Devuelve cuántos se han retirado.
 */
export async function retirarWebmailsAutomaticos(clientId: string): Promise<number> {
  const automaticos = webmailsDelCliente(clientId).filter((d) => d.automatico);
  const { retirarRegistroMarcaBlanca } = await import('./cloudflare');
  for (const domain of automaticos) {
    await retirarRegistroMarcaBlanca(domain).catch(() => false);
    db.prepare('DELETE FROM client_domains WHERE id = ?').run(domain.id);
    fallosSeguidos.delete(domain.id);
    // El vigilante ya no lo mirará: su alerta quedaría abierta para siempre.
    resolveAlert(`whitelabel:${domain.id}`);
    auditSystem('whitelabel.domain_deleted', { id: domain.id, hostname: domain.hostname, automatico: true }, clientId);
  }
  if (automaticos.some((d) => d.status === 'active')) avisarCorreoWeb(clientId);
  return automaticos.length;
}

/**
 * Un webmail que sigue esperando al DNS (Cloudflare falló al crearlo, o se
 * dio de alta antes de conectar la cuenta): el vigilante vuelve a intentar
 * crear su registro (solo crear, nunca modificar) y lo comprueba.
 */
export async function reintentarWebmailPendiente(id: string): Promise<ClientDomain> {
  const actual = getClientDomain(id);
  if (actual.kind === 'webmail' && actual.status === 'pending_dns') {
    try {
      const { aplicarDnsMarcaBlanca } = await import('./cloudflare');
      const r = await aplicarDnsMarcaBlanca(id, { permitirInstancia: false, replaceConflicts: false, soloCrear: true });
      if (r.applied.length > 0) {
        auditSystem('cloudflare.dns_applied', {
          whitelabelDomainId: id,
          hostname: actual.hostname,
          zone: r.zone,
          applied: r.applied.length,
          errors: r.errors.length,
          automatico: true,
        }, actual.clientId);
      }
      return r.domain;
    } catch {
      // Sin cuenta o sin respuesta: se mide igualmente, por si el DNS se puso a mano.
    }
  }
  return refreshClientDomain(id);
}

/* ------------------ Configuración dinámica para Traefik ------------------- */

/**
 * Token que Traefik envía en la cabecera X-Mailway-Token al sondear. Si el
 * instalador lo fija por entorno (MAILWAY_TRAEFIK_TOKEN), manda ese: así el
 * override de Traefik se puede escribir antes de arrancar el panel.
 */
export function getTraefikToken(): string {
  if (config.traefikTokenOverride) return config.traefikTokenOverride;
  let token = getSetting('traefik_token');
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    setSetting('traefik_token', token);
  }
  return token;
}

interface TraefikRouter {
  rule: string;
  entryPoints: string[];
  service: string;
  middlewares?: string[];
  tls?: { certResolver: string };
}

/**
 * Configuración dinámica en el formato del proveedor de ficheros de Traefik.
 * Solo se publican los dominios cuyo DNS ya apunta aquí: publicar uno cuyo
 * DNS no resuelve haría que Let's Encrypt fallara la validación y aplicara
 * un bloqueo temporal a base de reintentos.
 */
export function buildTraefikConfig(): Record<string, unknown> {
  const routers: Record<string, TraefikRouter> = {};
  const services: Record<string, unknown> = {};

  const rows = db
    .prepare(`SELECT * FROM client_domains WHERE status IN ('issuing', 'active')`)
    .all() as DomainRow[];

  // Cada host va en su propio par de routers: si un proxy intermedio (el
  // puente de Skyway) descarta uno, los demás siguen publicados.
  const usedHosts = new Set<string>();
  const addHost = (name: string, hostname: string, serviceName: string) => {
    usedHosts.add(hostname);
    const rule = `Host(\`${hostname}\`)`;
    routers[name] = {
      rule,
      entryPoints: ['websecure'],
      service: serviceName,
      tls: { certResolver: config.traefik.certResolver },
    };
    // El puerto 80 solo redirige a HTTPS, salvo la ruta del desafío ACME que
    // Traefik atiende por su cuenta antes que ninguna regla nuestra.
    routers[`${name}-http`] = {
      rule,
      entryPoints: ['web'],
      service: serviceName,
      middlewares: ['mailway-https'],
    };
  };

  // Un servicio por destino: Roundcube (mailway-webmail), Bulwark
  // (mailway-bulwark, solo los webmail de sus clientes) y el panel.
  const conBulwark = clientesConBulwarkEnServicio();
  for (const row of rows) {
    const destino = backendFor(row, conBulwark);
    if (!destino) continue;
    services[destino.servicio] = { loadBalancer: { servers: [{ url: destino.url }] } };
    addHost(`mailway-${row.id}`, row.hostname, destino.servicio);
  }

  // Autoconfiguración (autoconfig., autodiscover., mta-sts.): la sirve el
  // panel. routedAutoconfigHosts ya excluye los hosts cuyo DNS no apunta aquí
  // y devuelve una lista vacía si no se conoce el contenedor del panel.
  const autoconfigHosts = routedAutoconfigHosts().filter((h) => !usedHosts.has(h.host));
  if (autoconfigHosts.length > 0) {
    services['mailway-panel'] = {
      loadBalancer: { servers: [{ url: config.traefik.panelBackend }] },
    };
    for (const h of autoconfigHosts) addHost(`mailway-${h.routerKey}`, h.host, 'mailway-panel');
  }

  return {
    http: {
      routers,
      services,
      middlewares: {
        'mailway-https': { redirectScheme: { scheme: 'https', permanent: true } },
      },
    },
  };
}

/**
 * Da de alta un dominio propio (webmail o panel) de un cliente con todas las
 * comprobaciones del alta: nombre válido y permitido, libre y dentro del
 * máximo por cliente. No lo comprueba ni lo audita: eso lo hace quien llama.
 * La usan la ruta de alta y el cambio de dominio, que crea el webmail con la
 * marca del cliente en el dominio nuevo (webmail.dominio2.es).
 */
export function crearDominioPropio(clientId: string, hostnameEntrada: string, kind: DomainKind): ClientDomain {
  if (!kindAvailable(kind)) {
    throw badRequest(
      kind === 'panel'
        ? 'Los dominios de panel no están habilitados: falta configurar MAILWAY_PANEL_BACKEND_URL en el servidor.'
        : 'Los dominios de webmail no están habilitados en este servidor.',
      'kind_unavailable',
    );
  }
  const hostname = normalizeHostname(hostnameEntrada);
  assertHostnameAllowed(clientId, hostname);
  const existing = db.prepare('SELECT 1 FROM client_domains WHERE hostname = ?').get(hostname);
  if (existing) throw conflict('Ese dominio ya está dado de alta.');
  const count = (
    db.prepare('SELECT COUNT(*) AS c FROM client_domains WHERE client_id = ?').get(clientId) as {
      c: number;
    }
  ).c;
  if (count >= MAX_WHITELABEL_PER_CLIENT) {
    throw badRequest(
      `Se ha alcanzado el máximo de ${MAX_WHITELABEL_PER_CLIENT} dominios propios por cliente. Elimina uno que no se utilice para añadir otro.`,
      'whitelabel_limit',
    );
  }
  const id = randomId('wld');
  db.prepare(
    `INSERT INTO client_domains (id, client_id, hostname, kind, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, clientId, hostname, kind, now());
  // Darlo de alta es pedirlo: deja de estar descartado.
  db.prepare('DELETE FROM webmail_descartados WHERE hostname = ?').run(hostname);
  return getClientDomain(id);
}

/* --------------------------------- Rutas ---------------------------------- */

function requireDomainAccess(req: FastifyRequest, id: string): ClientDomain {
  const domain = getClientDomain(id);
  requireClientAccess(req, domain.clientId);
  return domain;
}

/**
 * Registro del webmail en Cloudflare sin que nadie lo pida: si una cuenta
 * utilizable ve la zona, se crea con el proxy activo (soloCrear: un registro
 * existente nunca se toca). Devuelve el dominio ya comprobado, o null si no
 * se ha podido (sin cuenta, Cloudflare no responde): entonces quedan las
 * instrucciones del DNS y el botón «Configurar en Cloudflare».
 */
async function dnsAutomatico(req: FastifyRequest, user: AuthedUser, id: string): Promise<ClientDomain | null> {
  try {
    // Importación diferida: cloudflare.ts ya importa este módulo.
    const { aplicarDnsMarcaBlanca, permiteInstancia } = await import('./cloudflare');
    const r = await aplicarDnsMarcaBlanca(id, {
      permitirInstancia: permiteInstancia(user, req.query),
      replaceConflicts: false,
      soloCrear: true,
    });
    if (r.applied.length > 0) {
      audit(req, 'cloudflare.dns_applied', {
        whitelabelDomainId: id,
        hostname: r.domain.hostname,
        zone: r.zone,
        applied: r.applied.length,
        errors: r.errors.length,
        automatico: true,
      }, r.domain.clientId);
    }
    return r.domain;
  } catch {
    return null;
  }
}

const createSchema = z.object({
  clientId: z.string().optional(),
  hostname: z.string().min(4),
  kind: z.enum(['webmail', 'panel']).default('webmail'),
});

export function registerWhitelabelRoutes(app: FastifyInstance): void {
  /**
   * Endpoint que sondea Traefik. No lleva sesión: se autentica con un token
   * fijo, porque quien lo llama es el proxy, no una persona.
   */
  app.get('/api/traefik/config', async (req, reply) => {
    const token = req.headers['x-mailway-token'];
    const expected = getTraefikToken();
    const provided = Array.isArray(token) ? token[0] : token;
    const ok =
      typeof provided === 'string' &&
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!ok) {
      reply.status(401);
      return { error: 'Token no válido.' };
    }
    const dynamicConfig = buildTraefikConfig();
    setSetting('traefik_last_poll', String(now()));
    return dynamicConfig;
  });

  /** Datos que necesita el administrador para conectar Traefik con Mailway. */
  app.get('/api/whitelabel/setup', async (req) => {
    requireAdmin(req);
    const token = getTraefikToken();
    const certResolver = config.traefik.certResolver;
    const endpoint = traefikProviderEndpoint(req);
    return {
      token,
      tokenFromEnv: Boolean(config.traefikTokenOverride),
      certResolver,
      webmailBackend: config.traefik.webmailBackend,
      // Destino de los webmail de los clientes con el correo web nuevo (null si no está disponible).
      bulwarkBackend: estadoBulwark().disponible ? config.bulwark.backendUrl : null,
      panelBackend: config.traefik.panelBackend,
      panelDomainsAvailable: kindAvailable('panel'),
      panelUrl: publicBaseUrl(req),
      underSkyway: runningUnderSkyway(),
      providerEndpoint: endpoint,
      overrideSnippet: traefikOverrideSnippet(endpoint, token, certResolver),
      autoconfig: {
        routingAvailable: autoconfigRoutingAvailable(),
        routedHosts: routedAutoconfigHosts().length,
      },
      skywayBridge: {
        minVersion: '0.34.0',
        endpoint: 'http://skyway:4000/api/traefik/mailway',
        note:
          'Con Skyway 0.34 o posterior no es necesario instalar nada: el Traefik de Skyway consulta ' +
          'estas rutas a través de Skyway (/api/traefik/mailway), que las filtra y conserva la última ' +
          'configuración válida. Basta con conectar Mailway en Skyway, en Ajustes → Correo (Mailway), con un ' +
          'token de gestión; Skyway obtiene el token de Traefik por sí mismo.',
      },
      lastPollAt: Number(getSetting('traefik_last_poll')) || null,
      publishedDomains: (
        db
          .prepare(`SELECT COUNT(*) AS c FROM client_domains WHERE status IN ('issuing','active')`)
          .get() as { c: number }
      ).c,
    };
  });

  app.get('/api/whitelabel/domains', async (req) => {
    const user = requireAuth(req);
    if (user.role === 'admin') {
      const { clientId } = req.query as { clientId?: string };
      return { domains: listClientDomains(clientId) };
    }
    return { domains: listClientDomains(user.clientId!) };
  });

  app.post('/api/whitelabel/domains', async (req) => {
    const user = requireAuth(req);
    const body = createSchema.parse(req.body);
    const clientId = user.role === 'admin' ? body.clientId || '' : user.clientId!;
    if (!clientId) throw badRequest('Indica a qué cliente pertenece el dominio.', 'client_required');
    requireClientAccess(req, clientId);
    const clientExists = db.prepare('SELECT 1 FROM clients WHERE id = ?').get(clientId);
    if (!clientExists) throw notFound('Cliente no encontrado.');

    if (!kindAvailable(body.kind)) {
      throw badRequest(
        body.kind === 'panel'
          ? 'Los dominios de panel no están habilitados: falta configurar MAILWAY_PANEL_BACKEND_URL en el servidor.'
          : 'Los dominios de webmail no están habilitados en este servidor.',
        'kind_unavailable',
      );
    }
    const hostname = normalizeHostname(body.hostname);
    const existing = db.prepare('SELECT * FROM client_domains WHERE hostname = ?').get(hostname) as
      | DomainRow
      | undefined;
    if (existing && existing.client_id === clientId && existing.kind === body.kind) {
      // El mismo nombre del mismo cliente y del mismo tipo (lo creó el alta
      // automática, o Skyway lo pide otra vez): se devuelve el que hay, en
      // lugar de un error que haría fallar a quien integra.
      assertHostnameAllowed(clientId, hostname);
      // Pedido expresamente: desactivar el automático ya no lo retira.
      if (existing.automatico === 1) {
        db.prepare('UPDATE client_domains SET automatico = 0 WHERE id = ?').run(existing.id);
      }
      return { domain: getClientDomain(existing.id), instructions: dnsInstructions(hostname) };
    }
    const creado = crearDominioPropio(clientId, hostname, body.kind);
    const id = creado.id;
    audit(req, 'whitelabel.domain_created', { id, hostname: creado.hostname, kind: body.kind }, clientId);

    // El webmail se apunta solo en Cloudflare cuando se puede. Después, la
    // primera comprobación inmediata: si el DNS ya estaba puesto, el usuario
    // ve el progreso sin tener que pulsar nada.
    const automatico = body.kind === 'webmail' ? await dnsAutomatico(req, user, id) : null;
    const domain = automatico ?? (await refreshClientDomain(id).catch(() => getClientDomain(id)));
    return { domain, instructions: dnsInstructions(creado.hostname) };
  });

  app.get('/api/whitelabel/domains/:id', async (req) => {
    const { id } = req.params as { id: string };
    const domain = requireDomainAccess(req, id);
    return { domain, instructions: dnsInstructions(domain.hostname) };
  });

  app.post('/api/whitelabel/domains/:id/verify', async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    const actual = requireDomainAccess(req, id);
    // Un webmail que aún espera al DNS (dado de alta antes de que hubiera una
    // cuenta de Cloudflare, por ejemplo): se intenta crear su registro.
    const automatico =
      actual.kind === 'webmail' && actual.status === 'pending_dns' ? await dnsAutomatico(req, user, id) : null;
    const domain = automatico ?? (await refreshClientDomain(id));
    audit(req, 'whitelabel.domain_verified', { id, status: domain.status }, domain.clientId);
    return { domain, instructions: dnsInstructions(domain.hostname) };
  });

  app.post('/api/whitelabel/domains/:id/primary', async (req) => {
    const { id } = req.params as { id: string };
    requireDomainAccess(req, id);
    const domain = setPrimaryWebmail(id);
    audit(req, 'whitelabel.primary_changed', { id, hostname: domain.hostname }, domain.clientId);
    return { domain };
  });

  /* ----------------------- Interruptores del automático ------------------- */

  const interruptorSchema = z.object({ activo: z.boolean() });

  /** Estado del webmail automático de un cliente y sus webmail. */
  app.get('/api/clients/:id/webmail-automatico', async (req) => {
    const { id } = req.params as { id: string };
    requireClientAccess(req, id);
    if (!db.prepare('SELECT 1 FROM clients WHERE id = ?').get(id)) throw notFound('Cliente no encontrado.');
    return {
      webmailAutomatico: webmailAutomaticoCliente(id),
      global: webmailAutomaticoGlobal(),
      webmailDomains: webmailsDelCliente(id),
    };
  });

  /**
   * Activa o desactiva el webmail automático de un cliente (el botón de su
   * ficha y el de Skyway). Activarlo prepara ya webmail.<dominio> de cada
   * dominio comprobado; desactivarlo retira los que se crearon solos.
   */
  app.put('/api/clients/:id/webmail-automatico', async (req) => {
    const { id } = req.params as { id: string };
    requireClientAccess(req, id);
    if (!db.prepare('SELECT 1 FROM clients WHERE id = ?').get(id)) throw notFound('Cliente no encontrado.');
    const { activo } = interruptorSchema.parse(req.body);
    db.prepare('UPDATE clients SET webmail_automatico = ? WHERE id = ?').run(activo ? 1 : 0, id);
    let retirados = 0;
    if (activo) {
      const dominios = db
        .prepare('SELECT id FROM domains WHERE client_id = ? AND owner_verified_at IS NOT NULL ORDER BY created_at')
        .all(id) as { id: string }[];
      for (const d of dominios) await asegurarWebmailDeDominio(d.id).catch(() => null);
    } else {
      retirados = await retirarWebmailsAutomaticos(id);
    }
    audit(req, 'whitelabel.automatico_changed', { activo, retirados }, id);
    return {
      webmailAutomatico: activo,
      global: webmailAutomaticoGlobal(),
      webmailDomains: webmailsDelCliente(id),
    };
  });

  /** Interruptor general del webmail automático (Ajustes). */
  app.get('/api/settings/webmail-automatico', async (req) => {
    requireAdmin(req);
    return { webmailAutomatico: webmailAutomaticoGlobal() };
  });

  app.put('/api/settings/webmail-automatico', async (req) => {
    requireAdmin(req);
    const { activo } = interruptorSchema.parse(req.body);
    setWebmailAutomaticoGlobal(activo);
    audit(req, 'settings.webmail_automatico_changed', { activo });
    return { webmailAutomatico: webmailAutomaticoGlobal() };
  });

  app.delete('/api/whitelabel/domains/:id', async (req) => {
    const { id } = req.params as { id: string };
    const domain = requireDomainAccess(req, id);
    // Eliminado a mano: el alta automática no lo vuelve a crear.
    eliminarDominioPropio(id, { descartar: true });
    audit(req, 'whitelabel.domain_deleted', { id, hostname: domain.hostname }, domain.clientId);
    // Traefik dejará de enrutarlo en su siguiente sondeo (unos segundos).
    return { ok: true };
  });
}
