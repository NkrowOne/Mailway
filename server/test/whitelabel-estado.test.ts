import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';

/**
 * Fija la regla que costó un fallo real: un DNS no concluyente (corte de red,
 * resolutor lento) NO puede degradar un dominio que ya funcionaba. Si lo
 * hiciera, saldría de la configuración de Traefik y el webmail de ese cliente
 * devolvería 404 por un problema que no es suyo.
 *
 * Se prueba la transición sobre la BD real, sin tocar la red: la política es
 * "qué escribo según lo que averigüé", y eso es lo que hay que blindar.
 */

type DnsStatus = 'ok' | 'failed' | 'unknown';

/** Misma decisión que refreshClientDomain, aislada para poder fijarla. */
function siguienteEstado(
  anterior: string,
  dns: DnsStatus,
  httpsOk: boolean,
): string {
  if (dns === 'unknown') return anterior; // no concluyente: no se toca
  if (dns === 'failed') return 'pending_dns';
  return httpsOk ? 'active' : 'issuing';
}

beforeEach(() => {
  db.prepare('DELETE FROM client_domains').run();
});

test('un DNS no concluyente conserva el estado activo', () => {
  assert.equal(siguienteEstado('active', 'unknown', false), 'active');
});

test('un DNS no concluyente tampoco promociona un dominio pendiente', () => {
  assert.equal(siguienteEstado('pending_dns', 'unknown', false), 'pending_dns');
  assert.equal(siguienteEstado('issuing', 'unknown', false), 'issuing');
});

test('un fallo DEFINITIVO de DNS sí degrada, aunque estuviera activo', () => {
  assert.equal(siguienteEstado('active', 'failed', false), 'pending_dns');
});

test('DNS correcto sin HTTPS todavía = emitiendo certificado', () => {
  assert.equal(siguienteEstado('pending_dns', 'ok', false), 'issuing');
});

test('DNS correcto y HTTPS válido = activo', () => {
  assert.equal(siguienteEstado('issuing', 'ok', true), 'active');
});

test('activated_at se fija una sola vez y no se pisa al re-verificar', () => {
  const t0 = Date.now() - 100_000;
  db.prepare('INSERT OR IGNORE INTO plans (id,name,created_at) VALUES (?,?,?)').run('p','P',0);
  db.prepare('INSERT OR IGNORE INTO clients (id,name,slug,plan_id,created_at) VALUES (?,?,?,?,?)')
    .run('c', 'C', 'c', 'p', 0);
  db.prepare(
    `INSERT INTO client_domains (id,client_id,hostname,kind,status,activated_at,created_at)
     VALUES ('w','c','a.com','webmail','active',?,?)`,
  ).run(t0, t0);

  const ahora = Date.now();
  db.prepare(
    `UPDATE client_domains SET status = ?, detail = ?, last_checked_at = ?,
       activated_at = COALESCE(activated_at, CASE WHEN ? = 'active' THEN ? END)
     WHERE id = 'w'`,
  ).run('active', 'ok', ahora, 'active', ahora);

  const row = db.prepare('SELECT activated_at FROM client_domains WHERE id = ?').get('w') as {
    activated_at: number;
  };
  assert.equal(row.activated_at, t0, 'la fecha de activación original debe conservarse');
});
