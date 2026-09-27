import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { db, now } from '../core/db';
import { lookupA, lookupCname } from '../core/dns';
import { conflict, notFound } from '../core/errors';
import { audit } from './audit';
import { requireAdmin, requireAuth, requireClientAccess } from './auth';
import {
  AUTOCONFIG_CONTENT_TYPE,
  AUTOCONFIG_HOSTS_SETTING,
  AUTODISCOVER_CONTENT_TYPE,
  MOBILECONFIG_CONTENT_TYPE,
  autodiscoverErrorXml,
  autodiscoverRequestEmail,
  autodiscoverXml,
  buildConnectionInfo,
  clientOfMailDomain,
  domainOf,
  getConnectionSettings,
  instanceAutoconfigBase,
  mobileconfigFilename,
  mobileconfigPlist,
  readAutoconfigHostStates,
  thunderbirdAutoconfigXml,
  type AutoconfigHostRecord,
  type AutoconfigHostState,
} from './connection';
import { getInstanceSettings, getSetting, setJsonSetting, setSetting } from './settings';

/**
 * Autoconfiguración de programas de correo y rutas de sus hosts.
 *
 * - Rutas públicas que consultan los clientes de correo: Thunderbird
 *   (clientConfig), Outlook/Thunderbird (Autodiscover POX y v2), MTA-STS.
 *   Responden por ruta en cualquier host; qué dominio se sirve se deduce de la
 *   dirección o del host, y solo si el dominio es de esta instancia.
 * - Estado DNS de los hosts autoconfig./autodiscover./mta-sts.: Traefik solo
 *   los enruta cuando apuntan aquí (si no, Let's Encrypt fallaría la
 *   validación y acabaría bloqueando la emisión por reintentos).
 */

export type AutoconfigPurpose = 'autoconfig' | 'autodiscover' | 'mta-sts';

export interface AutoconfigHost {
  host: string;
  purpose: AutoconfigPurpose;
  scope: 'instance' | 'domain';
  domainId: string | null;
  /** Dominio de correo (o base de la instancia) al que pertenece el host. */
  domain: string;
  /** Sufijo estable y único del router de Traefik (sin puntos: Skyway no los admite). */
  routerKey: string;
}

export interface HostCheck {
  state: AutoconfigHostState;
  detail: string;
}

export type HostChecker = (host: string) => Promise<HostCheck>;

const DOMAIN_PURPOSES: AutoconfigPurpose[] = ['autoconfig', 'autodiscover', 'mta-sts'];
const INSTANCE_PURPOSES: AutoconfigPurpose[] = ['autoconfig', 'autodiscover'];
const CHECKED_AT_SETTING = 'autoconfig_hosts_checked_at';
/** Consultas DNS simultáneas: suficientes para cientos de dominios sin saturar el resolutor. */
const DNS_CONCURRENCY = 6;

function routerKey(purpose: AutoconfigPurpose, id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '-');
  return `${purpose === 'mta-sts' ? 'mtasts' : purpose}-${safe}`;
}

/** Desplegado con Skyway: Skyway inyecta estas variables en sus servicios. */
export function runningUnderSkyway(): boolean {
  return Boolean(process.env.SKYWAY_PROJECT?.trim() && process.env.SKYWAY_SERVICE?.trim());
}

/**
 * Hosts que deberían existir ahora mismo: los dos de la instancia y los tres
 * de cada dominio de correo gestionado. Sin duplicados: si un dominio de
 * cliente coincide con la base de la instancia, manda la entrada de la
 * instancia (dos routers con el mismo Host dejarían a Traefik eligiendo).
 */
export function expectedAutoconfigHosts(): AutoconfigHost[] {
  const out: AutoconfigHost[] = [];
  const seen = new Set<string>();
  const add = (entry: AutoconfigHost) => {
    if (seen.has(entry.host)) return;
    seen.add(entry.host);
    out.push(entry);
  };
  const base = instanceAutoconfigBase();
  if (base) {
    for (const purpose of INSTANCE_PURPOSES) {
      add({
        host: `${purpose}.${base}`,
        purpose,
        scope: 'instance',
        domainId: null,
        domain: base,
        routerKey: routerKey(purpose, 'instancia'),
      });
    }
  }
  const rows = db.prepare('SELECT id, domain FROM domains ORDER BY domain').all() as {
    id: string;
    domain: string;
  }[];
  for (const row of rows) {
    for (const purpose of DOMAIN_PURPOSES) {
      add({
        host: `${purpose}.${row.domain}`,
        purpose,
        scope: 'domain',
        domainId: row.id,
        domain: row.domain,
        routerKey: routerKey(purpose, row.id),
      });
    }
  }
  return out;
}

/* ------------------------------ Comprobación ------------------------------ */

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * ¿Apunta el host a este servidor? Vale un CNAME al servidor de correo (lo que
 * recomienda Stalwart) o una A con la IP pública. Si ninguna consulta obtiene
 * respuesta, el resultado es «desconocido»: un corte de red no es un «no».
 */
export async function checkAutoconfigHost(host: string): Promise<HostCheck> {
  const instance = getInstanceSettings();
  const target = normalizeName(instance.mailHostname);
  const ip = instance.publicIp.trim();
  if (!target && !ip) {
    return {
      state: 'unknown',
      detail:
        'Faltan el nombre del servidor de correo y la IP pública en Ajustes: no es posible comprobar el DNS.',
    };
  }
  const [cname, a] = await Promise.all([lookupCname(host), lookupA(host)]);
  if (target && cname?.some((c) => normalizeName(c) === target)) {
    return { state: 'ok', detail: `El registro CNAME apunta a ${target}.` };
  }
  if (ip && a?.includes(ip)) {
    return { state: 'ok', detail: `El nombre resuelve a ${ip}, la IP de este servidor.` };
  }
  if (a === null) {
    return {
      state: 'unknown',
      detail: 'No se ha podido consultar el DNS. Se volverá a intentar en la próxima comprobación.',
    };
  }
  if (cname && cname.length > 0) {
    return {
      state: 'pending',
      detail: `El registro CNAME apunta a ${cname.join(', ')} en lugar de a ${target || 'este servidor'}.`,
    };
  }
  if (a.length > 0) {
    return {
      state: 'pending',
      detail: ip
        ? `El nombre resuelve a ${a.join(', ')} en lugar de a ${ip}.`
        : `El nombre resuelve a ${a.join(', ')}; falta la IP pública en Ajustes para compararla.`,
    };
  }
  return { state: 'pending', detail: 'El registro no existe en el DNS.' };
}

/**
 * Siguiente estado guardado de un host. Una consulta sin respuesta NUNCA
 * cambia un estado ya conocido: si lo hiciera, un corte de red retiraría la
 * ruta de Traefik (o la publicaría sin DNS) por un fallo que no es del cliente.
 */
export function nextHostRecord(
  prev: AutoconfigHostRecord | undefined,
  check: HostCheck,
  at: number,
): AutoconfigHostRecord {
  if (check.state === 'unknown') {
    if (prev && prev.state !== 'unknown') {
      return { ...prev, lastAttemptAt: at, lastAttemptInconclusive: true };
    }
    return {
      state: 'unknown',
      detail: check.detail,
      checkedAt: prev?.checkedAt ?? null,
      changedAt: prev?.changedAt ?? at,
      lastAttemptAt: at,
      lastAttemptInconclusive: true,
    };
  }
  return {
    state: check.state,
    detail: check.detail,
    checkedAt: at,
    changedAt: prev && prev.state === check.state ? prev.changedAt : at,
    lastAttemptAt: at,
    lastAttemptInconclusive: false,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function checkMany(hosts: string[], checker: HostChecker): Promise<[string, HostCheck][]> {
  return mapLimit(hosts, DNS_CONCURRENCY, async (host): Promise<[string, HostCheck]> => {
    try {
      return [host, await checker(host)];
    } catch {
      return [host, { state: 'unknown', detail: 'No se ha podido consultar el DNS.' }];
    }
  });
}

export interface AutoconfigRefreshSummary {
  checked: number;
  ok: number;
  pending: number;
  unknown: number;
}

export interface RefreshOptions {
  /** Sustituye la consulta DNS (pruebas). */
  check?: HostChecker;
}

let inFlight: Promise<AutoconfigRefreshSummary> | null = null;

/**
 * Comprueba el DNS de todos los hosts de autoconfiguración y guarda el
 * resultado. La llama el vigilante cada hora y el botón «Comprobar ahora» de
 * Ajustes; dos llamadas a la vez comparten la misma comprobación.
 */
export function refreshAutoconfigHosts(opts: RefreshOptions = {}): Promise<AutoconfigRefreshSummary> {
  if (inFlight && !opts.check) return inFlight;
  const run = (async (): Promise<AutoconfigRefreshSummary> => {
    const hosts = expectedAutoconfigHosts();
    const results = await checkMany(
      hosts.map((h) => h.host),
      opts.check ?? checkAutoconfigHost,
    );
    const at = now();
    // Leer y escribir sin esperas intermedias: así no se pisa lo que haya
    // guardado mientras tanto una comprobación de un solo dominio.
    const current = readAutoconfigHostStates();
    const expected = new Set(hosts.map((h) => h.host));
    const next: Record<string, AutoconfigHostRecord> = {};
    for (const [host, record] of Object.entries(current)) {
      if (expected.has(host)) next[host] = record; // los de dominios borrados se olvidan
    }
    for (const [host, check] of results) next[host] = nextHostRecord(current[host], check, at);
    setJsonSetting(AUTOCONFIG_HOSTS_SETTING, next);
    setSetting(CHECKED_AT_SETTING, String(at));
    return summarize(results.map(([host]) => next[host]!));
  })();
  if (!opts.check) {
    inFlight = run;
    void run.finally(() => {
      if (inFlight === run) inFlight = null;
    }).catch(() => undefined);
  }
  return run;
}

/**
 * Comprueba solo los hosts de un dominio de correo (por nombre o id). Para
 * llamarla cuando un dominio se verifica o se activa: así su autoconfiguración
 * se publica en el siguiente sondeo de Traefik y no a la hora siguiente.
 */
export async function refreshAutoconfigForDomain(
  domainOrId: string,
  opts: RefreshOptions = {},
): Promise<AutoconfigRefreshSummary> {
  const key = domainOrId.trim().toLowerCase();
  const hosts = expectedAutoconfigHosts().filter(
    (h) => h.scope === 'domain' && (h.domain === key || h.domainId === domainOrId),
  );
  const results = await checkMany(
    hosts.map((h) => h.host),
    opts.check ?? checkAutoconfigHost,
  );
  const at = now();
  const current = readAutoconfigHostStates();
  for (const [host, check] of results) current[host] = nextHostRecord(current[host], check, at);
  setJsonSetting(AUTOCONFIG_HOSTS_SETTING, current);
  return summarize(results.map(([host]) => current[host]!));
}

function summarize(records: AutoconfigHostRecord[]): AutoconfigRefreshSummary {
  return {
    checked: records.length,
    ok: records.filter((r) => r.state === 'ok').length,
    pending: records.filter((r) => r.state === 'pending').length,
    unknown: records.filter((r) => r.state === 'unknown').length,
  };
}

/* --------------------------------- Traefik -------------------------------- */

/** Sin el contenedor del panel, Traefik no tiene adónde enviar estos hosts. */
export function autoconfigRoutingAvailable(): boolean {
  return Boolean(config.traefik.panelBackend);
}

/** Hosts que Traefik debe enrutar al panel: solo los que ya apuntan aquí. */
export function routedAutoconfigHosts(): AutoconfigHost[] {
  if (!autoconfigRoutingAvailable()) return [];
  const states = readAutoconfigHostStates();
  return expectedAutoconfigHosts().filter((h) => states[h.host]?.state === 'ok');
}

/* ---------------------------------- Estado --------------------------------- */

export interface AutoconfigHostStatus {
  host: string;
  purpose: AutoconfigPurpose;
  state: AutoconfigHostState;
  detail: string;
  checkedAt: number | null;
  lastAttemptAt: number | null;
  lastAttemptInconclusive: boolean;
  /** Traefik lo enruta ahora mismo. */
  routed: boolean;
}

export interface AutoconfigStatus {
  routingAvailable: boolean;
  panelBackend: string;
  underSkyway: boolean;
  mailHostname: string;
  publicIp: string;
  checkedAt: number | null;
  instance: { base: string | null; hosts: AutoconfigHostStatus[] };
  domains: {
    domainId: string;
    domain: string;
    clientId: string;
    clientName: string;
    hosts: AutoconfigHostStatus[];
  }[];
  /** Registros DNS que el administrador debe crear para los hosts de la instancia. */
  records: { type: 'CNAME'; name: string; value: string; purpose: AutoconfigPurpose }[];
}

export function autoconfigStatus(): AutoconfigStatus {
  const instance = getInstanceSettings();
  const states = readAutoconfigHostStates();
  const routing = autoconfigRoutingAvailable();
  const toStatus = (h: AutoconfigHost): AutoconfigHostStatus => {
    const record = states[h.host];
    const state = record?.state ?? 'unknown';
    return {
      host: h.host,
      purpose: h.purpose,
      state,
      detail: record?.detail ?? 'Todavía no se ha comprobado.',
      checkedAt: record?.checkedAt ?? null,
      lastAttemptAt: record?.lastAttemptAt ?? null,
      lastAttemptInconclusive: record?.lastAttemptInconclusive ?? false,
      routed: routing && state === 'ok',
    };
  };
  const hosts = expectedAutoconfigHosts();
  const clients = new Map(
    (db.prepare('SELECT d.id, d.client_id, c.name FROM domains d JOIN clients c ON c.id = d.client_id').all() as {
      id: string;
      client_id: string;
      name: string;
    }[]).map((r) => [r.id, r]),
  );
  const byDomain = new Map<string, AutoconfigStatus['domains'][number]>();
  for (const h of hosts) {
    if (h.scope !== 'domain' || !h.domainId) continue;
    let entry = byDomain.get(h.domainId);
    if (!entry) {
      const owner = clients.get(h.domainId);
      entry = {
        domainId: h.domainId,
        domain: h.domain,
        clientId: owner?.client_id ?? '',
        clientName: owner?.name ?? '',
        hosts: [],
      };
      byDomain.set(h.domainId, entry);
    }
    entry.hosts.push(toStatus(h));
  }
  const base = instanceAutoconfigBase();
  const target = normalizeName(instance.mailHostname);
  const checkedAt = Number(getSetting(CHECKED_AT_SETTING)) || null;
  return {
    routingAvailable: routing,
    panelBackend: config.traefik.panelBackend,
    underSkyway: runningUnderSkyway(),
    mailHostname: instance.mailHostname,
    publicIp: instance.publicIp,
    checkedAt,
    instance: { base, hosts: hosts.filter((h) => h.scope === 'instance').map(toStatus) },
    domains: [...byDomain.values()],
    records:
      base && target
        ? INSTANCE_PURPOSES.map((purpose) => ({
            type: 'CNAME' as const,
            name: `${purpose}.${base}`,
            value: `${target}.`,
            purpose,
          }))
        : [],
  };
}

/* ------------------------------ Rutas públicas ----------------------------- */

/** Host de la petición sin puerto ni punto final (con trustProxy, el reenviado). */
function requestHost(req: FastifyRequest): string {
  return String(req.hostname || '')
    .split(',')[0]!
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

function stripLabel(host: string, label: string): string | null {
  return host.startsWith(`${label}.`) ? host.slice(label.length + 1) : null;
}

/** Patrón que casa una palabra sin distinguir mayúsculas (find-my-way no admite flags). */
function ci(word: string): string {
  return word
    .split('')
    .map((ch) => (/[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch === '.' ? '\\.' : ch))
    .join('');
}

/** Política MTA-STS en modo de prueba: informa de fallos de TLS sin rechazar correo. */
export function mtaStsPolicy(mxHost: string): string {
  return ['version: STSv1', 'mode: testing', `mx: ${mxHost}`, 'max_age: 86400', ''].join('\r\n');
}

/** URL de Autodiscover POX que se anuncia en Autodiscover v2 para un dominio. */
function autodiscoverUrlFor(domain: string): string {
  const states = readAutoconfigHostStates();
  const own = `autodiscover.${domain}`;
  const base = instanceAutoconfigBase();
  const shared = base ? `autodiscover.${base}` : null;
  const host = states[own]?.state === 'ok' ? own : shared && states[shared]?.state === 'ok' ? shared : own;
  return `https://${host}/autodiscover/autodiscover.xml`;
}

async function thunderbirdHandler(req: FastifyRequest, reply: FastifyReply): Promise<string> {
  const query = req.query as Record<string, unknown>;
  const emailParam = typeof query.emailaddress === 'string' ? query.emailaddress.trim() : '';
  const host = requestHost(req);
  const hostDomain = stripLabel(host, 'autoconfig') ?? host;
  const base = instanceAutoconfigBase();

  let xml: string | null = null;
  if (emailParam) {
    // Con dirección manda su dominio, llegue por el host que llegue (por
    // ejemplo, autoconfig.<instancia> tras la búsqueda por MX).
    const domain = domainOf(emailParam);
    if (domain && clientOfMailDomain(domain)) {
      xml = thunderbirdAutoconfigXml(domain, getConnectionSettings(domain));
    }
  } else if (hostDomain && clientOfMailDomain(hostDomain)) {
    xml = thunderbirdAutoconfigXml(hostDomain, getConnectionSettings(hostDomain));
  } else if (base && hostDomain === base) {
    // Thunderbird para Android no envía la dirección: documento genérico
    // válido para cualquier dominio cuyo MX sea este servidor.
    xml = thunderbirdAutoconfigXml(base, getConnectionSettings(base, null), { placeholderDomain: true });
  }
  if (!xml) throw notFound('No hay autoconfiguración para ese dominio en este servidor.');
  reply.type(AUTOCONFIG_CONTENT_TYPE).header('Cache-Control', 'public, max-age=300');
  return xml;
}

function autodiscoverPoxResponse(body: unknown): string {
  try {
    const text = typeof body === 'string' ? body : '';
    const email = autodiscoverRequestEmail(text);
    const domain = email ? domainOf(email) : null;
    if (email && domain && clientOfMailDomain(domain)) {
      return autodiscoverXml(email, getConnectionSettings(domain));
    }
  } catch {
    // Cualquier fallo se contesta con el error de Autodiscover, nunca con 401/500.
  }
  return autodiscoverErrorXml();
}

function sendAutodiscoverXml(reply: FastifyReply, xml: string): FastifyReply {
  return reply.status(200).type(AUTODISCOVER_CONTENT_TYPE).header('Cache-Control', 'no-store').send(xml);
}

/** Autodiscover v2 (JSON): Outlook pregunta dónde está el Autodiscover POX. */
function autodiscoverV2(req: FastifyRequest, reply: FastifyReply, emailFromPath?: string): FastifyReply {
  const query = req.query as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = query[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };
  const protocol = pick('Protocol', 'protocol') || 'AutodiscoverV1';
  const email = (emailFromPath || pick('Email', 'email')).toLowerCase();
  reply.header('Cache-Control', 'no-store');
  if (protocol.toLowerCase() !== 'autodiscoverv1') {
    return reply.status(400).send({
      ErrorCode: 'InvalidProtocol',
      ErrorMessage: `El protocolo «${protocol.slice(0, 40)}» no está disponible. Solo se admite AutodiscoverV1.`,
    });
  }
  const domain = email ? domainOf(email) : null;
  if (!domain || !clientOfMailDomain(domain)) {
    return reply.status(404).send({
      ErrorCode: 'NotFound',
      ErrorMessage: 'La dirección no pertenece a ningún dominio de este servidor.',
    });
  }
  return reply.status(200).send({ Protocol: 'AutodiscoverV1', Url: autodiscoverUrlFor(domain) });
}

function mailboxRow(id: string): {
  id: string;
  local_part: string;
  display_name: string;
  domain: string;
  client_id: string;
} {
  const row = db
    .prepare(
      `SELECT m.id, m.local_part, m.display_name, d.domain, d.client_id
       FROM mailboxes m JOIN domains d ON d.id = m.domain_id WHERE m.id = ?`,
    )
    .get(id) as
    | { id: string; local_part: string; display_name: string; domain: string; client_id: string }
    | undefined;
  if (!row) throw notFound('Buzón no encontrado.');
  return row;
}

export function registerAutoconfigRoutes(app: FastifyInstance): void {
  // Nivel «warn»: son rutas públicas muy consultadas y su URL lleva la
  // dirección del usuario; no hace falta una línea de registro por petición.
  const quiet = { logLevel: 'warn' as const };

  /* Thunderbird (y Thunderbird para Android / K-9). */
  app.get('/mail/config-v1.1.xml', quiet, thunderbirdHandler);
  app.get('/.well-known/autoconfig/mail/config-v1.1.xml', quiet, thunderbirdHandler);

  /* MTA-STS: https://mta-sts.<dominio>/.well-known/mta-sts.txt, sin redirecciones. */
  app.get('/.well-known/mta-sts.txt', quiet, async (req, reply) => {
    const domain = stripLabel(requestHost(req), 'mta-sts');
    const mx = normalizeName(getInstanceSettings().mailHostname);
    if (!domain || !mx || !clientOfMailDomain(domain)) {
      throw notFound('No hay política MTA-STS para este dominio en este servidor.');
    }
    reply.type('text/plain; charset=utf-8').header('Cache-Control', 'public, max-age=3600');
    return mtaStsPolicy(mx);
  });

  /*
   * Autodiscover (Outlook y Thunderbird). En un ámbito propio porque necesita
   * aceptar cuerpos XML (y cualquier otro tipo, como texto) y porque sus
   * errores se contestan siempre con 200 y el XML de error: Thunderbird
   * envía aquí la contraseña real por Basic auth y un 401 le haría pedirla
   * de nuevo. La cabecera Authorization no se lee ni se registra.
   */
  const dir = `:dir(^${ci('autodiscover')}$)`;
  const file = `:file(^${ci('autodiscover')}\\.(?:${ci('xml')}|${ci('json')})$)`;
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => {
      done(null, body);
    });
    scope.setErrorHandler((_err, req, reply) => {
      if (/\.json/i.test(req.url)) {
        void reply.status(400).header('Cache-Control', 'no-store').send({
          ErrorCode: 'InvalidRequest',
          ErrorMessage: 'La petición no es válida.',
        });
        return;
      }
      void sendAutodiscoverXml(reply, autodiscoverErrorXml());
    });

    scope.route({
      method: ['GET', 'POST'],
      url: `/${dir}/${file}`,
      logLevel: 'warn',
      handler: async (req, reply) => {
        const { file: name } = req.params as { file: string };
        if (name.toLowerCase().endsWith('.json')) return autodiscoverV2(req, reply);
        return sendAutodiscoverXml(reply, autodiscoverPoxResponse(req.body));
      },
    });
    scope.get(`/${dir}/${file}/:ver(^[Vv]1\\.0$)/:email`, quiet, async (req, reply) => {
      const { file: name, email } = req.params as { file: string; email: string };
      if (!name.toLowerCase().endsWith('.json')) throw notFound();
      return autodiscoverV2(req, reply, email);
    });
  });

  /* Perfil de Apple de un buzón (sin contraseña: el dispositivo la pide). */
  app.get('/api/mailboxes/:id/mobileconfig', async (req, reply) => {
    requireAuth(req);
    const { id } = req.params as { id: string };
    const row = mailboxRow(id);
    requireClientAccess(req, row.client_id);
    const settings = getConnectionSettings(row.domain, row.client_id);
    if (!settings.imap.host) {
      throw conflict(
        'Falta el nombre del servidor de correo en Ajustes: no es posible generar el perfil.',
        'mail_hostname_missing',
      );
    }
    const email = `${row.local_part}@${row.domain}`;
    audit(req, 'autoconfig.profile_downloaded', { mailboxId: row.id, email });
    reply
      .type(MOBILECONFIG_CONTENT_TYPE)
      .header('Content-Disposition', `attachment; filename="${mobileconfigFilename(email)}"`)
      .header('Cache-Control', 'no-store');
    return mobileconfigPlist({ email, displayName: row.display_name || undefined, settings });
  });

  /**
   * Datos de conexión de un buzón: lo que el usuario final debe introducir en
   * su programa de correo, las URL de autoconfiguración y el webmail.
   */
  app.get('/api/mailboxes/:id/connection', async (req) => {
    requireAuth(req);
    const { id } = req.params as { id: string };
    const row = mailboxRow(id);
    requireClientAccess(req, row.client_id);
    return buildConnectionInfo(row.id, req);
  });

  /* Estado de los hosts de autoconfiguración (Ajustes). */
  app.get('/api/autoconfig/status', async (req) => {
    requireAdmin(req);
    return autoconfigStatus();
  });

  app.post('/api/autoconfig/refresh', async (req) => {
    requireAdmin(req);
    const summary = await refreshAutoconfigHosts();
    audit(req, 'autoconfig.hosts_checked', { ...summary });
    return { summary, status: autoconfigStatus() };
  });
}
