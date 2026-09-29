import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resolver } from 'node:dns/promises';
import { checkDomainDns } from '../src/modules/deliverability';
import Fastify from 'fastify';
import { db } from '../src/core/db';
import { HttpError } from '../src/core/errors';
import { getEngine } from '../src/engine';
import { registerDomainRoutes } from '../src/modules/domains';

test('un nombre Docker como MX nunca deja el dominio verificado', async (t) => {
  t.mock.method(Resolver.prototype, 'resolveMx', async () => [
    { priority: 10, exchange: '93e0126401b4' },
  ]);
  const report = await checkDomainDns('ligaescarlata.com', [
    { type: 'MX', name: 'ligaescarlata.com', content: '10 93e0126401b4' },
  ]);
  assert.equal(report.allRequiredOk, false);
  assert.equal(report.checks[0].status, 'mismatch');
  assert.match(report.checks[0].help, /Stalwart/);
});

test('un MX público que coincide conserva su verificación', async (t) => {
  t.mock.method(Resolver.prototype, 'resolveMx', async () => [
    { priority: 10, exchange: 'mail.nkrow.com' },
  ]);
  const report = await checkDomainDns('ligaescarlata.com', [
    { type: 'MX', name: 'ligaescarlata.com', content: '10 mail.nkrow.com.' },
  ]);
  assert.equal(report.allRequiredOk, true);
});

test('la API reconoce el MX del motor y bloquea la exportación de su nombre interno', async (t) => {
  db.prepare("INSERT OR IGNORE INTO plans (id, name, created_at) VALUES ('mx_plan', 'MX', 0)").run();
  db.prepare("INSERT OR IGNORE INTO clients (id, name, slug, plan_id, created_at) VALUES ('mx_client', 'MX', 'mx-client', 'mx_plan', 0)").run();
  db.prepare("INSERT OR IGNORE INTO domains (id, client_id, domain, created_at) VALUES ('mx_domain', 'mx_client', 'mx-test.example.com', 0)").run();
  t.mock.method(Resolver.prototype, 'resolveMx', async () => [{ priority: 10, exchange: '93e0126401b4.' }]);
  t.mock.method(Resolver.prototype, 'resolveTxt', async () => []);
  t.mock.method(getEngine(), 'getDnsRecords', async () => [
    { type: 'MX', name: 'mx-test.example.com.', content: '10 93e0126401b4' },
  ]);
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.user = { id: 'mx_user', role: 'admin', clientId: null, name: 'Test', email: 'test@example.com' };
  });
  app.setErrorHandler((err, _req, reply) => {
    reply.code(err instanceof HttpError ? err.status : 500).send({ error: err.message });
  });
  registerDomainRoutes(app);
  t.after(() => app.close());
  const conflict = await app.inject('/api/domains/mx_domain/conflicto');
  assert.equal(conflict.statusCode, 200);
  assert.equal(conflict.json().hayOtroProveedor, false);
  assert.match(conflict.json().avisoConfiguracion, /Stalwart/);
  const zone = await app.inject('/api/domains/mx_domain/zonefile');
  assert.equal(zone.statusCode, 400);
  assert.match(zone.json().error, /sin dominio público completo/);
});
