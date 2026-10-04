import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../src/core/errors';
import { sha512Crypt } from '../src/core/sha512crypt';
import { StalwartEngine } from '../src/engine/stalwart';

/*
 * Driver de Stalwart contra un `fetch` falso con la semántica real de la API
 * de gestión de la v0.15 (comprobada en su código fuente):
 * - los errores de gestión vuelven con HTTP 200 y { error, item } sin «data»;
 * - «notFound» lleva en `item` el nombre que no existe (el principal de la
 *   ruta o un miembro de la lista);
 * - los miembros de una lista deben existir y se validan antes de escribir;
 * - un GET omite los campos vacíos (un buzón suspendido llega SIN «roles»);
 * - un HTTP 404 solo significa «ruta desconocida».
 */

interface Principal {
  type: 'individual' | 'list' | 'domain';
  secrets?: string[];
  roles?: string[];
  members?: string[];
  externalMembers?: string[];
}

interface Llamada {
  method: string;
  path: string;
  body: unknown;
}

const principales = new Map<string, Principal>();
const llamadas: Llamada[] = [];
/** true = el servidor no conoce ninguna ruta (URL del motor mal configurada). */
let rutaDesconocida = false;
/**
 * Nombre en ejecución del motor (core.network.server_name): con el que genera
 * los registros DNS. null = no propone ningún MX; Error = fallo de gestión.
 */
let nombreEnEjecucion: string | null | Error = 'mail.acme.test';

function respuesta(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sinVacios(p: Principal): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(p).filter(([, v]) => !(Array.isArray(v) && v.length === 0) && v !== undefined),
  );
}

function faltaMiembro(miembros: unknown): string | null {
  if (!Array.isArray(miembros)) return null;
  for (const m of miembros as string[]) if (!principales.has(m)) return m;
  return null;
}

/** Ajustes del motor (POST /api/settings) y errores que devolverá la recarga. */
const ajustes = new Map<string, string>();
let erroresDeRecarga: Record<string, unknown> = {};

const fetchOriginal = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
  llamadas.push({ method, path: url.pathname, body });
  if (rutaDesconocida) return respuesta(404, { status: 404, title: 'Not Found' });

  // Como dns.rs de la v0.15.5: genera los registros de cualquier nombre, sin
  // exigir que el dominio exista, con el nombre en ejecución del servidor.
  if (url.pathname.startsWith('/api/dns/records/') && method === 'GET') {
    const dominio = decodeURIComponent(url.pathname.slice('/api/dns/records/'.length));
    if (nombreEnEjecucion instanceof Error) return respuesta(200, { error: 'other', details: nombreEnEjecucion.message });
    if (nombreEnEjecucion === null) return respuesta(200, { data: [] });
    return respuesta(200, {
      data: [
        { type: 'MX', name: `${dominio}.`, content: `10 ${nombreEnEjecucion}.` },
        { type: 'CNAME', name: `mail.${dominio}.`, content: `${nombreEnEjecucion}.` },
        { type: 'TXT', name: `${dominio}.`, content: 'v=spf1 mx ra=postmaster -all' },
      ],
    });
  }

  // Ajustes, con la semántica de settings.rs de la v0.15.5: «keys» devuelve
  // las claves exactas y todo lo que cuelga de cada «prefixes»; «clear»
  // borra un prefijo y «insert» con assert_empty falla si la primera clave existe.
  if (url.pathname === '/api/settings/keys' && method === 'GET') {
    const out: Record<string, string> = {};
    for (const k of (url.searchParams.get('keys') || '').split(',').filter(Boolean)) {
      if (ajustes.has(k)) out[k] = ajustes.get(k)!;
    }
    for (const p of (url.searchParams.get('prefixes') || '').split(',').filter(Boolean)) {
      for (const [k, v] of ajustes) if (k.startsWith(`${p}.`)) out[k] = v;
    }
    return respuesta(200, { data: out });
  }
  if (url.pathname === '/api/settings' && method === 'POST') {
    for (const op of body as { type: string; prefix?: string | null; values?: [string, string][]; assert_empty?: boolean; keys?: string[] }[]) {
      if (op.type === 'clear') for (const k of [...ajustes.keys()]) if (k.startsWith(op.prefix!)) ajustes.delete(k);
      if (op.type === 'insert') {
        if (op.assert_empty && ajustes.has(op.values![0]![0])) return respuesta(200, { error: 'assertFailed' });
        for (const [k, v] of op.values!) ajustes.set(k, v);
      }
    }
    return respuesta(200, { data: null });
  }
  if (url.pathname === '/api/reload' && method === 'GET') {
    return respuesta(200, { data: { errors: erroresDeRecarga, warnings: {} } });
  }

  const nombre = decodeURIComponent(url.pathname.replace(/^\/api\/principal\/?/, ''));
  if (url.pathname === '/api/principal' && method === 'POST') {
    const nuevo = body as Principal & { name: string };
    if (principales.has(nuevo.name)) {
      return respuesta(200, { error: 'fieldAlreadyExists', field: 'name', value: nuevo.name });
    }
    const falta = faltaMiembro(nuevo.members);
    if (falta) return respuesta(200, { error: 'notFound', item: falta });
    principales.set(nuevo.name, {
      type: nuevo.type,
      secrets: nuevo.secrets,
      roles: nuevo.roles,
      members: nuevo.members,
      externalMembers: nuevo.externalMembers,
    });
    return respuesta(200, { data: 1 });
  }
  const actual = principales.get(nombre);
  if (!actual) return respuesta(200, { error: 'notFound', item: nombre });
  if (method === 'GET') return respuesta(200, { data: { name: nombre, ...sinVacios(actual) } });
  if (method === 'DELETE') {
    principales.delete(nombre);
    return respuesta(200, { data: null });
  }
  if (method === 'PATCH') {
    const cambios = body as { action: string; field: keyof Principal; value: unknown }[];
    // Se valida todo antes de escribir nada, como Stalwart.
    for (const c of cambios) {
      const falta = c.field === 'members' ? faltaMiembro(c.value) : null;
      if (falta) return respuesta(200, { error: 'notFound', item: falta });
    }
    for (const c of cambios) if (c.action === 'set') (actual as Record<string, unknown>)[c.field] = c.value;
    return respuesta(200, { data: null });
  }
  return respuesta(404, { status: 404, title: 'Not Found' });
}) as typeof fetch;

after(() => {
  globalThis.fetch = fetchOriginal;
});

beforeEach(() => {
  ajustes.clear();
  erroresDeRecarga = {};
  principales.clear();
  llamadas.length = 0;
  rutaDesconocida = false;
  nombreEnEjecucion = 'mail.acme.test';
});

const motor = new StalwartEngine({
  kind: 'stalwart',
  url: 'http://motor.test:8080',
  adminUser: 'admin',
  adminPassword: 'secreto',
  smtpHost: 'motor.test',
  smtpPort: 587,
  smtpSecure: false,
});

function buzon(nombre: string, extra: Partial<Principal> = {}): void {
  principales.set(nombre, { type: 'individual', secrets: [sha512Crypt('clave-correcta')], roles: ['user'], ...extra });
}

/* --------------------------------- Alias ---------------------------------- */

test('upsertAlias de una lista existente: un único PATCH, sin borrarla', async () => {
  buzon('ana@acme.test');
  buzon('bob@acme.test');
  principales.set('ventas@acme.test', { type: 'list', members: ['ana@acme.test'], externalMembers: [] });

  await motor.upsertAlias('ventas@acme.test', ['ana@acme.test', 'bob@acme.test'], ['fuera@gmail.test']);

  assert.deepEqual(
    llamadas.map((l) => `${l.method} ${l.path}`),
    ['PATCH /api/principal/ventas%40acme.test'],
  );
  assert.deepEqual(llamadas[0]!.body, [
    { action: 'set', field: 'members', value: ['ana@acme.test', 'bob@acme.test'] },
    { action: 'set', field: 'externalMembers', value: ['fuera@gmail.test'] },
  ]);
  assert.deepEqual(principales.get('ventas@acme.test')?.members, ['ana@acme.test', 'bob@acme.test']);
  assert.deepEqual(principales.get('ventas@acme.test')?.externalMembers, ['fuera@gmail.test']);
});

test('upsertAlias de una lista que no existe: la crea con POST', async () => {
  buzon('ana@acme.test');
  await motor.upsertAlias('info@acme.test', ['ana@acme.test'], []);
  assert.deepEqual(
    llamadas.map((l) => l.method),
    ['PATCH', 'POST'],
  );
  assert.equal(principales.get('info@acme.test')?.type, 'list');
  assert.deepEqual(principales.get('info@acme.test')?.members, ['ana@acme.test']);
});

test('upsertAlias con un miembro inexistente falla sin tocar la lista', async () => {
  buzon('ana@acme.test');
  principales.set('ventas@acme.test', { type: 'list', members: ['ana@acme.test'], externalMembers: [] });

  await assert.rejects(
    motor.upsertAlias('ventas@acme.test', ['ana@acme.test', 'bob@acme.test'], []),
    (err: HttpError) => err.code === 'engine_not_found' && /bob@acme\.test/.test(err.message),
  );
  // Antes se borraba la lista y la creación fallaba: el alias desaparecía.
  assert.deepEqual(principales.get('ventas@acme.test')?.members, ['ana@acme.test']);
  assert.ok(!llamadas.some((l) => l.method === 'DELETE' || l.method === 'POST'));
});

/* ------------------------------ HTTP 404 real ------------------------------ */

test('un HTTP 404 (ruta desconocida) es un error del motor, nunca «no existe»', async () => {
  buzon('ana@acme.test');
  rutaDesconocida = true;

  await assert.rejects(motor.deleteMailbox('ana@acme.test'), (err: HttpError) => {
    assert.equal(err.code, 'engine_error');
    assert.match(err.message, /no reconoce la ruta de gestión/);
    return true;
  });
  await assert.rejects(motor.deleteAlias('ventas@acme.test'), (err: HttpError) => err.code === 'engine_error');
  await assert.rejects(motor.deleteDomain('acme.test'), (err: HttpError) => err.code === 'engine_error');
  assert.equal(principales.has('ana@acme.test'), true);

  // Sin poder consultar, la contraseña queda «sin comprobar» (503), no «incorrecta».
  assert.equal(await motor.verifyCredentials('ana@acme.test', 'clave-correcta'), null);
  const salud = await motor.ping();
  assert.equal(salud.ok, false);
  assert.match(salud.detail ?? '', /Revisa la URL del motor/);
});

test('un borrado de algo que ya no existe ({ error: "notFound" }) sigue siendo idempotente', async () => {
  await motor.deleteMailbox('nadie@acme.test');
  await motor.deleteAlias('nada@acme.test');
});

/* --------------------------- verifyCredentials ----------------------------- */

test('verifyCredentials: un buzón suspendido llega sin «roles» y se rechaza', async () => {
  buzon('ana@acme.test');
  assert.equal(await motor.verifyCredentials('ana@acme.test', 'clave-correcta'), true);
  assert.equal(await motor.verifyCredentials('ana@acme.test', 'otra'), false);

  // Suspendido: roles [] → el GET omite la clave.
  principales.get('ana@acme.test')!.roles = [];
  assert.equal(await motor.verifyCredentials('ana@acme.test', 'clave-correcta'), false);

  assert.equal(await motor.verifyCredentials('nadie@acme.test', 'clave-correcta'), false);

  // Una lista (alias) nunca autentica, aunque tuviera secretos.
  principales.set('lista@acme.test', { type: 'list', secrets: [sha512Crypt('clave-correcta')], roles: ['user'] });
  assert.equal(await motor.verifyCredentials('lista@acme.test', 'clave-correcta'), false);
});

/* --------------------------- Nombre en ejecución --------------------------- */

test('getRunningHostname lee el destino del MX que genera el motor, con un dominio reservado', async () => {
  nombreEnEjecucion = 'Mail.ACME.test';
  assert.equal(await motor.getRunningHostname(), 'mail.acme.test');
  assert.deepEqual(
    llamadas.map((l) => `${l.method} ${l.path}`),
    ['GET /api/dns/records/mailway.invalid'],
    'pregunta por un dominio que no existe: la ruta no lo exige',
  );

  // Sin server.hostname, Stalwart se presenta con el nombre del contenedor.
  nombreEnEjecucion = '3f2a1b4c5d6e';
  assert.equal(await motor.getRunningHostname(), '3f2a1b4c5d6e');

  nombreEnEjecucion = null;
  assert.equal(await motor.getRunningHostname(), null);
});

test('getRunningHostname propaga los errores de gestión (HTTP 200 con { error })', async () => {
  nombreEnEjecucion = new Error('Fallo simulado');
  await assert.rejects(motor.getRunningHostname(), (err: HttpError) => err.code === 'engine_error');
  rutaDesconocida = true;
  await assert.rejects(motor.getRunningHostname(), (err: HttpError) => /no reconoce la ruta/.test(err.message));
});

/* ------------------------ Recepción en otro proveedor ---------------------- */

test('syncRemoteDomains escribe las reglas de Mailway, recarga y no repite si no cambian', async () => {
  const r = await motor.syncRemoteDomains(['traslado.es', 'Otro.es.']);
  assert.deepEqual(r, { changed: true, customized: false, errors: [], warnings: [] });
  assert.equal(
    ajustes.get('session.rcpt.directory.0000.if'),
    "!is_empty(authenticated_as) && (rcpt_domain == 'otro.es' || rcpt_domain == 'traslado.es')",
  );
  assert.equal(ajustes.get('session.rcpt.directory.0000.then'), 'false');
  assert.equal(ajustes.get('queue.strategy.route.0000.then'), "'mx'");
  assert.equal(ajustes.get('queue.strategy.route.0002.else'), "'mx'", 'el resto, como el valor por defecto del motor');
  assert.ok(llamadas.some((l) => l.path === '/api/reload'));

  llamadas.length = 0;
  const otra = await motor.syncRemoteDomains(['otro.es', 'traslado.es']);
  assert.equal(otra.changed, false);
  assert.ok(!llamadas.some((l) => l.method === 'POST'), 'sin cambios no se escribe ni se recarga');

  // Lista vacía: el motor vuelve a sus valores por defecto.
  const vacia = await motor.syncRemoteDomains([]);
  assert.equal(vacia.changed, true);
  assert.equal([...ajustes.keys()].length, 0);
});

test('syncRemoteDomains no toca una configuración personalizada del motor', async () => {
  // Un valor directo tiene prioridad sobre el bloque: escribir el bloque no serviría.
  ajustes.set('queue.strategy.route', "'mx'");
  const r = await motor.syncRemoteDomains(['traslado.es']);
  assert.equal(r.customized, true);
  assert.equal(ajustes.get('queue.strategy.route'), "'mx'");
  assert.equal(ajustes.size, 1, 'no se escribe nada');

  ajustes.clear();
  ajustes.set('queue.strategy.route.0000.if', "rcpt_domain == 'interno.es'");
  ajustes.set('queue.strategy.route.0000.then', "'relay'");
  ajustes.set('queue.strategy.route.0001.else', "'mx'");
  assert.equal((await motor.syncRemoteDomains(['traslado.es'])).customized, true);
  assert.equal(ajustes.get('queue.strategy.route.0000.then'), "'relay'");
});

test('syncRemoteDomains informa de una recarga con errores y la repite si se pide', async () => {
  erroresDeRecarga = { 'spam-filter.pyzor.host': { type: 'build', error: 'Invalid address' } };
  const r = await motor.syncRemoteDomains(['traslado.es']);
  assert.equal(r.changed, true);
  assert.equal(r.errors.length, 1);
  erroresDeRecarga = {};
  llamadas.length = 0;
  const repetida = await motor.syncRemoteDomains(['traslado.es'], { reload: true });
  assert.equal(repetida.changed, false);
  assert.deepEqual(repetida.errors, []);
  assert.ok(llamadas.some((l) => l.path === '/api/reload'), 'sin cambios, pero con la recarga pendiente');
});
