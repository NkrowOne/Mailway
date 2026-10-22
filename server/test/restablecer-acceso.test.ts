import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { componerCorreoRestablecimiento } from '../src/modules/restablecimientos';
import { adminContext, cookieFrom, createClient, createDomain, type TestContext } from './helpers';

/*
 * Restablecer el acceso al panel de un usuario de un cliente: la
 * administración le envía un enlace por correo y con él elige una
 * contraseña nueva.
 */

let ctx: TestContext;

before(async () => {
  ctx = await adminContext();
});

function tokenDe(url: string): string {
  const match = /\/restablecer\/([A-Za-z0-9_-]+)$/.exec(url);
  assert.ok(match, `la URL debe acabar en /restablecer/<token>: ${url}`);
  return match[1]!;
}

async function usuarioDe(clientId: string, email: string): Promise<string> {
  const fila = db.prepare('SELECT id FROM users WHERE email = ? AND client_id = ?').get(email, clientId) as {
    id: string;
  };
  return fila.id;
}

async function enviar(clientId: string, userId: string, payload: Record<string, unknown> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/clients/${clientId}/users/${userId}/password-reset`,
    headers: { cookie: ctx.adminCookie },
    payload,
  });
}

async function login(email: string, password: string) {
  return ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
}

test('restablecer acceso: el enlace llega, cambia la contraseña, abre sesión y no se puede repetir', async () => {
  const { clientId, userEmail, userCookie } = await createClient(ctx, { withUser: true });
  const email = userEmail!;
  await createDomain(ctx, clientId, email.split('@')[1]);
  const userId = await usuarioDe(clientId, email);

  const res = await enviar(clientId, userId);
  assert.equal(res.statusCode, 200, res.body);
  const { reset } = res.json() as { reset: { url: string; to: string; status: string; expiresAt: number } };
  assert.equal(reset.status, 'sent');
  assert.equal(reset.to, email, 'por defecto, a su propio correo');
  assert.ok(Math.abs(reset.expiresAt - (Date.now() + 24 * 3600_000)) < 60_000, '24 horas por defecto');
  const token = tokenDe(reset.url);
  const fila = db.prepare('SELECT token_hash FROM panel_password_resets WHERE user_id = ?').get(userId) as {
    token_hash: string;
  };
  assert.ok(!fila.token_hash.includes(token), 'solo se guarda el hash');

  const datos = await ctx.app.inject({ method: 'GET', url: `/api/password-reset/${token}` });
  assert.equal(datos.statusCode, 200, datos.body);
  assert.equal((datos.json() as { email: string }).email, email);

  const corta = await ctx.app.inject({
    method: 'POST',
    url: `/api/password-reset/${token}`,
    payload: { password: 'corta' },
  });
  assert.equal(corta.statusCode, 400);

  const usar = await ctx.app.inject({
    method: 'POST',
    url: `/api/password-reset/${token}`,
    payload: { password: 'contraseña-nueva-segura' },
  });
  assert.equal(usar.statusCode, 200, usar.body);
  assert.equal((usar.json() as { redirect: string }).redirect, '/');
  const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieFrom(usar) } });
  assert.equal((me.json() as { user: { email: string } }).user.email, email);

  // La sesión anterior se cierra; la contraseña vieja ya no sirve y la nueva sí.
  const vieja = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: userCookie! } });
  assert.equal((vieja.json() as { user: unknown }).user ?? null, null);
  assert.equal((await login(email, 'clave-cliente-segura')).statusCode, 401);
  assert.equal((await login(email, 'contraseña-nueva-segura')).statusCode, 200);

  const otraVez = await ctx.app.inject({
    method: 'POST',
    url: `/api/password-reset/${token}`,
    payload: { password: 'otra-contraseña-segura' },
  });
  assert.equal(otraVez.statusCode, 404);
  assert.equal((otraVez.json() as { code: string }).code, 'reset_invalid');

  const actividad = db
    .prepare(`SELECT action, detail FROM audit_log WHERE client_id = ? AND action LIKE 'client.user_password_reset%'`)
    .all(clientId) as { action: string; detail: string }[];
  assert.deepEqual(actividad.map((a) => a.action).sort(), [
    'client.user_password_reset_sent',
    'client.user_password_reset_used',
  ]);
  assert.ok(actividad.every((a) => !a.detail.includes(token)), 'el token nunca va a la actividad');
});

test('restablecer acceso: a otro correo, y el enlace nuevo sustituye al anterior', async () => {
  const { clientId, userEmail } = await createClient(ctx, { withUser: true });
  await createDomain(ctx, clientId);
  const userId = await usuarioDe(clientId, userEmail!);

  const primero = await enviar(clientId, userId, { to: 'Personal@Ejemplo.test' });
  assert.equal(primero.statusCode, 200, primero.body);
  const r1 = (primero.json() as { reset: { url: string; to: string } }).reset;
  assert.equal(r1.to, 'personal@ejemplo.test');

  const segundo = await enviar(clientId, userId, { to: 'otro@ejemplo.test', ttlHours: 2 });
  assert.equal(segundo.statusCode, 200, segundo.body);
  const r2 = (segundo.json() as { reset: { url: string } }).reset;

  const viejo = await ctx.app.inject({ method: 'GET', url: `/api/password-reset/${tokenDe(r1.url)}` });
  assert.equal(viejo.statusCode, 404);
  const nuevo = await ctx.app.inject({ method: 'GET', url: `/api/password-reset/${tokenDe(r2.url)}` });
  assert.equal(nuevo.statusCode, 200);

  // Si la administración le pone una contraseña a mano, el enlace deja de servir.
  const patch = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/clients/${clientId}/users/${userId}`,
    headers: { cookie: ctx.adminCookie },
    payload: { generatePassword: true },
  });
  assert.equal(patch.statusCode, 200);
  const tras = await ctx.app.inject({ method: 'GET', url: `/api/password-reset/${tokenDe(r2.url)}` });
  assert.equal(tras.statusCode, 404);
});

test('restablecer acceso: sin dominio con propiedad el correo no sale, pero llega el enlace', async () => {
  const { clientId, userEmail } = await createClient(ctx, { withUser: true });
  const userId = await usuarioDe(clientId, userEmail!);
  const res = await enviar(clientId, userId);
  assert.equal(res.statusCode, 200, res.body);
  const { reset } = res.json() as { reset: { url: string; status: string; error?: string } };
  assert.equal(reset.status, 'failed');
  assert.match(reset.error ?? '', /dominio/);
  const datos = await ctx.app.inject({ method: 'GET', url: `/api/password-reset/${tokenDe(reset.url)}` });
  assert.equal(datos.statusCode, 200, 'la administración puede enviarlo ella');
});

test('restablecer acceso: solo la administración, solo usuarios del cliente y con límite', async () => {
  const a = await createClient(ctx, { withUser: true });
  const b = await createClient(ctx, { withUser: true });
  await createDomain(ctx, a.clientId);
  const userA = await usuarioDe(a.clientId, a.userEmail!);

  const comoCliente = await ctx.app.inject({
    method: 'POST',
    url: `/api/clients/${a.clientId}/users/${userA}/password-reset`,
    headers: { cookie: a.userCookie! },
    payload: {},
  });
  assert.equal(comoCliente.statusCode, 403);

  // El usuario de A no se alcanza desde la ficha de B.
  assert.equal((await enviar(b.clientId, userA)).statusCode, 404);

  // Ni el administrador de la instancia.
  const admin = db.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get() as { id: string };
  assert.equal((await enviar(a.clientId, admin.id)).statusCode, 404);

  const malo = await enviar(a.clientId, userA, { to: 'no-es-correo' });
  assert.equal(malo.statusCode, 400);

  // Deshabilitado: primero hay que habilitarlo.
  db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(userA);
  assert.equal((await enviar(a.clientId, userA)).statusCode, 400);
  db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').run(userA);

  for (let i = 0; i < 5; i++) assert.equal((await enviar(a.clientId, userA)).statusCode, 200);
  assert.equal((await enviar(a.clientId, userA)).statusCode, 429);
});

test('restablecer acceso: con el cliente suspendido el enlace no sirve', async () => {
  const { clientId, userEmail } = await createClient(ctx, { withUser: true });
  await createDomain(ctx, clientId);
  const userId = await usuarioDe(clientId, userEmail!);
  const res = await enviar(clientId, userId);
  const token = tokenDe((res.json() as { reset: { url: string } }).reset.url);
  db.prepare('UPDATE clients SET suspended = 1 WHERE id = ?').run(clientId);
  const usar = await ctx.app.inject({
    method: 'POST',
    url: `/api/password-reset/${token}`,
    payload: { password: 'contraseña-nueva-segura' },
  });
  assert.equal(usar.statusCode, 403);
  assert.equal((usar.json() as { code: string }).code, 'client_suspended');
  db.prepare('UPDATE clients SET suspended = 0 WHERE id = ?').run(clientId);
});

test('restablecer acceso: el correo escapa lo que escribe la gente', () => {
  const correo = componerCorreoRestablecimiento({
    email: 'info@codanuancelegal.com',
    name: 'Ana <b>López</b>',
    url: 'https://panel.test/restablecer/abc',
    expiresAt: Date.now() + 3600_000,
    clientName: 'Coda & Nuance',
    brandName: 'Correo',
  });
  assert.match(correo.subject, /Coda & Nuance/);
  assert.ok(correo.html.includes('Coda &amp; Nuance'));
  assert.ok(!correo.html.includes('<b>López'));
  assert.ok(correo.text.includes('https://panel.test/restablecer/abc'));
  assert.ok(correo.text.includes('info@codanuancelegal.com'));
});
