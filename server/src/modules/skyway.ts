import { timingSafeEqual } from 'node:crypto';
import { parse } from 'tldts';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db, now } from '../core/db';
import { randomId } from '../core/crypto';
import { badRequest, conflict, unauthorized } from '../core/errors';
import { validateMailHostname } from '../core/mail-hostname';
import { getEngine } from '../engine';
import { assertWithinLimit, getClient, getPlan, getClientUsage } from './clients';
import { getDomain, refreshDomainDns } from './domains';
import { getInstanceSettings, setSetting } from './settings';
import { syncMailHostname } from './hostname-sync';
import { buildTraefikConfig, getClientDomain, kindAvailable, refreshClientDomain, setPrimaryWebmail } from './whitelabel';
import { generarZona, evaluarConflicto } from './zonefile';
import { lookupMx, lookupTxt } from '../core/dns';
import { audit } from './audit';

const identity = z.object({
  source: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  serviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  domain: z.string().trim().toLowerCase().max(253),
});
const account = z.object({
  localPart: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/),
  password: z.string().min(12).max(128),
});
const setup = identity.extend({ accounts: z.array(account).min(1).max(20) });
type Identity = z.infer<typeof identity>;

function authorize(req: FastifyRequest) {
  const token = Buffer.from(process.env.MAILWAY_SKYWAY_TOKEN?.trim() || '');
  const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
  if (token.length < 32 || token.length !== supplied.length ||
      !timingSafeEqual(token, supplied)) throw unauthorized('Integración Skyway no autorizada.');
}

export function rootDomain(domain: string): string {
  const parsed = parse(domain);
  if (!parsed.isIcann || parsed.domain !== domain || !/^[a-z0-9.-]+$/.test(domain)) {
    throw badRequest('Usa el dominio raíz, por ejemplo codanuancelegal.com, sin www ni webmail.');
  }
  return validateMailHostname(domain);
}

function binding(input: Identity): { client_id: string } | undefined {
  return db.prepare('SELECT client_id FROM skyway_bindings WHERE source = ? AND service_id = ? AND domain = ?')
    .get(input.source, input.serviceId, input.domain) as { client_id: string } | undefined;
}

// Serializa altas y reintentos de esta integración para no duplicar recursos al doble clic.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.catch(() => undefined);
  return result;
}

async function provision(input: z.infer<typeof setup>) {
  rootDomain(input.domain);
  if (new Set(input.accounts.map(a => a.localPart)).size !== input.accounts.length) throw badRequest('Hay direcciones repetidas.');
  if (!input.accounts.some(a => a.localPart === 'postmaster')) throw badRequest('Incluye postmaster para los avisos del servidor.');
  const engine = getEngine();
  if (engine.kind === 'demo') throw badRequest('Conecta un motor real antes de configurar correo desde Skyway.');
  if (!kindAvailable('webmail')) throw badRequest('Configura MAILWAY_WEBMAIL_BACKEND_URL.');
  const sync = await syncMailHostname();
  if (sync.status !== 'synced') throw badRequest(sync.detail);
  let link = binding(input);
  const existing = db.prepare('SELECT id, client_id FROM domains WHERE domain = ?').get(input.domain) as { id: string; client_id: string } | undefined;
  if (existing && (!link || existing.client_id !== link.client_id)) throw conflict('Este dominio ya pertenece a otro alta de Mailway. Un administrador debe revisar su vinculación.');
  const webmail = `webmail.${input.domain}`;
  if (getInstanceSettings().mailHostname === webmail) throw badRequest('El hostname del motor debe ser distinto del dominio de webmail. Usa mail.tudominio.com para el motor.');
  const web = db.prepare('SELECT id, client_id, kind FROM client_domains WHERE hostname = ?').get(webmail) as { id: string; client_id: string; kind: string } | undefined;
  if (web && (!link || web.client_id !== link.client_id || web.kind !== 'webmail')) throw conflict('El dominio de webmail ya está asignado.');
  if (!link) {
    const plan = getPlan(process.env.MAILWAY_SKYWAY_PLAN_ID || 'plan_basico');
    if (input.accounts.length > plan.maxMailboxes) throw badRequest(`El plan permite ${plan.maxMailboxes} buzones.`);
    const clientId = randomId('cli');
    db.transaction(() => {
      db.prepare('INSERT INTO clients (id, name, slug, plan_id, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(clientId, input.domain, clientId, plan.id, `Skyway: ${input.source}/${input.serviceId}`, now());
      db.prepare('INSERT INTO skyway_bindings (source, service_id, domain, client_id) VALUES (?, ?, ?, ?)')
        .run(input.source, input.serviceId, input.domain, clientId);
    })();
    link = { client_id: clientId };
  }
  const client = getClient(link.client_id);
  if (client.suspended) throw badRequest('Este cliente está suspendido.');
  const plan = getPlan(client.planId);
  let domainId = existing?.id;
  if (!domainId) {
    assertWithinLimit(client.id, 'domains');
    await engine.createDomain(input.domain);
    domainId = randomId('dom');
    try {
      db.prepare('INSERT INTO domains (id, client_id, domain, created_at) VALUES (?, ?, ?, ?)').run(domainId, client.id, input.domain, now());
    } catch (err) { await engine.deleteDomain(input.domain).catch(() => undefined); throw err; }
  }
  await engine.ensureDkim(input.domain, 'mail');
  const missing = input.accounts.filter(a => !db.prepare('SELECT 1 FROM mailboxes WHERE domain_id = ? AND local_part = ?').get(domainId, a.localPart));
  if (getClientUsage(client.id).mailboxes + missing.length > plan.maxMailboxes) throw badRequest('Las cuentas superan el límite del plan.');
  for (const a of missing) {
    if (db.prepare('SELECT 1 FROM aliases WHERE domain_id = ? AND local_part = ?').get(domainId, a.localPart)) throw conflict(`Ya existe un alias ${a.localPart}.`);
    assertWithinLimit(client.id, 'mailboxes');
    const email = `${a.localPart}@${input.domain}`;
    await engine.createMailbox({ email, password: a.password, quotaBytes: plan.mailboxQuotaMb * 1024 * 1024 });
    try {
      db.prepare('INSERT INTO mailboxes (id, domain_id, local_part, quota_mb, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(randomId('mbx'), domainId, a.localPart, plan.mailboxQuotaMb, now());
    } catch (err) { await engine.deleteMailbox(email).catch(() => undefined); throw err; }
  }
  if (!web) db.prepare('INSERT INTO client_domains (id, client_id, hostname, kind, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(randomId('cdm'), client.id, webmail, 'webmail', now());
}

async function report(input: Identity, verify = false) {
  rootDomain(input.domain);
  const link = binding(input);
  if (!link) return { configured: false, domain: input.domain };
  if (getClient(link.client_id).suspended) throw badRequest('Este cliente está suspendido.');
  const d = db.prepare('SELECT id FROM domains WHERE client_id = ? AND domain = ?').get(link.client_id, input.domain) as { id: string } | undefined;
  const w = db.prepare("SELECT id FROM client_domains WHERE client_id = ? AND hostname = ? AND kind = 'webmail'").get(link.client_id, `webmail.${input.domain}`) as { id: string } | undefined;
  const accounts = d ? (db.prepare('SELECT local_part FROM mailboxes WHERE domain_id = ? ORDER BY local_part').all(d.id) as { local_part: string }[])
    .map(a => `${a.local_part}@${input.domain}`) : [];
  if (!d || !w) return { configured: false, domain: input.domain, partial: true, accounts };
  const [domain, webmail] = verify
    ? await Promise.all([refreshDomainDns(d.id), refreshClientDomain(w.id)])
    : [getDomain(d.id), getClientDomain(w.id)];
  if (webmail.status === 'active' && !webmail.isPrimary) setPrimaryWebmail(webmail.id);
  const settings = getInstanceSettings();
  validateMailHostname(settings.mailHostname);
  const records = await getEngine().getDnsRecords(input.domain);
  for (const r of records.filter(r => r.type === 'MX')) validateMailHostname(r.content.trim().split(/\s+/).at(-1) || '');
  // El A/CNAME raíz es de la web; nunca se exporta el de Stalwart por encima.
  const ownRecords = records.filter(r => (r.name.replace(/\.$/, '') === input.domain || r.name.replace(/\.$/, '').endsWith(`.${input.domain}`)) &&
    !(r.name.replace(/\.$/, '') === input.domain && ['A', 'AAAA', 'CNAME'].includes(r.type)) &&
    r.name.replace(/\.$/, '') !== webmail.hostname);
  ownRecords.push({ type: 'CNAME', name: webmail.hostname, content: `${settings.mailHostname}.` });
  const [mx, txt, dmarc] = await Promise.all([lookupMx(input.domain), lookupTxt(input.domain), lookupTxt(`_dmarc.${input.domain}`)]);
  const warning = evaluarConflicto({ mx, txt, dmarc, mailHostname: settings.mailHostname,
    mxEsperados: records.filter(r => r.type === 'MX').map(r => r.content.trim().split(/\s+/).at(-1) || '') });
  return {
    configured: true, domain: input.domain, webmailUrl: `https://${webmail.hostname}`,
    mailStatus: domain.status, webmailStatus: webmail.status, webmailDetail: webmail.detail,
    ready: domain.dnsStatus.allRequiredOk === true && webmail.status === 'active',
    accounts,
    checks: domain.dnsStatus.checks || [], warning: warning.aviso,
    dnsUnknown: mx === null || txt === null || dmarc === null,
    zone: generarZona({ domain: input.domain, records: ownRecords, nivel: 'recomendados' }),
  };
}

export function registerSkywayRoutes(app: FastifyInstance) {
  app.get('/api/integrations/skyway/traefik', async req => {
    authorize(req);
    const result = buildTraefikConfig();
    setSetting('traefik_last_poll', String(now()));
    return result;
  });
  app.post('/api/integrations/skyway/status', async (req, reply) => {
    authorize(req); reply.header('Cache-Control', 'no-store');
    return report(identity.parse(req.body));
  });
  app.post('/api/integrations/skyway/provision', async (req, reply) => {
    authorize(req); reply.header('Cache-Control', 'no-store');
    const input = setup.parse(req.body);
    await exclusive(() => provision(input));
    audit(req, 'skyway.provisioned', { source: input.source, serviceId: input.serviceId, domain: input.domain });
    return report(input);
  });
  app.post('/api/integrations/skyway/verify', async (req, reply) => {
    authorize(req); reply.header('Cache-Control', 'no-store');
    return report(identity.parse(req.body), true);
  });
}
