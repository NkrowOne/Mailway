import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { encryptSecret } from '../src/core/crypto';
import { db, now } from '../src/core/db';
import { getEngine } from '../src/engine';
import { listAlerts } from '../src/modules/alerts';
import {
  checkEngineTls,
  evaluateTlsAlerts,
  recommendedEngineSettings,
  type EngineTlsStatus,
} from '../src/modules/engineops';
import { setInstanceSettings } from '../src/modules/settings';
import { adminContext, createClient, type TestContext } from './helpers';

/*
 * Operaciones del servidor de correo contra el motor de demostración, que
 * guarda en memoria lo que se le escribe: así se comprueba qué claves llegan
 * al motor sin un Stalwart real ni red.
 */

const HOST = 'mail.mailway.test';
const CF_TOKEN = 'cf-token-de-prueba-que-no-debe-salir';

let ctx: TestContext;
let clientCookie = '';
let clientId = '';

before(async () => {
  ctx = await adminContext();
  setInstanceSettings({ mailHostname: HOST });
  const client = await createClient(ctx, { withUser: true });
  clientCookie = client.userCookie!;
  clientId = client.clientId;
});

after(() => {
  mock.restoreAll();
});

function insertCloudflareAccount(id: string, owner: string | null): void {
  db.prepare(
    `INSERT INTO cloudflare_accounts (id, client_id, label, token_enc, token_hint, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, owner, `Cuenta ${id}`, encryptSecret(CF_TOKEN), CF_TOKEN.slice(-4), now());
}

/** Cloudflare simulado: solo la zona mailway.test es visible para el token. */
function mockCloudflare(visibleZone: string | null) {
  const calls: { url: string; authorization: string | null }[] = [];
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    calls.push({ url: url.href, authorization: headers.get('authorization') });
    const name = url.searchParams.get('name');
    const result = visibleZone && name === visibleZone ? [{ id: 'zona-1', name: visibleZone, status: 'active' }] : [];
    return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

test('las operaciones del motor son solo para administradores', async () => {
  const routes: { method: 'GET' | 'POST'; url: string; payload?: object }[] = [
    { method: 'GET', url: '/api/engine/status' },
    { method: 'POST', url: '/api/engine/recommended' },
    { method: 'POST', url: '/api/engine/acme', payload: { cloudflareAccountId: 'x', email: 'a@b.es' } },
    { method: 'POST', url: '/api/engine/reload-certificate' },
  ];
  for (const route of routes) {
    const anon = await ctx.app.inject({ method: route.method, url: route.url, payload: route.payload });
    assert.equal(anon.statusCode, 401, `${route.url} sin sesión`);
    const cliente = await ctx.app.inject({
      method: route.method,
      url: route.url,
      payload: route.payload,
      headers: { cookie: clientCookie },
    });
    assert.equal(cliente.statusCode, 403, `${route.url} con usuario de cliente`);
  }
});

test('aplicar los ajustes recomendados los escribe en el motor', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/engine/recommended',
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { applied: string[]; hostname: string; errors: string[] };
  assert.equal(body.hostname, HOST);
  assert.deepEqual(body.errors, []);
  assert.ok(body.applied.includes('server.allowed-ip.10.203.53.0/24'));

  const stored = await getEngine().getServerSettings([
    'server.hostname',
    'http.use-x-forwarded',
    'server.allowed-ip.10.203.53.0/24',
  ]);
  assert.deepEqual(stored, {
    'server.hostname': HOST,
    'http.use-x-forwarded': 'true',
    'server.allowed-ip.10.203.53.0/24': '',
  });

  const audited = db
    .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'engine.recommended_applied'")
    .get() as { c: number };
  assert.equal(audited.c, 1);
});

test('el rango exento se puede cambiar por entorno y descarta valores no válidos', () => {
  const previous = process.env.MAILWAY_ENGINE_TRUSTED_NETWORK;
  process.env.MAILWAY_ENGINE_TRUSTED_NETWORK = '10.9.8.0/24, no-es-una-red, fd00:5e::/64';
  try {
    const values = recommendedEngineSettings(HOST);
    assert.deepEqual(
      Object.keys(values).filter((k) => k.startsWith('server.allowed-ip.')),
      ['server.allowed-ip.10.9.8.0/24', 'server.allowed-ip.fd00:5e::/64'],
    );
    process.env.MAILWAY_ENGINE_TRUSTED_NETWORK = '';
    assert.ok(!Object.keys(recommendedEngineSettings(HOST)).some((k) => k.startsWith('server.allowed-ip.')));
  } finally {
    if (previous === undefined) delete process.env.MAILWAY_ENGINE_TRUSTED_NETWORK;
    else process.env.MAILWAY_ENGINE_TRUSTED_NETWORK = previous;
  }
});

test('el estado refleja lo aplicado y no mide TLS en demostración', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/engine/status', headers: { cookie: ctx.adminCookie } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    engine: { kind: string; error: string | null };
    hostname: { configured: string; expected: string; ok: boolean };
    recommendedApplied: boolean;
    tls: EngineTlsStatus;
    acme: { configured: boolean };
  };
  assert.equal(body.engine.kind, 'demo');
  assert.equal(body.engine.error, null);
  assert.deepEqual(body.hostname, { configured: HOST, expected: HOST, ok: true });
  assert.equal(body.recommendedApplied, true);
  assert.equal(body.tls.ok, false);
  assert.match(body.tls.error ?? '', /demostración/);
  assert.equal(body.acme.configured, false);
});

test('sin nombre del servidor, los ajustes recomendados se rechazan', async () => {
  setInstanceSettings({ mailHostname: '' });
  try {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/engine/recommended',
      headers: { cookie: ctx.adminCookie },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { code: string }).code, 'mail_hostname_missing');
  } finally {
    setInstanceSettings({ mailHostname: HOST });
  }
});

test('emitir el certificado con Cloudflare escribe las claves ACME en el motor', async () => {
  insertCloudflareAccount('cf-instancia', null);
  const calls = mockCloudflare('mailway.test');
  try {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/engine/acme',
      headers: { cookie: ctx.adminCookie },
      payload: { cloudflareAccountId: 'cf-instancia', email: 'postmaster@mailway.test' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(!res.body.includes(CF_TOKEN), 'el token de Cloudflare no vuelve al navegador');
    const body = res.json() as { acme: { zone: string; provider: string } };
    assert.equal(body.acme.zone, 'mailway.test');
    assert.equal(body.acme.provider, 'cloudflare');

    // Se buscó la zona del más largo al más corto, con el token de la cuenta.
    assert.ok(calls.length >= 2);
    assert.ok(calls.every((c) => c.authorization === `Bearer ${CF_TOKEN}`));
    assert.match(calls[0]!.url, /name=mail\.mailway\.test/);
  } finally {
    mock.restoreAll();
  }

  const stored = await getEngine().getServerSettings([
    'acme.mailway.directory',
    'acme.mailway.challenge',
    'acme.mailway.provider',
    'acme.mailway.secret',
    'acme.mailway.contact.0',
    'acme.mailway.domains.0',
    'acme.mailway.origin',
    'acme.mailway.default',
  ]);
  assert.deepEqual(stored, {
    'acme.mailway.directory': 'https://acme-v02.api.letsencrypt.org/directory',
    'acme.mailway.challenge': 'dns-01',
    'acme.mailway.provider': 'cloudflare',
    'acme.mailway.secret': CF_TOKEN,
    'acme.mailway.contact.0': 'postmaster@mailway.test',
    'acme.mailway.domains.0': HOST,
    'acme.mailway.origin': 'mailway.test',
    'acme.mailway.default': 'true',
  });

  const audit = db
    .prepare("SELECT detail FROM audit_log WHERE action = 'engine.acme_configured'")
    .all() as { detail: string }[];
  assert.equal(audit.length, 1);
  assert.ok(!audit[0]!.detail.includes(CF_TOKEN), 'la auditoría no guarda el token');

  const status = await ctx.app.inject({ method: 'GET', url: '/api/engine/status', headers: { cookie: ctx.adminCookie } });
  assert.ok(!status.body.includes(CF_TOKEN));
  const acme = (status.json() as { acme: { configured: boolean; provider: string; accountId: string } }).acme;
  assert.equal(acme.configured, true);
  assert.equal(acme.provider, 'cloudflare');
  assert.equal(acme.accountId, 'cf-instancia');
});

test('el certificado de la plataforma no usa cuentas de clientes ni zonas ajenas', async () => {
  insertCloudflareAccount('cf-de-cliente', clientId);
  const deCliente = await ctx.app.inject({
    method: 'POST',
    url: '/api/engine/acme',
    headers: { cookie: ctx.adminCookie },
    payload: { cloudflareAccountId: 'cf-de-cliente', email: 'postmaster@mailway.test' },
  });
  assert.equal(deCliente.statusCode, 400);
  assert.equal((deCliente.json() as { code: string }).code, 'cloudflare_account_not_instance');

  const inexistente = await ctx.app.inject({
    method: 'POST',
    url: '/api/engine/acme',
    headers: { cookie: ctx.adminCookie },
    payload: { cloudflareAccountId: 'no-existe', email: 'postmaster@mailway.test' },
  });
  assert.equal(inexistente.statusCode, 404);

  insertCloudflareAccount('cf-otra-zona', null);
  mockCloudflare('otra-empresa.test');
  try {
    const sinZona = await ctx.app.inject({
      method: 'POST',
      url: '/api/engine/acme',
      headers: { cookie: ctx.adminCookie },
      payload: { cloudflareAccountId: 'cf-otra-zona', email: 'postmaster@mailway.test' },
    });
    assert.equal(sinZona.statusCode, 400);
    assert.equal((sinZona.json() as { code: string }).code, 'cloudflare_zone_not_found');
    assert.ok(!sinZona.body.includes(CF_TOKEN));
  } finally {
    mock.restoreAll();
  }
});

test('recargar el certificado responde en demostración sin medir TLS', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/engine/reload-certificate',
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { ok: boolean; tls: EngineTlsStatus };
  assert.equal(body.ok, true);
  assert.match(body.tls.error ?? '', /demostración/);
});

test('checkEngineTls no lanza en demostración ni sin motor configurado', async () => {
  await checkEngineTls();
  config.demoMode = false;
  try {
    await checkEngineTls();
  } finally {
    config.demoMode = true;
  }
});

function tlsStatus(patch: Partial<EngineTlsStatus>): EngineTlsStatus {
  return {
    host: HOST,
    port: 993,
    ok: true,
    issuer: "Let's Encrypt",
    subject: HOST,
    validFrom: null,
    validTo: null,
    daysLeft: 60,
    selfSigned: false,
    hostnameMatches: true,
    authorizationError: null,
    via: 'publico',
    ...patch,
  };
}

function openTlsAlerts(): string[] {
  return listAlerts({})
    .filter((a) => a.type === 'engine_tls')
    .map((a) => a.severity);
}

test('los avisos del certificado siguen su estado', () => {
  db.prepare('DELETE FROM alerts').run();

  evaluateTlsAlerts(tlsStatus({ ok: false, selfSigned: true, issuer: HOST, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), HOST);
  assert.deepEqual(openTlsAlerts(), ['critical'], 'autofirmado: crítico');

  evaluateTlsAlerts(tlsStatus({ daysLeft: 15 }), HOST);
  assert.deepEqual(openTlsAlerts(), ['warning'], 'a 15 días: aviso, y el crítico se cierra');

  // Un fallo de conexión no cambia nada: de eso ya avisa el vigilante del motor.
  evaluateTlsAlerts(tlsStatus({ ok: false, daysLeft: null, error: 'ECONNREFUSED' }), HOST);
  assert.deepEqual(openTlsAlerts(), ['warning']);

  evaluateTlsAlerts(tlsStatus({ daysLeft: 3 }), HOST);
  assert.deepEqual(openTlsAlerts(), ['critical'], 'a 3 días: crítico');

  evaluateTlsAlerts(tlsStatus({ daysLeft: 80 }), HOST);
  assert.deepEqual(openTlsAlerts(), [], 'renovado: todo cerrado');
});
