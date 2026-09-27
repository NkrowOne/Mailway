import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { adminContext, createClient, createDomain, type TestContext } from './helpers';

/**
 * Registro de actividad: acceso protegido, cada cliente ve lo suyo (también
 * lo que el administrador hizo por él), paginación y anotación de tokens.
 */

let ctx: TestContext;

interface Entry {
  id: number;
  action: string;
  clientId: string | null;
  detail: Record<string, unknown>;
  actor: { name: string; email: string | null; role: string } | null;
  clientName: string | null;
}

interface Page {
  entries: Entry[];
  nextBefore: number | null;
}

async function leer(url: string, headers: Record<string, string>): Promise<Page> {
  const res = await ctx.app.inject({ method: 'GET', url, headers });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as Page;
}

before(async () => {
  ctx = await adminContext();
});

test('sin sesión, /api/audit responde 401 (antes fallaba con 500)', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/audit' });
  assert.equal(res.statusCode, 401);
  assert.equal((res.json() as { code: string }).code, 'unauthorized');
});

test('cada cliente ve lo que el administrador hizo por él, y solo eso', async () => {
  const a = await createClient(ctx, { withUser: true });
  const b = await createClient(ctx, { withUser: true });
  const { domain } = await createDomain(ctx, a.clientId);

  const deA = await leer('/api/audit', { cookie: a.userCookie! });
  const alta = deA.entries.find((e) => e.action === 'domain.created');
  assert.ok(alta, 'el alta del dominio hecha por el administrador figura en la actividad del cliente');
  assert.equal(alta.detail.domain, domain);
  assert.equal(alta.actor?.role, 'admin');
  assert.equal(alta.actor?.email, null, 'el cliente no ve el correo personal del administrador');
  assert.ok(deA.entries.every((e) => e.clientId === a.clientId));

  // ?clientId no sirve a un cliente para leer otro cliente.
  const intento = await leer(`/api/audit?clientId=${a.clientId}`, { cookie: b.userCookie! });
  assert.ok(intento.entries.every((e) => e.clientId === b.clientId));
  assert.ok(!intento.entries.some((e) => e.action === 'domain.created'));

  const admin = await leer(`/api/audit?clientId=${a.clientId}`, { cookie: ctx.adminCookie });
  assert.ok(admin.entries.length > 0);
  assert.ok(admin.entries.every((e) => e.clientId === a.clientId));
  assert.ok(admin.entries.some((e) => e.actor?.email === 'admin@mailway.test'));
  assert.ok(admin.entries.every((e) => e.clientName !== null));
});

test('paginación con ?limit y ?before sin repetir ni saltar anotaciones', async () => {
  for (let i = 0; i < 5; i += 1) await createClient(ctx);
  const completo = await leer('/api/audit?limit=500', { cookie: ctx.adminCookie });
  const total = completo.entries.length;
  assert.ok(total >= 5);

  const vistos: number[] = [];
  let url = '/api/audit?limit=2';
  for (let vuelta = 0; vuelta < 200; vuelta += 1) {
    const page = await leer(url, { cookie: ctx.adminCookie });
    assert.ok(page.entries.length <= 2);
    vistos.push(...page.entries.map((e) => e.id));
    if (page.nextBefore === null) break;
    url = `/api/audit?limit=2&before=${page.nextBefore}`;
  }
  assert.deepEqual(vistos, completo.entries.map((e) => e.id));
  assert.equal(new Set(vistos).size, vistos.length);
});

test('parámetros de consulta no válidos devuelven 400', async () => {
  for (const url of ['/api/audit?limit=0', '/api/audit?limit=501', '/api/audit?limit=abc', '/api/audit?before=-3']) {
    const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie: ctx.adminCookie } });
    assert.equal(res.statusCode, 400, url);
  }
});

test('las acciones hechas con un token anotan «via: token:<nombre>»', async () => {
  const crear = await ctx.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: { cookie: ctx.adminCookie },
    payload: { name: 'Skyway' },
  });
  const { token } = crear.json() as { token: string };
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/clients',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Creado por Skyway', planId: 'plan_basico' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const entrada = db
    .prepare(`SELECT detail FROM audit_log WHERE action = 'client.created' ORDER BY id DESC LIMIT 1`)
    .get() as { detail: string };
  assert.equal(JSON.parse(entrada.detail).via, 'token:Skyway');
  assert.ok(!entrada.detail.includes(token));
});

test('audit() respeta el cliente afectado explícito y el deducido del detalle', async () => {
  const { audit } = await import('../src/modules/audit');
  const cliente = await createClient(ctx);
  const adminReq = {
    ip: '127.0.0.1',
    user: { id: 'usr_x', email: 'a@b.c', name: 'A', role: 'admin', clientId: null },
  } as unknown as Parameters<typeof audit>[0];
  audit(adminReq, 'prueba.explicita', { id: 'x' }, cliente.clientId);
  audit(adminReq, 'prueba.deducida', { clientId: cliente.clientId });
  audit(adminReq, 'prueba.sin_cliente', {});
  const filas = db
    .prepare(`SELECT action, client_id FROM audit_log WHERE action LIKE 'prueba.%'`)
    .all() as { action: string; client_id: string | null }[];
  const por = Object.fromEntries(filas.map((f) => [f.action, f.client_id]));
  assert.equal(por['prueba.explicita'], cliente.clientId);
  assert.equal(por['prueba.deducida'], cliente.clientId);
  assert.equal(por['prueba.sin_cliente'], null);

  // Un usuario de cliente siempre anota en su propio cliente.
  const clienteReq = {
    ip: '127.0.0.1',
    user: { id: 'usr_y', email: 'c@d.e', name: 'C', role: 'client', clientId: cliente.clientId },
  } as unknown as Parameters<typeof audit>[0];
  audit(clienteReq, 'prueba.cliente', {}, 'cli_otro');
  const propia = db
    .prepare(`SELECT client_id FROM audit_log WHERE action = 'prueba.cliente'`)
    .get() as { client_id: string };
  assert.equal(propia.client_id, cliente.clientId);
});
