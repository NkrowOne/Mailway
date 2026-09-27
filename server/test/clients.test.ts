import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { getEngine } from '../src/engine';
import {
  adminContext,
  cookieFrom,
  createClient,
  createDomain,
  createMailbox,
  type TestContext,
} from './helpers';

let ctx: TestContext;

before(async () => {
  ctx = await adminContext();
});

function asAdmin(method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: unknown) {
  return ctx.app.inject({ method, url, headers: { cookie: ctx.adminCookie }, payload: payload as object });
}

const planBase = {
  maxDomains: 2,
  maxMailboxes: 10,
  maxAliases: 5,
  mailboxQuotaMb: 1024,
  apiDailyLimit: 100,
  apiPerMinuteLimit: 10,
};

async function newPlan(name: string, overrides: Partial<typeof planBase> = {}): Promise<string> {
  const res = await asAdmin('POST', '/api/plans', { name, ...planBase, ...overrides });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { plan: { id: string } }).plan.id;
}

/* --------------------------------- Planes -------------------------------- */

test('planes: alta, edición parcial, validación en español y nombre único', async () => {
  const id = await newPlan('Pruebas CRUD');

  const dup = await asAdmin('POST', '/api/plans', { name: 'pruebas crud', ...planBase });
  assert.equal(dup.statusCode, 409);
  assert.match(dup.json().error, /Ya existe un plan/);

  const invalid = await asAdmin('POST', '/api/plans', { name: 'Mal', ...planBase, maxDomains: 0 });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, 'validation');
  assert.match(invalid.json().error, /máximo de dominios debe ser como mínimo 1/);

  const patched = await asAdmin('PATCH', `/api/plans/${id}`, { maxMailboxes: 40, notes: 'Ampliado' });
  assert.equal(patched.statusCode, 200, patched.body);
  const plan = patched.json().plan;
  assert.equal(plan.maxMailboxes, 40);
  assert.equal(plan.maxDomains, planBase.maxDomains, 'lo no enviado se conserva');
  assert.equal(plan.notes, 'Ampliado');

  const list = await asAdmin('GET', '/api/plans');
  const listed = (list.json().plans as { id: string; clientCount: number }[]).find((p) => p.id === id);
  assert.equal(listed?.clientCount, 0);
});

test('planes: borrar uno inexistente da 404 y uno en uso da 409 con explicación', async () => {
  const missing = await asAdmin('DELETE', '/api/plans/plan_no_existe');
  assert.equal(missing.statusCode, 404);

  const id = await newPlan('En uso');
  const client = await asAdmin('POST', '/api/clients', { name: 'Usa el plan', planId: id });
  assert.equal(client.statusCode, 200);

  const inUse = await asAdmin('DELETE', `/api/plans/${id}`);
  assert.equal(inUse.statusCode, 409);
  assert.equal(inUse.json().code, 'plan_in_use');
  assert.match(inUse.json().error, /lo usa 1 cliente/);

  const counted = (await asAdmin('GET', '/api/plans')).json().plans as { id: string; clientCount: number }[];
  assert.equal(counted.find((p) => p.id === id)?.clientCount, 1);

  const free = await newPlan('Sin uso');
  const ok = await asAdmin('DELETE', `/api/plans/${free}`);
  assert.equal(ok.statusCode, 200);
  assert.equal((await asAdmin('DELETE', `/api/plans/${free}`)).statusCode, 404);
});

test('planes: solo el administrador', async () => {
  const { userCookie } = await createClient(ctx, { withUser: true });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/plans',
    headers: { cookie: userCookie! },
    payload: { name: 'Intruso', ...planBase },
  });
  assert.equal(res.statusCode, 403);
});

/* -------------------------------- Clientes -------------------------------- */

test('alta guiada: cliente con primer usuario y contraseña generada una sola vez', async () => {
  const planId = await newPlan('Alta guiada');
  const email = `primera-${Date.now()}@guiada.test`;
  const res = await asAdmin('POST', '/api/clients', {
    name: 'Guiada S.L.',
    contactEmail: 'Gerencia@Guiada.TEST',
    planId,
    user: { name: 'Ana Pérez', email },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.client.externalRef, null);
  assert.equal(body.client.contactEmail, 'gerencia@guiada.test', 'el correo se guarda en minúsculas');
  assert.equal(body.user.email, email);
  assert.equal(typeof body.password, 'string');
  assert.ok(body.password.length >= 12);

  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: body.password },
  });
  assert.equal(login.statusCode, 200, 'el usuario puede entrar con la contraseña generada');

  const detail = await asAdmin('GET', `/api/clients/${body.client.id}`);
  const data = detail.json();
  assert.equal(data.client.users.length, 1);
  assert.equal(data.users.length, 1, 'también en la raíz, según el contrato');
  assert.equal(data.plan.id, planId);
  assert.equal(typeof data.usage.mailboxes, 'number');
});

test('alta guiada: un correo de usuario repetido no deja un cliente a medias', async () => {
  const planId = await newPlan('Sin medias');
  const email = `repetido-${Date.now()}@guiada.test`;
  const first = await asAdmin('POST', '/api/clients', { name: 'Uno', planId, user: { name: 'Uno', email } });
  assert.equal(first.statusCode, 200);

  const before = (db.prepare('SELECT COUNT(*) AS c FROM clients').get() as { c: number }).c;
  const second = await asAdmin('POST', '/api/clients', { name: 'Dos', planId, user: { name: 'Dos', email } });
  assert.equal(second.statusCode, 409);
  const after = (db.prepare('SELECT COUNT(*) AS c FROM clients').get() as { c: number }).c;
  assert.equal(after, before);
});

test('editar cliente: nombre, contacto y notas; validación en español', async () => {
  const { clientId } = await createClient(ctx);
  const res = await asAdmin('PATCH', `/api/clients/${clientId}`, {
    name: 'Nombre nuevo',
    contactEmail: 'nuevo@cliente.test',
    notes: 'Factura trimestral',
  });
  assert.equal(res.statusCode, 200, res.body);
  const client = res.json().client;
  assert.equal(client.name, 'Nombre nuevo');
  assert.equal(client.contactEmail, 'nuevo@cliente.test');
  assert.equal(client.notes, 'Factura trimestral');

  const bad = await asAdmin('PATCH', `/api/clients/${clientId}`, { contactEmail: 'no-es-correo' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'El correo de contacto no es válido.');

  const audit = db
    .prepare(`SELECT detail FROM audit_log WHERE action = 'client.updated' ORDER BY id DESC LIMIT 1`)
    .get() as { detail: string };
  assert.ok(JSON.parse(audit.detail).fields.includes('name'));
});

test('cambio de plan: se rechaza bajar por debajo del uso actual y se permite subir', async () => {
  const big = await newPlan('Grande', { maxDomains: 5 });
  const small = await newPlan('Pequeño', { maxDomains: 1 });
  const created = await asAdmin('POST', '/api/clients', { name: 'Con dos dominios', planId: big });
  const clientId = created.json().client.id as string;
  await createDomain(ctx, clientId);
  await createDomain(ctx, clientId);

  const down = await asAdmin('PATCH', `/api/clients/${clientId}`, { planId: small });
  assert.equal(down.statusCode, 409);
  assert.equal(down.json().code, 'plan_below_usage');
  assert.match(down.json().error, /tiene 2 dominios y el plan permite 1/);
  assert.equal((await asAdmin('GET', `/api/clients/${clientId}`)).json().client.planId, big);

  const bigger = await newPlan('Mayor', { maxDomains: 10 });
  const up = await asAdmin('PATCH', `/api/clients/${clientId}`, { planId: bigger });
  assert.equal(up.statusCode, 200);
  assert.equal(up.json().client.planId, bigger);
  assert.equal(up.json().client.plan.maxDomains, 10);
});

test('suspender un cliente suspende sus buzones en el motor y reactivarlo restaura solo los activos', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId);
  const active = await createMailbox(ctx, domainId, 'activo');
  const own = await createMailbox(ctx, domainId, 'propio');
  const engine = getEngine();

  // Un buzón suspendido por su cuenta antes de suspender el cliente.
  const single = await asAdmin('PATCH', `/api/mailboxes/${own.mailboxId}`, { status: 'suspended' });
  assert.equal(single.statusCode, 200);
  assert.equal(await engine.verifyCredentials(active.email, active.password), true);
  assert.equal(await engine.verifyCredentials(own.email, own.password), false);

  const suspend = await asAdmin('PATCH', `/api/clients/${clientId}`, { suspended: true });
  assert.equal(suspend.statusCode, 200, suspend.body);
  assert.equal(suspend.json().client.suspended, true);
  assert.deepEqual(suspend.json().suspension, { updated: 1, skipped: 1, failed: [] });
  assert.equal(await engine.verifyCredentials(active.email, active.password), false);
  assert.equal(await engine.verifyCredentials(own.email, own.password), false);

  // Mientras el cliente está suspendido no se reactiva un buzón suelto…
  const reactivate = await asAdmin('PATCH', `/api/mailboxes/${active.mailboxId}`, { status: 'active' });
  assert.equal(reactivate.statusCode, 409);
  assert.equal(reactivate.json().code, 'client_suspended');
  // …ni se crean buzones.
  const blocked = await asAdmin('POST', '/api/mailboxes', { domainId, localPart: 'nuevo' });
  assert.equal(blocked.statusCode, 400);
  assert.equal(blocked.json().code, 'client_suspended');

  const resume = await asAdmin('PATCH', `/api/clients/${clientId}`, { suspended: false });
  assert.equal(resume.statusCode, 200);
  assert.equal(await engine.verifyCredentials(active.email, active.password), true);
  assert.equal(
    await engine.verifyCredentials(own.email, own.password),
    false,
    'el buzón suspendido individualmente sigue suspendido',
  );

  const states = (await asAdmin('GET', `/api/mailboxes?clientId=${clientId}`)).json().mailboxes as {
    email: string;
    status: string;
  }[];
  assert.equal(states.find((m) => m.email === active.email)?.status, 'active');
  assert.equal(states.find((m) => m.email === own.email)?.status, 'suspended');
});

test('usuarios del cliente: restablecer con contraseña generada, deshabilitar y eliminar', async () => {
  const { clientId } = await createClient(ctx);
  const email = `gestion-${Date.now()}@cliente.test`;
  const created = await asAdmin('POST', `/api/clients/${clientId}/users`, { name: 'Gestión', email });
  assert.equal(created.statusCode, 200, created.body);
  const userId = created.json().user.id as string;
  assert.equal(typeof created.json().password, 'string', 'sin contraseña, se genera y se devuelve una vez');

  const reset = await asAdmin('PATCH', `/api/clients/${clientId}/users/${userId}`, { generatePassword: true });
  assert.equal(reset.statusCode, 200);
  const password = reset.json().password as string;
  assert.ok(password.length >= 12);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  assert.equal(login.statusCode, 200);
  const cookie = cookieFrom(login);

  const disable = await asAdmin('PATCH', `/api/clients/${clientId}/users/${userId}`, { disabled: true });
  assert.equal(disable.statusCode, 200);
  const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  assert.equal(me.json().user, null, 'deshabilitar cierra sus sesiones');

  const del = await asAdmin('DELETE', `/api/clients/${clientId}/users/${userId}`);
  assert.equal(del.statusCode, 200);
  const again = await asAdmin('DELETE', `/api/clients/${clientId}/users/${userId}`);
  assert.equal(again.statusCode, 404);
});

test('un usuario de cliente solo ve su propio cliente', async () => {
  const mine = await createClient(ctx, { withUser: true });
  const other = await createClient(ctx);
  const own = await ctx.app.inject({
    method: 'GET',
    url: `/api/clients/${mine.clientId}`,
    headers: { cookie: mine.userCookie! },
  });
  assert.equal(own.statusCode, 200);
  const foreign = await ctx.app.inject({
    method: 'GET',
    url: `/api/clients/${other.clientId}`,
    headers: { cookie: mine.userCookie! },
  });
  assert.equal(foreign.statusCode, 403);
  const edit = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/clients/${mine.clientId}`,
    headers: { cookie: mine.userCookie! },
    payload: { suspended: false },
  });
  assert.equal(edit.statusCode, 403);
});
