import { test, beforeEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import net from 'node:net';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { comprobarPuerto25, type ResultadoPuerto25 } from '../src/core/puerto25';
import { listAlerts } from '../src/modules/alerts';
import { checkServerHealth } from '../src/modules/deliverability';
import { setEngineSettings } from '../src/modules/settings';
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

test('la prueba distingue abierto y bloqueado', async (t) => {
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
});

/**
 * Resolutor del sistema simulado: responde con un error al cabo de `ms`. Un
 * resolutor caído con glibc tarda 5 s por intento en rendirse.
 */
function resolutorQueFalla(t: TestContext, ms: number, code: string): void {
  t.mock.method(dns, 'lookup', (_host: string, _opciones: unknown, cb: (err: NodeJS.ErrnoException) => void) => {
    setTimeout(() => cb(Object.assign(new Error(`getaddrinfo ${code}`), { code })), ms);
  });
}

test('un nombre que no resuelve no dice nada del puerto', async (t) => {
  resolutorQueFalla(t, 0, 'ENOTFOUND');
  const r = await comprobarPuerto25({ destinos: [{ host: 'gmail-smtp-in.ejemplo.test', port: 25 }], tiempoLimiteMs: 2000 });
  assert.equal(r.estado, 'desconocido');
});

test('un DNS más lento que el tiempo límite no da el puerto por bloqueado', async (t) => {
  // Antes, el reloj vencía mientras se resolvía el nombre y salía
  // «bloqueado»: un aviso crítico y 30 puntos menos por un resolutor lento.
  resolutorQueFalla(t, 1500, 'EAI_AGAIN');
  const r = await comprobarPuerto25({ destinos: [{ host: 'gmail-smtp-in.ejemplo.test', port: 25 }], tiempoLimiteMs: 300 });
  assert.equal(r.estado, 'desconocido', r.detalle);
});

test('con el nombre ya resuelto, agotar el tiempo sí es un puerto bloqueado', async (t) => {
  // 192.0.2.1 (TEST-NET-1) no se enruta: la conexión se queda esperando o
  // falla, pero nunca conecta, como un puerto 25 filtrado por el proveedor.
  t.mock.method(dns, 'lookup', (_host: string, _opciones: unknown, cb: (err: null, ip: string, familia: number) => void) => {
    setImmediate(() => cb(null, '192.0.2.1', 4));
  });
  const r = await comprobarPuerto25({ destinos: [{ host: 'gmail-smtp-in.ejemplo.test', port: 25 }], tiempoLimiteMs: 300 });
  assert.equal(r.estado, 'bloqueado', r.detalle);
});

test('Entregabilidad ya no recomienda el puerto 25 sin medirlo', async () => {
  // Con el motor de demostración no hay nada que entregar: ni se mide ni se recomienda.
  const demo = await checkServerHealth();
  const titulos = demo.recommendations.map((r) => r.title);
  assert.ok(!titulos.includes('Comprueba que el proveedor permite el puerto 25 de salida'));
  assert.ok(!titulos.some((t) => /puerto 25/.test(t)), titulos.join(' | '));

  // Con Stalwart se mide; sin red no se puede, y se dice así, como información.
  config.demoMode = false;
  setEngineSettings({
    kind: 'stalwart',
    url: 'http://mailway-mail:8080',
    adminUser: 'admin',
    adminPassword: 'x',
    smtpHost: 'mailway-mail',
    smtpPort: 587,
    smtpSecure: false,
  });
  try {
    const real = await checkServerHealth();
    const sinMedir = real.recommendations.find((r) => r.title === 'No se ha podido comprobar el puerto 25 de salida');
    assert.equal(sinMedir?.severity, 'info');
  } finally {
    config.demoMode = true;
  }
});

function avisoCola() {
  return listAlerts({}).find((a) => a.type === 'queue_backed_up') ?? null;
}

function avisoAntiguo() {
  return listAlerts({}).find((a) => a.type === 'queue_stale') ?? null;
}

const BLOQUEADO: ResultadoPuerto25 = { estado: 'bloqueado', detalle: 'No se ha podido conectar.', comprobadoEn: Date.now() };
const ABIERTO: ResultadoPuerto25 = { estado: 'abierto', detalle: 'Conecta.', comprobadoEn: Date.now() };

test('pocos mensajes retenidos más de una hora abren el aviso de la cola', () => {
  evaluarCola({ pending: 3, oldestSeconds: 600 }, null);
  assert.equal(avisoAntiguo(), null, 'diez minutos son reintentos normales');

  evaluarCola({ pending: 3, oldestSeconds: QUEUE_AGE_THRESHOLD_S + 60 }, null);
  const aviso = avisoAntiguo();
  assert.ok(aviso, 'tres mensajes de más de una hora abren el aviso');
  assert.match(aviso.title, /retenido .* más de una hora/);
  assert.equal(avisoCola(), null, 'no es el aviso del volumen');

  evaluarCola({ pending: 0, oldestSeconds: null }, null);
  assert.equal(avisoAntiguo(), null, 'con la cola vacía se cierra');
});

test('con el puerto 25 bloqueado, el aviso de la cola lo dice', () => {
  evaluarCola({ pending: 1, oldestSeconds: 2 * QUEUE_AGE_THRESHOLD_S }, BLOQUEADO);
  const aviso = avisoAntiguo();
  assert.ok(aviso);
  assert.match(aviso.message, /puerto 25 de salida está bloqueado/);
  assert.match(aviso.remedy, /apertura del puerto 25/);
});

test('con el puerto 25 abierto, un mensaje diferido no abre el aviso', () => {
  // Un destino caído o un buzón lleno: el motor lo reintenta días y avisa al
  // remitente. En un servidor con tráfico casi siempre hay alguno.
  evaluarCola({ pending: 1, oldestSeconds: 2 * QUEUE_AGE_THRESHOLD_S }, ABIERTO);
  assert.equal(avisoAntiguo(), null);
  assert.equal(avisoCola(), null);

  // Uno abierto con el puerto bloqueado se cierra cuando el puerto responde.
  evaluarCola({ pending: 1, oldestSeconds: 2 * QUEUE_AGE_THRESHOLD_S }, BLOQUEADO);
  assert.ok(avisoAntiguo());
  evaluarCola({ pending: 1, oldestSeconds: 3 * QUEUE_AGE_THRESHOLD_S }, ABIERTO);
  assert.equal(avisoAntiguo(), null);
});

test('un mensaje diferido no oculta después una acumulación de la cola', () => {
  // Antes compartían clave: con el aviso abierto por un solo mensaje, que la
  // cola llegara a 400 no avisaba a nadie y el título seguía diciendo «1».
  evaluarCola({ pending: 1, oldestSeconds: 2 * QUEUE_AGE_THRESHOLD_S }, BLOQUEADO);
  assert.ok(avisoAntiguo());
  evaluarCola({ pending: 400, oldestSeconds: 30_000 }, BLOQUEADO);
  const volumen = avisoCola();
  assert.ok(volumen, 'la acumulación abre su propio aviso');
  assert.equal(volumen.title, 'Hay 400 mensajes retenidos en la cola de salida');
  assert.match(volumen.message, /puerto 25 de salida está bloqueado/);

  // Al bajar de 50 se cierra el del volumen; el de la antigüedad sigue.
  evaluarCola({ pending: 10, oldestSeconds: 30_000 }, BLOQUEADO);
  assert.equal(avisoCola(), null);
  assert.ok(avisoAntiguo());
});

test('la acumulación sola no abre también el aviso de la antigüedad', () => {
  evaluarCola({ pending: 80, oldestSeconds: 2 * QUEUE_AGE_THRESHOLD_S }, null);
  assert.ok(avisoCola());
  assert.equal(avisoAntiguo(), null, 'un solo aviso por lo mismo');
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
