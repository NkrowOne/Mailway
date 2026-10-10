import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrustProxy } from '../src/config';
import { hashToken } from '../src/core/crypto';
import { db } from '../src/core/db';
import { setInstanceSettings } from '../src/modules/settings';
import { adminContext, cookieFrom, createClient, createDomain, type TestContext } from './helpers';

/*
 * IP real del cliente y cabeceras X-Forwarded-* detrás de Traefik. Con el
 * valor por defecto de MAILWAY_TRUST_PROXY (un salto) el panel cree lo que
 * añade el proxy inmediato y nada más. Fastify 5.12.5 dejó de admitir un
 * número de saltos: sin la conversión de config.ts, todas las peticiones
 * parecerían venir de Traefik.
 */

const PROXY = '10.0.0.2';
const ADMIN = { email: 'admin@mailway.test', password: 'clave-admin-segura' };

let ctx: TestContext;
let dominio: string;

before(async () => {
  ctx = await adminContext();
  // Sin URL del panel configurada: la URL pública sale de la petición.
  setInstanceSettings({ mailHostname: 'mail.proveedor.test', panelUrl: '' });
  const cliente = await createClient(ctx);
  ({ domain: dominio } = await createDomain(ctx, cliente.clientId, 'cliente-proxy.test'));
});

function loginFallido(ip: string, email: string, xff?: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: PROXY,
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    payload: { email, password: `incorrecta-${ip}` },
  });
}

test('MAILWAY_TRUST_PROXY: número de saltos, true/false y lista de IP', () => {
  const unSalto = parseTrustProxy(undefined);
  assert.equal(typeof unSalto, 'function', 'por defecto, un salto');
  const fn = unSalto as (address: string, hop: number) => boolean;
  assert.equal(fn('172.18.0.5', 0), true, 'se cree al proxy inmediato');
  assert.equal(fn('198.51.100.7', 1), false, 'y a nadie más');

  const dos = parseTrustProxy('2') as (address: string, hop: number) => boolean;
  assert.equal(dos('172.18.0.5', 1), true);
  assert.equal(dos('198.51.100.7', 2), false);

  assert.equal(parseTrustProxy('0'), false);
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('10.0.0.0/8, 127.0.0.1'), '10.0.0.0/8, 127.0.0.1');
});

test('la IP de la sesión es la que añade el proxy, no la que escribe el cliente', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: PROXY,
    // La primera la pone el cliente (falsa); la última, Traefik.
    headers: { 'x-forwarded-for': '192.0.2.66, 203.0.113.9' },
    payload: ADMIN,
  });
  assert.equal(res.statusCode, 200, res.body);
  const token = cookieFrom(res).split('=')[1]!;
  const sesion = db.prepare('SELECT ip FROM sessions WHERE token_hash = ?').get(hashToken(token)) as { ip: string };
  assert.equal(sesion.ip, '203.0.113.9');

  const directa = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: '198.51.100.20',
    payload: ADMIN,
  });
  const otro = cookieFrom(directa).split('=')[1]!;
  const sinProxy = db.prepare('SELECT ip FROM sessions WHERE token_hash = ?').get(hashToken(otro)) as { ip: string };
  assert.equal(sinProxy.ip, '198.51.100.20', 'sin X-Forwarded-For, la del socket');
});

test('el límite de intentos por IP cuenta por cliente, no por proxy', async () => {
  // Ocho fallos (el máximo por IP) desde un cliente, cada uno con un correo
  // distinto para no tocar el límite por correo.
  for (let i = 0; i < 8; i += 1) {
    const res = await loginFallido('a', `nadie-${i}@ejemplo.test`, '203.0.113.21');
    assert.equal(res.statusCode, 401, res.body);
  }
  const bloqueado = await loginFallido('a', 'otro@ejemplo.test', '203.0.113.21');
  assert.equal(bloqueado.statusCode, 429);
  assert.equal(bloqueado.json().code, 'rate_limited');

  // Otro cliente detrás del mismo Traefik no hereda el bloqueo.
  const vecino = await loginFallido('b', 'vecino@ejemplo.test', '203.0.113.22');
  assert.equal(vecino.statusCode, 401);
  assert.equal(vecino.json().code, 'bad_credentials');
});

test('X-Forwarded-Proto y X-Forwarded-Host del proxy forman la URL pública del panel', async () => {
  const info = async (headers: Record<string, string>) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/integrations/info',
      remoteAddress: PROXY,
      headers: { cookie: ctx.adminCookie, host: 'mailway-panel:4100', ...headers },
    });
    assert.equal(res.statusCode, 200, res.body);
    return (res.json() as { panelUrl: string }).panelUrl;
  };
  assert.equal(
    await info({ 'x-forwarded-host': 'panel.ejemplo.test', 'x-forwarded-proto': 'https' }),
    'https://panel.ejemplo.test',
  );
  // Con varios valores manda el último, el del proxy de confianza.
  assert.equal(
    await info({ 'x-forwarded-host': 'panel.ejemplo.test', 'x-forwarded-proto': 'http, https' }),
    'https://panel.ejemplo.test',
  );
  assert.equal(await info({}), 'http://mailway-panel:4100', 'sin cabeceras del proxy, la petición tal cual');
});

test('autoconfiguración: host con puerto y host reenviado por el proxy', async () => {
  const conPuerto = await ctx.app.inject({
    method: 'GET',
    url: '/mail/config-v1.1.xml',
    headers: { host: `autoconfig.${dominio}:8443` },
  });
  assert.equal(conPuerto.statusCode, 200, conPuerto.body);
  assert.match(conPuerto.body, new RegExp(`<domain>${dominio.replace('.', '\\.')}</domain>`));

  const reenviado = await ctx.app.inject({
    method: 'GET',
    url: '/mail/config-v1.1.xml',
    remoteAddress: PROXY,
    headers: { host: 'mailway-panel:4100', 'x-forwarded-host': `autoconfig.${dominio}` },
  });
  assert.equal(reenviado.statusCode, 200, reenviado.body);
  assert.match(reenviado.body, new RegExp(`<domain>${dominio.replace('.', '\\.')}</domain>`));

  const mtaSts = await ctx.app.inject({
    method: 'GET',
    url: '/.well-known/mta-sts.txt',
    remoteAddress: PROXY,
    headers: { host: 'mailway-panel:4100', 'x-forwarded-host': `mta-sts.${dominio}` },
  });
  assert.equal(mtaSts.statusCode, 200, mtaSts.body);
  assert.match(mtaSts.body, /^version: STSv1\r\n/);
});
