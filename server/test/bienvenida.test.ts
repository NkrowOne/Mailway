import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import {
  adminContext,
  cookieFrom,
  createClient,
  createDomain,
  createMailbox,
  setDomainOwnership,
  type TestContext,
} from './helpers';

/*
 * Enlace de bienvenida del cliente y lo que usa su puesta en marcha:
 * direcciones obligatorias (postmaster y abuse), altas masivas con enlace de
 * configuración y el estado del resumen.
 */

let ctx: TestContext;
let seq = 0;

before(async () => {
  ctx = await adminContext();
});

function tokenDe(url: string): string {
  const match = /\/bienvenida\/([A-Za-z0-9_-]+)$/.exec(url);
  assert.ok(match, `la URL debe acabar en /bienvenida/<token>: ${url}`);
  return match[1]!;
}

async function invitar(clientId: string, payload: Record<string, unknown>, cookie = ctx.adminCookie) {
  return ctx.app.inject({ method: 'POST', url: `/api/clients/${clientId}/invites`, headers: { cookie }, payload });
}

function correoNuevo(): string {
  seq += 1;
  return `contacto${seq}-${Date.now()}@empresa.test`;
}

test('enlace de bienvenida: crear el acceso abre la sesión del cliente y el enlace ya no sirve', async () => {
  const { clientId } = await createClient(ctx);
  const email = correoNuevo();

  const res = await invitar(clientId, { email: email.toUpperCase(), name: 'Marta Ruiz' });
  assert.equal(res.statusCode, 200, res.body);
  const { invite } = res.json() as {
    invite: { id: string; url: string; email: string; expiresAt: number; existingUser: boolean };
  };
  assert.equal(invite.email, email);
  assert.equal(invite.existingUser, false);
  assert.ok(Math.abs(invite.expiresAt - (Date.now() + 168 * 3600_000)) < 60_000, '7 días por defecto');
  const token = tokenDe(invite.url);
  const fila = db.prepare('SELECT token_enc FROM client_invites WHERE id = ?').get(invite.id) as { token_enc: string };
  assert.ok(fila.token_enc.startsWith('v1:') && !fila.token_enc.includes(token));

  // La administración puede volver a enviarlo.
  const otraVez = await ctx.app.inject({
    method: 'GET',
    url: `/api/clients/${clientId}/invites/${invite.id}/url`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(otraVez.statusCode, 200, otraVez.body);
  assert.equal((otraVez.json() as { invite: { url: string } }).invite.url, invite.url);

  const pagina = await ctx.app.inject({ method: 'GET', url: `/api/invite/${token}` });
  assert.equal(pagina.statusCode, 200, pagina.body);
  assert.equal(pagina.json().email, email);
  assert.equal(pagina.json().name, 'Marta Ruiz');
  assert.ok(pagina.json().clientName);
  assert.ok(pagina.json().brandName);
  assert.equal(pagina.json().existingUser, false);

  const corta = await ctx.app.inject({
    method: 'POST',
    url: `/api/invite/${token}/accept`,
    payload: { name: 'Marta Ruiz', password: 'corta' },
  });
  assert.equal(corta.statusCode, 400);
  // Para crear el acceso el nombre sigue siendo obligatorio.
  for (const payload of [{ password: 'una-clave-larga-123' }, { name: '  ', password: 'una-clave-larga-123' }]) {
    const sinNombre = await ctx.app.inject({ method: 'POST', url: `/api/invite/${token}/accept`, payload });
    assert.equal(sinNombre.statusCode, 400, sinNombre.body);
    assert.equal(sinNombre.json().code, 'validation');
  }
  const sinCrear = db.prepare('SELECT COUNT(*) AS c FROM users WHERE email = ?').get(email) as { c: number };
  assert.equal(sinCrear.c, 0);

  const aceptar = await ctx.app.inject({
    method: 'POST',
    url: `/api/invite/${token}/accept`,
    payload: { name: 'Marta Ruiz García', password: 'una-clave-larga-123' },
  });
  assert.equal(aceptar.statusCode, 200, aceptar.body);
  assert.equal(aceptar.json().redirect, '/puesta-en-marcha');
  const cookie = cookieFrom(aceptar);

  // Entra como usuario de su cliente, con su nombre.
  const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  const user = (me.json() as { user: { email: string; name: string; role: string; clientId: string } }).user;
  assert.deepEqual([user.email, user.name, user.role, user.clientId], [email, 'Marta Ruiz García', 'client', clientId]);
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'una-clave-larga-123' },
  });
  assert.equal(login.statusCode, 200, 'después entra con su correo y su contraseña');

  // Un solo uso.
  const usada = await ctx.app.inject({ method: 'GET', url: `/api/invite/${token}` });
  assert.equal(usada.statusCode, 409);
  assert.equal(usada.json().code, 'invite_used');
  const repetir = await ctx.app.inject({
    method: 'POST',
    url: `/api/invite/${token}/accept`,
    payload: { name: 'Otra', password: 'otra-clave-larga-12' },
  });
  assert.equal(repetir.statusCode, 409);

  const lista = await ctx.app.inject({ method: 'GET', url: `/api/clients/${clientId}/invites`, headers: { cookie: ctx.adminCookie } });
  const [fila0] = (lista.json() as { invites: { status: string; recoverable: boolean; openedAt: number | null }[] }).invites;
  assert.equal(fila0!.status, 'accepted');
  assert.equal(fila0!.recoverable, false);
  assert.ok(fila0!.openedAt);

  const registro = db
    .prepare("SELECT user_id, client_id, detail FROM audit_log WHERE action = 'client.invite_accepted' ORDER BY id DESC")
    .get() as { user_id: string; client_id: string; detail: string };
  assert.equal(registro.client_id, clientId);
  assert.ok(registro.user_id);
  assert.ok(!registro.detail.includes(token));
  assert.equal(JSON.parse(registro.detail).existing, false);
});

test('enlace de bienvenida: solo la administración, uno por persona y con sus límites', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const email = correoNuevo();

  const delCliente = await invitar(cliente.clientId, { email }, cliente.userCookie!);
  assert.equal(delCliente.statusCode, 403);

  // El correo de la administración o de un usuario de otro cliente, nunca:
  // el enlace daría acceso a su cuenta.
  const deLaAdministracion = await invitar(cliente.clientId, { email: 'ADMIN@mailway.test' });
  assert.equal(deLaAdministracion.statusCode, 409);
  assert.equal(deLaAdministracion.json().code, 'user_exists');
  const otro = await createClient(ctx, { withUser: true });
  const deOtroCliente = await invitar(cliente.clientId, { email: otro.userEmail! });
  assert.equal(deOtroCliente.statusCode, 409);
  assert.equal(deOtroCliente.json().code, 'user_exists');

  // Uno nuevo para la misma persona sustituye al anterior.
  const primero = (await invitar(cliente.clientId, { email })).json() as { invite: { url: string } };
  const segundo = (await invitar(cliente.clientId, { email })).json() as { invite: { url: string } };
  assert.equal((await ctx.app.inject({ method: 'GET', url: `/api/invite/${tokenDe(primero.invite.url)}` })).statusCode, 404);
  assert.equal((await ctx.app.inject({ method: 'GET', url: `/api/invite/${tokenDe(segundo.invite.url)}` })).statusCode, 200);

  // Caducado.
  const caduca = (await invitar(cliente.clientId, { email: correoNuevo() })).json() as { invite: { id: string; url: string } };
  db.prepare('UPDATE client_invites SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, caduca.invite.id);
  const caducado = await ctx.app.inject({ method: 'GET', url: `/api/invite/${tokenDe(caduca.invite.url)}` });
  assert.equal(caducado.statusCode, 404);
  assert.equal(caducado.json().code, 'invite_invalid');

  // Revocado.
  const revoca = (await invitar(cliente.clientId, { email: correoNuevo() })).json() as { invite: { id: string; url: string } };
  await ctx.app.inject({
    method: 'DELETE',
    url: `/api/clients/${cliente.clientId}/invites/${revoca.invite.id}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal((await ctx.app.inject({ method: 'GET', url: `/api/invite/${tokenDe(revoca.invite.url)}` })).statusCode, 404);

  // Cliente suspendido.
  db.prepare('UPDATE clients SET suspended = 1 WHERE id = ?').run(cliente.clientId);
  try {
    const suspendido = await ctx.app.inject({ method: 'GET', url: `/api/invite/${tokenDe(segundo.invite.url)}` });
    assert.equal(suspendido.statusCode, 403);
    assert.equal((await invitar(cliente.clientId, { email: correoNuevo() })).statusCode, 400);
  } finally {
    db.prepare('UPDATE clients SET suspended = 0 WHERE id = ?').run(cliente.clientId);
  }

  // Aceptar abre una sesión: desde otra web se rechaza como cualquier petición con cookie.
  const desdeFuera = await ctx.app.inject({
    method: 'POST',
    url: `/api/invite/${tokenDe(segundo.invite.url)}/accept`,
    headers: { 'sec-fetch-site': 'cross-site' },
    payload: { name: 'Intruso', password: 'clave-del-intruso-1' },
  });
  assert.equal(desdeFuera.statusCode, 403);
  assert.equal(desdeFuera.json().code, 'cross_site_request');
});

/* -------------------- Enlace para un usuario que ya existe -------------------- */

function aceptar(token: string, payload: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url: `/api/invite/${token}/accept`, payload });
}

function entrar(email: string, password: string) {
  return ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
}

async function yo(cookie: string) {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  return (res.json() as { user: { id: string; email: string; name: string; role: string; clientId: string } | null }).user;
}

test('enlace de bienvenida para un usuario del mismo cliente: elige una contraseña nueva sin duplicarlo', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const email = cliente.userEmail!;
  const antes = (await yo(cliente.userCookie!))!;

  const res = await invitar(cliente.clientId, { email: email.toUpperCase(), name: 'Contacto' });
  assert.equal(res.statusCode, 200, res.body);
  const { invite } = res.json() as { invite: { url: string; email: string; existingUser: boolean } };
  assert.equal(invite.email, email);
  assert.equal(invite.existingUser, true);
  const token = tokenDe(invite.url);

  const pagina = await ctx.app.inject({ method: 'GET', url: `/api/invite/${token}` });
  assert.equal(pagina.statusCode, 200, pagina.body);
  assert.equal(pagina.json().existingUser, true);
  assert.equal(pagina.json().email, email);

  // La contraseña, con las mismas reglas; un nombre que llega también se valida.
  assert.equal((await aceptar(token, { password: 'corta' })).statusCode, 400);
  assert.equal((await aceptar(token, { name: 'A', password: 'nueva-clave-del-contacto' })).statusCode, 400);

  // Sin nombre: conserva el suyo.
  const ok = await aceptar(token, { password: 'nueva-clave-del-contacto' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json(), { ok: true, redirect: '/puesta-en-marcha' });
  const despues = (await yo(cookieFrom(ok)))!;
  assert.deepEqual(
    [despues.id, despues.email, despues.name, despues.role, despues.clientId],
    [antes.id, email, antes.name, 'client', cliente.clientId],
  );
  const usuarios = db.prepare('SELECT COUNT(*) AS c FROM users WHERE lower(email) = ?').get(email) as { c: number };
  assert.equal(usuarios.c, 1, 'el mismo usuario, no otro');
  const aceptada = db
    .prepare('SELECT accepted_user_id FROM client_invites WHERE token_hash IS NOT NULL AND email = ? AND accepted_at IS NOT NULL')
    .get(email) as { accepted_user_id: string };
  assert.equal(aceptada.accepted_user_id, antes.id);

  // Las sesiones abiertas con la contraseña anterior se cierran; vale la nueva.
  assert.equal(await yo(cliente.userCookie!), null);
  assert.equal((await entrar(email, 'clave-cliente-segura')).statusCode, 401);
  assert.equal((await entrar(email, 'nueva-clave-del-contacto')).statusCode, 200);

  const registro = db
    .prepare("SELECT user_id, client_id, detail FROM audit_log WHERE action = 'client.invite_accepted' ORDER BY id DESC")
    .get() as { user_id: string; client_id: string; detail: string };
  assert.equal(registro.user_id, antes.id);
  assert.equal(registro.client_id, cliente.clientId);
  assert.equal(JSON.parse(registro.detail).existing, true);
  assert.ok(!registro.detail.includes('nueva-clave-del-contacto'));

  // Un usuario deshabilitado vuelve a quedar habilitado, y el nombre que
  // llega sustituye al anterior.
  const deshabilitar = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/clients/${cliente.clientId}/users/${antes.id}`,
    headers: { cookie: ctx.adminCookie },
    payload: { disabled: true },
  });
  assert.equal(deshabilitar.statusCode, 200, deshabilitar.body);
  assert.equal((await entrar(email, 'nueva-clave-del-contacto')).statusCode, 401);
  const otro = (await invitar(cliente.clientId, { email })).json() as { invite: { url: string; existingUser: boolean } };
  assert.equal(otro.invite.existingUser, true);
  const reactivar = await aceptar(tokenDe(otro.invite.url), { name: 'Marta Ruiz', password: 'otra-clave-del-contacto' });
  assert.equal(reactivar.statusCode, 200, reactivar.body);
  const fila = db.prepare('SELECT name, disabled FROM users WHERE id = ?').get(antes.id) as { name: string; disabled: number };
  assert.deepEqual(fila, { name: 'Marta Ruiz', disabled: 0 });
  assert.equal((await entrar(email, 'otra-clave-del-contacto')).statusCode, 200);
});

test('el enlace nunca entra en una cuenta de la administración ni de otro cliente, aunque cambie después', async () => {
  const cliente = await createClient(ctx);
  const otro = await createClient(ctx, { withUser: true });

  // Un usuario de otro cliente guardado con otras mayúsculas tampoco cuela.
  const raro = correoNuevo();
  const usuarioRaro = db.prepare('SELECT id FROM users WHERE email = ?').get(otro.userEmail!) as { id: string };
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(raro.toUpperCase(), usuarioRaro.id);
  const mayusculas = await invitar(cliente.clientId, { email: raro });
  assert.equal(mayusculas.statusCode, 409);
  assert.equal(mayusculas.json().code, 'user_exists');

  // Correo libre al crear el enlace, de otro cliente al aceptarlo.
  const email = correoNuevo();
  const creado = (await invitar(cliente.clientId, { email })).json() as { invite: { id: string; url: string } };
  const token = tokenDe(creado.invite.url);
  const alta = await ctx.app.inject({
    method: 'POST',
    url: `/api/clients/${otro.clientId}/users`,
    headers: { cookie: ctx.adminCookie },
    payload: { email, name: 'De otro cliente', password: 'clave-de-otro-cliente' },
  });
  assert.equal(alta.statusCode, 200, alta.body);
  const pagina = await ctx.app.inject({ method: 'GET', url: `/api/invite/${token}` });
  assert.equal(pagina.statusCode, 200, pagina.body);
  assert.equal(pagina.json().existingUser, false, 'no es un usuario de este cliente');
  const rechazo = await aceptar(token, { name: 'Intruso', password: 'clave-del-intruso-1' });
  assert.equal(rechazo.statusCode, 409);
  assert.equal(rechazo.json().code, 'user_exists');
  assert.equal(cookieFrom(rechazo), '', 'sin sesión');
  assert.equal((await entrar(email, 'clave-de-otro-cliente')).statusCode, 200, 'su contraseña no ha cambiado');
  assert.equal((await entrar(email, 'clave-del-intruso-1')).statusCode, 401);
  const invitacion = db.prepare('SELECT accepted_at FROM client_invites WHERE id = ?').get(creado.invite.id) as {
    accepted_at: number | null;
  };
  assert.equal(invitacion.accepted_at, null);

  // Lo mismo si pasa a ser el de la administración.
  const email2 = correoNuevo();
  const creado2 = (await invitar(cliente.clientId, { email: email2 })).json() as { invite: { url: string } };
  const admin = db.prepare("SELECT id, email FROM users WHERE role = 'admin' LIMIT 1").get() as { id: string; email: string };
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email2, admin.id);
  try {
    const contraAdmin = await aceptar(tokenDe(creado2.invite.url), { name: 'Intruso', password: 'clave-del-intruso-1' });
    assert.equal(contraAdmin.statusCode, 409);
    assert.equal(contraAdmin.json().code, 'user_exists');
    const rol = db.prepare('SELECT role, client_id FROM users WHERE id = ?').get(admin.id) as { role: string; client_id: string | null };
    assert.deepEqual(rol, { role: 'admin', client_id: null });
  } finally {
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(admin.email, admin.id);
  }
  assert.equal((await entrar(admin.email, 'clave-admin-segura')).statusCode, 200, 'la administración sigue entrando');

  // Y si el correo pasa a ser de un usuario de ESTE cliente, se le pone la
  // contraseña elegida en lugar de crear otro.
  const email3 = correoNuevo();
  const creado3 = (await invitar(cliente.clientId, { email: email3 })).json() as { invite: { url: string } };
  const propio = await ctx.app.inject({
    method: 'POST',
    url: `/api/clients/${cliente.clientId}/users`,
    headers: { cookie: ctx.adminCookie },
    payload: { email: email3, name: 'Alta manual', password: 'clave-de-alta-manual' },
  });
  assert.equal(propio.statusCode, 200, propio.body);
  const ok = await aceptar(tokenDe(creado3.invite.url), { password: 'clave-elegida-por-el' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await entrar(email3, 'clave-elegida-por-el')).statusCode, 200);
  const cuenta = db.prepare('SELECT COUNT(*) AS c FROM users WHERE email = ?').get(email3) as { c: number };
  assert.equal(cuenta.c, 1);
});

test('postmaster y abuse: se crean de una vez y no cuentan para el plan', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const { domainId, domain } = await createDomain(ctx, cliente.clientId);
  const buzon = await createMailbox(ctx, domainId, 'ana');
  const ruta = `/api/domains/${domainId}/essential-addresses`;

  const antes = await ctx.app.inject({ method: 'GET', url: ruta, headers: { cookie: cliente.userCookie! } });
  assert.deepEqual(
    (antes.json() as { addresses: { localPart: string; kind: string | null }[] }).addresses.map((a) => [a.localPart, a.kind]),
    [['postmaster', null], ['abuse', null]],
  );

  // Aunque el plan no admita ni un alias más.
  const planId = (db.prepare('SELECT plan_id FROM clients WHERE id = ?').get(cliente.clientId) as { plan_id: string }).plan_id;
  const maxAntes = (db.prepare('SELECT max_aliases FROM plans WHERE id = ?').get(planId) as { max_aliases: number }).max_aliases;
  db.prepare('UPDATE plans SET max_aliases = 0 WHERE id = ?').run(planId);
  try {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: ruta,
      headers: { cookie: cliente.userCookie! },
      payload: { destinations: [buzon.email, 'gerencia@gmail.com'] },
    });
    assert.equal(res.statusCode, 200, res.body);
    const direcciones = (res.json() as { addresses: { email: string; kind: string; destinations: string[] }[] }).addresses;
    assert.deepEqual(direcciones.map((a) => [a.email, a.kind]), [
      [`postmaster@${domain}`, 'alias'],
      [`abuse@${domain}`, 'alias'],
    ]);
    assert.deepEqual(direcciones[0]!.destinations, [buzon.email, 'gerencia@gmail.com']);

    // Repetir actualiza, no duplica.
    const otra = await ctx.app.inject({ method: 'PUT', url: ruta, headers: { cookie: ctx.adminCookie }, payload: { destinations: [buzon.email] } });
    assert.equal(otra.statusCode, 200, otra.body);
    const filas = db.prepare('SELECT COUNT(*) AS c FROM aliases WHERE domain_id = ?').get(domainId) as { c: number };
    assert.equal(filas.c, 2);

    // Fuera del recuento del plan: el resumen sigue en 0 alias.
    const resumen = await ctx.app.inject({
      method: 'GET',
      url: '/api/dashboard/client',
      headers: { cookie: cliente.userCookie! },
    });
    assert.equal(resumen.json().usage.aliases, 0);
    assert.equal(resumen.json().onboarding.hasEssentialAddresses, true);
    assert.equal(resumen.json().onboarding.ownershipVerified, true);
    assert.equal(resumen.json().onboarding.mailboxes, 1);

    // Un alias normal sí choca con el plan.
    const normal = await ctx.app.inject({
      method: 'POST',
      url: '/api/aliases',
      headers: { cookie: cliente.userCookie! },
      payload: { domainId, localPart: 'info', destinations: [buzon.email] },
    });
    assert.equal(normal.statusCode, 400);
  } finally {
    db.prepare('UPDATE plans SET max_aliases = ? WHERE id = ?').run(maxAntes, planId);
  }

  // De otro cliente, no.
  const ajeno = await createClient(ctx, { withUser: true });
  const deOtro = await ctx.app.inject({ method: 'PUT', url: ruta, headers: { cookie: ajeno.userCookie! }, payload: { destinations: [buzon.email] } });
  assert.equal(deOtro.statusCode, 403);
});

test('postmaster y abuse: un buzón con ese nombre se respeta y la propiedad es obligatoria', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId);
  const buzon = await createMailbox(ctx, domainId, 'postmaster');
  const res = await ctx.app.inject({
    method: 'PUT',
    url: `/api/domains/${domainId}/essential-addresses`,
    headers: { cookie: ctx.adminCookie },
    payload: { destinations: [buzon.email] },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    (res.json() as { addresses: { localPart: string; kind: string }[] }).addresses.map((a) => [a.localPart, a.kind]),
    [['postmaster', 'mailbox'], ['abuse', 'alias']],
  );

  const otro = await createClient(ctx);
  const { domainId: sinPropiedad } = await createDomain(ctx, otro.clientId);
  setDomainOwnership(sinPropiedad, false);
  const pendiente = await ctx.app.inject({
    method: 'PUT',
    url: `/api/domains/${sinPropiedad}/essential-addresses`,
    headers: { cookie: ctx.adminCookie },
    payload: { destinations: ['alguien@gmail.com'] },
  });
  assert.equal(pendiente.statusCode, 409);
  assert.equal(pendiente.json().code, 'domain_ownership_pending');
});

test('alta masiva con enlace de configuración para cada buzón', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const { domainId } = await createDomain(ctx, cliente.clientId);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/mailboxes/bulk',
    headers: { cookie: cliente.userCookie! },
    payload: {
      domainId,
      entries: [
        { localPart: 'ana.garcia', displayName: 'Ana García' },
        { localPart: 'luis', displayName: 'Luis Pérez' },
      ],
      setupLinks: { ttlHours: 168 },
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const resultados = (res.json() as {
    results: { ok: boolean; password: string; setupLink: { url: string; expiresAt: number; hasPassword: boolean } }[];
  }).results;
  assert.equal(resultados.length, 2);
  for (const r of resultados) {
    assert.ok(r.ok);
    assert.equal(r.setupLink.hasPassword, true);
    assert.ok(Math.abs(r.setupLink.expiresAt - (Date.now() + 168 * 3600_000)) < 60_000);
    const token = /\/conectar\/([A-Za-z0-9_-]+)$/.exec(r.setupLink.url)![1]!;
    const pagina = await ctx.app.inject({ method: 'GET', url: `/api/public/setup/${token}` });
    assert.equal(pagina.json().password, r.password, 'el enlace lleva la contraseña del buzón');
  }

  // Sin la opción, como siempre: sin enlaces.
  const sin = await ctx.app.inject({
    method: 'POST',
    url: '/api/mailboxes/bulk',
    headers: { cookie: ctx.adminCookie },
    payload: { domainId, entries: [{ localPart: 'marta' }] },
  });
  assert.equal(sin.statusCode, 200, sin.body);
  assert.equal((sin.json() as { results: { setupLink?: unknown }[] }).results[0]!.setupLink, undefined);
});
