import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { mailboxStateLockKey, withLock } from '../src/core/locks';
import { listAudit } from '../src/modules/audit';
import { activarMantenimiento, desactivarMantenimiento } from '../src/modules/mantenimiento';
import { setEngineSettings } from '../src/modules/settings';
import {
  AJUSTE_HECHA,
  iniciarReparacionSuspensiones,
  reparacionSuspensionesHecha,
  repararSuspensiones,
} from '../src/modules/suspensiones';
import { runWatchdogOnce } from '../src/modules/watchdog';
import { adminContext, createClient, createDomain, createMailbox, type TestContext } from './helpers';

/*
 * Corrección única de lo que dejó la forma anterior de suspender (roles: [],
 * con la que Stalwart 0.15.5 devolvía el correo del buzón y lo sacaba de sus
 * alias). Los datos se crean en modo demostración, como si ya estuvieran en
 * producción, y la corrección se ejecuta contra un Stalwart 0.15 simulado que
 * anota lo que recibe. Este fichero corre en su propio proceso, así que puede
 * desactivar el modo demostración.
 */

interface Peticion {
  method: string;
  path: string;
  body: unknown;
}

const recibidas: Peticion[] = [];
/** true = el motor no responde: corta cada conexión. */
let caido = false;
/** Principales que el motor no tiene ({ error: "notFound" }). */
const ausentes = new Set<string>();
/** Principales cuyo PATCH falla con un error de gestión. */
const conError = new Set<string>();
/** Lo que hace «otra ruta» justo cuando el motor recibe un PATCH (para simular carreras). */
let alRecibirPatch: ((nombre: string) => void) | null = null;

const motor = http.createServer((req, res) => {
  if (caido) {
    req.socket.destroy();
    return;
  }
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const url = new URL(req.url || '/', 'http://motor');
    const path = decodeURIComponent(url.pathname);
    const body = raw ? (JSON.parse(raw) as unknown) : undefined;
    recibidas.push({ method: req.method || '', path, body });
    res.setHeader('content-type', 'application/json');
    const nombre = path.replace(/^\/api\/principal\/?/, '');
    // Como la 0.15: los errores de gestión llegan con HTTP 200 y { error, item }.
    const responder = (data: unknown) => res.end(JSON.stringify(data));
    if (path === '/api/principal' && req.method === 'GET') return responder({ data: { items: [], total: 0 } });
    if (path === '/api/principal' && req.method === 'POST') return responder({ data: 1 });
    if (path.startsWith('/api/principal/') && req.method === 'DELETE') return responder({ data: null });
    if (path.startsWith('/api/principal/') && req.method === 'PATCH') {
      alRecibirPatch?.(nombre);
      if (ausentes.has(nombre)) return responder({ error: 'notFound', item: nombre });
      const cambios = body as { field: string; value: unknown }[];
      const miembros = cambios.find((c) => c.field === 'members')?.value as string[] | undefined;
      const falta = miembros?.find((m) => ausentes.has(m));
      if (falta) return responder({ error: 'notFound', item: falta });
      if (conError.has(nombre)) return responder({ error: 'other', details: 'Fallo simulado' });
      return responder({ data: null });
    }
    res.writeHead(404);
    res.end(JSON.stringify({ status: 404, title: 'Not Found' }));
  });
});

/** Lo que pide el driver para suspender un buzón: añade el rol (sin reescribir sus alias) y quita el permiso de entrar. */
const SUSPENDER = [
  { action: 'addItem', field: 'roles', value: 'user' },
  { action: 'set', field: 'disabledPermissions', value: ['authenticate', 'authenticate-oauth'] },
];

const SUSPENDIDOS = ['beto@activo.test', 'dani@suspendido.test', 'eva@suspendido.test'];
const ALIAS = ['equipo@activo.test', 'ventas@suspendido.test'];

let ctx: TestContext;
let motorUrl = '';
const ids: Record<string, string> = {};

function parches(prefijo = ''): Peticion[] {
  return recibidas.filter((p) => p.method === 'PATCH' && p.path.startsWith(`/api/principal/${prefijo}`));
}

function rutasDe(peticiones: Peticion[]): string[] {
  return peticiones.map((p) => p.path.replace('/api/principal/', '')).sort();
}

/** Vuelve a dejar la corrección pendiente, como antes de hacerla. */
function olvidarCorreccion(): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(AJUSTE_HECHA);
  recibidas.length = 0;
}

async function hasta(condicion: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condicion(); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(condicion(), 'la condición no llega a cumplirse');
}

async function cambiar(method: 'POST' | 'PATCH', url: string, payload: unknown): Promise<void> {
  const res = await ctx.app.inject({ method, url, headers: { cookie: ctx.adminCookie }, payload });
  assert.equal(res.statusCode, 200, res.body);
}

function conectarMotor(): void {
  config.demoMode = false;
  setEngineSettings({
    kind: 'stalwart',
    url: motorUrl,
    adminUser: 'admin',
    adminPassword: 'secreto-del-motor',
    smtpHost: '127.0.0.1',
    smtpPort: 587,
    smtpSecure: false,
  });
}

/**
 * Datos como los dejaba la versión anterior (en modo demostración, sin motor):
 * un cliente activo con un buzón suspendido y otro suspendido entero, con un
 * buzón que además estaba suspendido por su cuenta, y un alias en cada uno.
 */
async function crearDatos(): Promise<void> {
  config.demoMode = true;
  const activo = await createClient(ctx, { name: 'Activo' });
  const dominioActivo = await createDomain(ctx, activo.clientId, 'activo.test');
  for (const nombre of ['ana', 'beto', 'carla']) {
    ids[nombre] = (await createMailbox(ctx, dominioActivo.domainId, nombre)).mailboxId;
  }
  const suspendido = await createClient(ctx, { name: 'Suspendido' });
  const dominioSuspendido = await createDomain(ctx, suspendido.clientId, 'suspendido.test');
  for (const nombre of ['dani', 'eva']) {
    ids[nombre] = (await createMailbox(ctx, dominioSuspendido.domainId, nombre)).mailboxId;
  }
  await cambiar('POST', '/api/aliases', {
    domainId: dominioActivo.domainId,
    localPart: 'equipo',
    destinations: ['ana@activo.test', 'beto@activo.test'],
  });
  await cambiar('POST', '/api/aliases', {
    domainId: dominioSuspendido.domainId,
    localPart: 'ventas',
    destinations: ['dani@suspendido.test', 'fuera@externo.test'],
  });
  await cambiar('PATCH', `/api/mailboxes/${ids.beto}`, { status: 'suspended' });
  await cambiar('PATCH', `/api/mailboxes/${ids.eva}`, { status: 'suspended' });
  await cambiar('PATCH', `/api/clients/${suspendido.clientId}`, { suspended: true });
  conectarMotor();
}

before(async () => {
  motorUrl = await new Promise<string>((resolve) =>
    motor.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(motor.address() as AddressInfo).port}`)),
  );
  ctx = await adminContext();
});

after(() => {
  motor.closeAllConnections();
  motor.close();
});

test('en modo demostración no hace nada ni se da por hecha', async () => {
  assert.equal(config.demoMode, true);
  const resultado = await repararSuspensiones();
  assert.equal(resultado.estado, 'omitida');
  assert.equal(reparacionSuspensionesHecha(), false, 'se hará cuando haya un motor real');
  assert.equal(recibidas.length, 0);
});

test('en una instalación sin buzones suspendidos ni alias se da por hecha sin preguntar al motor', async () => {
  conectarMotor();
  assert.deepEqual(await repararSuspensiones(), { estado: 'hecha', buzones: 0, alias: 0, omitidos: 0, fallidos: 0 });
  assert.equal(reparacionSuspensionesHecha(), true);
  assert.equal(recibidas.length, 0);
});

test('con el motor caído queda pendiente; cuando responde, la hace una sola vez', async () => {
  await crearDatos();
  olvidarCorreccion();

  const registro: string[] = [];
  caido = true;
  iniciarReparacionSuspensiones({
    info: (msg) => registro.push(`info: ${msg}`),
    warn: (msg) => registro.push(`warn: ${msg}`),
  });
  // La del arranque sigue en marcha: se recibe su mismo resultado.
  const pendiente = await repararSuspensiones();
  assert.deepEqual(pendiente, { estado: 'pendiente', buzones: 0, alias: 0, omitidos: 0, fallidos: 0 });
  assert.equal(reparacionSuspensionesHecha(), false);
  assert.match(
    registro.join('\n'),
    /warn: La corrección de 3 buzones suspendidos y 2 alias en el motor queda pendiente: el motor de correo no responde/,
  );

  caido = false;
  recibidas.length = 0;
  const hecha = await repararSuspensiones();
  assert.deepEqual(hecha, { estado: 'hecha', buzones: 3, alias: 2, omitidos: 0, fallidos: 0 });
  // Solo los suspendidos (por sí mismos o por su cliente), con el método actual...
  const buzones = parches().filter((p) => !ALIAS.some((a) => p.path.endsWith(a)));
  assert.deepEqual(rutasDe(buzones), SUSPENDIDOS);
  for (const p of buzones) assert.deepEqual(p.body, SUSPENDER);
  // ...y todos los alias, con los destinos del panel.
  assert.deepEqual(parches('equipo@').map((p) => p.body), [
    [
      { action: 'set', field: 'members', value: ['ana@activo.test', 'beto@activo.test'] },
      { action: 'set', field: 'externalMembers', value: [] },
    ],
  ]);
  assert.deepEqual(parches('ventas@').map((p) => p.body), [
    [
      { action: 'set', field: 'members', value: ['dani@suspendido.test'] },
      { action: 'set', field: 'externalMembers', value: ['fuera@externo.test'] },
    ],
  ]);
  assert.equal(reparacionSuspensionesHecha(), true);

  // En la actividad y en el registro, solo recuentos.
  const anotacion = listAudit({ viewerIsAdmin: true }).find((a) => a.action === 'engine.suspensions_repaired');
  assert.ok(anotacion);
  assert.deepEqual(anotacion.detail, { mailboxes: 3, aliasesUpdated: 2, skipped: 0 });
  assert.equal(anotacion.userId, null);
  assert.match(registro.join('\n'), /info: Corrección aplicada en el motor: 3 buzones suspendidos y 2 alias\./);
  assert.ok(!registro.join('\n').includes('@'), 'el registro no lleva direcciones');

  // Hecha una vez, no vuelve a tocar el motor (tampoco en el siguiente arranque).
  recibidas.length = 0;
  assert.equal((await repararSuspensiones()).estado, 'hecha');
  assert.equal(recibidas.length, 0);
});

test('si el motor falla con algún buzón, espera antes de repetirla entera', async (t) => {
  olvidarCorreccion();
  conError.add('dani@suspendido.test');
  const parcial = await repararSuspensiones();
  assert.deepEqual(parcial, { estado: 'pendiente', buzones: 2, alias: 2, omitidos: 0, fallidos: 1 });
  assert.equal(reparacionSuspensionesHecha(), false);

  // No se repite en cada vuelta del vigilante.
  recibidas.length = 0;
  assert.equal((await repararSuspensiones()).estado, 'pendiente');
  assert.equal(recibidas.length, 0);

  conError.clear();
  const ahora = Date.now();
  t.mock.method(Date, 'now', () => ahora + 11 * 60_000);
  const hecha = await repararSuspensiones();
  assert.deepEqual(hecha, { estado: 'hecha', buzones: 3, alias: 2, omitidos: 0, fallidos: 0 });
  assert.equal(reparacionSuspensionesHecha(), true);
});

test('lo que el motor no tiene no impide darla por hecha', async () => {
  olvidarCorreccion();
  // dani no está en el motor: ni su suspensión ni el alias ventas@ (que lo
  // tiene de destino) se pueden corregir desde aquí.
  ausentes.add('dani@suspendido.test');
  try {
    const resultado = await repararSuspensiones();
    assert.deepEqual(resultado, { estado: 'hecha', buzones: 2, alias: 1, omitidos: 2, fallidos: 0 });
  } finally {
    ausentes.clear();
  }
});

test('un buzón reactivado mientras se corrige no se vuelve a suspender', async () => {
  olvidarCorreccion();
  // Una ruta está reactivando a beto: tiene su turno y cambia el motor antes que el panel.
  let soltar!: () => void;
  const enMotor = new Promise<void>((resolve) => (soltar = resolve));
  const ruta = withLock(mailboxStateLockKey(ids.beto!), () => enMotor);

  const correccion = repararSuspensiones();
  // La corrección ya ha leído a beto como suspendido y espera su turno
  // mientras corrige a los demás.
  await hasta(() => parches().length === 2);
  db.prepare("UPDATE mailboxes SET status = 'active' WHERE id = ?").run(ids.beto);
  soltar();
  await ruta;
  try {
    const resultado = await correccion;
    assert.deepEqual(resultado, { estado: 'hecha', buzones: 2, alias: 2, omitidos: 1, fallidos: 0 });
    assert.deepEqual(parches('beto@'), [], 'beto se queda como lo dejó la ruta');
  } finally {
    db.prepare("UPDATE mailboxes SET status = 'suspended' WHERE id = ?").run(ids.beto);
  }
});

test('la ruta del buzón espera su turno para cambiarlo en el motor', async () => {
  let soltar!: () => void;
  const enCurso = new Promise<void>((resolve) => (soltar = resolve));
  const ocupado = withLock(mailboxStateLockKey(ids.ana!), () => enCurso);
  recibidas.length = 0;
  let respondida = false;
  const peticion = ctx.app
    .inject({
      method: 'PATCH',
      url: `/api/mailboxes/${ids.ana}`,
      headers: { cookie: ctx.adminCookie },
      payload: { displayName: 'Ana' },
    })
    .then((res) => {
      respondida = true;
      return res;
    });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(respondida, false);
  assert.equal(parches().length, 0, 'no llega al motor mientras otro tiene el turno');
  soltar();
  await ocupado;
  assert.equal((await peticion).statusCode, 200);
  assert.deepEqual(rutasDe(parches()), ['ana@activo.test']);
});

test('un alias que una ruta cambia o borra mientras se corrige se queda como diga el panel', async () => {
  const fila = db
    .prepare("SELECT * FROM aliases WHERE local_part = 'equipo'")
    .get() as { id: string; domain_id: string; local_part: string; destinations_json: string; created_at: number };
  try {
    // Una ruta quita a beto del alias justo cuando el motor recibe los destinos antiguos.
    olvidarCorreccion();
    alRecibirPatch = (nombre) => {
      if (nombre !== 'equipo@activo.test') return;
      alRecibirPatch = null;
      db.prepare('UPDATE aliases SET destinations_json = ? WHERE id = ?').run('["ana@activo.test"]', fila.id);
    };
    assert.equal((await repararSuspensiones()).estado, 'hecha');
    assert.deepEqual(
      parches('equipo@').map((p) => (p.body as { field: string; value: unknown }[])[0]?.value),
      [['ana@activo.test', 'beto@activo.test'], ['ana@activo.test']],
      'se vuelve a fijar con los destinos nuevos',
    );

    // Y otra lo borra: no puede quedar vivo en el motor.
    olvidarCorreccion();
    alRecibirPatch = (nombre) => {
      if (nombre !== 'equipo@activo.test') return;
      alRecibirPatch = null;
      db.prepare('DELETE FROM aliases WHERE id = ?').run(fila.id);
    };
    assert.equal((await repararSuspensiones()).estado, 'hecha');
    assert.ok(recibidas.some((p) => p.method === 'DELETE' && p.path === '/api/principal/equipo@activo.test'));
  } finally {
    alRecibirPatch = null;
    db.prepare(
      `INSERT INTO aliases (id, domain_id, local_part, destinations_json, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET destinations_json = excluded.destinations_json`,
    ).run(fila.id, fila.domain_id, fila.local_part, fila.destinations_json, fila.created_at);
  }
});

test('el vigilante hace la corrección que quedó pendiente', async () => {
  olvidarCorreccion();
  caido = true;
  await runWatchdogOnce();
  assert.equal(reparacionSuspensionesHecha(), false);

  caido = false;
  recibidas.length = 0;
  await runWatchdogOnce();
  assert.equal(reparacionSuspensionesHecha(), true);
  assert.deepEqual(rutasDe(parches()), [...SUSPENDIDOS, ...ALIAS].sort());
});

test('con el motor en mantenimiento queda pendiente, sin tocarlo ni avisar, y se hace al terminar', async () => {
  olvidarCorreccion();
  activarMantenimiento(5);
  try {
    const registro: string[] = [];
    iniciarReparacionSuspensiones({ info: (msg) => registro.push(msg), warn: (msg) => registro.push(msg) });
    assert.equal((await repararSuspensiones()).estado, 'pendiente');
    await runWatchdogOnce();
    assert.equal(reparacionSuspensionesHecha(), false);
    assert.equal(parches().length, 0, 'ningún cambio llega al motor durante el mantenimiento');
    assert.deepEqual(registro, [], 'el mantenimiento es a propósito: no es un fallo que avisar');
  } finally {
    desactivarMantenimiento();
  }

  await runWatchdogOnce();
  assert.equal(reparacionSuspensionesHecha(), true);
  assert.deepEqual(rutasDe(parches()), [...SUSPENDIDOS, ...ALIAS].sort());
});
