import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { MANAGEMENT_TOKEN_RE } from '../src/modules/auth';
import {
  getEngineSettings,
  getInstanceSettings,
  getJsonSetting,
  isSetupComplete,
  setInstanceSettings,
} from '../src/modules/settings';
import { activeAdminTokensNamed } from '../src/modules/tokens';
import { emparejar, leerArgumentos, NOMBRE_TOKEN_SKYWAY } from '../src/tools/emparejar';
import { cookieFrom, createClient, getTestApp } from './helpers';
import { fakeStalwart } from './stalwart-falso';

/*
 * Herramienta de emparejado con Skyway (contrato del instalador): crea el
 * administrador la primera vez, completa la puesta en marcha con el entorno,
 * renueva el token «Skyway» y nunca deja secretos en la auditoría. Corre en su
 * propio proceso (base de datos propia) y sin modo demostración, con un
 * Stalwart simulado, como el panel que despliega el instalador.
 */

const ENGINE_SECRET = 'contraseña-del-motor-del-emparejado';
const SETUP_TOKEN = 'token-de-puesta-en-marcha-emparejado-0123';
const ADMIN = 'admin@emparejado.test';

const motor = fakeStalwart(ENGINE_SECRET);
let motorUrl = '';
/** Todo lo secreto que ha salido de la herramienta: no puede acabar en la auditoría. */
const secretos: string[] = [ENGINE_SECRET];
let adminPassword = '';
let primerToken = '';
let tokenVigente = '';

before(async () => {
  motorUrl = await motor.listen();
  config.demoMode = false;
  // El emparejado no necesita el token de puesta en marcha aunque exista.
  config.setupToken = SETUP_TOKEN;
  // Primero, un motor que no responde (puerto 9, conexión rechazada al instante).
  config.engineDefaults = {
    url: 'http://127.0.0.1:9',
    adminUser: 'admin',
    adminPassword: ENGINE_SECRET,
    smtpHost: '',
    smtpPort: 587,
  };
  config.mailHostnameDefault = 'mail.emparejado.test';
  config.publicIpDefault = '203.0.113.20';
  config.webmailUrlDefault = 'https://webmail.emparejado.test';
  config.panelUrlDefault = 'https://panel.emparejado.test';
});

after(() => motor.close());

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function usuarios(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
}

test('lee --email y --nombre, también con «=», y rechaza lo demás', () => {
  assert.deepEqual(leerArgumentos(['--email', 'a@b.test', '--nombre', 'Ana Pérez']), {
    email: 'a@b.test',
    nombre: 'Ana Pérez',
  });
  assert.deepEqual(leerArgumentos(['--email=a@b.test']), { email: 'a@b.test', nombre: undefined });
  assert.throws(() => leerArgumentos([]), /Indica el correo del administrador/);
  assert.throws(() => leerArgumentos(['--email']), /Falta el valor de --email/);
  assert.throws(() => leerArgumentos(['--email', '--nombre', 'Ana']), /Falta el valor de --email/);
  assert.throws(() => leerArgumentos(['--email', 'a@b.test', '--token', 'x']), /Opción --token: solo se admiten/);
  assert.throws(() => leerArgumentos(['--email', 'a@b.test', '--email', 'c@d.test']), /está repetida/);
  // Un valor suelto (p. ej. un secreto pegado por error) no se repite en el mensaje.
  const suelto = 'mwt_0123abcd_valor-que-no-debe-salir';
  assert.throws(
    () => leerArgumentos(['--email', 'a@b.test', suelto]),
    (err: Error) => !err.message.includes(suelto) && /Opción no reconocida/.test(err.message),
  );
});

test('un correo no válido no crea nada', async () => {
  await assert.rejects(emparejar({ email: 'no-es-un-correo' }), /correo del administrador no es válido/);
  assert.equal(usuarios(), 0);
});

test('si falla el último paso no queda una cuenta sin contraseña conocida ni un token', async () => {
  // El token no se puede guardar: el administrador, que se crea en la misma
  // transacción, tampoco debe quedar (su contraseña no llegaría a mostrarse).
  db.exec(`CREATE TRIGGER fallo_simulado BEFORE INSERT ON management_tokens
           BEGIN SELECT RAISE(ABORT, 'fallo simulado'); END`);
  try {
    await assert.rejects(emparejar({ email: ADMIN }), /fallo simulado/);
  } finally {
    db.exec('DROP TRIGGER fallo_simulado');
  }
  assert.equal(usuarios(), 0, 'sin administrador a medias');
  assert.equal(activeAdminTokensNamed(NOMBRE_TOKEN_SKYWAY).length, 0);
  const anotado = db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'setup.admin_created'`).get() as { c: number };
  assert.equal(anotado.c, 0, 'la actividad no anota una cuenta que no existe');
});

test('la primera vez crea el administrador y el token aunque el motor aún no responda', async () => {
  const app = await getTestApp();
  const r = await emparejar({ email: '  Admin@Emparejado.TEST ' });
  assert.equal(r.adminEmail, ADMIN);
  assert.ok(r.adminPassword && r.adminPassword.length >= 20, 'contraseña aleatoria larga');
  assert.match(r.token, MANAGEMENT_TOKEN_RE);
  adminPassword = r.adminPassword!;
  primerToken = r.token;
  tokenVigente = r.token;
  secretos.push(r.adminPassword!, r.token);

  // El motor no responde: queda como aviso, sin la contraseña, y la puesta en
  // marcha sigue abierta para que el asistente lo retome al entrar.
  assert.ok(r.avisos.some((a) => a.includes('continúa en el paso del motor')), r.avisos.join('\n'));
  assert.ok(!r.avisos.join('\n').includes(ENGINE_SECRET));
  assert.equal(getEngineSettings(), null);
  assert.equal(isSetupComplete(), false);

  // La identidad del entorno queda guardada (validada y normalizada).
  const guardada = getJsonSetting<Record<string, string>>('instance')!;
  assert.equal(guardada.mailHostname, 'mail.emparejado.test');
  assert.equal(guardada.publicIp, '203.0.113.20');
  assert.equal(guardada.webmailUrl, 'https://webmail.emparejado.test');
  assert.equal(guardada.panelUrl, 'https://panel.emparejado.test');

  // El administrador entra con esa contraseña; el token es suyo y de administración.
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ADMIN, password: adminPassword } });
  assert.equal(login.statusCode, 200, login.body);
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(r.token) });
  const body = me.json() as { user: { email: string; role: string }; via: { name: string } };
  assert.equal(body.user.email, ADMIN);
  assert.equal(body.user.role, 'admin');
  assert.equal(body.via.name, NOMBRE_TOKEN_SKYWAY);

  // El asistente ya no ofrece crear otro administrador.
  const estado = await app.inject({ method: 'GET', url: '/api/setup/status' });
  assert.equal((estado.json() as { hasAdmin: boolean }).hasAdmin, true);
});

test('la segunda vez no devuelve contraseña, conecta el motor y renueva el token', async () => {
  const app = await getTestApp();
  config.engineDefaults.url = motorUrl;
  const r = await emparejar({ email: ADMIN });
  secretos.push(r.token);
  assert.equal(r.adminEmail, ADMIN);
  assert.equal(r.adminPassword, undefined);
  assert.equal(usuarios(), 1);
  assert.notEqual(r.token, primerToken);

  // Motor conectado con el entorno, ajustes recomendados y puesta en marcha completa.
  assert.equal(getEngineSettings()?.url, motorUrl);
  assert.equal(motor.settings.get('server.hostname'), 'mail.emparejado.test');
  assert.equal(motor.settings.get('http.use-x-forwarded'), 'true');
  assert.equal(isSetupComplete(), true);
  assert.deepEqual(r.avisos, []);

  // El token anterior queda revocado y solo hay uno «Skyway» activo.
  const viejo = await app.inject({ method: 'GET', url: '/api/tokens', headers: bearer(primerToken) });
  assert.equal(viejo.statusCode, 401);
  assert.equal((viejo.json() as { code: string }).code, 'token_revoked');
  const nuevo = await app.inject({ method: 'GET', url: '/api/tokens', headers: bearer(r.token) });
  assert.equal(nuevo.statusCode, 200, nuevo.body);
  assert.equal(activeAdminTokensNamed(NOMBRE_TOKEN_SKYWAY).length, 1);
  tokenVigente = r.token;
});

test('con otro correo usa el administrador que ya existe y no crea otro', async () => {
  const r = await emparejar({ email: 'otra-persona@emparejado.test', nombre: 'Otra Persona' });
  secretos.push(r.token);
  tokenVigente = r.token;
  assert.equal(r.adminEmail, ADMIN);
  assert.equal(r.adminPassword, undefined);
  assert.equal(usuarios(), 1);
});

test('no pisa la identidad ni el motor que la administración ya ha cambiado', async () => {
  setInstanceSettings({ mailHostname: 'correo.propio.test', panelUrl: 'https://otro-panel.test' });
  config.engineDefaults.url = 'http://127.0.0.1:9';
  try {
    const r = await emparejar({ email: ADMIN });
    secretos.push(r.token);
    tokenVigente = r.token;
    const instancia = getInstanceSettings();
    assert.equal(instancia.mailHostname, 'correo.propio.test');
    assert.equal(instancia.panelUrl, 'https://otro-panel.test');
    assert.equal(getEngineSettings()?.url, motorUrl, 'el motor conectado no se cambia por el del entorno');
    // Los ajustes recomendados se vuelven a aplicar con el nombre guardado.
    assert.equal(motor.settings.get('server.hostname'), 'correo.propio.test');
  } finally {
    config.engineDefaults.url = motorUrl;
  }
});

test('revoca el «Skyway» de cualquier administrador, pero nunca el de un cliente', async () => {
  const app = await getTestApp();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ADMIN, password: adminPassword } });
  const adminCookie = cookieFrom(login);
  const cliente = await createClient({ app, adminCookie }, { withUser: true });

  const delCliente = await app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: { cookie: cliente.userCookie! },
    payload: { name: NOMBRE_TOKEN_SKYWAY },
  });
  assert.equal(delCliente.statusCode, 200, delCliente.body);
  const tokenCliente = (delCliente.json() as { token: string }).token;
  // Otro «Skyway» creado a mano por la administración: debe quedar solo uno vivo.
  const aMano = await app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: { cookie: adminCookie },
    payload: { name: NOMBRE_TOKEN_SKYWAY },
  });
  const tokenAMano = (aMano.json() as { token: string }).token;
  secretos.push(tokenCliente, tokenAMano);

  const r = await emparejar({ email: ADMIN });
  secretos.push(r.token);
  for (const revocado of [tokenVigente, tokenAMano]) {
    const res = await app.inject({ method: 'GET', url: '/api/tokens', headers: bearer(revocado) });
    assert.equal(res.statusCode, 401);
  }
  const propio = await app.inject({ method: 'GET', url: '/api/tokens', headers: bearer(tokenCliente) });
  assert.equal(propio.statusCode, 200, 'el token del cliente sigue activo');
  const vivos = activeAdminTokensNamed(NOMBRE_TOKEN_SKYWAY);
  assert.equal(vivos.length, 1);
  assert.equal(vivos[0]!.ownerEmail, ADMIN);
});

test('la auditoría lo anota como el sistema y sin ningún secreto', async () => {
  const filas = db.prepare('SELECT user_id, ip, action, detail FROM audit_log').all() as {
    user_id: string | null;
    ip: string;
    action: string;
    detail: string;
  }[];
  for (const fila of filas) {
    for (const secreto of secretos) {
      assert.ok(!fila.detail.includes(secreto), `${fila.action} no puede guardar un secreto`);
    }
  }
  const delEmparejado = filas.filter((f) => (JSON.parse(f.detail) as { origen?: string }).origen === 'emparejado con Skyway');
  const acciones = new Set(delEmparejado.map((f) => f.action));
  for (const accion of [
    'setup.admin_created',
    'setup.instance_configured',
    'setup.engine_configured',
    'setup.completed',
    'engine.recommended_applied',
    'token.created',
    'token.revoked',
  ]) {
    assert.ok(acciones.has(accion), `falta ${accion}`);
  }
  for (const fila of delEmparejado) {
    assert.equal(fila.user_id, null, 'sin usuario: lo hizo el sistema');
    assert.equal(fila.ip, '');
  }
  // El administrador lo ve en la Actividad sin autor de panel («Sistema»).
  const app = await getTestApp();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ADMIN, password: adminPassword } });
  const res = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: cookieFrom(login) } });
  const creado = (res.json() as { entries: { action: string; actor: unknown }[] }).entries.find(
    (e) => e.action === 'setup.admin_created',
  );
  assert.equal(creado?.actor, null);
});

/* ------------------------- La herramienta de terminal ------------------------ */

const SERVIDOR = path.resolve(__dirname, '..');

function ejecutar(datos: string, args: string[], entorno: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/tools/emparejar.ts', ...args], {
    cwd: SERVIDOR,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      MAILWAY_DATA_DIR: datos,
      MAILWAY_DEMO: '1',
      MAILWAY_DNS_OFFLINE: '1',
      MAILWAY_WATCHDOG_DISABLED: '1',
      MAILWAY_SECRET: 'clave-maestra-de-la-prueba-0123456789',
      MAILWAY_PANEL_URL: '',
      PUBLIC_URL: '',
      MAILWAY_MAIL_HOSTNAME: '',
      ...entorno,
    },
  });
}

test('una URL del panel con parámetros en el entorno se descarta con un aviso y el emparejado termina', () => {
  // setInstanceSettings rechaza parámetros, credenciales y fragmentos en la
  // URL del panel: antes, la herramienta terminaba con código 1 justo después
  // de crear el administrador y su contraseña no se mostraba nunca.
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), 'mailway-emparejar-url-'));
  try {
    const r = ejecutar(datos, ['--email', 'url@emparejado.test'], {
      MAILWAY_PANEL_URL: 'https://panel.ejemplo.test/?x=secreto-de-la-url',
      MAILWAY_MAIL_HOSTNAME: 'mail.ejemplo.test',
    });
    assert.equal(r.status, 0, r.stderr);
    const salida = JSON.parse(r.stdout) as Record<string, string>;
    assert.deepEqual(Object.keys(salida), ['adminEmail', 'adminPassword', 'token']);
    assert.match(r.stderr, /MAILWAY_PANEL_URL del entorno del panel no es válido/);
    assert.ok(!r.stderr.includes('secreto-de-la-url'), 'el aviso no repite el valor');

    // El resto de la identidad sí se guarda.
    const base = new Database(path.join(datos, 'mailway.db'), { readonly: true });
    try {
      const fila = base.prepare(`SELECT value FROM settings WHERE key = 'instance'`).get() as { value: string };
      const instancia = JSON.parse(fila.value) as Record<string, string>;
      assert.equal(instancia.mailHostname, 'mail.ejemplo.test');
      assert.ok(!instancia.panelUrl, 'la URL del panel no válida no se guarda');
    } finally {
      base.close();
    }
  } finally {
    fs.rmSync(datos, { recursive: true, force: true });
  }
});

test('la herramienta imprime una sola línea JSON y falla con código 1 y el motivo', () => {
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), 'mailway-emparejar-'));
  try {
    const primera = ejecutar(datos, ['--email', 'cli@emparejado.test', '--nombre', 'Administración']);
    assert.equal(primera.status, 0, primera.stderr);
    const lineas = primera.stdout.split('\n').filter(Boolean);
    assert.equal(lineas.length, 1, `una sola línea: ${primera.stdout}`);
    const salida = JSON.parse(lineas[0]!) as Record<string, string>;
    assert.deepEqual(Object.keys(salida), ['adminEmail', 'adminPassword', 'token']);
    assert.equal(salida.adminEmail, 'cli@emparejado.test');
    assert.match(salida.token!, MANAGEMENT_TOKEN_RE);
    assert.ok(!primera.stderr.includes(salida.adminPassword!) && !primera.stderr.includes(salida.token!));

    const segunda = ejecutar(datos, ['--email=cli@emparejado.test']);
    assert.equal(segunda.status, 0, segunda.stderr);
    const repetida = JSON.parse(segunda.stdout) as Record<string, string>;
    assert.deepEqual(Object.keys(repetida), ['adminEmail', 'token'], 'sin contraseña la segunda vez');
    assert.notEqual(repetida.token, salida.token);

    const sinCorreo = ejecutar(datos, []);
    assert.equal(sinCorreo.status, 1);
    assert.equal(sinCorreo.stdout, '');
    assert.match(sinCorreo.stderr, /Indica el correo del administrador/);
  } finally {
    fs.rmSync(datos, { recursive: true, force: true });
  }
});
