import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resolver } from 'node:dns/promises';
import Fastify from 'fastify';
import { checkDomainDns } from '../src/modules/deliverability';
import { registerSetupRoutes } from '../src/modules/setup';
import { HttpError } from '../src/core/errors';
import { config } from '../src/config';
import { setEngineSettings, setJsonSetting } from '../src/modules/settings';
import { StalwartEngine } from '../src/engine/stalwart';
import { syncMailHostname } from '../src/modules/hostname-sync';
import { db } from '../src/core/db';
import { runWatchdogOnce } from '../src/modules/watchdog';

const records = [
  { type: 'MX', name: 'example.com.', content: '10 mail.example.com.' },
  { type: 'TXT', name: 'example.com.', content: 'v=spf1 mx -all' },
  { type: 'TXT', name: 's._domainkey.example.com.', content: 'v=DKIM1; k=rsa; p=ABC' },
  { type: 'TXT', name: '_dmarc.example.com.', content: 'v=DMARC1; p=reject' },
];

test('DNS completo; MX extra/prioridad errónea, políticas duplicadas y DKIM ausente bloquean el verde', async (t) => {
  let mx = [{ priority: 10, exchange: 'mail.example.com' }];
  let spf = ['v=spf1 mx -all'];
  let dmarc = ['v=DMARC1; p=reject'];
  t.mock.method(Resolver.prototype, 'resolveMx', async () => mx);
  t.mock.method(Resolver.prototype, 'resolveTxt', async (name: string) =>
    (name === 'example.com' ? spf : name.startsWith('_dmarc') ? dmarc : ['v=DKIM1; k=rsa; p=ABC']).map((s) => [s]));
  assert.equal((await checkDomainDns('example.com', records)).allRequiredOk, true);
  mx = [...mx, { priority: 20, exchange: 'old.example.net' }];
  assert.equal((await checkDomainDns('example.com', records)).allRequiredOk, false);
  mx = [{ priority: 20, exchange: 'mail.example.com' }];
  assert.equal((await checkDomainDns('example.com', records)).allRequiredOk, false);
  mx[0]!.priority = 10;
  spf.push('v=spf1 include:other.example -all');
  assert.equal((await checkDomainDns('example.com', records)).allRequiredOk, false);
  for (const invalid of ['v=spf1 -mx -all', 'v=spf1 include:mx.attacker.example -all', 'v=spf1 -all mx']) {
    spf = [invalid];
    assert.equal((await checkDomainDns('example.com', records)).allRequiredOk, false, invalid);
  }
  spf = ['v=spf1 mx include:other.example -all'];
  assert.equal((await checkDomainDns('example.com', records)).allRequiredOk, true);
  dmarc.push('v=DMARC1; p=none');
  assert.equal((await checkDomainDns('example.com', records)).allRequiredOk, false);
  dmarc = ['v=DMARC1; p=reject-invalid'];
  assert.equal((await checkDomainDns('example.com', records)).allRequiredOk, false);
  dmarc = ['v=DMARC1; p=quarantine'];
  assert.equal((await checkDomainDns('example.com', records.filter((r) => !r.name.includes('_domainkey')))).allRequiredOk, false);
});

test('SRV comprueba puerto, prioridad y peso; AAAA se consulta de verdad', async (t) => {
  t.mock.method(Resolver.prototype, 'resolveSrv', async () => [{ priority: 0, weight: 1, port: 143, name: 'mail.example.com' }]);
  t.mock.method(Resolver.prototype, 'resolve6', async () => ['2001:db8::1']);
  const report = await checkDomainDns('example.com', [
    { type: 'SRV', name: '_imaps._tcp.example.com', content: '0 1 993 mail.example.com.' },
    { type: 'AAAA', name: 'mail.example.com', content: '2001:db8::1' },
  ]);
  assert.equal(report.checks.find((c) => c.type === 'SRV')?.status, 'mismatch');
  assert.equal(report.checks.find((c) => c.type === 'AAAA')?.status, 'ok');
});

test('la API no completa el asistente si Stalwart no confirma la identidad', async (t) => {
  const previous = { demo: config.demoMode, hostname: config.mailHostnameDefault };
  t.after(() => { config.demoMode = previous.demo; config.mailHostnameDefault = previous.hostname; });
  config.demoMode = false;
  config.mailHostnameDefault = 'mail.example.com';
  setEngineSettings({ kind: 'stalwart', url: 'http://engine.test', adminUser: 'admin', adminPassword: 'test', smtpHost: 'engine.test', smtpPort: 587, smtpSecure: false });
  let fails = true;
  t.mock.method(StalwartEngine.prototype, 'syncHostname', async () => {
    if (fails) throw new Error('offline');
    return { changed: false, previousHostname: 'mail.example.com' };
  });
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('onRequest', async (req) => { req.user = { id: 'ready_admin', role: 'admin', clientId: null, name: 'Test', email: 'test@example.com' }; });
  app.setErrorHandler((err, _req, reply) => reply.code(err instanceof HttpError ? err.status : 500).send({ error: err.message }));
  registerSetupRoutes(app);
  assert.equal((await app.inject({ method: 'POST', url: '/api/setup/complete' })).statusCode, 400);
  fails = false;
  assert.equal((await app.inject({ method: 'POST', url: '/api/setup/complete' })).statusCode, 200);
});

test('cambiar identidad invalida el informe pero conserva el seguimiento de dominios anteriores', async (t) => {
  const previous = { demo: config.demoMode, hostname: config.mailHostnameDefault };
  t.after(() => { config.demoMode = previous.demo; config.mailHostnameDefault = previous.hostname; });
  config.demoMode = false;
  config.mailHostnameDefault = 'new.example.com';
  t.mock.method(StalwartEngine.prototype, 'syncHostname', async () => ({ changed: true, previousHostname: 'old.example.com' }));
  db.prepare("INSERT OR IGNORE INTO plans (id, name, created_at) VALUES ('ready_p','P',0)").run();
  db.prepare("INSERT OR IGNORE INTO clients (id,name,slug,plan_id,created_at) VALUES ('ready_c','C','ready-c','ready_p',0)").run();
  db.prepare("INSERT OR REPLACE INTO domains (id,client_id,domain,status,verified_at,created_at) VALUES ('ready_d','ready_c','ready.example.com','active',123,0)").run();
  await syncMailHostname(true);
  const row = db.prepare("SELECT status, verified_at, dns_status_json FROM domains WHERE id='ready_d'").get() as {status: string; verified_at: number; dns_status_json: string};
  assert.equal(row.status, 'pending_dns');
  assert.equal(row.verified_at, 123);
  assert.equal(row.dns_status_json, '{}');
});

test('el vigilante alerta ante un 404 del webmail compartido', async (t) => {
  setJsonSetting('watchdog_last_domains', Date.now());
  setJsonSetting('watchdog_last_whitelabel', Date.now());
  setJsonSetting('instance', { webmailUrl: 'https://webmail.example.com' });
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  await runWatchdogOnce();
  const alert = db.prepare("SELECT resolved_at FROM alerts WHERE dedupe_key='webmail_down' ORDER BY id DESC LIMIT 1").get() as {resolved_at: number | null};
  assert.equal(alert.resolved_at, null);
});
