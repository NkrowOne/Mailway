import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { revertirPropiedadSimulada } from '../src/modules/demo';
import { markSetupComplete } from '../src/modules/settings';
import { adminContext, createClient, createDomain, type TestContext } from './helpers';

/*
 * Modo demostración: la propiedad de un dominio solo se comprueba con un MX o
 * un TXT reales, así que en la demostración no se podía crear ningún buzón
 * («Ningún dominio admite buzones en este momento»). Ahora se puede simular,
 * solo con MAILWAY_DEMO=1 y con acceso al cliente, y lo simulado se deshace
 * al arrancar sin demostración.
 */

let ctx: TestContext;
let cliente: Awaited<ReturnType<typeof createClient>>;
let otro: Awaited<ReturnType<typeof createClient>>;
let dominioId = '';

before(async () => {
  ctx = await adminContext();
  cliente = await createClient(ctx, { withUser: true });
  otro = await createClient(ctx, { withUser: true });
  dominioId = (await createDomain(ctx, cliente.clientId, 'panaderia-demo.test', { ownershipVerified: false })).domainId;
});

after(() => {
  config.demoMode = true;
});

function crearBuzon(cookie: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/mailboxes',
    headers: { cookie },
    payload: { domainId: dominioId, localPart: 'hola' },
  });
}

function simular(cookie: string, id = dominioId) {
  return ctx.app.inject({ method: 'POST', url: `/api/demo/domains/${id}/ownership`, headers: { cookie } });
}

test('sin simularla, la propiedad pendiente impide crear buzones', async () => {
  const res = await crearBuzon(cliente.userCookie!);
  assert.equal(res.statusCode, 409);
  assert.equal((res.json() as { code: string }).code, 'domain_ownership_pending');
});

test('otro cliente no puede simular la propiedad de un dominio ajeno', async () => {
  const res = await simular(otro.userCookie!);
  assert.equal(res.statusCode, 403);
});

test('el cliente la simula y ya puede crear buzones', async () => {
  const res = await simular(cliente.userCookie!);
  assert.equal(res.statusCode, 200, res.body);
  assert.ok((res.json() as { domain: { ownershipVerifiedAt: number | null } }).domain.ownershipVerifiedAt);
  const buzon = await crearBuzon(cliente.userCookie!);
  assert.equal(buzon.statusCode, 200, buzon.body);
  const anotada = db
    .prepare("SELECT action FROM audit_log WHERE action = 'domain.ownership_simulated'")
    .all();
  assert.equal(anotada.length, 1);
});

test('fuera del modo demostración la ruta no existe', async () => {
  config.demoMode = false;
  try {
    const res = await simular(ctx.adminCookie);
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as { code: string }).code, 'demo_only');
  } finally {
    config.demoMode = true;
  }
});

test('al arrancar sin demostración, lo simulado vuelve a quedar pendiente', async () => {
  // Uno comprobado de verdad no se toca.
  const real = await createDomain(ctx, otro.clientId, 'comprobado-real.test', { ownershipVerified: true });
  await simular(ctx.adminCookie, real.domainId);

  assert.equal(revertirPropiedadSimulada(), 0, 'en demostración no se deshace nada');
  config.demoMode = false;
  try {
    assert.equal(revertirPropiedadSimulada(), 1);
    const fila = (id: string) =>
      db.prepare('SELECT owner_verified_at FROM domains WHERE id = ?').get(id) as { owner_verified_at: number | null };
    assert.equal(fila(dominioId).owner_verified_at, null);
    assert.ok(fila(real.domainId).owner_verified_at, 'la propiedad comprobada de verdad se conserva');
    assert.equal(revertirPropiedadSimulada(), 0, 'solo una vez');
  } finally {
    config.demoMode = true;
  }
});

test('con sesión, el estado de la instancia dice que es una demostración', async () => {
  markSetupComplete();
  const conSesion = await ctx.app.inject({
    method: 'GET',
    url: '/api/setup/status',
    headers: { cookie: cliente.userCookie! },
  });
  assert.equal((conSesion.json() as { demoMode?: boolean }).demoMode, true);
  const anonimo = await ctx.app.inject({ method: 'GET', url: '/api/setup/status' });
  assert.equal((anonimo.json() as { demoMode?: boolean }).demoMode, undefined);
});
