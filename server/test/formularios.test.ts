import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Transporter } from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { getEngine } from '../src/engine';
import {
  CAMPO_TRAMPA,
  LIMITE_POR_FORMULARIO,
  LIMITE_POR_IP,
  MAX_FORMULARIOS_POR_CLIENTE,
  componerMensajeFormulario,
  leerCampos,
  normalizarOrigen,
  resetFormLimitsForTests,
  setTurnstileVerifierForTests,
  type RespuestaTurnstile,
} from '../src/modules/forms';
import { setEngineSettings } from '../src/modules/settings';
import { setTransportFactoryForTests } from '../src/modules/transactional';
import {
  adminContext,
  createClient,
  createDomain,
  createMailbox,
  setDomainOwnership,
  type TestContext,
} from './helpers';

/*
 * Formularios de contacto para webs estáticas: gestión en el panel (con
 * aislamiento entre clientes) y la ruta pública POST /forms/:clave.
 */

interface FormInfo {
  id: string;
  clientId: string;
  publicKey: string;
  recipientEmail: string;
  allowedOrigins: string[];
  subject: string;
  turnstile: { siteKey: string } | null;
  enabled: boolean;
  submissionsCount: number;
  endpoint: string;
  embedHtml: string;
}

const ORIGEN = 'https://www.acme.test';

let ctx: TestContext;
let clientId: string;
let userCookie: string;
let mailboxId: string;
let mailboxEmail: string;
let dominioA: string;
let otro: { clientId: string; userCookie: string; mailboxId: string };

before(async () => {
  ctx = await adminContext();
  const a = await createClient(ctx, { withUser: true });
  clientId = a.clientId;
  userCookie = a.userCookie!;
  const { domainId } = await createDomain(ctx, clientId);
  dominioA = domainId;
  ({ mailboxId, email: mailboxEmail } = await createMailbox(ctx, domainId, 'contacto'));

  const b = await createClient(ctx, { withUser: true });
  const dominioB = await createDomain(ctx, b.clientId);
  const buzonB = await createMailbox(ctx, dominioB.domainId, 'info');
  otro = { clientId: b.clientId, userCookie: b.userCookie!, mailboxId: buzonB.mailboxId };
});

beforeEach(() => {
  resetFormLimitsForTests();
});

after(() => {
  setTurnstileVerifierForTests(null);
  setTransportFactoryForTests(null);
});

async function crearFormulario(
  datos: Record<string, unknown> = {},
  cookie = userCookie,
): Promise<FormInfo> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/forms',
    headers: { cookie, host: 'panel.proveedor.test' },
    payload: { name: 'Contacto', recipientMailboxId: mailboxId, allowedOrigins: [ORIGEN], ...datos },
  });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { form: FormInfo }).form;
}

let ipSeq = 0;
function enviar(
  clave: string,
  opciones: {
    origen?: string | null;
    payload?: Record<string, unknown> | string;
    ip?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = { accept: 'application/json', ...opciones.headers };
  if (opciones.origen !== null) headers.origin = opciones.origen ?? ORIGEN;
  return ctx.app.inject({
    method: 'POST',
    url: `/forms/${clave}`,
    remoteAddress: opciones.ip ?? `198.51.100.${(ipSeq++ % 250) + 1}`,
    headers,
    payload: opciones.payload ?? { nombre: 'Ana Pérez', email: 'ana@ejemplo.com', mensaje: 'Hola,\nquiero información.' },
  });
}

function mensajesDe(formId: string): { from_address: string; to_json: string; subject: string; status: string }[] {
  return db.prepare('SELECT * FROM messages WHERE form_id = ?').all(formId) as {
    from_address: string;
    to_json: string;
    subject: string;
    status: string;
  }[];
}

/* --------------------------------- Panel ---------------------------------- */

test('crear un formulario devuelve la clave pública y el fragmento, sin secretos', async () => {
  const form = await crearFormulario({
    allowedOrigins: ['www.acme.test/contacto', 'https://acme.test', 'https://WWW.ACME.TEST'],
    subject: 'Contacto desde la web',
  });
  assert.match(form.publicKey, /^mwf_[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(form.allowedOrigins, ['https://www.acme.test', 'https://acme.test']);
  assert.equal(form.recipientEmail, mailboxEmail);
  assert.equal(form.endpoint, `http://panel.proveedor.test/forms/${form.publicKey}`);
  assert.ok(form.embedHtml.includes(`action="http://panel.proveedor.test/forms/${form.publicKey}"`));
  assert.ok(form.embedHtml.includes(`<script src="http://panel.proveedor.test/forms/widget.js" data-form="${form.publicKey}" defer></script>`));
  assert.ok(form.embedHtml.includes(`name="${CAMPO_TRAMPA}"`));
  assert.ok(form.embedHtml.includes('role="status"'));
  assert.equal(form.turnstile, null);

  const fila = db.prepare('SELECT smtp_password_enc FROM forms WHERE id = ?').get(form.id) as { smtp_password_enc: string };
  assert.match(fila.smtp_password_enc, /^v1:/, 'la credencial SMTP va cifrada');

  const auditoria = db
    .prepare("SELECT client_id, detail FROM audit_log WHERE action = 'form.created' AND detail LIKE ?")
    .get(`%${form.id}%`) as { client_id: string; detail: string };
  assert.equal(auditoria.client_id, clientId);
});

test('Turnstile exige las dos claves y el secreto nunca sale del servidor', async () => {
  const incompleto = await ctx.app.inject({
    method: 'POST',
    url: '/api/forms',
    headers: { cookie: userCookie },
    payload: { name: 'Contacto', recipientMailboxId: mailboxId, allowedOrigins: [ORIGEN], turnstileSiteKey: '1x00000000000000000000AA' },
  });
  assert.equal(incompleto.statusCode, 400);
  assert.equal(incompleto.json().code, 'turnstile_incomplete');

  const secreto = '1x0000000000000000000000000000000AA';
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/forms',
    headers: { cookie: userCookie },
    payload: {
      name: 'Con Turnstile',
      recipientMailboxId: mailboxId,
      allowedOrigins: [ORIGEN],
      turnstileSiteKey: '1x00000000000000000000AA',
      turnstileSecret: secreto,
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(!res.body.includes(secreto));
  const form = (res.json() as { form: FormInfo }).form;
  assert.deepEqual(form.turnstile, { siteKey: '1x00000000000000000000AA' });
  assert.ok(form.embedHtml.includes('class="cf-turnstile" data-sitekey="1x00000000000000000000AA"'));
  assert.ok(form.embedHtml.includes('https://challenges.cloudflare.com/turnstile/v0/api.js'));
  const lista = await ctx.app.inject({ method: 'GET', url: '/api/forms', headers: { cookie: userCookie } });
  assert.ok(!lista.body.includes(secreto));
  const auditoria = db.prepare("SELECT detail FROM audit_log WHERE action LIKE 'form.%'").all() as { detail: string }[];
  assert.ok(auditoria.every((a) => !a.detail.includes(secreto)), 'la actividad no guarda el secreto');
});

test('los orígenes deben ser https y sin comodines', async () => {
  for (const origen of ['http://www.acme.test', '*.acme.test', 'https://', 'ftp://acme.test', 'https://localhost']) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/forms',
      headers: { cookie: userCookie },
      payload: { name: 'Contacto', recipientMailboxId: mailboxId, allowedOrigins: [origen] },
    });
    assert.equal(res.statusCode, 400, `${origen}: ${res.body}`);
    assert.equal(res.json().code, 'invalid_origin', origen);
  }
  assert.equal(normalizarOrigen('https://tienda.acme.test:8443/carrito?x=1'), 'https://tienda.acme.test:8443');
  assert.equal(normalizarOrigen('https://www.acme.test:443/'), 'https://www.acme.test');
});

test('el buzón destinatario debe ser del cliente y de un dominio con la propiedad comprobada', async () => {
  // Un cliente no puede apuntar el formulario a un buzón de otro.
  const ajeno = await ctx.app.inject({
    method: 'POST',
    url: '/api/forms',
    headers: { cookie: userCookie },
    payload: { name: 'Contacto', recipientMailboxId: otro.mailboxId, allowedOrigins: [ORIGEN] },
  });
  assert.equal(ajeno.statusCode, 400);
  assert.equal(ajeno.json().code, 'recipient_other_client');
  // Ni pasando otro clientId: un usuario de cliente siempre crea en el suyo.
  const conCliente = await ctx.app.inject({
    method: 'POST',
    url: '/api/forms',
    headers: { cookie: userCookie },
    payload: { clientId: otro.clientId, name: 'Contacto', recipientMailboxId: otro.mailboxId, allowedOrigins: [ORIGEN] },
  });
  assert.equal(conCliente.statusCode, 400);
  assert.equal(conCliente.json().code, 'recipient_other_client');

  // La propiedad se exige también a la administración.
  const cliente = await createClient(ctx);
  const { domainId } = await createDomain(ctx, cliente.clientId);
  const buzon = await createMailbox(ctx, domainId, 'web');
  setDomainOwnership(domainId, false);
  try {
    const pendiente = await ctx.app.inject({
      method: 'POST',
      url: '/api/forms',
      headers: { cookie: ctx.adminCookie },
      payload: { clientId: cliente.clientId, name: 'Contacto', recipientMailboxId: buzon.mailboxId, allowedOrigins: [ORIGEN] },
    });
    assert.equal(pendiente.statusCode, 409);
    assert.equal(pendiente.json().code, 'domain_ownership_pending');
  } finally {
    setDomainOwnership(domainId, true);
  }
});

test('un cliente no ve, edita ni elimina los formularios de otro', async () => {
  const form = await crearFormulario();
  const lista = await ctx.app.inject({ method: 'GET', url: '/api/forms', headers: { cookie: otro.userCookie } });
  assert.equal(lista.statusCode, 200);
  assert.ok(!(lista.json() as { forms: FormInfo[] }).forms.some((f) => f.id === form.id));
  // Ni filtrando por el cliente ajeno: el filtro solo lo usa la administración.
  const filtrada = await ctx.app.inject({
    method: 'GET',
    url: `/api/forms?clientId=${clientId}`,
    headers: { cookie: otro.userCookie },
  });
  assert.ok(!filtrada.body.includes(form.id));

  const editar = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/forms/${form.id}`,
    headers: { cookie: otro.userCookie },
    payload: { allowedOrigins: ['https://atacante.test'] },
  });
  assert.equal(editar.statusCode, 403);
  const borrar = await ctx.app.inject({ method: 'DELETE', url: `/api/forms/${form.id}`, headers: { cookie: otro.userCookie } });
  assert.equal(borrar.statusCode, 403);
  const anonimo = await ctx.app.inject({ method: 'GET', url: '/api/forms' });
  assert.equal(anonimo.statusCode, 401);

  // La administración ve los de todos y puede filtrar.
  const admin = await ctx.app.inject({ method: 'GET', url: `/api/forms?clientId=${clientId}`, headers: { cookie: ctx.adminCookie } });
  assert.ok((admin.json() as { forms: FormInfo[] }).forms.some((f) => f.id === form.id));
});

test(`un cliente admite como máximo ${MAX_FORMULARIOS_POR_CLIENTE} formularios`, async () => {
  const cliente = await createClient(ctx);
  const { domainId } = await createDomain(ctx, cliente.clientId);
  const buzon = await createMailbox(ctx, domainId, 'web');
  const alta = () =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/forms',
      headers: { cookie: ctx.adminCookie },
      payload: { clientId: cliente.clientId, name: 'Contacto', recipientMailboxId: buzon.mailboxId, allowedOrigins: [ORIGEN] },
    });
  const altas = await Promise.all(Array.from({ length: MAX_FORMULARIOS_POR_CLIENTE + 2 }, alta));
  assert.equal(altas.filter((r) => r.statusCode === 200).length, MAX_FORMULARIOS_POR_CLIENTE);
  assert.ok(altas.filter((r) => r.statusCode !== 200).every((r) => r.json().code === 'form_limit'));
});

/* ------------------------------ Ruta pública ------------------------------ */

test('un envío desde un origen permitido llega al buzón con CORS para ese origen', async () => {
  const form = await crearFormulario({ subject: 'Nuevo contacto' });
  const res = await enviar(form.publicKey);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { ok: true });
  assert.equal(res.headers['access-control-allow-origin'], ORIGEN);
  assert.match(String(res.headers.vary), /Origin/);

  const mensajes = mensajesDe(form.id);
  assert.equal(mensajes.length, 1);
  assert.equal(mensajes[0]!.from_address, mailboxEmail, 'el remitente es el buzón del cliente');
  assert.deepEqual(JSON.parse(mensajes[0]!.to_json), [mailboxEmail]);
  assert.equal(mensajes[0]!.subject, 'Nuevo contacto');
  const fila = db.prepare('SELECT submissions_count FROM forms WHERE id = ?').get(form.id) as { submissions_count: number };
  assert.equal(fila.submissions_count, 1);
});

test('el formulario HTML (urlencoded) y el JSON en text/plain también se admiten', async () => {
  const form = await crearFormulario();
  const html = await enviar(form.publicKey, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'nombre=Luis&email=luis%40ejemplo.com&mensaje=Hola&intereses=a&intereses=b',
  });
  assert.equal(html.statusCode, 200, html.body);
  const texto = await enviar(form.publicKey, {
    headers: { 'content-type': 'text/plain' },
    payload: JSON.stringify({ email: 'eva@ejemplo.com', mensaje: 'Hola' }),
  });
  assert.equal(texto.statusCode, 200, texto.body);
  assert.equal(mensajesDe(form.id).length, 2);
});

test('otro origen, o ninguno, recibe 403 sin cabeceras de CORS', async () => {
  const form = await crearFormulario();
  const ajeno = await enviar(form.publicKey, { origen: 'https://atacante.test' });
  assert.equal(ajeno.statusCode, 403);
  assert.equal(ajeno.json().code, 'origin_not_allowed');
  assert.equal(ajeno.headers['access-control-allow-origin'], undefined);
  const sinOrigen = await enviar(form.publicKey, { origen: null });
  assert.equal(sinOrigen.statusCode, 403);
  assert.equal(sinOrigen.headers['access-control-allow-origin'], undefined);
  const http = await enviar(form.publicKey, { origen: 'http://www.acme.test' });
  assert.equal(http.statusCode, 403);
  assert.equal(mensajesDe(form.id).length, 0);

  const inexistente = await enviar('mwf_AAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(inexistente.statusCode, 404);
  assert.equal(inexistente.json().code, 'form_not_found');
});

test('la petición previa de CORS solo se autoriza para los orígenes permitidos', async () => {
  const form = await crearFormulario();
  const ok = await ctx.app.inject({
    method: 'OPTIONS',
    url: `/forms/${form.publicKey}`,
    headers: { origin: ORIGEN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(ok.statusCode, 204);
  assert.equal(ok.headers['access-control-allow-origin'], ORIGEN);
  assert.match(String(ok.headers['access-control-allow-methods']), /POST/);
  assert.match(String(ok.headers['access-control-allow-headers']), /Content-Type/);

  const ajeno = await ctx.app.inject({
    method: 'OPTIONS',
    url: `/forms/${form.publicKey}`,
    headers: { origin: 'https://atacante.test', 'access-control-request-method': 'POST' },
  });
  assert.equal(ajeno.statusCode, 403);
  assert.equal(ajeno.headers['access-control-allow-origin'], undefined);

  // El resto de la API no responde con CORS.
  const api = await ctx.app.inject({ method: 'GET', url: '/api/health', headers: { origin: ORIGEN } });
  assert.equal(api.headers['access-control-allow-origin'], undefined);
});

test('el campo trampa relleno responde como si funcionara pero no envía', async () => {
  const form = await crearFormulario();
  const res = await enviar(form.publicKey, {
    payload: { email: 'bot@spam.test', mensaje: 'Compra ya', [CAMPO_TRAMPA]: 'https://spam.test' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  assert.equal(mensajesDe(form.id).length, 0);
});

test(`límite por IP: ${LIMITE_POR_IP.max} envíos cada 10 minutos; los errores de escritura no cuentan`, async () => {
  const form = await crearFormulario();
  const ip = '203.0.113.77';
  for (let i = 0; i < 3; i += 1) {
    const malo = await enviar(form.publicKey, { ip, payload: { email: 'no-es-un-correo', mensaje: 'Hola' } });
    assert.equal(malo.statusCode, 400);
    assert.equal(malo.json().code, 'invalid_email');
  }
  for (let i = 0; i < LIMITE_POR_IP.max; i += 1) {
    assert.equal((await enviar(form.publicKey, { ip })).statusCode, 200);
  }
  const exceso = await enviar(form.publicKey, { ip });
  assert.equal(exceso.statusCode, 429);
  assert.equal(exceso.json().code, 'rate_limited');
  assert.equal(exceso.headers['access-control-allow-origin'], ORIGEN, 'el error lleva CORS para que la web lo lea');
  assert.equal((await enviar(form.publicKey, { ip: '203.0.113.78' })).statusCode, 200, 'otra IP sigue pudiendo');
});

test(`límite por formulario: ${LIMITE_POR_FORMULARIO.max} mensajes por hora`, async () => {
  const form = await crearFormulario();
  for (let i = 0; i < LIMITE_POR_FORMULARIO.max; i += 1) {
    const res = await enviar(form.publicKey, { ip: `192.0.2.${i + 1}` });
    assert.equal(res.statusCode, 200, res.body);
  }
  const exceso = await enviar(form.publicKey, { ip: '192.0.2.200' });
  assert.equal(exceso.statusCode, 429);
  assert.equal(mensajesDe(form.id).length, LIMITE_POR_FORMULARIO.max);
});

test('los mensajes de los formularios cuentan para el cupo diario del plan', async () => {
  const plan = await ctx.app.inject({
    method: 'POST',
    url: '/api/plans',
    headers: { cookie: ctx.adminCookie },
    payload: {
      name: `Formularios ${Date.now()}`,
      maxDomains: 1,
      maxMailboxes: 5,
      maxAliases: 5,
      mailboxQuotaMb: 1024,
      apiDailyLimit: 2,
      apiPerMinuteLimit: 100,
    },
  });
  assert.equal(plan.statusCode, 200, plan.body);
  const cliente = await createClient(ctx);
  await ctx.app.inject({
    method: 'PATCH',
    url: `/api/clients/${cliente.clientId}`,
    headers: { cookie: ctx.adminCookie },
    payload: { planId: plan.json().plan.id },
  });
  const { domainId } = await createDomain(ctx, cliente.clientId);
  const buzon = await createMailbox(ctx, domainId, 'web');
  const form = await crearFormulario({ clientId: cliente.clientId, recipientMailboxId: buzon.mailboxId }, ctx.adminCookie);
  assert.equal((await enviar(form.publicKey)).statusCode, 200);
  assert.equal((await enviar(form.publicKey)).statusCode, 200);
  const tercero = await enviar(form.publicKey);
  assert.equal(tercero.statusCode, 429);
  assert.equal(tercero.json().code, 'daily_limit_reached');
  assert.doesNotMatch(tercero.json().error, /plan|clave/, 'el visitante no ve detalles del plan');
});

test('un envío demasiado grande responde 413 con CORS', async () => {
  const form = await crearFormulario();
  const res = await enviar(form.publicKey, { payload: { email: 'ana@ejemplo.com', mensaje: 'x'.repeat(40 * 1024) } });
  assert.equal(res.statusCode, 413);
  assert.equal(res.headers['access-control-allow-origin'], ORIGEN);
  const largo = await enviar(form.publicKey, { payload: { email: 'ana@ejemplo.com', mensaje: 'x'.repeat(6000) } });
  assert.equal(largo.statusCode, 400);
  assert.equal(largo.json().code, 'field_too_long');
  const vacio = await enviar(form.publicKey, { payload: { email: '', mensaje: '   ' } });
  assert.equal(vacio.statusCode, 400);
  assert.equal(vacio.json().code, 'empty_submission');
  assert.equal(mensajesDe(form.id).length, 0);
});

test('Turnstile: token obligatorio y hostname de un origen permitido', async () => {
  const form = await crearFormulario({ turnstileSiteKey: '1x00000000000000000000AA', turnstileSecret: 'secreto-turnstile-1234' });
  const llamadas: { secreto: string; token: string }[] = [];
  let respuesta: RespuestaTurnstile | null = { success: true, hostname: 'www.acme.test' };
  setTurnstileVerifierForTests(async (secreto, token) => {
    llamadas.push({ secreto, token });
    return respuesta;
  });
  try {
    const sinToken = await enviar(form.publicKey);
    assert.equal(sinToken.statusCode, 400);
    assert.equal(sinToken.json().code, 'turnstile_required');

    const conToken = (extra: Record<string, unknown> = {}) =>
      enviar(form.publicKey, {
        payload: { email: 'ana@ejemplo.com', mensaje: 'Hola', 'cf-turnstile-response': 'token-ok', ...extra },
      });
    assert.equal((await conToken()).statusCode, 200);
    assert.deepEqual(llamadas.at(-1), { secreto: 'secreto-turnstile-1234', token: 'token-ok' });

    respuesta = { success: true, hostname: 'atacante.test' };
    const otroHost = await conToken();
    assert.equal(otroHost.statusCode, 400);
    assert.equal(otroHost.json().code, 'turnstile_failed');

    respuesta = { success: false, 'error-codes': ['invalid-input-response'] };
    assert.equal((await conToken()).json().code, 'turnstile_failed');

    respuesta = null;
    const caido = await conToken();
    assert.equal(caido.statusCode, 503);
    assert.equal(caido.json().code, 'turnstile_unavailable');
    assert.equal(mensajesDe(form.id).length, 1);
  } finally {
    setTurnstileVerifierForTests(null);
  }
});

test('un formulario desactivado o de un cliente suspendido no admite envíos', async () => {
  const form = await crearFormulario();
  const off = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/forms/${form.id}`,
    headers: { cookie: userCookie },
    payload: { enabled: false },
  });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal((off.json() as { form: FormInfo }).form.enabled, false);
  const desactivado = await enviar(form.publicKey);
  assert.equal(desactivado.statusCode, 403);
  assert.equal(desactivado.json().code, 'form_disabled');
  const auditoria = db.prepare("SELECT client_id FROM audit_log WHERE action = 'form.updated' AND detail LIKE ?").get(`%${form.id}%`) as { client_id: string };
  assert.equal(auditoria.client_id, clientId);

  await ctx.app.inject({ method: 'PATCH', url: `/api/forms/${form.id}`, headers: { cookie: userCookie }, payload: { enabled: true } });
  db.prepare('UPDATE clients SET suspended = 1 WHERE id = ?').run(clientId);
  try {
    const suspendido = await enviar(form.publicKey);
    assert.equal(suspendido.statusCode, 403);
    assert.equal(suspendido.json().code, 'form_unavailable');
  } finally {
    db.prepare('UPDATE clients SET suspended = 0 WHERE id = ?').run(clientId);
  }
});

test('sin JavaScript, el envío nativo recibe una página en español', async () => {
  const form = await crearFormulario();
  const ok = await enviar(form.publicKey, {
    headers: { accept: 'text/html,application/xhtml+xml', 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'email=ana%40ejemplo.com&mensaje=Hola',
  });
  assert.equal(ok.statusCode, 200);
  assert.match(String(ok.headers['content-type']), /text\/html/);
  assert.match(ok.body, /Mensaje enviado/);
  assert.match(ok.body, /href="https:\/\/www\.acme\.test"/);
  const ajeno = await enviar(form.publicKey, {
    origen: 'https://atacante.test',
    headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'email=ana%40ejemplo.com&mensaje=Hola',
  });
  assert.equal(ajeno.statusCode, 403);
  assert.match(ajeno.body, /no admite envíos desde esta página/);
  assert.doesNotMatch(ajeno.body, /href=/, 'a un origen ajeno no se le ofrece volver');
});

test('widget.js se sirve como JavaScript sin dependencias', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/forms/widget.js' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /application\/javascript/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.body, /data-form/);
  assert.match(res.body, /credentials: 'omit'/);
  assert.match(res.body, /aria-live/);
  assert.doesNotMatch(res.body, /\bimport\b|require\(/);
});

test('eliminar el formulario retira su credencial del motor y deja de aceptar envíos', async () => {
  const form = await crearFormulario();
  const engine = getEngine();
  const retiradas: string[] = [];
  const remove = engine.removeAppPassword.bind(engine);
  engine.removeAppPassword = async (email, stored) => {
    retiradas.push(email);
    await remove(email, stored);
  };
  try {
    const res = await ctx.app.inject({ method: 'DELETE', url: `/api/forms/${form.id}`, headers: { cookie: userCookie } });
    assert.equal(res.statusCode, 200, res.body);
  } finally {
    engine.removeAppPassword = remove;
  }
  assert.deepEqual(retiradas, [mailboxEmail]);
  assert.equal((await enviar(form.publicKey)).statusCode, 404);
  const auditoria = db.prepare("SELECT client_id FROM audit_log WHERE action = 'form.deleted' AND detail LIKE ?").get(`%${form.id}%`) as { client_id: string };
  assert.equal(auditoria.client_id, clientId);
});

test('no se elimina un buzón que recibe formularios', async () => {
  const buzon = await createMailbox(ctx, dominioA, 'formularios');
  const form = await crearFormulario({ recipientMailboxId: buzon.mailboxId });
  const res = await ctx.app.inject({ method: 'DELETE', url: `/api/mailboxes/${buzon.mailboxId}`, headers: { cookie: userCookie } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'mailbox_in_use');
  await ctx.app.inject({ method: 'DELETE', url: `/api/forms/${form.id}`, headers: { cookie: userCookie } });
});

test('el mensaje sale con el remitente del buzón y la dirección del visitante en Reply-To', async () => {
  const form = await crearFormulario({ subject: 'Contacto web' });
  const enviados: Mail.Options[] = [];
  setTransportFactoryForTests(
    () =>
      ({
        sendMail: async (opciones: Mail.Options) => {
          enviados.push(opciones);
          return { messageId: '<form@mailway>' };
        },
        close: () => undefined,
      }) as unknown as Transporter,
  );
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
    const res = await enviar(form.publicKey, {
      payload: { nombre: 'Ana "Jefa" <Pérez>', email: 'ana@ejemplo.com', mensaje: 'Hola' },
    });
    assert.equal(res.statusCode, 200, res.body);
  } finally {
    config.demoMode = true;
    setTransportFactoryForTests(null);
  }
  assert.equal(enviados.length, 1);
  const m = enviados[0]!;
  assert.deepEqual(m.from, { name: 'Contacto (formulario web)', address: mailboxEmail });
  assert.equal(m.to, mailboxEmail);
  assert.deepEqual(m.replyTo, { name: 'Ana  Jefa   Pérez'.replace(/\s+/g, ' '), address: 'ana@ejemplo.com' });
  assert.equal(m.subject, 'Contacto web');
  assert.match(String(m.text), /Mensaje: Hola/);
  assert.equal(m.html, undefined, 'solo texto');
});

/* ------------------------------ Unidad: mensaje ----------------------------- */

test('componerMensajeFormulario nunca usa al visitante como remitente ni admite cabeceras inyectadas', () => {
  const campos = leerCampos({
    nombre: 'Eva\r\nBcc: victima@ejemplo.com',
    email: 'eva@ejemplo.com\r\nBcc: victima@ejemplo.com',
    mensaje: 'Línea 1\r\nLínea 2',
    [CAMPO_TRAMPA]: '',
    'cf-turnstile-response': 'token',
  });
  const m = componerMensajeFormulario({
    formName: 'Contacto',
    publicKey: 'mwf_AAAAAAAAAAAAAAAAAAAAAA',
    subject: 'Nuevo mensaje',
    recipient: 'contacto@acme.test',
    origin: ORIGEN,
    campos,
    recibidoEn: Date.UTC(2026, 9, 2, 10, 15),
  });
  assert.equal(m.from.address, 'contacto@acme.test');
  assert.equal(m.to, 'contacto@acme.test');
  assert.equal(m.replyTo, undefined, 'una dirección con saltos de línea no llega a Reply-To');
  assert.match(m.text, /Mensaje:\n {2}Línea 1\n {2}Línea 2/);
  assert.doesNotMatch(m.text, /cf-turnstile|token|Mw web/i);
  assert.match(m.text, /Recibido el 2026-10-02 10:15 \(UTC\)/);
  assert.equal(m.headers['X-Web-Form'], 'mwf_AAAAAAAAAAAAAAAAAAAAAA');

  const valido = componerMensajeFormulario({
    formName: 'Contacto',
    publicKey: 'mwf_AAAAAAAAAAAAAAAAAAAAAA',
    subject: 'Nuevo mensaje',
    recipient: 'contacto@acme.test',
    origin: ORIGEN,
    campos: leerCampos({ name: 'Luis\nGarcía', email: 'luis@ejemplo.com', mensaje: 'Hola' }),
    recibidoEn: Date.now(),
  });
  assert.deepEqual(valido.replyTo, { name: 'Luis García', address: 'luis@ejemplo.com' });
});

test('eliminar el dominio del buzón destinatario elimina también sus formularios', async () => {
  const cliente = await createClient(ctx);
  const { domainId, domain } = await createDomain(ctx, cliente.clientId);
  const buzon = await createMailbox(ctx, domainId, 'web');
  const form = await crearFormulario({ clientId: cliente.clientId, recipientMailboxId: buzon.mailboxId }, ctx.adminCookie);
  assert.equal((await enviar(form.publicKey)).statusCode, 200);
  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/domains/${domainId}?confirm=${encodeURIComponent(domain)}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM forms WHERE id = ?').get(form.id) as { c: number }).c, 0);
  assert.equal((await enviar(form.publicKey)).statusCode, 404);
});
