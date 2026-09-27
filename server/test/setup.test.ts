import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { getEngineSettings, setInstanceSettings } from '../src/modules/settings';
import { cookieFrom, getTestApp } from './helpers';

/*
 * Puesta en marcha tal y como la hace el instalador: token de puesta en
 * marcha y motor definido en el entorno. Este fichero corre en su propio
 * proceso (base de datos propia), así que puede desactivar el modo
 * demostración para ejercitar el camino real con un Stalwart simulado.
 */

const SETUP_TOKEN = 'token-de-puesta-en-marcha-0123456789abcdef';
const ENGINE_SECRET = 'contraseña-del-motor-que-nunca-sale';

interface Received {
  method: string;
  path: string;
  body: string;
  authorization: string | undefined;
}

/** Stalwart mínimo: lo que usan ping, ajustes y recarga. */
function fakeStalwart(password: string) {
  const received: Received[] = [];
  const settings = new Map<string, string>();
  const expectedAuth = `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://motor');
      received.push({ method: req.method || '', path: url.pathname, body: raw, authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401);
        res.end(JSON.stringify({ status: 401, title: 'Unauthorized', detail: 'You have to authenticate first.' }));
        return;
      }
      if (url.pathname === '/api/principal') {
        res.end(JSON.stringify({ data: { items: [], total: 0 } }));
      } else if (url.pathname === '/api/settings' && req.method === 'POST') {
        for (const op of JSON.parse(raw) as { type: string; prefix: string | null; values: [string, string][] }[]) {
          if (op.type !== 'insert') continue;
          for (const [key, value] of op.values) settings.set(op.prefix ? `${op.prefix}.${key}` : key, value);
        }
        res.end(JSON.stringify({ data: null }));
      } else if (url.pathname === '/api/reload') {
        res.end(JSON.stringify({ data: { errors: {}, warnings: {} } }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ status: 404, title: 'Not Found' }));
      }
    });
  });
  return { server, received, settings };
}

const motor = fakeStalwart(ENGINE_SECRET);
let motorUrl = '';

before(async () => {
  await new Promise<void>((resolve) => motor.server.listen(0, '127.0.0.1', resolve));
  motorUrl = `http://127.0.0.1:${(motor.server.address() as AddressInfo).port}`;
  // Instalación real: sin modo demostración, con token y motor en el entorno.
  config.demoMode = false;
  config.setupToken = SETUP_TOKEN;
  config.engineDefaults = {
    url: motorUrl,
    adminUser: 'admin',
    adminPassword: ENGINE_SECRET,
    smtpHost: '',
    smtpPort: 587,
  };
});

after(() => {
  motor.server.closeAllConnections();
  motor.server.close();
});

let adminCookie = '';

test('el estado anuncia el token y el motor del entorno, sin la contraseña', async () => {
  const app = await getTestApp();
  const res = await app.inject({ method: 'GET', url: '/api/setup/status' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    requiresSetupToken: boolean;
    engineFromEnv: boolean;
    engineConfigured: boolean;
    engineDefaults: { hasPassword: boolean; url: string };
  };
  assert.equal(body.requiresSetupToken, true);
  assert.equal(body.engineFromEnv, true);
  assert.equal(body.engineConfigured, false);
  assert.equal(body.engineDefaults.hasPassword, true);
  assert.equal(body.engineDefaults.url, motorUrl);
  assert.ok(!res.body.includes(ENGINE_SECRET), 'la contraseña del motor no viaja al navegador');
  assert.ok(!res.body.includes(SETUP_TOKEN), 'el token de puesta en marcha tampoco');
});

test('crear el administrador exige el token de puesta en marcha', async () => {
  const app = await getTestApp();
  const creds = { email: 'admin@mailway.test', name: 'Administración', password: 'clave-admin-segura' };

  const sinToken = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: creds });
  assert.equal(sinToken.statusCode, 403);
  assert.equal((sinToken.json() as { code: string }).code, 'setup_token_invalid');

  const erroneo = await app.inject({
    method: 'POST',
    url: '/api/setup/admin',
    payload: { ...creds, setupToken: 'token-equivocado' },
  });
  assert.equal(erroneo.statusCode, 403);
  const count = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  assert.equal(count, 0, 'un token equivocado no crea nada');

  const correcto = await app.inject({
    method: 'POST',
    url: '/api/setup/admin',
    payload: { ...creds, setupToken: SETUP_TOKEN },
  });
  assert.equal(correcto.statusCode, 200, correcto.body);
  adminCookie = cookieFrom(correcto);
  assert.ok(adminCookie);

  const segundo = await app.inject({
    method: 'POST',
    url: '/api/setup/admin',
    payload: { ...creds, email: 'otro@mailway.test', setupToken: SETUP_TOKEN },
  });
  assert.equal(segundo.statusCode, 403);
  assert.equal((segundo.json() as { code: string }).code, 'admin_exists');
});

test('los pasos siguientes exigen la sesión del administrador', async () => {
  const app = await getTestApp();
  for (const url of ['/api/setup/engine', '/api/setup/instance', '/api/setup/complete']) {
    const res = await app.inject({ method: 'POST', url, payload: { useEnvDefaults: true } });
    assert.equal(res.statusCode, 401, url);
  }
  const dns = await app.inject({ method: 'GET', url: '/api/setup/platform-dns' });
  assert.equal(dns.statusCode, 401);
});

test('un motor del entorno inaccesible falla sin exponer la contraseña', async () => {
  const app = await getTestApp();
  const original = config.engineDefaults.url;
  // Puerto 9 (discard) en local: conexión rechazada al instante.
  config.engineDefaults.url = 'http://127.0.0.1:9';
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/engine',
      headers: { cookie: adminCookie },
      payload: { useEnvDefaults: true },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { code: string }).code, 'engine_test_failed');
    assert.ok(!res.body.includes(ENGINE_SECRET));
  } finally {
    config.engineDefaults.url = original;
  }
});

test('sin motor en el entorno, el atajo se rechaza con un mensaje claro', async () => {
  const app = await getTestApp();
  const original = config.engineDefaults.adminPassword;
  config.engineDefaults.adminPassword = '';
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/engine',
      headers: { cookie: adminCookie },
      payload: { useEnvDefaults: true },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { code: string }).code, 'engine_env_missing');
  } finally {
    config.engineDefaults.adminPassword = original;
  }
});

test('conectar el motor del entorno aplica los ajustes recomendados y guarda la contraseña cifrada', async () => {
  const app = await getTestApp();
  setInstanceSettings({ mailHostname: 'mail.mailway.test' });
  motor.received.length = 0;

  const res = await app.inject({
    method: 'POST',
    url: '/api/setup/engine',
    headers: { cookie: adminCookie },
    payload: { useEnvDefaults: true },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(!res.body.includes(ENGINE_SECRET));
  const body = res.json() as { fromEnv: boolean; recommended: { applied: boolean; hostname: string } };
  assert.equal(body.fromEnv, true);
  assert.equal(body.recommended.applied, true);
  assert.equal(body.recommended.hostname, 'mail.mailway.test');

  // El motor recibió el nombre, la confianza en el proxy y el rango exento.
  assert.equal(motor.settings.get('server.hostname'), 'mail.mailway.test');
  assert.equal(motor.settings.get('http.use-x-forwarded'), 'true');
  assert.equal(motor.settings.get('server.allowed-ip.10.203.53.0/24'), '');
  assert.ok(motor.received.some((r) => r.path === '/api/reload'), 'y se le pidió recargar');

  // Guardada y recuperable en el servidor, pero cifrada en la base de datos.
  assert.equal(getEngineSettings()?.adminPassword, ENGINE_SECRET);
  const raw = (db.prepare("SELECT value FROM settings WHERE key = 'engine'").get() as { value: string }).value;
  assert.ok(!raw.includes(ENGINE_SECRET), 'la contraseña no se guarda en claro');

  const settings = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: adminCookie } });
  assert.equal(settings.statusCode, 200);
  assert.ok(!settings.body.includes(ENGINE_SECRET));
  assert.equal((settings.json() as { engine: { hasPassword: boolean } }).engine.hasPassword, true);
});

test('guardar la identidad del servidor fija el nombre nuevo en el motor', async () => {
  const app = await getTestApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/setup/instance',
    headers: { cookie: adminCookie },
    payload: {
      brandName: 'Correo Ejemplo',
      mailHostname: 'correo.mailway.test',
      publicIp: '203.0.113.10',
      webmailUrl: 'https://webmail.mailway.test',
      panelUrl: 'https://panel.mailway.test',
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { recommended: { applied: boolean; hostname: string } };
  assert.equal(body.recommended.applied, true);
  assert.equal(motor.settings.get('server.hostname'), 'correo.mailway.test');
});

test('el DNS de la plataforma se mide sin red como «sin dato»', async () => {
  const app = await getTestApp();
  const res = await app.inject({ method: 'GET', url: '/api/setup/platform-dns', headers: { cookie: adminCookie } });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    publicIp: string;
    records: { role: string; host: string; status: string }[];
    ptr: { status: string } | null;
  };
  assert.equal(body.publicIp, '203.0.113.10');
  assert.deepEqual(
    body.records.map((r) => [r.role, r.host, r.status]),
    [
      ['mail', 'correo.mailway.test', 'unknown'],
      ['panel', 'panel.mailway.test', 'unknown'],
      ['webmail', 'webmail.mailway.test', 'unknown'],
    ],
  );
  assert.equal(body.ptr?.status, 'unknown');
});
