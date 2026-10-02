import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Transporter } from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { HttpError } from '../src/core/errors';
import { setEngineSettings } from '../src/modules/settings';
import {
  IDEMPOTENCIA_EN_CURSO_MAX_MS,
  IDEMPOTENCIA_MS,
  MAX_ADJUNTOS_BYTES,
  liberarIdempotenciaInterrumpida,
  prepararAdjuntos,
  sanearNombreAdjunto,
  setTransportFactoryForTests,
} from '../src/modules/transactional';
import { adminContext, createClient, createDomain, createMailbox, type TestContext } from './helpers';

/*
 * Adjuntos e Idempotency-Key de POST /v1/send.
 */

let ctx: TestContext;
let clientId: string;
let mailboxId: string;

before(async () => {
  ctx = await adminContext();
  ({ clientId } = await createClient(ctx));
  const { domainId } = await createDomain(ctx, clientId);
  ({ mailboxId } = await createMailbox(ctx, domainId, 'facturas'));
});

after(() => {
  setTransportFactoryForTests(null);
});

async function crearClave(cliente = clientId, remitente = mailboxId): Promise<{ key: string; id: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/apikeys',
    headers: { cookie: ctx.adminCookie },
    payload: { clientId: cliente, name: 'Adjuntos', senderMailboxId: remitente },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { key: string; info: { id: string } };
  return { key: body.key, id: body.info.id };
}

function enviar(key: string, payload: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/send',
    headers: { authorization: `Bearer ${key}`, ...headers },
    payload: { to: 'destino@ejemplo.com', subject: 'Factura', text: 'Adjunta.', ...payload },
  });
}

const b64 = (contenido: string | Buffer) => Buffer.from(contenido).toString('base64');

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Mailway//Pruebas//ES',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:reunion-1@ejemplo.com',
  'DTSTART:20261010T090000Z',
  'DTEND:20261010T100000Z',
  'SUMMARY:Reunión',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 0x20), Buffer.from('\n%%EOF\n')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

function codigoDe(fn: () => unknown): { status: number; code: string } {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof HttpError, `se esperaba HttpError: ${String(err)}`);
    return { status: err.status, code: err.code };
  }
  assert.fail('se esperaba un error');
}

/* ----------------------------- Nombre saneado ----------------------------- */

test('sanearNombreAdjunto quita rutas, controles, marcas de dirección y reservados', () => {
  assert.equal(sanearNombreAdjunto('../../etc/passwd'), 'passwd');
  assert.equal(sanearNombreAdjunto('C:\\Users\\ana\\factura.pdf'), 'factura.pdf');
  // U+202E (RLO) haría que «fdp.exe» se leyera como «exe.pdf».
  assert.equal(sanearNombreAdjunto('factura\u202Efdp.exe'), 'facturafdp.exe');
  assert.equal(sanearNombreAdjunto('in\r\nforme\t.pdf'), 'informe.pdf');
  assert.equal(sanearNombreAdjunto('a"b<c>d:e*f?g|h.txt'), 'a_b_c_d_e_f_g_h.txt');
  assert.equal(sanearNombreAdjunto('...oculto.txt...'), 'oculto.txt');
  assert.equal(sanearNombreAdjunto('   '), '');
  const largo = sanearNombreAdjunto(`${'x'.repeat(300)}.pdf`);
  assert.ok(largo.length <= 120);
  assert.ok(largo.endsWith('.pdf'), 'se conserva la extensión al recortar');
});

/* --------------------------- Validación (unidad) --------------------------- */

test('prepararAdjuntos admite un ICS con method y un PDF, y canoniza el tipo', () => {
  const { adjuntos, bytes } = prepararAdjuntos([
    { filename: 'invitacion.ics', contentType: 'Text/Calendar; Method=request; charset=UTF-8; name="x"', content: b64(ICS) },
    { filename: 'factura', contentType: 'application/pdf', content: b64(PDF) },
  ]);
  assert.equal(adjuntos[0]!.contentType, 'text/calendar; method=REQUEST; charset=utf-8');
  assert.equal(adjuntos[1]!.filename, 'factura.pdf', 'sin extensión se añade la del tipo');
  assert.equal(bytes, Buffer.byteLength(ICS) + PDF.length);
});

test('prepararAdjuntos rechaza tipos no admitidos, extensiones engañosas y contenidos falsos', () => {
  assert.deepEqual(
    codigoDe(() => prepararAdjuntos([{ filename: 'a.exe', contentType: 'application/x-msdownload', content: b64('MZ') }])),
    { status: 400, code: 'attachment_type_not_allowed' },
  );
  assert.deepEqual(
    codigoDe(() => prepararAdjuntos([{ filename: 'pagina.html', contentType: 'text/html', content: b64('<p>') }])),
    { status: 400, code: 'attachment_type_not_allowed' },
  );
  assert.deepEqual(
    codigoDe(() => prepararAdjuntos([{ filename: 'factura.pdf.exe', contentType: 'application/pdf', content: b64(PDF) }])),
    { status: 400, code: 'attachment_type_not_allowed' },
  );
  // Un ejecutable con la etiqueta de PDF o de imagen no pasa por su firma.
  assert.deepEqual(
    codigoDe(() => prepararAdjuntos([{ filename: 'factura.pdf', contentType: 'application/pdf', content: b64('MZ\x90\x00') }])),
    { status: 400, code: 'attachment_invalid' },
  );
  assert.deepEqual(
    codigoDe(() => prepararAdjuntos([{ filename: 'foto.png', contentType: 'image/png', content: b64(PDF) }])),
    { status: 400, code: 'attachment_invalid' },
  );
  assert.deepEqual(
    codigoDe(() => prepararAdjuntos([{ filename: 'notas.txt', contentType: 'text/plain', content: b64(Buffer.from([0x41, 0, 0x42])) }])),
    { status: 400, code: 'attachment_invalid' },
  );
  assert.deepEqual(
    codigoDe(() => prepararAdjuntos([{ filename: 'cita.ics', contentType: 'text/calendar', content: b64('hola') }])),
    { status: 400, code: 'attachment_invalid' },
  );
  assert.deepEqual(
    codigoDe(() => prepararAdjuntos([{ filename: 'a.txt', contentType: 'text/plain', content: 'esto no es base64!' }])),
    { status: 400, code: 'attachment_invalid' },
  );
});

test('prepararAdjuntos admite base64 partido en líneas y rechaza más de 10 MB en total', () => {
  const partido = b64(PNG).replace(/(.{8})/g, '$1\r\n');
  const { adjuntos } = prepararAdjuntos([{ filename: 'logo.png', contentType: 'image/png', content: partido }]);
  assert.deepEqual(adjuntos[0]!.content, PNG);

  const seis = Buffer.concat([Buffer.from('texto '), Buffer.alloc(6 * 1024 * 1024, 0x61)]);
  assert.deepEqual(
    codigoDe(() =>
      prepararAdjuntos([
        { filename: 'a.txt', contentType: 'text/plain', content: b64(seis) },
        { filename: 'b.txt', contentType: 'text/plain', content: b64(seis) },
      ]),
    ),
    { status: 413, code: 'attachments_too_large' },
  );
  assert.equal(MAX_ADJUNTOS_BYTES, 10 * 1024 * 1024);
});

/* ------------------------------ Ruta /v1/send ----------------------------- */

test('/v1/send con un ICS y un PDF envía y cuenta su tamaño', async () => {
  const { key, id } = await crearClave();
  const res = await enviar(key, {
    attachments: [
      { filename: 'invitacion.ics', contentType: 'text/calendar; method=REQUEST', content: b64(ICS) },
      { filename: 'factura.pdf', contentType: 'application/pdf', content: b64(PDF) },
    ],
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'sent');
  const fila = db.prepare('SELECT size_bytes FROM messages WHERE api_key_id = ?').get(id) as { size_bytes: number };
  assert.equal(fila.size_bytes, Buffer.byteLength('Adjunta.') + Buffer.byteLength(ICS) + PDF.length);
});

test('/v1/send rechaza más de 5 adjuntos, tipos no admitidos y excesos sin gastar cupo', async () => {
  const { key, id } = await crearClave();
  const seis = Array.from({ length: 6 }, (_, i) => ({ filename: `n${i}.txt`, contentType: 'text/plain', content: b64('hola') }));
  const muchos = await enviar(key, { attachments: seis });
  assert.equal(muchos.statusCode, 400);
  assert.equal(muchos.json().code, 'validation');
  assert.match(muchos.json().error, /5 adjuntos/);

  const exe = await enviar(key, { attachments: [{ filename: 'x.exe', contentType: 'application/octet-stream', content: b64('MZ') }] });
  assert.equal(exe.statusCode, 400);
  assert.equal(exe.json().code, 'attachment_type_not_allowed');

  const grande = Buffer.concat([Buffer.from('a'), Buffer.alloc(11 * 1024 * 1024, 0x62)]);
  const exceso = await enviar(key, { attachments: [{ filename: 'grande.txt', contentType: 'text/plain', content: b64(grande) }] });
  assert.equal(exceso.statusCode, 413);
  assert.equal(exceso.json().code, 'attachments_too_large');

  const usado = db.prepare('SELECT COALESCE(SUM(count), 0) AS c FROM api_usage WHERE api_key_id = ?').get(id) as { c: number };
  assert.equal(usado.c, 0, 'los rechazos no gastan cupo');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE api_key_id = ?').get(id) as { c: number }).c,
    0,
  );
});

test('los adjuntos llegan al SMTP con el nombre saneado y el tipo canónico', async () => {
  const { key } = await crearClave();
  const enviados: Mail.Options[] = [];
  setTransportFactoryForTests(
    () =>
      ({
        sendMail: async (opciones: Mail.Options) => {
          enviados.push(opciones);
          return { messageId: '<prueba@mailway>' };
        },
        close: () => undefined,
      }) as unknown as Transporter,
  );
  // Sin el motor de demostración, /v1/send usa el transporte SMTP (aquí, el falso).
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
    const res = await enviar(key, {
      attachments: [
        { filename: '../informe\u202Efdp.ics', contentType: 'TEXT/CALENDAR; method=request', content: b64(ICS) },
      ],
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, 'sent');
  } finally {
    config.demoMode = true;
    setTransportFactoryForTests(null);
  }
  assert.equal(enviados.length, 1);
  const adjunto = (enviados[0]!.attachments ?? [])[0]!;
  assert.equal(adjunto.filename, 'informefdp.ics');
  assert.equal(adjunto.contentType, 'text/calendar; method=REQUEST');
  assert.equal(adjunto.contentDisposition, 'attachment');
  assert.equal(String(adjunto.content), ICS);
});

/* ----------------------------- Idempotency-Key ---------------------------- */

function enviosDe(keyId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE api_key_id = ?').get(keyId) as { c: number }).c;
}

test('la misma Idempotency-Key con la misma clave devuelve la respuesta original sin reenviar', async () => {
  const { key, id } = await crearClave();
  const primero = await enviar(key, { subject: 'OTP' }, { 'idempotency-key': 'pedido-4821' });
  assert.equal(primero.statusCode, 200, primero.body);
  assert.equal(primero.headers['idempotent-replayed'], undefined);

  // El orden de los campos no cambia el mensaje.
  const segundo = await ctx.app.inject({
    method: 'POST',
    url: '/v1/send',
    headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'pedido-4821' },
    payload: { text: 'Adjunta.', subject: 'OTP', to: 'destino@ejemplo.com' },
  });
  assert.equal(segundo.statusCode, 200, segundo.body);
  assert.equal(segundo.headers['idempotent-replayed'], 'true');
  assert.deepEqual(segundo.json(), primero.json());
  assert.equal(enviosDe(id), 1, 'solo hay un envío');
  const usado = db.prepare('SELECT COALESCE(SUM(count), 0) AS c FROM api_usage WHERE api_key_id = ?').get(id) as { c: number };
  assert.equal(usado.c, 1, 'la repetición no gasta cupo');
});

test('con otra clave de API la misma Idempotency-Key no interfiere', async () => {
  const a = await crearClave();
  const b = await crearClave();
  const ra = await enviar(a.key, {}, { 'idempotency-key': 'compartida' });
  const rb = await enviar(b.key, {}, { 'idempotency-key': 'compartida' });
  assert.equal(ra.statusCode, 200);
  assert.equal(rb.statusCode, 200);
  assert.equal(rb.headers['idempotent-replayed'], undefined);
  assert.notEqual(ra.json().id, rb.json().id);
  assert.equal(enviosDe(a.id), 1);
  assert.equal(enviosDe(b.id), 1);

  // Ni siquiera la de otro cliente.
  const otro = await createClient(ctx);
  const { domainId } = await createDomain(ctx, otro.clientId);
  const buzon = await createMailbox(ctx, domainId, 'avisos');
  const c = await crearClave(otro.clientId, buzon.mailboxId);
  const rc = await enviar(c.key, {}, { 'idempotency-key': 'compartida' });
  assert.equal(rc.statusCode, 200);
  assert.equal(rc.headers['idempotent-replayed'], undefined);
});

test('un cuerpo distinto con la misma Idempotency-Key responde 409 idempotency_conflict', async () => {
  const { key, id } = await crearClave();
  assert.equal((await enviar(key, { subject: 'Uno' }, { 'idempotency-key': 'k-1' })).statusCode, 200);
  const distinto = await enviar(key, { subject: 'Dos' }, { 'idempotency-key': 'k-1' });
  assert.equal(distinto.statusCode, 409);
  assert.equal(distinto.json().code, 'idempotency_conflict');
  assert.equal(enviosDe(id), 1);
});

/** Reserva «en curso» (sin respuesta) del cuerpo por defecto de enviar(), creada hace `hace` ms. */
async function reservaEnCurso(keyId: string, clave: string, hace = 0): Promise<void> {
  const crypto = await import('node:crypto');
  const cuerpo = { to: ['destino@ejemplo.com'], subject: 'Factura', text: 'Adjunta.' };
  const ordenado = JSON.stringify({ subject: cuerpo.subject, text: cuerpo.text, to: cuerpo.to });
  const creada = Date.now() - hace;
  db.prepare(
    `INSERT INTO send_idempotency (api_key_id, key_hash, request_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    keyId,
    crypto.createHash('sha256').update(clave).digest('hex'),
    crypto.createHash('sha256').update(ordenado).digest('hex'),
    creada,
    creada + IDEMPOTENCIA_MS,
  );
}

test('una Idempotency-Key en curso responde 409 idempotency_in_progress', async () => {
  const { key, id } = await crearClave();
  await reservaEnCurso(id, 'en-curso', IDEMPOTENCIA_EN_CURSO_MAX_MS - 60_000);
  const res = await enviar(key, {}, { 'idempotency-key': 'en-curso' });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, 'idempotency_in_progress');
  assert.equal(enviosDe(id), 0);
});

test('una reserva en curso abandonada (el proceso se detuvo a mitad) se vuelve a enviar', async () => {
  const { key, id } = await crearClave();
  await reservaEnCurso(id, 'abandonada', IDEMPOTENCIA_EN_CURSO_MAX_MS + 1000);
  const res = await enviar(key, {}, { 'idempotency-key': 'abandonada' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['idempotent-replayed'], undefined);
  assert.equal(enviosDe(id), 1);

  // La reserva nueva guarda la respuesta: el siguiente reintento es una repetición.
  const otra = await enviar(key, {}, { 'idempotency-key': 'abandonada' });
  assert.equal(otra.headers['idempotent-replayed'], 'true');
  assert.deepEqual(otra.json(), res.json());
  assert.equal(enviosDe(id), 1);

  // Abandonada, pero de otro mensaje: sigue siendo un conflicto.
  await reservaEnCurso(id, 'abandonada-otra', IDEMPOTENCIA_EN_CURSO_MAX_MS + 1000);
  const distinta = await enviar(key, { subject: 'Otro asunto' }, { 'idempotency-key': 'abandonada-otra' });
  assert.equal(distinta.statusCode, 409);
  assert.equal(distinta.json().code, 'idempotency_conflict');
});

test('al arrancar se liberan las reservas que quedaron a medias y se conservan las respuestas', async () => {
  const { key, id } = await crearClave();
  assert.equal((await enviar(key, { subject: 'Guardada' }, { 'idempotency-key': 'completa' })).statusCode, 200);
  await reservaEnCurso(id, 'interrumpida', 1000);
  assert.equal((await enviar(key, {}, { 'idempotency-key': 'interrumpida' })).statusCode, 409);

  assert.ok(liberarIdempotenciaInterrumpida() >= 1);

  const reintento = await enviar(key, {}, { 'idempotency-key': 'interrumpida' });
  assert.equal(reintento.statusCode, 200, reintento.body);
  assert.equal(reintento.headers['idempotent-replayed'], undefined);
  const repetida = await enviar(key, { subject: 'Guardada' }, { 'idempotency-key': 'completa' });
  assert.equal(repetida.headers['idempotent-replayed'], 'true', 'las respuestas ya guardadas no se tocan');
  assert.equal(enviosDe(id), 2);
});

test('Idempotency-Key no válida responde 400 sin enviar', async () => {
  const { key, id } = await crearClave();
  const larga = await enviar(key, {}, { 'idempotency-key': 'x'.repeat(201) });
  assert.equal(larga.statusCode, 400);
  assert.equal(larga.json().code, 'invalid_idempotency_key');
  const noAscii = await enviar(key, {}, { 'idempotency-key': 'clave-ñ' });
  assert.equal(noAscii.statusCode, 400);
  assert.equal(noAscii.json().code, 'invalid_idempotency_key');
  assert.equal((await enviar(key, {}, { 'idempotency-key': 'x'.repeat(200) })).statusCode, 200);
  assert.equal(enviosDe(id), 1);
});

test('un envío rechazado por el límite no guarda la Idempotency-Key y el reintento funciona', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/apikeys',
    headers: { cookie: ctx.adminCookie },
    payload: { clientId, name: 'Con límite', senderMailboxId: mailboxId, dailyLimit: 1 },
  });
  const { key, info } = res.json() as { key: string; info: { id: string } };
  assert.equal((await enviar(key, { subject: 'Primero' })).statusCode, 200);
  const limitado = await enviar(key, { subject: 'Segundo' }, { 'idempotency-key': 'tras-429' });
  assert.equal(limitado.statusCode, 429);
  const fila = db.prepare('SELECT COUNT(*) AS c FROM send_idempotency WHERE api_key_id = ?').get(info.id) as { c: number };
  assert.equal(fila.c, 0, 'un 429 no deja la clave reservada');
});

test('pasadas 24 horas la Idempotency-Key vuelve a enviar', async () => {
  const { key, id } = await crearClave();
  assert.equal((await enviar(key, {}, { 'idempotency-key': 'diaria' })).statusCode, 200);
  db.prepare('UPDATE send_idempotency SET expires_at = ? WHERE api_key_id = ?').run(Date.now() - 1, id);
  const otra = await enviar(key, {}, { 'idempotency-key': 'diaria' });
  assert.equal(otra.statusCode, 200);
  assert.equal(otra.headers['idempotent-replayed'], undefined);
  assert.equal(enviosDe(id), 2);
  const fila = db.prepare('SELECT expires_at - created_at AS ttl FROM send_idempotency WHERE api_key_id = ?').get(id) as { ttl: number };
  assert.equal(fila.ttl, IDEMPOTENCIA_MS);
});
