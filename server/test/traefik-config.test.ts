import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { AUTOCONFIG_HOSTS_SETTING, type AutoconfigHostRecord } from '../src/modules/connection';
import { setInstanceSettings, setJsonSetting } from '../src/modules/settings';
import { buildTraefikConfig } from '../src/modules/whitelabel';

interface Router {
  rule: string;
  entryPoints: string[];
  service: string;
  middlewares?: string[];
  tls?: { certResolver: string };
}
interface TraefikConfig {
  http: {
    routers: Record<string, Router>;
    services: Record<string, { loadBalancer: { servers: { url: string }[] } }>;
    middlewares: Record<string, { redirectScheme: { scheme: string } }>;
  };
}

function build(): TraefikConfig {
  return buildTraefikConfig() as unknown as TraefikConfig;
}

function seedClient(): void {
  db.prepare('INSERT OR IGNORE INTO plans (id, name, created_at) VALUES (?, ?, ?)').run(
    'plan_t',
    'Test',
    Date.now(),
  );
  db.prepare(
    'INSERT OR IGNORE INTO clients (id, name, slug, plan_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('cli_t', 'Cliente Test', 'cliente-test', 'plan_t', Date.now());
}

function seedDomain(id: string, hostname: string, status: string, kind = 'webmail'): void {
  seedClient();
  db.prepare(
    `INSERT INTO client_domains (id, client_id, hostname, kind, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, 'cli_t', hostname, kind, status, Date.now());
}

function seedMailDomain(id: string, domain: string): void {
  seedClient();
  db.prepare('INSERT INTO domains (id, client_id, domain, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    'cli_t',
    domain,
    Date.now(),
  );
}

function seedHostStates(states: Record<string, AutoconfigHostRecord['state']>): void {
  const map: Record<string, AutoconfigHostRecord> = {};
  for (const [host, state] of Object.entries(states)) {
    map[host] = {
      state,
      detail: 'prueba',
      checkedAt: Date.now(),
      changedAt: Date.now(),
      lastAttemptAt: Date.now(),
      lastAttemptInconclusive: false,
    };
  }
  setJsonSetting(AUTOCONFIG_HOSTS_SETTING, map);
}

const originalPanelBackend = config.traefik.panelBackend;

beforeEach(() => {
  db.prepare('DELETE FROM client_domains').run();
  db.prepare('DELETE FROM domains').run();
  setJsonSetting(AUTOCONFIG_HOSTS_SETTING, {});
  setInstanceSettings({ mailHostname: 'mail.proveedor.test', publicIp: '203.0.113.10' });
  config.traefik.panelBackend = '';
});

afterEach(() => {
  config.traefik.panelBackend = originalPanelBackend;
});

test('un dominio sin DNS verificado NO se publica a Traefik', () => {
  seedDomain('wld_1', 'webmail.pendiente.com', 'pending_dns');
  assert.deepEqual(
    Object.keys(build().http.routers),
    [],
    'publicar un dominio cuyo DNS no apunta aquí haría fallar la validación de Let\'s Encrypt',
  );
});

test('un dominio con DNS correcto se publica con certresolver y redirección', () => {
  seedDomain('wld_2', 'webmail.panaderialaura.com', 'issuing');
  const cfg = build();

  const https = cfg.http.routers['mailway-wld_2'];
  assert.ok(https, 'debe existir el router HTTPS');
  assert.equal(https.rule, 'Host(`webmail.panaderialaura.com`)');
  assert.deepEqual(https.entryPoints, ['websecure']);
  assert.equal(https.tls?.certResolver, 'le', 'el certresolver debe ser el de Skyway');

  const http = cfg.http.routers['mailway-wld_2-http'];
  assert.ok(http, 'debe existir el router HTTP que redirige');
  assert.deepEqual(http.middlewares, ['mailway-https']);
  assert.equal(http.tls, undefined, 'el router del puerto 80 no lleva TLS');

  assert.equal(
    cfg.http.services['mailway-webmail']!.loadBalancer.servers[0]!.url,
    'http://mailway-webmail:80',
  );
  assert.equal(cfg.http.middlewares['mailway-https']!.redirectScheme.scheme, 'https');
});

test('un dominio ya activo sigue publicado (si no, Traefik lo dejaría de servir)', () => {
  seedDomain('wld_3', 'webmail.activo.com', 'active');
  assert.ok(build().http.routers['mailway-wld_3']);
});

test('los dominios de tipo panel se omiten si no hay backend configurado', () => {
  seedDomain('wld_4', 'panel.cliente.com', 'active', 'panel');
  assert.equal(
    build().http.routers['mailway-wld_4'],
    undefined,
    'sin contenedor del panel no se puede enrutar: mejor omitir que generar una ruta rota',
  );
});

test('varios dominios comparten un único servicio backend', () => {
  seedDomain('wld_5', 'webmail.uno.com', 'active');
  seedDomain('wld_6', 'webmail.dos.com', 'active');
  const cfg = build();
  assert.equal(Object.keys(cfg.http.routers).length, 4, '2 dominios × (https + http)');
  assert.deepEqual(Object.keys(cfg.http.services), ['mailway-webmail']);
});

/* ------------------------- Autoconfiguración ------------------------------ */

test('sin contenedor del panel no se publica ninguna ruta de autoconfiguración', () => {
  seedMailDomain('dom_a', 'cliente-a.test');
  seedHostStates({
    'autoconfig.cliente-a.test': 'ok',
    'autodiscover.cliente-a.test': 'ok',
    'autoconfig.proveedor.test': 'ok',
  });
  const cfg = build();
  assert.deepEqual(Object.keys(cfg.http.routers), []);
  assert.equal(cfg.http.services['mailway-panel'], undefined);
});

test('solo se publican los hosts de autoconfiguración cuyo DNS apunta aquí', () => {
  config.traefik.panelBackend = 'http://skyway-correo-panel:4100';
  seedMailDomain('dom_a', 'cliente-a.test');
  seedHostStates({
    'autoconfig.cliente-a.test': 'ok',
    'autodiscover.cliente-a.test': 'pending',
    'mta-sts.cliente-a.test': 'unknown',
    'autoconfig.proveedor.test': 'ok',
    'autodiscover.proveedor.test': 'pending',
  });
  const cfg = build();
  const names = Object.keys(cfg.http.routers).sort();
  assert.deepEqual(names, [
    'mailway-autoconfig-dom_a',
    'mailway-autoconfig-dom_a-http',
    'mailway-autoconfig-instancia',
    'mailway-autoconfig-instancia-http',
  ]);

  const https = cfg.http.routers['mailway-autoconfig-dom_a']!;
  assert.equal(https.rule, 'Host(`autoconfig.cliente-a.test`)');
  assert.deepEqual(https.entryPoints, ['websecure']);
  assert.equal(https.service, 'mailway-panel');
  assert.equal(https.tls?.certResolver, 'le');
  const http = cfg.http.routers['mailway-autoconfig-dom_a-http']!;
  assert.deepEqual(http.entryPoints, ['web']);
  assert.deepEqual(http.middlewares, ['mailway-https']);

  assert.equal(cfg.http.routers['mailway-autoconfig-instancia']!.rule, 'Host(`autoconfig.proveedor.test`)');
  assert.equal(
    cfg.http.services['mailway-panel']!.loadBalancer.servers[0]!.url,
    'http://skyway-correo-panel:4100',
  );
});

test('MTA-STS y Autodiscover se publican cuando su DNS está correcto', () => {
  config.traefik.panelBackend = 'http://mailway-panel:4100';
  seedMailDomain('dom_b', 'cliente-b.test');
  seedHostStates({ 'autodiscover.cliente-b.test': 'ok', 'mta-sts.cliente-b.test': 'ok' });
  const cfg = build();
  assert.equal(cfg.http.routers['mailway-autodiscover-dom_b']!.rule, 'Host(`autodiscover.cliente-b.test`)');
  assert.equal(cfg.http.routers['mailway-mtasts-dom_b']!.rule, 'Host(`mta-sts.cliente-b.test`)');
});

test('los nombres de router son estables y válidos para el puente de Skyway', () => {
  config.traefik.panelBackend = 'http://mailway-panel:4100';
  seedMailDomain('dom_c', 'cliente-c.test');
  seedDomain('wld_7', 'webmail.cliente-c.test', 'active');
  seedHostStates({
    'autoconfig.cliente-c.test': 'ok',
    'autodiscover.cliente-c.test': 'ok',
    'mta-sts.cliente-c.test': 'ok',
    'autoconfig.proveedor.test': 'ok',
    'autodiscover.proveedor.test': 'ok',
  });
  const first = Object.keys(build().http.routers);
  const second = Object.keys(build().http.routers);
  assert.deepEqual(first, second, 'el mismo estado debe producir los mismos nombres');
  assert.equal(new Set(first).size, first.length);
  // Skyway descarta nombres con puntos o «@» (podrían señalar a otro proveedor).
  for (const name of first) assert.match(name, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
  // Una regla por router, solo Host(): es lo único que acepta el puente.
  for (const router of Object.values(build().http.routers)) {
    assert.match(router.rule, /^Host\(`[a-z0-9.-]+`\)$/);
  }
});

test('un host de un dominio ya borrado no se publica aunque quede su estado', () => {
  config.traefik.panelBackend = 'http://mailway-panel:4100';
  seedHostStates({ 'autoconfig.borrado.test': 'ok' });
  assert.deepEqual(Object.keys(build().http.routers), []);
});

test('si un dominio de cliente coincide con la base de la instancia, no se duplica el host', () => {
  config.traefik.panelBackend = 'http://mailway-panel:4100';
  seedMailDomain('dom_d', 'proveedor.test');
  seedHostStates({ 'autoconfig.proveedor.test': 'ok', 'mta-sts.proveedor.test': 'ok' });
  const routers = build().http.routers;
  const rules = Object.values(routers).map((r) => r.rule);
  assert.equal(rules.filter((r) => r === 'Host(`autoconfig.proveedor.test`)').length, 2, 'https + http');
  assert.ok(routers['mailway-autoconfig-instancia']);
  assert.equal(routers['mailway-autoconfig-dom_d'], undefined);
  assert.ok(routers['mailway-mtasts-dom_d']);
});
