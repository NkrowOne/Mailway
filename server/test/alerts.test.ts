import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { fireAlert, listAlerts, resolveAlert } from '../src/modules/alerts';
import { adminContext, createClient } from './helpers';

beforeEach(() => {
  db.prepare('DELETE FROM alerts').run();
});

const base = {
  severity: 'critical' as const,
  type: 'engine_down',
  title: 'El servidor de correo no responde',
  message: 'sin conexión',
  // quiet: no queremos que los tests intenten llamar a Discord/Telegram.
  quiet: true,
};

test('una alerta repetida no se duplica mientras siga abierta', () => {
  assert.equal(fireAlert({ ...base, dedupeKey: 'engine_down' }), true);
  assert.equal(fireAlert({ ...base, dedupeKey: 'engine_down' }), false);
  assert.equal(fireAlert({ ...base, dedupeKey: 'engine_down' }), false);
  assert.equal(listAlerts({}).length, 1);
});

test('tras resolverse, el mismo problema puede volver a avisar', () => {
  fireAlert({ ...base, dedupeKey: 'engine_down' });
  resolveAlert('engine_down');
  assert.equal(listAlerts({}).length, 0, 'la resuelta ya no cuenta como abierta');

  assert.equal(
    fireAlert({ ...base, dedupeKey: 'engine_down' }),
    true,
    'una recaída debe poder avisar otra vez',
  );
  assert.equal(listAlerts({}).length, 1);
  assert.equal(listAlerts({ includeResolved: true }).length, 2, 'queda el histórico');
});

test('claves distintas conviven como alertas independientes', () => {
  fireAlert({ ...base, dedupeKey: 'engine_down' });
  fireAlert({ ...base, type: 'webmail_down', dedupeKey: 'webmail_down' });
  fireAlert({ ...base, type: 'domain_dns_broken', dedupeKey: 'domain_dns:dom_1' });
  assert.equal(listAlerts({}).length, 3);

  resolveAlert('webmail_down');
  assert.equal(listAlerts({}).length, 2, 'resolver una no toca las demás');
});

test('resolver una clave inexistente no hace nada ni lanza', () => {
  assert.doesNotThrow(() => resolveAlert('no_existe'));
  assert.equal(listAlerts({}).length, 0);
});

test('listAlerts filtra por cliente', () => {
  fireAlert({ ...base, dedupeKey: 'global' });
  // clientId null = alerta del sistema; no debe colarse en la vista de un cliente.
  assert.equal(listAlerts({ clientId: 'cli_x' }).length, 0);
});

/* --------------------------- Rutas (app.inject) --------------------------- */

test('descartar un aviso lo cierra una sola vez y responde 404 si no existe', async () => {
  const ctx = await adminContext();
  fireAlert({ ...base, dedupeKey: 'descartable' });
  const [alerta] = listAlerts({});
  assert.ok(alerta);

  const auditados = () =>
    (db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'alert.dismissed'").get() as {
      c: number;
    }).c;
  const antes = auditados();

  const primero = await ctx.app.inject({
    method: 'POST',
    url: `/api/alerts/${alerta.id}/dismiss`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(primero.statusCode, 200);
  assert.equal(listAlerts({}).length, 0);

  const segundo = await ctx.app.inject({
    method: 'POST',
    url: `/api/alerts/${alerta.id}/dismiss`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(segundo.statusCode, 200, 'descartar dos veces no es un error');
  assert.equal(auditados(), antes + 1, 'solo el primer descarte queda auditado');

  for (const id of ['999999', 'no-es-un-numero']) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/alerts/${id}/dismiss`,
      headers: { cookie: ctx.adminCookie },
    });
    assert.equal(res.statusCode, 404, `id ${id}`);
  }
});

test('un usuario de cliente solo ve sus avisos y no puede descartarlos', async () => {
  const ctx = await adminContext();
  const { clientId, userCookie } = await createClient(ctx, { withUser: true });
  fireAlert({ ...base, dedupeKey: 'sistema' });
  fireAlert({ ...base, type: 'domain_dns_broken', dedupeKey: 'propia', clientId });

  const res = await ctx.app.inject({
    method: 'GET',
    url: '/api/alerts',
    headers: { cookie: userCookie! },
  });
  assert.equal(res.statusCode, 200);
  const alerts = (res.json() as { alerts: { clientId: string | null; id: number }[] }).alerts;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.clientId, clientId);

  const dismiss = await ctx.app.inject({
    method: 'POST',
    url: `/api/alerts/${alerts[0]!.id}/dismiss`,
    headers: { cookie: userCookie! },
  });
  assert.equal(dismiss.statusCode, 403);
});

test('los canales solo admiten URL http(s) y el token de Telegram se puede olvidar', async () => {
  const ctx = await adminContext();
  const put = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'PUT',
      url: '/api/notify/channels',
      headers: { cookie: ctx.adminCookie },
      payload: { webhookUrl: '', discordUrl: '', telegramToken: '', telegramChat: '', ...payload },
    });

  const invalida = await put({ webhookUrl: 'file:///tmp/canal' });
  assert.equal(invalida.statusCode, 400);
  assert.match(invalida.json().error, /webhook genérico/);

  // Sin canales, la prueba explica qué falta en lugar de fingir un envío.
  const prueba = await ctx.app.inject({
    method: 'POST',
    url: '/api/notify/test',
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(prueba.json().ok, false);
  assert.match(prueba.json().error, /canal/);

  assert.equal((await put({ telegramToken: '123:ABC', telegramChat: '-100' })).statusCode, 200);
  const leer = () =>
    ctx.app.inject({ method: 'GET', url: '/api/notify/channels', headers: { cookie: ctx.adminCookie } });
  assert.equal((await leer()).json().channels.hasTelegramToken, true);

  // Vacío conserva el token guardado…
  assert.equal((await put({ telegramChat: '-100' })).statusCode, 200);
  assert.equal((await leer()).json().channels.hasTelegramToken, true);

  // …y clearTelegramToken lo borra de verdad.
  assert.equal((await put({ telegramChat: '-100', clearTelegramToken: true })).statusCode, 200);
  assert.equal((await leer()).json().channels.hasTelegramToken, false);
});
