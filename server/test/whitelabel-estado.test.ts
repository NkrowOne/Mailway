import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { setInstanceSettings } from '../src/modules/settings';
import {
  applyClientDomainCheck,
  getClientDomain,
  nextClientDomainStatus,
  refreshClientDomain,
} from '../src/modules/whitelabel';

/**
 * Fija la regla que costó un fallo real: un DNS no concluyente (corte de red,
 * resolutor lento) NO puede degradar un dominio que ya funcionaba. Si lo
 * hiciera, saldría de la configuración de Traefik y el webmail de ese cliente
 * devolvería 404 por un problema que no es suyo.
 *
 * Se prueban las funciones reales de whitelabel.ts: la decisión pura, la
 * escritura en la base de datos y la comprobación completa sin red (las
 * pruebas corren con MAILWAY_DNS_OFFLINE=1, así que todo DNS es «desconocido»).
 */

function seed(id: string, hostname: string, status: string, activatedAt: number | null = null): void {
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
  ).run(id, 'c', hostname, status, activatedAt, Date.now());
}

beforeEach(() => {
  db.prepare('DELETE FROM client_domains').run();
  setInstanceSettings({ publicIp: '203.0.113.10', mailHostname: 'mail.proveedor.test' });
});

test('un DNS no concluyente conserva el estado activo', () => {
  assert.equal(nextClientDomainStatus('active', 'unknown', false), 'active');
});

test('un DNS no concluyente tampoco promociona un dominio pendiente', () => {
  assert.equal(nextClientDomainStatus('pending_dns', 'unknown', true), 'pending_dns');
  assert.equal(nextClientDomainStatus('issuing', 'unknown', false), 'issuing');
});

test('un fallo DEFINITIVO de DNS sí degrada, aunque estuviera activo', () => {
  assert.equal(nextClientDomainStatus('active', 'failed', false), 'pending_dns');
});

test('DNS correcto sin HTTPS todavía = emitiendo certificado', () => {
  assert.equal(nextClientDomainStatus('pending_dns', 'ok', false), 'issuing');
});

test('DNS correcto y HTTPS válido = activo', () => {
  assert.equal(nextClientDomainStatus('issuing', 'ok', true), 'active');
});

test('sin red, la comprobación real no toca un dominio activo', async () => {
  seed('w1', 'webmail.activo.test', 'active', 1000);
  const domain = await refreshClientDomain('w1');
  assert.equal(domain.status, 'active');
  assert.equal(domain.activatedAt, 1000);
  assert.match(domain.detail, /No se ha podido consultar el DNS/);
});

test('un resultado desconocido solo actualiza el detalle', () => {
  seed('w2', 'webmail.pendiente.test', 'pending_dns');
  const domain = applyClientDomainCheck('w2', { status: 'unknown', detail: 'sin respuesta' }, null);
  assert.equal(domain.status, 'pending_dns');
  assert.equal(domain.detail, 'sin respuesta');
  assert.ok(domain.lastCheckedAt);
});

test('un fallo definitivo se escribe como pendiente de DNS', () => {
  seed('w3', 'webmail.roto.test', 'active', 1000);
  const domain = applyClientDomainCheck('w3', { status: 'failed', detail: 'apunta a otra IP' }, null);
  assert.equal(domain.status, 'pending_dns');
  assert.equal(domain.detail, 'apunta a otra IP');
});

test('DNS correcto y certificado emitido activa el dominio y fija la fecha', () => {
  seed('w4', 'webmail.nuevo.test', 'issuing');
  const before = Date.now();
  const domain = applyClientDomainCheck(
    'w4',
    { status: 'ok', detail: 'apunta aquí' },
    { ok: true, detail: 'Certificado válido' },
  );
  assert.equal(domain.status, 'active');
  assert.equal(domain.detail, 'Certificado válido');
  assert.ok(domain.activatedAt && domain.activatedAt >= before);
});

test('activated_at se fija una sola vez y no se pisa al re-verificar', () => {
  const t0 = Date.now() - 100_000;
  seed('w5', 'webmail.antiguo.test', 'active', t0);
  applyClientDomainCheck('w5', { status: 'ok', detail: 'ok' }, { ok: true, detail: 'ok' });
  assert.equal(getClientDomain('w5').activatedAt, t0, 'la fecha de activación original debe conservarse');
});
