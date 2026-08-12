import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';

// Tabla temporal con la misma forma que api_usage (PK compuesta), sin las
// claves foráneas, para probar la mecánica exacta del INSERT…ON CONFLICT…
// RETURNING que usa /v1/send sin tener que sembrar clientes ni buzones.
before(() => {
  db.exec(
    `CREATE TEMP TABLE t_usage (
       api_key_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (api_key_id, day)
     )`,
  );
});

beforeEach(() => {
  db.prepare('DELETE FROM t_usage').run();
});

function reserve(keyId: string, day: string): number {
  const row = db
    .prepare(
      `INSERT INTO t_usage (api_key_id, day, count) VALUES (?, ?, 1)
       ON CONFLICT(api_key_id, day) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .get(keyId, day) as { count: number };
  return row.count;
}

test('reserva atómica: cada llamada devuelve un total creciente sin huecos', () => {
  const totals = [];
  for (let i = 0; i < 5; i++) totals.push(reserve('key_a', '2026-08-12'));
  assert.deepEqual(totals, [1, 2, 3, 4, 5]);
});

test('la reserva simula correctamente el corte en el límite', () => {
  const limit = 3;
  let accepted = 0;
  let rejected = 0;
  for (let i = 0; i < 6; i++) {
    const reserved = reserve('key_b', '2026-08-12');
    if (reserved > limit) {
      rejected++;
      db.prepare(
        'UPDATE t_usage SET count = count - 1 WHERE api_key_id = ? AND day = ? AND count > 0',
      ).run('key_b', '2026-08-12');
    } else {
      accepted++;
    }
  }
  assert.equal(accepted, limit);
  assert.equal(rejected, 3);
  const final = db
    .prepare('SELECT count FROM t_usage WHERE api_key_id = ? AND day = ?')
    .get('key_b', '2026-08-12') as { count: number };
  assert.equal(final.count, limit);
});

test('claves distintas o días distintos no comparten contador', () => {
  reserve('key_c', '2026-08-12');
  reserve('key_c', '2026-08-13');
  const d1 = db
    .prepare('SELECT count FROM t_usage WHERE api_key_id = ? AND day = ?')
    .get('key_c', '2026-08-12') as { count: number };
  const d2 = db
    .prepare('SELECT count FROM t_usage WHERE api_key_id = ? AND day = ?')
    .get('key_c', '2026-08-13') as { count: number };
  assert.equal(d1.count, 1);
  assert.equal(d2.count, 1);
});

/** Réplica de la regla de acotado de /v1/send y de la creación de claves. */
function effectiveDaily(planLimit: number, keyLimit: number | null): number {
  return planLimit > 0 ? Math.min(keyLimit ?? planLimit, planLimit) : keyLimit ?? 0;
}

test('el límite por clave solo puede acotar el del plan, nunca ampliarlo', () => {
  assert.equal(effectiveDaily(500, 10_000_000), 500);
  assert.equal(effectiveDaily(500, 100), 100);
  assert.equal(effectiveDaily(0, 1000), 1000);
  assert.equal(effectiveDaily(0, null), 0);
});
