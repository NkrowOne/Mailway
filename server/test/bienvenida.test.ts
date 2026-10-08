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
  const { invite } = res.json() as { invite: { id: string; url: string; email: string; expiresAt: number } };
  assert.equal(invite.email, email);
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

  const corta = await ctx.app.inject({
    method: 'POST',
    url: `/api/invite/${token}/accept`,
    payload: { name: 'Marta Ruiz', password: 'corta' },
  });
  assert.equal(corta.statusCode, 400);

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
});

test('enlace de bienvenida: solo la administración, uno por persona y con sus límites', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const email = correoNuevo();

  const delCliente = await invitar(cliente.clientId, { email }, cliente.userCookie!);
  assert.equal(delCliente.statusCode, 403);

  const yaExiste = await invitar(cliente.clientId, { email: cliente.userEmail! });
  assert.equal(yaExiste.statusCode, 409);
  assert.equal(yaExiste.json().code, 'user_exists');

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
