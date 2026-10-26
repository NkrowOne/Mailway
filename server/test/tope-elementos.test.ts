import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { superaTopeElementos, TOPE_ELEMENTOS_CUERPO } from '../src/core/elementos';
import { adminContext, createClient, createDomain, createMailbox, type TestContext } from './helpers';

/*
 * Tope de elementos del cuerpo (aviso GHSA-mrhx-c7xc-m3w5 de zod 3): zod
 * valida cada elemento de una lista aunque pase de su `.max()`, y un cuerpo
 * de pocos MB lleno de elementos costaba cientos de MB y segundos de CPU. Se
 * rechaza antes de llegar a la ruta, sin gastar cupo ni crear nada.
 */

let ctx: TestContext;
let clientId: string;
let domainId: string;
let mailboxId: string;

before(async () => {
  ctx = await adminContext();
  ({ clientId } = await createClient(ctx));
  ({ domainId } = await createDomain(ctx, clientId));
  ({ mailboxId } = await createMailbox(ctx, domainId, 'noreply'));
});

/** `n` listas, cada una dentro de la anterior, construidas sin recursión. */
function listasAnidadas(n: number): unknown {
  let valor: unknown = [];
  for (let i = 0; i < n; i++) valor = [valor];
  return valor;
}

/* --------------------------------- Recuento -------------------------------- */

test('un cuerpo normal no supera el tope', () => {
  assert.equal(superaTopeElementos(undefined), false);
  assert.equal(superaTopeElementos(null), false);
  assert.equal(superaTopeElementos({}), false);
  assert.equal(
    superaTopeElementos({
      to: ['ana@ejemplo.com', 'luis@ejemplo.com'],
      subject: 'Prueba',
      text: 'Hola',
      headers: { 'X-Campaign': 'otoño' },
      attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', content: 'JVBERi0=' }],
    }),
    false,
  );
});

test('cuenta los elementos de las listas y las claves de los objetos, y solo pasa del tope por encima', () => {
  assert.equal(TOPE_ELEMENTOS_CUERPO, 20_000);
  // «to» cuenta como una clave: 1 + 19 999 = 20 000, justo el tope.
  assert.equal(superaTopeElementos({ to: new Array(TOPE_ELEMENTOS_CUERPO - 1).fill(0) }), false);
  assert.equal(superaTopeElementos({ to: new Array(TOPE_ELEMENTOS_CUERPO).fill(0) }), true);
  assert.equal(superaTopeElementos(new Array(TOPE_ELEMENTOS_CUERPO + 1).fill(0)), true);

  // Las claves de un objeto, también con prototipo nulo.
  const claves = Object.create(null) as Record<string, number>;
  for (let i = 0; i <= TOPE_ELEMENTOS_CUERPO; i++) claves[`k${i}`] = i;
  assert.equal(superaTopeElementos({ headers: claves }), true);

  // Se suman entre todas las listas del cuerpo, no por lista.
  const mitad = () => new Array(TOPE_ELEMENTOS_CUERPO / 2).fill({ a: 1 });
  assert.equal(superaTopeElementos({ a: mitad(), b: mitad() }), true);
  assert.equal(superaTopeElementos({ a: [1, 2, 3] }, 3), true);
  assert.equal(superaTopeElementos({ a: [1, 2] }, 3), false);
});

test('un anidamiento muy profundo no desborda la pila', () => {
  const profundo = listasAnidadas(100_000);
  assert.doesNotThrow(() => superaTopeElementos(profundo));
  assert.equal(superaTopeElementos(profundo), true);
  // Con un tope mayor se recorren los 100 000 niveles enteros sin recursión.
  assert.equal(superaTopeElementos(profundo, 200_000), false);

  let objetos: Record<string, unknown> = {};
  for (let i = 0; i < 100_000; i++) objetos = { a: objetos };
  assert.equal(superaTopeElementos(objetos), true);
  assert.equal(superaTopeElementos(objetos, 200_000), false);
});

test('no recorre textos, Buffers ni otros objetos que no son planos', () => {
  assert.equal(superaTopeElementos('x'.repeat(1_000_000)), false);
  assert.equal(superaTopeElementos(Buffer.alloc(1_000_000)), false);
  assert.equal(superaTopeElementos(new Uint8Array(1_000_000)), false);
  assert.equal(superaTopeElementos(new Map(Array.from({ length: 30_000 }, (_, i) => [i, i]))), false);
  // Dentro de un objeto plano, el Buffer cuenta como una clave más.
  assert.equal(superaTopeElementos({ datos: Buffer.alloc(1_000_000) }), false);
});

/* ---------------------------------- Rutas ---------------------------------- */

async function crearClave(dailyLimit: number): Promise<{ key: string; id: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/apikeys',
    headers: { cookie: ctx.adminCookie },
    payload: { clientId, name: 'Tope de elementos', senderMailboxId: mailboxId, dailyLimit },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { key: string; info: { id: string } };
  return { key: body.key, id: body.info.id };
}

test('/v1/send con demasiados destinatarios responde 400 demasiados_elementos sin gastar cupo', async () => {
  const { key, id } = await crearClave(1);
  const mensajesAntes = (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE client_id = ?').get(clientId) as {
    c: number;
  }).c;

  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/send',
    headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'tope-elementos-1' },
    payload: { to: new Array(TOPE_ELEMENTOS_CUERPO + 1).fill(0), subject: 'Prueba', text: 'Hola' },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.deepEqual(res.json(), {
    error: 'La petición incluye demasiados elementos.',
    code: 'demasiados_elementos',
  });

  const uso = db
    .prepare('SELECT COALESCE(SUM(count), 0) AS c FROM api_usage WHERE api_key_id = ?')
    .get(id) as { c: number };
  assert.equal(uso.c, 0, 'no gasta cupo diario');
  const mensajes = (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE client_id = ?').get(clientId) as {
    c: number;
  }).c;
  assert.equal(mensajes, mensajesAntes, 'no queda como envío');

  // El cupo de 1 sigue libre y la Idempotency-Key no quedó reservada.
  const normal = await ctx.app.inject({
    method: 'POST',
    url: '/v1/send',
    headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'tope-elementos-1' },
    payload: { to: 'destino@ejemplo.com', subject: 'Prueba', text: 'Hola' },
  });
  assert.equal(normal.statusCode, 200, normal.body);
  assert.equal(normal.json().status, 'sent');
  assert.equal(normal.headers['idempotent-replayed'], undefined);
});

test('una ruta del panel con una lista enorme responde 400 demasiados_elementos sin crear nada', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/mailboxes/bulk',
    headers: { cookie: ctx.adminCookie },
    payload: { domainId, entries: new Array(TOPE_ELEMENTOS_CUERPO + 1).fill({ localPart: 'x' }) },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().code, 'demasiados_elementos');

  const buzones = await ctx.app.inject({
    method: 'GET',
    url: `/api/mailboxes?domainId=${domainId}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.deepEqual(
    (buzones.json() as { mailboxes: { email: string }[] }).mailboxes.map((m) => m.email.split('@')[0]),
    ['noreply'],
  );
});

test('el alta masiva más grande que admite el esquema sigue funcionando', async () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ localPart: `lote${i}`, displayName: `Persona ${i}` }));
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/mailboxes/bulk',
    headers: { cookie: ctx.adminCookie },
    payload: { domainId, entries, dryRun: true, setupLinks: { ttlHours: 72 } },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as { results: unknown[] }).results.length, 100);
});
