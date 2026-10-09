import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Transporter } from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { decryptSecret } from '../src/core/crypto';
import { getEngine } from '../src/engine';
import type { CreateMailboxInput } from '../src/engine/types';
import {
  MAX_ENVIOS_POR_BUZON,
  MAX_ENVIOS_POR_CLIENTE,
  componerCorreoConfiguracion,
  fechaLargaConfiguracion,
} from '../src/modules/envioconfiguracion';
import { MENSAJE_DIRECCION_RESERVADA, REMITENTE_CONFIGURACION } from '../src/modules/remitente';
import { setEngineSettings } from '../src/modules/settings';
import { forgetTransport, setTransportFactoryForTests } from '../src/modules/transactional';
import {
  adminContext,
  cookieFrom,
  createClient,
  createDomain,
  createMailbox,
  type TestContext,
  motorAcepta,
} from './helpers';

/*
 * Entrega de la configuración al titular: buzón configurado (configured_at),
 * correo de configuración desde configuration@<dominio> y la dirección
 * reservada. En modo demostración el envío no abre SMTP; las últimas pruebas
 * cambian a un motor «real» con un transporte falso para ver el mensaje.
 */

let ctx: TestContext;
let ipSeq = 0;
function nuevaIp(): string {
  ipSeq += 1;
  return `10.60.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

before(async () => {
  ctx = await adminContext();
});

after(() => {
  setTransportFactoryForTests(null);
});

interface MailboxJson {
  id: string;
  email: string;
  configuredAt: number | null;
  setup: {
    lastLinkAt: number | null;
    lastOpenedAt: number | null;
    lastEmail: { to: string; at: number; status: 'sent' | 'failed' } | null;
  };
}

interface RespuestaEnvio {
  sent: { to: string; at: number; status: 'sent' };
  link: { expiresAt: number; hasPassword: boolean };
  reused: boolean;
}

async function equipo(opts: { name?: string } = {}) {
  const client = await createClient(ctx, { withUser: true, name: opts.name });
  const { domainId, domain } = await createDomain(ctx, client.clientId);
  const mailbox = await createMailbox(ctx, domainId);
  return { ...client, userCookie: client.userCookie!, domainId, domain, ...mailbox };
}

function enviar(mailboxId: string, payload: Record<string, unknown>, cookie: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${mailboxId}/setup-email`,
    headers: { cookie },
    payload,
  });
}

async function buzonJson(mailboxId: string, clientId: string): Promise<MailboxJson> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/mailboxes?clientId=${clientId}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  const mailbox = (res.json() as { mailboxes: MailboxJson[] }).mailboxes.find((m) => m.id === mailboxId);
  assert.ok(mailbox, 'el buzón debe estar en el listado');
  return mailbox;
}

function enlaces(mailboxId: string) {
  return db
    .prepare('SELECT id, password_enc, token_enc, expires_at FROM setup_links WHERE mailbox_id = ? ORDER BY created_at')
    .all(mailboxId) as { id: string; password_enc: string | null; token_enc: string | null; expires_at: number }[];
}

function envios(mailboxId: string) {
  return db
    .prepare('SELECT * FROM envios_configuracion WHERE mailbox_id = ? ORDER BY created_at')
    .all(mailboxId) as { recipient: string; status: string; error: string; link_id: string; client_id: string; sent_by: string | null }[];
}

function auditoria(action: string, email: string) {
  return (
    db.prepare('SELECT user_id, client_id, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as {
      user_id: string | null;
      client_id: string | null;
      detail: string;
    }[]
  ).filter((a) => a.detail.includes(email));
}

function tokenDe(url: string): string {
  const match = /\/conectar\/([A-Za-z0-9_-]+)$/.exec(url);
  assert.ok(match, `la URL debe acabar en /conectar/<token>: ${url}`);
  return match[1]!;
}

async function crearEnlace(mailboxId: string, payload: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${mailboxId}/setup-links`,
    headers: { cookie: ctx.adminCookie },
    payload,
  });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { link: { id: string; url: string } }).link;
}

function configuredAt(mailboxId: string): number | null {
  return (db.prepare('SELECT configured_at FROM mailboxes WHERE id = ?').get(mailboxId) as { configured_at: number | null })
    .configured_at;
}

/* ------------------------- Dirección reservada ---------------------------- */

test('configuration@ está reservada: ni buzón, ni alta masiva, ni alias', async () => {
  const t = await equipo();

  const buzon = await ctx.app.inject({
    method: 'POST',
    url: '/api/mailboxes',
    headers: { cookie: t.userCookie },
    payload: { domainId: t.domainId, localPart: 'Configuration' },
  });
  assert.equal(buzon.statusCode, 400, buzon.body);
  assert.deepEqual(buzon.json(), { error: MENSAJE_DIRECCION_RESERVADA, code: 'reserved_address' });

  // La revisión del lote lo dice en su línea, como cualquier otro error.
  const revision = await ctx.app.inject({
    method: 'POST',
    url: '/api/mailboxes/bulk',
    headers: { cookie: t.userCookie },
    payload: { domainId: t.domainId, dryRun: true, entries: [{ localPart: ' CONFIGURATION ' }, { localPart: 'ana' }] },
  });
  assert.equal(revision.statusCode, 200, revision.body);
  const r = revision.json() as { valid: number; results: { localPart: string; ok: boolean; error?: string }[] };
  assert.equal(r.valid, 1);
  assert.deepEqual(r.results[0], {
    localPart: 'configuration',
    email: `configuration@${t.domain}`,
    displayName: '',
    ok: false,
    error: MENSAJE_DIRECCION_RESERVADA,
  });
  assert.equal(r.results[1]!.ok, true);

  // Y al crear el lote de verdad, esa línea no se crea.
  const lote = await ctx.app.inject({
    method: 'POST',
    url: '/api/mailboxes/bulk',
    headers: { cookie: t.userCookie },
    payload: { domainId: t.domainId, entries: [{ localPart: 'configuration' }, { localPart: 'luis' }] },
  });
  assert.equal(lote.statusCode, 200, lote.body);
  const l = lote.json() as { created: number; results: { ok: boolean; error?: string }[] };
  assert.equal(l.created, 1);
  assert.equal(l.results[0]!.ok, false);
  assert.equal(l.results[0]!.error, MENSAJE_DIRECCION_RESERVADA);

  // Ni siquiera la administración crea el alias.
  const alias = await ctx.app.inject({
    method: 'POST',
    url: '/api/aliases',
    headers: { cookie: ctx.adminCookie },
    payload: { domainId: t.domainId, localPart: REMITENTE_CONFIGURACION, destinations: [t.email] },
  });
  assert.equal(alias.statusCode, 400, alias.body);
  assert.equal(alias.json().code, 'reserved_address');

  const ocupadas = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM mailboxes WHERE local_part = 'configuration')
            + (SELECT COUNT(*) FROM aliases WHERE local_part = 'configuration') AS c`,
    )
    .get() as { c: number };
  assert.equal(ocupadas.c, 0);
});

/* ------------------------- Correo de configuración ------------------------- */

test('enviar la configuración: genera contraseña y enlace, anota el envío y no devuelve la URL', async () => {
  const t = await equipo();
  await ctx.app.inject({
    method: 'PATCH',
    url: `/api/mailboxes/${t.mailboxId}`,
    headers: { cookie: t.userCookie },
    payload: { displayName: 'Ana Pérez' },
  });

  const res = await enviar(t.mailboxId, { to: '  Ana.Personal@Gmail.com ' }, t.userCookie);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as RespuestaEnvio;
  assert.equal(body.sent.to, 'ana.personal@gmail.com');
  assert.equal(body.sent.status, 'sent');
  assert.ok(Math.abs(body.sent.at - Date.now()) < 60_000);
  assert.equal(body.link.hasPassword, true);
  // Validez por defecto: 7 días.
  assert.ok(Math.abs(body.link.expiresAt - (Date.now() + 168 * 3600_000)) < 60_000);
  assert.equal(body.reused, false);
  assert.deepEqual(Object.keys(body).sort(), ['link', 'reused', 'sent']);
  assert.doesNotMatch(res.body, /conectar|token|"password"|"url"/i);

  // Sin enlace previo con contraseña: contraseña nueva (la anterior deja de valer).
  const engine = getEngine();
  assert.equal(await motorAcepta(t.email, t.password), false);
  const [enlace] = enlaces(t.mailboxId);
  assert.ok(enlace?.password_enc && enlace.token_enc);
  assert.equal(await motorAcepta(t.email, decryptSecret(enlace.password_enc)), true);
  assert.ok(!res.body.includes(decryptSecret(enlace.token_enc)));

  const [fila] = envios(t.mailboxId);
  assert.ok(fila);
  assert.equal(fila.recipient, 'ana.personal@gmail.com');
  assert.equal(fila.status, 'sent');
  assert.equal(fila.client_id, t.clientId);
  assert.equal(fila.link_id, enlace.id);
  assert.ok(fila.sent_by);

  const registro = auditoria('mailbox.setup_email_sent', t.email);
  assert.equal(registro.length, 1);
  assert.equal(registro[0]!.client_id, t.clientId);
  assert.deepEqual(JSON.parse(registro[0]!.detail), {
    mailboxId: t.mailboxId,
    email: t.email,
    to: 'ana.personal@gmail.com',
    linkId: enlace.id,
    reused: false,
    hasPassword: true,
  });
  assert.ok(!registro[0]!.detail.includes(decryptSecret(enlace.token_enc)));
  assert.ok(!registro[0]!.detail.includes(decryptSecret(enlace.password_enc)));

  // El buzón lo cuenta en el listado.
  const mailbox = await buzonJson(t.mailboxId, t.clientId);
  assert.equal(mailbox.configuredAt, null);
  assert.ok(mailbox.setup.lastLinkAt);
  assert.equal(mailbox.setup.lastOpenedAt, null);
  assert.deepEqual(mailbox.setup.lastEmail, { to: 'ana.personal@gmail.com', at: body.sent.at, status: 'sent' });
});

test('un enlace reciente con contraseña se reutiliza: sin contraseña nueva ni enlace nuevo', async () => {
  const t = await equipo();
  const primero = await enviar(t.mailboxId, { to: 'titular@ejemplo.com' }, t.userCookie);
  assert.equal(primero.statusCode, 200, primero.body);
  const [enlace] = enlaces(t.mailboxId);
  const password = decryptSecret(enlace!.password_enc!);

  const segundo = await enviar(t.mailboxId, { to: 'otra@ejemplo.com', ttlHours: 2 }, t.userCookie);
  assert.equal(segundo.statusCode, 200, segundo.body);
  const body = segundo.json() as RespuestaEnvio;
  assert.equal(body.reused, true);
  assert.equal(body.link.hasPassword, true);
  // Es el mismo enlace (la validez pedida solo vale para uno nuevo).
  assert.equal(body.link.expiresAt, enlace!.expires_at);
  assert.equal(enlaces(t.mailboxId).length, 1);
  assert.equal(await motorAcepta(t.email, password), true, 'la contraseña no ha cambiado');

  const mailbox = await buzonJson(t.mailboxId, t.clientId);
  assert.equal(mailbox.setup.lastEmail?.to, 'otra@ejemplo.com');
  const registro = auditoria('mailbox.setup_email_sent', t.email).map((a) => JSON.parse(a.detail).reused);
  assert.deepEqual(registro, [false, true]);
});

test('sin enlace reutilizable se rota la contraseña y el buzón vuelve a estar sin configurar', async () => {
  const t = await equipo();
  // El titular entra en «Mi buzón»: queda configurado.
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/login',
    payload: { email: t.email, password: t.password },
    remoteAddress: nuevaIp(),
  });
  assert.equal(login.statusCode, 200, login.body);
  assert.ok(configuredAt(t.mailboxId));
  // Un enlace con contraseña que caduca en menos de un día no se reutiliza.
  await crearEnlace(t.mailboxId, { includePassword: true, password: t.password, ttlHours: 12 });

  const res = await enviar(t.mailboxId, { to: 'titular@ejemplo.com' }, t.userCookie);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as RespuestaEnvio).reused, false);
  assert.equal(configuredAt(t.mailboxId), null);
  assert.equal(await motorAcepta(t.email, t.password), false);
  const lista = enlaces(t.mailboxId);
  assert.equal(lista.length, 2);
  assert.equal(lista[0]!.password_enc, null, 'el enlace anterior pierde la contraseña que ya no vale');
  assert.equal(await motorAcepta(t.email, decryptSecret(lista[1]!.password_enc!)), true);
  // La sesión de «Mi buzón» se cierra con la contraseña antigua.
  const me = await ctx.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie: cookieFrom(login) } });
  assert.equal(me.statusCode, 401);
});

test('sin contraseña: no la cambia y nunca reutiliza un enlace que la lleva', async () => {
  const t = await equipo();
  const conContrasena = await crearEnlace(t.mailboxId, { includePassword: true, password: t.password });

  const res = await enviar(t.mailboxId, { to: 'compartido@ejemplo.com', includePassword: false }, t.userCookie);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as RespuestaEnvio;
  assert.equal(body.reused, false);
  assert.equal(body.link.hasPassword, false);
  assert.equal(await motorAcepta(t.email, t.password), true, 'la contraseña sigue siendo la misma');
  const lista = enlaces(t.mailboxId);
  assert.equal(lista.length, 2);
  assert.equal(lista[0]!.id, conContrasena.id);
  assert.ok(lista[0]!.password_enc, 'el enlace con contraseña no se toca');
  assert.equal(lista[1]!.password_enc, null);

  // El siguiente sin contraseña reutiliza ese enlace.
  const otra = await enviar(t.mailboxId, { to: 'compartido@ejemplo.com', includePassword: false }, t.userCookie);
  assert.equal((otra.json() as RespuestaEnvio).reused, true);
  assert.equal(enlaces(t.mailboxId).length, 2);
});

test('no se envía al propio buzón ni a una dirección no válida', async () => {
  const t = await equipo();
  const mismo = await enviar(t.mailboxId, { to: t.email.toUpperCase() }, t.userCookie);
  assert.equal(mismo.statusCode, 400, mismo.body);
  assert.equal(mismo.json().code, 'setup_email_same_mailbox');

  for (const to of ['no-es-un-correo', '', `${'a'.repeat(250)}@x.es`, 'a@b.es\r\nBcc: otro@x.es']) {
    const res = await enviar(t.mailboxId, { to }, t.userCookie);
    assert.equal(res.statusCode, 400, `${to}: ${res.body}`);
  }
  assert.equal((await enviar(t.mailboxId, {}, t.userCookie)).statusCode, 400);
  assert.equal((await enviar(t.mailboxId, { to: 'a@ejemplo.com', ttlHours: 0 }, t.userCookie)).statusCode, 400);
  assert.equal((await enviar(t.mailboxId, { to: 'a@ejemplo.com', ttlHours: 721 }, t.userCookie)).statusCode, 400);
  assert.equal(envios(t.mailboxId).length, 0);
  // Nada de lo anterior toca la contraseña.
  assert.equal(await motorAcepta(t.email, t.password), true);
});

test(`límites: ${MAX_ENVIOS_POR_BUZON} por buzón y ${MAX_ENVIOS_POR_CLIENTE} por cliente cada hora`, async () => {
  const t = await equipo();
  for (let i = 0; i < MAX_ENVIOS_POR_BUZON; i += 1) {
    const res = await enviar(t.mailboxId, { to: `titular${i}@ejemplo.com` }, t.userCookie);
    assert.equal(res.statusCode, 200, res.body);
  }
  const tope = await enviar(t.mailboxId, { to: 'titular@ejemplo.com' }, t.userCookie);
  assert.equal(tope.statusCode, 429, tope.body);
  assert.equal(tope.json().code, 'too_many_setup_emails');
  assert.equal(envios(t.mailboxId).length, MAX_ENVIOS_POR_BUZON);

  // Por cliente: los envíos de otros buzones suman.
  const otro = await createMailbox(ctx, t.domainId);
  const insertar = db.prepare(
    `INSERT INTO envios_configuracion (id, mailbox_id, client_id, recipient, status, created_at)
     VALUES (?, ?, ?, 'x@ejemplo.com', 'sent', ?)`,
  );
  for (let i = 0; i < MAX_ENVIOS_POR_CLIENTE - MAX_ENVIOS_POR_BUZON; i += 1) {
    insertar.run(`ecf_relleno_${t.clientId}_${i}`, t.mailboxId, t.clientId, Date.now());
  }
  const cliente = await enviar(otro.mailboxId, { to: 'titular@ejemplo.com' }, t.userCookie);
  assert.equal(cliente.statusCode, 429, cliente.body);
  assert.equal(cliente.json().code, 'too_many_setup_emails');
  assert.equal(await motorAcepta(otro.email, otro.password), true, 'sin envío no hay contraseña nueva');

  // Lo de hace más de una hora ya no cuenta.
  db.prepare('UPDATE envios_configuracion SET created_at = ? WHERE client_id = ?').run(
    Date.now() - 2 * 3600_000,
    t.clientId,
  );
  assert.equal((await enviar(otro.mailboxId, { to: 'titular@ejemplo.com' }, t.userCookie)).statusCode, 200);
});

test('cliente suspendido, buzón suspendido, otro cliente o sin sesión: no se envía', async () => {
  const t = await equipo();
  const ajeno = await createClient(ctx, { withUser: true });

  assert.equal((await ctx.app.inject({ method: 'POST', url: `/api/mailboxes/${t.mailboxId}/setup-email`, payload: { to: 'a@ejemplo.com' } })).statusCode, 401);
  const otro = await enviar(t.mailboxId, { to: 'a@ejemplo.com' }, ajeno.userCookie!);
  assert.equal(otro.statusCode, 403, otro.body);
  const marca = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${t.mailboxId}/configured`,
    headers: { cookie: ajeno.userCookie! },
    payload: { configured: true },
  });
  assert.equal(marca.statusCode, 403, marca.body);
  assert.equal((await enviar('mbx_no_existe', { to: 'a@ejemplo.com' }, t.userCookie)).statusCode, 404);

  const suspender = (suspended: boolean) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/clients/${t.clientId}`,
      headers: { cookie: ctx.adminCookie },
      payload: { suspended },
    });
  assert.equal((await suspender(true)).statusCode, 200);
  const suspendido = await enviar(t.mailboxId, { to: 'a@ejemplo.com' }, ctx.adminCookie);
  assert.equal(suspendido.statusCode, 403, suspendido.body);
  assert.equal(suspendido.json().code, 'client_suspended');
  assert.equal((await suspender(false)).statusCode, 200);

  await ctx.app.inject({
    method: 'PATCH',
    url: `/api/mailboxes/${t.mailboxId}`,
    headers: { cookie: ctx.adminCookie },
    payload: { status: 'suspended' },
  });
  const buzon = await enviar(t.mailboxId, { to: 'a@ejemplo.com' }, t.userCookie);
  assert.equal(buzon.statusCode, 400, buzon.body);
  assert.equal(buzon.json().code, 'mailbox_suspended');

  assert.equal(envios(t.mailboxId).length, 0);
  assert.equal(enlaces(t.mailboxId).length, 0);
});

test('con un buzón o alias configuration@ anterior a la reserva no se envía (409) ni se toca nada', async () => {
  const t = await equipo();
  db.prepare(
    `INSERT INTO mailboxes (id, domain_id, local_part, display_name, quota_mb, created_at)
     VALUES (?, ?, 'configuration', '', 1024, ?)`,
  ).run(`mbx_heredado_${t.domainId}`, t.domainId, Date.now());
  const res = await enviar(t.mailboxId, { to: 'titular@ejemplo.com' }, t.userCookie);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, 'configuration_sender_taken');
  assert.match(res.json().error, new RegExp(`configuration@${t.domain.replace(/\./g, '\\.')} ya está en uso`));
  assert.equal(await motorAcepta(t.email, t.password), true, 'la contraseña no cambia');
  assert.equal(enlaces(t.mailboxId).length, 0);
  assert.equal(envios(t.mailboxId).length, 0);

  // Igual con un alias.
  const conAlias = await equipo();
  db.prepare(
    `INSERT INTO aliases (id, domain_id, local_part, destinations_json, created_at)
     VALUES (?, ?, 'configuration', ?, ?)`,
  ).run(`als_heredado_${conAlias.domainId}`, conAlias.domainId, JSON.stringify([conAlias.email]), Date.now());
  const alias = await enviar(conAlias.mailboxId, { to: 'titular@ejemplo.com' }, conAlias.userCookie);
  assert.equal(alias.statusCode, 409, alias.body);
  assert.equal(alias.json().code, 'configuration_sender_taken');
  const filas = db
    .prepare('SELECT COUNT(*) AS c FROM remitentes_configuracion WHERE domain_id IN (?, ?)')
    .get(t.domainId, conAlias.domainId) as { c: number };
  assert.equal(filas.c, 0);
});

test('la cuenta configuration@ se crea una vez por dominio, oculta, y se borra con el dominio', async () => {
  const t = await equipo();
  const segundo = await createMailbox(ctx, t.domainId);
  const engine = getEngine();
  const altas: CreateMailboxInput[] = [];
  const original = engine.createMailbox.bind(engine);
  engine.createMailbox = async (input) => {
    altas.push(input);
    return original(input);
  };
  let respuestas = '';
  try {
    for (const id of [t.mailboxId, segundo.mailboxId, t.mailboxId]) {
      const res = await enviar(id, { to: 'titular@ejemplo.com' }, t.userCookie);
      assert.equal(res.statusCode, 200, res.body);
      respuestas += res.body;
    }
  } finally {
    engine.createMailbox = original;
  }
  const remitente = `configuration@${t.domain}`;
  assert.equal(altas.length, 1, 'una sola alta en el motor');
  assert.equal(altas[0]!.email, remitente);
  assert.equal(altas[0]!.displayName, 'Configura tu correo');
  assert.equal(altas[0]!.quotaBytes, 25 * 1024 * 1024);
  const fila = db.prepare('SELECT password_enc FROM remitentes_configuracion WHERE domain_id = ?').get(t.domainId) as
    | { password_enc: string }
    | undefined;
  assert.ok(fila);
  const password = decryptSecret(fila.password_enc);
  assert.ok(password.length >= 24);
  assert.equal(await motorAcepta(remitente, password), true);
  assert.ok(!respuestas.includes(password), 'su contraseña nunca sale en una respuesta');

  // No es un buzón del cliente: ni en el listado, ni en el uso del plan.
  const lista = await ctx.app.inject({
    method: 'GET',
    url: '/api/mailboxes',
    headers: { cookie: t.userCookie },
  });
  const emails = (lista.json() as { mailboxes: { email: string }[] }).mailboxes.map((m) => m.email);
  assert.deepEqual(emails.sort(), [t.email, segundo.email].sort());
  const cliente = await ctx.app.inject({ method: 'GET', url: `/api/clients/${t.clientId}`, headers: { cookie: t.userCookie } });
  assert.equal((cliente.json() as { usage: { mailboxes: number } }).usage.mailboxes, 2);
  // Nadie entra en «Mi buzón» con ella (no es un buzón del panel).
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/login',
    payload: { email: remitente, password },
    remoteAddress: nuevaIp(),
  });
  assert.equal(login.statusCode, 401);

  // Al borrar el dominio, la cuenta desaparece del motor y de la base.
  const borrado = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/domains/${t.domainId}?confirm=${t.domain}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(borrado.statusCode, 200, borrado.body);
  assert.equal(await motorAcepta(remitente, password), false);
  assert.equal((await engine.getMailboxUsage()).has(remitente), false);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS c FROM remitentes_configuracion WHERE domain_id = ?').get(t.domainId) as { c: number }).c,
    0,
  );
});

/* ------------------------------ Configurado -------------------------------- */

test('configurado: lo marcan «Ya lo he configurado», el perfil de Apple, «Mi buzón» y el webmail', async () => {
  const t = await equipo();
  const otros = await Promise.all([createMailbox(ctx, t.domainId), createMailbox(ctx, t.domainId), createMailbox(ctx, t.domainId)]);
  const [perfil, portal, webmail] = otros as [typeof otros[0], typeof otros[0], typeof otros[0]];

  // Abrir el enlace no basta: solo cuenta como apertura.
  const enlace = await crearEnlace(t.mailboxId);
  const token = tokenDe(enlace.url);
  await ctx.app.inject({ method: 'GET', url: `/api/public/setup/${token}` });
  let mailbox = await buzonJson(t.mailboxId, t.clientId);
  assert.equal(mailbox.configuredAt, null);
  assert.ok(mailbox.setup.lastOpenedAt);
  assert.ok(mailbox.setup.lastLinkAt);
  assert.equal(mailbox.setup.lastEmail, null);

  const hecho = await ctx.app.inject({ method: 'POST', url: `/api/public/setup/${token}/done` });
  assert.equal(hecho.statusCode, 200, hecho.body);
  mailbox = await buzonJson(t.mailboxId, t.clientId);
  assert.ok(mailbox.configuredAt);
  const primero = mailbox.configuredAt;

  // Se guarda el primer momento: volver a hacerlo no lo cambia.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await ctx.app.inject({ method: 'POST', url: `/api/public/setup/${token}/done` });
  assert.equal(configuredAt(t.mailboxId), primero);

  const enlacePerfil = await crearEnlace(perfil.mailboxId);
  const descarga = await ctx.app.inject({
    method: 'GET',
    url: `/api/public/setup/${tokenDe(enlacePerfil.url)}/perfil.mobileconfig`,
  });
  assert.equal(descarga.statusCode, 200);
  assert.ok(configuredAt(perfil.mailboxId));

  // Un intento fallido en «Mi buzón» no cuenta; entrar, sí.
  const mal = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/login',
    payload: { email: portal.email, password: 'no-es-la-buena' },
    remoteAddress: nuevaIp(),
  });
  assert.equal(mal.statusCode, 401);
  assert.equal(configuredAt(portal.mailboxId), null);
  const bien = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/login',
    payload: { email: portal.email, password: portal.password },
    remoteAddress: nuevaIp(),
  });
  assert.equal(bien.statusCode, 200, bien.body);
  assert.ok(configuredAt(portal.mailboxId));

  const anterior = config.webmailToken;
  try {
    config.webmailToken = 'secreto-webmail-entrega';
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/webmail/profile',
      headers: { 'x-mailway-token': 'secreto-webmail-entrega' },
      payload: { user: webmail.email.toUpperCase() },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(configuredAt(webmail.mailboxId));
  } finally {
    config.webmailToken = anterior;
  }
});

test('configurado: lo borran el reinicio y la contraseña nueva del panel, no la que cambia el titular', async () => {
  const t = await equipo();
  const entrar = (password: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/portal/login',
      payload: { email: t.email, password },
      remoteAddress: nuevaIp(),
    });
  const sesion = await entrar(t.password);
  assert.equal(sesion.statusCode, 200, sesion.body);
  assert.ok(configuredAt(t.mailboxId));

  // El titular cambia su contraseña: sigue teniendo acceso.
  const cambio = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/password',
    headers: { cookie: cookieFrom(sesion) },
    payload: { current: t.password, next: 'otra-clave-del-titular' },
  });
  assert.equal(cambio.statusCode, 200, cambio.body);
  assert.ok(configuredAt(t.mailboxId));

  // El panel pone otra: sus dispositivos dejan de entrar.
  const panel = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${t.mailboxId}/password`,
    headers: { cookie: t.userCookie },
    payload: {},
  });
  assert.equal(panel.statusCode, 200, panel.body);
  assert.equal(configuredAt(t.mailboxId), null);

  // Reinicio: además se olvidan los correos de configuración enviados.
  const nueva = (panel.json() as { password: string }).password;
  assert.equal((await entrar(nueva)).statusCode, 200);
  assert.ok(configuredAt(t.mailboxId));
  assert.equal((await enviar(t.mailboxId, { to: 'titular@ejemplo.com' }, t.userCookie)).statusCode, 200);
  // (enviar con contraseña rota la del buzón y ya lo deja sin configurar)
  assert.equal(configuredAt(t.mailboxId), null);
  await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${t.mailboxId}/configured`,
    headers: { cookie: t.userCookie },
    payload: { configured: true },
  });
  assert.ok(configuredAt(t.mailboxId));
  const reinicio = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${t.mailboxId}/setup-reset`,
    headers: { cookie: t.userCookie },
    payload: {},
  });
  assert.equal(reinicio.statusCode, 200, reinicio.body);
  assert.equal(configuredAt(t.mailboxId), null);
  assert.equal(envios(t.mailboxId).length, 0);
  const mailbox = await buzonJson(t.mailboxId, t.clientId);
  assert.equal(mailbox.setup.lastEmail, null);
  assert.ok(mailbox.setup.lastLinkAt, 'el enlace del reinicio');
});

test('marcar a mano como configurado (y deshacerlo), con su anotación en la actividad', async () => {
  const t = await equipo();
  const marcar = (payload: unknown, cookie = t.userCookie) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/mailboxes/${t.mailboxId}/configured`,
      headers: { cookie },
      payload: payload as Record<string, unknown>,
    });

  const si = await marcar({ configured: true });
  assert.equal(si.statusCode, 200, si.body);
  const { configuredAt: marcado } = si.json() as { configuredAt: number };
  assert.ok(Math.abs(marcado - Date.now()) < 60_000);
  assert.equal((await buzonJson(t.mailboxId, t.clientId)).configuredAt, marcado);
  // Marcarlo otra vez conserva el primer momento.
  assert.equal((await marcar({ configured: true })).json().configuredAt, marcado);

  const no = await marcar({ configured: false }, ctx.adminCookie);
  assert.equal(no.statusCode, 200, no.body);
  assert.deepEqual(no.json(), { configuredAt: null });
  assert.equal((await buzonJson(t.mailboxId, t.clientId)).configuredAt, null);

  assert.equal((await marcar({})).statusCode, 400);
  assert.equal((await marcar({ configured: 'sí' })).statusCode, 400);

  const registro = auditoria('mailbox.marked_configured', t.email);
  assert.equal(registro.length, 3);
  assert.ok(registro.every((a) => a.client_id === t.clientId));
  assert.deepEqual(JSON.parse(registro[2]!.detail), { mailboxId: t.mailboxId, email: t.email, configured: false });
});

/* ------------------------------ El mensaje --------------------------------- */

test('el mensaje: saludo, contraseña incluida o no, firma y todo escapado en el HTML', () => {
  const caduca = Date.UTC(2026, 9, 15, 8, 30);
  assert.equal(fechaLargaConfiguracion(caduca), '15 de octubre de 2026 a las 10:30');

  const con = componerCorreoConfiguracion({
    email: 'ana@acme.test',
    displayName: '  Ana   María Pérez ',
    url: 'https://panel.acme.test/conectar/abc_DEF-123',
    expiresAt: caduca,
    hasPassword: true,
    clientName: 'Acme',
    senderName: 'Luis',
  });
  assert.equal(con.subject, 'Configura tu correo ana@acme.test');
  assert.match(con.text, /^Hola, Ana:\n/);
  assert.match(con.text, /Ya tienes tu buzón de correo ana@acme\.test\./);
  assert.match(con.text, /La contraseña ya va incluida, así que solo lleva un par de minutos\./);
  assert.match(con.text, /\nhttps:\/\/panel\.acme\.test\/conectar\/abc_DEF-123\n/);
  assert.match(con.text, /El enlace es personal y vale hasta el 15 de octubre de 2026 a las 10:30\. Como incluye tu contraseña, no lo reenvíes a nadie\./);
  assert.match(con.text, /Te lo envía Luis desde Acme\.\n$/);
  assert.match(con.html, /Configurar mi correo<\/a>/);
  assert.match(con.html, /#0d5c5e/);
  assert.ok(con.html.includes('href="https://panel.acme.test/conectar/abc_DEF-123"'));
  assert.doesNotMatch(con.text + con.html, /mailway/i, 'marca blanca: sin el nombre de la plataforma');

  const sin = componerCorreoConfiguracion({
    email: 'eva@acme.test',
    displayName: '',
    url: 'https://panel.acme.test/conectar/x"><script>alert(1)</script>',
    expiresAt: caduca,
    hasPassword: false,
    clientName: 'Acme <b>& "Cía"</b>',
    senderName: null,
  });
  // Un nombre que ya acaba en punto («S.L.») no lleva un segundo punto.
  const sl = componerCorreoConfiguracion({
    email: 'ana@acme.test',
    displayName: 'Ana',
    url: 'https://panel.acme.test/conectar/abc',
    expiresAt: caduca,
    hasPassword: true,
    clientName: 'Talleres Ruiz S.L.',
    senderName: 'Marta Ruiz',
  });
  assert.match(sl.text, /Te lo envía Marta Ruiz desde Talleres Ruiz S\.L\.\n$/);
  assert.doesNotMatch(sl.text + sl.html, /S\.L\.\./);

  assert.match(sin.text, /^Hola:\n/);
  assert.match(sin.text, /necesitarás la contraseña de tu buzón\./);
  assert.doesNotMatch(sin.text, /incluye tu contraseña|ya va incluida/);
  assert.match(sin.text, /Te lo envía Acme <b>& "Cía"<\/b>\.\n$/);
  assert.ok(sin.html.includes('Te lo envía Acme &lt;b&gt;&amp; &quot;Cía&quot;&lt;/b&gt;.'));
  assert.ok(!sin.html.includes('<script>'));
  assert.ok(!sin.html.includes('<b>'));

  const nombreRaro = componerCorreoConfiguracion({
    email: 'x@acme.test',
    displayName: '<img src=x onerror=alert(1)> Pérez',
    url: 'https://panel.acme.test/conectar/abc',
    expiresAt: caduca,
    hasPassword: true,
    clientName: 'Acme',
    senderName: 'Luis\nBcc: alguien',
  });
  assert.ok(nombreRaro.html.includes('Hola, &lt;img:'));
  assert.ok(!nombreRaro.html.includes('<img'));
  assert.match(nombreRaro.text, /Te lo envía Luis Bcc: alguien desde Acme\./);
});

test('sin motor de correo configurado: 503 y nada cambia', async () => {
  const t = await equipo();
  config.demoMode = false;
  try {
    const res = await enviar(t.mailboxId, { to: 'titular@ejemplo.com' }, t.userCookie);
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json().code, 'engine_not_configured');
  } finally {
    config.demoMode = true;
  }
  assert.equal(enlaces(t.mailboxId).length, 0);
  assert.equal(envios(t.mailboxId).length, 0);
});

/*
 * Con un motor «real» y un transporte falso. Va al final: el envío de
 * demostración deja creados el remitente y el enlace, así que en el modo real
 * no hace falta hablar con la API del motor.
 */
test('con el SMTP del motor: remitente, Reply-To, asunto y cuerpos; y un fallo da 502 y queda anotado', async () => {
  const t = await equipo({ name: 'Acme <Pruebas> & Cía' });
  await ctx.app.inject({
    method: 'PATCH',
    url: `/api/mailboxes/${t.mailboxId}`,
    headers: { cookie: ctx.adminCookie },
    payload: { displayName: 'Marta Ruiz' },
  });
  assert.equal((await enviar(t.mailboxId, { to: 'marta@ejemplo.com' }, t.userCookie)).statusCode, 200);
  const usuario = db
    .prepare("SELECT email, name FROM users WHERE client_id = ? AND role = 'client'")
    .get(t.clientId) as { email: string; name: string };

  const enviados: Mail.Options[] = [];
  let fallar = false;
  const credenciales: unknown[] = [];
  setTransportFactoryForTests((options) => {
    credenciales.push(options.auth);
    return {
      sendMail: async (opciones: Mail.Options) => {
        if (fallar) throw new Error('Connection refused');
        enviados.push(opciones);
        return { messageId: '<config@motor>' };
      },
      close: () => undefined,
    } as unknown as Transporter;
  });
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
  let ok;
  let fallo;
  let reintento;
  try {
    ok = await enviar(t.mailboxId, { to: 'marta.casa@ejemplo.com' }, t.userCookie);
    fallar = true;
    fallo = await enviar(t.mailboxId, { to: 'marta.casa@ejemplo.com' }, t.userCookie);
    fallar = false;
    reintento = await enviar(t.mailboxId, { to: 'marta.casa@ejemplo.com' }, t.userCookie);
  } finally {
    config.demoMode = true;
    setTransportFactoryForTests(null);
    forgetTransport(`config:${t.domainId}`);
  }
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((ok.json() as RespuestaEnvio).reused, true);

  const remitente = `configuration@${t.domain}`;
  const fila = db.prepare('SELECT password_enc FROM remitentes_configuracion WHERE domain_id = ?').get(t.domainId) as {
    password_enc: string;
  };
  assert.deepEqual(credenciales[0], { user: remitente, pass: decryptSecret(fila.password_enc) });

  assert.equal(enviados.length, 2);
  const m = enviados[0]!;
  assert.deepEqual(m.from, { name: 'Configura tu correo', address: remitente });
  assert.equal(m.to, 'marta.casa@ejemplo.com');
  assert.equal(m.replyTo, usuario.email);
  assert.equal(m.subject, `Configura tu correo ${t.email}`);
  const [enlace] = enlaces(t.mailboxId);
  const url = `/conectar/${decryptSecret(enlace!.token_enc!)}`;
  assert.ok(String(m.text).includes(url));
  assert.ok(String(m.html).includes(url));
  assert.match(String(m.text), /^Hola, Marta:/);
  assert.ok(String(m.text).includes(`Te lo envía ${usuario.name} desde Acme <Pruebas> & Cía.`));
  assert.ok(String(m.html).includes('desde Acme &lt;Pruebas&gt; &amp; Cía.'));
  assert.ok(!ok.body.includes(url));

  assert.equal(fallo.statusCode, 502, fallo.body);
  assert.equal(fallo.json().code, 'setup_email_failed');
  assert.match(fallo.json().error, /Connection refused/);
  assert.ok(!fallo.body.includes(url));
  const filas = envios(t.mailboxId);
  assert.deepEqual(
    filas.map((f) => f.status),
    ['sent', 'sent', 'failed', 'sent'],
  );
  assert.match(filas[2]!.error, /Connection refused/);
  assert.equal(auditoria('mailbox.setup_email_failed', t.email).length, 1);
  assert.ok(!auditoria('mailbox.setup_email_failed', t.email)[0]!.detail.includes(url));

  // El reintento envía el mismo enlace.
  assert.equal(reintento.statusCode, 200, reintento.body);
  assert.equal((reintento.json() as RespuestaEnvio).reused, true);
  assert.equal(enlaces(t.mailboxId).length, 1);
  assert.equal((await buzonJson(t.mailboxId, t.clientId)).setup.lastEmail?.status, 'sent');
});
