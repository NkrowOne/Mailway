import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { db } from '../src/core/db';
import { HttpError } from '../src/core/errors';
import { setInstanceSettings, getSetting, setSetting } from '../src/modules/settings';
import { registerAutoconfigRoutes } from '../src/modules/autoconfig';
import { registerDashboardRoutes } from '../src/modules/dashboard';
import {
  checkHttps, getClientWebmailUrl, setPrimaryWebmail,
  registerWhitelabelRoutes, getTraefikToken,
} from '../src/modules/whitelabel';

beforeEach(() => {
  db.prepare("DELETE FROM clients WHERE id IN ('web_a', 'web_b')").run();
  db.prepare('INSERT OR IGNORE INTO plans (id, name, created_at) VALUES (?, ?, ?)')
    .run('web_plan', 'Webmail', 0);
  for (const id of ['web_a', 'web_b']) {
    db.prepare('INSERT INTO clients (id, name, slug, plan_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, id, id, 'web_plan', 0);
  }
  setInstanceSettings({ webmailUrl: 'https://webmail.provider.example', mailHostname: 'smtp.provider.example' });
});

function seed(id: string, clientId = 'web_a', status = 'active', kind = 'webmail') {
  db.prepare(`INSERT INTO client_domains (id, client_id, hostname, kind, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, clientId, `${id}.example.com`, kind, status, 1);
}

function appFor(clientId: string | null = 'web_a') {
  const app = Fastify();
  // Stub the authenticated identity, retaining the real authorization checks.
  app.addHook('onRequest', async (req) => {
    req.user = { id: 'test_user', name: 'Test', email: 'test@example.com',
      role: clientId ? 'client' : 'admin', clientId };
  });
  app.setErrorHandler((error, _req, reply) => {
    reply.code(error instanceof HttpError ? error.status : 500).send({ error: error.message });
  });
  registerWhitelabelRoutes(app);
  registerDashboardRoutes(app);
  // Los datos de conexión de un buzón viven con la autoconfiguración.
  registerAutoconfigRoutes(app);
  return app;
}

test('solo usa webmail activo del cliente y permite elegir el principal', () => {
  seed('web_other', 'web_b');
  seed('web_pending', 'web_a', 'issuing');
  seed('web_panel', 'web_a', 'active', 'panel');
  assert.equal(getClientWebmailUrl('web_a'), 'https://webmail.provider.example');
  seed('web_first');
  seed('web_second');
  assert.equal(getClientWebmailUrl('web_a'), 'https://web_first.example.com');
  setPrimaryWebmail('web_second');
  assert.equal(getClientWebmailUrl('web_a'), 'https://web_second.example.com');
  setPrimaryWebmail('web_first');
  assert.equal(getClientWebmailUrl('web_a'), 'https://web_first.example.com');
  assert.throws(() => setPrimaryWebmail('web_pending'), /HTTPS/);
  assert.throws(() => setPrimaryWebmail('web_panel'), /HTTPS/);
});

test('al perder o borrar el principal usa otro activo y después el general', () => {
  seed('web_first');
  seed('web_second');
  setPrimaryWebmail('web_second');
  db.prepare("UPDATE client_domains SET status = 'issuing' WHERE id = 'web_second'").run();
  assert.equal(getClientWebmailUrl('web_a'), 'https://web_first.example.com');
  db.prepare("DELETE FROM client_domains WHERE client_id = 'web_a'").run();
  assert.equal(getClientWebmailUrl('web_a'), 'https://webmail.provider.example');
  setInstanceSettings({ webmailUrl: '' });
  assert.equal(getClientWebmailUrl('web_a'), '');
});

test('Inicio y datos del buzón devuelven el mismo webmail personalizado', async (t) => {
  seed('web_first');
  seed('web_second');
  setPrimaryWebmail('web_second');
  db.prepare(`INSERT INTO domains (id, client_id, domain, created_at)
    VALUES ('web_domain', 'web_a', 'web-a.example', 0)`).run();
  db.prepare(`INSERT INTO mailboxes (id, domain_id, local_part, created_at)
    VALUES ('web_mailbox', 'web_domain', 'hello', 0)`).run();
  const app = appFor();
  t.after(() => app.close());
  const dashboard = await app.inject('/api/dashboard/client');
  const connection = await app.inject('/api/mailboxes/web_mailbox/connection');
  assert.equal(dashboard.statusCode, 200);
  assert.equal(connection.statusCode, 200);
  assert.equal(dashboard.json().webmailUrl, 'https://web_second.example.com');
  assert.equal(connection.json().webmailUrl, dashboard.json().webmailUrl);
  assert.equal(connection.json().imap.host, 'smtp.provider.example');
});

test('un cliente no puede listar ni seleccionar el dominio de otro', async (t) => {
  seed('web_first');
  seed('web_other', 'web_b');
  const app = appFor();
  t.after(() => app.close());
  const list = await app.inject('/api/whitelabel/domains?clientId=web_b');
  assert.deepEqual(list.json().domains.map((d: { id: string }) => d.id), ['web_first']);
  const denied = await app.inject({ method: 'POST', url: '/api/whitelabel/domains/web_other/primary' });
  assert.equal(denied.statusCode, 403);
  const allowed = await app.inject({ method: 'POST', url: '/api/whitelabel/domains/web_first/primary' });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().domain.isPrimary, true);
});

test('el administrador selecciona el principal del cliente indicado', async (t) => {
  seed('web_other', 'web_b');
  const app = appFor(null);
  t.after(() => app.close());
  const result = await app.inject({ method: 'POST', url: '/api/whitelabel/domains/web_other/primary' });
  assert.equal(result.statusCode, 200);
  assert.equal(getClientWebmailUrl('web_b'), 'https://web_other.example.com');
  assert.equal(getClientWebmailUrl('web_a'), 'https://webmail.provider.example');
});

test('la conexión con Skyway solo se registra tras una consulta autenticada', async (t) => {
  const app = appFor(null);
  t.after(() => app.close());
  setSetting('traefik_last_poll', '');
  const denied = await app.inject('/api/traefik/config');
  assert.equal(denied.statusCode, 401);
  assert.equal(getSetting('traefik_last_poll'), '');
  const accepted = await app.inject({ url: '/api/traefik/config', headers: { 'x-mailway-token': getTraefikToken() } });
  assert.equal(accepted.statusCode, 200);
  assert.ok(Number(getSetting('traefik_last_poll')) > 0);
  const setup = await app.inject('/api/whitelabel/setup');
  assert.equal(setup.json().lastPollAt, Number(getSetting('traefik_last_poll')));
});

test('404, 5xx y errores TLS no pasan por HTTPS operativo', async (t) => {
  // fetch está simulado: no hay red real, así que se desactiva el modo sin
  // red de las pruebas para que checkHttps llegue a llamarlo.
  const offline = process.env.MAILWAY_DNS_OFFLINE;
  process.env.MAILWAY_DNS_OFFLINE = '0';
  t.after(() => {
    if (offline === undefined) delete process.env.MAILWAY_DNS_OFFLINE;
    else process.env.MAILWAY_DNS_OFFLINE = offline;
  });
  const fakeFetch = t.mock.method(globalThis, 'fetch');
  for (const status of [404, 500, 502, 503]) {
    fakeFetch.mock.mockImplementation(async () => new Response(null, { status }));
    const result = await checkHttps('mail.example.com');
    assert.equal(result.ok, false);
    assert.match(result.detail, new RegExp(String(status)));
  }
  fakeFetch.mock.mockImplementation(async () => { throw new Error('self signed certificate'); });
  assert.equal((await checkHttps('mail.example.com')).ok, false);
  for (const status of [200, 302]) {
    fakeFetch.mock.mockImplementation(async () => new Response(null, { status }));
    assert.equal((await checkHttps('mail.example.com')).ok, true);
  }
});
