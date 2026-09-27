import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { getEngine } from '../src/engine';
import { MAX_ACTIVE_APP_PASSWORDS } from '../src/modules/apppasswords';
import {
  adminContext,
  cookieFrom,
  createClient,
  createDomain,
  createMailbox,
  type TestContext,
} from './helpers';

/*
 * Portal del titular: enlaces de configuración, «Mi buzón» y cambio de
 * contraseña desde el webmail. El motor de demostración guarda los hashes de
 * verdad, así que una contraseña equivocada se rechaza como en producción.
 */

let ctx: TestContext;
let ipSeq = 0;
/** IP distinta por prueba: el límite por IP no debe mezclar unas con otras. */
function nuevaIp(): string {
  ipSeq += 1;
  return `10.20.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

before(async () => {
  ctx = await adminContext();
});

async function buzonDePrueba(opts: { withUser?: boolean } = {}) {
  const client = await createClient(ctx, { withUser: opts.withUser });
  const { domainId } = await createDomain(ctx, client.clientId);
  const mailbox = await createMailbox(ctx, domainId);
  return { ...client, ...mailbox, domainId };
}

function tokenDe(url: string): string {
  const match = /\/conectar\/([A-Za-z0-9_-]+)$/.exec(url);
  assert.ok(match, `la URL debe acabar en /conectar/<token>: ${url}`);
  return match[1]!;
}

async function crearEnlace(
  mailboxId: string,
  payload: Record<string, unknown> = {},
  cookie = ctx.adminCookie,
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${mailboxId}/setup-links`,
    headers: { cookie },
    payload,
  });
}

async function login(email: string, password: string, ip = nuevaIp()) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/portal/login',
    payload: { email, password },
    remoteAddress: ip,
  });
}

async function sesionPortal(email: string, password: string): Promise<string> {
  const res = await login(email, password);
  assert.equal(res.statusCode, 200, res.body);
  return cookieFrom(res);
}

function auditoria(action: string): { user_id: string | null; client_id: string | null; detail: string }[] {
  return db
    .prepare('SELECT user_id, client_id, detail FROM audit_log WHERE action = ? ORDER BY id')
    .all(action) as { user_id: string | null; client_id: string | null; detail: string }[];
}

/* ------------------------- Enlaces de configuración ------------------------ */

test('enlace sin contraseña: la página pública da los datos, pero nunca la contraseña', async () => {
  const b = await buzonDePrueba();
  const res = await crearEnlace(b.mailboxId);
  assert.equal(res.statusCode, 200, res.body);
  const { link } = res.json() as { link: { id: string; url: string; expiresAt: number; hasPassword: boolean } };
  assert.equal(link.hasPassword, false);
  assert.match(link.url, /^http:\/\/[^/]+\/conectar\//);
  // Validez por defecto: 72 horas.
  assert.ok(Math.abs(link.expiresAt - (Date.now() + 72 * 3600_000)) < 60_000);
  const token = tokenDe(link.url);
  // En la base solo queda el hash del token.
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS c FROM setup_links WHERE token_hash = ?').get(token) as { c: number }).c,
    0,
  );

  const pub = await ctx.app.inject({ method: 'GET', url: `/api/public/setup/${token}` });
  assert.equal(pub.statusCode, 200, pub.body);
  assert.equal(pub.headers['cache-control'], 'no-store');
  const body = pub.json() as Record<string, any>;
  assert.equal(body.email, b.email);
  assert.equal(body.password, undefined);
  assert.equal(body.hasPassword, false);
  assert.equal(body.connection.username, b.email);
  assert.equal(body.connection.imap.port, 993);
  assert.equal(body.connection.smtp.port, 465);
  assert.equal(body.connection.smtpAlt.port, 587);
  assert.match(body.appleProfileUrl, new RegExp(`/api/public/setup/${token}/perfil\\.mobileconfig$`));
  assert.match(body.portalUrl, /\/mi-buzon$/);
  assert.ok(Array.isArray(JSON.parse(body.thunderbirdAndroidQr)));

  const perfil = await ctx.app.inject({ method: 'GET', url: body.appleProfileUrl.replace(/^https?:\/\/[^/]+/, '') });
  assert.equal(perfil.statusCode, 200);
  assert.match(String(perfil.headers['content-type']), /^application\/x-apple-aspen-config/);
  assert.match(String(perfil.headers['content-disposition']), /^attachment; filename="correo-.*\.mobileconfig"$/);
  assert.ok(perfil.body.includes(b.email));
  assert.ok(!perfil.body.includes('<key>IncomingPassword</key>'));
  assert.ok(!perfil.body.includes(b.password));

  const lista = await ctx.app.inject({
    method: 'GET',
    url: `/api/mailboxes/${b.mailboxId}/setup-links`,
    headers: { cookie: ctx.adminCookie },
  });
  const { links } = lista.json() as { links: { id: string; lastOpenedAt: number | null; hasPassword: boolean }[] };
  assert.equal(links.length, 1);
  assert.equal(links[0]!.id, link.id);
  assert.ok(links[0]!.lastOpenedAt, 'abrir el enlace debe quedar anotado');
  assert.ok(auditoria('mailbox.setup_link_created').some((a) => a.detail.includes(link.id)));
});

test('enlace con contraseña: se entrega en la página y en el perfil hasta marcarlo como configurado', async () => {
  const b = await buzonDePrueba();

  const sinContrasena = await crearEnlace(b.mailboxId, { includePassword: true });
  assert.equal(sinContrasena.statusCode, 400);
  assert.equal(sinContrasena.json().code, 'password_required');

  const equivocada = await crearEnlace(b.mailboxId, { includePassword: true, password: 'no-es-la-buena' });
  assert.equal(equivocada.statusCode, 400);
  assert.equal(equivocada.json().code, 'password_mismatch');

  const res = await crearEnlace(b.mailboxId, { includePassword: true, password: b.password, ttlHours: 24 });
  assert.equal(res.statusCode, 200, res.body);
  const { link } = res.json() as { link: { id: string; url: string; expiresAt: number; hasPassword: boolean } };
  assert.equal(link.hasPassword, true);
  assert.ok(Math.abs(link.expiresAt - (Date.now() + 24 * 3600_000)) < 60_000);
  const token = tokenDe(link.url);
  // Guardada cifrada, nunca en claro.
  const fila = db.prepare('SELECT password_enc FROM setup_links WHERE id = ?').get(link.id) as { password_enc: string };
  assert.ok(fila.password_enc.startsWith('v1:'));
  assert.ok(!fila.password_enc.includes(b.password));

  const pub = await ctx.app.inject({ method: 'GET', url: `/api/public/setup/${token}` });
  assert.equal(pub.json().password, b.password);
  assert.equal(pub.json().hasPassword, true);

  const perfil = await ctx.app.inject({ method: 'GET', url: `/api/public/setup/${token}/perfil.mobileconfig` });
  assert.ok(perfil.body.includes('<key>IncomingPassword</key>'));
  assert.ok(perfil.body.includes(`<string>${b.password}</string>`));

  const hecho = await ctx.app.inject({ method: 'POST', url: `/api/public/setup/${token}/done` });
  assert.equal(hecho.statusCode, 200, hecho.body);
  assert.equal(
    (db.prepare('SELECT password_enc FROM setup_links WHERE id = ?').get(link.id) as { password_enc: string | null }).password_enc,
    null,
  );

  // El enlace sigue sirviendo de guía, ya sin contraseña.
  const despues = await ctx.app.inject({ method: 'GET', url: `/api/public/setup/${token}` });
  assert.equal(despues.statusCode, 200);
  assert.equal(despues.json().password, undefined);
  const perfilDespues = await ctx.app.inject({ method: 'GET', url: `/api/public/setup/${token}/perfil.mobileconfig` });
  assert.ok(!perfilDespues.body.includes('<key>IncomingPassword</key>'));

  const lista = await ctx.app.inject({
    method: 'GET',
    url: `/api/mailboxes/${b.mailboxId}/setup-links`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal((lista.json() as { links: { hasPassword: boolean }[] }).links[0]!.hasPassword, false);
});

test('incluir la contraseña no sirve de oráculo: 5 fallos por buzón bloquean 15 minutos', async () => {
  const b = await buzonDePrueba();
  for (let i = 0; i < 5; i += 1) {
    const mala = await crearEnlace(b.mailboxId, { includePassword: true, password: `no-es-la-buena-${i}` });
    assert.equal(mala.statusCode, 400, mala.body);
    assert.equal(mala.json().code, 'password_mismatch');
  }
  // Bloqueado incluso con la contraseña correcta: así no se distingue nada.
  const bloqueado = await crearEnlace(b.mailboxId, { includePassword: true, password: b.password });
  assert.equal(bloqueado.statusCode, 429, bloqueado.body);
  assert.equal(bloqueado.json().code, 'rate_limited');
  assert.match(bloqueado.json().error, /cree el enlace sin la contraseña/);

  // El enlace sin contraseña sigue disponible y otro buzón no se ve afectado.
  assert.equal((await crearEnlace(b.mailboxId)).statusCode, 200);
  const otro = await buzonDePrueba();
  const bueno = await crearEnlace(otro.mailboxId, { includePassword: true, password: otro.password });
  assert.equal(bueno.statusCode, 200, bueno.body);

  // Iniciar sesión en el panel no acorta la ventana de 15 minutos del portal.
  const hace12min = Date.now() - 12 * 60_000;
  db.prepare('UPDATE login_attempts SET attempted_at = ? WHERE ip = ?').run(hace12min, `buzon-enlace:${b.mailboxId}`);
  const panel = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'nadie@mailway.test', password: 'contraseña-cualquiera' },
    remoteAddress: nuevaIp(),
  });
  assert.equal(panel.statusCode, 401);
  const quedan = db
    .prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ?')
    .get(`buzon-enlace:${b.mailboxId}`) as { c: number };
  assert.equal(quedan.c, 5, 'los fallos del portal siguen contando');
  assert.equal((await crearEnlace(b.mailboxId, { includePassword: true, password: b.password })).statusCode, 429);
});

test('sin respuesta del motor, la contraseña no se guarda en el enlace (503)', async () => {
  const b = await buzonDePrueba();
  const engine = getEngine();
  const original = engine.verifyCredentials.bind(engine);
  engine.verifyCredentials = async () => null;
  try {
    const res = await crearEnlace(b.mailboxId, { includePassword: true, password: b.password });
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json().code, 'engine_unreachable');
  } finally {
    engine.verifyCredentials = original;
  }
  const enlaces = db.prepare('SELECT COUNT(*) AS c FROM setup_links WHERE mailbox_id = ?').get(b.mailboxId) as {
    c: number;
  };
  assert.equal(enlaces.c, 0, 'no se crea ningún enlace');
});

test('el enlace no admite una contraseña de aplicación en lugar de la principal', async () => {
  const b = await buzonDePrueba();
  const app = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${b.mailboxId}/app-passwords`,
    headers: { cookie: ctx.adminCookie },
    payload: { name: 'Móvil' },
  });
  assert.equal(app.statusCode, 200, app.body);
  const res = await crearEnlace(b.mailboxId, { includePassword: true, password: app.json().password });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'app_password_not_allowed');
});

test('un enlace caducado da 404 y su contraseña se borra aunque nadie lo abra', async () => {
  const b = await buzonDePrueba();
  const res = await crearEnlace(b.mailboxId, { includePassword: true, password: b.password });
  const { link } = res.json() as { link: { id: string; url: string } };
  db.prepare('UPDATE setup_links SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, link.id);

  // Cualquier uso de los enlaces purga los caducados, no solo abrir este.
  await ctx.app.inject({
    method: 'GET',
    url: `/api/mailboxes/${b.mailboxId}/setup-links`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(
    (db.prepare('SELECT password_enc FROM setup_links WHERE id = ?').get(link.id) as { password_enc: string | null }).password_enc,
    null,
  );

  const token = tokenDe(link.url);
  const pub = await ctx.app.inject({ method: 'GET', url: `/api/public/setup/${token}` });
  assert.equal(pub.statusCode, 404);
  assert.equal(pub.json().code, 'setup_link_invalid');
  assert.match(pub.json().error, /no es válido o ha caducado/);
  const perfil = await ctx.app.inject({ method: 'GET', url: `/api/public/setup/${token}/perfil.mobileconfig` });
  assert.equal(perfil.statusCode, 404);
});

test('un enlace revocado da 404 y pierde la contraseña; un token inventado también da 404', async () => {
  const b = await buzonDePrueba();
  const res = await crearEnlace(b.mailboxId, { includePassword: true, password: b.password });
  const { link } = res.json() as { link: { id: string; url: string } };

  const revocar = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/mailboxes/${b.mailboxId}/setup-links/${link.id}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(revocar.statusCode, 200, revocar.body);
  const fila = db.prepare('SELECT password_enc, revoked_at FROM setup_links WHERE id = ?').get(link.id) as {
    password_enc: string | null;
    revoked_at: number | null;
  };
  assert.equal(fila.password_enc, null);
  assert.ok(fila.revoked_at);
  assert.ok(auditoria('mailbox.setup_link_revoked').some((a) => a.detail.includes(link.id)));

  const pub = await ctx.app.inject({ method: 'GET', url: `/api/public/setup/${tokenDe(link.url)}` });
  assert.equal(pub.statusCode, 404);
  const hecho = await ctx.app.inject({ method: 'POST', url: `/api/public/setup/${tokenDe(link.url)}/done` });
  assert.equal(hecho.statusCode, 404);

  const inventado = await ctx.app.inject({ method: 'GET', url: `/api/public/setup/${'x'.repeat(43)}` });
  assert.equal(inventado.statusCode, 404);
  const corto = await ctx.app.inject({ method: 'GET', url: '/api/public/setup/abc' });
  assert.equal(corto.statusCode, 404);

  // Revocar un enlace de otro buzón no es posible aunque se conozca su id.
  const otro = await buzonDePrueba();
  const ajeno = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/mailboxes/${otro.mailboxId}/setup-links/${link.id}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(ajeno.statusCode, 404);
});

test('solo quien gestiona el cliente del buzón crea o ve sus enlaces', async () => {
  const propio = await buzonDePrueba({ withUser: true });
  const ajeno = await createClient(ctx, { withUser: true });

  const anonimo = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${propio.mailboxId}/setup-links`,
    payload: {},
  });
  assert.equal(anonimo.statusCode, 401);

  const deOtroCliente = await crearEnlace(propio.mailboxId, {}, ajeno.userCookie!);
  assert.equal(deOtroCliente.statusCode, 403);
  const listaAjena = await ctx.app.inject({
    method: 'GET',
    url: `/api/mailboxes/${propio.mailboxId}/setup-links`,
    headers: { cookie: ajeno.userCookie! },
  });
  assert.equal(listaAjena.statusCode, 403);

  const delCliente = await crearEnlace(propio.mailboxId, { ttlHours: 1 }, propio.userCookie!);
  assert.equal(delCliente.statusCode, 200, delCliente.body);

  const fueraDeRango = await crearEnlace(propio.mailboxId, { ttlHours: 721 });
  assert.equal(fueraDeRango.statusCode, 400);
  const cero = await crearEnlace(propio.mailboxId, { ttlHours: 0 });
  assert.equal(cero.statusCode, 400);
});

/* -------------------------------- Mi buzón --------------------------------- */

test('«Mi buzón»: entrar, consultar los datos y salir', async () => {
  const b = await buzonDePrueba();

  const mal = await login(b.email, 'contraseña-equivocada');
  assert.equal(mal.statusCode, 401);
  assert.equal(mal.json().code, 'bad_credentials');
  const inexistente = await login(`nadie@${b.email.split('@')[1]}`, 'lo-que-sea-123');
  assert.equal(inexistente.statusCode, 401);
  assert.equal(inexistente.json().error, mal.json().error, 'no debe revelar qué direcciones existen');

  const sinSesion = await ctx.app.inject({ method: 'GET', url: '/api/portal/me' });
  assert.equal(sinSesion.statusCode, 401);

  const ok = await login(b.email.toUpperCase(), b.password);
  assert.equal(ok.statusCode, 200, ok.body);
  const setCookie = String(ok.headers['set-cookie']);
  assert.match(setCookie, /^mailway_buzon=/);
  assert.match(setCookie, /Path=\/api\/portal/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = cookieFrom(ok);
  // Solo el hash del token llega a la base.
  const token = cookie.split('=')[1]!;
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS c FROM mailbox_sessions WHERE token_hash = ?').get(token) as { c: number }).c,
    0,
  );

  const me = await ctx.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } });
  assert.equal(me.statusCode, 200, me.body);
  const datos = me.json() as Record<string, any>;
  assert.equal(datos.email, b.email);
  assert.equal(datos.domain, b.email.split('@')[1]);
  assert.equal(typeof datos.quotaMb, 'number');
  assert.equal(datos.usedBytes, 0);
  assert.equal(datos.connection.username, b.email);
  assert.match(datos.appleProfileUrl, /\/api\/portal\/mobileconfig$/);
  assert.equal(typeof datos.brandName, 'string');

  const perfil = await ctx.app.inject({ method: 'GET', url: '/api/portal/mobileconfig', headers: { cookie } });
  assert.equal(perfil.statusCode, 200);
  assert.match(String(perfil.headers['content-type']), /^application\/x-apple-aspen-config/);
  assert.ok(!perfil.body.includes('<key>IncomingPassword</key>'));

  const entradas = auditoria('portal.login').filter((a) => a.detail.includes(b.email));
  assert.equal(entradas.length, 1);
  assert.equal(entradas[0]!.user_id, null);
  assert.equal(entradas[0]!.client_id, b.clientId);

  const salir = await ctx.app.inject({ method: 'POST', url: '/api/portal/logout', headers: { cookie } });
  assert.equal(salir.statusCode, 200);
  const despues = await ctx.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } });
  assert.equal(despues.statusCode, 401);
});

test('un buzón suspendido (o de un cliente suspendido) no entra y pierde las sesiones abiertas', async () => {
  const b = await buzonDePrueba();
  const cookie = await sesionPortal(b.email, b.password);

  db.prepare("UPDATE mailboxes SET status = 'suspended' WHERE id = ?").run(b.mailboxId);
  await getEngine().updateMailbox(b.email, { suspended: true });
  const me = await ctx.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } });
  assert.equal(me.statusCode, 403);
  assert.equal(me.json().code, 'mailbox_suspended');
  const res = await login(b.email, b.password);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, 'mailbox_suspended');
  const enlace = await crearEnlace(b.mailboxId);
  assert.equal(enlace.statusCode, 400);

  const c = await buzonDePrueba();
  db.prepare('UPDATE clients SET suspended = 1 WHERE id = ?').run(c.clientId);
  const delCliente = await login(c.email, c.password);
  assert.equal(delCliente.statusCode, 403);
  assert.equal(delCliente.json().code, 'mailbox_suspended');
});

test('límite de intentos: 5 fallos por buzón bloquean también la contraseña correcta', async () => {
  const b = await buzonDePrueba();
  for (let i = 0; i < 5; i++) {
    // Cada intento desde una IP distinta: el límite por buzón no depende de ella.
    const res = await login(b.email, `equivocada-${i}`);
    assert.equal(res.statusCode, 401);
  }
  const bloqueado = await login(b.email, b.password);
  assert.equal(bloqueado.statusCode, 429);
  assert.equal(bloqueado.json().code, 'rate_limited');

  // Límite por IP: 20 fallos desde la misma IP contra buzones distintos.
  const ip = nuevaIp();
  for (let i = 0; i < 20; i++) {
    await login(`nadie${i}@ejemplo-inexistente.test`, 'equivocada-123', ip);
  }
  const otro = await buzonDePrueba();
  const porIp = await login(otro.email, otro.password, ip);
  assert.equal(porIp.statusCode, 429);
  const otraIp = await login(otro.email, otro.password);
  assert.equal(otraIp.statusCode, 200);
});

test('cambiar la contraseña conserva las contraseñas de aplicación y cierra las demás sesiones', async () => {
  const b = await buzonDePrueba();
  const cookie = await sesionPortal(b.email, b.password);
  const otraSesion = await sesionPortal(b.email, b.password);

  // Contraseña de aplicación creada desde el portal.
  const creada = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/app-passwords',
    headers: { cookie },
    payload: { name: 'Móvil de trabajo' },
  });
  assert.equal(creada.statusCode, 200, creada.body);
  const { appPassword, password: appPass } = creada.json() as {
    appPassword: { id: string; name: string };
    password: string;
  };
  assert.equal(appPassword.name, 'Móvil de trabajo');
  assert.equal(await getEngine().verifyCredentials(b.email, appPass), true);

  // Con una contraseña de aplicación no se gestiona la cuenta.
  const conApp = await login(b.email, appPass);
  assert.equal(conApp.statusCode, 400);
  assert.equal(conApp.json().code, 'app_password_not_allowed');
  const cambioConApp = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/password',
    headers: { cookie },
    payload: { current: appPass, next: 'otra-clave-larga-123' },
  });
  assert.equal(cambioConApp.statusCode, 400);
  assert.equal(cambioConApp.json().code, 'app_password_not_allowed');

  // Un enlace con la contraseña antigua deja de llevarla tras el cambio.
  const enlace = await crearEnlace(b.mailboxId, { includePassword: true, password: b.password });
  const linkId = (enlace.json() as { link: { id: string } }).link.id;

  const actualMal = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/password',
    headers: { cookie },
    payload: { current: 'no-es-esta-clave', next: 'nueva-clave-segura-1' },
  });
  assert.equal(actualMal.statusCode, 400);
  assert.equal(actualMal.json().code, 'bad_current_password');
  const igual = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/password',
    headers: { cookie },
    payload: { current: b.password, next: b.password },
  });
  assert.equal(igual.statusCode, 400);
  const corta = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/password',
    headers: { cookie },
    payload: { current: b.password, next: 'corta' },
  });
  assert.equal(corta.statusCode, 400);

  const nueva = 'nueva-clave-segura-1';
  const cambio = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/password',
    headers: { cookie },
    payload: { current: b.password, next: nueva },
  });
  assert.equal(cambio.statusCode, 200, cambio.body);

  const engine = getEngine();
  assert.equal(await engine.verifyCredentials(b.email, nueva), true);
  assert.equal(await engine.verifyCredentials(b.email, b.password), false);
  assert.equal(await engine.verifyCredentials(b.email, appPass), true, 'la contraseña de aplicación debe seguir valiendo');

  const actual = await ctx.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } });
  assert.equal(actual.statusCode, 200, 'la sesión que hizo el cambio sigue abierta');
  const cerrada = await ctx.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie: otraSesion } });
  assert.equal(cerrada.statusCode, 401, 'las demás sesiones se cierran');
  assert.equal(
    (db.prepare('SELECT password_enc FROM setup_links WHERE id = ?').get(linkId) as { password_enc: string | null }).password_enc,
    null,
  );
  const registro = auditoria('portal.password_changed').filter((a) => a.detail.includes(b.email));
  assert.equal(registro.length, 1);
  assert.equal(registro[0]!.client_id, b.clientId);
});

test('contraseñas de aplicación desde el portal: listar, crear y revocar', async () => {
  const b = await buzonDePrueba();
  const cookie = await sesionPortal(b.email, b.password);

  const vacia = await ctx.app.inject({ method: 'GET', url: '/api/portal/app-passwords', headers: { cookie } });
  assert.equal(vacia.statusCode, 200);
  assert.deepEqual(vacia.json(), { appPasswords: [] });

  const sinNombre = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/app-passwords',
    headers: { cookie },
    payload: { name: '   ' },
  });
  assert.equal(sinNombre.statusCode, 400);

  const movil = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/app-passwords',
    headers: { cookie },
    payload: { name: 'Móvil' },
  });
  const portatil = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/app-passwords',
    headers: { cookie },
    payload: { name: 'Portátil' },
  });
  const passMovil = movil.json().password as string;
  const passPortatil = portatil.json().password as string;
  const idMovil = movil.json().appPassword.id as string;

  const lista = await ctx.app.inject({ method: 'GET', url: '/api/portal/app-passwords', headers: { cookie } });
  const apps = (lista.json() as { appPasswords: { id: string; email: string; revokedAt: number | null }[] }).appPasswords;
  assert.equal(apps.length, 2);
  assert.ok(apps.every((a) => a.email === b.email));
  assert.ok(!lista.body.includes(passMovil), 'la contraseña no se vuelve a mostrar');

  const revocar = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/portal/app-passwords/${idMovil}`,
    headers: { cookie },
  });
  assert.equal(revocar.statusCode, 200, revocar.body);
  const engine = getEngine();
  assert.equal(await engine.verifyCredentials(b.email, passMovil), false);
  assert.equal(await engine.verifyCredentials(b.email, passPortatil), true);
  assert.equal(await engine.verifyCredentials(b.email, b.password), true);

  // No se puede revocar la de otro buzón desde esta sesión.
  const otro = await buzonDePrueba();
  const otraCookie = await sesionPortal(otro.email, otro.password);
  const ajena = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/portal/app-passwords/${apps.find((a) => a.id !== idMovil)!.id}`,
    headers: { cookie: otraCookie },
  });
  assert.equal(ajena.statusCode, 404);

  const sinSesion = await ctx.app.inject({ method: 'GET', url: '/api/portal/app-passwords' });
  assert.equal(sinSesion.statusCode, 401);
});

test('el máximo de contraseñas de aplicación es el mismo en el portal y en el panel (409)', async () => {
  const b = await buzonDePrueba();
  const cookie = await sesionPortal(b.email, b.password);
  const insertar = db.prepare(
    `INSERT INTO app_passwords (id, mailbox_id, name, stored_secret, created_by, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  );
  for (let i = 0; i < MAX_ACTIVE_APP_PASSWORDS; i += 1) {
    insertar.run(`app_limite_${b.mailboxId}_${i}`, b.mailboxId, `Equipo ${i}`, '$app$x$y', Date.now());
  }
  const portal = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/app-passwords',
    headers: { cookie },
    payload: { name: 'Uno más' },
  });
  assert.equal(portal.statusCode, 409, portal.body);
  assert.equal(portal.json().code, 'app_password_limit');
  const panel = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${b.mailboxId}/app-passwords`,
    headers: { cookie: ctx.adminCookie },
    payload: { name: 'Uno más' },
  });
  assert.equal(panel.statusCode, 409, panel.body);
  assert.equal(panel.json().code, 'app_password_limit');
  assert.equal(panel.json().error, portal.json().error);
});

/* ------------------------------ Webmail ------------------------------------ */

function formulario(campos: Record<string, string>): string {
  return new URLSearchParams(campos).toString();
}

async function cambioWebmail(campos: Record<string, string>, token?: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/webmail/password',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(token !== undefined ? { 'x-mailway-token': token } : {}),
    },
    payload: formulario(campos),
  });
}

test('cambio de contraseña desde el webmail (complemento password de Roundcube)', async () => {
  const b = await buzonDePrueba();
  const anterior = config.webmailToken;
  try {
    config.webmailToken = '';
    const desactivada = await cambioWebmail(
      { user: b.email, curpass: b.password, newpass: 'nueva-desde-webmail' },
      'lo-que-sea',
    );
    assert.equal(desactivada.statusCode, 404, 'sin secreto compartido la ruta no existe');

    config.webmailToken = 'secreto-compartido-webmail-pruebas';
    const sinToken = await cambioWebmail({ user: b.email, curpass: b.password, newpass: 'nueva-desde-webmail' });
    assert.equal(sinToken.statusCode, 401);
    const tokenMalo = await cambioWebmail(
      { user: b.email, curpass: b.password, newpass: 'nueva-desde-webmail' },
      'secreto-equivocado',
    );
    assert.equal(tokenMalo.statusCode, 401);

    const token = config.webmailToken;
    const actualMal = await cambioWebmail({ user: b.email, curpass: 'no-es-esta', newpass: 'nueva-desde-webmail' }, token);
    assert.equal(actualMal.statusCode, 403);
    assert.equal(actualMal.body, 'error');
    const corta = await cambioWebmail({ user: b.email, curpass: b.password, newpass: 'corta' }, token);
    assert.equal(corta.statusCode, 400);
    const incompleta = await cambioWebmail({ user: b.email, curpass: b.password }, token);
    assert.equal(incompleta.statusCode, 400);
    const desconocido = await cambioWebmail(
      { user: 'nadie@ejemplo-inexistente.test', curpass: 'algo-largo-1', newpass: 'nueva-desde-webmail' },
      token,
    );
    assert.equal(desconocido.statusCode, 403);

    const ok = await cambioWebmail({ user: b.email, curpass: b.password, newpass: 'nueva-desde-webmail' }, token);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.body, 'ok');
    assert.match(String(ok.headers['content-type']), /^text\/plain/);
    assert.equal(await getEngine().verifyCredentials(b.email, 'nueva-desde-webmail'), true);
    assert.equal(await getEngine().verifyCredentials(b.email, b.password), false);

    const registro = auditoria('webmail.password_changed').filter((a) => a.detail.includes(b.email));
    assert.equal(registro.length, 1);
    assert.equal(registro[0]!.user_id, null);
    assert.deepEqual(JSON.parse(registro[0]!.detail), { email: b.email });

    // Límite por buzón: tras 5 fallos (1 antes + 4 ahora) se bloquea.
    for (let i = 0; i < 4; i++) {
      await cambioWebmail({ user: b.email, curpass: `mal-${i}-xxxx`, newpass: 'otra-mas-larga-1' }, token);
    }
    const bloqueado = await cambioWebmail(
      { user: b.email, curpass: 'nueva-desde-webmail', newpass: 'otra-mas-larga-1' },
      token,
    );
    assert.equal(bloqueado.statusCode, 429);
  } finally {
    config.webmailToken = anterior;
  }
});

test('el analizador de formularios no se extiende al resto de la API', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: formulario({ email: 'a@b.test', password: 'x' }),
  });
  assert.equal(res.statusCode, 415);
});
