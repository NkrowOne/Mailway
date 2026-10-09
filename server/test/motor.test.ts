import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Transporter } from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { decryptSecret } from '../src/core/crypto';
import { getEngine } from '../src/engine';
import { DemoEngine } from '../src/engine/demo';
import type { CreatedAppPassword, EngineApi, MailEngine } from '../src/engine/types';
import { listAlerts } from '../src/modules/alerts';
import { MAX_ACTIVE_APP_PASSWORDS } from '../src/modules/apppasswords';
import { componerAvisoInvalidadas, trasMigrarMotor } from '../src/modules/cambiomotor';
import { comprobarContrasenaBuzon, leerHashBuzon } from '../src/modules/credenciales';
import { estadoMantenimiento } from '../src/modules/mantenimiento';
import { setEngineSettings, setInstanceSettings, setSetting } from '../src/modules/settings';
import { setTransportFactoryForTests } from '../src/modules/transactional';
import { runWatchdogOnce } from '../src/modules/watchdog';
import { ejecutarMotor } from '../src/tools/motor';
import {
  adminContext,
  createClient,
  createDomain,
  createMailbox,
  motorAcepta,
  type TestContext,
} from './helpers';

/*
 * Cambio de versión del motor: modo mantenimiento, herramienta de terminal
 * (tools/motor.ts) y lo que ven el panel, «Mi buzón» y las integraciones
 * cuando las contraseñas de aplicación mueren con la migración.
 *
 * Stalwart 0.16 se simula sobre el motor de demostración: dice que habla
 * JMAP, genera él el secreto de las contraseñas de aplicación (app_…) y ya
 * no da los hashes. Así se prueban los flujos del panel sin el driver JMAP.
 */

const HOST = 'mail.mailway.test';
let ctx: TestContext;

before(async () => {
  ctx = await adminContext();
  setInstanceSettings({ mailHostname: HOST, panelUrl: 'https://panel.mailway.test' });
});

after(() => {
  setTransportFactoryForTests(null);
  db.prepare("DELETE FROM settings WHERE key = 'motor_mantenimiento'").run();
});

/* --------------------------------- Ayudas --------------------------------- */

interface Salida {
  codigo: number;
  json: Record<string, any>;
  errores: string[];
}

async function motor(...argv: string[]): Promise<Salida> {
  const salida: string[] = [];
  const errores: string[] = [];
  const codigo = await ejecutarMotor(argv, { out: (l) => salida.push(l), err: (l) => errores.push(l) });
  assert.equal(salida.length, 1, 'una sola línea JSON por la salida estándar');
  return { codigo, json: JSON.parse(salida[0]!) as Record<string, any>, errores };
}

function como(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  return ctx.app.inject({ method, url, headers: { cookie: ctx.adminCookie }, payload });
}

/**
 * Convierte el motor de demostración en un «Stalwart 0.16»: el panel y la
 * herramienta lo ven igual, porque el guardián del mantenimiento delega en él.
 */
function simular016(): { retiradas: string[]; restaurar: () => void } {
  const crudo = getEngine({ saltarMantenimiento: true }) as DemoEngine & Record<string, unknown>;
  const retiradas: string[] = [];
  let n = 0;
  crudo.detectApi = async (): Promise<EngineApi> => 'jmap016';
  crudo.addAppPassword = async (email: string): Promise<CreatedAppPassword> => {
    n += 1;
    return { secret: `app_GENERADA${String(n).padStart(4, '0')}ENELMOTOR`, ref: `cuenta-${email}:${n}` };
  };
  crudo.removeAppPassword = async (_email: string, ref: string) => {
    retiradas.push(ref);
  };
  crudo.readMailboxCredentials = async () => null;
  return {
    retiradas,
    restaurar: () => {
      for (const metodo of ['detectApi', 'addAppPassword', 'removeAppPassword', 'readMailboxCredentials']) {
        delete crudo[metodo];
      }
    },
  };
}

async function escenario(nombre: string) {
  const client = await createClient(ctx, { name: nombre });
  const { domainId, domain } = await createDomain(ctx, client.clientId);
  const buzon = await createMailbox(ctx, domainId, 'ana');
  return { clientId: client.clientId, domainId, domain, ...buzon };
}

/* ---------------------------- Modo mantenimiento ---------------------------- */

test('la orden mantenimiento valida sus opciones (código 2) y on/off devuelven el estado', async () => {
  for (const argv of [[], ['nada'], ['mantenimiento'], ['mantenimiento', 'on', '--minutos', '0'], ['mantenimiento', 'on', '--minutos=abc'], ['mantenimiento', 'on', '--otra'], ['estado', '--x']]) {
    const r = await motor(...argv);
    assert.equal(r.codigo, 2, argv.join(' '));
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /Uso:|minutos|no admite/);
  }
  const on = await motor('mantenimiento', 'on', '--minutos', '30');
  assert.equal(on.codigo, 0);
  assert.equal(on.json.ok, true);
  assert.equal(on.json.activo, true);
  assert.ok(Math.abs(on.json.hasta - (Date.now() + 30 * 60_000)) < 5000);
  const off = await motor('mantenimiento', 'off');
  assert.deepEqual(off.json, { ok: true, activo: false, hasta: null });
  assert.equal(off.codigo, 0);
});

test('en mantenimiento las modificaciones del motor dan 503 y las lecturas siguen', async () => {
  const e = await escenario('Mantenimiento');
  const clave = await como('POST', '/api/apikeys', { clientId: e.clientId, name: 'OTP', senderMailboxId: e.mailboxId });
  assert.equal(clave.statusCode, 200, clave.body);
  const hashAntes = leerHashBuzon(e.mailboxId);
  assert.equal((await motor('mantenimiento', 'on')).codigo, 0);
  try {
    const mutaciones: [string, 'POST' | 'PATCH' | 'DELETE', string, object?][] = [
      ['alta de buzón', 'POST', '/api/mailboxes', { domainId: e.domainId, localPart: 'nuevo' }],
      ['contraseña del buzón', 'POST', `/api/mailboxes/${e.mailboxId}/password`, { password: 'otra-clave-larga' }],
      ['contraseña de aplicación', 'POST', `/api/mailboxes/${e.mailboxId}/app-passwords`, { name: 'Móvil' }],
      ['nombre visible', 'PATCH', `/api/mailboxes/${e.mailboxId}`, { displayName: 'Ana' }],
      ['suspensión del cliente', 'PATCH', `/api/clients/${e.clientId}`, { suspended: true }],
      ['revocar la clave de API', 'DELETE', `/api/apikeys/${(clave.json() as { info: { id: string } }).info.id}`],
      ['alias', 'POST', '/api/aliases', { domainId: e.domainId, localPart: 'ventas', destinations: [e.email] }],
      ['ajustes recomendados', 'POST', '/api/engine/recommended'],
      ['certificado', 'POST', '/api/engine/acme', { cloudflareAccountId: 'cf', email: 'a@b.es' }],
      ['recargar certificado', 'POST', '/api/engine/reload-certificate'],
      ['alta masiva', 'POST', '/api/mailboxes/bulk', { domainId: e.domainId, entries: [{ localPart: 'lote' }] }],
      ['eliminar el dominio', 'DELETE', `/api/domains/${e.domainId}?confirm=${e.domain}`],
      ['reiniciar la puesta en marcha', 'POST', `/api/clients/${e.clientId}/onboarding-reset`, {}],
    ];
    for (const [que, method, url, payload] of mutaciones) {
      const res = await como(method, url, payload);
      assert.equal(res.statusCode, 503, `${que}: ${res.body}`);
      assert.equal(res.json().code, 'engine_maintenance', que);
      assert.match(res.json().error, /se está actualizando/);
    }
    // Nada ha cambiado a medias en la base.
    assert.equal(leerHashBuzon(e.mailboxId), hashAntes);
    assert.notEqual(db.prepare('SELECT 1 FROM domains WHERE id = ?').get(e.domainId), undefined);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM mailboxes WHERE domain_id = ?').get(e.domainId) as { c: number }).c,
      1,
    );
    assert.equal((db.prepare('SELECT suspended FROM clients WHERE id = ?').get(e.clientId) as { suspended: number }).suspended, 0);
    assert.equal(
      (db.prepare('SELECT revoked_at FROM api_keys WHERE client_id = ?').get(e.clientId) as { revoked_at: number | null }).revoked_at,
      null,
    );

    // Las lecturas, sí: listados, estado del motor y «Mi buzón».
    assert.equal((await como('GET', `/api/mailboxes?clientId=${e.clientId}`)).statusCode, 200);
    const estado = await como('GET', '/api/engine/status');
    assert.equal(estado.statusCode, 200, estado.body);
    assert.equal(estado.json().maintenance.active, true);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/portal/login',
      payload: { email: e.email, password: e.password },
      remoteAddress: '10.61.0.1',
    });
    assert.equal(login.statusCode, 200, login.body);

    // La migración se salta el guardián.
    await getEngine({ saltarMantenimiento: true }).createDomain('directo.test');
  } finally {
    await motor('mantenimiento', 'off');
  }
  assert.equal((await como('PATCH', `/api/mailboxes/${e.mailboxId}`, { displayName: 'Ana' })).statusCode, 200);
});

test('el mantenimiento caduca solo: una migración interrumpida no deja el panel bloqueado', async () => {
  const e = await escenario('Caducidad');
  setSetting('motor_mantenimiento', JSON.stringify({ desde: Date.now() - 3 * 3600_000, hasta: Date.now() - 1000 }));
  assert.equal(estadoMantenimiento().activo, false);
  assert.equal((await como('PATCH', `/api/mailboxes/${e.mailboxId}`, { displayName: 'Ana' })).statusCode, 200);
  // Y nunca dura más de un día.
  const r = await motor('mantenimiento', 'on', '--minutos', '5000');
  assert.equal(r.codigo, 2);
});

test('en mantenimiento el vigilante no avisa de motor caído', async () => {
  db.prepare('DELETE FROM alerts').run();
  const crudo = getEngine({ saltarMantenimiento: true }) as unknown as Record<string, unknown>;
  crudo.ping = async () => ({ ok: false, detail: 'Parado para migrar.' });
  try {
    await motor('mantenimiento', 'on');
    await runWatchdogOnce();
    assert.equal(listAlerts({}).filter((a) => a.type === 'engine_down').length, 0);
    await motor('mantenimiento', 'off');
    await runWatchdogOnce();
    assert.equal(listAlerts({}).filter((a) => a.type === 'engine_down').length, 1, 'fuera del mantenimiento, sí');
  } finally {
    delete crudo.ping;
    await motor('mantenimiento', 'off');
    db.prepare('DELETE FROM alerts').run();
  }
});

/* --------------------------- estado y capturar ----------------------------- */

test('estado: API, copia de las contraseñas, contraseñas de aplicación por API y mantenimiento', async () => {
  const e = await escenario('Estado');
  await como('POST', `/api/mailboxes/${e.mailboxId}/app-passwords`, { name: 'Móvil' });
  db.prepare('DELETE FROM credenciales_buzon WHERE mailbox_id = ?').run(e.mailboxId);
  const r = await motor('estado');
  assert.equal(r.codigo, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.api, 'demo');
  assert.deepEqual(r.json.mantenimiento, { activo: false, hasta: null });
  assert.equal(r.json.buzones.total, r.json.buzones.conHash + r.json.buzones.sinHash);
  assert.ok(r.json.buzones.sinHash >= 1);
  assert.ok(r.json.contrasenasAplicacion.porApi.demo >= 1);
  assert.equal(typeof r.json.contrasenasAplicacion.invalidadas, 'number');
  // La copia vuelve sola al comprobar la contraseña (el motor de demostración la tiene).
  assert.equal(await comprobarContrasenaBuzon(e.mailboxId, e.password), 'principal');
});

test('capturar solo funciona con Stalwart 0.15', async () => {
  const r = await motor('capturar');
  assert.equal(r.codigo, 1);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /Stalwart 0\.15/);
  assert.deepEqual(r.json.fallidos, []);
});

/* ------------------------------- provisionar -------------------------------- */

test('provisionar: ajustes, suspensiones de nuevo y lo que falta en el motor (también en mantenimiento)', async () => {
  const e = await escenario('Provisión');
  const suspendido = await createMailbox(ctx, e.domainId, 'suspendido');
  assert.equal((await como('PATCH', `/api/mailboxes/${suspendido.mailboxId}`, { status: 'suspended' })).statusCode, 200);
  assert.equal((await como('POST', '/api/aliases', { domainId: e.domainId, localPart: 'ventas', destinations: [e.email] })).statusCode, 200);
  const crudo = getEngine({ saltarMantenimiento: true });
  // La migración oficial no conserva las suspensiones: vuelve activo.
  await crudo.updateMailbox(suspendido.email, { suspended: false });
  assert.equal(await motorAcepta(suspendido.email, suspendido.password), true);

  const sim = simular016();
  await motor('mantenimiento', 'on');
  try {
    const bien = await motor('provisionar');
    assert.equal(bien.codigo, 0, JSON.stringify(bien.json));
    assert.equal(bien.json.ok, true);
    assert.equal(bien.json.api, 'jmap016');
    assert.ok(bien.json.aplicados.includes(`Nombre del servidor: ${HOST}`));
    assert.ok(bien.json.aplicados.includes('Máximo de contraseñas de aplicación por buzón: 100'));
    assert.deepEqual(bien.json.restartRequired, []);
    assert.deepEqual(bien.json.errores, []);
    assert.ok(bien.json.suspensiones.reaplicadas >= 1);
    assert.deepEqual(bien.json.suspensiones.fallidas, []);
    assert.deepEqual(bien.json.faltan, { dominios: [], buzones: [], alias: [] });
    assert.equal(await motorAcepta(suspendido.email, suspendido.password), false, 'suspendido otra vez');

    // Un puerto nuevo que exige reiniciar no es un error.
    const aplicar = crudo.applyRecommended.bind(crudo);
    (crudo as unknown as Record<string, unknown>).applyRecommended = async (input: Parameters<MailEngine['applyRecommended']>[0]) => ({
      ...(await aplicar(input)),
      restartRequired: ['Puerto 587 (STARTTLS)'],
    });
    const reiniciar = await motor('provisionar');
    delete (crudo as unknown as Record<string, unknown>).applyRecommended;
    assert.equal(reiniciar.codigo, 0);
    assert.deepEqual(reiniciar.json.restartRequired, ['Puerto 587 (STARTTLS)']);
    assert.ok(reiniciar.errores.some((l) => /reiniciarse/.test(l)));

    // Falta un buzón y un alias en el motor: código 1 y la lista.
    await crudo.deleteMailbox(e.email);
    await crudo.deleteAlias(`ventas@${e.domain}`);
    const mal = await motor('provisionar');
    assert.equal(mal.codigo, 1);
    assert.equal(mal.json.ok, false);
    assert.deepEqual(mal.json.faltan.buzones, [e.email]);
    assert.deepEqual(mal.json.faltan.alias, [`ventas@${e.domain}`]);
    assert.match(mal.json.error, /Faltan en el motor/);
  } finally {
    sim.restaurar();
    await motor('mantenimiento', 'off');
    // Se deja el motor de demostración como estaba para las demás pruebas.
    await crudo.createMailbox({ email: e.email, passwordHash: leerHashBuzon(e.mailboxId)! });
    await crudo.upsertAlias(`ventas@${e.domain}`, [e.email]);
  }
});

/* -------------------------------- tras-migrar ------------------------------- */

test('el motor impone el secreto: contraseñas de aplicación, claves de API y formularios guardan el que devuelve', async () => {
  const e = await escenario('Secreto impuesto');
  const sim = simular016();
  try {
    const app = await como('POST', `/api/mailboxes/${e.mailboxId}/app-passwords`, { name: 'Móvil' });
    assert.equal(app.statusCode, 200, app.body);
    const { password, appPassword, snippets } = app.json() as {
      password: string;
      appPassword: { id: string };
      snippets: { content: string }[];
    };
    assert.match(password, /^app_GENERADA/, 'se entrega la del motor, no la propuesta');
    assert.ok(snippets.some((s) => s.content.includes(password)), 'y los bloques llevan esa misma');
    const fila = db.prepare('SELECT stored_secret, engine_api FROM app_passwords WHERE id = ?').get(appPassword.id) as {
      stored_secret: string;
      engine_api: string;
    };
    assert.equal(fila.engine_api, 'jmap016');
    assert.match(fila.stored_secret, /^cuenta-.*:\d+$/, 'se guarda la referencia que dio el motor');
    // «Mi buzón» la reconoce como contraseña de aplicación por su verificador.
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/portal/login',
      payload: { email: e.email, password },
      remoteAddress: '10.61.0.2',
    });
    assert.equal(login.statusCode, 400, login.body);
    assert.equal(login.json().code, 'app_password_not_allowed');

    const clave = await como('POST', '/api/apikeys', { clientId: e.clientId, name: 'OTP', senderMailboxId: e.mailboxId });
    assert.equal(clave.statusCode, 200, clave.body);
    const filaClave = db
      .prepare('SELECT smtp_password_enc, smtp_engine_api FROM api_keys WHERE id = ?')
      .get((clave.json() as { info: { id: string } }).info.id) as { smtp_password_enc: string; smtp_engine_api: string };
    assert.equal(filaClave.smtp_engine_api, 'jmap016');
    assert.match((JSON.parse(decryptSecret(filaClave.smtp_password_enc)) as { plain: string }).plain, /^app_GENERADA/);

    const form = await ctx.app.inject({
      method: 'POST',
      url: '/api/forms',
      headers: { cookie: ctx.adminCookie },
      payload: { clientId: e.clientId, name: 'Contacto', recipientMailboxId: e.mailboxId, allowedOrigins: ['https://web.test'] },
    });
    assert.equal(form.statusCode, 200, form.body);
    const filaForm = db
      .prepare('SELECT smtp_password_enc, smtp_engine_api FROM forms WHERE id = ?')
      .get((form.json() as { form: { id: string } }).form.id) as { smtp_password_enc: string; smtp_engine_api: string };
    assert.equal(filaForm.smtp_engine_api, 'jmap016');
    assert.match((JSON.parse(decryptSecret(filaForm.smtp_password_enc)) as { plain: string }).plain, /^app_GENERADA/);

    // Revocar una de este motor la retira de él con su referencia.
    assert.equal((await como('DELETE', `/api/mailboxes/${e.mailboxId}/app-passwords/${appPassword.id}`)).statusCode, 200);
    assert.deepEqual(sim.retiradas, [fila.stored_secret]);
  } finally {
    sim.restaurar();
  }
});

test('tras-migrar: renueva las credenciales internas, invalida las de dispositivos y Skyway, avisa y es idempotente', async () => {
  db.prepare("DELETE FROM alerts WHERE type = 'engine_app_passwords_invalidated'").run();
  const e = await escenario('Tras migrar');
  // Antes de migrar (motor de demostración, que hace de 0.15).
  const movil = await como('POST', `/api/mailboxes/${e.mailboxId}/app-passwords`, { name: 'Móvil de Ana' });
  const skyway = await como('POST', `/api/mailboxes/${e.mailboxId}/app-passwords`, { name: 'skyway:web' });
  assert.equal(movil.statusCode, 200);
  assert.equal(skyway.statusCode, 200);
  const clave = await como('POST', '/api/apikeys', { clientId: e.clientId, name: 'OTP', senderMailboxId: e.mailboxId });
  const form = await ctx.app.inject({
    method: 'POST',
    url: '/api/forms',
    headers: { cookie: ctx.adminCookie },
    payload: { clientId: e.clientId, name: 'Contacto', recipientMailboxId: e.mailboxId, allowedOrigins: ['https://web.test'] },
  });
  assert.equal(clave.statusCode, 200);
  assert.equal(form.statusCode, 200);
  const claveId = (clave.json() as { info: { id: string } }).info.id;
  const formId = (form.json() as { form: { id: string } }).form.id;
  const movilId = (movil.json() as { appPassword: { id: string } }).appPassword.id;

  const sim = simular016();
  try {
    // El formulario falla la primera vez: queda marcado y se reintenta.
    const crudo = getEngine({ saltarMantenimiento: true }) as DemoEngine & Record<string, unknown>;
    const imponer = crudo.addAppPassword as MailEngine['addAppPassword'];
    crudo.addAppPassword = async (email: string, label: string, propuesta: string) => {
      if (label.startsWith('mailway-form-')) throw new Error('Motor ocupado');
      return imponer(email, label, propuesta);
    };
    const primera = await motor('tras-migrar');
    assert.equal(primera.codigo, 1, JSON.stringify(primera.json));
    assert.equal(primera.json.ok, false);
    assert.ok(primera.json.credencialesInternas.renovadas >= 1);
    assert.equal(primera.json.credencialesInternas.fallidas.length >= 1, true);
    assert.match(primera.json.credencialesInternas.fallidas.join(' '), /Formulario «Contacto».*Motor ocupado/);
    assert.ok(primera.json.contrasenasInvalidadas >= 2);
    assert.equal(primera.json.avisados, 0, 'con el motor de demostración no se envía correo');
    const filaForm = db.prepare('SELECT smtp_invalidated_at FROM forms WHERE id = ?').get(formId) as { smtp_invalidated_at: number | null };
    assert.notEqual(filaForm.smtp_invalidated_at, null);

    crudo.addAppPassword = imponer;
    const segunda = await motor('tras-migrar');
    assert.equal(segunda.codigo, 0, JSON.stringify(segunda.json));
    assert.equal(segunda.json.contrasenasInvalidadas, 0, 'ya estaban marcadas');
    assert.deepEqual(segunda.json.credencialesInternas.fallidas, []);
    assert.ok(segunda.json.credencialesInternas.renovadas >= 1, 'el formulario, ahora sí');
    const tercera = await motor('tras-migrar');
    assert.equal(tercera.codigo, 0);
    assert.equal(tercera.json.credencialesInternas.renovadas, 0, 'idempotente');
    assert.equal(tercera.json.contrasenasInvalidadas, 0);

    for (const [tabla, id] of [['api_keys', claveId], ['forms', formId]] as const) {
      const fila = db.prepare(`SELECT smtp_password_enc, smtp_engine_api, smtp_invalidated_at FROM ${tabla} WHERE id = ?`).get(id) as {
        smtp_password_enc: string;
        smtp_engine_api: string;
        smtp_invalidated_at: number | null;
      };
      assert.equal(fila.smtp_engine_api, 'jmap016', tabla);
      assert.equal(fila.smtp_invalidated_at, null, tabla);
      assert.match((JSON.parse(decryptSecret(fila.smtp_password_enc)) as { plain: string }).plain, /^app_GENERADA/, tabla);
    }

    // Un único aviso para la administración, con el buzón afectado.
    const avisos = listAlerts({}).filter((a) => a.type === 'engine_app_passwords_invalidated');
    assert.equal(avisos.length, 1);
    assert.ok(avisos[0]!.message.includes(e.email));

    // El panel, la integración y «Mi buzón» lo ven.
    const lista = (await como('GET', `/api/mailboxes/${e.mailboxId}/app-passwords`)).json() as {
      appPasswords: { id: string; name: string; invalidatedAt: number | null; revokedAt: number | null }[];
    };
    assert.ok(lista.appPasswords.every((a) => a.revokedAt !== null || a.invalidatedAt !== null));
    const resumen = (await como('GET', `/api/integrations/clients/${e.clientId}/summary`)).json() as {
      appPasswords: { name: string; invalidatedAt: number | null }[];
    };
    assert.ok(resumen.appPasswords.find((a) => a.name === 'skyway:web')!.invalidatedAt! > 0);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/portal/login',
      payload: { email: e.email, password: e.password },
      remoteAddress: '10.61.0.3',
    });
    assert.equal(login.statusCode, 200, login.body);
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/portal/me',
      headers: { cookie: String(login.headers['set-cookie']).split(';')[0]! },
    });
    // La de Skyway no cuenta: la renueva Skyway, no el titular.
    assert.equal(me.json().invalidatedAppPasswords, 1);

    // Las invalidadas no cuentan para el máximo y se revocan sin el motor.
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM app_passwords WHERE mailbox_id = ? AND revoked_at IS NULL').get(e.mailboxId) as { c: number }).c,
      2,
    );
    for (let i = 0; i < MAX_ACTIVE_APP_PASSWORDS; i += 1) {
      const res = await como('POST', `/api/mailboxes/${e.mailboxId}/app-passwords`, { name: `Dispositivo ${i}` });
      assert.equal(res.statusCode, 200, res.body);
    }
    const sobra = await como('POST', `/api/mailboxes/${e.mailboxId}/app-passwords`, { name: 'Uno más' });
    assert.equal(sobra.statusCode, 409);
    sim.retiradas.length = 0;
    assert.equal((await como('DELETE', `/api/mailboxes/${e.mailboxId}/app-passwords/${movilId}`)).statusCode, 200);
    assert.equal((await como('DELETE', `/api/mailboxes/${e.mailboxId}/app-passwords/${movilId}`)).statusCode, 200, 'idempotente');
    assert.deepEqual(sim.retiradas, [], 'una invalidada no se pide al motor');
    assert.notEqual(
      (db.prepare('SELECT revoked_at FROM app_passwords WHERE id = ?').get(movilId) as { revoked_at: number | null }).revoked_at,
      null,
    );
  } finally {
    sim.restaurar();
  }
});

test('tras-migrar avisa por correo a cada titular una sola vez, sin las de Skyway', async () => {
  const e = await escenario('Aviso por correo');
  const otro = await createMailbox(ctx, e.domainId, 'solo-skyway');
  await como('POST', `/api/mailboxes/${e.mailboxId}/app-passwords`, { name: 'Móvil <Ana>' });
  await como('POST', `/api/mailboxes/${e.mailboxId}/app-passwords`, { name: 'skyway:api' });
  await como('POST', `/api/mailboxes/${otro.mailboxId}/app-passwords`, { name: 'skyway:web' });
  db.prepare(
    'UPDATE app_passwords SET invalidated_at = ? WHERE revoked_at IS NULL AND invalidated_at IS NULL AND mailbox_id IN (?, ?)',
  ).run(Date.now(), e.mailboxId, otro.mailboxId);
  // Las de las pruebas anteriores ya se avisaron: aquí solo cuentan estas.
  db.prepare('UPDATE app_passwords SET invalidation_notified_at = 1 WHERE mailbox_id NOT IN (?, ?)').run(
    e.mailboxId,
    otro.mailboxId,
  );

  class Motor016 extends DemoEngine {
    override async detectApi(): Promise<EngineApi> {
      return 'jmap016';
    }
  }
  const enviados: Mail.Options[] = [];
  setTransportFactoryForTests(
    () =>
      ({
        sendMail: async (opciones: Mail.Options) => {
          enviados.push(opciones);
          return { messageId: '<aviso@motor>' };
        },
        close: () => undefined,
      }) as unknown as Transporter,
  );
  config.demoMode = false;
  setEngineSettings({
    kind: 'stalwart',
    url: 'http://mailway-mail:8080',
    adminUser: 'admin',
    adminPassword: 'x',
    smtpHost: 'mailway-mail',
    smtpPort: 587,
    smtpSecure: false,
  });
  try {
    const motor016 = new Motor016();
    const primera = await trasMigrarMotor(motor016);
    assert.equal(primera.avisados, 1, JSON.stringify(primera));
    const aviso = enviados.find((m) => m.to === e.email);
    assert.ok(aviso, 'el titular recibe el aviso en su buzón');
    assert.ok(!enviados.some((m) => m.to === otro.email), 'las de Skyway las renueva Skyway');
    assert.equal((aviso.from as { address: string }).address, `configuration@${e.domain}`);
    assert.match(String(aviso.text), /Móvil <Ana>/);
    assert.ok(!String(aviso.text).includes('skyway:api'));
    assert.match(String(aviso.text), /https:\/\/panel\.mailway\.test\/mi-buzon/);
    assert.ok(String(aviso.html).includes('Móvil &lt;Ana&gt;'), 'el HTML va escapado');

    const segunda = await trasMigrarMotor(motor016);
    assert.equal(segunda.avisados, 0, 'cada titular, una vez');
    assert.equal(enviados.filter((m) => m.to === e.email).length, 1);
  } finally {
    config.demoMode = true;
    setTransportFactoryForTests(null);
  }
});

test('el aviso al titular sin URL pública del panel explica dónde crear la contraseña', () => {
  const correo = componerAvisoInvalidadas({
    email: 'ana@acme.test',
    domain: 'acme.test',
    contrasenas: [{ nombre: 'Portátil', creadaEn: Date.UTC(2026, 2, 3, 10) }],
    urlMiBuzon: '',
  });
  assert.match(correo.subject, /han dejado de funcionar \(ana@acme\.test\)/);
  assert.match(correo.text, /«Portátil», creada el 3 de marzo de 2026/);
  assert.match(correo.text, /persona que administra tu correo/);
  assert.ok(!correo.html.includes('href='));
});
