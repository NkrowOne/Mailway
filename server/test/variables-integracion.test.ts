import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  bloquesClaveApi,
  bloquesContrasenaAplicacion,
  getConnectionSettings,
} from '../src/modules/connection';
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
 * «Copiar variables»: la respuesta que crea una clave de API o una contraseña
 * de aplicación trae bloques listos para copiar, y solo esa respuesta.
 */

interface Bloque {
  id: string;
  label: string;
  language: string;
  filename: string;
  content: string;
}

let ctx: TestContext;
let clientId: string;
let userCookie: string;
let mailboxId: string;
let email: string;
let mailboxPassword: string;

before(async () => {
  ctx = await adminContext();
  setInstanceSettings({ mailHostname: 'mail.proveedor.test' });
  const cliente = await createClient(ctx, { withUser: true });
  clientId = cliente.clientId;
  userCookie = cliente.userCookie!;
  const { domainId } = await createDomain(ctx, clientId);
  ({ mailboxId, email, password: mailboxPassword } = await createMailbox(ctx, domainId, 'web'));
});

function porId(bloques: Bloque[]): Record<string, Bloque> {
  return Object.fromEntries(bloques.map((b) => [b.id, b]));
}

test('crear una clave de API devuelve los bloques .env, Node, Laravel y Django una sola vez', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/apikeys',
    headers: { cookie: userCookie, host: 'panel.proveedor.test' },
    payload: { name: 'Web pública', senderMailboxId: mailboxId },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['cache-control'], 'no-store');
  const { key, snippets } = res.json() as { key: string; snippets: Bloque[] };
  assert.deepEqual(snippets.map((b) => b.id), ['env', 'node', 'laravel', 'django']);
  const b = porId(snippets);

  // Mismos nombres que inyecta Skyway en modo API.
  assert.match(b.env!.content, new RegExp(`^MAILWAY_API_KEY=${key}$`, 'm'));
  assert.match(b.env!.content, /^MAILWAY_API_URL=http:\/\/panel\.proveedor\.test$/m);
  assert.match(b.env!.content, new RegExp(`^MAIL_FROM=${email.replace('.', '\\.')}$`, 'm'));
  assert.match(b.env!.content, /^# Clave de API «Web pública»/);

  // El código lee la clave del entorno: el secreto solo va en los .env.
  assert.ok(!b.node!.content.includes(key));
  assert.match(b.node!.content, /\/v1\/send/);
  assert.match(b.node!.content, /Idempotency-Key/);
  assert.ok(b.laravel!.content.includes(`MAILWAY_API_KEY=${key}`));
  assert.match(b.laravel!.content, /Http::withToken/);
  assert.ok(!b.django!.content.includes(key));
  assert.match(b.django!.content, /os\.environ\["MAILWAY_API_KEY"\]/);

  // Después ya no existen: ni la clave ni los bloques vuelven a salir.
  const lista = await ctx.app.inject({ method: 'GET', url: '/api/apikeys', headers: { cookie: userCookie } });
  assert.equal(lista.statusCode, 200);
  assert.ok(!lista.body.includes(key));
  assert.ok(!lista.body.includes('snippets'));
});

test('crear una contraseña de aplicación en el panel devuelve los bloques SMTP', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${mailboxId}/app-passwords`,
    headers: { cookie: userCookie },
    payload: { name: 'Tienda online' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['cache-control'], 'no-store');
  const { password, snippets } = res.json() as { password: string; snippets: Bloque[] };
  const b = porId(snippets);

  // Mismos nombres y puerto que inyecta Skyway en modo SMTP.
  for (const linea of [
    'SMTP_HOST=mail.proveedor.test',
    'SMTP_PORT=587',
    'SMTP_SECURE=false',
    `SMTP_USER=${email}`,
    `SMTP_PASS=${password}`,
    `SMTP_FROM=${email}`,
  ]) {
    assert.ok(b.env!.content.split('\n').includes(linea), `falta «${linea}» en el .env`);
  }
  assert.match(b.node!.content, /nodemailer\.createTransport/);
  assert.ok(!b.node!.content.includes(password));
  assert.ok(b.laravel!.content.split('\n').includes(`MAIL_PASSWORD=${password}`));
  assert.ok(b.laravel!.content.split('\n').includes('MAIL_HOST=mail.proveedor.test'));
  assert.match(b.django!.content, /EMAIL_HOST_PASSWORD = os\.environ\["SMTP_PASS"\]/);
  assert.ok(!b.django!.content.includes(password));

  const lista = await ctx.app.inject({
    method: 'GET',
    url: `/api/mailboxes/${mailboxId}/app-passwords`,
    headers: { cookie: userCookie },
  });
  assert.ok(!lista.body.includes(password));
  assert.ok(!lista.body.includes('snippets'));
});

test('crear una contraseña de aplicación en «Mi buzón» devuelve los bloques SMTP', async () => {
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/login',
    payload: { email, password: mailboxPassword },
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = cookieFrom(login);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/app-passwords',
    headers: { cookie },
    payload: { name: 'Blog' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const { password, snippets } = res.json() as { password: string; snippets: Bloque[] };
  assert.deepEqual(snippets.map((b) => b.id), ['env', 'node', 'laravel', 'django']);
  assert.ok(porId(snippets).env!.content.includes(`SMTP_PASS=${password}`));

  const lista = await ctx.app.inject({ method: 'GET', url: '/api/portal/app-passwords', headers: { cookie } });
  assert.ok(!lista.body.includes(password));
});

test('otro cliente no obtiene bloques de un buzón ajeno', async () => {
  const otro = await createClient(ctx, { withUser: true });
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${mailboxId}/app-passwords`,
    headers: { cookie: otro.userCookie! },
    payload: { name: 'Intruso' },
  });
  assert.equal(res.statusCode, 403);
  assert.ok(!res.body.includes('snippets'));
  const clave = await ctx.app.inject({
    method: 'POST',
    url: '/api/apikeys',
    headers: { cookie: otro.userCookie! },
    payload: { name: 'Intrusa', senderMailboxId: mailboxId },
  });
  assert.equal(clave.statusCode, 400, clave.body);
  assert.ok(!clave.body.includes('snippets'));
});

test('los bloques no dejan que un nombre rompa una línea ni el formato del .env', () => {
  const api = porId(
    bloquesClaveApi({
      apiUrl: 'https://panel.ejemplo.com',
      key: 'mw_abcd1234_secreto',
      from: 'noreply@ejemplo.com',
      name: 'Prueba\nMAILWAY_API_KEY=robada',
    }),
  );
  const lineas = api.env!.content.split('\n');
  assert.equal(lineas.filter((l) => l.startsWith('MAILWAY_API_KEY=')).length, 1);
  assert.ok(lineas.includes('MAILWAY_API_KEY=mw_abcd1234_secreto'));

  const smtp = porId(
    bloquesContrasenaAplicacion({
      email: 'ana@ejemplo.com',
      password: 'abcd efgh"ijkl',
      name: 'Móvil\r\n# otro',
      settings: getConnectionSettings('ejemplo.com', null),
    }),
  );
  // Un valor con espacios o comillas va entre comillas dobles escapadas.
  assert.ok(smtp.env!.content.split('\n').includes('SMTP_PASS="abcd efgh\\"ijkl"'));
  assert.equal(smtp.env!.content.split('\n').filter((l) => l.startsWith('#')).length, 2);
});
