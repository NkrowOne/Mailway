import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { db, now } from '../core/db';
import { randomId } from '../core/crypto';
import { lookupA, lookupCname } from '../core/dns';
import { badRequest, conflict, notFound } from '../core/errors';
import { audit } from './audit';
import { requireAdmin, requireAuth, requireClientAccess } from './auth';
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
      'El dominio no es válido. Escribe solo el nombre, por ejemplo: webmail.suempresa.com',
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
      help: 'Opción recomendada: si algún día cambias de servidor, no hay que tocar el DNS de tus clientes.',
    });
  }
  if (instance.publicIp) {
    out.push({
      type: 'A',
      name: hostname,
      value: instance.publicIp,
      recommended: !instance.mailHostname,
      help: 'Alternativa: apunta directamente a la IP del servidor. Sirve igual, pero habría que cambiarlo si migras de servidor.',
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
interface DnsCheckResult {
  status: 'ok' | 'failed' | 'unknown';
  detail: string;
}

/**
 * El dominio debe resolver a la IP de este servidor. `resolve4` sigue la
 * cadena de CNAME, así que esto cubre las dos formas de apuntarlo.
 */
async function checkDns(hostname: string): Promise<DnsCheckResult> {
  const instance = getInstanceSettings();
  if (!instance.publicIp) {
    return {
      status: 'unknown',
      detail:
        'Falta la IP pública del servidor en Ajustes: sin ella no se puede comprobar si el dominio apunta aquí.',
    };
  }
  const ips = await lookupA(hostname);
  if (ips === null) {
    return {
      status: 'unknown',
      detail: 'No se pudo consultar el DNS ahora mismo. Vuelve a intentarlo en un minuto.',
    };
  }
  if (ips.length === 0) {
    const cname = await lookupCname(hostname);
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
  if (!ips.includes(instance.publicIp)) {
    return {
      status: 'failed',
      detail: `El dominio apunta a ${ips.join(', ')} en lugar de a ${instance.publicIp}. Corrige el registro.`,
    };
  }
  return { status: 'ok', detail: `El dominio apunta correctamente a ${instance.publicIp}.` };
}

/**
 * Comprueba que Traefik ya sirve el dominio con un certificado válido. Se hace
 * una petición HTTPS real: si el certificado aún no está emitido, falla el
 * handshake y sabemos que sigue en proceso.
 */
async function checkHttps(hostname: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`https://${hostname}/`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    return {
      ok: true,
      detail: `Certificado válido y sirviendo (HTTP ${res.status}).`,
    };
  } catch (err) {
    const message = (err as Error).message || '';
    const cause = String((err as { cause?: unknown }).cause ?? '');
    const text = `${message} ${cause}`.toLowerCase();
    if (text.includes('certificate') || text.includes('altname') || text.includes('tls')) {
      return {
        ok: false,
        detail:
          'El certificado todavía no está emitido. Let\'s Encrypt suele tardar menos de un minuto; vuelve a comprobar.',
      };
    }
    if (text.includes('timeout') || text.includes('aborted')) {
      return {
        ok: false,
        detail:
          'No hubo respuesta a tiempo. Si el DNS acaba de cambiar, espera a que se propague y reintenta.',
      };
    }
    return {
      ok: false,
      detail: `Todavía no responde por HTTPS (${message.slice(0, 120)}). Reintenta en un minuto.`,
    };
  }
}

/**
 * Avanza el dominio por sus estados: DNS correcto → Traefik lo publica →
 * certificado emitido → activo. Devuelve el dominio ya actualizado.
 */
export async function refreshClientDomain(id: string): Promise<ClientDomain> {
  const domain = getClientDomain(id);
  const dns = await checkDns(domain.hostname);

  // Un DNS no concluyente (corte de red, resolutor lento) NO degrada el
  // dominio: si lo hiciera, saldría de la configuración de Traefik y el
  // webmail del cliente devolvería 404 por un fallo que no es suyo.
  if (dns.status === 'unknown') {
    db.prepare('UPDATE client_domains SET detail = ?, last_checked_at = ? WHERE id = ?').run(
      dns.detail,
      now(),
      id,
    );
    return getClientDomain(id);
  }

  // Si el DNS falla de forma definitiva, o si aún no sirve por HTTPS, el
  // estado se calcula de una vez y se escribe con una sola sentencia.
  const check = dns.status === 'ok' ? await checkHttps(domain.hostname) : { ok: false, detail: dns.detail };
  const status: DomainStatus =
    dns.status === 'failed' ? 'pending_dns' : check.ok ? 'active' : 'issuing';

  const row = db
    .prepare(
      `UPDATE client_domains SET status = ?, detail = ?, last_checked_at = ?,
         activated_at = COALESCE(activated_at, CASE WHEN ? = 'active' THEN ? END)
       WHERE id = ? RETURNING *`,
    )
    .get(status, check.detail, now(), status, now(), id) as DomainRow;
  return toDomain(row);
}

/* ------------------ Configuración dinámica para Traefik ------------------- */

/** Token que Traefik envía en la cabecera X-Mailway-Token al sondear. */
export function getTraefikToken(): string {
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

  for (const row of rows) {
    const backend = backendFor(row.kind);
    if (!backend) continue;
    const serviceName = `mailway-${row.kind}`;
    services[serviceName] = { loadBalancer: { servers: [{ url: backend }] } };

    const rule = `Host(\`${row.hostname}\`)`;
    routers[`mailway-${row.id}`] = {
      rule,
      entryPoints: ['websecure'],
      service: serviceName,
      tls: { certResolver: config.traefik.certResolver },
    };
    // El puerto 80 solo redirige a HTTPS, salvo la ruta del desafío ACME que
    // Traefik atiende por su cuenta antes que ninguna regla nuestra.
    routers[`mailway-${row.id}-http`] = {
      rule,
      entryPoints: ['web'],
      service: serviceName,
      middlewares: ['mailway-https'],
    };
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
    return buildTraefikConfig();
  });

  /** Datos que necesita el administrador para configurar Traefik una vez. */
  app.get('/api/whitelabel/setup', async (req) => {
    requireAdmin(req);
    return {
      token: getTraefikToken(),
      certResolver: config.traefik.certResolver,
      webmailBackend: config.traefik.webmailBackend,
      panelBackend: config.traefik.panelBackend,
      panelDomainsAvailable: kindAvailable('panel'),
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
    if (!clientId) throw badRequest('Indica a qué cliente pertenece el dominio.');
    requireClientAccess(req, clientId);

    if (!kindAvailable(body.kind)) {
      throw badRequest(
        body.kind === 'panel'
          ? 'Los dominios de panel no están habilitados: falta configurar MAILWAY_PANEL_BACKEND_URL en el servidor.'
          : 'Los dominios de webmail no están habilitados en este servidor.',
        'kind_unavailable',
      );
    }

    const hostname = normalizeHostname(body.hostname);
    const existing = db.prepare('SELECT 1 FROM client_domains WHERE hostname = ?').get(hostname);
    if (existing) throw conflict('Ese dominio ya está dado de alta.');

    const instance = getInstanceSettings();
    if (hostname === instance.mailHostname) {
      throw badRequest(
        'Ese es el nombre del propio servidor de correo. Usa un subdominio distinto, por ejemplo webmail.suempresa.com',
      );
    }

    const id = randomId('wld');
    db.prepare(
      `INSERT INTO client_domains (id, client_id, hostname, kind, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, clientId, hostname, body.kind, now());
    audit(req, 'whitelabel.domain_created', { id, hostname, kind: body.kind });

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
    audit(req, 'whitelabel.domain_verified', { id, status: domain.status });
    return { domain, instructions: dnsInstructions(domain.hostname) };
  });

  app.delete('/api/whitelabel/domains/:id', async (req) => {
    const { id } = req.params as { id: string };
    const domain = requireDomainAccess(req, id);
    db.prepare('DELETE FROM client_domains WHERE id = ?').run(id);
    audit(req, 'whitelabel.domain_deleted', { id, hostname: domain.hostname });
    // Traefik dejará de enrutarlo en su siguiente sondeo (unos segundos).
    return { ok: true };
  });
}
