import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalIpv6, isInternalHost, isValidHostname, normalizeHostname } from '../src/core/hostnames';
import { adminContext } from './helpers';

/* --------------------------- Nombre del servidor -------------------------- */

test('un nombre completo es válido, también con un dominio de primer nivel xn--', () => {
  for (const bueno of [
    'mail.ejemplo.com',
    'mail.ejemplo.com.',
    'Mail.Ejemplo.COM',
    'correo.xn--panadera-and-yfb2d0h.es',
    'mail.ejemplo.xn--p1ai',
    'mx-1.correo.ejemplo.museum',
    'mail.cluster.k8s',
  ]) {
    assert.equal(isValidHostname(bueno), true, bueno);
  }
});

test('una IPv4 no es un nombre: la última etiqueta no puede ser numérica', () => {
  for (const malo of ['203.0.113.10', '10.20.30.40', 'mail.ejemplo.123', '1.2.3.4.']) {
    assert.equal(isValidHostname(malo), false, malo);
  }
});

test('se rechazan los nombres mal formados', () => {
  for (const malo of [
    '',
    'localhost',
    'mailway-mail',
    'mail.ejemplo.c',
    '-mail.ejemplo.com',
    'mail-.ejemplo.com',
    'mail..ejemplo.com',
    'mail ejemplo.com',
    'mail_1.ejemplo.com',
    `${'a'.repeat(64)}.ejemplo.com`,
  ]) {
    assert.equal(isValidHostname(malo), false, malo);
  }
});

test('Ajustes y la puesta en marcha usan el mismo validador del nombre del servidor', async () => {
  const ctx = await adminContext();
  for (const mailHostname of ['203.0.113.10', 'mail.ejemplo.123', 'mailway-mail']) {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/instance',
      headers: { cookie: ctx.adminCookie },
      payload: { mailHostname },
    });
    assert.equal(res.statusCode, 400, mailHostname);
    assert.match((res.json() as { error: string }).error, /no una dirección IP/);
  }
  const idn = await ctx.app.inject({
    method: 'PUT',
    url: '/api/settings/instance',
    headers: { cookie: ctx.adminCookie },
    payload: { mailHostname: 'Mail.Ejemplo.XN--P1AI.' },
  });
  assert.equal(idn.statusCode, 200, idn.body);
  assert.equal((idn.json() as { instance: { mailHostname: string } }).instance.mailHostname, 'mail.ejemplo.xn--p1ai');
  const asistente = await ctx.app.inject({
    method: 'POST',
    url: '/api/setup/instance',
    headers: { cookie: ctx.adminCookie },
    payload: { mailHostname: '198.51.100.7' },
  });
  assert.equal(asistente.statusCode, 400);
});

/* ------------------------------ Nombre interno ---------------------------- */

test('isInternalHost reconoce contenedores, IP, localhost y los sufijos de red local', () => {
  for (const interno of [
    '3f2a1b4c5d6e',
    'mailway-mail',
    'localhost',
    '10.0.0.5',
    '2001:db8::1',
    '[2001:db8::1]',
    'mail.123',
    'stalwart.internal',
    'mail.local',
    'servidor.lan',
    'mail.docker',
    'host.localdomain',
    'mail.home.arpa',
  ]) {
    assert.equal(isInternalHost(interno), true, interno);
  }
  for (const publico of ['mail.ejemplo.com', 'mail.ejemplo.com.', 'mail.ejemplo.xn--p1ai', 'local.ejemplo.com', '']) {
    assert.equal(isInternalHost(publico), false, publico);
  }
});

test('normalizeHostname y canonicalIpv6 dan una forma comparable', () => {
  assert.equal(normalizeHostname('  Mail.Ejemplo.COM. '), 'mail.ejemplo.com');
  assert.equal(canonicalIpv6('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1');
  assert.equal(canonicalIpv6('[2001:db8::1]'), '2001:db8::1');
  assert.equal(canonicalIpv6('203.0.113.10'), null);
  assert.equal(canonicalIpv6('no-es-una-ip'), null);
});
