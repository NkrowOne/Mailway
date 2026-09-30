import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resolver } from 'node:dns/promises';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { HttpError } from '../src/core/errors';
import { getEngine } from '../src/engine';
import { ensureDefaultPlans } from '../src/modules/clients';
import { setEngineSettings, setInstanceSettings } from '../src/modules/settings';
import { registerSkywayRoutes, rootDomain } from '../src/modules/skyway';

test('dominios raíz reales, incluidos sufijos compuestos; rechaza hosts internos y subdominios', () => {
  for (const d of ['codanuancelegal.com', 'business.co.uk']) assert.equal(rootDomain(d), d);
  for (const d of ['webmail.company.com', 'company', 'co.uk', 'company.invalid', 'https://company.com', '1.2.3.4']) assert.throws(() => rootDomain(d));
});

test('integración: autorización, reintento parcial, aislamiento, DNS y rutas reales', async t => {
  const oldDemo = config.demoMode;
  config.demoMode = false;
  process.env.MAILWAY_SKYWAY_TOKEN = 'test-token-for-skyway-at-least-32-characters';
  t.after(() => { config.demoMode = oldDemo; delete process.env.MAILWAY_SKYWAY_TOKEN; });
  ensureDefaultPlans();
  // Otras suites pueden crear sus propios planes en la base compartida.
  db.prepare("INSERT OR IGNORE INTO plans (id, name, max_mailboxes, created_at) VALUES ('plan_basico', 'Plan integración', 5, 0)").run();
  db.prepare("DELETE FROM clients WHERE notes LIKE 'Skyway: test-onboarding/%'").run();
  setInstanceSettings({ mailHostname: 'mail.provider.com', publicIp: '192.0.2.1' });
  setEngineSettings({ kind: 'stalwart', url: 'http://test-onboarding:8080', adminUser: 'admin', adminPassword: 'fake', smtpHost: 'test', smtpPort: 587, smtpSecure: false });
  const engine = getEngine();
  const created: string[] = [];
  let fail = true;
  let domainCreates = 0;
  t.mock.method(engine, 'syncHostname', async () => ({ changed: false, previousHostname: 'mail.provider.com' }));
  t.mock.method(engine, 'createDomain', async () => { domainCreates++; });
  t.mock.method(engine, 'ensureDkim', async () => {});
  t.mock.method(engine, 'createMailbox', async (a: { email: string }) => {
    if (a.email.startsWith('no-reply@') && fail) { fail = false; throw new Error('temporary'); }
    created.push(a.email);
  });
  const records = [
    { type: 'MX', name: 'codanuancelegal.com.', content: '10 mail.provider.com.' },
    { type: 'TXT', name: 'codanuancelegal.com.', content: 'v=spf1 mx -all' },
    { type: 'TXT', name: 'mail._domainkey.codanuancelegal.com.', content: 'v=DKIM1; p=abc' },
    { type: 'A', name: 'codanuancelegal.com.', content: '192.0.2.99' },
    { type: 'A', name: 'mail.provider.com.', content: '192.0.2.1' },
  ];
  t.mock.method(engine, 'getDnsRecords', async () => records);
  t.mock.method(Resolver.prototype, 'resolveMx', async () => []);
  t.mock.method(Resolver.prototype, 'resolveTxt', async () => []);
  t.mock.method(Resolver.prototype, 'resolve4', async () => []);
  t.mock.method(Resolver.prototype, 'resolveCname', async () => []);
  const app = Fastify();
  app.setErrorHandler((e, _req, reply) => reply.code(e instanceof HttpError ? e.status : e instanceof ZodError ? 400 : 500).send({ error: e.message }));
  registerSkywayRoutes(app);
  t.after(() => app.close());
  const payload = { source: 'test-onboarding', serviceId: 'service1', domain: 'codanuancelegal.com',
    accounts: ['info', 'no-reply', 'postmaster'].map(localPart => ({ localPart, password: 'A-unique-test-password' })) };
  const headers = { authorization: `Bearer ${process.env.MAILWAY_SKYWAY_TOKEN}` };
  const post = (action: string, body = payload) => app.inject({ method: 'POST', url: `/api/integrations/skyway/${action}`, headers, payload: body });
  assert.equal((await app.inject({ method: 'POST', url: '/api/integrations/skyway/provision', payload })).statusCode, 401);
  assert.equal((await post('provision', { ...payload, accounts: payload.accounts.slice(0, 2) })).statusCode, 400);
  assert.equal((await post('provision')).statusCode, 500);
  assert.deepEqual(created, ['info@codanuancelegal.com']);
  assert.equal((await post('status')).json().partial, true);
  const retry = await post('provision');
  assert.equal(retry.statusCode, 200, retry.body);
  const report = retry.json();
  assert.equal(report.webmailUrl, 'https://webmail.codanuancelegal.com');
  assert.equal(report.ready, false);
  assert.equal(report.accounts.length, 3);
  assert.match(report.zone, /webmail.codanuancelegal.com\.\s+.*CNAME\s+mail.provider.com\./);
  assert.doesNotMatch(report.zone, /192\.0\.2\.99|A\s+192\.0\.2\.1/);
  assert.doesNotMatch(retry.body, /A-unique-test-password/);
  assert.equal(domainCreates, 1);
  await post('provision');
  assert.equal(created.length, 3, 'no duplicate accounts or password resets');
  assert.equal((await post('provision', { ...payload, serviceId: 'other-service' })).statusCode, 409);
  assert.equal((await post('verify')).json().ready, false);
  const unauthProxy = await app.inject({ url: '/api/integrations/skyway/traefik' });
  assert.equal(unauthProxy.statusCode, 401);
  const pendingProxy = await app.inject({ url: '/api/integrations/skyway/traefik', headers });
  assert.ok(!Object.values(pendingProxy.json().http.routers).some((r: any) => r.rule === 'Host(`webmail.codanuancelegal.com`)'), 'no ACME route before DNS verification');
  db.prepare("UPDATE client_domains SET status = 'issuing' WHERE hostname = 'webmail.codanuancelegal.com'").run();
  const proxy = (await app.inject({ url: '/api/integrations/skyway/traefik', headers })).json();
  assert.ok(Object.values(proxy.http.routers).some((r: any) => r.rule === 'Host(`webmail.codanuancelegal.com`)'));
  const client = db.prepare('SELECT client_id FROM skyway_bindings WHERE domain = ?').get(payload.domain) as { client_id: string };
  db.prepare('UPDATE clients SET suspended = 1 WHERE id = ?').run(client.client_id);
  assert.equal((await post('provision')).statusCode, 400);
});
