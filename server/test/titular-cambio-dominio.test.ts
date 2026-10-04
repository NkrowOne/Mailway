import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { getEngine } from '../src/engine';
import type { MailEngine } from '../src/engine/types';
import { stableUuid } from '../src/modules/connection';
import { crearEnlaceConfiguracion } from '../src/modules/portal';
import { setInstanceSettings } from '../src/modules/settings';
import {
  adminContext,
  cookieFrom,
  createClient,
  createDomain,
  createMailbox,
  type TestContext,
} from './helpers';

/*
 * El titular durante un cambio de dominio (dominio viejo → dominio nuevo):
 * «Mi buzón», el enlace de configuración, el webmail y la autoconfiguración.
 *
 * Mientras no actualiza sus dispositivos, el buzón ya tiene la dirección nueva
 * pero el motor solo lo conoce por el usuario anterior (mailboxes.usuario_motor):
 * se entra con cualquiera de las dos direcciones, los datos de conexión y los
 * perfiles enseñan el usuario anterior, y «Actualizar mis dispositivos» lo
 * cambia a la dirección vigente conservando el correo y las contraseñas.
 *
 * El estado del cambio se escribe a mano (motor y SQL), como lo dejan «Pasar»
 * y la pre-recepción: la orquestación es de otra pieza.
 */

const MAIL_HOST = 'mail.proveedor-titular.test';
const PANEL = 'https://panel.proveedor-titular.test';
const TOKEN_WEBMAIL = 'secreto-compartido-webmail-titular';

let ctx: TestContext;
let clientId: string;
let viejo: { domainId: string; domain: string };
let nuevo: { domainId: string; domain: string };
/** Cambio en preparación (con la pre-recepción hecha): el buzón aún vive en el viejo. */
let prepViejo: { domainId: string; domain: string };
let prepNuevo: { domainId: string; domain: string };
let normal: { domainId: string; domain: string };

interface Buzon {
  mailboxId: string;
  /** Dirección anterior: el usuario del motor hasta actualizar. */
  vieja: string;
  /** Dirección vigente tras pasar. */
  nueva: string;
  password: string;
}

const buzones: Record<string, Buzon> = {};
let prep: { mailboxId: string; direccion: string; pareja: string; password: string };
let corriente: { mailboxId: string; email: string; password: string };

const motor = (): MailEngine => getEngine();

let ipSeq = 0;
/** IP distinta por petición: el límite por IP no debe mezclar unas pruebas con otras. */
function nuevaIp(): string {
  ipSeq += 1;
  return `10.77.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

/** Cambio de dominio escrito en la base, con sus ítems (lo crea la orquestación). */
function insertarCambio(input: {
  id: string;
  desde: { domainId: string; domain: string };
  hacia: { domainId: string; domain: string };
  estado: string;
  buzones: { id: string; local: string }[];
}): void {
  const t = Date.now();
  db.prepare(
    `INSERT INTO domain_migrations (id, client_id, from_domain_id, to_domain_id, from_domain, to_domain,
       estado, direcciones_at, created_at, updated_at, pasado_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    clientId,
    input.desde.domainId,
    input.hacia.domainId,
    input.desde.domain,
    input.hacia.domain,
    input.estado,
    t,
    t,
    t,
    input.estado === 'pasado' ? t : null,
  );
  for (const b of input.buzones) {
    db.prepare(
      `INSERT INTO domain_migration_items (migration_id, tipo, item_id, local_part) VALUES (?, 'buzon', ?, ?)`,
    ).run(input.id, b.id, b.local);
  }
}

before(async () => {
  ctx = await adminContext();
  setInstanceSettings({
    brandName: 'Correo Titular',
    mailHostname: MAIL_HOST,
    publicIp: '203.0.113.20',
    panelUrl: PANEL,
    webmailUrl: 'https://webmail.proveedor-titular.test',
  });
  const cliente = await createClient(ctx);
  clientId = cliente.clientId;
  const plan = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/clients/${clientId}`,
    headers: { cookie: ctx.adminCookie },
    payload: { planId: 'plan_agencia' },
  });
  assert.equal(plan.statusCode, 200, plan.body);
  viejo = await createDomain(ctx, clientId, 'titular-viejo.test');
  nuevo = await createDomain(ctx, clientId, 'titular-nuevo.test');
  prepViejo = await createDomain(ctx, clientId, 'titular-prep-viejo.test');
  prepNuevo = await createDomain(ctx, clientId, 'titular-prep-nuevo.test');
  normal = await createDomain(ctx, clientId, 'titular-normal.test');

  // Buzones del dominio viejo, creados ANTES del cambio (después el origen no admite altas).
  const locales = ['ana', 'bea', 'carla', 'dario', 'elena', 'fede', 'gema', 'tienda'];
  for (const local of locales) {
    const creado = await createMailbox(ctx, viejo.domainId, local);
    buzones[local] = {
      mailboxId: creado.mailboxId,
      vieja: `${local}@${viejo.domain}`,
      nueva: `${local}@${nuevo.domain}`,
      password: creado.password,
    };
  }
  const p = await createMailbox(ctx, prepViejo.domainId, 'pilar');
  prep = {
    mailboxId: p.mailboxId,
    direccion: `pilar@${prepViejo.domain}`,
    pareja: `pilar@${prepNuevo.domain}`,
    password: p.password,
  };
  const c = await createMailbox(ctx, normal.domainId, 'nora');
  corriente = { mailboxId: c.mailboxId, email: c.email, password: c.password };

  // «Pasar» (viejo → nuevo): en el motor, la dirección nueva es la principal y
  // la vieja sigue; en la base, el buzón vive en el dominio nuevo y entra con
  // su usuario anterior.
  await motor().createDomain(nuevo.domain);
  for (const b of Object.values(buzones)) {
    await motor().setAddresses(b.vieja, { add: [b.nueva], primary: b.nueva });
    db.prepare('UPDATE mailboxes SET domain_id = ?, usuario_motor = ?, semilla_perfil = ? WHERE id = ?').run(
      nuevo.domainId,
      b.vieja,
      b.vieja,
      b.mailboxId,
    );
  }
  insertarCambio({
    id: 'dmg_titular_pasado',
    desde: viejo,
    hacia: nuevo,
    estado: 'pasado',
    buzones: locales.map((local) => ({ id: buzones[local]!.mailboxId, local })),
  });

  // Pre-recepción (prepViejo → prepNuevo, «listo»): el buzón sigue en el viejo
  // y ya recibe también en la dirección del nuevo.
  await motor().createDomain(prepNuevo.domain);
  await motor().setAddresses(prep.direccion, { add: [prep.pareja] });
  insertarCambio({
    id: 'dmg_titular_listo',
    desde: prepViejo,
    hacia: prepNuevo,
    estado: 'listo',
    buzones: [{ id: prep.mailboxId, local: 'pilar' }],
  });

  // La tienda envía con una contraseña de aplicación de Skyway.
  const app = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${buzones.tienda!.mailboxId}/app-passwords`,
    headers: { cookie: ctx.adminCookie },
    payload: { name: 'skyway:tienda' },
  });
  assert.equal(app.statusCode, 200, app.body);
});

/* --------------------------------- Utilidades -------------------------------- */

async function entrar(email: string, password: string, ip = nuevaIp()) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/portal/login',
    payload: { email, password },
    remoteAddress: ip,
  });
}

async function sesion(email: string, password: string): Promise<string> {
  const res = await entrar(email, password);
  assert.equal(res.statusCode, 200, res.body);
  return cookieFrom(res);
}

async function crearEnlace(mailboxId: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${mailboxId}/setup-links`,
    headers: { cookie: ctx.adminCookie },
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body);
  const match = /\/conectar\/([A-Za-z0-9_-]+)$/.exec((res.json() as { link: { url: string } }).link.url);
  assert.ok(match);
  return match[1]!;
}

function auditoria(action: string, id: string): { user_id: string | null; client_id: string | null; detail: Record<string, unknown> }[] {
  return (
    db.prepare('SELECT user_id, client_id, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as {
      user_id: string | null;
      client_id: string | null;
      detail: string;
    }[]
  )
    .map((fila) => ({ ...fila, detail: JSON.parse(fila.detail) as Record<string, unknown> }))
    .filter((fila) => fila.detail.id === id);
}

function filaBuzon(mailboxId: string) {
  return db
    .prepare('SELECT usuario_motor, login_anterior, semilla_perfil FROM mailboxes WHERE id = ?')
    .get(mailboxId) as { usuario_motor: string | null; login_anterior: string | null; semilla_perfil: string | null };
}

/**
 * Cambio de usuario a medias (usuario_cambiando_a), como lo deja un renombrado
 * sin respuesta del motor hasta que lo resuelve el conciliador.
 */
async function conCambioAMedias<T>(buzon: Buzon, fn: () => Promise<T>): Promise<T> {
  db.prepare('UPDATE mailboxes SET usuario_cambiando_a = ? WHERE id = ?').run(buzon.nueva, buzon.mailboxId);
  try {
    return await fn();
  } finally {
    db.prepare('UPDATE mailboxes SET usuario_cambiando_a = NULL WHERE id = ?').run(buzon.mailboxId);
  }
}

/** Usuario de entrada y de salida de un perfil de Apple. */
function usuariosDelPerfil(plist: string): string[] {
  return [...plist.matchAll(/<key>(?:Incoming|Outgoing)MailServerUsername<\/key>\s*<string>([^<]*)<\/string>/g)].map(
    (m) => m[1]!,
  );
}

async function thunderbird(email: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
  });
  assert.equal(res.statusCode, 200, res.body);
  const usuario = /<username>([^<]*)<\/username>/.exec(res.body);
  assert.ok(usuario, res.body);
  return usuario[1]!;
}

async function autodiscover(email: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/autodiscover/autodiscover.xml',
    headers: { 'content-type': 'text/xml; charset=utf-8' },
    payload: `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">
  <Request>
    <EMailAddress>${email}</EMailAddress>
    <AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema>
  </Request>
</Autodiscover>`,
  });
  assert.equal(res.statusCode, 200);
  const login = /<LoginName>([^<]*)<\/LoginName>/.exec(res.body);
  assert.ok(login, res.body);
  return login[1]!;
}

/** `token: null` envía la petición sin la cabecera X-Mailway-Token. */
async function cuentaWebmail(user: unknown, token: string | null = TOKEN_WEBMAIL) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/webmail/cuenta',
    headers: token === null ? {} : { 'x-mailway-token': token },
    payload: { user },
  });
}

async function conTokenWebmail<T>(fn: () => Promise<T>, token = TOKEN_WEBMAIL): Promise<T> {
  const anterior = config.webmailToken;
  config.webmailToken = token;
  try {
    return await fn();
  } finally {
    config.webmailToken = anterior;
  }
}

/* ---------------------------------- «Mi buzón» -------------------------------- */

test('«Mi buzón» entra con la dirección vieja y con la nueva, y enseña el usuario del motor', async () => {
  const ana = buzones.ana!;
  for (const tecleada of [ana.vieja, ana.nueva, ana.vieja.toUpperCase()]) {
    const res = await entrar(tecleada, ana.password);
    assert.equal(res.statusCode, 200, `${tecleada}: ${res.body}`);
    // La respuesta da siempre la dirección vigente, se teclee la que se teclee.
    assert.equal(res.json().email, ana.nueva);
  }

  const cookie = await sesion(ana.vieja, ana.password);
  const me = await ctx.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } });
  assert.equal(me.statusCode, 200, me.body);
  const datos = me.json() as Record<string, any>;
  assert.equal(datos.email, ana.nueva);
  assert.equal(datos.domain, nuevo.domain);
  assert.equal(datos.login, ana.vieja);
  assert.equal(datos.loginPending, true);
  assert.equal(datos.usadoPorApp, false);
  assert.equal(datos.connection.email, ana.nueva);
  assert.equal(datos.connection.username, ana.vieja);
  // La ocupación se busca por el nombre del principal en el motor (el usuario).
  assert.equal(datos.usedBytes, 0);
  const qr = JSON.parse(datos.thunderbirdAndroidQr) as unknown[];
  const entrada = qr[2] as unknown[];
  const salida = (qr[3] as unknown[][])[0]![0] as unknown[];
  assert.equal(entrada[5], ana.vieja, 'usuario de entrada del QR');
  assert.equal(entrada[6], ana.nueva, 'la cuenta sigue siendo la dirección');
  assert.equal(salida[5], ana.vieja, 'usuario de salida del QR');

  const perfil = await ctx.app.inject({ method: 'GET', url: '/api/portal/mobileconfig', headers: { cookie } });
  assert.equal(perfil.statusCode, 200);
  assert.deepEqual(usuariosDelPerfil(perfil.body), [ana.vieja, ana.vieja]);
  assert.match(perfil.body, new RegExp(`<key>EmailAddress</key>\\s*<string>${ana.nueva}</string>`));
  // Mismos UUID que el perfil que se instaló antes del cambio: lo sustituye.
  assert.ok(perfil.body.includes(stableUuid(`mobileconfig-perfil:${ana.vieja}`)));
  assert.ok(perfil.body.includes(stableUuid(`mobileconfig-cuenta:${ana.vieja}`)));
});

test('«Mi buzón» durante la preparación: entra con su dirección y con la del dominio nuevo', async () => {
  for (const tecleada of [prep.direccion, prep.pareja]) {
    const res = await entrar(tecleada, prep.password);
    assert.equal(res.statusCode, 200, `${tecleada}: ${res.body}`);
    assert.equal(res.json().email, prep.direccion);
  }
  const cookie = await sesion(prep.pareja, prep.password);
  const me = (await ctx.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } })).json() as Record<
    string,
    unknown
  >;
  assert.equal(me.login, prep.direccion);
  assert.equal(me.loginPending, false);

  // Una dirección del dominio nuevo que no es de ningún ítem no lleva a nada.
  const ajena = await entrar(`nadie@${prepNuevo.domain}`, prep.password);
  assert.equal(ajena.statusCode, 401);
});

test('el contador de fallos es por buzón: alternar la dirección vieja y la nueva no da más intentos', async () => {
  const bea = buzones.bea!;
  const tecleadas = [bea.vieja, bea.nueva, bea.vieja, bea.nueva, bea.vieja];
  for (const [i, tecleada] of tecleadas.entries()) {
    const res = await entrar(tecleada, `equivocada-${i}-larga`);
    assert.equal(res.statusCode, 401, tecleada);
  }
  for (const tecleada of [bea.nueva, bea.vieja]) {
    const bloqueado = await entrar(tecleada, bea.password);
    assert.equal(bloqueado.statusCode, 429, `${tecleada} también está bloqueada`);
    assert.equal(bloqueado.json().code, 'rate_limited');
  }
  const claves = db
    .prepare("SELECT DISTINCT ip FROM login_attempts WHERE ip LIKE 'buzon:%' AND (ip = ? OR ip = ? OR ip = ?)")
    .all(`buzon:${bea.mailboxId}`, `buzon:${bea.vieja}`, `buzon:${bea.nueva}`) as { ip: string }[];
  assert.deepEqual(
    claves.map((c) => c.ip),
    [`buzon:${bea.mailboxId}`],
  );
});

test('cambiar la contraseña desde «Mi buzón» va al usuario del motor', async () => {
  const carla = buzones.carla!;
  const cookie = await sesion(carla.nueva, carla.password);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/password',
    headers: { cookie },
    payload: { current: carla.password, next: 'nueva-clave-de-carla' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await motor().verifyCredentials(carla.vieja, 'nueva-clave-de-carla'), true);
  carla.password = 'nueva-clave-de-carla';
  // La sesión que hizo el cambio sigue.
  const me = await ctx.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } });
  assert.equal(me.statusCode, 200);
});

/* ------------------------- «Actualizar mis dispositivos» ----------------------- */

test('«Actualizar mis dispositivos» desde «Mi buzón»: renombra, conserva la sesión y es idempotente', async () => {
  const dario = buzones.dario!;
  const cookie = await sesion(dario.vieja, dario.password);
  const perfilAntes = await ctx.app.inject({ method: 'GET', url: '/api/portal/mobileconfig', headers: { cookie } });

  const res = await ctx.app.inject({ method: 'POST', url: '/api/portal/login-update', headers: { cookie }, payload: {} });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { ok: true, login: dario.nueva });
  assert.deepEqual(filaBuzon(dario.mailboxId), {
    usuario_motor: null,
    login_anterior: dario.vieja,
    semilla_perfil: dario.vieja,
  });
  // El principal se ha renombrado: misma contraseña, usuario nuevo.
  assert.equal(await motor().verifyCredentials(dario.nueva, dario.password), true);
  assert.equal(await motor().getPrincipal(dario.vieja), null);

  const registro = auditoria('mailbox.login_updated', dario.mailboxId);
  assert.equal(registro.length, 1);
  assert.equal(registro[0]!.user_id, null);
  assert.equal(registro[0]!.client_id, clientId);
  assert.deepEqual(registro[0]!.detail, { id: dario.mailboxId, de: dario.vieja, a: dario.nueva, por: 'titular' });

  // La sesión sigue y ya enseña el usuario nuevo.
  const me = (await ctx.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } })).json() as Record<
    string,
    any
  >;
  assert.equal(me.login, dario.nueva);
  assert.equal(me.loginPending, false);
  assert.equal(me.connection.username, dario.nueva);

  // El perfil nuevo lleva el usuario nuevo y los MISMOS identificadores: sustituye al anterior.
  const perfilDespues = await ctx.app.inject({ method: 'GET', url: '/api/portal/mobileconfig', headers: { cookie } });
  assert.deepEqual(usuariosDelPerfil(perfilDespues.body), [dario.nueva, dario.nueva]);
  const uuids = (plist: string) => [...plist.matchAll(/<key>PayloadUUID<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1]);
  assert.deepEqual(uuids(perfilDespues.body), uuids(perfilAntes.body));

  const otraVez = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/login-update',
    headers: { cookie },
    payload: {},
  });
  assert.equal(otraVez.statusCode, 200);
  assert.deepEqual(otraVez.json(), { ok: true, login: dario.nueva });
  assert.equal(auditoria('mailbox.login_updated', dario.mailboxId).length, 1, 'sin cambios no se audita');

  // Hasta la baja, también se entra con la dirección vieja.
  const conVieja = await entrar(dario.vieja, dario.password);
  assert.equal(conVieja.statusCode, 200, conVieja.body);

  const sinSesion = await ctx.app.inject({ method: 'POST', url: '/api/portal/login-update', payload: {} });
  assert.equal(sinSesion.statusCode, 401);
});

test('«Actualizar y continuar» desde el enlace: sin contraseña, con el límite público y al vuelo', async () => {
  const elena = buzones.elena!;
  const token = await crearEnlace(elena.mailboxId);
  const ip = nuevaIp();
  const abrir = () =>
    ctx.app.inject({ method: 'GET', url: `/api/public/setup/${token}`, remoteAddress: ip });

  const antes = (await abrir()).json() as Record<string, any>;
  assert.equal(antes.email, elena.nueva);
  assert.equal(antes.login, elena.vieja);
  assert.equal(antes.loginPending, true);
  assert.equal(antes.usadoPorApp, false);
  assert.equal(antes.connection.username, elena.vieja);
  assert.equal((JSON.parse(antes.thunderbirdAndroidQr) as unknown[][])[2]![5], elena.vieja);
  const perfil = await ctx.app.inject({
    method: 'GET',
    url: `/api/public/setup/${token}/perfil.mobileconfig`,
    remoteAddress: ip,
  });
  assert.deepEqual(usuariosDelPerfil(perfil.body), [elena.vieja, elena.vieja]);
  assert.ok(perfil.body.includes(stableUuid(`mobileconfig-perfil:${elena.vieja}`)));

  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/public/setup/${token}/login-update`,
    payload: {},
    remoteAddress: ip,
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { ok: true, login: elena.nueva });
  assert.equal(await motor().verifyCredentials(elena.nueva, elena.password), true);
  const registro = auditoria('mailbox.login_updated', elena.mailboxId);
  assert.equal(registro.length, 1);
  assert.equal(registro[0]!.client_id, clientId);
  assert.equal(registro[0]!.detail.por, 'enlace');

  // El mismo enlace enseña ya el usuario nuevo (se calcula al abrirlo).
  const despues = (await abrir()).json() as Record<string, any>;
  assert.equal(despues.login, elena.nueva);
  assert.equal(despues.loginPending, false);
  assert.equal(despues.connection.username, elena.nueva);

  // Un token inventado o revocado no actualiza nada.
  const inventado = await ctx.app.inject({
    method: 'POST',
    url: `/api/public/setup/${'x'.repeat(43)}/login-update`,
    payload: {},
    remoteAddress: nuevaIp(),
  });
  assert.equal(inventado.statusCode, 404);
  assert.equal(inventado.json().code, 'setup_link_invalid');

  // Límite público: 60 peticiones por minuto y por IP entre todas las rutas del enlace.
  const ipLimite = nuevaIp();
  let ultima = 0;
  for (let i = 0; i < 61; i++) {
    const r = await ctx.app.inject({
      method: 'POST',
      url: `/api/public/setup/${token}/login-update`,
      payload: {},
      remoteAddress: ipLimite,
    });
    ultima = r.statusCode;
    if (i < 60) assert.equal(r.statusCode, 200, `petición ${i + 1}`);
  }
  assert.equal(ultima, 429);
});

test('un buzón con el que envía una aplicación de Skyway no se actualiza desde el portal ni desde el enlace (409)', async () => {
  const tienda = buzones.tienda!;
  const cookie = await sesion(tienda.nueva, tienda.password);
  const me = (await ctx.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } })).json() as Record<
    string,
    unknown
  >;
  assert.equal(me.usadoPorApp, true);
  assert.equal(me.loginPending, true);
  const portal = await ctx.app.inject({ method: 'POST', url: '/api/portal/login-update', headers: { cookie }, payload: {} });
  assert.equal(portal.statusCode, 409);
  assert.equal(portal.json().code, 'mailbox_used_by_app');
  // Al titular no se le propone revocar las contraseñas de la aplicación (la
  // dejaría sin enviar): se le pide que lo actualice quien gestiona la web.
  assert.equal(
    portal.json().error,
    'Este buzón lo usa una aplicación para enviar (tienda). Pide a quien gestiona la web que lo actualice desde Skyway.',
  );

  const token = await crearEnlace(tienda.mailboxId);
  const abierto = await ctx.app.inject({ method: 'GET', url: `/api/public/setup/${token}`, remoteAddress: nuevaIp() });
  assert.equal(abierto.json().usadoPorApp, true);
  const enlace = await ctx.app.inject({
    method: 'POST',
    url: `/api/public/setup/${token}/login-update`,
    payload: {},
    remoteAddress: nuevaIp(),
  });
  assert.equal(enlace.statusCode, 409);
  assert.equal(enlace.json().code, 'mailbox_used_by_app');
  assert.doesNotMatch(enlace.json().error, /revoca/);
  assert.equal(filaBuzon(tienda.mailboxId).usuario_motor, tienda.vieja, 'sigue pendiente');
  assert.equal(auditoria('mailbox.login_updated', tienda.mailboxId).length, 0);
});

test('«Mi buzón» no deja crear contraseñas de aplicación con el prefijo reservado de Skyway', async () => {
  const cookie = await sesion(corriente.email, corriente.password);
  const crear = (name: string) =>
    ctx.app.inject({ method: 'POST', url: '/api/portal/app-passwords', headers: { cookie }, payload: { name } });
  for (const name of ['skyway:falsa', '  Skyway:Otra ', 'SKYWAY:tienda']) {
    const res = await crear(name);
    assert.equal(res.statusCode, 400, `${name}: ${res.body}`);
    assert.equal(res.json().code, 'app_password_name_reserved');
  }
  const activas = db
    .prepare('SELECT COUNT(*) AS c FROM app_passwords WHERE mailbox_id = ? AND revoked_at IS NULL')
    .get(corriente.mailboxId) as { c: number };
  assert.equal(activas.c, 0, 'no se ha creado ninguna');
  const me = await ctx.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } });
  assert.equal(me.json().usadoPorApp, false);

  // Solo el prefijo está reservado.
  const valida = await crear('Móvil (skyway:no)');
  assert.equal(valida.statusCode, 200, valida.body);
});

test('«Mi buzón» con un cambio de usuario a medias: responde como con el motor caído y cuenta el intento', async () => {
  const gema = buzones.gema!;
  const ip = nuevaIp();
  await conCambioAMedias(gema, async () => {
    // Exista o no la contraseña, la respuesta no dice que la dirección exista.
    for (const [tecleada, password] of [
      [gema.nueva, 'contrasena-cualquiera'],
      [gema.vieja, gema.password],
    ] as const) {
      const res = await entrar(tecleada, password, ip);
      assert.equal(res.statusCode, 503, `${tecleada}: ${res.body}`);
      assert.deepEqual(res.json(), {
        error: 'No se ha podido comprobar la contraseña en este momento. Vuelve a intentarlo en unos minutos.',
        code: 'engine_unreachable',
      });
    }
    const fallos = db
      .prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ?')
      .get(`buzon:${gema.mailboxId}`) as { c: number };
    assert.equal(fallos.c, 2, 'cada intento cuenta para el límite del buzón');
  });
  db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(`buzon:${gema.mailboxId}`);
  const resuelto = await entrar(gema.vieja, gema.password);
  assert.equal(resuelto.statusCode, 200, resuelto.body);
});

test('crearEnlaceConfiguracion: enlace sin contraseña que abre el titular', async () => {
  const fede = buzones.fede!;
  const enlace = crearEnlaceConfiguracion(fede.mailboxId, {
    ttlHours: 168,
    createdBy: null,
    baseUrl: PANEL,
  });
  const match = new RegExp(`^${PANEL}/conectar/([A-Za-z0-9_-]{43})$`).exec(enlace.url);
  assert.ok(match, enlace.url);
  assert.ok(enlace.expiresAt - Date.now() > 167 * 3600_000);
  const fila = db.prepare('SELECT mailbox_id, password_enc, expires_at FROM setup_links WHERE id = ?').get(enlace.id) as {
    mailbox_id: string;
    password_enc: string | null;
    expires_at: number;
  };
  assert.deepEqual(fila, { mailbox_id: fede.mailboxId, password_enc: null, expires_at: enlace.expiresAt });
  const abierto = await ctx.app.inject({
    method: 'GET',
    url: `/api/public/setup/${match[1]}`,
    remoteAddress: nuevaIp(),
  });
  assert.equal(abierto.statusCode, 200);
  assert.equal(abierto.json().hasPassword, false);
  assert.equal(abierto.json().login, fede.vieja);

  assert.throws(() => crearEnlaceConfiguracion('mbx_no_existe', { ttlHours: 1, createdBy: null, baseUrl: PANEL }), {
    code: 'not_found',
  });
  db.prepare("UPDATE mailboxes SET status = 'suspended' WHERE id = ?").run(fede.mailboxId);
  try {
    assert.throws(() => crearEnlaceConfiguracion(fede.mailboxId, { ttlHours: 1, createdBy: null, baseUrl: PANEL }), {
      code: 'mailbox_suspended',
    });
  } finally {
    db.prepare("UPDATE mailboxes SET status = 'active' WHERE id = ?").run(fede.mailboxId);
  }
});

/* ---------------------------------- Webmail ---------------------------------- */

test('/api/webmail/password: «user» es el usuario de la sesión de Roundcube (el del motor)', async () => {
  const fede = buzones.fede!;
  const cambio = (user: string, curpass: string, newpass: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/webmail/password',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-mailway-token': TOKEN_WEBMAIL },
      payload: new URLSearchParams({ user, curpass, newpass }).toString(),
    });
  await conTokenWebmail(async () => {
    const conLogin = await cambio(fede.vieja, fede.password, 'clave-webmail-de-fede');
    assert.equal(conLogin.statusCode, 200, conLogin.body);
    assert.equal(conLogin.body, 'ok');
    assert.equal(await motor().verifyCredentials(fede.vieja, 'clave-webmail-de-fede'), true);
    // Con la dirección nueva también (lleva al mismo buzón).
    const conNueva = await cambio(fede.nueva, 'clave-webmail-de-fede', 'otra-clave-de-fede');
    assert.equal(conNueva.statusCode, 200, conNueva.body);
    assert.equal(await motor().verifyCredentials(fede.vieja, 'otra-clave-de-fede'), true);
    fede.password = 'otra-clave-de-fede';
    const registro = (
      db.prepare("SELECT detail FROM audit_log WHERE action = 'webmail.password_changed'").all() as { detail: string }[]
    ).filter((r) => r.detail.includes(fede.nueva));
    assert.equal(registro.length, 2);
  });
});

test('/api/webmail/cuenta: 404 sin token configurado, 401 con un token erróneo y los datos del buzón', async () => {
  const ana = buzones.ana!;
  const desactivada = await conTokenWebmail(() => cuentaWebmail(ana.nueva, 'lo-que-sea'), '');
  assert.equal(desactivada.statusCode, 404, 'sin secreto compartido la ruta no existe');

  await conTokenWebmail(async () => {
    const sinToken = await cuentaWebmail(ana.nueva, null);
    assert.equal(sinToken.statusCode, 401);
    const malo = await cuentaWebmail(ana.nueva, 'secreto-equivocado');
    assert.equal(malo.statusCode, 401);
    assert.equal(malo.json().code, 'webmail_token_invalid');

    const invalido = await cuentaWebmail('a');
    assert.equal(invalido.statusCode, 400);
    const desconocido = await cuentaWebmail(`nadie@${nuevo.domain}`);
    assert.equal(desconocido.statusCode, 404);
    assert.equal(desconocido.json().code, 'not_found');

    // Pendiente: lo que se teclee (la nueva, la vieja, en mayúsculas) lleva al usuario anterior.
    for (const tecleado of [ana.nueva, ana.vieja, `  ${ana.nueva.toUpperCase()} `]) {
      const res = await cuentaWebmail(tecleado);
      assert.equal(res.statusCode, 200, `${tecleado}: ${res.body}`);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.deepEqual(res.json(), {
        login: ana.vieja,
        email: ana.nueva,
        anteriores: [],
        otrasDirecciones: [ana.vieja],
      });
    }

    // Actualizado: el usuario es la dirección nueva y la vieja es el anterior.
    const dario = buzones.dario!;
    const actualizado = await cuentaWebmail(dario.vieja);
    assert.equal(actualizado.statusCode, 200, actualizado.body);
    assert.deepEqual(actualizado.json(), {
      login: dario.nueva,
      email: dario.nueva,
      anteriores: [dario.vieja],
      otrasDirecciones: [dario.vieja],
    });

    // Preparación: el usuario sigue siendo su dirección; la del dominio nuevo es la otra.
    const enPreparacion = await cuentaWebmail(prep.pareja);
    assert.deepEqual(enPreparacion.json(), {
      login: prep.direccion,
      email: prep.direccion,
      anteriores: [],
      otrasDirecciones: [prep.pareja],
    });

    // Un buzón sin cambio de dominio.
    const sinCambio = await cuentaWebmail(corriente.email);
    assert.deepEqual(sinCambio.json(), {
      login: corriente.email,
      email: corriente.email,
      anteriores: [],
      otrasDirecciones: [],
    });
  });
  // No verifica contraseñas: no cuenta fallos.
  const fallos = db
    .prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ?')
    .get(`buzon:nadie@${nuevo.domain}`) as { c: number };
  assert.equal(fallos.c, 0);
});

test('/api/webmail/cuenta con un cambio de usuario a medias: 409 y el webmail entra con lo tecleado', async () => {
  const gema = buzones.gema!;
  await conTokenWebmail(async () => {
    await conCambioAMedias(gema, async () => {
      for (const tecleado of [gema.nueva, gema.vieja]) {
        const res = await cuentaWebmail(tecleado);
        assert.equal(res.statusCode, 409, `${tecleado}: ${res.body}`);
        assert.equal(res.json().code, 'mailbox_login_updating');
      }
    });
    const resuelto = await cuentaWebmail(gema.nueva);
    assert.equal(resuelto.statusCode, 200, resuelto.body);
    assert.equal(resuelto.json().login, gema.vieja);
  });
});

/* ----------------------------- Autoconfiguración ------------------------------ */

test('Thunderbird: con una dirección pendiente, <username> es el usuario del motor; si no, %EMAILADDRESS%', async () => {
  const ana = buzones.ana!;
  assert.equal(await thunderbird(ana.nueva), ana.vieja);
  assert.equal(await thunderbird(ana.nueva.toUpperCase()), ana.vieja);
  // La dirección vieja ES el usuario: el documento de siempre.
  assert.equal(await thunderbird(ana.vieja), '%EMAILADDRESS%');
  // Ya actualizado: quien teclee la vieja recibe el usuario nuevo.
  const dario = buzones.dario!;
  assert.equal(await thunderbird(dario.vieja), dario.nueva);
  assert.equal(await thunderbird(dario.nueva), '%EMAILADDRESS%');
  // Durante la preparación, la dirección del dominio nuevo entra con la actual.
  assert.equal(await thunderbird(prep.pareja), prep.direccion);
  // Una dirección normal, exista o no, recibe lo mismo: no se revela nada.
  assert.equal(await thunderbird(corriente.email), '%EMAILADDRESS%');
  assert.equal(await thunderbird(`nadie@${normal.domain}`), '%EMAILADDRESS%');
  assert.equal(await thunderbird(`nadie@${nuevo.domain}`), '%EMAILADDRESS%');

  // Con dirección no se cachea (el usuario cambia al actualizar los
  // dispositivos), sea la dirección que sea; sin ella, el documento del dominio sí.
  for (const email of [ana.nueva, corriente.email, `nadie@${normal.domain}`]) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
    });
    assert.equal(res.headers['cache-control'], 'no-store', email);
  }
  const porHost = await ctx.app.inject({
    method: 'GET',
    url: '/.well-known/autoconfig/mail/config-v1.1.xml',
    headers: { host: `autoconfig.${normal.domain}` },
  });
  assert.equal(porHost.statusCode, 200, porHost.body);
  assert.equal(porHost.headers['cache-control'], 'public, max-age=300');
});

test('Autodiscover: LoginName es el usuario del motor con la misma regla', async () => {
  const ana = buzones.ana!;
  assert.equal(await autodiscover(ana.nueva), ana.vieja);
  assert.equal(await autodiscover(ana.vieja), ana.vieja);
  assert.equal(await autodiscover(buzones.dario!.vieja), buzones.dario!.nueva);
  assert.equal(await autodiscover(corriente.email), corriente.email);
  assert.equal(await autodiscover(`nadie@${normal.domain}`), `nadie@${normal.domain}`);
});

test('el perfil de Apple del panel lleva el usuario del motor y la semilla del primer perfil', async () => {
  const ana = buzones.ana!;
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/mailboxes/${ana.mailboxId}/mobileconfig`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(usuariosDelPerfil(res.body), [ana.vieja, ana.vieja]);
  assert.match(res.body, new RegExp(`<key>EmailAddress</key>\\s*<string>${ana.nueva}</string>`));
  assert.ok(res.body.includes(stableUuid(`mobileconfig-perfil:${ana.vieja}`)));
  assert.ok(res.body.includes(stableUuid(`mobileconfig-cuenta:${ana.vieja}`)));
  assert.ok(!res.body.includes(stableUuid(`mobileconfig-perfil:${ana.nueva}`)));

  // Sin cambio de dominio, la semilla es la dirección (como antes).
  const normalRes = await ctx.app.inject({
    method: 'GET',
    url: `/api/mailboxes/${corriente.mailboxId}/mobileconfig`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.deepEqual(usuariosDelPerfil(normalRes.body), [corriente.email, corriente.email]);
  assert.ok(normalRes.body.includes(stableUuid(`mobileconfig-perfil:${corriente.email}`)));
});
