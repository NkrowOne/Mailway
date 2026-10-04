import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { listAlerts } from '../src/modules/alerts';
import { setInstanceSettings } from '../src/modules/settings';
import { evaluarIpPublica } from '../src/modules/watchdog';
import {
  buildTraefikConfig,
  comprobarDnsMarcaBlanca,
  getClientDomain,
  refreshClientDomain,
} from '../src/modules/whitelabel';
import { instalarDnsFalso } from './dns-falso';

/*
 * Cambio de IP del servidor (mudanza): Ajustes conserva la IP anterior hasta
 * que alguien la corrige. El webmail de marca blanca de los clientes no puede
 * depender de esa IP guardada: un CNAME al servidor de correo, o un A que ya
 * apunta a la IP nueva del servidor de correo, sigue siendo correcto. Antes,
 * a los dos fallos seguidos el dominio salía de Traefik y devolvía 404.
 */

const IP_ANTERIOR = '203.0.113.7';
const IP_NUEVA = '198.51.100.99';
const SERVIDOR = 'mail.proveedor.test';

function sembrar(id: string, hostname: string, status: string): void {
  db.prepare('INSERT OR IGNORE INTO plans (id,name,created_at) VALUES (?,?,?)').run('p', 'P', 0);
  db.prepare('INSERT OR IGNORE INTO clients (id,name,slug,plan_id,created_at) VALUES (?,?,?,?,?)').run(
    'c',
    'C',
    'c',
    'p',
    0,
  );
  db.prepare(
    `INSERT INTO client_domains (id,client_id,hostname,kind,status,activated_at,created_at)
     VALUES (?,?,?,'webmail',?,?,?)`,
  ).run(id, 'c', hostname, status, status === 'active' ? 1000 : null, Date.now());
}

beforeEach(() => {
  db.prepare('DELETE FROM client_domains').run();
  db.prepare('DELETE FROM alerts').run();
  // Ajustes sigue con la IP de antes de la mudanza.
  setInstanceSettings({ publicIp: IP_ANTERIOR, mailHostname: SERVIDOR });
});

test('un CNAME al servidor de correo vale aunque Ajustes tenga la IP anterior', async (t) => {
  instalarDnsFalso(t, {
    a: { 'webmail.cliente.test': [IP_NUEVA], [SERVIDOR]: [IP_NUEVA] },
    cname: { 'webmail.cliente.test': [`${SERVIDOR}.`] },
  });
  const r = await comprobarDnsMarcaBlanca('webmail.cliente.test');
  assert.equal(r.status, 'ok', r.detail);
  assert.match(r.detail, /mail\.proveedor\.test/);
});

test('un A a la IP nueva del servidor de correo también vale', async (t) => {
  instalarDnsFalso(t, { a: { 'webmail.cliente.test': [IP_NUEVA], [SERVIDOR]: [IP_NUEVA] } });
  const r = await comprobarDnsMarcaBlanca('webmail.cliente.test');
  assert.equal(r.status, 'ok', r.detail);
});

test('un A a la IP guardada sigue valiendo', async (t) => {
  instalarDnsFalso(t, { a: { 'webmail.cliente.test': [IP_ANTERIOR], [SERVIDOR]: [IP_NUEVA] } });
  assert.equal((await comprobarDnsMarcaBlanca('webmail.cliente.test')).status, 'ok');
});

test('un A a otra máquina sigue siendo un fallo', async (t) => {
  instalarDnsFalso(t, { a: { 'webmail.cliente.test': ['192.0.2.50'], [SERVIDOR]: [IP_NUEVA] } });
  const r = await comprobarDnsMarcaBlanca('webmail.cliente.test');
  assert.equal(r.status, 'failed');
  assert.match(r.detail, /192\.0\.2\.50/);
});

test('sin poder resolver el servidor de correo, una IP desconocida no es concluyente', async (t) => {
  // El servidor de correo no está en la zona falsa como A: se simula el corte con
  // un resolutor que falla solo para ese nombre.
  instalarDnsFalso(t, { a: { 'webmail.cliente.test': [IP_NUEVA] } });
  const { Resolver } = await import('node:dns/promises');
  const original = Resolver.prototype.resolve4;
  t.mock.method(Resolver.prototype, 'resolve4', async function (this: InstanceType<typeof Resolver>, n: string) {
    if (n === SERVIDOR) throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
    return original.call(this, n);
  });
  const r = await comprobarDnsMarcaBlanca('webmail.cliente.test');
  assert.equal(r.status, 'unknown', r.detail);
});

test('en plena mudanza, un dominio activo con CNAME no sale de Traefik', async (t) => {
  sembrar('w1', 'webmail.cliente.test', 'active');
  instalarDnsFalso(t, {
    a: { 'webmail.cliente.test': [IP_NUEVA], [SERVIDOR]: [IP_NUEVA] },
    cname: { 'webmail.cliente.test': [SERVIDOR] },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 302 }));
  // Dos vueltas del vigilante: antes, la segunda lo degradaba a «Esperando DNS».
  await refreshClientDomain('w1');
  await refreshClientDomain('w1');
  assert.equal(getClientDomain('w1').status, 'active');
  const config = buildTraefikConfig() as { http?: { routers?: Record<string, { rule: string }> } };
  const reglas = Object.values(config.http?.routers ?? {}).map((r) => r.rule);
  assert.ok(
    reglas.some((r) => r.includes('webmail.cliente.test')),
    'el webmail de marca blanca sigue publicado en Traefik',
  );
});

/* ------------------------- Aviso de la IP pública ------------------------- */

function avisosIp() {
  return listAlerts({}).filter((a) => a.type === 'public_ip_mismatch');
}

test('avisa si la IP de salida cambia y el servidor de correo ya apunta a la nueva', () => {
  evaluarIpPublica(IP_NUEVA, [IP_NUEVA]);
  const avisos = avisosIp();
  assert.equal(avisos.length, 1);
  assert.match(avisos[0]!.message, new RegExp(IP_NUEVA.replace(/\./g, '\\.')));
  assert.match(avisos[0]!.message, new RegExp(IP_ANTERIOR.replace(/\./g, '\\.')));
  assert.match(avisos[0]!.remedy, /Usar esta IP/);
});

test('no avisa a un servidor con varias IP cuyo nombre sigue en la IP guardada', () => {
  evaluarIpPublica(IP_NUEVA, [IP_ANTERIOR]);
  assert.equal(avisosIp().length, 0);
  // Sin dato del DNS tampoco se avisa: puede ser un corte.
  evaluarIpPublica(IP_NUEVA, null);
  assert.equal(avisosIp().length, 0);
});

test('el aviso se cierra al corregir la IP en Ajustes', () => {
  evaluarIpPublica(IP_NUEVA, [IP_NUEVA]);
  assert.equal(avisosIp().length, 1);
  setInstanceSettings({ publicIp: IP_NUEVA });
  evaluarIpPublica(IP_NUEVA, [IP_NUEVA]);
  assert.equal(avisosIp().length, 0);
});
