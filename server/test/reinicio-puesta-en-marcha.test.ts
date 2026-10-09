import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { upstream } from '../src/core/errors';
import { db } from '../src/core/db';
import { getEngine } from '../src/engine';
import {
  adminContext,
  cookieFrom,
  createClient,
  createDomain,
  createMailbox,
  type TestContext,
  motorAcepta,
} from './helpers';

/*
 * «Reiniciar puesta en marcha» de un cliente (POST /api/clients/:id/onboarding-reset):
 * cada buzón activo queda como tras setup-reset, pero sin enlace nuevo; los
 * suspendidos se saltan y un fallo del motor en uno no detiene los demás.
 */

let ctx: TestContext;
let ipSeq = 0;
function nuevaIp(): string {
  ipSeq += 1;
  return `10.70.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

before(async () => {
  ctx = await adminContext();
});

interface Resultado {
  reset: number;
  skipped: number;
  failed: { email: string; error: string }[];
}

function reiniciarCliente(clientId: string, payload: Record<string, unknown> = {}, headers: Record<string, string> = { cookie: ctx.adminCookie }) {
  return ctx.app.inject({ method: 'POST', url: `/api/clients/${clientId}/onboarding-reset`, headers, payload });
}

function enlaces(mailboxId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM setup_links WHERE mailbox_id = ?').get(mailboxId) as { c: number }).c;
}

function configuredAt(mailboxId: string): number | null {
  return (db.prepare('SELECT configured_at FROM mailboxes WHERE id = ?').get(mailboxId) as { configured_at: number | null })
    .configured_at;
}

function envios(mailboxId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM envios_configuracion WHERE mailbox_id = ?').get(mailboxId) as { c: number }).c;
}

function tieneFoto(mailboxId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM mailbox_photos WHERE mailbox_id = ?').get(mailboxId));
}

function auditoria(action: string, clientId: string) {
  return db
    .prepare('SELECT user_id, client_id, detail FROM audit_log WHERE action = ? AND client_id = ? ORDER BY id')
    .all(action, clientId) as { user_id: string | null; client_id: string; detail: string }[];
}

async function crearEnlace(mailboxId: string, payload: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${mailboxId}/setup-links`,
    headers: { cookie: ctx.adminCookie },
    payload,
  });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { link: { id: string; url: string } }).link;
}

/**
 * Deja en el buzón el rastro de una prueba: enlace con contraseña, sesión de
 * «Mi buzón» (que lo marca como configurado), foto, un correo de
 * configuración anotado, un fallo al entrar y una contraseña de aplicación.
 */
async function rastroDePrueba(b: { mailboxId: string; email: string; password: string }, clientId: string) {
  await crearEnlace(b.mailboxId, { includePassword: true, password: b.password });
  const sesion = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/login',
    payload: { email: b.email, password: b.password },
    remoteAddress: nuevaIp(),
  });
  assert.equal(sesion.statusCode, 200, sesion.body);
  db.prepare('INSERT INTO mailbox_photos (mailbox_id, mime, data, updated_at) VALUES (?, ?, ?, ?)').run(
    b.mailboxId,
    'image/png',
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Date.now(),
  );
  db.prepare(
    `INSERT INTO envios_configuracion (id, mailbox_id, client_id, recipient, status, created_at)
     VALUES (?, ?, ?, 'titular@ejemplo.com', 'sent', ?)`,
  ).run(`env_${b.mailboxId}`, b.mailboxId, clientId, Date.now());
  db.prepare('INSERT INTO login_attempts (ip, attempted_at) VALUES (?, ?)').run(`buzon:${b.email}`, Date.now());
  const app = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${b.mailboxId}/app-passwords`,
    headers: { cookie: ctx.adminCookie },
    payload: { name: 'Integración de la web' },
  });
  assert.equal(app.statusCode, 200, app.body);
  return { portalCookie: cookieFrom(sesion), appPassword: (app.json() as { password: string }).password };
}

test('reinicia todos los buzones activos del cliente, salta los suspendidos y no toca otros clientes', async () => {
  const engine = getEngine();
  const cliente = await createClient(ctx);
  // Dos dominios: el plan básico solo admite uno.
  db.prepare("UPDATE clients SET plan_id = 'plan_negocio' WHERE id = ?").run(cliente.clientId);
  const d1 = await createDomain(ctx, cliente.clientId);
  const d2 = await createDomain(ctx, cliente.clientId);
  const ana = await createMailbox(ctx, d1.domainId, 'ana');
  const luis = await createMailbox(ctx, d2.domainId, 'luis');
  const pausado = await createMailbox(ctx, d1.domainId, 'pausado');
  const rastroAna = await rastroDePrueba(ana, cliente.clientId);
  await rastroDePrueba(luis, cliente.clientId);

  // Un buzón suspendido conserva su configuración.
  await crearEnlace(pausado.mailboxId);
  db.prepare('UPDATE mailboxes SET configured_at = ? WHERE id = ?').run(Date.now(), pausado.mailboxId);
  const suspender = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/mailboxes/${pausado.mailboxId}`,
    headers: { cookie: ctx.adminCookie },
    payload: { status: 'suspended' },
  });
  assert.equal(suspender.statusCode, 200, suspender.body);

  // Otro cliente, con su buzón ya configurado.
  const otro = await createClient(ctx);
  const dOtro = await createDomain(ctx, otro.clientId);
  const ajeno = await createMailbox(ctx, dOtro.domainId);
  await rastroDePrueba(ajeno, otro.clientId);

  const res = await reiniciarCliente(cliente.clientId);
  assert.equal(res.statusCode, 200, res.body);
  const r = res.json() as Resultado;
  assert.deepEqual(r, { reset: 2, skipped: 1, failed: [] }, 'solo los recuentos: nunca contraseñas');

  for (const b of [ana, luis]) {
    assert.equal(await motorAcepta(b.email, b.password), false, `${b.email}: la contraseña anterior ya no vale`);
    assert.equal(enlaces(b.mailboxId), 0, `${b.email}: sin enlaces (tampoco uno nuevo)`);
    assert.equal(configuredAt(b.mailboxId), null, `${b.email}: vuelve a estar sin configurar`);
    assert.equal(envios(b.mailboxId), 0, `${b.email}: sin correos de configuración`);
    assert.equal(tieneFoto(b.mailboxId), false, `${b.email}: sin foto`);
    const fallos = db.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ?').get(`buzon:${b.email}`) as { c: number };
    assert.equal(fallos.c, 0, `${b.email}: sin fallos pendientes`);
  }
  // La sesión de «Mi buzón» de la prueba se cierra.
  const me = await ctx.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie: rastroAna.portalCookie } });
  assert.equal(me.statusCode, 401);
  // Por defecto, las contraseñas de aplicación siguen (pueden ser de integraciones).
  assert.equal(await motorAcepta(ana.email, rastroAna.appPassword), true);
  const activas = db
    .prepare('SELECT COUNT(*) AS c FROM app_passwords WHERE mailbox_id = ? AND revoked_at IS NULL')
    .get(ana.mailboxId) as { c: number };
  assert.equal(activas.c, 1);

  // El suspendido, intacto.
  assert.equal(enlaces(pausado.mailboxId), 1);
  assert.ok(configuredAt(pausado.mailboxId));

  // El otro cliente, intacto.
  assert.equal(await motorAcepta(ajeno.email, ajeno.password), true);
  assert.equal(enlaces(ajeno.mailboxId), 1);
  assert.ok(configuredAt(ajeno.mailboxId));
  assert.equal(envios(ajeno.mailboxId), 1);
  assert.equal(tieneFoto(ajeno.mailboxId), true);

  // Una sola anotación en la actividad del cliente, sin secretos.
  const registro = auditoria('client.onboarding_reset', cliente.clientId);
  assert.equal(registro.length, 1);
  const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@mailway.test'").get() as { id: string };
  assert.equal(registro[0]!.user_id, admin.id);
  assert.deepEqual(JSON.parse(registro[0]!.detail), {
    clientId: cliente.clientId,
    reset: 2,
    skipped: 1,
    failed: 0,
    revokeAppPasswords: false,
  });
  assert.equal(auditoria('mailbox.setup_reset', cliente.clientId).length, 0, 'ni una fila por buzón');

  // Después, cada titular recibe su configuración desde la puesta en marcha.
  const envio = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${ana.mailboxId}/setup-email`,
    headers: { cookie: ctx.adminCookie },
    payload: { to: 'ana@ejemplo.com' },
  });
  assert.equal(envio.statusCode, 200, envio.body);
});

test('con revokeAppPasswords también retira las contraseñas de aplicación y su historial', async () => {
  const engine = getEngine();
  const cliente = await createClient(ctx);
  const { domainId } = await createDomain(ctx, cliente.clientId);
  const b = await createMailbox(ctx, domainId);
  const { appPassword } = await rastroDePrueba(b, cliente.clientId);

  const res = await reiniciarCliente(cliente.clientId, { revokeAppPasswords: true });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { reset: 1, skipped: 0, failed: [] });
  assert.equal(await motorAcepta(b.email, appPassword), false);
  const filas = db.prepare('SELECT COUNT(*) AS c FROM app_passwords WHERE mailbox_id = ?').get(b.mailboxId) as { c: number };
  assert.equal(filas.c, 0);
  const [registro] = auditoria('client.onboarding_reset', cliente.clientId);
  assert.equal(JSON.parse(registro!.detail).revokeAppPasswords, true);

  // Un cliente sin buzones: nada que hacer, pero queda anotado.
  const vacio = await createClient(ctx);
  const sinBuzones = await reiniciarCliente(vacio.clientId);
  assert.equal(sinBuzones.statusCode, 200, sinBuzones.body);
  assert.deepEqual(sinBuzones.json(), { reset: 0, skipped: 0, failed: [] });
});

test('solo la administración con sesión del panel: ni el cliente, ni otro cliente, ni un token de gestión', async () => {
  const engine = getEngine();
  const cliente = await createClient(ctx, { withUser: true });
  const { domainId } = await createDomain(ctx, cliente.clientId);
  const b = await createMailbox(ctx, domainId);
  const ajeno = await createClient(ctx, { withUser: true });

  const anonimo = await reiniciarCliente(cliente.clientId, {}, {});
  assert.equal(anonimo.statusCode, 401);

  const propio = await reiniciarCliente(cliente.clientId, {}, { cookie: cliente.userCookie! });
  assert.equal(propio.statusCode, 403);
  const deOtro = await reiniciarCliente(cliente.clientId, {}, { cookie: ajeno.userCookie! });
  assert.equal(deOtro.statusCode, 403);

  const creado = await ctx.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: { cookie: ctx.adminCookie },
    payload: { name: 'Integración de pruebas' },
  });
  assert.equal(creado.statusCode, 200, creado.body);
  const token = (creado.json() as { token: string }).token;
  const conToken = await reiniciarCliente(cliente.clientId, {}, { authorization: `Bearer ${token}` });
  assert.equal(conToken.statusCode, 403);
  assert.equal(conToken.json().code, 'session_required');

  const noExiste = await reiniciarCliente('cli_no_existe');
  assert.equal(noExiste.statusCode, 404);

  const malo = await reiniciarCliente(cliente.clientId, { revokeAppPasswords: 'sí' });
  assert.equal(malo.statusCode, 400);
  assert.equal(malo.json().code, 'validation');

  db.prepare('UPDATE clients SET suspended = 1 WHERE id = ?').run(cliente.clientId);
  try {
    const suspendido = await reiniciarCliente(cliente.clientId);
    assert.equal(suspendido.statusCode, 400);
    assert.equal(suspendido.json().code, 'client_suspended');
  } finally {
    db.prepare('UPDATE clients SET suspended = 0 WHERE id = ?').run(cliente.clientId);
  }

  // Sin motor configurado, un único error y nada cambia.
  config.demoMode = false;
  try {
    const sinMotor = await reiniciarCliente(cliente.clientId);
    assert.equal(sinMotor.statusCode, 400);
    assert.equal(sinMotor.json().code, 'engine_not_configured');
  } finally {
    config.demoMode = true;
  }

  assert.equal(await motorAcepta(b.email, b.password), true, 'nada de lo anterior ha cambiado la contraseña');
  assert.equal(auditoria('client.onboarding_reset', cliente.clientId).length, 0);
});

test('un buzón que falla en el motor no detiene los demás y se informa en failed', async () => {
  const engine = getEngine();
  const cliente = await createClient(ctx);
  const { domainId } = await createDomain(ctx, cliente.clientId);
  const bien = await createMailbox(ctx, domainId, 'bien');
  const falla = await createMailbox(ctx, domainId, 'falla');
  const rara = await createMailbox(ctx, domainId, 'rara');
  for (const b of [bien, falla, rara]) await crearEnlace(b.mailboxId);

  const original = engine.setMailboxPassword.bind(engine);
  engine.setMailboxPassword = async (email: string, password: string) => {
    if (email === falla.email) throw upstream('El servidor de correo no ha respondido.', 'engine_unreachable');
    // Un error inesperado no se enseña tal cual.
    if (email === rara.email) throw new TypeError('detalle interno que no debe salir');
    return original(email, password);
  };
  let r: Resultado;
  try {
    const res = await reiniciarCliente(cliente.clientId);
    assert.equal(res.statusCode, 200, res.body);
    r = res.json() as Resultado;
  } finally {
    engine.setMailboxPassword = original;
  }

  assert.equal(r.reset, 1);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.failed.map((f) => f.email), [falla.email, rara.email]);
  assert.equal(r.failed[0]!.error, 'El servidor de correo no ha respondido.');
  assert.ok(!r.failed[1]!.error.includes('detalle interno'));
  assert.ok(r.failed[1]!.error.length > 0);

  // El que funcionó, reiniciado; los que fallaron, como estaban (se puede repetir).
  assert.equal(await motorAcepta(bien.email, bien.password), false);
  assert.equal(enlaces(bien.mailboxId), 0);
  for (const b of [falla, rara]) {
    assert.equal(await motorAcepta(b.email, b.password), true);
    assert.equal(enlaces(b.mailboxId), 1);
  }
  const [registro] = auditoria('client.onboarding_reset', cliente.clientId);
  assert.deepEqual(JSON.parse(registro!.detail), {
    clientId: cliente.clientId,
    reset: 1,
    skipped: 0,
    failed: 2,
    revokeAppPasswords: false,
  });

  // Repetir reintenta los que fallaron.
  const otraVez = await reiniciarCliente(cliente.clientId);
  assert.deepEqual(otraVez.json(), { reset: 3, skipped: 0, failed: [] });
  assert.equal(await motorAcepta(falla.email, falla.password), false);
});
