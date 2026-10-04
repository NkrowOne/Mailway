import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { listAlerts } from '../src/modules/alerts';
import { revisarCaducidadTokens } from '../src/modules/watchdog';
import { adminContext, createClient, type TestContext } from './helpers';

/*
 * Caducidad de los tokens de gestión. Un token con caducidad que usa una
 * integración (Skyway, un script) deja de funcionar el día que caduca, y
 * antes solo lo decía la lista de Conexiones: nadie recibía ningún aviso.
 */

const DIA = 24 * 3600_000;
let ctx: TestContext;
let clienteCookie = '';
let clienteId = '';

before(async () => {
  ctx = await adminContext();
  const cliente = await createClient(ctx, { withUser: true });
  clienteCookie = cliente.userCookie!;
  clienteId = cliente.clientId;
});

beforeEach(() => {
  db.prepare('DELETE FROM alerts').run();
  db.prepare('DELETE FROM management_tokens').run();
});

async function crearToken(cookie: string, name: string, dias: number | null): Promise<{ id: string; token: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: { cookie },
    payload: { name, expiresInDays: dias },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { token: string; info: { id: string } };
  return { id: body.info.id, token: body.token };
}

function usar(id: string, haceMs = 3600_000): void {
  db.prepare('UPDATE management_tokens SET last_used_at = ? WHERE id = ?').run(Date.now() - haceMs, id);
}

function avisos(tipo: string) {
  return listAlerts({}).filter((a) => a.type === tipo);
}

test('avisa 14 días antes de que caduque un token en uso', async () => {
  const lejano = await crearToken(ctx.adminCookie, 'Script mensual', 60);
  const cercano = await crearToken(ctx.adminCookie, 'Skyway', 10);
  usar(lejano.id);
  usar(cercano.id);
  revisarCaducidadTokens();
  const abiertos = avisos('token_expiring');
  assert.equal(abiertos.length, 1);
  assert.match(abiertos[0]!.title, /«Skyway» caduca el/);
  assert.match(abiertos[0]!.remedy, /--emparejar/);
  assert.equal(abiertos[0]!.clientId, null);
});

test('un token que nadie usa no avisa', async () => {
  await crearToken(ctx.adminCookie, 'Sin usar', 5);
  revisarCaducidadTokens();
  assert.equal(avisos('token_expiring').length, 0);
});

test('al caducar, el aviso pasa a crítico; al revocarlo, se cierra', async () => {
  const t = await crearToken(ctx.adminCookie, 'Skyway', 5);
  usar(t.id);
  revisarCaducidadTokens();
  assert.equal(avisos('token_expiring').length, 1);

  // Seis días después ya ha caducado.
  revisarCaducidadTokens(Date.now() + 6 * DIA);
  assert.equal(avisos('token_expiring').length, 0);
  const caducado = avisos('token_expired');
  assert.equal(caducado.length, 1);
  assert.equal(caducado[0]!.severity, 'critical');

  db.prepare('UPDATE management_tokens SET revoked_at = ? WHERE id = ?').run(Date.now(), t.id);
  revisarCaducidadTokens(Date.now() + 6 * DIA);
  assert.equal(avisos('token_expired').length, 0);
});

test('el de un cliente se le muestra en su panel', async () => {
  const t = await crearToken(clienteCookie, 'Copias nocturnas', 3);
  usar(t.id);
  revisarCaducidadTokens();
  const abiertos = avisos('token_expiring');
  assert.equal(abiertos.length, 1);
  assert.equal(abiertos[0]!.clientId, clienteId);
  assert.doesNotMatch(abiertos[0]!.remedy, /Skyway/);
  const res = await ctx.app.inject({ method: 'GET', url: '/api/alerts', headers: { cookie: clienteCookie } });
  assert.ok((res.json() as { alerts: { type: string }[] }).alerts.some((a) => a.type === 'token_expiring'));
});

test('la información de la integración devuelve la caducidad del token', async () => {
  const conCaducidad = await crearToken(ctx.adminCookie, 'Skyway', 30);
  const sinCaducidad = await crearToken(ctx.adminCookie, 'Otro', null);
  const info = async (headers: Record<string, string>) =>
    (await ctx.app.inject({ method: 'GET', url: '/api/integrations/info', headers })).json() as {
      tokenExpiresAt: number | null;
    };
  const a = await info({ authorization: `Bearer ${conCaducidad.token}` });
  assert.ok(a.tokenExpiresAt && Math.abs(a.tokenExpiresAt - (Date.now() + 30 * DIA)) < 60_000);
  assert.equal((await info({ authorization: `Bearer ${sinCaducidad.token}` })).tokenExpiresAt, null);
  assert.equal((await info({ cookie: ctx.adminCookie })).tokenExpiresAt, null);
});
