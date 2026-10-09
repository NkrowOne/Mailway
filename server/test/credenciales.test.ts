import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { sha512Crypt } from '../src/core/sha512crypt';
import { MotorStalwart } from '../src/engine/detector';
import type { EngineSettings } from '../src/engine/types';
import {
  capturarCredenciales,
  comprobarContrasenaBuzon,
  leerHashBuzon,
  recuentoCopias,
} from '../src/modules/credenciales';
import { setEngineSettings } from '../src/modules/settings';
import {
  adminContext,
  createClient,
  createDomain,
  createMailbox,
  motorAcepta,
  type TestContext,
} from './helpers';
import { fakeStalwart } from './stalwart-falso';

/*
 * Copia local de las credenciales de los buzones: el panel comprueba las
 * contraseñas con su propia copia del hash (Stalwart 0.16 ya no los da) y la
 * llena desde Stalwart 0.15 al comprobar una contraseña o en bloque.
 */

const SECRETO = 'clave-del-motor-015';
const motorFalso = fakeStalwart(SECRETO);
let ajustes015: EngineSettings;
let ctx: TestContext;

before(async () => {
  ctx = await adminContext();
  const url = await motorFalso.listen();
  ajustes015 = {
    kind: 'stalwart',
    url,
    adminUser: 'admin',
    adminPassword: SECRETO,
    smtpHost: '127.0.0.1',
    smtpPort: 587,
    smtpSecure: false,
  };
});

after(() => motorFalso.close());

async function buzonNuevo() {
  const client = await createClient(ctx);
  const { domainId } = await createDomain(ctx, client.clientId);
  const mailbox = await createMailbox(ctx, domainId);
  return { ...mailbox, clientId: client.clientId, domainId };
}

function patch(url: string, payload: object) {
  return ctx.app.inject({ method: 'PATCH', url, headers: { cookie: ctx.adminCookie }, payload });
}

/* ------------------------- Comprobación en el panel ------------------------ */

test('al crear el buzón el panel guarda el mismo hash que recibe el motor, cifrado', async () => {
  const b = await buzonNuevo();
  const hash = leerHashBuzon(b.mailboxId);
  assert.ok(hash?.startsWith('$6$'));
  const fila = db.prepare('SELECT password_hash_enc, source FROM credenciales_buzon WHERE mailbox_id = ?').get(b.mailboxId) as {
    password_hash_enc: string;
    source: string;
  };
  assert.ok(fila.password_hash_enc.startsWith('v1:'), 'cifrado con la clave maestra');
  assert.ok(!fila.password_hash_enc.includes('$6$'));
  assert.equal(fila.source, 'panel');
  assert.equal(await motorAcepta(b.email, b.password), true, 'el motor recibió ese mismo hash');
});

test('correcta, incorrecta, buzón suspendido, cliente suspendido y dirección desconocida', async () => {
  const b = await buzonNuevo();
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, b.password), 'principal');
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, 'otra-clave-cualquiera'), 'incorrecta');
  assert.equal(await comprobarContrasenaBuzon(null, b.password), 'incorrecta', 'dirección que no es de ningún buzón');
  assert.equal(await comprobarContrasenaBuzon('mbx_no_existe', b.password), 'incorrecta');

  // La suspensión sale de la base del panel, no del motor.
  assert.equal((await patch(`/api/mailboxes/${b.mailboxId}`, { status: 'suspended' })).statusCode, 200);
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, b.password), 'incorrecta');
  assert.equal((await patch(`/api/mailboxes/${b.mailboxId}`, { status: 'active' })).statusCode, 200);
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, b.password), 'principal');

  assert.equal((await patch(`/api/clients/${b.clientId}`, { suspended: true })).statusCode, 200);
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, b.password), 'incorrecta', 'su cliente está suspendido');
  assert.equal((await patch(`/api/clients/${b.clientId}`, { suspended: false })).statusCode, 200);
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, b.password), 'principal');
});

test('las contraseñas de aplicación se reconocen por su verificador; revocadas e invalidadas no valen', async () => {
  const b = await buzonNuevo();
  const crear = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${b.mailboxId}/app-passwords`,
    headers: { cookie: ctx.adminCookie },
    payload: { name: 'Móvil' },
  });
  assert.equal(crear.statusCode, 200, crear.body);
  const { appPassword, password } = crear.json() as { appPassword: { id: string }; password: string };
  const fila = db.prepare('SELECT verifier, engine_api FROM app_passwords WHERE id = ?').get(appPassword.id) as {
    verifier: string;
    engine_api: string;
  };
  assert.ok(fila.verifier.startsWith('$6$'), 'verificador irreversible, nunca la contraseña');
  assert.equal(fila.engine_api, 'demo');
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, password), 'aplicacion');

  db.prepare('UPDATE app_passwords SET invalidated_at = ? WHERE id = ?').run(Date.now(), appPassword.id);
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, password), 'incorrecta', 'invalidada: ya no funciona');

  db.prepare('UPDATE app_passwords SET invalidated_at = NULL, revoked_at = ? WHERE id = ?').run(Date.now(), appPassword.id);
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, password), 'incorrecta', 'revocada');
});

test('una contraseña de aplicación anterior a la copia local se reconoce por su referencia $app$', async () => {
  const b = await buzonNuevo();
  const legada = 'abcd-efgh-jkmn-pqrs';
  db.prepare(
    `INSERT INTO app_passwords (id, mailbox_id, name, stored_secret, created_at) VALUES ('app_legada', ?, 'Portátil', ?, ?)`,
  ).run(b.mailboxId, `$app$mw-portatil-1a2b3c4d$${sha512Crypt(legada)}`, Date.now());
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, legada), 'aplicacion');
});

test('cambiar la contraseña desde el panel actualiza el motor y la copia local', async () => {
  const b = await buzonNuevo();
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${b.mailboxId}/password`,
    headers: { cookie: ctx.adminCookie },
    payload: { password: 'una-clave-nueva-larga' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, 'una-clave-nueva-larga'), 'principal');
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, b.password), 'incorrecta');
  assert.equal(await motorAcepta(b.email, 'una-clave-nueva-larga'), true);
});

/* ------------------------- Captura desde Stalwart 0.15 ---------------------- */

test('captura perezosa: sin copia local, la comprobación lee el hash de 0.15 y lo guarda', async () => {
  const b = await buzonNuevo();
  db.prepare('DELETE FROM credenciales_buzon WHERE mailbox_id = ?').run(b.mailboxId);
  motorFalso.principals.set(b.email, { type: 'individual', secrets: [sha512Crypt(b.password)], roles: ['user'] });
  const motor = new MotorStalwart(ajustes015);

  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, 'no-es-la-clave', motor), 'incorrecta');
  const fila = db.prepare('SELECT source FROM credenciales_buzon WHERE mailbox_id = ?').get(b.mailboxId) as
    | { source: string }
    | undefined;
  assert.equal(fila?.source, 'motor', 'aunque la contraseña no coincida, la copia queda guardada');

  motorFalso.received.length = 0;
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, b.password, motor), 'principal');
  assert.equal(motorFalso.received.length, 0, 'con la copia, el motor ya no se consulta');

  // Cambiada fuera del panel (el autoservicio de Stalwart 0.15): un fallo
  // con la copia vuelve a leer el motor y la refresca.
  motorFalso.principals.get(b.email)!.secrets = [sha512Crypt('cambiada-en-el-motor')];
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, 'cambiada-en-el-motor', motor), 'principal');
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, b.password, motor), 'incorrecta');
  // Nunca se le ha pedido al motor que autentique la contraseña de nadie.
  assert.ok(motorFalso.received.every((r) => r.authorization === `Basic ${Buffer.from(`admin:${SECRETO}`).toString('base64')}`));
});

test('captura perezosa: buzón que no está en el motor, sin hash $6$ o motor caído', async () => {
  const b = await buzonNuevo();
  db.prepare('DELETE FROM credenciales_buzon WHERE mailbox_id = ?').run(b.mailboxId);
  const motor = new MotorStalwart(ajustes015);
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, b.password, motor), 'incorrecta', 'no existe en el motor');

  motorFalso.principals.set(b.email, { type: 'individual', secrets: ['{PLAIN}otro-formato'], roles: ['user'] });
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, b.password, motor), 'sin_copia');

  const caido = new MotorStalwart({ ...ajustes015, url: 'http://127.0.0.1:9' });
  assert.equal(await comprobarContrasenaBuzon(b.mailboxId, b.password, caido), 'sin_respuesta');
});

test('portal: un buzón anterior a la copia entra con el motor 0.15 configurado y su copia queda guardada', async () => {
  const b = await buzonNuevo();
  db.prepare('DELETE FROM credenciales_buzon WHERE mailbox_id = ?').run(b.mailboxId);
  motorFalso.principals.set(b.email, { type: 'individual', secrets: [sha512Crypt(b.password)], roles: ['user'] });
  config.demoMode = false;
  setEngineSettings(ajustes015);
  try {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/portal/login',
      payload: { email: b.email, password: b.password },
      remoteAddress: '10.77.0.1',
    });
    assert.equal(res.statusCode, 200, res.body);
  } finally {
    config.demoMode = true;
  }
  assert.ok(leerHashBuzon(b.mailboxId)?.startsWith('$6$'));
});

test('captura en bloque: copia lo que falta, refresca lo distinto y lista lo que no se puede', async () => {
  // Parte de cero: solo cuentan los buzones de esta prueba.
  db.prepare('DELETE FROM credenciales_buzon').run();
  const a = await buzonNuevo();
  const b = await buzonNuevo();
  const c = await buzonNuevo();
  db.prepare('DELETE FROM credenciales_buzon WHERE mailbox_id IN (?, ?)').run(a.mailboxId, b.mailboxId);
  motorFalso.principals.clear();
  motorFalso.principals.set(a.email, { type: 'individual', secrets: [sha512Crypt(a.password)], roles: ['user'] });
  // c tiene copia, pero el motor tiene otra contraseña (cambiada fuera del panel).
  motorFalso.principals.set(c.email, { type: 'individual', secrets: [sha512Crypt('otra-de-c')], roles: [] });
  const motor = new MotorStalwart(ajustes015);

  const total = (db.prepare('SELECT COUNT(*) AS n FROM mailboxes').get() as { n: number }).n;
  const faltan = await capturarCredenciales({ engine: motor, soloFaltantes: true });
  assert.equal(faltan.capturados, 1, 'a');
  assert.ok(faltan.fallidos.includes(b.email), 'b no está en el motor');
  assert.equal(faltan.total, total);
  assert.equal(await comprobarContrasenaBuzon(a.mailboxId, a.password), 'principal');
  assert.equal(await comprobarContrasenaBuzon(c.mailboxId, c.password), 'principal', 'solo faltantes: c no se toca');

  const todas = await capturarCredenciales({ engine: motor });
  assert.ok(todas.capturados >= 1, 'c se refresca con lo del motor');
  assert.equal(await comprobarContrasenaBuzon(c.mailboxId, 'otra-de-c'), 'principal');
  assert.equal(recuentoCopias().sinHash, todas.fallidos.length);
  assert.ok(todas.fallidos.includes(b.email));
});
