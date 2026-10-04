import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { db } from '../src/core/db';
import { comprobarPuerto25 } from '../src/core/puerto25';
import { listAlerts } from '../src/modules/alerts';
import { checkServerHealth } from '../src/modules/deliverability';
import { evaluarCola, evaluarPuerto25, QUEUE_AGE_THRESHOLD_S } from '../src/modules/watchdog';

/*
 * Puerto 25 de salida y cola retenida. Antes, Entregabilidad recomendaba
 * siempre «Comprueba que el proveedor permite el puerto 25» sin medir nada
 * (con el puerto abierto o cerrado, el mismo texto), y el vigilante solo
 * avisaba con 50 mensajes en cola: un cliente pequeño con el puerto
 * bloqueado tenía sus primeros envíos días en la cola sin ningún aviso.
 */

beforeEach(() => {
  db.prepare('DELETE FROM alerts').run();
});

/** Un puerto local que nadie escucha: la conexión se rechaza al instante. */
async function puertoCerrado(): Promise<number> {
  const servidor = net.createServer();
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  const { port } = servidor.address() as net.AddressInfo;
  await new Promise<void>((r) => servidor.close(() => r()));
  return port;
}

test('la prueba distingue abierto, bloqueado y sin DNS', async (t) => {
  const servidor = net.createServer((s) => s.end());
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => servidor.close());
  const { port } = servidor.address() as net.AddressInfo;

  const abierto = await comprobarPuerto25({ destinos: [{ host: '127.0.0.1', port }] });
  assert.equal(abierto.estado, 'abierto');

  const cerrado = await puertoCerrado();
  const bloqueado = await comprobarPuerto25({ destinos: [{ host: '127.0.0.1', port: cerrado }], tiempoLimiteMs: 2000 });
  assert.equal(bloqueado.estado, 'bloqueado');

  // Basta con que uno de los destinos conecte.
  const mixto = await comprobarPuerto25({
    destinos: [
      { host: '127.0.0.1', port: cerrado },
      { host: '127.0.0.1', port },
    ],
  });
  assert.equal(mixto.estado, 'abierto');

  // Un nombre que no resuelve no dice nada del puerto.
  const sinDns = await comprobarPuerto25({ destinos: [{ host: 'no-existe.invalid', port: 25 }], tiempoLimiteMs: 3000 });
  assert.equal(sinDns.estado, 'desconocido');
});

test('Entregabilidad ya no recomienda el puerto 25 sin medirlo', async () => {
  const informe = await checkServerHealth();
  const titulos = informe.recommendations.map((r) => r.title);
  assert.ok(!titulos.includes('Comprueba que el proveedor permite el puerto 25 de salida'));
  // Sin red no se puede medir: se dice así, como información.
  const sinMedir = informe.recommendations.find((r) => r.title === 'No se ha podido comprobar el puerto 25 de salida');
  assert.equal(sinMedir?.severity, 'info');
});

function avisoCola() {
  return listAlerts({}).find((a) => a.type === 'queue_backed_up') ?? null;
}

test('pocos mensajes retenidos más de una hora abren el aviso de la cola', () => {
  evaluarCola({ pending: 3, oldestSeconds: 600 }, null);
  assert.equal(avisoCola(), null, 'diez minutos son reintentos normales');

  evaluarCola({ pending: 3, oldestSeconds: QUEUE_AGE_THRESHOLD_S + 60 }, null);
  const aviso = avisoCola();
  assert.ok(aviso, 'tres mensajes de más de una hora abren el aviso');
  assert.match(aviso.title, /3 mensajes retenidos .* más de una hora/);

  evaluarCola({ pending: 0, oldestSeconds: null }, null);
  assert.equal(avisoCola(), null, 'con la cola vacía se cierra');
});

test('con el puerto 25 bloqueado, el aviso de la cola lo dice', () => {
  evaluarCola(
    { pending: 1, oldestSeconds: 2 * QUEUE_AGE_THRESHOLD_S },
    { estado: 'bloqueado', detalle: 'No se ha podido conectar.', comprobadoEn: Date.now() },
  );
  const aviso = avisoCola();
  assert.ok(aviso);
  assert.match(aviso.title, /^Hay 1 mensaje retenido/);
  assert.match(aviso.message, /puerto 25 de salida está bloqueado/);
  assert.match(aviso.remedy, /apertura del puerto 25/);
});

test('el aviso del puerto 25 se abre bloqueado y se cierra abierto', () => {
  const tipo = () => listAlerts({}).filter((a) => a.type === 'smtp_port_blocked');
  evaluarPuerto25({ estado: 'bloqueado', detalle: 'Sin conexión.', comprobadoEn: Date.now() });
  assert.equal(tipo().length, 1);
  assert.equal(tipo()[0]!.severity, 'critical');
  evaluarPuerto25({ estado: 'desconocido', detalle: 'Sin DNS.', comprobadoEn: Date.now() });
  assert.equal(tipo().length, 1, 'sin dato no se cierra');
  evaluarPuerto25({ estado: 'abierto', detalle: 'Conecta.', comprobadoEn: Date.now() });
  assert.equal(tipo().length, 0);
});
