import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpError } from '../src/core/errors';
import { getEngine, motorProtegidoPara } from '../src/engine';
import { DemoEngine } from '../src/engine/demo';
import { anunciaGestion016, detectarApiStalwart, MotorStalwart } from '../src/engine/detector';
import { Stalwart015Engine } from '../src/engine/stalwart';
import type { EngineApi, EngineSettings, MailEngine } from '../src/engine/types';
import { activarMantenimiento, desactivarMantenimiento } from '../src/modules/mantenimiento';
import { getEngineSettings } from '../src/modules/settings';
import { fakeStalwart } from './stalwart-falso';

/*
 * Detección de la versión de Stalwart detrás de la URL del motor y fachada
 * que elige el driver: contra un Stalwart simulado por HTTP que responde como
 * 0.15 (API REST, /jmap/session sin la capacidad de gestión) o como 0.16
 * (JMAP con `urn:stalwart:jmap`, sin /api). La migración se simula cambiando
 * su versión con la fachada en marcha.
 */

const SECRETO = 'clave-del-motor';
const motorFalso = fakeStalwart(SECRETO);
let ajustes: EngineSettings;

before(async () => {
  const url = await motorFalso.listen();
  ajustes = {
    kind: 'stalwart',
    url,
    adminUser: 'admin',
    adminPassword: SECRETO,
    smtpHost: '127.0.0.1',
    smtpPort: 587,
    smtpSecure: false,
  };
});

after(() => motorFalso.close());

beforeEach(() => {
  motorFalso.version = '0.15';
  motorFalso.principals.clear();
  motorFalso.received.length = 0;
});

/** Driver 0.16 de pega: el de demostración diciendo que es JMAP. */
class Falso016 extends DemoEngine {
  override async detectApi(): Promise<EngineApi> {
    return 'jmap016';
  }
  override async getMailboxUsage(): Promise<Map<string, number>> {
    return new Map([['ana@acme.test', 16]]);
  }
}

function fachada(creados: string[] = []): MotorStalwart {
  return new MotorStalwart(ajustes, {
    rest015: (s) => {
      creados.push('rest015');
      return new Stalwart015Engine(s);
    },
    jmap016: () => {
      creados.push('jmap016');
      return new Falso016() as unknown as MailEngine;
    },
  });
}

test('la capacidad de gestión de 0.16 cuenta en las del servidor, en primaryAccounts o en una cuenta', () => {
  // Forma real de Stalwart 0.16.25: ausente arriba, presente por cuenta.
  const real016 = {
    capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {} },
    accounts: {
      b: { name: 'admin', accountCapabilities: { 'urn:ietf:params:jmap:mail': {}, 'urn:stalwart:jmap': {} } },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'b', 'urn:stalwart:jmap': 'b' },
  };
  assert.equal(anunciaGestion016(real016), true);
  assert.equal(anunciaGestion016({ ...real016, primaryAccounts: {} }), true, 'solo en la cuenta');
  assert.equal(anunciaGestion016({ capabilities: {}, accounts: {}, primaryAccounts: { 'urn:stalwart:jmap': 'b' } }), true);
  assert.equal(anunciaGestion016({ capabilities: { 'urn:stalwart:jmap': {} } }), true, 'en las del servidor');
  // Sesión de 0.15.5 (la del correo): ninguna de las tres.
  assert.equal(
    anunciaGestion016({
      capabilities: { 'urn:ietf:params:jmap:core': {} },
      accounts: { a: { accountCapabilities: { 'urn:ietf:params:jmap:mail': {} } } },
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' },
    }),
    false,
  );
  assert.equal(anunciaGestion016(null), false);
  assert.equal(anunciaGestion016('<html>'), false);
});

test('0.16: la sesión JMAP anuncia urn:stalwart:jmap en la cuenta (forma real)', async () => {
  motorFalso.version = '0.16';
  assert.equal(await detectarApiStalwart(ajustes), 'jmap016');
  assert.deepEqual(
    motorFalso.received.map((r) => r.path),
    ['/jmap/session'],
    'con la capacidad basta: no se pregunta por la API REST',
  );
});

test('0.15: la sesión JMAP existe pero sin la capacidad de gestión; se confirma con la API REST', async () => {
  assert.equal(await detectarApiStalwart(ajustes), 'rest015');
  assert.deepEqual(motorFalso.received.map((r) => r.path), ['/jmap/session', '/api/principal']);
});

test('credenciales rechazadas (401): error claro y una sola petición', async () => {
  await assert.rejects(detectarApiStalwart({ ...ajustes, adminPassword: 'otra' }), (err: HttpError) => {
    assert.equal(err.code, 'engine_auth_failed');
    assert.match(err.message, /usuario o la contraseña de administración/);
    return true;
  });
  // Cada fallo cuenta para el bloqueo automático de IPs del motor: no se insiste.
  assert.equal(motorFalso.received.length, 1);
});

test('sin conexión: engine_unreachable; otra cosa en la URL: engine_error', async () => {
  await assert.rejects(
    detectarApiStalwart({ ...ajustes, url: 'http://127.0.0.1:9' }),
    (err: HttpError) => err.code === 'engine_unreachable',
  );

  // Un servidor que no es Stalwart: ni sesión JMAP de gestión ni API REST.
  const otro = http.createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html>no</html>');
  });
  await new Promise<void>((resolve) => otro.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(otro.address() as AddressInfo).port}`;
    await assert.rejects(detectarApiStalwart({ ...ajustes, url }), (err: HttpError) => {
      assert.equal(err.code, 'engine_error');
      assert.match(err.message, /ni la de 0\.16/);
      return true;
    });
  } finally {
    otro.closeAllConnections();
    otro.close();
  }
});

test('la fachada detecta una vez, recuerda la API y el ping la informa', async () => {
  const creados: string[] = [];
  const motor = fachada(creados);
  assert.equal(motor.apiConocida, null);
  assert.equal(await motor.detectApi(), 'rest015');
  assert.equal(await motor.detectApi(), 'rest015');
  assert.deepEqual(creados, ['rest015'], 'un solo driver mientras no cambie la versión');
  assert.equal(motorFalso.received.filter((r) => r.path === '/jmap/session').length, 1);

  const salud = await motor.ping();
  assert.equal(salud.ok, true);
  assert.equal(salud.api, 'rest015');

  // Sin credenciales válidas el ping lo explica sin lanzar.
  const mala = new MotorStalwart({ ...ajustes, adminPassword: 'otra' });
  const fallo = await mala.ping();
  assert.equal(fallo.ok, false);
  assert.match(fallo.detail ?? '', /usuario o la contraseña/);
});

test('motor migrado con el panel en marcha: la ruta desaparece, se detecta 0.16 y se repite la operación', async () => {
  const creados: string[] = [];
  const motor = fachada(creados);
  motorFalso.principals.set('ana@acme.test', { type: 'individual', secrets: [], roles: ['user'] });
  assert.equal(await motor.detectApi(), 'rest015');
  assert.deepEqual([...(await motor.getMailboxUsage()).keys()], ['ana@acme.test']);

  // Se migra el motor: /api deja de existir.
  motorFalso.version = '0.16';
  const uso = await motor.getMailboxUsage();
  assert.equal(uso.get('ana@acme.test'), 16, 'la respuesta es la del driver 0.16');
  assert.equal(await motor.detectApi(), 'jmap016');
  assert.deepEqual(creados, ['rest015', 'jmap016']);

  // Y el ping (cada minuto en el vigilante) informa ya la API nueva.
  assert.equal((await motor.ping()).api, 'jmap016');
});

test('una ruta que falta sin cambio de versión no se repite: el error llega tal cual', async () => {
  const motor = fachada();
  assert.equal(await motor.detectApi(), 'rest015');
  // El motor sigue siendo 0.15, pero esta ruta concreta da 404.
  motorFalso.received.length = 0;
  await assert.rejects(motor.reloadCertificates(), (err: HttpError) => {
    assert.equal(err.code, 'engine_error');
    assert.match(err.message, /no reconoce la ruta de gestión/);
    return true;
  });
  assert.equal(
    motorFalso.received.filter((r) => r.path === '/api/reload/certificate').length,
    1,
    'la operación no se repite si la API no ha cambiado',
  );
});

test('la puesta en marcha aplica los ajustes con el mismo motor que el resto del panel', async () => {
  // Con los ajustes del motor activo, el mismo objeto que getEngine(): lo que
  // el driver recuerda tras aplicarlos (en 0.16, el reinicio pendiente) lo ve
  // después Ajustes.
  const activos = getEngineSettings();
  assert.ok(activos);
  assert.equal(motorProtegidoPara({ ...activos }), getEngine());

  // Con otros ajustes, uno nuevo que también respeta el modo mantenimiento,
  // sin llegar a hablar con el motor.
  const otro = motorProtegidoPara(ajustes);
  assert.notEqual(otro, getEngine());
  activarMantenimiento(5);
  try {
    motorFalso.received.length = 0;
    await assert.rejects(otro.createDomain('acme.test'), (err: HttpError) => err.code === 'engine_maintenance');
    assert.equal(motorFalso.received.length, 0);
  } finally {
    desactivarMantenimiento();
  }
});
