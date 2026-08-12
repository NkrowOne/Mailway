import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { buildTraefikConfig } from '../src/modules/whitelabel';

function seedDomain(id: string, hostname: string, status: string, kind = 'webmail'): void {
  db.prepare('INSERT OR IGNORE INTO plans (id, name, created_at) VALUES (?, ?, ?)').run(
    'plan_t',
    'Test',
    Date.now(),
  );
  db.prepare(
    'INSERT OR IGNORE INTO clients (id, name, slug, plan_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('cli_t', 'Cliente Test', 'cliente-test', 'plan_t', Date.now());
  db.prepare(
    `INSERT INTO client_domains (id, client_id, hostname, kind, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, 'cli_t', hostname, kind, status, Date.now());
}

beforeEach(() => {
  db.prepare('DELETE FROM client_domains').run();
});

test('un dominio sin DNS verificado NO se publica a Traefik', () => {
  seedDomain('wld_1', 'webmail.pendiente.com', 'pending_dns');
  const cfg = buildTraefikConfig() as any;
  assert.deepEqual(
    Object.keys(cfg.http.routers),
    [],
    'publicar un dominio cuyo DNS no apunta aquí haría fallar la validación de Let\'s Encrypt',
  );
});

test('un dominio con DNS correcto se publica con certresolver y redirección', () => {
  seedDomain('wld_2', 'webmail.panaderialaura.com', 'issuing');
  const cfg = buildTraefikConfig() as any;

  const https = cfg.http.routers['mailway-wld_2'];
  assert.ok(https, 'debe existir el router HTTPS');
  assert.equal(https.rule, 'Host(`webmail.panaderialaura.com`)');
  assert.deepEqual(https.entryPoints, ['websecure']);
  assert.equal(https.tls.certResolver, 'le', 'el certresolver debe ser el de Skyway');

  const http = cfg.http.routers['mailway-wld_2-http'];
  assert.ok(http, 'debe existir el router HTTP que redirige');
  assert.deepEqual(http.middlewares, ['mailway-https']);
  assert.equal(http.tls, undefined, 'el router del puerto 80 no lleva TLS');

  assert.equal(
    cfg.http.services['mailway-webmail'].loadBalancer.servers[0].url,
    'http://mailway-webmail:80',
  );
  assert.equal(cfg.http.middlewares['mailway-https'].redirectScheme.scheme, 'https');
});

test('un dominio ya activo sigue publicado (si no, Traefik lo dejaría de servir)', () => {
  seedDomain('wld_3', 'webmail.activo.com', 'active');
  const cfg = buildTraefikConfig() as any;
  assert.ok(cfg.http.routers['mailway-wld_3']);
});

test('los dominios de tipo panel se omiten si no hay backend configurado', () => {
  seedDomain('wld_4', 'panel.cliente.com', 'active', 'panel');
  const cfg = buildTraefikConfig() as any;
  assert.equal(
    cfg.http.routers['mailway-wld_4'],
    undefined,
    'sin MAILWAY_PANEL_BACKEND_URL no se puede enrutar: mejor omitir que generar una ruta rota',
  );
});

test('varios dominios comparten un único servicio backend', () => {
  seedDomain('wld_5', 'webmail.uno.com', 'active');
  seedDomain('wld_6', 'webmail.dos.com', 'active');
  const cfg = buildTraefikConfig() as any;
  assert.equal(Object.keys(cfg.http.routers).length, 4, '2 dominios × (https + http)');
  assert.deepEqual(Object.keys(cfg.http.services), ['mailway-webmail']);
});
