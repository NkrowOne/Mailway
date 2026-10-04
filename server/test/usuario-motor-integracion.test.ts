import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { getEngine } from '../src/engine';
import { loginParaMotor } from '../src/modules/direcciones';
import { runWatchdogOnce } from '../src/modules/watchdog';
import { adminContext, createClient, createDomain, createMailbox, type TestContext } from './helpers';

/*
 * Usuario del motor fuera de los módulos de buzones: el borrado de un dominio,
 * el resumen de integraciones, el vigilante y el enlace de configuración. Un
 * buzón pendiente de actualizar dispositivos vive ya en el dominio nuevo pero
 * su principal se llama como la dirección anterior, así que toda llamada al
 * motor tiene que ir con ese nombre y no con la dirección.
 *
 * El estado «pasado» se fija a mano (motor y SQL), como lo deja «Pasar».
 */

let ctx: TestContext;
let clientId: string;

before(async () => {
  ctx = await adminContext();
  clientId = (await createClient(ctx)).clientId;
  const plan = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/clients/${clientId}`,
    headers: { cookie: ctx.adminCookie },
    payload: { planId: 'plan_agencia' },
  });
  assert.equal(plan.statusCode, 200, plan.body);
});

/** Buzón creado en `viejo` y llevado a `nuevo` como lo deja «Pasar». */
async function buzonPendiente(
  local: string,
  viejo: { domainId: string; domain: string },
  nuevo: { domainId: string; domain: string },
): Promise<{ mailboxId: string; login: string; email: string }> {
  const creado = await createMailbox(ctx, viejo.domainId, local);
  const login = `${local}@${viejo.domain}`;
  const email = `${local}@${nuevo.domain}`;
  await getEngine().createDomain(nuevo.domain);
  await getEngine().setAddresses(login, { add: [email], primary: email });
  db.prepare('UPDATE mailboxes SET domain_id = ?, usuario_motor = ? WHERE id = ?').run(
    nuevo.domainId,
    login,
    creado.mailboxId,
  );
  return { mailboxId: creado.mailboxId, login, email };
}

function destinosDe(aliasId: string): string[] {
  const fila = db.prepare('SELECT destinations_json FROM aliases WHERE id = ?').get(aliasId) as
    | { destinations_json: string }
    | undefined;
  return fila ? (JSON.parse(fila.destinations_json) as string[]) : [];
}

test('borrar dominios: los alias de otros dominios y el buzón pendiente van con su usuario del motor', async () => {
  const viejo = await createDomain(ctx, clientId, 'viejo-integ.test');
  const nuevo = await createDomain(ctx, clientId, 'nuevo-integ.test');
  const otro = await createDomain(ctx, clientId, 'alias-integ.test');
  const borrado = await createDomain(ctx, clientId, 'borrado-integ.test');
  const ana = await buzonPendiente('ana', viejo, nuevo);
  const luis = await createMailbox(ctx, borrado.domainId, 'luis');

  const alias = await ctx.app.inject({
    method: 'POST',
    url: '/api/aliases',
    headers: { cookie: ctx.adminCookie },
    payload: { domainId: otro.domainId, localPart: 'equipo', destinations: [ana.email, luis.email] },
  });
  assert.equal(alias.statusCode, 200, alias.body);
  const aliasId = (alias.json() as { alias: { id: string } }).alias.id;

  // Al borrar el dominio de luis, el alias se queda con ana. En el motor, sus
  // miembros van por nombre: con la dirección de ana (que en el motor es una
  // dirección de «ana@viejo», no un nombre) el motor no lo encontraría.
  const sinLuis = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/domains/${borrado.domainId}?confirm=${borrado.domain}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(sinLuis.statusCode, 200, sinLuis.body);
  assert.deepEqual(sinLuis.json().aliasesUpdated, ['equipo@alias-integ.test']);
  assert.deepEqual(destinosDe(aliasId), [ana.email]);

  // Al borrar el dominio de ana, su principal se borra por su usuario del
  // motor: con la dirección quedaría huérfano en el motor.
  assert.ok(await getEngine().getPrincipal(ana.login), 'el principal de ana existe antes de borrar');
  const sinAna = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/domains/${nuevo.domainId}?confirm=${nuevo.domain}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(sinAna.statusCode, 200, sinAna.body);
  assert.deepEqual(sinAna.json().aliasesDeleted, ['equipo@alias-integ.test']);
  assert.equal(await getEngine().getPrincipal(ana.login), null, 'el principal de ana ya no está en el motor');
  assert.equal(db.prepare('SELECT 1 FROM mailboxes WHERE id = ?').get(ana.mailboxId), undefined);
});

test('borrar un dominio con un cambio de usuario a medias deja ese buzón para el reintento', async () => {
  const dominio = await createDomain(ctx, clientId, 'marca-integ.test');
  const eva = await createMailbox(ctx, dominio.domainId, 'eva');
  db.prepare('UPDATE mailboxes SET usuario_cambiando_a = ? WHERE id = ?').run('eva@otra-integ.test', eva.mailboxId);

  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/domains/${dominio.domainId}?confirm=${dominio.domain}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(res.statusCode, 502, res.body);
  assert.equal(res.json().code, 'partial_delete');
  assert.ok(await getEngine().getPrincipal(eva.email), 'el principal no se toca mientras no se sepa su nombre');
  assert.ok(db.prepare('SELECT 1 FROM mailboxes WHERE id = ?').get(eva.mailboxId));

  db.prepare('UPDATE mailboxes SET usuario_cambiando_a = NULL WHERE id = ?').run(eva.mailboxId);
  const reintento = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/domains/${dominio.domainId}?confirm=${dominio.domain}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(reintento.statusCode, 200, reintento.body);
  assert.equal(await getEngine().getPrincipal(eva.email), null);
});

test('el resumen de integraciones da el usuario del motor de cada buzón', async () => {
  const viejo = await createDomain(ctx, clientId, 'viejo-resumen.test');
  const nuevo = await createDomain(ctx, clientId, 'nuevo-resumen.test');
  const pepa = await buzonPendiente('pepa', viejo, nuevo);
  const juan = await createMailbox(ctx, nuevo.domainId, 'juan');

  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/integrations/clients/${clientId}/summary`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  const buzones = (res.json() as { mailboxes: { id: string; email: string; login: string; loginPending: boolean }[] })
    .mailboxes;
  const dePepa = buzones.find((m) => m.id === pepa.mailboxId);
  assert.deepEqual(
    dePepa && { email: dePepa.email, login: dePepa.login, loginPending: dePepa.loginPending },
    { email: pepa.email, login: pepa.login, loginPending: true },
  );
  const deJuan = buzones.find((m) => m.id === juan.mailboxId);
  assert.deepEqual(deJuan && { login: deJuan.login, loginPending: deJuan.loginPending }, {
    login: juan.email,
    loginPending: false,
  });
});

test('el vigilante concilia un cambio de usuario que quedó a medias', async () => {
  const dominio = await createDomain(ctx, clientId, 'vigilante-integ.test');
  const rosa = await createMailbox(ctx, dominio.domainId, 'rosa');
  // El renombrado no llegó a aplicarse: el principal sigue con el nombre de
  // siempre y el destino no existe, así que la marca se limpia.
  db.prepare('UPDATE mailboxes SET usuario_cambiando_a = ? WHERE id = ?').run('rosa@otra-integ.test', rosa.mailboxId);
  assert.throws(() => loginParaMotor(rosa.mailboxId), { code: 'mailbox_login_updating' } as never);

  await runWatchdogOnce();

  assert.equal(loginParaMotor(rosa.mailboxId), rosa.email);
});

test('el enlace de configuración dice si una aplicación de Skyway usa el buzón', async () => {
  const dominio = await createDomain(ctx, clientId, 'enlace-integ.test');
  const tienda = await createMailbox(ctx, dominio.domainId, 'tienda');
  const enlace = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${tienda.mailboxId}/setup-links`,
    headers: { cookie: ctx.adminCookie },
    payload: {},
  });
  assert.equal(enlace.statusCode, 200, enlace.body);
  const token = /\/conectar\/([A-Za-z0-9_-]+)$/.exec((enlace.json() as { link: { url: string } }).link.url)?.[1];
  assert.ok(token);
  const abrir = () => ctx.app.inject({ method: 'GET', url: `/api/public/setup/${token}` });

  const antes = await abrir();
  assert.equal(antes.statusCode, 200, antes.body);
  assert.equal(antes.json().usadoPorApp, false);

  const app = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${tienda.mailboxId}/app-passwords`,
    headers: { cookie: ctx.adminCookie },
    payload: { name: 'skyway:tienda' },
  });
  assert.equal(app.statusCode, 200, app.body);

  const despues = await abrir();
  assert.equal(despues.statusCode, 200, despues.body);
  assert.equal(despues.json().usadoPorApp, true);
});
