import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detalleIpAjena, esIpDeCloudflare } from '../src/modules/whitelabel';

/**
 * Por qué un dominio de marca blanca no apunta aquí. Caso real: un
 * webmail.<dominio> sin registro propio en una zona de Cloudflare con un
 * comodín con proxy (el de la web). El DNS devolvía las IP de Cloudflare y el
 * panel pedía «corregir el registro», que no existía.
 */

const BASE = {
  hostname: 'webmail.ejemplo.com',
  publicIp: '203.0.113.10',
  mailHostname: 'mail.servidor.com',
};

test('reconoce las IP del proxy de Cloudflare y no otras', () => {
  assert.equal(esIpDeCloudflare('172.67.211.216'), true);
  assert.equal(esIpDeCloudflare('104.21.67.34'), true);
  assert.equal(esIpDeCloudflare('162.159.1.1'), true);
  assert.equal(esIpDeCloudflare('203.0.113.10'), false);
  assert.equal(esIpDeCloudflare('152.53.113.27'), false);
  assert.equal(esIpDeCloudflare('104.32.0.1'), false);
  assert.equal(esIpDeCloudflare('no-es-una-ip'), false);
  assert.equal(esIpDeCloudflare('300.1.1.1'), false);
});

test('comodín con proxy: pide crear el registro propio sin proxy', () => {
  const detalle = detalleIpAjena({ ...BASE, ips: ['172.67.211.216', '104.21.67.34'], comodin: true });
  assert.match(detalle, /no tiene registro propio/);
  assert.match(detalle, /\*\.ejemplo\.com/);
  assert.match(detalle, /CNAME para webmail\.ejemplo\.com que apunte a mail\.servidor\.com/);
  assert.match(detalle, /sin proxy/);
});

test('comodín sin proxy: pide crear el registro propio', () => {
  const detalle = detalleIpAjena({ ...BASE, ips: ['198.51.100.7'], comodin: true });
  assert.match(detalle, /no tiene registro propio/);
  assert.match(detalle, /198\.51\.100\.7/);
  assert.doesNotMatch(detalle, /proxy/);
});

test('registro propio con proxy: pide quitar el proxy', () => {
  const detalle = detalleIpAjena({ ...BASE, ips: ['104.21.67.34'], comodin: false });
  assert.match(detalle, /proxy de Cloudflare/);
  assert.match(detalle, /Desactiva el proxy/);
});

test('sin nombre del servidor de correo, propone un registro A con la IP', () => {
  const detalle = detalleIpAjena({ ...BASE, mailHostname: '', ips: ['104.21.67.34'], comodin: true });
  assert.match(detalle, /registro A para webmail\.ejemplo\.com con la IP 203\.0\.113\.10/);
});

test('otra IP cualquiera: el mensaje de siempre', () => {
  const detalle = detalleIpAjena({ ...BASE, ips: ['198.51.100.7'], comodin: false });
  assert.equal(detalle, 'El dominio apunta a 198.51.100.7 en lugar de a 203.0.113.10. Corrige el registro.');
});
