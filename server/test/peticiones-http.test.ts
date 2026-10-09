import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { adminContext, cookieFrom, type TestContext } from './helpers';

/*
 * Contrato HTTP del panel que depende de Fastify y de @fastify/cookie: las
 * cookies de sesión, qué cuerpos se aceptan y cómo se enrutan las URL. Fija
 * lo que la migración a Fastify 5 podía cambiar sin que lo notara ninguna
 * otra prueba.
 */

const ADMIN = { email: 'admin@mailway.test', password: 'clave-admin-segura' };

let ctx: TestContext;

before(async () => {
  ctx = await adminContext();
});

function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
}

/* --------------------------------- Cookies --------------------------------- */

test('la cookie de sesión: HttpOnly, SameSite=Lax, ruta raíz, caducidad y Secure en producción', async () => {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
  assert.equal(res.statusCode, 200, res.body);
  const [cookie, ...resto] = setCookies(res);
  assert.equal(resto.length, 0);
  assert.match(cookie!, /^mailway_session=[A-Za-z0-9_-]+;/);
  assert.match(cookie!, /; Path=\/(;|$)/);
  assert.match(cookie!, /; HttpOnly(;|$)/);
  assert.match(cookie!, /; SameSite=Lax(;|$)/);
  assert.match(cookie!, new RegExp(`; Max-Age=${config.sessionTtlHours * 3600}(;|$)`));
  assert.equal(/; Secure(;|$)/.test(cookie!), config.isProduction);
});

test('cerrar sesión borra la cookie en la misma ruta y la sesión deja de valer', async () => {
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
  const cookie = cookieFrom(login);
  const salida = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
  assert.equal(salida.statusCode, 200);
  const [borrado] = setCookies(salida);
  assert.match(borrado!, /^mailway_session=;/);
  assert.match(borrado!, /; Path=\/(;|$)/);
  // Caducada: Max-Age=0 o una fecha de 1970 (cualquiera de las dos la borra).
  assert.ok(/; Max-Age=0(;|$)/.test(borrado!) || /Expires=Thu, 01 Jan 1970/.test(borrado!), borrado);

  const despues = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  assert.deepEqual(despues.json(), { user: null });
});

test('la cookie de sesión se lee entre otras cookies del mismo sitio', async () => {
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
  const sesion = cookieFrom(login);
  const me = await ctx.app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { cookie: `preferencia=oscuro; ${sesion}; _ga=GA1.2.3%204` },
  });
  assert.equal(me.json().user?.email, ADMIN.email);

  const rara = await ctx.app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { cookie: 'mailway_session="no-es-un-token"; otra=%ZZ' },
  });
  assert.equal(rara.statusCode, 200);
  assert.deepEqual(rara.json(), { user: null });
});

/* ------------------------------ Cuerpos y tipos ----------------------------- */

test('la API solo lee JSON: con charset sí, con tipos parecidos o de formulario no', async () => {
  const conCharset = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    payload: JSON.stringify({ email: 'nadie@ejemplo.test', password: 'x' }),
  });
  assert.equal(conCharset.statusCode, 401, 'el cuerpo se ha leído');
  assert.equal(conCharset.json().code, 'bad_credentials');

  for (const tipo of ['application/jsonx', 'application/x-www-form-urlencoded', 'text/xml']) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': tipo },
      payload: 'email=nadie%40ejemplo.test&password=x',
    });
    assert.equal(res.statusCode, 415, tipo);
    assert.deepEqual(res.json(), { error: 'La petición no es válida.', code: 'bad_request' });
  }

  const roto = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: '{"email":',
  });
  assert.equal(roto.statusCode, 400);
  assert.equal(roto.json().code, 'bad_request');
});

test('un DELETE sin cuerpo con Content-Type llega a la ruta; con cuerpo, se valida', async () => {
  // Fastify 5 intentaría leer un JSON vacío y respondería 400 (ver app.ts).
  for (const tipo of ['application/json', 'application/x-www-form-urlencoded']) {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/apikeys/key_no_existe',
      headers: { cookie: ctx.adminCookie, 'content-type': tipo },
    });
    assert.equal(res.statusCode, 404, `${tipo}: ${res.body}`);
    assert.equal(res.json().code, 'not_found');
  }

  const conCuerpo = await ctx.app.inject({
    method: 'DELETE',
    url: '/api/apikeys/key_no_existe',
    headers: { cookie: ctx.adminCookie, 'content-type': 'application/json' },
    payload: '{roto',
  });
  assert.equal(conCuerpo.statusCode, 400);
  assert.equal(conCuerpo.json().code, 'bad_request');
});

test('la API rechaza cuerpos de más de 5 MB con 413', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email: 'nadie@ejemplo.test', password: 'x'.repeat(5 * 1024 * 1024) }),
  });
  assert.equal(res.statusCode, 413);
  assert.equal(res.json().code, 'bad_request');
});

/* ---------------------------------- Rutas ---------------------------------- */

test('el punto y coma forma parte de la ruta: no separa parámetros', async () => {
  const conPuntoYComa = await ctx.app.inject({ method: 'GET', url: '/api/health;jsessionid=1' });
  assert.equal(conPuntoYComa.statusCode, 404);
  assert.equal(conPuntoYComa.json().code, 'not_found');

  const enLaConsulta = await ctx.app.inject({ method: 'GET', url: '/api/health?a=1;b=2' });
  assert.equal(enLaConsulta.statusCode, 200);
  assert.equal(enLaConsulta.json().ok, true);
});
