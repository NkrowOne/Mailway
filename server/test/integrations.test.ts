import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { createAppPassword } from '../src/modules/apppasswords';
import {
  adminContext,
  createClient,
  createDomain,
  createMailbox,
  type TestContext,
} from './helpers';

/**
 * API de integraciones (Skyway, scripts): información de la instancia,
 * alta idempotente por referencia externa, vínculos y resumen por cliente.
 */

let ctx: TestContext;
let adminToken: string;

interface ClientView {
  id: string;
  name: string;
  slug: string;
  planId: string;
  externalRef: string | null;
  plan: { id: string };
  usage: { domains: number };
}

async function tokenDe(cookie: string, name: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: { cookie },
    payload: { name },
  });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { token: string }).token;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function ensure(
  payload: Record<string, unknown>,
  headers: Record<string, string> = bearer(adminToken),
) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/integrations/clients/ensure',
    headers,
    payload,
  });
}

before(async () => {
  ctx = await adminContext();
  adminToken = await tokenDe(ctx.adminCookie, 'Skyway');
});

test('info: datos de la instancia; el token de Traefik solo para administradores', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/api/integrations/info',
    headers: { ...bearer(adminToken), host: 'panel.ejemplo.test' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const info = res.json() as Record<string, any>;
  assert.equal(info.version, '1.0.0');
  assert.equal(info.user.role, 'admin');
  assert.equal(info.imap.port, 993);
  assert.equal(info.smtp.port, 465);
  assert.equal(info.submission.port, 587);
  assert.equal(info.submission.security, 'STARTTLS');
  assert.equal(info.panelUrl, 'http://panel.ejemplo.test');
  assert.equal(typeof info.features.cloudflare, 'boolean');
  assert.equal(typeof info.features.autoconfig, 'boolean');
  assert.equal(info.features.portal, true);
  assert.equal(info.traefik.configPath, '/api/traefik/config');
  assert.ok(info.traefik.token.length > 10);

  const cliente = await createClient(ctx, { withUser: true });
  const clienteToken = await tokenDe(cliente.userCookie!, 'Script del cliente');
  const deCliente = await ctx.app.inject({
    method: 'GET',
    url: '/api/integrations/info',
    headers: bearer(clienteToken),
  });
  assert.equal(deCliente.statusCode, 200);
  const infoCliente = deCliente.json() as Record<string, any>;
  assert.equal(infoCliente.user.role, 'client');
  assert.equal(infoCliente.traefik, null);

  const anonimo = await ctx.app.inject({ method: 'GET', url: '/api/integrations/info' });
  assert.equal(anonimo.statusCode, 401);
});

test('ensure es idempotente por externalRef y usa el primer plan por defecto', async () => {
  const primera = await ensure({
    externalRef: 'skyway:project:abc123',
    name: 'Proyecto Ábaco',
    contactEmail: 'equipo@abaco.test',
  });
  assert.equal(primera.statusCode, 200, primera.body);
  const a = primera.json() as { client: ClientView; created: boolean };
  assert.equal(a.created, true);
  assert.equal(a.client.externalRef, 'skyway:project:abc123');
  assert.equal(a.client.slug, 'proyecto-abaco');
  const primerPlan = db
    .prepare('SELECT id FROM plans ORDER BY created_at ASC, rowid ASC LIMIT 1')
    .get() as { id: string };
  assert.equal(a.client.planId, primerPlan.id);
  assert.equal(a.client.plan.id, primerPlan.id);

  const segunda = await ensure({ externalRef: 'skyway:project:abc123', name: 'Otro nombre' });
  const b = segunda.json() as { client: ClientView; created: boolean };
  assert.equal(b.created, false);
  assert.equal(b.client.id, a.client.id);
  assert.equal(b.client.name, 'Proyecto Ábaco', 'un cliente existente no se modifica');

  const n = db
    .prepare(`SELECT COUNT(*) AS c FROM clients WHERE external_ref = 'skyway:project:abc123'`)
    .get() as { c: number };
  assert.equal(n.c, 1);
  const altas = db
    .prepare(`SELECT client_id, detail FROM audit_log WHERE action = 'client.created' AND detail LIKE ?`)
    .all('%skyway:project:abc123%') as { client_id: string; detail: string }[];
  assert.equal(altas.length, 1, 'solo se audita la creación real');
  assert.equal(altas[0]!.client_id, a.client.id);
  assert.equal(JSON.parse(altas[0]!.detail).via, 'token:Skyway');

  // Mismo nombre, otra referencia: otro cliente con slug propio.
  const tercera = await ensure({ externalRef: 'skyway:project:def456', name: 'Proyecto Ábaco' });
  const c = tercera.json() as { client: ClientView; created: boolean };
  assert.equal(c.created, true);
  assert.equal(c.client.slug, 'proyecto-abaco-2');

  // Plan explícito.
  const conPlan = await ensure({
    externalRef: 'skyway:project:plan',
    name: 'Con plan',
    planId: 'plan_agencia',
  });
  assert.equal((conPlan.json() as { client: ClientView }).client.planId, 'plan_agencia');
});

test('ensure valida la entrada y exige administrador', async () => {
  for (const externalRef of ['', 'ab', '-empieza-mal', 'con espacio', 'x'.repeat(201), 'ñandú:1']) {
    const res = await ensure({ externalRef, name: 'Cliente' });
    assert.equal(res.statusCode, 400, externalRef);
  }
  const sinNombre = await ensure({ externalRef: 'skyway:project:sin-nombre' });
  assert.equal(sinNombre.statusCode, 400);
  const planInexistente = await ensure({
    externalRef: 'skyway:project:plan-malo',
    name: 'Cliente',
    planId: 'plan_que_no_existe',
  });
  assert.equal(planInexistente.statusCode, 400);
  assert.equal((planInexistente.json() as { code: string }).code, 'plan_not_found');

  const cliente = await createClient(ctx, { withUser: true });
  const clienteToken = await tokenDe(cliente.userCookie!, 'Cliente');
  const prohibido = await ensure({ externalRef: 'skyway:project:x1', name: 'Intruso' }, bearer(clienteToken));
  assert.equal(prohibido.statusCode, 403);
});

test('vincular, conflicto 409, buscar por referencia y desvincular', async () => {
  const manual = await createClient(ctx, { name: 'Cliente manual' });
  const otro = await ensure({ externalRef: 'skyway:project:ocupada', name: 'Ya vinculado' });
  const otroId = (otro.json() as { client: ClientView }).client.id;

  const conflicto = await ctx.app.inject({
    method: 'PUT',
    url: `/api/integrations/clients/${manual.clientId}/link`,
    headers: bearer(adminToken),
    payload: { externalRef: 'skyway:project:ocupada' },
  });
  assert.equal(conflicto.statusCode, 409);
  assert.equal((conflicto.json() as { code: string }).code, 'external_ref_in_use');

  const vincular = await ctx.app.inject({
    method: 'PUT',
    url: `/api/integrations/clients/${manual.clientId}/link`,
    headers: bearer(adminToken),
    payload: { externalRef: 'skyway:project:manual' },
  });
  assert.equal(vincular.statusCode, 200, vincular.body);
  assert.equal((vincular.json() as { client: ClientView }).client.externalRef, 'skyway:project:manual');

  // Repetir el mismo vínculo es inocuo y no duplica la auditoría.
  const repetir = await ctx.app.inject({
    method: 'PUT',
    url: `/api/integrations/clients/${manual.clientId}/link`,
    headers: bearer(adminToken),
    payload: { externalRef: 'skyway:project:manual' },
  });
  assert.equal(repetir.statusCode, 200);
  const vinculos = db
    .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'client.external_linked' AND client_id = ?`)
    .get(manual.clientId) as { c: number };
  assert.equal(vinculos.c, 1);

  const buscar = await ctx.app.inject({
    method: 'GET',
    url: '/api/integrations/clients/by-ref?externalRef=skyway:project:manual',
    headers: bearer(adminToken),
  });
  assert.equal(buscar.statusCode, 200);
  assert.equal((buscar.json() as { client: ClientView }).client.id, manual.clientId);

  // ensure con la referencia vinculada devuelve el cliente manual.
  const adoptado = await ensure({ externalRef: 'skyway:project:manual', name: 'Da igual' });
  assert.equal((adoptado.json() as { client: ClientView; created: boolean }).created, false);
  assert.equal((adoptado.json() as { client: ClientView }).client.id, manual.clientId);

  const desvincular = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/integrations/clients/${manual.clientId}/link`,
    headers: bearer(adminToken),
  });
  assert.equal(desvincular.statusCode, 200);
  assert.equal((desvincular.json() as { client: ClientView }).client.externalRef, null);
  const desvinculos = db
    .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'client.external_unlinked' AND client_id = ?`)
    .get(manual.clientId) as { c: number };
  assert.equal(desvinculos.c, 1);

  const yaNo = await ctx.app.inject({
    method: 'GET',
    url: '/api/integrations/clients/by-ref?externalRef=skyway:project:manual',
    headers: bearer(adminToken),
  });
  assert.equal(yaNo.statusCode, 404);
  assert.equal((yaNo.json() as { code: string }).code, 'client_not_found');

  const inexistente = await ctx.app.inject({
    method: 'PUT',
    url: '/api/integrations/clients/cli_no_existe/link',
    headers: bearer(adminToken),
    payload: { externalRef: 'skyway:project:nada' },
  });
  assert.equal(inexistente.statusCode, 404);

  const sinRef = await ctx.app.inject({
    method: 'GET',
    url: '/api/integrations/clients/by-ref',
    headers: bearer(adminToken),
  });
  assert.equal(sinRef.statusCode, 400);
  assert.ok(otroId);
});

test('resumen: un token de cliente lee el suyo y no el de otro cliente', async () => {
  const propio = await createClient(ctx, { withUser: true });
  const ajeno = await createClient(ctx);
  const { domainId } = await createDomain(ctx, propio.clientId);
  const buzon = await createMailbox(ctx, domainId, 'ventas');
  db.prepare('UPDATE mailboxes SET used_bytes = ? WHERE id = ?').run(123456, buzon.mailboxId);
  const app = await createAppPassword(buzon.mailboxId, 'Móvil', null);
  const clave = await ctx.app.inject({
    method: 'POST',
    url: '/api/apikeys',
    headers: { cookie: ctx.adminCookie },
    payload: { clientId: propio.clientId, name: 'OTP', senderMailboxId: buzon.mailboxId },
  });
  assert.equal(clave.statusCode, 200, clave.body);

  const clienteToken = await tokenDe(propio.userCookie!, 'Resumen');
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/integrations/clients/${propio.clientId}/summary`,
    headers: bearer(clienteToken),
  });
  assert.equal(res.statusCode, 200, res.body);
  const resumen = res.json() as Record<string, any>;
  assert.equal(resumen.client.id, propio.clientId);
  assert.equal(resumen.client.externalRef, null);
  assert.equal(resumen.domains.length, 1);
  assert.equal(resumen.mailboxes.length, 1);
  assert.equal(resumen.mailboxes[0].email, buzon.email);
  assert.equal(resumen.mailboxes[0].usedBytes, 123456);
  assert.equal(resumen.apiKeys.length, 1);
  assert.equal(resumen.apiKeys[0].senderEmail, buzon.email);
  assert.equal(resumen.apiKeys[0].usedToday, 0);
  assert.equal(resumen.appPasswords.length, 1);
  assert.equal(resumen.appPasswords[0].id, app.appPassword.id);
  assert.equal(resumen.connection.imap.port, 993);
  assert.equal(resumen.connection.submission.port, 587);
  assert.equal(resumen.usage.mailboxes, 1);
  assert.ok(!res.body.includes(app.password), 'la contraseña de aplicación no vuelve a salir');
  assert.ok(!res.body.includes('stored_secret') && !res.body.includes('$app$'));

  const otro = await ctx.app.inject({
    method: 'GET',
    url: `/api/integrations/clients/${ajeno.clientId}/summary`,
    headers: bearer(clienteToken),
  });
  assert.equal(otro.statusCode, 403);

  // Un id inexistente también da 403 a un cliente: no puede sondear ids.
  const sondeo = await ctx.app.inject({
    method: 'GET',
    url: '/api/integrations/clients/cli_no_existe/summary',
    headers: bearer(clienteToken),
  });
  assert.equal(sondeo.statusCode, 403);

  const admin = await ctx.app.inject({
    method: 'GET',
    url: `/api/integrations/clients/${ajeno.clientId}/summary`,
    headers: bearer(adminToken),
  });
  assert.equal(admin.statusCode, 200);
  const noExiste = await ctx.app.inject({
    method: 'GET',
    url: '/api/integrations/clients/cli_no_existe/summary',
    headers: bearer(adminToken),
  });
  assert.equal(noExiste.statusCode, 404);
});

test('las rutas de clientes de integración son solo para administradores', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const clienteToken = await tokenDe(cliente.userCookie!, 'Limitado');
  const rutas: { method: 'GET' | 'PUT' | 'DELETE'; url: string; payload?: unknown }[] = [
    { method: 'GET', url: '/api/integrations/clients/by-ref?externalRef=skyway:project:abc123' },
    {
      method: 'PUT',
      url: `/api/integrations/clients/${cliente.clientId}/link`,
      payload: { externalRef: 'skyway:project:mio' },
    },
    { method: 'DELETE', url: `/api/integrations/clients/${cliente.clientId}/link` },
  ];
  for (const ruta of rutas) {
    const res = await ctx.app.inject({ ...ruta, headers: bearer(clienteToken) });
    assert.equal(res.statusCode, 403, `${ruta.method} ${ruta.url}`);
  }
});
