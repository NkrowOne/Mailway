import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { getEngine } from '../src/engine';
import {
  adminContext,
  createClient,
  createDomain,
  createMailbox,
  type TestContext,
} from './helpers';

let ctx: TestContext;

before(async () => {
  ctx = await adminContext();
});

function call(cookie: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  return ctx.app.inject({ method, url, headers: { cookie }, payload: payload as object });
}

interface AppPasswordView {
  id: string;
  mailboxId: string;
  email: string;
  name: string;
  createdAt: number;
  revokedAt: number | null;
}

test('crear, listar y revocar contraseñas de aplicación sin tocar la principal', async () => {
  const { clientId, userCookie } = await createClient(ctx, { withUser: true });
  const { domainId } = await createDomain(ctx, clientId);
  const { mailboxId, email, password } = await createMailbox(ctx, domainId, 'movil');
  const engine = getEngine();
  const base = `/api/mailboxes/${mailboxId}/app-passwords`;

  const created = await call(userCookie!, 'POST', base, { name: 'Móvil de Ana' });
  assert.equal(created.statusCode, 200, created.body);
  const body = created.json() as { appPassword: AppPasswordView; password: string };
  assert.equal(body.appPassword.name, 'Móvil de Ana');
  assert.equal(body.appPassword.email, email);
  assert.equal(body.appPassword.revokedAt, null);
  assert.match(body.password, /^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/);

  assert.equal(await engine.verifyCredentials(email, body.password), true, 'la nueva sirve para entrar');
  assert.equal(await engine.verifyCredentials(email, password), true, 'la principal no cambia');

  const list = await call(userCookie!, 'GET', base);
  assert.equal(list.statusCode, 200);
  const items = list.json().appPasswords as (AppPasswordView & Record<string, unknown>)[];
  assert.equal(items.length, 1);
  assert.equal(items[0]!.password, undefined, 'el listado nunca incluye secretos');
  assert.equal(items[0]!.stored_secret, undefined);
  assert.ok(!list.body.includes(body.password));

  const revoked = await call(userCookie!, 'DELETE', `${base}/${body.appPassword.id}`);
  assert.equal(revoked.statusCode, 200);
  assert.equal(await engine.verifyCredentials(email, body.password), false, 'revocada deja de funcionar');
  assert.equal(await engine.verifyCredentials(email, password), true);

  const after = (await call(userCookie!, 'GET', base)).json().appPasswords as AppPasswordView[];
  assert.ok(after[0]!.revokedAt, 'queda en el historial como revocada');

  const actions = (
    db
      .prepare(`SELECT action, detail FROM audit_log WHERE action LIKE 'mailbox.app_password_%'`)
      .all() as { action: string; detail: string }[]
  );
  assert.deepEqual(
    actions.map((a) => a.action).sort(),
    ['mailbox.app_password_created', 'mailbox.app_password_revoked'],
  );
  assert.ok(actions.every((a) => !a.detail.includes(body.password)), 'la auditoría no guarda la contraseña');
});

test('validación del nombre y 404 al revocar una que no existe', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId);
  const { mailboxId } = await createMailbox(ctx, domainId, 'validacion');
  const base = `/api/mailboxes/${mailboxId}/app-passwords`;

  const empty = await call(ctx.adminCookie, 'POST', base, { name: '   ' });
  assert.equal(empty.statusCode, 400);
  assert.match(empty.json().error, /Indica un nombre/);

  const missing = await call(ctx.adminCookie, 'DELETE', `${base}/app_no_existe`);
  assert.equal(missing.statusCode, 404);

  const noMailbox = await call(ctx.adminCookie, 'GET', '/api/mailboxes/mbx_no_existe/app-passwords');
  assert.equal(noMailbox.statusCode, 404);
});

test('un usuario de otro cliente no puede ver, crear ni revocar', async () => {
  const owner = await createClient(ctx, { withUser: true });
  const intruder = await createClient(ctx, { withUser: true });
  const { domainId } = await createDomain(ctx, owner.clientId);
  const { mailboxId } = await createMailbox(ctx, domainId, 'privado');
  const base = `/api/mailboxes/${mailboxId}/app-passwords`;

  const created = await call(owner.userCookie!, 'POST', base, { name: 'Portátil' });
  assert.equal(created.statusCode, 200);
  const appId = created.json().appPassword.id as string;

  assert.equal((await call(intruder.userCookie!, 'GET', base)).statusCode, 403);
  assert.equal((await call(intruder.userCookie!, 'POST', base, { name: 'Intruso' })).statusCode, 403);
  assert.equal((await call(intruder.userCookie!, 'DELETE', `${base}/${appId}`)).statusCode, 403);

  // Una contraseña de otro buzón no se puede revocar a través de este.
  const { mailboxId: otherBox } = await createMailbox(ctx, domainId, 'otro');
  const cross = await call(owner.userCookie!, 'DELETE', `/api/mailboxes/${otherBox}/app-passwords/${appId}`);
  assert.equal(cross.statusCode, 404);

  const anonymous = await ctx.app.inject({ method: 'GET', url: base });
  assert.equal(anonymous.statusCode, 401);
});

test('un cliente o un buzón suspendidos no crean contraseñas de aplicación', async () => {
  const { clientId, userCookie } = await createClient(ctx, { withUser: true });
  const { domainId } = await createDomain(ctx, clientId);
  const { mailboxId } = await createMailbox(ctx, domainId, 'suspensiones');
  const base = `/api/mailboxes/${mailboxId}/app-passwords`;

  db.prepare('UPDATE clients SET suspended = 1 WHERE id = ?').run(clientId);
  try {
    for (const cookie of [userCookie!, ctx.adminCookie]) {
      const res = await call(cookie, 'POST', base, { name: 'Móvil' });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(res.json().code, 'client_suspended');
    }
  } finally {
    db.prepare('UPDATE clients SET suspended = 0 WHERE id = ?').run(clientId);
  }

  db.prepare("UPDATE mailboxes SET status = 'suspended' WHERE id = ?").run(mailboxId);
  try {
    const res = await call(ctx.adminCookie, 'POST', base, { name: 'Móvil' });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().code, 'mailbox_suspended');
  } finally {
    db.prepare("UPDATE mailboxes SET status = 'active' WHERE id = ?").run(mailboxId);
  }

  const activas = db
    .prepare('SELECT COUNT(*) AS c FROM app_passwords WHERE mailbox_id = ?')
    .get(mailboxId) as { c: number };
  assert.equal(activas.c, 0);
  assert.equal((await call(userCookie!, 'POST', base, { name: 'Móvil' })).statusCode, 200, 'reactivado, funciona');
});
