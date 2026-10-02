import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, now } from '../src/core/db';
import { upstream } from '../src/core/errors';
import { getEngine } from '../src/engine';
import { listAlerts } from '../src/modules/alerts';
import { checkEngineHostname, evaluateHostnameAlert } from '../src/modules/engineops';
import { setInstanceSettings } from '../src/modules/settings';
import { runWatchdogOnce } from '../src/modules/watchdog';
import { adminContext, createClient, createDomain, type TestContext } from './helpers';

/*
 * Nombre con el que el motor se anuncia DE VERDAD (el destino del MX que
 * genera) frente al de Ajustes. El motor de demostración «arranca» con el
 * último server.hostname aplicado; para simular un Stalwart que se anuncia
 * con otro nombre se sustituye getRunningHostname en la instancia.
 */

const HOST = 'mail.mailway.test';

interface EstadoNombre {
  configured: string | null;
  expected: string | null;
  ok: boolean;
  running: string | null;
  runningOk: boolean | null;
  runningError: string | null;
}

let ctx: TestContext;

before(async () => {
  ctx = await adminContext();
  setInstanceSettings({ mailHostname: HOST });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/engine/recommended',
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(res.statusCode, 200, res.body);
});

beforeEach(() => {
  db.prepare("DELETE FROM alerts WHERE type = 'engine_hostname'").run();
  db.prepare("DELETE FROM settings WHERE key = 'watchdog_last_engine_hostname'").run();
});

function avisosAbiertos() {
  return listAlerts({}).filter((a) => a.type === 'engine_hostname');
}

async function estado(): Promise<{ engine: { error: string | null }; hostname: EstadoNombre }> {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/engine/status', headers: { cookie: ctx.adminCookie } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { engine: { error: string | null }; hostname: EstadoNombre };
}

/** Sustituye el nombre en ejecución del motor durante `fn`. */
async function conNombreEnEjecucion(valor: string | null | Error, fn: () => Promise<void>): Promise<void> {
  const engine = getEngine();
  const original = engine.getRunningHostname.bind(engine);
  engine.getRunningHostname = async () => {
    if (valor instanceof Error) throw valor;
    return valor;
  };
  try {
    await fn();
  } finally {
    engine.getRunningHostname = original;
  }
}

/* --------------------------------- Estado --------------------------------- */

test('el estado del motor dice con qué nombre se anuncia y si difiere del de Ajustes', async () => {
  assert.deepEqual((await estado()).hostname, {
    configured: HOST,
    expected: HOST,
    ok: true,
    running: HOST,
    runningOk: true,
    runningError: null,
  });

  // Lo guardado coincide, pero el motor sigue presentándose con el nombre del contenedor.
  await conNombreEnEjecucion('3f2a1b4c5d6e', async () => {
    const { hostname } = await estado();
    assert.equal(hostname.ok, true, 'el server.hostname guardado sí coincide');
    assert.equal(hostname.running, '3f2a1b4c5d6e');
    assert.equal(hostname.runningOk, false);
  });
});

test('si no se puede leer el nombre en ejecución, el estado lo explica sin fallar', async () => {
  await conNombreEnEjecucion(upstream('El motor de correo no reconoce la ruta de gestión /api/dns/records.'), async () => {
    const { engine, hostname } = await estado();
    assert.equal(engine.error, null, 'el resto del estado se ha leído');
    assert.equal(hostname.running, null);
    assert.equal(hostname.runningOk, null);
    assert.match(hostname.runningError ?? '', /no reconoce la ruta/);
  });
});

test('la puesta en marcha no se bloquea aunque el motor se presente con otro nombre', async () => {
  await conNombreEnEjecucion('3f2a1b4c5d6e', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/setup/complete',
      headers: { cookie: ctx.adminCookie },
    });
    assert.equal(res.statusCode, 200, res.body);
  });
});

/* --------------------------------- Aviso ---------------------------------- */

test('el aviso se abre si los nombres difieren, se rehace si cambian y se cierra al coincidir', () => {
  evaluateHostnameAlert(HOST, '3f2a1b4c5d6e');
  evaluateHostnameAlert(HOST, '3F2A1B4C5D6E.');
  let abiertos = avisosAbiertos();
  assert.equal(abiertos.length, 1, 'el mismo problema no se repite');
  assert.equal(abiertos[0]!.severity, 'warning');
  assert.match(abiertos[0]!.title, /3f2a1b4c5d6e.*mail\.mailway\.test/);
  assert.match(abiertos[0]!.remedy, /Aplicar ajustes recomendados/);

  evaluateHostnameAlert(HOST, 'mx.otro.test');
  abiertos = avisosAbiertos();
  assert.equal(abiertos.length, 1, 'el aviso anterior ya no describe la situación');
  assert.match(abiertos[0]!.title, /mx\.otro\.test/);

  evaluateHostnameAlert(HOST, null);
  assert.equal(avisosAbiertos().length, 1, 'sin lectura del motor no se abre ni se cierra nada');

  evaluateHostnameAlert(`${HOST.toUpperCase()}.`, HOST);
  assert.equal(avisosAbiertos().length, 0);
});

test('sin nombre en Ajustes no hay con qué comparar y el aviso se cierra', () => {
  evaluateHostnameAlert(HOST, '3f2a1b4c5d6e');
  assert.equal(avisosAbiertos().length, 1);
  evaluateHostnameAlert('', '3f2a1b4c5d6e');
  assert.equal(avisosAbiertos().length, 0);
});

test('aplicar los ajustes recomendados cierra el aviso en cuanto el motor usa el nombre', async () => {
  evaluateHostnameAlert(HOST, '3f2a1b4c5d6e');
  assert.equal(avisosAbiertos().length, 1);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/engine/recommended',
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as { running: string | null }).running, HOST);
  assert.equal(avisosAbiertos().length, 0);
});

/* -------------------------------- Vigilante ------------------------------- */

test('el vigilante abre el aviso y no reinicia el estado DNS de los dominios', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId, 'sin-reinicio.test');
  const medidoEn = now() - 5 * 60_000;
  const informe = JSON.stringify({ checks: [], requiredTotal: 4, requiredOk: 4, allRequiredOk: true, checkedAt: medidoEn });
  db.prepare(
    "UPDATE domains SET status = 'active', dns_status_json = ?, last_checked_at = ?, verified_at = ? WHERE id = ?",
  ).run(informe, medidoEn, medidoEn, domainId);
  const antes = db.prepare('SELECT status, dns_status_json, last_checked_at, verified_at FROM domains WHERE id = ?').get(domainId);

  await conNombreEnEjecucion('3f2a1b4c5d6e', async () => {
    await runWatchdogOnce();
  });
  assert.equal(avisosAbiertos().length, 1, 'el vigilante compara el nombre en ejecución');
  assert.deepEqual(
    db.prepare('SELECT status, dns_status_json, last_checked_at, verified_at FROM domains WHERE id = ?').get(domainId),
    antes,
    'los dominios se vuelven a medir con su ritmo normal, no se reinician',
  );

  // Motor sin respuesta: el aviso del nombre ni se abre ni se cierra.
  await conNombreEnEjecucion(upstream('Sin respuesta.', 'engine_unreachable'), async () => {
    await checkEngineHostname();
  });
  assert.equal(avisosAbiertos().length, 1);

  await checkEngineHostname();
  assert.equal(avisosAbiertos().length, 0, 'con el nombre correcto, el aviso se cierra');
});
