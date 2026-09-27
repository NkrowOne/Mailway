import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import {
  adminContext,
  cookieFrom,
  createClient,
  createDomain,
  createMailbox,
  type TestContext,
} from './helpers';

/**
 * Tokens de gestión: ciclo de vida, autenticación por Bearer y los límites
 * que impiden que un token filtrado haga más de lo que debe.
 */

let ctx: TestContext;

interface TokenInfo {
  id: string;
  name: string;
  prefix: string;
  status: string;
  userId: string;
  ownerEmail: string;
  lastUsedAt: number | null;
  expiresAt: number | null;
  current: boolean;
}

async function crearToken(
  cookie: string,
  name = 'Skyway',
  expiresInDays?: number | null,
): Promise<{ token: string; info: TokenInfo }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: { cookie },
    payload: expiresInDays === undefined ? { name } : { name, expiresInDays },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { token: string; info: TokenInfo };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

before(async () => {
  ctx = await adminContext();
});

test('crear un token devuelve el secreto una sola vez y guarda solo su hash', async () => {
  const { token, info } = await crearToken(ctx.adminCookie, 'Skyway producción', 90);
  assert.match(token, /^mwt_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
  assert.equal(info.name, 'Skyway producción');
  assert.equal(info.status, 'active');
  assert.equal(token.split('_')[1], info.prefix);
  assert.ok(info.expiresAt && info.expiresAt > Date.now() + 89 * 24 * 3600_000);

  const row = db.prepare('SELECT * FROM management_tokens WHERE id = ?').get(info.id) as Record<
    string,
    unknown
  >;
  assert.ok(row, 'el token debe quedar registrado');
  for (const value of Object.values(row)) {
    assert.notEqual(value, token, 'el token en claro no debe guardarse en ninguna columna');
  }
  assert.ok(!JSON.stringify(row).includes(token.split('_').slice(2).join('_')));

  const list = await ctx.app.inject({
    method: 'GET',
    url: '/api/tokens',
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(list.statusCode, 200);
  assert.ok(!list.body.includes(token), 'el listado nunca devuelve el secreto');
  const tokens = (list.json() as { tokens: TokenInfo[] }).tokens;
  assert.ok(tokens.some((t) => t.id === info.id));

  const audit = db
    .prepare(`SELECT detail FROM audit_log WHERE action = 'token.created'`)
    .all() as { detail: string }[];
  assert.ok(audit.length > 0, 'la creación queda auditada');
  for (const entry of audit) assert.ok(!entry.detail.includes(token), 'la auditoría no guarda el secreto');
});

test('Bearer autentica como el administrador y anota el último uso', async () => {
  const { token, info } = await crearToken(ctx.adminCookie, 'Script');
  const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(token) });
  assert.equal(me.statusCode, 200);
  const body = me.json() as { user: { role: string } | null; via: { kind: string; name?: string } };
  assert.equal(body.user?.role, 'admin');
  assert.equal(body.via.kind, 'token');
  assert.equal(body.via.name, 'Script');

  const clients = await ctx.app.inject({ method: 'GET', url: '/api/clients', headers: bearer(token) });
  assert.equal(clients.statusCode, 200, 'un token de administrador tiene los permisos del administrador');

  const row = db
    .prepare('SELECT last_used_at, last_used_ip FROM management_tokens WHERE id = ?')
    .get(info.id) as { last_used_at: number | null; last_used_ip: string };
  assert.ok(row.last_used_at, 'se anota el último uso');

  const list = await ctx.app.inject({ method: 'GET', url: '/api/tokens', headers: bearer(token) });
  const current = (list.json() as { tokens: TokenInfo[] }).tokens.find((t) => t.current);
  assert.equal(current?.id, info.id, 'el listado marca el token de la propia petición');
});

test('el token de un cliente hereda su rol: solo ve su cliente', async () => {
  const propio = await createClient(ctx, { withUser: true });
  const ajeno = await createClient(ctx);
  const { token } = await crearToken(propio.userCookie!, 'CI del cliente');

  const todos = await ctx.app.inject({ method: 'GET', url: '/api/clients', headers: bearer(token) });
  assert.equal(todos.statusCode, 403, 'un cliente no lista clientes');

  const suyo = await ctx.app.inject({
    method: 'GET',
    url: `/api/clients/${propio.clientId}`,
    headers: bearer(token),
  });
  assert.equal(suyo.statusCode, 200);

  const otro = await ctx.app.inject({
    method: 'GET',
    url: `/api/clients/${ajeno.clientId}`,
    headers: bearer(token),
  });
  assert.equal(otro.statusCode, 403, 'un token de cliente no accede a otro cliente');
});

test('un token no puede crear más tokens ni cambiar la contraseña', async () => {
  const { token } = await crearToken(ctx.adminCookie, 'Filtrado');
  const crear = await ctx.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: bearer(token),
    payload: { name: 'Otro' },
  });
  assert.equal(crear.statusCode, 403);
  assert.equal((crear.json() as { code: string }).code, 'session_required');

  const password = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/password',
    headers: bearer(token),
    payload: { currentPassword: 'clave-admin-segura', newPassword: 'otra-clave-muy-segura' },
  });
  assert.equal(password.statusCode, 403);
  assert.equal((password.json() as { code: string }).code, 'session_required');
});

test('un token revocado deja de funcionar al instante', async () => {
  const { token, info } = await crearToken(ctx.adminCookie, 'Para revocar');
  const antes = await ctx.app.inject({ method: 'GET', url: '/api/clients', headers: bearer(token) });
  assert.equal(antes.statusCode, 200);

  const revocar = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/tokens/${info.id}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(revocar.statusCode, 200);
  assert.equal((revocar.json() as { token: TokenInfo }).token.status, 'revoked');

  const despues = await ctx.app.inject({ method: 'GET', url: '/api/clients', headers: bearer(token) });
  assert.equal(despues.statusCode, 401);
  assert.equal((despues.json() as { code: string }).code, 'token_revoked');

  // Revocar dos veces no es un error ni duplica la auditoría.
  const otraVez = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/tokens/${info.id}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(otraVez.statusCode, 200);
  const revocados = db
    .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'token.revoked' AND detail LIKE ?`)
    .get(`%${info.id}%`) as { c: number };
  assert.equal(revocados.c, 1);
});

test('un token caducado o de un usuario deshabilitado se rechaza', async () => {
  const { token, info } = await crearToken(ctx.adminCookie, 'Caduca', 1);
  db.prepare('UPDATE management_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, info.id);
  const caducado = await ctx.app.inject({ method: 'GET', url: '/api/clients', headers: bearer(token) });
  assert.equal(caducado.statusCode, 401);
  assert.equal((caducado.json() as { code: string }).code, 'token_expired');

  const cliente = await createClient(ctx, { withUser: true });
  const delCliente = await crearToken(cliente.userCookie!, 'Del cliente');
  const userId = delCliente.info.userId;
  const deshabilitar = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/clients/${cliente.clientId}/users/${userId}`,
    headers: { cookie: ctx.adminCookie },
    payload: { disabled: true },
  });
  assert.equal(deshabilitar.statusCode, 200, deshabilitar.body);
  const rechazado = await ctx.app.inject({
    method: 'GET',
    url: `/api/clients/${cliente.clientId}`,
    headers: bearer(delCliente.token),
  });
  assert.equal(rechazado.statusCode, 401);
  assert.equal((rechazado.json() as { code: string }).code, 'token_user_disabled');
});

test('un Bearer no válido no recurre a la cookie de sesión', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/api/clients',
    headers: {
      cookie: ctx.adminCookie,
      authorization: 'Bearer mwt_00000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
  });
  assert.equal(res.statusCode, 401);
  assert.equal((res.json() as { code: string }).code, 'invalid_token');

  // Un secreto erróneo con un prefijo real tampoco vale.
  const { token } = await crearToken(ctx.adminCookie, 'Prefijo real');
  const manipulado = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  const res2 = await ctx.app.inject({ method: 'GET', url: '/api/clients', headers: bearer(manipulado) });
  assert.equal(res2.statusCode, 401);
});

test('una clave de envío mw_ no autentica las rutas del panel', async () => {
  const cliente = await createClient(ctx);
  const { domainId } = await createDomain(ctx, cliente.clientId);
  const { mailboxId } = await createMailbox(ctx, domainId, 'noreply');
  const creada = await ctx.app.inject({
    method: 'POST',
    url: '/api/apikeys',
    headers: { cookie: ctx.adminCookie },
    payload: { clientId: cliente.clientId, name: 'OTP', senderMailboxId: mailboxId },
  });
  assert.equal(creada.statusCode, 200, creada.body);
  const key = (creada.json() as { key: string }).key;
  assert.match(key, /^mw_/);

  for (const url of ['/api/clients', `/api/clients/${cliente.clientId}`, '/api/tokens', '/api/audit']) {
    const res = await ctx.app.inject({ method: 'GET', url, headers: bearer(key) });
    assert.equal(res.statusCode, 401, `${url} no debe aceptar una clave mw_`);
    assert.equal((res.json() as { code: string }).code, 'api_key_not_allowed');
  }
  const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(key) });
  assert.equal((me.json() as { user: unknown }).user, null);
});

test('solo el dueño o un administrador pueden revocar; ?all=1 es solo para administradores', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const delAdmin = await crearToken(ctx.adminCookie, 'Del administrador');
  const delCliente = await crearToken(cliente.userCookie!, 'Integración del cliente');

  const ajeno = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/tokens/${delAdmin.info.id}`,
    headers: { cookie: cliente.userCookie! },
  });
  assert.equal(ajeno.statusCode, 404, 'un cliente no puede ni ver tokens ajenos');

  const listaCliente = await ctx.app.inject({
    method: 'GET',
    url: '/api/tokens?all=1',
    headers: { cookie: cliente.userCookie! },
  });
  const idsCliente = (listaCliente.json() as { tokens: TokenInfo[] }).tokens.map((t) => t.id);
  assert.deepEqual(idsCliente, [delCliente.info.id], 'un cliente solo ve sus propios tokens');

  const listaAdmin = await ctx.app.inject({
    method: 'GET',
    url: '/api/tokens?all=1',
    headers: { cookie: ctx.adminCookie },
  });
  const delOtro = (listaAdmin.json() as { tokens: TokenInfo[] }).tokens.find(
    (t) => t.id === delCliente.info.id,
  );
  assert.ok(delOtro, 'el administrador ve los tokens de todos con ?all=1');
  assert.equal(delOtro.ownerEmail, cliente.userEmail);

  const propiosAdmin = await ctx.app.inject({
    method: 'GET',
    url: '/api/tokens',
    headers: { cookie: ctx.adminCookie },
  });
  assert.ok(
    !(propiosAdmin.json() as { tokens: TokenInfo[] }).tokens.some((t) => t.id === delCliente.info.id),
    'sin ?all=1, el administrador solo ve los suyos',
  );

  const porAdmin = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/tokens/${delCliente.info.id}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(porAdmin.statusCode, 200);
  const entrada = db
    .prepare(`SELECT client_id FROM audit_log WHERE action = 'token.revoked' AND detail LIKE ?`)
    .get(`%${delCliente.info.id}%`) as { client_id: string | null };
  assert.equal(entrada.client_id, cliente.clientId, 'la revocación consta en la actividad del cliente');
});

test('el alta valida nombre y caducidad', async () => {
  const casos = [
    { name: '' },
    { name: 'x'.repeat(61) },
    { name: 'Válido', expiresInDays: 0 },
    { name: 'Válido', expiresInDays: 3651 },
    { name: 'Válido', expiresInDays: 1.5 },
  ];
  for (const payload of casos) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { cookie: ctx.adminCookie },
      payload,
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  const sinCaducidad = await crearToken(ctx.adminCookie, 'Sin caducidad', null);
  assert.equal(sinCaducidad.info.expiresAt, null);

  const anonimo = await ctx.app.inject({ method: 'POST', url: '/api/tokens', payload: { name: 'x' } });
  assert.equal(anonimo.statusCode, 401);
});

test('cambiar la contraseña conserva la sesión actual y cierra las demás', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const email = cliente.userEmail!;
  const sesionA = cliente.userCookie!;
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'clave-cliente-segura' },
  });
  const sesionB = cookieFrom(login);
  const { token } = await crearToken(sesionA, 'Sobrevive al cambio');

  const cambio = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/password',
    headers: { cookie: sesionA },
    payload: { currentPassword: 'clave-cliente-segura', newPassword: 'nueva-clave-del-cliente' },
  });
  assert.equal(cambio.statusCode, 200, cambio.body);

  const meA = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sesionA } });
  assert.equal((meA.json() as { user: { email: string } | null }).user?.email, email);
  const meB = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sesionB } });
  assert.equal((meB.json() as { user: unknown }).user, null, 'la otra sesión queda cerrada');

  // Los tokens son credenciales independientes: siguen funcionando.
  const conToken = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(token) });
  assert.equal((conToken.json() as { user: { email: string } | null }).user?.email, email);
});

test('cerrar sesión se audita y purga la sesión', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const salir = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { cookie: cliente.userCookie! },
  });
  assert.equal(salir.statusCode, 200);
  const me = await ctx.app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { cookie: cliente.userCookie! },
  });
  assert.equal((me.json() as { user: unknown }).user, null);
  const entrada = db
    .prepare(`SELECT client_id FROM audit_log WHERE action = 'auth.logout' ORDER BY id DESC LIMIT 1`)
    .get() as { client_id: string | null } | undefined;
  assert.equal(entrada?.client_id, cliente.clientId);
});

test('iniciar sesión purga las sesiones caducadas', async () => {
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
     SELECT 'caducada-de-prueba', id, 0, 1 FROM users WHERE role = 'admin' LIMIT 1`,
  ).run();
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@mailway.test', password: 'clave-admin-segura' },
  });
  assert.equal(login.statusCode, 200);
  const quedan = db
    .prepare(`SELECT COUNT(*) AS c FROM sessions WHERE token_hash = 'caducada-de-prueba'`)
    .get() as { c: number };
  assert.equal(quedan.c, 0);
});
