import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { getEngine } from '../src/engine';
import type { DemoEngine } from '../src/engine/demo';
import { esReglaDeMailway, normalizarDominiosRemotos, reglasRecepcionRemota } from '../src/engine/recepcion';
import { evaluarRecepcionExterna, getDomain, type DomainRecord } from '../src/modules/domains';
import { dominiosConRecepcionExterna, sincronizarRecepcionExterna } from '../src/modules/recepcion';
import { setInstanceSettings } from '../src/modules/settings';
import { instalarDnsFalso } from './dns-falso';
import { adminContext, createClient, createDomain, type TestContext } from './helpers';

/*
 * Dominios con buzones aquí y el correo en otro proveedor (traslado en
 * preparación, o solo el envío en Mailway): el motor debe entregar por su MX
 * lo que se envía desde aquí, no en local. Las reglas de Stalwart se
 * comprobaron contra una 0.15.5 real; aquí se prueba cuándo entra y sale un
 * dominio de la lista y qué reglas se generan.
 */

let ctx: TestContext;

before(async () => {
  ctx = await adminContext();
  setInstanceSettings({ mailHostname: 'mail.servidor.test' });
});

test('la recepción es externa si hay MX y ninguno es de este servidor; sin datos, no se decide', () => {
  const propios = ['mail.servidor.test', 'mail.servidor.test.'];
  assert.equal(evaluarRecepcionExterna([{ priority: 1, exchange: 'aspmx.l.google.com' }], propios), true);
  assert.equal(
    evaluarRecepcionExterna(
      [
        { priority: 10, exchange: 'MAIL.servidor.test.' },
        { priority: 20, exchange: 'respaldo.otro.test' },
      ],
      propios,
    ),
    false,
  );
  assert.equal(evaluarRecepcionExterna([], propios), false, 'sin MX no recibe en ningún otro sitio');
  assert.equal(evaluarRecepcionExterna(null, propios), null, 'un corte de red no es un «no»');
});

test('las reglas del motor: solo nombres DNS válidos, en orden y con los valores por defecto detrás', () => {
  assert.deepEqual(normalizarDominiosRemotos(['B.es.', 'a.es', "x'.es", 'a.es']), ['a.es', 'b.es']);
  assert.deepEqual(reglasRecepcionRemota([]), {}, 'sin dominios, el motor vuelve a sus valores por defecto');
  const reglas = reglasRecepcionRemota(['b.es', 'a.es']);
  assert.deepEqual(reglas, {
    'session.rcpt.directory.0000.if': "!is_empty(authenticated_as) && (rcpt_domain == 'a.es' || rcpt_domain == 'b.es')",
    'session.rcpt.directory.0000.then': 'false',
    'session.rcpt.directory.0001.else': "'*'",
    'queue.strategy.route.0000.if':
      "source != 'unauthenticated' && source != 'dmarc_pass' && (rcpt_domain == 'a.es' || rcpt_domain == 'b.es')",
    'queue.strategy.route.0000.then': "'mx'",
    'queue.strategy.route.0001.if': "is_local_domain('*', rcpt_domain)",
    'queue.strategy.route.0001.then': "'local'",
    'queue.strategy.route.0002.else': "'mx'",
    'queue.strategy.schedule.0000.if':
      "source != 'unauthenticated' && source != 'dmarc_pass' && (rcpt_domain == 'a.es' || rcpt_domain == 'b.es')",
    'queue.strategy.schedule.0000.then': "if_then(source == 'dsn', 'dsn', if_then(source == 'report', 'report', 'remote'))",
    'queue.strategy.schedule.0001.if': "is_local_domain('*', rcpt_domain)",
    'queue.strategy.schedule.0001.then': "'local'",
    'queue.strategy.schedule.0002.if': "source == 'dsn'",
    'queue.strategy.schedule.0002.then': "'dsn'",
    'queue.strategy.schedule.0003.if': "source == 'report'",
    'queue.strategy.schedule.0003.then': "'report'",
    'queue.strategy.schedule.0004.else': "'remote'",
  });
  assert.equal(esReglaDeMailway(reglas), true);
  assert.equal(esReglaDeMailway({}), true);
  assert.equal(esReglaDeMailway({ ...reglas, 'queue.strategy.route.0002.else': "'relay'" }), false);
  assert.equal(esReglaDeMailway({ 'session.rcpt.directory': "'*'" }), false);
});

test('al medir, un dominio con el MX en otro proveedor entra en la lista del motor y sale al hacer el cambio', async (t) => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId, 'traslado-t2.es');
  const motor = getEngine() as DemoEngine;

  const zona = { mx: { 'traslado-t2.es': [{ priority: 1, exchange: 'aspmx.l.google.com' }] } };
  instalarDnsFalso(t, zona);
  let res = await ctx.app.inject({
    method: 'POST',
    url: `/api/domains/${domainId}/verify`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as { domain: DomainRecord }).domain.recepcionExterna, true);
  await sincronizarRecepcionExterna();
  assert.deepEqual(dominiosConRecepcionExterna(), ['traslado-t2.es']);
  assert.deepEqual(motor.remoteDomains, ['traslado-t2.es']);

  // El MX pasa a este servidor: en la siguiente medición sale de la lista.
  zona.mx['traslado-t2.es'] = [{ priority: 10, exchange: 'mail.servidor.test' }];
  res = await ctx.app.inject({
    method: 'POST',
    url: `/api/domains/${domainId}/verify`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal((res.json() as { domain: DomainRecord }).domain.recepcionExterna, false);
  await sincronizarRecepcionExterna();
  assert.deepEqual(motor.remoteDomains, []);
});

test('una consulta del MX que falla no cambia la recepción', async (t) => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId, 'corte-t2.es');
  const zona = { mx: { 'corte-t2.es': [{ priority: 1, exchange: 'mx.otro.test' }] } };
  instalarDnsFalso(t, zona);
  await ctx.app.inject({ method: 'POST', url: `/api/domains/${domainId}/verify`, headers: { cookie: ctx.adminCookie } });
  assert.equal(getDomain(domainId).recepcionExterna, true);
  // Sin red: el MX no se puede consultar y se conserva lo anterior.
  process.env.MAILWAY_DNS_OFFLINE = '1';
  await ctx.app.inject({ method: 'POST', url: `/api/domains/${domainId}/verify`, headers: { cookie: ctx.adminCookie } });
  assert.equal(getDomain(domainId).recepcionExterna, true);
});

test('borrar un dominio con el correo en otro proveedor lo saca de la lista del motor', async (t) => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId, 'baja-t2.es');
  instalarDnsFalso(t, { mx: { 'baja-t2.es': [{ priority: 1, exchange: 'mx.otro.test' }] } });
  await ctx.app.inject({ method: 'POST', url: `/api/domains/${domainId}/verify`, headers: { cookie: ctx.adminCookie } });
  await sincronizarRecepcionExterna();
  const motor = getEngine() as DemoEngine;
  assert.ok(motor.remoteDomains.includes('baja-t2.es'));
  const res = await ctx.app.inject({ method: 'DELETE', url: `/api/domains/${domainId}`, headers: { cookie: ctx.adminCookie } });
  assert.equal(res.statusCode, 200, res.body);
  await sincronizarRecepcionExterna();
  assert.ok(!motor.remoteDomains.includes('baja-t2.es'));
});
