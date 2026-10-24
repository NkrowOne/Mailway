import { afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { getEngine } from '../src/engine';
import { anotarApiDelMotor, olvidarApiDelMotorParaPruebas } from '../src/engine/apiconocida';
import type { EngineSettingsStatus, MailEngine, RecommendedInput } from '../src/engine/types';
import { calcularEstadoDeseado, esperarTareasCorreoWeb } from '../src/modules/correoweb';
import { deleteSetting, setInstanceSettings } from '../src/modules/settings';
import { corsPermisivoNecesario, motorCorreoWebDe } from '../src/modules/webmailmotor';
import { bulwarkFalso, CONTRASENA } from './bulwark-falso';
import { adminContext, createClient, createDomain, type TestContext } from './helpers';

/*
 * Correo web nuevo para toda la instancia (Ajustes → Correo web nuevo): el
 * correo web de los clientes nuevos, pasar a todos de una vez y las funciones
 * de los usuarios (la política de Bulwark es una sola). Y los colores de la
 * marca de cada cliente, que también puede cambiar el propio cliente.
 */

const HOST = 'mail.mailway.test';
let ctx: TestContext;
const bulwarkOriginal = { ...config.bulwark };

before(async () => {
  ctx = await adminContext();
  setInstanceSettings({ mailHostname: HOST, panelUrl: 'https://panel.mailway.test' });
});

afterEach(async () => {
  await esperarTareasCorreoWeb();
  Object.assign(config.bulwark, bulwarkOriginal);
  deleteSetting('correo_web_general');
  deleteSetting('bulwark_sincronizacion');
  db.prepare(`UPDATE clients SET webmail_motor = 'roundcube'`).run();
  olvidarApiDelMotorParaPruebas();
});

async function conBulwark(): Promise<void> {
  const falso = await bulwarkFalso();
  config.bulwark.url = falso.url;
  config.bulwark.adminPassword = CONTRASENA;
  config.bulwark.backendUrl = 'http://mailway-bulwark-gw:8080';
}

/** El motor de demostración haciéndose pasar por Stalwart 0.16, con la cuenta del CORS. */
function simular016() {
  const crudo = getEngine({ saltarMantenimiento: true }) as MailEngine & Record<string, unknown>;
  const estado = { cors: false };
  crudo.detectApi = async () => 'jmap016';
  crudo.getSettingsStatus = async (input: { trustedNetworks: string[]; permissiveCors?: boolean }): Promise<EngineSettingsStatus> => {
    const deseado = input.permissiveCors ?? false;
    const extra: Record<string, boolean> = {};
    if (deseado || estado.cors) extra.permissiveCors = estado.cors === deseado;
    return {
      api: 'jmap016',
      hostname: HOST,
      forwardedHeaders: true,
      trustedNetworks: input.trustedNetworks,
      acme: null,
      certificateFiles: false,
      extra,
      restartRequired: [],
    };
  };
  crudo.applyRecommended = async (input: RecommendedInput) => {
    estado.cors = input.permissiveCors;
    return { errors: [], warnings: [], restartRequired: [] };
  };
  anotarApiDelMotor('jmap016');
  return {
    estado,
    restaurar: () => {
      for (const k of ['detectApi', 'getSettingsStatus', 'applyRecommended']) delete (crudo as Record<string, unknown>)[k];
    },
  };
}

const comoAdmin = (method: 'GET' | 'PUT' | 'POST' | 'PATCH', url: string, payload?: object) =>
  ctx.app.inject({ method, url, headers: { cookie: ctx.adminCookie }, payload });

let seq = 0;

test('ajustes generales: valores por defecto y solo para la administración', async () => {
  const res = await comoAdmin('GET', '/api/settings/correo-web');
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.deepEqual(body.ajustes, { paraNuevos: 'roundcube', calendario: true, contactos: true, archivos: false, relePush: '' });
  assert.equal(body.estado.disponible, false);

  const cliente = await createClient(ctx, { name: `General ${++seq}`, withUser: true });
  const comoCliente = await ctx.app.inject({ method: 'GET', url: '/api/settings/correo-web', headers: { cookie: cliente.userCookie! } });
  assert.equal(comoCliente.statusCode, 403);
  const cambiar = await ctx.app.inject({
    method: 'PUT',
    url: '/api/settings/correo-web',
    headers: { cookie: cliente.userCookie! },
    payload: { archivos: true },
  });
  assert.equal(cambiar.statusCode, 403);
});

test('las funciones de los usuarios van a la política de Bulwark', async () => {
  const res = await comoAdmin('PUT', '/api/settings/correo-web', {
    calendario: false,
    archivos: true,
    relePush: 'https://push.ejemplo.es/',
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().ajustes.archivos, true);
  const { politica } = calcularEstadoDeseado();
  assert.equal(politica.features.calendarEnabled, false);
  assert.equal(politica.features.calendarTasksEnabled, false);
  assert.equal(politica.features.filesEnabled, true);
  assert.equal(politica.features.contactsEnabled, true);
  assert.equal(politica.pushRelayUrl, 'https://push.ejemplo.es');
  assert.equal(politica.pushRelayUrlLocked, true);

  const mal = await comoAdmin('PUT', '/api/settings/correo-web', { relePush: 'http://push.ejemplo.es' });
  assert.equal(mal.statusCode, 400);
  assert.equal(calcularEstadoDeseado().politica.pushRelayUrl, 'https://push.ejemplo.es');
});

test('el nuevo para los clientes nuevos: solo si se puede servir, abre el CORS y los clientes nacen con él', async () => {
  const sinInstalar = await comoAdmin('PUT', '/api/settings/correo-web', { paraNuevos: 'bulwark' });
  assert.equal(sinInstalar.statusCode, 409);
  assert.equal(sinInstalar.json().code, 'bulwark_unavailable');

  await conBulwark();
  const con015 = await comoAdmin('PUT', '/api/settings/correo-web', { paraNuevos: 'bulwark' });
  assert.equal(con015.statusCode, 409);
  assert.equal(con015.json().code, 'bulwark_requires_016');

  const motor = simular016();
  try {
    const res = await comoAdmin('PUT', '/api/settings/correo-web', { paraNuevos: 'bulwark' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().ajustes.paraNuevos, 'bulwark');
    assert.equal(motor.estado.cors, true, 'el CORS se abre antes de guardar');
    // Ningún cliente lo usa todavía, pero el CORS se queda abierto para el próximo.
    assert.equal(corsPermisivoNecesario(), true);

    const nuevo = await createClient(ctx, { name: `Nuevo ${++seq}` });
    assert.equal(motorCorreoWebDe(nuevo.clientId), 'bulwark');

    const vuelta = await comoAdmin('PUT', '/api/settings/correo-web', { paraNuevos: 'roundcube' });
    assert.equal(vuelta.statusCode, 200, vuelta.body);
    const otro = await createClient(ctx, { name: `Otro ${++seq}` });
    assert.equal(motorCorreoWebDe(otro.clientId), 'roundcube');
    // El que nació con el nuevo lo conserva: cada cliente se cambia en su ficha.
    assert.equal(motorCorreoWebDe(nuevo.clientId), 'bulwark');
  } finally {
    motor.restaurar();
  }
});

test('pasar a todos los clientes de una vez, con una entrada en la Actividad de cada uno', async () => {
  const a = await createClient(ctx, { name: `Todos A ${++seq}` });
  const b = await createClient(ctx, { name: `Todos B ${++seq}` });
  await conBulwark();
  const motor = simular016();
  try {
    const res = await comoAdmin('POST', '/api/settings/correo-web/todos', { motor: 'bulwark' });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.json().cambiados >= 2);
    assert.equal(motorCorreoWebDe(a.clientId), 'bulwark');
    assert.equal(motorCorreoWebDe(b.clientId), 'bulwark');
    assert.equal(motor.estado.cors, true);
    const entradas = db
      .prepare("SELECT client_id FROM audit_log WHERE action = 'client.webmail_changed' AND client_id IN (?, ?)")
      .all(a.clientId, b.clientId);
    assert.equal(entradas.length, 2);

    const vuelta = await comoAdmin('POST', '/api/settings/correo-web/todos', { motor: 'roundcube' });
    assert.equal(vuelta.statusCode, 200, vuelta.body);
    assert.equal(motorCorreoWebDe(a.clientId), 'roundcube');
    assert.equal(vuelta.json().clientes.conBulwark, 0);
    await esperarTareasCorreoWeb();
    assert.equal(motor.estado.cors, false, 'sin nadie en el nuevo, el CORS se cierra');
  } finally {
    motor.restaurar();
  }
});

test('colores de la marca: los cambia el cliente, se validan y llegan a Bulwark', async () => {
  const cliente = await createClient(ctx, { name: `Colores ${++seq}`, withUser: true });
  const { domain } = await createDomain(ctx, cliente.clientId, `colores${seq}-correoweb.test`);
  db.prepare(
    `INSERT INTO client_domains (id, client_id, hostname, kind, status, activated_at, created_at)
     VALUES (?, ?, ?, 'webmail', 'active', ?, ?)`,
  ).run(`wld_col${seq}`, cliente.clientId, `webmail.${domain}`, Date.now(), Date.now());

  const mal = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/clients/${cliente.clientId}/webmail/marca`,
    headers: { cookie: cliente.userCookie! },
    payload: { colorTema: 'rojo' },
  });
  assert.equal(mal.statusCode, 400);

  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/clients/${cliente.clientId}/webmail/marca`,
    headers: { cookie: cliente.userCookie! },
    payload: { colorTema: '#0D5C5E', colorFondo: '#fff' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().marca.colorTema, '#0d5c5e');
  assert.equal(res.json().marca.colorFondo, '#fff');

  await conBulwark();
  const motor = simular016();
  try {
    db.prepare(`UPDATE clients SET webmail_motor = 'bulwark' WHERE id = ?`).run(cliente.clientId);
    const entrada = calcularEstadoDeseado().marca.find((m) => m.host === `webmail.${domain}`);
    assert.ok(entrada, 'la marca del webmail del cliente');
    assert.equal(entrada.pwaThemeColor, '#0d5c5e');
    assert.equal(entrada.pwaBackgroundColor, '#fff');
  } finally {
    motor.restaurar();
  }

  // Vacío vuelve al de Bulwark.
  const vacio = await comoAdmin('PATCH', `/api/clients/${cliente.clientId}/webmail/marca`, { colorTema: '' });
  assert.equal(vacio.json().marca.colorTema, '');
});
