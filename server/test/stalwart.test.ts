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

const fetchOriginal = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
  llamadas.push({ method, path: url.pathname, body });
  if (rutaDesconocida) return respuesta(404, { status: 404, title: 'Not Found' });

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
  principales.clear();
  llamadas.length = 0;
  rutaDesconocida = false;
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
  assert.match(salud.detail ?? '', /Revise la URL del motor/);
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
