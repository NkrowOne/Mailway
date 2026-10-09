import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Transporter } from 'nodemailer';
import { db } from '../src/core/db';
import { isInternalHost } from '../src/core/hostnames';
import { getEngine } from '../src/engine';
import {
  checkPerMinute,
  effectiveDailyLimit,
  forgetApiKey,
  getTransport,
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

test('las cabeceras de destinatarios, remitente, estructura o autenticación se rechazan sin gastar cupo', async () => {
  // nodemailer calcula el sobre SMTP con las cabeceras de direcciones: un
  // «Bcc» en «headers» añadía destinatarios sin validar y por encima de los
  // límites, y un «From» cambiaba el remitente fijado por la clave.
  const { key, info } = await crearClave({ dailyLimit: 1 });
  const rechazadas: Record<string, string>[] = [
    { Bcc: 'oculto@fuera.example' },
    { cc: 'oculto@fuera.example' },
    { TO: 'oculto@fuera.example' },
    { From: 'jefe@otro-cliente.example' },
    { Sender: 'jefe@otro-cliente.example' },
    { 'Reply-To': 'respuestas@fuera.example' },
    { Subject: 'Otro asunto' },
    { 'Resent-To': 'oculto@fuera.example' },
    { 'Content-Type': 'text/html' },
    { 'MIME-Version': '1.0' },
    { 'DKIM-Signature': 'v=1; d=otro.example' },
    { 'Authentication-Results': 'mx; dmarc=pass' },
    { 'X-Campaign': 'otoño\r\nBcc: oculto@fuera.example' },
    { 'Mal nombre': 'x' },
    { 'X-Campaña': 'x' },
  ];
  for (const headers of rechazadas) {
    const res = await enviar(key, { headers });
    assert.equal(res.statusCode, 400, `${JSON.stringify(headers)} → ${res.body}`);
  }
  const bcc = await enviar(key, { headers: { Bcc: 'oculto@fuera.example' } });
  assert.match((bcc.json() as { error: string }).error, /«Bcc»/);

  const buenas = await enviar(key, {
    headers: { 'X-Campaign': 'otoño', 'List-Unsubscribe': '<mailto:baja@ejemplo.com>', 'In-Reply-To': '<a@b>' },
  });
  assert.equal(buenas.statusCode, 200, buenas.body);
  const usage = db
    .prepare('SELECT COALESCE(SUM(count), 0) AS c FROM api_usage WHERE api_key_id = ?')
    .get(info.id) as { c: number };
  assert.equal(usage.c, 1, 'solo cuenta el envío válido');
});

test('se admiten como máximo 30 cabeceras adicionales', async () => {
  const { key } = await crearClave();
  const cabeceras = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`X-Dato-${i}`, 'v']));
  assert.equal((await enviar(key, { headers: cabeceras(30) })).statusCode, 200);
  assert.equal((await enviar(key, { headers: cabeceras(31) })).statusCode, 400);
});

/** Cliente propio con un plan a medida: los límites del plan son por cliente. */
async function clienteConPlan(limites: { apiDailyLimit: number; apiPerMinuteLimit: number }) {
  const plan = await ctx.app.inject({
    method: 'POST',
    url: '/api/plans',
    headers: { cookie: ctx.adminCookie },
    payload: {
      name: `API ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      maxDomains: 1,
      maxMailboxes: 5,
      maxAliases: 5,
      mailboxQuotaMb: 1024,
      ...limites,
    },
  });
  assert.equal(plan.statusCode, 200, plan.body);
  const cliente = await createClient(ctx);
  const cambio = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/clients/${cliente.clientId}`,
    headers: { cookie: ctx.adminCookie },
    payload: { planId: plan.json().plan.id },
  });
  assert.equal(cambio.statusCode, 200, cambio.body);
  const { domainId } = await createDomain(ctx, cliente.clientId);
  const buzon = await createMailbox(ctx, domainId, 'avisos');
  const clave = async (nombre: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/apikeys',
      headers: { cookie: ctx.adminCookie },
      payload: { clientId: cliente.clientId, name: nombre, senderMailboxId: buzon.mailboxId },
    });
    assert.equal(res.statusCode, 200, res.body);
    return (res.json() as { key: string }).key;
  };
  return { clientId: cliente.clientId, clave };
}

test('el límite por minuto del plan responde 429 rate_limited', async () => {
  const { clave } = await clienteConPlan({ apiDailyLimit: 100, apiPerMinuteLimit: 2 });
  const key = await clave('Minuto');
  assert.equal((await enviar(key)).statusCode, 200);
  assert.equal((await enviar(key)).statusCode, 200);
  const tercero = await enviar(key);
  assert.equal(tercero.statusCode, 429);
  assert.equal(tercero.json().code, 'rate_limited');
});

test('el límite por minuto es del cliente: varias claves no lo multiplican', async () => {
  const { clave } = await clienteConPlan({ apiDailyLimit: 100, apiPerMinuteLimit: 2 });
  const a = await clave('Clave A');
  const b = await clave('Clave B');
  assert.equal((await enviar(a)).statusCode, 200);
  assert.equal((await enviar(b)).statusCode, 200);
  const res = await enviar(await clave('Clave C'));
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().code, 'rate_limited');
});

test('el cupo diario del plan es del cliente: varias claves no lo multiplican', async () => {
  const { clientId: cliente, clave } = await clienteConPlan({ apiDailyLimit: 3, apiPerMinuteLimit: 100 });
  const a = await clave('Clave A');
  const b = await clave('Clave B');
  assert.equal((await enviar(a)).statusCode, 200);
  assert.equal((await enviar(a)).statusCode, 200);
  assert.equal((await enviar(b)).statusCode, 200);
  const cuarto = await enviar(b);
  assert.equal(cuarto.statusCode, 429);
  assert.equal(cuarto.json().code, 'daily_limit_reached');
  assert.match(cuarto.json().error, /sumando todas sus claves/);
  const enviados = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE client_id = ?').get(cliente) as { c: number };
  assert.equal(enviados.c, 3, 'el rechazado no queda como envío');
});

test('una petición mal formada no gasta la ventana por minuto', async () => {
  const { clave } = await clienteConPlan({ apiDailyLimit: 100, apiPerMinuteLimit: 1 });
  const key = await clave('Formato');
  const mala = await enviar(key, { text: undefined, html: undefined });
  assert.equal(mala.statusCode, 400);
  const otraMala = await enviar(key, { to: 'no-es-un-correo' });
  assert.equal(otraMala.statusCode, 400);
  assert.equal((await enviar(key)).statusCode, 200, 'el único envío del minuto sigue disponible');
});

test('un cliente suspendido no puede crear claves de API', async () => {
  const { clientId: cliente, clave } = await clienteConPlan({ apiDailyLimit: 100, apiPerMinuteLimit: 100 });
  await clave('Antes');
  db.prepare('UPDATE clients SET suspended = 1 WHERE id = ?').run(cliente);
  try {
    const buzon = db
      .prepare('SELECT m.id FROM mailboxes m JOIN domains d ON d.id = m.domain_id WHERE d.client_id = ?')
      .get(cliente) as { id: string };
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/apikeys',
      headers: { cookie: ctx.adminCookie },
      payload: { clientId: cliente, name: 'Durante', senderMailboxId: buzon.id },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().code, 'client_suspended');
  } finally {
    db.prepare('UPDATE clients SET suspended = 0 WHERE id = ?').run(cliente);
  }
});

test('el alta y la revocación de claves se anotan en la actividad del cliente', async () => {
  const { key, info } = await crearClave();
  assert.ok(key);
  const del = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/apikeys/${info.id}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(del.statusCode, 200);
  const filas = db
    .prepare("SELECT action, client_id FROM audit_log WHERE action IN ('apikey.created', 'apikey.revoked') AND detail LIKE ?")
    .all(`%${info.id}%`) as { action: string; client_id: string | null }[];
  assert.deepEqual(filas.map((f) => f.action).sort(), ['apikey.created', 'apikey.revoked']);
  assert.ok(filas.every((f) => f.client_id === clientId));
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
  engine.addAppPassword = async (email, label, propuesta) => {
    const creada = await add(email, label, propuesta);
    anadidas.push(creada.ref);
    return creada;
  };
  engine.removeAppPassword = async (email, ref) => {
    retiradas.push(ref);
    await remove(email, ref);
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
