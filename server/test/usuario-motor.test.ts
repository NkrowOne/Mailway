import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { HttpError } from '../src/core/errors';
import { getEngine } from '../src/engine';
import type { MailEngine } from '../src/engine/types';
import { alertaAbierta } from '../src/modules/alerts';
import {
  bloquesContrasenaAplicacion,
  getConnectionSettings,
  mobileconfigPlist,
  thunderbirdAndroidQrPayload,
  thunderbirdAutoconfigXml,
  autodiscoverXml,
} from '../src/modules/connection';
import {
  actualizarUsuario,
  appsSkywayDe,
  cambioAbiertoDeDominio,
  conciliarUsuariosEnCambio,
  datosWebmail,
  dominiosExentos,
  loginParaMotor,
  nombreEnMotor,
  resetConciliacionForTests,
  resolverBuzon,
} from '../src/modules/direcciones';
import { adminContext, createClient, createDomain, createMailbox, type TestContext } from './helpers';

/*
 * Usuario del motor (mailboxes.usuario_motor) durante un cambio de dominio:
 * toda llamada al motor que identifica un buzón usa su usuario, no su
 * dirección; las altas respetan el cambio abierto; el plan no cuenta el
 * dominio que se deja; y «Actualizar mis dispositivos» renombra el principal.
 *
 * El estado «pasado» se fija a mano (motor y SQL), como lo deja «Pasar»: el
 * buzón vive ya en el dominio nuevo, con las dos direcciones en el motor, y
 * sigue entrando con su usuario anterior.
 */

let ctx: TestContext;
let clientId: string;
let userCookie: string;
let viejo: { domainId: string; domain: string };
let nuevo: { domainId: string; domain: string };
let otro: { clientId: string; userCookie: string };

const motor = (): MailEngine => getEngine();

async function cambiarPlan(cliente: string, planId: string): Promise<{ statusCode: number; body: string }> {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/clients/${cliente}`,
    headers: { cookie: ctx.adminCookie },
    payload: { planId },
  });
}

before(async () => {
  ctx = await adminContext();
  const a = await createClient(ctx, { withUser: true });
  clientId = a.clientId;
  userCookie = a.userCookie!;
  assert.equal((await cambiarPlan(clientId, 'plan_agencia')).statusCode, 200);
  viejo = await createDomain(ctx, clientId, 'viejo-motor.test');
  nuevo = await createDomain(ctx, clientId, 'nuevo-motor.test');
  const b = await createClient(ctx, { withUser: true });
  otro = { clientId: b.clientId, userCookie: b.userCookie! };
});

interface Pendiente {
  mailboxId: string;
  /** Usuario del motor (la dirección anterior). */
  login: string;
  /** Dirección vigente. */
  email: string;
  password: string;
}

/** Buzón creado en el dominio viejo y llevado al nuevo como lo deja «Pasar». */
async function buzonPendiente(local: string): Promise<Pendiente> {
  const creado = await createMailbox(ctx, viejo.domainId, local);
  const login = `${local}@${viejo.domain}`;
  const email = `${local}@${nuevo.domain}`;
  await motor().createDomain(nuevo.domain);
  await motor().setAddresses(login, { add: [email], primary: email });
  db.prepare('UPDATE mailboxes SET domain_id = ?, usuario_motor = ?, semilla_perfil = ? WHERE id = ?').run(
    nuevo.domainId,
    login,
    login,
    creado.mailboxId,
  );
  return { mailboxId: creado.mailboxId, login, email, password: creado.password };
}

type Llamada = unknown[];

/** Registra las llamadas a un método del motor (sin cambiar lo que hace, salvo `antes`). */
function espiar(metodo: keyof MailEngine, antes?: (args: Llamada) => Promise<void> | void) {
  const engine = motor() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = engine[metodo as string]!;
  const llamadas: Llamada[] = [];
  engine[metodo as string] = async (...args: unknown[]) => {
    llamadas.push(args);
    if (antes) await antes(args);
    return original.apply(engine, args);
  };
  return {
    llamadas,
    restaurar: () => {
      delete engine[metodo as string];
    },
  };
}

function fila(mailboxId: string) {
  return db
    .prepare('SELECT usuario_motor, usuario_cambiando_a, login_anterior FROM mailboxes WHERE id = ?')
    .get(mailboxId) as { usuario_motor: string | null; usuario_cambiando_a: string | null; login_anterior: string | null };
}

let cambioSeq = 0;
/** Cambio de dominio abierto escrito directamente en la base (lo crea la orquestación). */
function crearCambio(input: {
  cliente: string;
  desde: { domainId: string; domain: string };
  hacia: { domainId: string | null; domain: string };
  estado?: string;
  direccionesAt?: number | null;
  buzones?: { id: string; local: string }[];
}): string {
  const id = `dmg_prueba_${++cambioSeq}`;
  const t = Date.now();
  db.prepare(
    `INSERT INTO domain_migrations (id, client_id, from_domain_id, to_domain_id, from_domain, to_domain,
       estado, direcciones_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.cliente,
    input.desde.domainId,
    input.hacia.domainId,
    input.desde.domain,
    input.hacia.domain,
    input.estado ?? 'preparando',
    input.direccionesAt ?? null,
    t,
    t,
  );
  for (const b of input.buzones ?? []) {
    db.prepare(
      `INSERT INTO domain_migration_items (migration_id, tipo, item_id, local_part) VALUES (?, 'buzon', ?, ?)`,
    ).run(id, b.id, b.local);
  }
  return id;
}

/* ------------------------- Llamadas al motor por login ------------------------ */

test('la contraseña, la suspensión del buzón y la del cliente van al usuario del motor', async () => {
  const ana = await buzonPendiente('ana');

  const listado = await ctx.app.inject({
    method: 'GET',
    url: `/api/mailboxes?domainId=${nuevo.domainId}`,
    headers: { cookie: ctx.adminCookie },
  });
  const visto = (listado.json() as { mailboxes: { id: string; email: string; login: string; loginPending: boolean }[] })
    .mailboxes.find((m) => m.id === ana.mailboxId)!;
  assert.equal(visto.email, ana.email);
  assert.equal(visto.login, ana.login);
  assert.equal(visto.loginPending, true);

  const clave = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${ana.mailboxId}/password`,
    headers: { cookie: userCookie },
    payload: { password: 'otra-clave-muy-segura' },
  });
  assert.equal(clave.statusCode, 200, clave.body);
  assert.equal(await motor().verifyCredentials(ana.login, 'otra-clave-muy-segura'), true);

  const suspender = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/mailboxes/${ana.mailboxId}`,
    headers: { cookie: userCookie },
    payload: { status: 'suspended' },
  });
  assert.equal(suspender.statusCode, 200, suspender.body);
  assert.equal(await motor().verifyCredentials(ana.login, 'otra-clave-muy-segura'), false);
  const reactivar = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/mailboxes/${ana.mailboxId}`,
    headers: { cookie: userCookie },
    payload: { status: 'active' },
  });
  assert.equal(reactivar.statusCode, 200, reactivar.body);
  assert.equal(await motor().verifyCredentials(ana.login, 'otra-clave-muy-segura'), true);

  const espia = espiar('updateMailbox');
  try {
    const cliente = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/clients/${clientId}`,
      headers: { cookie: ctx.adminCookie },
      payload: { suspended: true },
    });
    assert.equal(cliente.statusCode, 200, cliente.body);
    assert.deepEqual((cliente.json() as { suspension: { failed: unknown[] } }).suspension.failed, []);
    assert.equal(await motor().verifyCredentials(ana.login, 'otra-clave-muy-segura'), false);
    const reanudar = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/clients/${clientId}`,
      headers: { cookie: ctx.adminCookie },
      payload: { suspended: false },
    });
    assert.equal(reanudar.statusCode, 200, reanudar.body);
  } finally {
    espia.restaurar();
  }
  const nombres = espia.llamadas.map((l) => l[0]);
  assert.ok(nombres.includes(ana.login), 'la suspensión del cliente usa el usuario del motor');
  assert.ok(!nombres.includes(ana.email));
  assert.equal(await motor().verifyCredentials(ana.login, 'otra-clave-muy-segura'), true);

  // Su usuario anterior sigue siendo suyo en el motor: nadie puede crear un
  // buzón con ese nombre.
  const choque = await ctx.app.inject({
    method: 'POST',
    url: '/api/mailboxes',
    headers: { cookie: ctx.adminCookie },
    payload: { domainId: viejo.domainId, localPart: 'ana' },
  });
  assert.equal(choque.statusCode, 409, choque.body);
  assert.equal(choque.json().code, 'mailbox_exists');
});

test('contraseñas de aplicación, claves de API y formularios usan el usuario del motor', async () => {
  const bea = await buzonPendiente('bea');

  const app = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${bea.mailboxId}/app-passwords`,
    headers: { cookie: userCookie },
    payload: { name: 'Móvil' },
  });
  assert.equal(app.statusCode, 200, app.body);
  const creada = app.json() as {
    password: string;
    appPassword: { id: string };
    snippets: { id: string; content: string }[];
  };
  assert.equal(await motor().verifyCredentials(bea.login, creada.password), true);
  const env = creada.snippets.find((b) => b.id === 'env')!.content.split('\n');
  assert.ok(env.includes(`SMTP_USER=${bea.login}`), 'SMTP_USER es el usuario del motor');
  assert.ok(env.includes(`SMTP_FROM=${bea.email}`), 'el remitente es la dirección vigente');
  const laravel = creada.snippets.find((b) => b.id === 'laravel')!.content.split('\n');
  assert.ok(laravel.includes(`MAIL_USERNAME=${bea.login}`));
  assert.ok(laravel.includes(`MAIL_FROM_ADDRESS=${bea.email}`));

  const revocar = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/mailboxes/${bea.mailboxId}/app-passwords/${creada.appPassword.id}`,
    headers: { cookie: userCookie },
  });
  assert.equal(revocar.statusCode, 200, revocar.body);
  assert.equal(await motor().verifyCredentials(bea.login, creada.password), false);

  const altas = espiar('addAppPassword');
  const bajas = espiar('removeAppPassword');
  try {
    const clave = await ctx.app.inject({
      method: 'POST',
      url: '/api/apikeys',
      headers: { cookie: ctx.adminCookie },
      payload: { clientId, name: 'Tienda', senderMailboxId: bea.mailboxId },
    });
    assert.equal(clave.statusCode, 200, clave.body);
    const claveId = (clave.json() as { info: { id: string; senderEmail: string } }).info.id;
    assert.equal((clave.json() as { info: { senderEmail: string } }).info.senderEmail, bea.email);
    const revocada = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/apikeys/${claveId}`,
      headers: { cookie: ctx.adminCookie },
    });
    assert.equal(revocada.statusCode, 200, revocada.body);

    const form = await ctx.app.inject({
      method: 'POST',
      url: '/api/forms',
      headers: { cookie: ctx.adminCookie },
      payload: { clientId, name: 'Contacto', recipientMailboxId: bea.mailboxId, allowedOrigins: ['https://www.nuevo-motor.test'] },
    });
    assert.equal(form.statusCode, 200, form.body);
    const formId = (form.json() as { form: { id: string } }).form.id;
    const borrado = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/forms/${formId}`,
      headers: { cookie: ctx.adminCookie },
    });
    assert.equal(borrado.statusCode, 200, borrado.body);
  } finally {
    altas.restaurar();
    bajas.restaurar();
  }
  assert.deepEqual(altas.llamadas.map((l) => l[0]), [bea.login, bea.login]);
  assert.deepEqual(bajas.llamadas.map((l) => l[0]), [bea.login, bea.login]);
});

test('con un cambio de usuario a medias no se revoca una clave ni se borra un formulario', async () => {
  const caro = await buzonPendiente('caro');
  const clave = await ctx.app.inject({
    method: 'POST',
    url: '/api/apikeys',
    headers: { cookie: ctx.adminCookie },
    payload: { clientId, name: 'Web', senderMailboxId: caro.mailboxId },
  });
  assert.equal(clave.statusCode, 200, clave.body);
  const claveId = (clave.json() as { info: { id: string } }).info.id;
  const form = await ctx.app.inject({
    method: 'POST',
    url: '/api/forms',
    headers: { cookie: ctx.adminCookie },
    payload: { clientId, name: 'Presupuesto', recipientMailboxId: caro.mailboxId, allowedOrigins: ['https://www.nuevo-motor.test'] },
  });
  assert.equal(form.statusCode, 200, form.body);
  const formId = (form.json() as { form: { id: string } }).form.id;

  const bajas = espiar('removeAppPassword');
  db.prepare('UPDATE mailboxes SET usuario_cambiando_a = ? WHERE id = ?').run(caro.email, caro.mailboxId);
  try {
    const revocar = await ctx.app.inject({ method: 'DELETE', url: `/api/apikeys/${claveId}`, headers: { cookie: ctx.adminCookie } });
    assert.equal(revocar.statusCode, 409, revocar.body);
    assert.equal(revocar.json().code, 'mailbox_login_updating');
    const borrar = await ctx.app.inject({ method: 'DELETE', url: `/api/forms/${formId}`, headers: { cookie: ctx.adminCookie } });
    assert.equal(borrar.statusCode, 409, borrar.body);
    assert.equal(borrar.json().code, 'mailbox_login_updating');
    // Nada se ha tocado: la clave y el formulario siguen y se puede reintentar.
    const fila = db.prepare('SELECT revoked_at FROM api_keys WHERE id = ?').get(claveId) as { revoked_at: number | null };
    assert.equal(fila.revoked_at, null);
    assert.ok(db.prepare('SELECT 1 FROM forms WHERE id = ?').get(formId));
    assert.equal(bajas.llamadas.length, 0);
  } finally {
    db.prepare('UPDATE mailboxes SET usuario_cambiando_a = NULL WHERE id = ?').run(caro.mailboxId);
  }
  try {
    const revocar = await ctx.app.inject({ method: 'DELETE', url: `/api/apikeys/${claveId}`, headers: { cookie: ctx.adminCookie } });
    assert.equal(revocar.statusCode, 200, revocar.body);
    const borrar = await ctx.app.inject({ method: 'DELETE', url: `/api/forms/${formId}`, headers: { cookie: ctx.adminCookie } });
    assert.equal(borrar.statusCode, 200, borrar.body);
  } finally {
    bajas.restaurar();
  }
  assert.deepEqual(bajas.llamadas.map((l) => l[0]), [caro.login, caro.login], 'las credenciales se retiran del motor');
});

test('un alias con un destino pendiente envía como miembro el usuario del motor, también al borrar', async () => {
  const luis = await buzonPendiente('luis');
  const marta = await buzonPendiente('marta');
  const espia = espiar('upsertAlias');
  const borrados = espiar('deleteMailbox');
  try {
    const alta = await ctx.app.inject({
      method: 'POST',
      url: '/api/aliases',
      headers: { cookie: userCookie },
      payload: { domainId: nuevo.domainId, localPart: 'equipo', destinations: [luis.email, marta.email] },
    });
    assert.equal(alta.statusCode, 200, alta.body);
    const aliasId = (alta.json() as { id: string }).id;
    assert.deepEqual(espia.llamadas.at(-1), [`equipo@${nuevo.domain}`, [luis.login, marta.login], []]);

    const cambio = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/aliases/${aliasId}`,
      headers: { cookie: userCookie },
      payload: { destinations: [luis.email, marta.email, 'fuera@ejemplo.org'] },
    });
    assert.equal(cambio.statusCode, 200, cambio.body);
    assert.deepEqual(espia.llamadas.at(-1), [
      `equipo@${nuevo.domain}`,
      [luis.login, marta.login],
      ['fuera@ejemplo.org'],
    ]);

    const baja = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/mailboxes/${marta.mailboxId}`,
      headers: { cookie: userCookie },
    });
    assert.equal(baja.statusCode, 200, baja.body);
    assert.deepEqual(espia.llamadas.at(-1), [`equipo@${nuevo.domain}`, [luis.login], ['fuera@ejemplo.org']]);
    assert.deepEqual(borrados.llamadas.at(-1), [marta.login]);
    assert.equal(await motor().getPrincipal(marta.login), null, 'el principal del buzón se borra por su usuario');
  } finally {
    espia.restaurar();
    borrados.restaurar();
  }
});

test('al borrar un buzón, el alias se guarda sobre su lista vigente, no sobre la leída al principio', async () => {
  const c = await createClient(ctx);
  assert.equal((await cambiarPlan(c.clientId, 'plan_agencia')).statusCode, 200);
  const d = await createDomain(ctx, c.clientId, 'releer-alias.test');
  await createMailbox(ctx, d.domainId, 'eva');
  const del = await createMailbox(ctx, d.domainId, 'del');
  const alta = await ctx.app.inject({
    method: 'POST',
    url: '/api/aliases',
    headers: { cookie: ctx.adminCookie },
    payload: { domainId: d.domainId, localPart: 'todos', destinations: ['eva@releer-alias.test', 'del@releer-alias.test'] },
  });
  assert.equal(alta.statusCode, 200, alta.body);
  const aliasId = (alta.json() as { id: string }).id;

  // Mientras el borrado espera al motor, «Pasar» (de este u otro cliente)
  // reescribe los destinos de los alias de toda la instancia.
  const espia = espiar('upsertAlias', (args) => {
    if (args[0] !== 'todos@releer-alias.test') return;
    db.prepare('UPDATE aliases SET destinations_json = ? WHERE id = ?').run(
      JSON.stringify(['eva@releer-alias-nuevo.test', 'del@releer-alias.test']),
      aliasId,
    );
  });
  try {
    const baja = await ctx.app.inject({ method: 'DELETE', url: `/api/mailboxes/${del.mailboxId}`, headers: { cookie: ctx.adminCookie } });
    assert.equal(baja.statusCode, 200, baja.body);
    assert.deepEqual((baja.json() as { aliasesUpdated: string[] }).aliasesUpdated, ['todos@releer-alias.test']);
  } finally {
    espia.restaurar();
  }
  const fila = db.prepare('SELECT destinations_json FROM aliases WHERE id = ?').get(aliasId) as { destinations_json: string };
  assert.deepEqual(JSON.parse(fila.destinations_json), ['eva@releer-alias-nuevo.test']);
});

/* --------------------------------- Altas ------------------------------------ */

test('el origen y el destino de un cambio abierto no admiten altas, tampoco en lote', async () => {
  const c = await createClient(ctx);
  assert.equal((await cambiarPlan(c.clientId, 'plan_agencia')).statusCode, 200);
  const origen = await createDomain(ctx, c.clientId, 'origen-altas.test');
  const destino = await createDomain(ctx, c.clientId, 'destino-altas.test');
  const cambioId = crearCambio({ cliente: c.clientId, desde: origen, hacia: destino });

  const alta = (domainId: string, localPart: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/mailboxes',
      headers: { cookie: ctx.adminCookie },
      payload: { domainId, localPart },
    });
  const alias = (domainId: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/aliases',
      headers: { cookie: ctx.adminCookie },
      payload: { domainId, localPart: 'ventas', destinations: ['alguien@ejemplo.org'] },
    });

  const enOrigen = await alta(origen.domainId, 'nuevo');
  assert.equal(enOrigen.statusCode, 409, enOrigen.body);
  assert.equal(enOrigen.json().code, 'domain_migrating');
  assert.match(enOrigen.json().error, /origen-altas\.test está en un cambio de dominio: crea los buzones y alias en destino-altas\.test/);

  const enDestino = await alta(destino.domainId, 'nuevo');
  assert.equal(enDestino.statusCode, 409, enDestino.body);
  assert.equal(enDestino.json().code, 'domain_migrating');
  assert.match(enDestino.json().error, /destino-altas\.test se está preparando para sustituir a origen-altas\.test/);

  for (const domainId of [origen.domainId, destino.domainId]) {
    const res = await alias(domainId);
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().code, 'domain_migrating');
  }

  const revision = await ctx.app.inject({
    method: 'POST',
    url: '/api/mailboxes/bulk',
    headers: { cookie: ctx.adminCookie },
    payload: { domainId: origen.domainId, entries: [{ localPart: 'uno' }, { localPart: 'dos' }], dryRun: true },
  });
  assert.equal(revision.statusCode, 200, revision.body);
  const lineas = (revision.json() as { results: { ok: boolean; error?: string }[] }).results;
  assert.ok(lineas.every((l) => !l.ok && l.error === 'origen-altas.test está en un cambio de dominio.'));
  const lote = await ctx.app.inject({
    method: 'POST',
    url: '/api/mailboxes/bulk',
    headers: { cookie: ctx.adminCookie },
    payload: { domainId: origen.domainId, entries: [{ localPart: 'uno' }] },
  });
  assert.equal(lote.statusCode, 409, lote.body);
  assert.equal(lote.json().code, 'domain_migrating');

  // Tras pasar, las altas se hacen en el destino; el origen sigue cerrado.
  db.prepare("UPDATE domain_migrations SET estado = 'pasado' WHERE id = ?").run(cambioId);
  assert.equal((await alta(destino.domainId, 'nuevo')).statusCode, 200);
  assert.equal((await alta(origen.domainId, 'nuevo')).statusCode, 409);

  // Un cambio cancelado ya no bloquea nada.
  db.prepare("UPDATE domain_migrations SET estado = 'cancelada' WHERE id = ?").run(cambioId);
  assert.equal((await alta(origen.domainId, 'nuevo')).statusCode, 200);
});

test('plan Básico con un cambio abierto: el destino cabe y un tercer dominio no', async () => {
  const c = await createClient(ctx);
  const actual = await createDomain(ctx, c.clientId, 'plan-actual.test');
  const altaDominio = (domain: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/domains',
      headers: { cookie: ctx.adminCookie },
      payload: { domain, clientId: c.clientId },
    });

  const sinCambio = await altaDominio('plan-nuevo.test');
  assert.equal(sinCambio.statusCode, 400, sinCambio.body);
  assert.equal(sinCambio.json().code, 'plan_limit_reached');

  const cambioId = crearCambio({ cliente: c.clientId, desde: actual, hacia: { domainId: null, domain: 'plan-nuevo.test' } });
  assert.deepEqual(dominiosExentos(c.clientId), [actual.domainId]);
  const destino = await altaDominio('plan-nuevo.test');
  assert.equal(destino.statusCode, 200, destino.body);
  const destinoId = (destino.json() as { domain: { id: string } }).domain.id;
  db.prepare('UPDATE domain_migrations SET to_domain_id = ? WHERE id = ?').run(destinoId, cambioId);

  const tercero = await altaDominio('plan-tercero.test');
  assert.equal(tercero.statusCode, 400, tercero.body);
  assert.equal(tercero.json().code, 'plan_limit_reached');

  // planExcess tampoco cuenta el origen: el cliente cabe en el Básico.
  assert.equal((await cambiarPlan(c.clientId, 'plan_negocio')).statusCode, 200);
  assert.equal((await cambiarPlan(c.clientId, 'plan_basico')).statusCode, 200);

  // Con el cambio cancelado, los dos dominios cuentan.
  db.prepare("UPDATE domain_migrations SET estado = 'cancelada' WHERE id = ?").run(cambioId);
  assert.deepEqual(dominiosExentos(c.clientId), []);
  assert.equal((await cambiarPlan(c.clientId, 'plan_negocio')).statusCode, 200);
  const bajar = await cambiarPlan(c.clientId, 'plan_basico');
  assert.equal(bajar.statusCode, 409, bajar.body);
  assert.equal(bajar.json().code, 'plan_below_usage');
});

/* -------------------------- Actualizar el usuario --------------------------- */

test('actualizarUsuario renombra el principal, conserva las contraseñas y es idempotente', async () => {
  const pedro = await buzonPendiente('pedro');
  const app = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${pedro.mailboxId}/app-passwords`,
    headers: { cookie: userCookie },
    payload: { name: 'Portátil' },
  });
  const deAplicacion = (app.json() as { password: string }).password;
  const antes = await motor().getPrincipal(pedro.login);
  assert.ok(antes);

  assert.deepEqual(await actualizarUsuario(pedro.mailboxId), { de: pedro.login, a: pedro.email });
  const despues = await motor().getPrincipal(pedro.email);
  assert.equal(despues?.id, antes.id, 'mismo principal: el correo se conserva');
  assert.equal(await motor().getPrincipal(pedro.login), null);
  assert.deepEqual(fila(pedro.mailboxId), { usuario_motor: null, usuario_cambiando_a: null, login_anterior: pedro.login });
  assert.equal(await motor().verifyCredentials(pedro.email, pedro.password), true);
  assert.equal(await motor().verifyCredentials(pedro.email, deAplicacion), true);
  assert.equal(loginParaMotor(pedro.mailboxId), pedro.email);

  assert.equal(await actualizarUsuario(pedro.mailboxId), null, 'repetirlo no hace nada');
  assert.deepEqual(datosWebmail(pedro.mailboxId), {
    login: pedro.email,
    email: pedro.email,
    anteriores: [pedro.login],
    otrasDirecciones: [],
  });
});

test('un cambio de usuario a medias: 409 mientras tanto y el conciliador lo deshace o lo termina', async () => {
  // Deshacer: la marca está, pero el motor no llegó a renombrar.
  const rosa = await buzonPendiente('rosa');
  db.prepare('UPDATE mailboxes SET usuario_cambiando_a = ? WHERE id = ?').run(rosa.email, rosa.mailboxId);
  const bloqueado = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${rosa.mailboxId}/password`,
    headers: { cookie: userCookie },
    payload: { password: 'clave-mientras-tanto' },
  });
  assert.equal(bloqueado.statusCode, 409, bloqueado.body);
  assert.equal(bloqueado.json().code, 'mailbox_login_updating');
  const actualizar = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${rosa.mailboxId}/login-update`,
    headers: { cookie: userCookie },
    payload: {},
  });
  assert.equal(actualizar.statusCode, 409, actualizar.body);
  assert.equal(actualizar.json().code, 'mailbox_login_updating');

  // Terminar: el motor ya renombró y el panel se cayó antes de anotarlo.
  const sara = await buzonPendiente('sara');
  await motor().renamePrincipal(sara.login, sara.email, { expectEmail: sara.email });
  db.prepare('UPDATE mailboxes SET usuario_cambiando_a = ? WHERE id = ?').run(sara.email, sara.mailboxId);

  // Indeterminado: no existe ninguno de los dos nombres.
  const tere = await buzonPendiente('tere');
  db.prepare('UPDATE mailboxes SET usuario_cambiando_a = ? WHERE id = ?').run(tere.email, tere.mailboxId);
  await motor().deleteMailbox(tere.login);

  // Indeterminado: el nombre nuevo existe, pero sin la dirección vigente.
  const uri = await buzonPendiente('uri');
  db.prepare('UPDATE mailboxes SET usuario_cambiando_a = ? WHERE id = ?').run(uri.email, uri.mailboxId);
  await motor().deleteMailbox(uri.login);
  await motor().createMailbox({ email: uri.email, password: uri.password });
  await motor().setAddresses(uri.email, { remove: [uri.email], add: [`otra-uri@${nuevo.domain}`] });

  const resultado = await conciliarUsuariosEnCambio();
  assert.deepEqual(resultado, { resueltos: 2, pendientes: 2 });
  assert.deepEqual(fila(rosa.mailboxId), { usuario_motor: rosa.login, usuario_cambiando_a: null, login_anterior: null });
  assert.deepEqual(fila(sara.mailboxId), { usuario_motor: null, usuario_cambiando_a: null, login_anterior: sara.login });
  assert.deepEqual(fila(tere.mailboxId), { usuario_motor: tere.login, usuario_cambiando_a: tere.email, login_anterior: null });
  assert.deepEqual(fila(uri.mailboxId), { usuario_motor: uri.login, usuario_cambiando_a: uri.email, login_anterior: null });
  assert.equal(alertaAbierta(`buzon_usuario:${tere.mailboxId}`), true);
  assert.throws(() => loginParaMotor(tere.mailboxId), { code: 'mailbox_login_updating' });
  const aviso = (id: string) =>
    db.prepare('SELECT message FROM alerts WHERE dedupe_key = ? AND resolved_at IS NULL').get(`buzon_usuario:${id}`) as {
      message: string;
    };
  assert.match(aviso(tere.mailboxId).message, /no existe ninguno de los dos usuarios/);
  assert.match(aviso(uri.mailboxId).message, new RegExp(`el usuario ${uri.email} existe, pero no tiene la dirección ${uri.email}`));

  // Cuando vuelve a existir uno solo, la siguiente vuelta lo resuelve y cierra el aviso.
  await motor().createMailbox({ email: tere.login, password: tere.password });
  await motor().setAddresses(uri.email, { add: [uri.email] });
  assert.deepEqual(await conciliarUsuariosEnCambio(), { resueltos: 2, pendientes: 0 });
  assert.equal(fila(tere.mailboxId).usuario_cambiando_a, null);
  assert.equal(alertaAbierta(`buzon_usuario:${tere.mailboxId}`), false);
  assert.deepEqual(fila(uri.mailboxId), { usuario_motor: null, usuario_cambiando_a: null, login_anterior: uri.login });
  assert.equal(alertaAbierta(`buzon_usuario:${uri.mailboxId}`), false);
  assert.deepEqual(await conciliarUsuariosEnCambio(), { resueltos: 0, pendientes: 0 });
});

test('un fallo sin respuesta del motor deja la marca, y el conciliador espera un margen antes de mirar', async () => {
  // Aplicado tarde: el motor renombra después del corte por tiempo.
  const ivan = await buzonPendiente('ivan');
  // No aplicado: el PATCH no llegó al motor.
  const julia = await buzonPendiente('julia');
  const engine = motor() as unknown as Record<string, unknown>;
  engine.renamePrincipal = async () => {
    throw new HttpError(502, 'No se pudo conectar con el motor de correo.', 'engine_unreachable');
  };
  try {
    for (const b of [ivan, julia]) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/mailboxes/${b.mailboxId}/login-update`,
        headers: { cookie: userCookie },
        payload: {},
      });
      assert.equal(res.statusCode, 502, res.body);
      assert.equal(res.json().code, 'engine_unreachable');
      assert.deepEqual(fila(b.mailboxId), { usuario_motor: b.login, usuario_cambiando_a: b.email, login_anterior: null });
      assert.throws(() => loginParaMotor(b.mailboxId), { code: 'mailbox_login_updating' });
    }
  } finally {
    delete engine.renamePrincipal;
  }
  await motor().renamePrincipal(ivan.login, ivan.email, { expectEmail: ivan.email });

  // Justo después del fallo no se mira el motor: el renombrado aún podría llegar.
  assert.deepEqual(await conciliarUsuariosEnCambio(), { resueltos: 0, pendientes: 2 });
  assert.equal(fila(ivan.mailboxId).usuario_cambiando_a, ivan.email);
  assert.equal(fila(julia.mailboxId).usuario_cambiando_a, julia.email);
  assert.equal(alertaAbierta(`buzon_usuario:${ivan.mailboxId}`), false);

  // Pasado el margen, se resuelve cada uno según lo que haya en el motor.
  resetConciliacionForTests();
  assert.deepEqual(await conciliarUsuariosEnCambio(), { resueltos: 2, pendientes: 0 });
  assert.deepEqual(fila(ivan.mailboxId), { usuario_motor: null, usuario_cambiando_a: null, login_anterior: ivan.login });
  assert.deepEqual(fila(julia.mailboxId), { usuario_motor: julia.login, usuario_cambiando_a: null, login_anterior: null });
  const anotacion = db
    .prepare("SELECT detail FROM audit_log WHERE action = 'mailbox.login_updated' AND detail LIKE ?")
    .get(`%${ivan.mailboxId}%`) as { detail: string } | undefined;
  assert.equal((JSON.parse(anotacion!.detail) as { por: string }).por, 'conciliador');
});

test('borrar un buzón mientras se actualiza su usuario espera a que termine', async () => {
  const nora = await buzonPendiente('nora');
  let entrar!: () => void;
  const dentro = new Promise<void>((resolve) => {
    entrar = resolve;
  });
  let soltar!: () => void;
  const suelto = new Promise<void>((resolve) => {
    soltar = resolve;
  });
  const renombrar = espiar('renamePrincipal', async () => {
    entrar();
    await suelto;
  });
  const borrados = espiar('deleteMailbox');
  try {
    const actualizando = ctx.app.inject({
      method: 'POST',
      url: `/api/mailboxes/${nora.mailboxId}/login-update`,
      headers: { cookie: userCookie },
      payload: {},
    });
    await dentro;
    let borrado = false;
    const borrando = ctx.app
      .inject({ method: 'DELETE', url: `/api/mailboxes/${nora.mailboxId}`, headers: { cookie: userCookie } })
      .then((res) => {
        borrado = true;
        return res;
      });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(borrado, false, 'el borrado espera al cerrojo del buzón');
    soltar();
    const [a, b] = await Promise.all([actualizando, borrando]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
  } finally {
    renombrar.restaurar();
    borrados.restaurar();
  }
  assert.deepEqual(borrados.llamadas, [[nora.email]], 'se borra con el usuario ya actualizado');
  assert.equal(await motor().getPrincipal(nora.email), null);
  assert.equal(await motor().getPrincipal(nora.login), null);
});

test('POST /api/mailboxes/:id/login-update: acceso, aplicaciones de Skyway y token de gestión', async () => {
  const olga = await buzonPendiente('olga');

  const ajeno = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${olga.mailboxId}/login-update`,
    headers: { cookie: otro.userCookie },
    payload: {},
  });
  assert.equal(ajeno.statusCode, 403, ajeno.body);

  const token = await ctx.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: { cookie: ctx.adminCookie },
    payload: { name: 'Skyway' },
  });
  assert.equal(token.statusCode, 200, token.body);
  const bearer = { authorization: `Bearer ${(token.json() as { token: string }).token}` };

  // El prefijo «skyway:» es de Skyway: desde la sesión del panel no se usa.
  const aMano = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${olga.mailboxId}/app-passwords`,
    headers: { cookie: ctx.adminCookie },
    payload: { name: 'Skyway:tienda' },
  });
  assert.equal(aMano.statusCode, 400, aMano.body);
  assert.equal(aMano.json().code, 'app_password_name_reserved');
  assert.deepEqual(appsSkywayDe(olga.mailboxId), []);

  const app = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${olga.mailboxId}/app-passwords`,
    headers: bearer,
    payload: { name: 'skyway:tienda' },
  });
  assert.equal(app.statusCode, 200, app.body);
  assert.deepEqual(appsSkywayDe(olga.mailboxId), ['skyway:tienda']);

  const conSesion = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${olga.mailboxId}/login-update`,
    headers: { cookie: ctx.adminCookie },
    payload: {},
  });
  assert.equal(conSesion.statusCode, 409, conSesion.body);
  assert.equal(conSesion.json().code, 'mailbox_used_by_app');
  assert.match(conSesion.json().error, /\(tienda\)/);
  assert.equal(fila(olga.mailboxId).usuario_motor, olga.login, 'no se ha tocado nada');

  // Un token que se crea un usuario del cliente no es el de Skyway: tampoco.
  const tokenCliente = await ctx.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: { cookie: userCookie },
    payload: { name: 'Mi script' },
  });
  assert.equal(tokenCliente.statusCode, 200, tokenCliente.body);
  const conTokenCliente = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${olga.mailboxId}/login-update`,
    headers: { authorization: `Bearer ${(tokenCliente.json() as { token: string }).token}` },
    payload: {},
  });
  assert.equal(conTokenCliente.statusCode, 409, conTokenCliente.body);
  assert.equal(conTokenCliente.json().code, 'mailbox_used_by_app');
  assert.equal(fila(olga.mailboxId).usuario_motor, olga.login, 'no se ha tocado nada');

  const conToken = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${olga.mailboxId}/login-update`,
    headers: bearer,
    payload: {},
  });
  assert.equal(conToken.statusCode, 200, conToken.body);
  const mailbox = (conToken.json() as { mailbox: { login: string; loginPending: boolean; email: string } }).mailbox;
  assert.deepEqual(
    { login: mailbox.login, loginPending: mailbox.loginPending, email: mailbox.email },
    { login: olga.email, loginPending: false, email: olga.email },
  );
  const otraVez = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${olga.mailboxId}/login-update`,
    headers: bearer,
    payload: {},
  });
  assert.equal(otraVez.statusCode, 200, 'idempotente');

  const pablo = await buzonPendiente('pablo');
  const desdeElPanel = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${pablo.mailboxId}/login-update`,
    headers: { cookie: userCookie },
    payload: {},
  });
  assert.equal(desdeElPanel.statusCode, 200, desdeElPanel.body);

  const anotaciones = (
    db.prepare("SELECT detail, client_id FROM audit_log WHERE action = 'mailbox.login_updated'").all() as {
      detail: string;
      client_id: string;
    }[]
  ).map((a) => ({ ...(JSON.parse(a.detail) as Record<string, unknown>), clientId: a.client_id }));
  const deOlga = anotaciones.filter((a) => a.id === olga.mailboxId);
  assert.equal(deOlga.length, 1, 'la repetición no se anota');
  assert.equal(deOlga[0]!.por, 'integracion');
  assert.equal(deOlga[0]!.de, olga.login);
  assert.equal(deOlga[0]!.a, olga.email);
  assert.equal(deOlga[0]!.clientId, clientId);
  assert.equal(anotaciones.find((a) => a.id === pablo.mailboxId)?.por, 'panel');
});

/* --------------------- Resolución de direcciones y webmail -------------------- */

test('resolverBuzon, nombreEnMotor y datosWebmail a lo largo de un cambio', async () => {
  const c = await createClient(ctx);
  assert.equal((await cambiarPlan(c.clientId, 'plan_agencia')).statusCode, 200);
  const r1 = await createDomain(ctx, c.clientId, 'resolver-viejo.test');
  const r2 = await createDomain(ctx, c.clientId, 'resolver-nuevo.test');
  const vera = await createMailbox(ctx, r1.domainId, 'vera');
  const cambioId = crearCambio({
    cliente: c.clientId,
    desde: r1,
    hacia: r2,
    buzones: [{ id: vera.mailboxId, local: 'vera' }],
  });
  assert.equal(cambioAbiertoDeDominio(r1.domainId)?.rol, 'origen');
  assert.equal(cambioAbiertoDeDominio(r2.domainId)?.rol, 'destino');

  const de = (entrada: string) => resolverBuzon(entrada)?.mailboxId ?? null;
  assert.equal(de('vera@resolver-viejo.test'), vera.mailboxId);
  assert.deepEqual(resolverBuzon('vera@resolver-viejo.test'), { mailboxId: vera.mailboxId, clientId: c.clientId });
  assert.equal(de('vera@resolver-nuevo.test'), null, 'sin pre-recepción, la dirección nueva aún no es suya');
  db.prepare('UPDATE domain_migrations SET direcciones_at = ? WHERE id = ?').run(Date.now(), cambioId);
  assert.equal(de('  VERA@Resolver-Nuevo.test '), vera.mailboxId);
  assert.equal(de('nadie@resolver-nuevo.test'), null);
  assert.equal(de('sin-arroba'), null);
  assert.deepEqual(datosWebmail(vera.mailboxId), {
    login: 'vera@resolver-viejo.test',
    email: 'vera@resolver-viejo.test',
    anteriores: [],
    otrasDirecciones: ['vera@resolver-nuevo.test'],
  });

  // Pasado: vive en el dominio nuevo y entra con su usuario anterior.
  db.prepare('UPDATE mailboxes SET domain_id = ?, usuario_motor = ? WHERE id = ?').run(
    r2.domainId,
    'vera@resolver-viejo.test',
    vera.mailboxId,
  );
  db.prepare("UPDATE domain_migrations SET estado = 'pasado' WHERE id = ?").run(cambioId);
  assert.equal(de('vera@resolver-viejo.test'), vera.mailboxId);
  assert.equal(de('vera@resolver-nuevo.test'), vera.mailboxId);
  assert.equal(nombreEnMotor('vera@resolver-nuevo.test'), 'vera@resolver-viejo.test');
  assert.equal(nombreEnMotor('alguien@ejemplo.org'), 'alguien@ejemplo.org');
  assert.deepEqual(datosWebmail(vera.mailboxId), {
    login: 'vera@resolver-viejo.test',
    email: 'vera@resolver-nuevo.test',
    anteriores: [],
    otrasDirecciones: ['vera@resolver-viejo.test'],
  });

  // Un buzón creado en el destino después de pasar no es un ítem del cambio.
  const zoe = await createMailbox(ctx, r2.domainId, 'zoe');
  assert.equal(de('zoe@resolver-nuevo.test'), zoe.mailboxId);
  assert.equal(de('zoe@resolver-viejo.test'), null);

  // Actualizado: su dirección anterior la resuelve la pareja del cambio abierto.
  db.prepare('UPDATE mailboxes SET usuario_motor = NULL, login_anterior = ? WHERE id = ?').run(
    'vera@resolver-viejo.test',
    vera.mailboxId,
  );
  assert.equal(de('vera@resolver-viejo.test'), vera.mailboxId);
  assert.equal(nombreEnMotor('vera@resolver-nuevo.test'), 'vera@resolver-nuevo.test');
  assert.deepEqual(datosWebmail(vera.mailboxId), {
    login: 'vera@resolver-nuevo.test',
    email: 'vera@resolver-nuevo.test',
    anteriores: ['vera@resolver-viejo.test'],
    otrasDirecciones: ['vera@resolver-viejo.test'],
  });

  // Dado de baja: la dirección vieja ya no entra, pero el webmail aún la conoce.
  db.prepare("UPDATE domain_migrations SET estado = 'dado_de_baja' WHERE id = ?").run(cambioId);
  assert.equal(de('vera@resolver-viejo.test'), null);
  assert.equal(cambioAbiertoDeDominio(r2.domainId), null);
  assert.deepEqual(datosWebmail(vera.mailboxId).otrasDirecciones, ['vera@resolver-viejo.test']);
});

test('datosWebmail no ofrece un usuario anterior que hoy es otro buzón', async () => {
  const c = await createClient(ctx);
  assert.equal((await cambiarPlan(c.clientId, 'plan_agencia')).statusCode, 200);
  const d1 = await createDomain(ctx, c.clientId, 'webmail-uno.test');
  const d2 = await createDomain(ctx, c.clientId, 'webmail-dos.test');
  const ana = await createMailbox(ctx, d1.domainId, 'ana');
  // Lo que deja «Volver» y después «Cancelar» con un destino que ya existía:
  // ana vuelve a entrar con su dirección y su usuario anterior es el del destino.
  db.prepare('UPDATE mailboxes SET login_anterior = ? WHERE id = ?').run('ana@webmail-dos.test', ana.mailboxId);
  assert.deepEqual(datosWebmail(ana.mailboxId).anteriores, ['ana@webmail-dos.test']);

  // Esa dirección se da de alta para otra persona: deja de ser su usuario anterior.
  const otra = await createMailbox(ctx, d2.domainId, 'ana');
  assert.equal(fila(ana.mailboxId).login_anterior, null);
  assert.deepEqual(datosWebmail(ana.mailboxId).anteriores, []);
  assert.deepEqual(datosWebmail(otra.mailboxId).anteriores, []);

  // Y si llega por otro camino (un buzón que se muda a esa dirección), tampoco se ofrece.
  db.prepare('UPDATE mailboxes SET login_anterior = ? WHERE id = ?').run('ana@webmail-dos.test', ana.mailboxId);
  assert.deepEqual(datosWebmail(ana.mailboxId).anteriores, []);
});

test('datosWebmail tras dos cambios seguidos (A→B y B→C): ofrece las filas de los dos usuarios anteriores', async () => {
  const c = await createClient(ctx);
  assert.equal((await cambiarPlan(c.clientId, 'plan_agencia')).statusCode, 200);
  const a = await createDomain(ctx, c.clientId, 'cadena-a.test');
  const b = await createDomain(ctx, c.clientId, 'cadena-b.test');
  const cc = await createDomain(ctx, c.clientId, 'cadena-c.test');
  const eva = await createMailbox(ctx, a.domainId, 'eva');
  // A→B dado de baja (la baja la pasó a su usuario de B) y B→C pasado, con
  // Eva ya actualizada a C. No entró en el webmail entre medias: Roundcube
  // aún tiene su fila como eva@cadena-a.test.
  const primero = crearCambio({
    cliente: c.clientId,
    desde: a,
    hacia: b,
    estado: 'dado_de_baja',
    buzones: [{ id: eva.mailboxId, local: 'eva' }],
  });
  db.prepare('UPDATE domain_migrations SET created_at = created_at - 60000 WHERE id = ?').run(primero);
  crearCambio({
    cliente: c.clientId,
    desde: b,
    hacia: cc,
    estado: 'pasado',
    direccionesAt: Date.now(),
    buzones: [{ id: eva.mailboxId, local: 'eva' }],
  });
  db.prepare('UPDATE mailboxes SET domain_id = ?, usuario_motor = NULL, login_anterior = ? WHERE id = ?').run(
    cc.domainId,
    'eva@cadena-b.test',
    eva.mailboxId,
  );
  // Del más reciente al más antiguo; las identidades con cualquiera de las dos pasan a la vigente.
  assert.deepEqual(datosWebmail(eva.mailboxId), {
    login: 'eva@cadena-c.test',
    email: 'eva@cadena-c.test',
    anteriores: ['eva@cadena-b.test', 'eva@cadena-a.test'],
    otrasDirecciones: ['eva@cadena-b.test', 'eva@cadena-a.test'],
  });

  // Si eva@cadena-a.test es hoy otra persona, su fila no se traslada.
  const otra = await createMailbox(ctx, a.domainId, 'eva');
  assert.deepEqual(datosWebmail(eva.mailboxId).anteriores, ['eva@cadena-b.test']);
  assert.deepEqual(datosWebmail(otra.mailboxId).anteriores, []);
});

/* ------------------------------- connection.ts ------------------------------- */

test('connection.ts: usuario del motor en los datos, el perfil de Apple, el QR y los bloques', async () => {
  const uma = await buzonPendiente('uma');
  const conexion = await ctx.app.inject({
    method: 'GET',
    url: `/api/mailboxes/${uma.mailboxId}/connection`,
    headers: { cookie: userCookie },
  });
  assert.equal(conexion.statusCode, 200, conexion.body);
  assert.equal(conexion.json().email, uma.email);
  assert.equal(conexion.json().username, uma.login);

  const settings = getConnectionSettings(nuevo.domain, clientId);
  const uuids = (plist: string) => [...plist.matchAll(/<key>PayloadUUID<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1]);
  const original = mobileconfigPlist({ email: uma.login, settings });
  const tras = mobileconfigPlist({ email: uma.email, usuario: uma.login, semilla: uma.login, settings });
  assert.deepEqual(uuids(tras), uuids(original), 'instalarlo de nuevo sustituye al perfil anterior');
  assert.match(tras, new RegExp(`<key>IncomingMailServerUsername</key>\\s*<string>${uma.login}</string>`));
  assert.match(tras, new RegExp(`<key>OutgoingMailServerUsername</key>\\s*<string>${uma.login}</string>`));
  assert.match(tras, new RegExp(`<key>EmailAddress</key>\\s*<string>${uma.email}</string>`));
  assert.notDeepEqual(uuids(mobileconfigPlist({ email: uma.email, settings })), uuids(original));

  const qr = JSON.parse(thunderbirdAndroidQrPayload(uma.email, 'Uma', settings, uma.login)) as unknown[];
  const entrada = qr[2] as unknown[];
  const salida = (qr[3] as unknown[][])[0]! as unknown[][];
  assert.equal(entrada[5], uma.login);
  assert.equal(entrada[6], uma.email);
  assert.equal(salida[0]![5], uma.login);
  assert.deepEqual(salida[1], [uma.email, 'Uma']);
  const qrNormal = JSON.parse(thunderbirdAndroidQrPayload(uma.email, 'Uma', settings)) as unknown[];
  assert.equal((qrNormal[2] as unknown[])[5], uma.email);

  const bloques = bloquesContrasenaAplicacion({ email: uma.email, usuario: uma.login, password: 'x', name: 'App', settings });
  const env = bloques.find((b) => b.id === 'env')!.content.split('\n');
  assert.ok(env.includes(`SMTP_USER=${uma.login}`));
  assert.ok(env.includes(`SMTP_FROM=${uma.email}`));

  const conUsuario = thunderbirdAutoconfigXml(nuevo.domain, settings, { usuario: uma.login });
  assert.equal(conUsuario.split(`<username>${uma.login}</username>`).length - 1, 3);
  assert.ok(!conUsuario.includes('%EMAILADDRESS%'));
  assert.equal(thunderbirdAutoconfigXml(nuevo.domain, settings).split('<username>%EMAILADDRESS%</username>').length - 1, 3);

  const pox = autodiscoverXml(uma.email, settings, uma.login);
  assert.equal(pox.split(`<LoginName>${uma.login}</LoginName>`).length - 1, 2);
  assert.match(pox, new RegExp(`<DisplayName>${uma.email}</DisplayName>`));
  assert.equal(autodiscoverXml(uma.email, settings).split(`<LoginName>${uma.email}</LoginName>`).length - 1, 2);
});
