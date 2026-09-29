import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { HttpError } from '../src/core/errors';
import { StalwartEngine } from '../src/engine/stalwart';
import { getInstanceSettings, setInstanceSettings, setJsonSetting, setEngineSettings } from '../src/modules/settings';
import { getHostnameSyncStatus, syncMailHostname } from '../src/modules/hostname-sync';
import { registerSetupRoutes } from '../src/modules/setup';
import type { EngineSettings } from '../src/engine/types';

const settings: EngineSettings = {
  kind: 'stalwart', url: 'http://engine.test:8080', adminUser: 'admin', adminPassword: 'test-only',
  smtpHost: 'engine.test', smtpPort: 587, smtpSecure: false,
};

test('la env prevalece sobre SQLite; sin env se usa el ajuste guardado', (t) => {
  const original = config.mailHostnameDefault;
  t.after(() => { config.mailHostnameDefault = original; });
  setJsonSetting('instance', { mailHostname: 'old.example.com' });
  config.mailHostnameDefault = ' MAIL.Example.com. ';
  assert.equal(getInstanceSettings().mailHostname, 'mail.example.com');
  assert.throws(() => setInstanceSettings({ mailHostname: 'other.example.com' }), /MAILWAY_MAIL_HOSTNAME/);
  config.mailHostnameDefault = '';
  assert.equal(getInstanceSettings().mailHostname, 'old.example.com');
  setInstanceSettings({ mailHostname: ' NEW.example.com. ' });
  assert.equal(getInstanceSettings().mailHostname, 'new.example.com');
  for (const hostname of ['93e0126401b4', 'https://mail.example.com', '152.53.113.27', 'mail.example.com/path']) {
    assert.throws(() => setInstanceSettings({ mailHostname: hostname }), /dominio completo/);
  }
});

test('Stalwart guarda solo server.hostname, recarga y verifica el MX activo', async (t) => {
  let stored = '93e0126401b4';
  let runtime = stored;
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${options.method} ${path}`);
    if (path === '/api/settings/keys') return Response.json({ data: { 'server.hostname': stored } });
    if (path === '/api/settings') {
      const body = JSON.parse(String(options.body));
      assert.deepEqual(body, [{ type: 'insert', prefix: null, values: [['server.hostname', 'mail.example.com']], assert_empty: false }]);
      stored = body[0].values[0][1];
      return Response.json({ data: null });
    }
    if (path === '/api/reload') {
      runtime = stored;
      return Response.json({ data: { errors: {}, warnings: {} } });
    }
    if (path === '/api/dns/records/mail.example.com') {
      return Response.json({ data: [{ type: 'MX', name: 'mail.example.com.', content: `10 ${runtime}.` }] });
    }
    throw new Error(`Unexpected path ${path}`);
  });
  const engine = new StalwartEngine(settings);
  assert.deepEqual(await engine.syncHostname('mail.example.com'), { changed: true, previousHostname: '93e0126401b4' });
  assert.equal(runtime, 'mail.example.com');
  calls.length = 0;
  assert.equal((await engine.syncHostname('mail.example.com')).changed, false);
  assert.deepEqual(calls, ['GET /api/settings/keys', 'GET /api/dns/records/mail.example.com']);
});

test('si el valor está guardado pero no aplicado, reintenta la recarga sin reescribir', async (t) => {
  let runtime = 'old.example.com';
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(options.method, 'GET');
    const path = new URL(url).pathname;
    if (path === '/api/settings/keys') return Response.json({ data: { 'server.hostname': 'mail.example.com' } });
    if (path === '/api/reload') {
      runtime = 'mail.example.com';
      return Response.json({ data: { errors: {} } });
    }
    return Response.json({ data: [{ type: 'MX', name: 'mail.example.com', content: `10 ${runtime}.` }] });
  });
  assert.equal((await new StalwartEngine(settings).syncHostname('mail.example.com')).changed, true);
});

test('un HTTP 200 con errores de recarga o un MX sin actualizar no significa éxito', async (t) => {
  let reloadErrors: Record<string, unknown> = { 'server.hostname': { type: 'parse' } };
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/settings/keys') return Response.json({ data: { 'server.hostname': 'mail.example.com' } });
    if (path === '/api/reload') return Response.json({ data: { errors: reloadErrors } });
    return Response.json({ data: [{ type: 'MX', name: 'mail.example.com', content: '10 old.example.com.' }] });
  });
  const engine = new StalwartEngine(settings);
  await assert.rejects(engine.syncHostname('mail.example.com'), /recargar/);
  reloadErrors = {};
  await assert.rejects(engine.syncHostname('mail.example.com'), /sigue anunciando/);
});

test('la sincronización falla de forma visible, se recupera y sigue cambios posteriores de env', async (t) => {
  const originalEnv = config.mailHostnameDefault;
  const originalDemo = config.demoMode;
  t.after(() => { config.mailHostnameDefault = originalEnv; config.demoMode = originalDemo; });
  config.demoMode = false;
  config.mailHostnameDefault = 'first.example.com';
  setEngineSettings(settings);
  let fail = true;
  const applied: string[] = [];
  t.mock.method(StalwartEngine.prototype, 'syncHostname', async (hostname: string) => {
    applied.push(hostname);
    if (fail) throw new Error('engine offline');
    return { changed: true, previousHostname: 'old.example.com' };
  });
  assert.equal((await syncMailHostname(true)).status, 'error');
  assert.equal(getHostnameSyncStatus().status, 'error');
  fail = false;
  assert.equal((await syncMailHostname(true)).status, 'synced');
  await syncMailHostname();
  assert.equal(applied.length, 2, 'no repite escrituras durante el intervalo');
  config.mailHostnameDefault = 'second.example.com';
  assert.equal(getHostnameSyncStatus().status, 'pending');
  assert.equal((await syncMailHostname()).hostname, 'second.example.com');
  assert.deepEqual(applied, ['first.example.com', 'first.example.com', 'second.example.com']);
  const alert = db.prepare("SELECT resolved_at FROM alerts WHERE dedupe_key = 'hostname_sync_failed' ORDER BY id DESC LIMIT 1").get() as { resolved_at: number };
  assert.ok(alert.resolved_at);
});

test('la acción manual exige administrador y devuelve el error de sincronización', async (t) => {
  const originalEnv = config.mailHostnameDefault;
  const originalDemo = config.demoMode;
  t.after(() => { config.mailHostnameDefault = originalEnv; config.demoMode = originalDemo; });
  config.demoMode = false;
  config.mailHostnameDefault = 'mail.example.com';
  setEngineSettings(settings);
  let writes = 0;
  t.mock.method(StalwartEngine.prototype, 'syncHostname', async () => { writes++; throw new Error('offline'); });
  const app = Fastify();
  let admin = false;
  app.addHook('onRequest', async (req) => {
    req.user = { id: 'hostname_test', name: 'Test', email: 'test@example.com', role: admin ? 'admin' : 'client', clientId: null };
  });
  app.setErrorHandler((err, _req, reply) => reply.code(err instanceof HttpError ? err.status : 500).send({ error: err.message }));
  registerSetupRoutes(app);
  t.after(() => app.close());
  const denied = await app.inject({ method: 'POST', url: '/api/settings/hostname/sync' });
  assert.equal(denied.statusCode, 403);
  assert.equal(writes, 0);
  admin = true;
  const accepted = await app.inject({ method: 'POST', url: '/api/settings/hostname/sync' });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().hostnameSync.status, 'error');
  const view = await app.inject('/api/settings');
  assert.equal(view.json().hostnameFromEnv, true);
  assert.equal(view.json().hostnameSync.status, 'error');
});
