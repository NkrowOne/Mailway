import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Transporter } from 'nodemailer';
import { db } from '../src/core/db';
import { getEngine } from '../src/engine';
import {
  checkPerMinute,
  effectiveDailyLimit,
  forgetApiKey,
  getTransport,
  isInternalHost,
  messageSizeBytes,
  minuteBucketCount,
  setTransportFactoryForTests,
  smtpTlsOptions,
  transportCount,
} from '../src/modules/transactional';
import {
  adminContext,
  createClient,
  createDomain,
  createMailbox,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let clientId: string;
let mailboxId: string;
let mailboxEmail: string;

before(async () => {
  ctx = await adminContext();
  ({ clientId } = await createClient(ctx));
  const { domainId } = await createDomain(ctx, clientId);
  ({ mailboxId, email: mailboxEmail } = await createMailbox(ctx, domainId, 'noreply'));
});

after(() => {
  setTransportFactoryForTests(null);
});

async function crearClave(opts: { dailyLimit?: number; sender?: string } = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/apikeys',
    headers: { cookie: ctx.adminCookie },
    payload: {
      clientId,
      name: 'Pruebas',
      senderMailboxId: opts.sender ?? mailboxId,
      dailyLimit: opts.dailyLimit,
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { key: string; info: { id: string; prefix: string } };
}

function enviar(key: string | null, payload: Record<string, unknown> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/send',
    headers: key === null ? {} : { authorization: `Bearer ${key}` },
    payload: { to: 'destino@ejemplo.com', subject: 'Prueba', text: 'Hola', ...payload },
  });
}

/* ------------------------------ Autenticación ----------------------------- */

test('/v1/send sin cabecera responde 401 missing_api_key', async () => {
  const res = await enviar(null);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'missing_api_key');
});

test('/v1/send con una clave inexistente o mal formada responde 401 invalid_api_key', async () => {
  const inexistente = await enviar('mw_00000000_secretoinventado');
  assert.equal(inexistente.statusCode, 401);
  assert.equal(inexistente.json().code, 'invalid_api_key');

  // Un token de gestión (mwt_) no es una clave de envío.
  const malFormada = await enviar('mwt_abcdef12_otrosecreto');
  assert.equal(malFormada.statusCode, 401);
  assert.equal(malFormada.json().code, 'invalid_api_key');
});

test('/v1/send con el secreto equivocado de un prefijo real responde 401', async () => {
  const { key } = await crearClave();
  const falsa = key.slice(0, -4) + 'XXXX';
  const res = await enviar(falsa);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'invalid_api_key');
});

test('/v1/send envía en modo demostración y registra el tamaño en bytes', async () => {
  const { key, info } = await crearClave();
  const html = '<p>ñ€😀</p>'; // 3 + 2 + 3 + 4 + 4 = 16 bytes, 9 caracteres UTF-16
  const text = 'áé'; // 4 bytes
  const res = await enviar(key, { html, text });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { id: string; status: string; messageId: string };
  assert.equal(body.status, 'sent');
  assert.ok(body.messageId);

  const list = await ctx.app.inject({
    method: 'GET',
    url: `/api/messages?keyId=${info.id}`,
    headers: { cookie: ctx.adminCookie },
  });
  const message = (list.json() as { messages: { id: string; sizeBytes: number }[] }).messages.find(
    (m) => m.id === body.id,
  );
  assert.ok(message, 'el envío queda en el historial');
  assert.equal(message.sizeBytes, 20);
  assert.equal(messageSizeBytes({ html, text }), 20);
});

test('una clave revocada responde 401 revoked_api_key', async () => {
  const { key, info } = await crearClave();
  const del = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/apikeys/${info.id}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(del.statusCode, 200);
  const res = await enviar(key);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'revoked_api_key');
});

/* ------------------------------ Suspensiones ------------------------------ */

test('un cliente suspendido recibe 403 client_suspended (no 401)', async () => {
  const { key } = await crearClave();
  db.prepare('UPDATE clients SET suspended = 1 WHERE id = ?').run(clientId);
  try {
    const res = await enviar(key);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'client_suspended');
  } finally {
    db.prepare('UPDATE clients SET suspended = 0 WHERE id = ?').run(clientId);
  }
});

test('un buzón remitente suspendido recibe 403 sender_suspended y no gasta cupo', async () => {
  const { key, info } = await crearClave();
  db.prepare("UPDATE mailboxes SET status = 'suspended' WHERE id = ?").run(mailboxId);
  try {
    const res = await enviar(key);
    assert.equal(res.statusCode, 403);
    const body = res.json() as { code: string; error: string };
    assert.equal(body.code, 'sender_suspended');
    assert.match(body.error, /suspendido/);
    const usage = db
      .prepare('SELECT COALESCE(SUM(count), 0) AS c FROM api_usage WHERE api_key_id = ?')
      .get(info.id) as { c: number };
    assert.equal(usage.c, 0);

    // Tampoco se puede crear una clave nueva con ese remitente.
    const alta = await ctx.app.inject({
      method: 'POST',
      url: '/api/apikeys',
      headers: { cookie: ctx.adminCookie },
      payload: { clientId, name: 'Otra', senderMailboxId: mailboxId },
    });
    assert.equal(alta.statusCode, 400);
    assert.equal(alta.json().code, 'sender_suspended');
  } finally {
    db.prepare("UPDATE mailboxes SET status = 'active' WHERE id = ?").run(mailboxId);
  }
});

/* --------------------------------- Límites -------------------------------- */

test('el límite diario de la clave responde 429 y no consume cupo de más', async () => {
  const { key, info } = await crearClave({ dailyLimit: 2 });
  assert.equal((await enviar(key)).statusCode, 200);
  assert.equal((await enviar(key)).statusCode, 200);
  const tercero = await enviar(key);
  assert.equal(tercero.statusCode, 429);
  assert.equal(tercero.json().code, 'daily_limit_reached');
  const usage = db
    .prepare('SELECT COALESCE(SUM(count), 0) AS c FROM api_usage WHERE api_key_id = ?')
    .get(info.id) as { c: number };
  assert.equal(usage.c, 2, 'la reserva rechazada se devuelve al cupo');
});

test('un cuerpo inválido responde 400 sin gastar cupo diario', async () => {
  const { key, info } = await crearClave({ dailyLimit: 1 });
  const res = await enviar(key, { text: undefined, html: undefined });
  assert.equal(res.statusCode, 400);
  assert.equal((await enviar(key)).statusCode, 200, 'el cupo de 1 sigue disponible');
  const usage = db
    .prepare('SELECT COALESCE(SUM(count), 0) AS c FROM api_usage WHERE api_key_id = ?')
    .get(info.id) as { c: number };
  assert.equal(usage.c, 1);
});

test('el límite por minuto del plan responde 429 rate_limited', async () => {
  const { key } = await crearClave();
  const planId = (db.prepare('SELECT plan_id FROM clients WHERE id = ?').get(clientId) as {
    plan_id: string;
  }).plan_id;
  const previo = (db.prepare('SELECT api_per_minute_limit AS l FROM plans WHERE id = ?').get(planId) as {
    l: number;
  }).l;
  db.prepare('UPDATE plans SET api_per_minute_limit = 2 WHERE id = ?').run(planId);
  try {
    assert.equal((await enviar(key)).statusCode, 200);
    assert.equal((await enviar(key)).statusCode, 200);
    const tercero = await enviar(key);
    assert.equal(tercero.statusCode, 429);
    assert.equal(tercero.json().code, 'rate_limited');
  } finally {
    db.prepare('UPDATE plans SET api_per_minute_limit = ? WHERE id = ?').run(previo, planId);
  }
});

test('effectiveDailyLimit: el plan acota siempre a la clave', () => {
  assert.equal(effectiveDailyLimit(500, null), 500);
  assert.equal(effectiveDailyLimit(500, 50), 50);
  assert.equal(effectiveDailyLimit(500, 5000), 500);
  assert.equal(effectiveDailyLimit(0, null), 0, '0 = ilimitado');
  assert.equal(effectiveDailyLimit(0, 20), 20);
});

test('las ventanas por minuto caducadas se podan y la revocación las olvida', () => {
  // Instante posterior a los envíos de las pruebas anteriores, que también
  // dejaron sus ventanas en memoria y deben caer en la misma poda.
  const t0 = Date.now() + 10 * 60_000;
  checkPerMinute('key_poda_a', 5, t0);
  checkPerMinute('key_poda_b', 5, t0);
  assert.ok(minuteBucketCount() >= 2);
  // Dos minutos después, la siguiente comprobación retira las ventanas viejas.
  checkPerMinute('key_poda_c', 5, t0 + 120_000);
  assert.equal(minuteBucketCount(), 1);
  forgetApiKey('key_poda_c');
  assert.equal(minuteBucketCount(), 0);
});

/* ------------------------------- Transportes ------------------------------ */

test('isInternalHost reconoce servicios de Docker, IP y localhost', () => {
  assert.equal(isInternalHost('mailway-mail'), true);
  assert.equal(isInternalHost('10.0.0.5'), true);
  assert.equal(isInternalHost('localhost'), true);
  assert.equal(isInternalHost('stalwart.internal'), true);
  assert.equal(isInternalHost('mail.ejemplo.com'), false);
  assert.equal(isInternalHost(''), false);
});

test('smtpTlsOptions verifica contra el nombre público al conectar por un host interno', () => {
  assert.deepEqual(smtpTlsOptions('mailway-mail', 'mail.ejemplo.com', false), {
    servername: 'mail.ejemplo.com',
  });
  assert.equal(smtpTlsOptions('mail.ejemplo.com', 'mail.ejemplo.com', false), undefined);
  assert.equal(
    smtpTlsOptions('smtp.proveedor.com', 'mail.ejemplo.com', false),
    undefined,
    'un host público se verifica contra su propio nombre',
  );
  assert.equal(smtpTlsOptions('mailway-mail', '', false), undefined);
  // La salida explícita sigue existiendo.
  assert.deepEqual(smtpTlsOptions('mailway-mail', 'mail.ejemplo.com', true), {
    servername: 'mail.ejemplo.com',
    rejectUnauthorized: false,
  });
  assert.deepEqual(smtpTlsOptions('mail.ejemplo.com', 'mail.ejemplo.com', true), {
    rejectUnauthorized: false,
  });
});

test('los transportes se reutilizan, se rehacen al cambiar los ajustes y se cierran al revocar', () => {
  const creados: { options: Record<string, unknown>; cerrado: boolean }[] = [];
  setTransportFactoryForTests((options) => {
    const registro = { options: options as unknown as Record<string, unknown>, cerrado: false };
    creados.push(registro);
    return {
      close: () => {
        registro.cerrado = true;
      },
    } as unknown as Transporter;
  });
  const ajustes = { smtpHost: 'mailway-mail', smtpPort: 465, smtpSecure: true };
  const t0 = 50_000_000;

  const a = getTransport('key_tr_1', 'noreply@ejemplo.com', 'secreto', ajustes, 'mail.ejemplo.com', t0);
  const b = getTransport('key_tr_1', 'noreply@ejemplo.com', 'secreto', ajustes, 'mail.ejemplo.com', t0 + 1);
  assert.equal(a, b, 'misma clave y ajustes: mismo pool');
  assert.equal(creados.length, 1);
  assert.deepEqual(creados[0]!.options.tls, { servername: 'mail.ejemplo.com' });

  // Cambian los ajustes del motor: el pool anterior se cierra.
  getTransport('key_tr_1', 'noreply@ejemplo.com', 'secreto', { ...ajustes, smtpPort: 587, smtpSecure: false }, 'mail.ejemplo.com', t0 + 2);
  assert.equal(creados.length, 2);
  assert.equal(creados[0]!.cerrado, true);

  forgetApiKey('key_tr_1');
  assert.equal(creados[1]!.cerrado, true, 'revocar cierra el pool');
  assert.equal(transportCount(), 0);

  // Un pool sin uso durante más de diez minutos se cierra al crear otro.
  getTransport('key_tr_2', 'a@ejemplo.com', 's', ajustes, 'mail.ejemplo.com', t0);
  getTransport('key_tr_3', 'b@ejemplo.com', 's', ajustes, 'mail.ejemplo.com', t0 + 11 * 60_000);
  assert.equal(creados[2]!.cerrado, true);
  assert.equal(transportCount(), 1);

  // Nunca hay más de 100 pools abiertos: se cierra el usado hace más tiempo.
  for (let i = 0; i < 150; i += 1) {
    getTransport(`key_lru_${i}`, `u${i}@ejemplo.com`, 's', ajustes, 'mail.ejemplo.com', t0 + 11 * 60_000 + i);
  }
  assert.ok(transportCount() <= 100);
  assert.equal(creados.filter((c) => !c.cerrado).length, transportCount());
});

/* ------------------------- Alta de clave y rollback ------------------------ */

test('si falla el INSERT de la clave se retira la contraseña de aplicación del motor', async () => {
  const engine = getEngine();
  const anadidas: string[] = [];
  const retiradas: string[] = [];
  const add = engine.addAppPassword.bind(engine);
  const remove = engine.removeAppPassword.bind(engine);
  engine.addAppPassword = async (email, password, label) => {
    const stored = await add(email, password, label);
    anadidas.push(stored);
    return stored;
  };
  engine.removeAppPassword = async (email, stored) => {
    retiradas.push(stored);
    await remove(email, stored);
  };
  db.exec(
    "CREATE TEMP TRIGGER fallo_alta_clave BEFORE INSERT ON api_keys BEGIN SELECT RAISE(ABORT, 'fallo simulado'); END;",
  );
  try {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/apikeys',
      headers: { cookie: ctx.adminCookie },
      payload: { clientId, name: 'Rollback', senderMailboxId: mailboxId },
    });
    assert.equal(res.statusCode, 500);
    assert.equal(anadidas.length, 1);
    assert.deepEqual(retiradas, anadidas, 'la contraseña recién añadida se retira');
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS c FROM api_keys WHERE name = 'Rollback'").get() as { c: number }).c,
      0,
    );
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fallo_alta_clave');
    engine.addAppPassword = add;
    engine.removeAppPassword = remove;
  }
  assert.ok(mailboxEmail.startsWith('noreply@'));
});
