import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { listAlerts } from '../src/modules/alerts';
import { evaluateHostnameAlert } from '../src/modules/engineops';
import { ALERTA_ENTORNO, adoptarEntornoAlArrancar, sincronizarIdentidadConEntorno } from '../src/modules/entorno';
import { getInstanceSettings, setInstanceSettings } from '../src/modules/settings';
import { emparejar } from '../src/tools/emparejar';
import { adoptarIdentidad, leerArgumentos } from '../src/tools/identidad';
import { cookieFrom, getTestApp } from './helpers';
import { fakeStalwart } from './stalwart-falso';

/*
 * Identidad del servidor que fija el instalador en el entorno del panel. Al
 * repetir el instalador con otro dominio (CD-02, MW-OP-03), el panel adopta
 * los nombres nuevos en lo que nadie ha tocado en Ajustes y el emparejado ya
 * no devuelve el motor al nombre anterior; lo cambiado a mano se conserva
 * con un aviso que nombra los dos valores, salvo que quien instala confirme
 * el cambio (la herramienta identidad.js).
 */

const SECRETO = 'contraseña-del-motor-identidad';
const ADMIN = 'admin@viejo.test';
const motor = fakeStalwart(SECRETO);
let adminPassword = '';

function entorno(dominio: string, ip = '203.0.113.20'): void {
  config.mailHostnameDefault = `mail.${dominio}`;
  config.publicIpDefault = ip;
  config.webmailUrlDefault = `https://webmail.${dominio}`;
  config.panelUrlDefault = `https://panel.${dominio}`;
}

function avisosDeEntorno() {
  return listAlerts({}).filter((a) => a.type === ALERTA_ENTORNO);
}

before(async () => {
  const url = await motor.listen();
  config.demoMode = false;
  config.setupToken = '';
  config.engineDefaults = { url, adminUser: 'admin', adminPassword: SECRETO, smtpHost: '', smtpPort: 587 };
  entorno('viejo.test');
});

after(() => motor.close());

test('al cambiar de dominio con el instalador, el emparejado adopta los nombres nuevos y el motor no vuelve al viejo', async () => {
  const primero = await emparejar({ email: ADMIN });
  adminPassword = primero.adminPassword!;
  assert.equal(motor.settings.get('server.hostname'), 'mail.viejo.test');

  // El instalador vuelve a ejecutarse con otro dominio base: cambia el
  // entorno del panel y configurar_motor fija el nombre nuevo en el motor.
  entorno('nuevo.test');
  motor.settings.set('server.hostname', 'mail.nuevo.test');
  const r = await emparejar({ email: ADMIN });

  const instancia = getInstanceSettings();
  assert.equal(instancia.mailHostname, 'mail.nuevo.test');
  assert.equal(instancia.webmailUrl, 'https://webmail.nuevo.test');
  assert.equal(instancia.panelUrl, 'https://panel.nuevo.test');
  assert.equal(instancia.publicIp, '203.0.113.20', 'lo que no cambia se queda igual');
  assert.equal(motor.settings.get('server.hostname'), 'mail.nuevo.test', 'el emparejado no devuelve el motor al nombre viejo');
  assert.deepEqual(r.avisos, []);
  assert.deepEqual(avisosDeEntorno(), []);

  // La Actividad lo anota como el sistema, con los dos valores.
  const fila = db
    .prepare(`SELECT detail FROM audit_log WHERE action = 'settings.instance_env_adopted' ORDER BY id DESC LIMIT 1`)
    .get() as { detail: string } | undefined;
  assert.ok(fila, 'queda en la Actividad');
  const detalle = JSON.parse(fila.detail) as { cambios: { campo: string; antes: string; despues: string }[] };
  assert.deepEqual(
    detalle.cambios.find((c) => c.campo === 'mailHostname'),
    { campo: 'mailHostname', antes: 'mail.viejo.test', despues: 'mail.nuevo.test' },
  );
});

test('lo cambiado a mano en Ajustes se conserva y se avisa con los dos valores', async () => {
  const app = await getTestApp();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ADMIN, password: adminPassword } });
  const cookie = cookieFrom(login);
  const guardar = (payload: Record<string, string>) =>
    app.inject({ method: 'PUT', url: '/api/settings/instance', headers: { cookie }, payload });

  const res = await guardar({ mailHostname: 'correo.propio.test' });
  assert.equal(res.statusCode, 200, res.body);
  // Al guardar ya se avisa: el instalador sigue usando el nombre anterior.
  assert.equal(avisosDeEntorno().length, 1);
  assert.match(avisosDeEntorno()[0]!.message, /correo\.propio\.test.*mail\.nuevo\.test/);

  // Otra ejecución del instalador con otro dominio: no pisa lo cambiado a mano.
  entorno('otro.test');
  const r = await emparejar({ email: ADMIN });
  assert.equal(getInstanceSettings().mailHostname, 'correo.propio.test');
  assert.equal(getInstanceSettings().webmailUrl, 'https://webmail.otro.test', 'lo que nadie tocó sí cambia');
  assert.equal(motor.settings.get('server.hostname'), 'correo.propio.test');
  const aviso = r.avisos.find((a) => a.includes('MAILWAY_MAIL_HOSTNAME'));
  assert.ok(aviso, r.avisos.join('\n'));
  assert.match(aviso, /correo\.propio\.test/);
  assert.match(aviso, /mail\.otro\.test/);
  const abiertos = avisosDeEntorno();
  assert.equal(abiertos.length, 1, 'el aviso de la pareja anterior se cierra');
  assert.match(abiertos[0]!.title, /el nombre del servidor de correo/);
  assert.match(abiertos[0]!.message, /mail\.otro\.test/);
  assert.match(abiertos[0]!.remedy, /Ajustes → Identidad del servidor/);

  // Al corregirlo en Ajustes, el aviso se cierra sin esperar a un reinicio.
  const corregido = await guardar({ mailHostname: 'mail.otro.test' });
  assert.equal(corregido.statusCode, 200, corregido.body);
  assert.deepEqual(avisosDeEntorno(), []);
});

test('lo que confirma el instalador se adopta aunque se cambiara a mano', async () => {
  setInstanceSettings({ mailHostname: 'correo.propio.test', panelUrl: 'https://panel-a-mano.test' });
  entorno('cuarto.test');
  const r = await adoptarIdentidad(['mailHostname', 'webmailUrl', 'panelUrl']);
  assert.deepEqual(
    r.cambios.map((c) => c.campo),
    ['servidor', 'webmail', 'panel'],
  );
  assert.equal(getInstanceSettings().mailHostname, 'mail.cuarto.test');
  assert.equal(getInstanceSettings().panelUrl, 'https://panel.cuarto.test');
  assert.equal(motor.settings.get('server.hostname'), 'mail.cuarto.test', 'con el nombre nuevo se aplican los ajustes recomendados');
  assert.deepEqual(avisosDeEntorno(), []);

  // Idempotente: sin nada distinto, no cambia nada.
  const otra = await adoptarIdentidad(['mailHostname']);
  assert.deepEqual(otra.cambios, []);
});

test('un panel anterior a este registro no adopta nada sin la confirmación del instalador', async () => {
  db.prepare(`DELETE FROM settings WHERE key = 'instance_env'`).run();
  entorno('quinto.test');
  const r = sincronizarIdentidadConEntorno();
  assert.deepEqual(r.cambios, [], 'no se sabe si lo guardado vino del entorno o de la administración');
  assert.equal(getInstanceSettings().mailHostname, 'mail.cuarto.test');
  assert.equal(r.discrepancias.length, 3);
  assert.equal(r.avisos.length, 3, 'a quien ejecuta la herramienta se le dicen las tres');
  // En el panel, solo el nombre del servidor y la IP: una URL propia que
  // funcione es legítima y, si el webmail no responde, ya avisa el vigilante.
  assert.equal(avisosDeEntorno().length, 1);
  assert.match(avisosDeEntorno()[0]!.title, /el nombre del servidor de correo/);

  const adoptado = await adoptarIdentidad(['mailHostname', 'webmailUrl', 'panelUrl']);
  assert.equal(adoptado.cambios.length, 3);
  assert.equal(getInstanceSettings().webmailUrl, 'https://webmail.quinto.test');
  assert.deepEqual(avisosDeEntorno(), []);
});

test('al arrancar, el panel adopta el entorno nuevo en lo que nadie ha tocado', async () => {
  entorno('quinto.test', '198.51.100.30');
  const registro: { info: string[]; warn: string[] } = { info: [], warn: [] };
  await adoptarEntornoAlArrancar({ info: (m) => registro.info.push(m), warn: (m) => registro.warn.push(m) });
  assert.equal(getInstanceSettings().publicIp, '198.51.100.30');
  assert.match(registro.info.join('\n'), /MAILWAY_PUBLIC_IP 203\.0\.113\.20 → 198\.51\.100\.30/);
  assert.deepEqual(registro.warn, []);
});

test('guardar otro campo de la identidad fija los del entorno, y aun así se adoptan los siguientes', async () => {
  // Panel sin identidad guardada: usa la del entorno sin copiarla.
  db.prepare(`DELETE FROM settings WHERE key IN ('instance', 'instance_env')`).run();
  entorno('sexto.test');
  await adoptarEntornoAlArrancar({ info: () => undefined, warn: () => undefined });
  // La administración cambia solo la marca: se guardan todos los campos.
  setInstanceSettings({ brandName: 'Correo Sexto' });
  entorno('septimo.test');
  const r = sincronizarIdentidadConEntorno();
  assert.deepEqual(
    r.cambios.map((c) => c.campo),
    ['mailHostname', 'webmailUrl', 'panelUrl'],
  );
  assert.deepEqual(r.discrepancias, []);
  assert.equal(getInstanceSettings().mailHostname, 'mail.septimo.test');
  assert.equal(getInstanceSettings().brandName, 'Correo Sexto');
});

test('un valor no válido del entorno se descarta con un aviso que no lo repite', () => {
  const antes = getInstanceSettings().webmailUrl;
  config.webmailUrlDefault = 'javascript:alert(1)';
  try {
    const r = sincronizarIdentidadConEntorno();
    assert.ok(r.avisos.some((a) => a.includes('MAILWAY_WEBMAIL_URL del entorno del panel no es válido')));
    assert.ok(!r.avisos.join('\n').includes('javascript:'));
    assert.equal(getInstanceSettings().webmailUrl, antes);
  } finally {
    entorno('septimo.test');
  }
});

test('identidad.js solo admite --adoptar con servidor, webmail, panel e ip', () => {
  assert.deepEqual(leerArgumentos(['--adoptar', 'servidor,webmail']), ['mailHostname', 'webmailUrl']);
  assert.deepEqual(leerArgumentos(['--adoptar=ip,panel,ip']), ['publicIp', 'panelUrl']);
  assert.throws(() => leerArgumentos([]), /Indica qué adoptar/);
  assert.throws(() => leerArgumentos(['--adoptar']), /Falta el valor de --adoptar/);
  assert.throws(() => leerArgumentos(['--adoptar', 'servidor', '--adoptar', 'ip']), /está repetida/);
  assert.throws(() => leerArgumentos(['--adoptar', 'toString']), /solo admite servidor, ip, webmail, panel/);
  const suelto = 'mwt_0123abcd_valor-que-no-debe-salir';
  assert.throws(
    () => leerArgumentos(['--adoptar', suelto]),
    (err: Error) => !err.message.includes(suelto),
  );
  assert.throws(() => leerArgumentos(['--email', 'a@b.test']), /Opción --email: solo se admite --adoptar/);
});

test('el aviso del nombre del motor no propone volver al nombre anterior cuando el motor usa el del instalador', () => {
  config.mailHostnameDefault = 'mail.nuevo.test';
  evaluateHostnameAlert('mail.viejo.test', 'mail.nuevo.test');
  const aviso = listAlerts({}).find((a) => a.type === 'engine_hostname');
  assert.ok(aviso);
  assert.match(aviso.remedy, /mail\.nuevo\.test es el nombre que fijó el instalador/);
  assert.match(aviso.remedy, /devolverían el motor a mail\.viejo\.test/);

  // Con otro nombre en el motor, no hay nada que decir del instalador.
  evaluateHostnameAlert('mail.viejo.test', 'mail.otro.test');
  const otro = listAlerts({}).find((a) => a.type === 'engine_hostname' && a.title.includes('mail.otro.test'));
  assert.ok(otro);
  assert.doesNotMatch(otro.remedy, /fijó el instalador/);
});

/* ------------------------- La herramienta de terminal ------------------------ */

const SERVIDOR = path.resolve(__dirname, '..');

function ejecutar(herramienta: string, datos: string, args: string[], entorno: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', 'tsx', `src/tools/${herramienta}.ts`, ...args], {
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
      PUBLIC_URL: '',
      ...entorno,
    },
  });
}

test('identidad.js imprime una sola línea JSON con lo adoptado y falla con código 1 y el motivo', () => {
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), 'mailway-identidad-'));
  const viejo = {
    MAILWAY_MAIL_HOSTNAME: 'mail.viejo.test',
    MAILWAY_WEBMAIL_URL: 'https://webmail.viejo.test',
    MAILWAY_PANEL_URL: 'https://panel.viejo.test',
    MAILWAY_PUBLIC_IP: '203.0.113.20',
  };
  try {
    // El emparejado guarda la identidad del entorno, como la primera instalación.
    const emparejado = ejecutar('emparejar', datos, ['--email', 'cli@identidad.test'], viejo);
    assert.equal(emparejado.status, 0, emparejado.stderr);
    // La administración cambia el nombre a mano en Ajustes.
    const base = new Database(path.join(datos, 'mailway.db'));
    try {
      const fila = base.prepare(`SELECT value FROM settings WHERE key = 'instance'`).get() as { value: string };
      const instancia = { ...(JSON.parse(fila.value) as Record<string, string>), mailHostname: 'correo.propio.test' };
      base.prepare(`UPDATE settings SET value = ? WHERE key = 'instance'`).run(JSON.stringify(instancia));
    } finally {
      base.close();
    }

    const nuevo = { ...viejo, MAILWAY_MAIL_HOSTNAME: 'mail.nuevo.test' };
    const r = ejecutar('identidad', datos, ['--adoptar', 'servidor,webmail'], nuevo);
    assert.equal(r.status, 0, r.stderr);
    const lineas = r.stdout.split('\n').filter(Boolean);
    assert.equal(lineas.length, 1, `una sola línea: ${r.stdout}`);
    assert.deepEqual(JSON.parse(lineas[0]!), {
      cambios: [{ campo: 'servidor', antes: 'correo.propio.test', despues: 'mail.nuevo.test' }],
    });

    const repetida = ejecutar('identidad', datos, ['--adoptar=servidor'], nuevo);
    assert.equal(repetida.status, 0, repetida.stderr);
    assert.deepEqual(JSON.parse(repetida.stdout), { cambios: [] });

    const mal = ejecutar('identidad', datos, ['--adoptar', 'todo'], nuevo);
    assert.equal(mal.status, 1);
    assert.equal(mal.stdout, '');
    assert.match(mal.stderr, /--adoptar solo admite/);
  } finally {
    fs.rmSync(datos, { recursive: true, force: true });
  }
});
