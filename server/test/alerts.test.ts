import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { fireAlert, listAlerts, resolveAlert } from '../src/modules/alerts';

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
