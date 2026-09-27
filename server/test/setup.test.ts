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

test('el token de puesta en marcha no se puede probar sin límite', async () => {
  const app = await getTestApp();
  const creds = { email: 'intruso@mailway.test', name: 'Intruso', password: 'clave-intruso-segura' };
  for (let i = 0; i < 10; i += 1) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/admin',
      payload: { ...creds, setupToken: `intento-${i}` },
      remoteAddress: '192.0.2.50',
    });
    assert.equal(res.statusCode, 403, res.body);
  }
  const bloqueado = await app.inject({
    method: 'POST',
    url: '/api/setup/admin',
    payload: { ...creds, setupToken: SETUP_TOKEN },
    remoteAddress: '192.0.2.50',
  });
  assert.equal(bloqueado.statusCode, 429, 'ni con el token correcto desde esa IP');
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c, 0);
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

/* ---------------------- Motor: pruebas y cambios (S7) ---------------------- */

/** Servidor ajeno que anota lo que le llega: no debe recibir nunca la contraseña. */
function servidorAjeno() {
  const recibidas: { authorization: string | undefined }[] = [];
  const server = http.createServer((req, res) => {
    recibidas.push({ authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: { items: [], total: 0 } }));
  });
  return { server, recibidas };
}

test('probar o cambiar el motor con otra URL exige la contraseña y una sesión del panel', async () => {
  const app = await getTestApp();
  const ajeno = servidorAjeno();
  await new Promise<void>((resolve) => ajeno.server.listen(0, '127.0.0.1', resolve));
  const urlAjena = `http://127.0.0.1:${(ajeno.server.address() as AddressInfo).port}`;
  try {
    const actual = getEngineSettings()!;
    const cuerpo = {
      kind: 'stalwart',
      url: urlAjena,
      adminUser: actual.adminUser,
      adminPassword: '',
      smtpHost: actual.smtpHost,
      smtpPort: actual.smtpPort,
      smtpSecure: actual.smtpSecure,
    };

    const prueba = await app.inject({
      method: 'POST',
      url: '/api/settings/engine/test',
      headers: { cookie: adminCookie },
      payload: cuerpo,
    });
    assert.equal(prueba.statusCode, 400, prueba.body);
    assert.equal((prueba.json() as { code: string }).code, 'engine_password_required');
    const cambio = await app.inject({
      method: 'PUT',
      url: '/api/settings/engine',
      headers: { cookie: adminCookie },
      payload: cuerpo,
    });
    assert.equal(cambio.statusCode, 400, cambio.body);
    assert.equal(ajeno.recibidas.length, 0, 'la contraseña guardada no sale hacia otra URL');
    assert.equal(getEngineSettings()?.url, motorUrl, 'el motor configurado no cambia');

    // Tampoco se puede redirigir el SMTP (recibe las credenciales de las claves de API).
    const smtp = await app.inject({
      method: 'PUT',
      url: '/api/settings/engine',
      headers: { cookie: adminCookie },
      payload: { ...cuerpo, url: motorUrl, smtpHost: 'smtp.ajeno.test' },
    });
    assert.equal(smtp.statusCode, 400, smtp.body);
    assert.equal((smtp.json() as { code: string }).code, 'engine_password_required');

    // Mismo destino: se prueba con la contraseña guardada, sin volver a escribirla.
    const mismo = await app.inject({
      method: 'POST',
      url: '/api/settings/engine/test',
      headers: { cookie: adminCookie },
      payload: { ...cuerpo, url: `${motorUrl}/` },
    });
    assert.equal(mismo.statusCode, 200, mismo.body);
    assert.equal((mismo.json() as { ok: boolean }).ok, true);

    // Con un token de gestión (aunque sea de administrador), ni probar ni cambiar.
    const token = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie: adminCookie },
      payload: { name: 'Integración' },
    });
    assert.equal(token.statusCode, 200, token.body);
    const bearer = { authorization: `Bearer ${(token.json() as { token: string }).token}` };
    for (const [method, url] of [
      ['POST', '/api/settings/engine/test'],
      ['PUT', '/api/settings/engine'],
      ['POST', '/api/setup/engine'],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: bearer,
        payload: { ...cuerpo, adminPassword: 'la-que-sea-0123' },
      });
      assert.equal(res.statusCode, 403, `${method} ${url}: ${res.body}`);
      assert.equal((res.json() as { code: string }).code, 'session_required');
    }
    assert.equal(ajeno.recibidas.length, 0);
  } finally {
    ajeno.server.closeAllConnections();
    ajeno.server.close();
  }
});

test('la identidad solo admite un nombre de servidor válido y URL http(s)', async () => {
  const app = await getTestApp();
  for (const payload of [
    { mailHostname: 'mail servidor.test' },
    { mailHostname: 'mail.test"; rm -rf' },
    { webmailUrl: 'javascript:alert(1)' },
    { panelUrl: 'ftp://panel.mailway.test' },
  ]) {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/instance',
      headers: { cookie: adminCookie },
      payload,
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

test('con la puesta en marcha completa, el estado público solo trae la marca', async () => {
  const app = await getTestApp();
  const fin = await app.inject({ method: 'POST', url: '/api/setup/complete', headers: { cookie: adminCookie } });
  assert.equal(fin.statusCode, 200, fin.body);

  const anonimo = await app.inject({ method: 'GET', url: '/api/setup/status' });
  assert.equal(anonimo.statusCode, 200);
  const publico = anonimo.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(publico).sort(), ['hasAdmin', 'instance', 'requiresSetupToken', 'setupComplete']);
  assert.deepEqual(publico.instance, { brandName: 'Correo Ejemplo' });
  assert.ok(!anonimo.body.includes('203.0.113.10'), 'sin la IP pública');
  assert.ok(!anonimo.body.includes(motorUrl), 'sin la URL interna del motor');

  const admin = await app.inject({ method: 'GET', url: '/api/setup/status', headers: { cookie: adminCookie } });
  const completo = admin.json() as { instance: { publicIp: string }; engineDefaults: unknown };
  assert.equal(completo.instance.publicIp, '203.0.113.10');
  assert.ok(completo.engineDefaults);
});
