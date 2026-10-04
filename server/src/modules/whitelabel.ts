import crypto from 'node:crypto';
import { domainToUnicode } from 'node:url';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { db, now } from '../core/db';
import { randomId } from '../core/crypto';
import { avisoCaa, caaPermiteLetsEncrypt, dnsOffline, lookupA, lookupCname } from '../core/dns';
import { badRequest, conflict, notFound } from '../core/errors';
import { resolveAlert } from './alerts';
import { audit } from './audit';
import { requireAdmin, requireAuth, requireClientAccess } from './auth';
import {
  autoconfigRoutingAvailable,
  routedAutoconfigHosts,
  runningUnderSkyway,
} from './autoconfig';
import { instanceAutoconfigBase, publicBaseUrl, webmailUrlForClient } from './connection';
import { getInstanceSettings, getSetting, setSetting } from './settings';

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

/** Backend al que Traefik debe enviar el tráfico de cada tipo de dominio. */
function backendFor(kind: DomainKind): string {
  return kind === 'webmail' ? config.traefik.webmailBackend : config.traefik.panelBackend;
}

export function kindAvailable(kind: DomainKind): boolean {
  return Boolean(backendFor(kind));
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
 * webmail de marca blanca de todos los clientes en plena mudanza.
 *
 * `resolve4` sigue la cadena de CNAME, así que lookupA da las IP finales.
 */
export async function comprobarDnsMarcaBlanca(hostname: string): Promise<DnsCheckResult> {
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
  const validas = [...new Set([ipGuardada, ...(ipsServidor ?? [])].filter(Boolean))];
  const coincide = ips.find((ip) => validas.includes(ip));
  if (coincide) {
    return conCaa(hostname, `El dominio apunta correctamente a ${coincide}.`);
  }
  // Sin las IP del servidor de correo no se sabe si la del dominio es suya
  // (puede ser la nueva tras un cambio de IP): no concluyente, no un fallo.
  if (ipsServidor === null) {
    return {
      status: 'unknown',
      detail: `No se ha podido consultar el DNS de ${servidor} para comparar las IP. Vuelve a intentarlo en un minuto.`,
    };
  }
  return {
    status: 'failed',
    detail: `El dominio apunta a ${ips.join(', ')} en lugar de a ${
      servidor ? `${servidor} (${validas.join(', ') || 'sin IP'})` : validas.join(', ')
    }. Corrige el registro.`,
  };
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

/** Retira un dominio propio: deja de publicarse en Traefik en su siguiente sondeo. */
export function eliminarDominioPropio(id: string): void {
  db.prepare('DELETE FROM client_domains WHERE id = ?').run(id);
  fallosSeguidos.delete(id);
  // El vigilante ya no volverá a mirarlo: su alerta quedaría abierta para siempre.
  resolveAlert(`whitelabel:${id}`);
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
    return toDomain(row);
  }
  const dns = await comprobarDnsMarcaBlanca(domain.hostname);
  // Solo se prueba HTTPS cuando el DNS ya apunta aquí: antes no puede haber certificado.
  const https = dns.status === 'ok' ? await checkHttps(domain.hostname) : null;
  return applyClientDomainCheck(id, dns, https);
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

  for (const row of rows) {
    const backend = backendFor(row.kind);
    if (!backend) continue;
    const serviceName = `mailway-${row.kind}`;
    services[serviceName] = { loadBalancer: { servers: [{ url: backend }] } };
    addHost(`mailway-${row.id}`, row.hostname, serviceName);
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

/* --------------------------------- Rutas ---------------------------------- */

function requireDomainAccess(req: FastifyRequest, id: string): ClientDomain {
  const domain = getClientDomain(id);
  requireClientAccess(req, domain.clientId);
  return domain;
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
    ).run(id, clientId, hostname, body.kind, now());
    audit(req, 'whitelabel.domain_created', { id, hostname, kind: body.kind }, clientId);

    // Primera comprobación inmediata: si el DNS ya estaba puesto, el usuario
    // ve el progreso sin tener que pulsar nada.
    const domain = await refreshClientDomain(id).catch(() => getClientDomain(id));
    return { domain, instructions: dnsInstructions(hostname) };
  });

  app.get('/api/whitelabel/domains/:id', async (req) => {
    const { id } = req.params as { id: string };
    const domain = requireDomainAccess(req, id);
    return { domain, instructions: dnsInstructions(domain.hostname) };
  });

  app.post('/api/whitelabel/domains/:id/verify', async (req) => {
    const { id } = req.params as { id: string };
    requireDomainAccess(req, id);
    const domain = await refreshClientDomain(id);
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

  app.delete('/api/whitelabel/domains/:id', async (req) => {
    const { id } = req.params as { id: string };
    const domain = requireDomainAccess(req, id);
    eliminarDominioPropio(id);
    audit(req, 'whitelabel.domain_deleted', { id, hostname: domain.hostname }, domain.clientId);
    // Traefik dejará de enrutarlo en su siguiente sondeo (unos segundos).
    return { ok: true };
  });
}
