import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type tls from 'node:tls';
import {
  checkHttpsDetrasDeCloudflare,
  detalleIpAjena,
  esIpDeCloudflare,
  evaluarIps,
  headAlOrigen,
  redirigeASiMismo,
  type ClientDomain,
  type RespuestaHead,
} from '../src/modules/whitelabel';

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

test('comodín con proxy y sin cuenta de Cloudflare: pide el registro propio sin proxy o conectar la cuenta', () => {
  const detalle = detalleIpAjena({ ...BASE, ips: ['172.67.211.216', '104.21.67.34'], comodin: true });
  assert.match(detalle, /no tiene registro propio/);
  assert.match(detalle, /\*\.ejemplo\.com/);
  assert.match(detalle, /CNAME para webmail\.ejemplo\.com que apunte a mail\.servidor\.com/);
  assert.match(detalle, /sin proxy/);
  assert.match(detalle, /conecta en Conexiones/);
});

test('comodín con proxy y con cuenta de Cloudflare: el botón lo crea con proxy', () => {
  const detalle = detalleIpAjena({ ...BASE, ips: ['172.67.211.216'], comodin: true, cuentaCloudflare: true });
  assert.match(detalle, /no tiene registro propio/);
  assert.match(detalle, /«Configurar en Cloudflare» lo crea con el proxy activo/);
});

test('comodín sin proxy: pide crear el registro propio', () => {
  const detalle = detalleIpAjena({ ...BASE, ips: ['198.51.100.7'], comodin: true });
  assert.match(detalle, /no tiene registro propio/);
  assert.match(detalle, /198\.51\.100\.7/);
  assert.doesNotMatch(detalle, /proxy/);
});

test('registro propio con proxy y sin cuenta: no se puede comprobar adónde apunta', () => {
  const detalle = detalleIpAjena({ ...BASE, ips: ['104.21.67.34'], comodin: false });
  assert.match(detalle, /proxy de Cloudflare/);
  assert.match(detalle, /Conéctala en Conexiones o desactiva el proxy/);
});

test('registro propio con proxy, comprobado con la cuenta: no apunta aquí', () => {
  const detalle = detalleIpAjena({ ...BASE, ips: ['104.21.67.34'], comodin: false, cuentaCloudflare: true });
  assert.match(detalle, /no apunta a este servidor: debe ser un registro CNAME/);
});

test('una redirección a la misma página por HTTPS es el bucle del modo Flexible', () => {
  assert.equal(redirigeASiMismo('webmail.ejemplo.com', 'https://webmail.ejemplo.com/'), true);
  assert.equal(redirigeASiMismo('webmail.ejemplo.com', '/'), true);
  assert.equal(redirigeASiMismo('webmail.ejemplo.com', 'https://webmail.ejemplo.com/?_task=login'), false);
  assert.equal(redirigeASiMismo('webmail.ejemplo.com', '/?_task=mail'), false);
  assert.equal(redirigeASiMismo('webmail.ejemplo.com', 'http://webmail.ejemplo.com/'), false);
  assert.equal(redirigeASiMismo('webmail.ejemplo.com', 'https://otro.ejemplo.com/'), false);
  assert.equal(redirigeASiMismo('webmail.ejemplo.com', '/login'), false);
  assert.equal(redirigeASiMismo('webmail.ejemplo.com', null), false);
});

test('sin nombre del servidor de correo, propone un registro A con la IP', () => {
  const detalle = detalleIpAjena({ ...BASE, mailHostname: '', ips: ['104.21.67.34'], comodin: true });
  assert.match(detalle, /registro A para webmail\.ejemplo\.com con la IP 203\.0\.113\.10/);
});

test('otra IP cualquiera: el mensaje de siempre', () => {
  const detalle = detalleIpAjena({ ...BASE, ips: ['198.51.100.7'], comodin: false });
  assert.equal(detalle, 'El dominio apunta a 198.51.100.7 en lugar de a 203.0.113.10. Corrige el registro.');
});

/* --------------------- Veredicto del DNS con Cloudflare -------------------- */

const DOMINIO: ClientDomain = {
  id: 'wld_x',
  clientId: 'cli_x',
  hostname: 'webmail.ejemplo.com',
  kind: 'webmail',
  status: 'pending_dns',
  detail: '',
  lastCheckedAt: null,
  activatedAt: null,
  createdAt: 0,
  isPrimary: false,
};
const INSTANCIA = { publicIp: '203.0.113.10', mailHostname: 'mail.servidor.com' };

function deps(proxy: boolean | null, comodin = false) {
  const llamadas = { proxy: 0 };
  return {
    llamadas,
    deps: {
      proxyApuntaAqui: async () => {
        llamadas.proxy += 1;
        return proxy;
      },
      respondeComodin: async () => comodin,
    },
  };
}

test('DNS: la IP del servidor basta, sin preguntar a Cloudflare', async () => {
  const { llamadas, deps: d } = deps(true);
  const r = await evaluarIps(DOMINIO, ['203.0.113.10'], INSTANCIA, d);
  assert.equal(r.status, 'ok');
  assert.equal(r.viaCloudflare, undefined);
  assert.equal(llamadas.proxy, 0);
});

test('DNS: IP de Cloudflare y registro confirmado por su API → apunta aquí a través del proxy', async () => {
  const r = await evaluarIps(DOMINIO, ['172.67.211.216', '104.21.67.34'], INSTANCIA, deps(true).deps);
  assert.equal(r.status, 'ok');
  assert.equal(r.viaCloudflare, true);
  assert.match(r.detail, /a través del proxy de Cloudflare/);
});

test('DNS: IP de Cloudflare sin registro propio (comodín) y con cuenta → ofrece crearlo', async () => {
  const r = await evaluarIps(DOMINIO, ['172.67.211.216'], INSTANCIA, deps(false, true).deps);
  assert.equal(r.status, 'failed');
  assert.match(r.detail, /no tiene registro propio/);
  assert.match(r.detail, /Configurar en Cloudflare/);
});

test('DNS: IP de Cloudflare sin cuenta que vea la zona → lo explica', async () => {
  const r = await evaluarIps(DOMINIO, ['104.21.67.34'], INSTANCIA, deps(null).deps);
  assert.equal(r.status, 'failed');
  assert.match(r.detail, /no hay una cuenta de Cloudflare conectada/);
});

test('DNS: otras IP que no son de Cloudflare → no se pregunta a su API', async () => {
  const { llamadas, deps: d } = deps(true);
  const r = await evaluarIps(DOMINIO, ['198.51.100.7'], INSTANCIA, d);
  assert.equal(r.status, 'failed');
  assert.equal(llamadas.proxy, 0);
});

/* ------------------- HTTPS detrás del proxy de Cloudflare ------------------ */

const OK = { status: 200, location: null, mitigada: false };

async function https_(origen: RespuestaHead, publico?: RespuestaHead) {
  let llamadasPublico = 0;
  const r = await checkHttpsDetrasDeCloudflare('webmail.ejemplo.com', '203.0.113.10', {
    origen: async () => origen,
    publico: async () => {
      llamadasPublico += 1;
      return publico ?? OK;
    },
  });
  return { ...r, llamadasPublico };
}

test('HTTPS con proxy: sin certificado en el servidor no está en servicio (y no se mira Cloudflare)', async () => {
  const r = await https_({ error: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }) });
  assert.equal(r.ok, false);
  assert.match(r.detail, /certificado/);
  assert.equal(r.llamadasPublico, 0);
});

test('HTTPS con proxy: 404 en el servidor (ruta sin publicar) no está en servicio', async () => {
  const r = await https_({ status: 404, location: null, mitigada: false });
  assert.equal(r.ok, false);
  assert.match(r.detail, /404/);
});

test('HTTPS con proxy: servidor y Cloudflare responden → en servicio', async () => {
  const r = await https_(OK, OK);
  assert.equal(r.ok, true);
  assert.match(r.detail, /a través de Cloudflare/);
});

test('HTTPS con proxy: la redirección normal de la aplicación vale', async () => {
  const r = await https_(OK, { status: 302, location: '/?_task=login', mitigada: false });
  assert.equal(r.ok, true);
});

test('HTTPS con proxy: el bucle del modo Flexible no está en servicio', async () => {
  const r = await https_(OK, { status: 301, location: 'https://webmail.ejemplo.com/', mitigada: false });
  assert.equal(r.ok, false);
  assert.match(r.detail, /Flexible/);
});

test('HTTPS con proxy: la protección de Cloudflare contra bots no saca el webmail de servicio', async () => {
  assert.equal((await https_(OK, { status: 403, location: null, mitigada: true })).ok, true);
  assert.equal((await https_(OK, { status: 503, location: null, mitigada: true })).ok, true);
  assert.equal((await https_(OK, { status: 429, location: null, mitigada: false })).ok, true);
});

test('HTTPS con proxy: un fallo de red hacia Cloudflare tampoco, si el servidor responde', async () => {
  const r = await https_(OK, { error: new Error('fetch failed') });
  assert.equal(r.ok, true);
});

test('HTTPS con proxy: los errores 52x de Cloudflare no están en servicio', async () => {
  for (const status of [520, 521, 522, 523, 524, 525, 526]) {
    const r = await https_(OK, { status, location: null, mitigada: false });
    assert.equal(r.ok, false, `HTTP ${status}`);
    assert.match(r.detail, new RegExp(String(status)));
  }
});

/* ------------- Conexión directa al servidor: SNI, Host y certificado ------- */

test('la conexión directa al servidor usa el nombre en SNI y Host, y valida el certificado', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailway-origen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nombre = 'webmail.prueba.test';
  const gen = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', path.join(dir, 'clave.pem'), '-out', path.join(dir, 'cert.pem'),
    '-subj', `/CN=${nombre}`, '-addext', `subjectAltName=DNS:${nombre}`,
  ]);
  assert.equal(gen.status, 0, String(gen.stderr));
  const cert = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8');
  const vistos: { host?: string; sni?: string | false }[] = [];
  const servidor = https.createServer({ key: fs.readFileSync(path.join(dir, 'clave.pem')), cert }, (req, res) => {
    vistos.push({ host: req.headers.host, sni: (req.socket as tls.TLSSocket).servername });
    res.writeHead(200).end();
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  t.after(() => servidor.close());
  const puerto = (servidor.address() as { port: number }).port;

  // Con la CA del servidor: responde, y le llegan el nombre por SNI y en Host.
  const bien = await headAlOrigen(nombre, '127.0.0.1', { puerto, ca: cert });
  assert.ok(!('error' in bien), 'error' in bien ? bien.error.message : '');
  assert.equal((bien as { status: number }).status, 200);
  assert.deepEqual(vistos[0], { host: nombre, sni: nombre });

  // Sin confiar en su certificado (autofirmado): error de certificado.
  const sinCa = await headAlOrigen(nombre, '127.0.0.1', { puerto });
  assert.ok('error' in sinCa);
  const veredicto = await checkHttpsDetrasDeCloudflare(nombre, '127.0.0.1', {
    origen: (h, ip) => headAlOrigen(h, ip, { puerto }),
    publico: async () => OK,
  });
  assert.equal(veredicto.ok, false);
  assert.match(veredicto.detail, /certificado/);

  // Un certificado de otro nombre tampoco vale.
  const otroNombre = await headAlOrigen('otro.prueba.test', '127.0.0.1', { puerto, ca: cert });
  assert.ok('error' in otroNombre);
});

test('la conexión directa al servidor no se queda esperando si nadie contesta', async (t) => {
  // Un servidor TCP que acepta y no habla TLS: el tope corta la espera.
  const net = await import('node:net');
  const mudo = net.createServer(() => {});
  await new Promise<void>((ok) => mudo.listen(0, '127.0.0.1', ok));
  t.after(() => mudo.close());
  const puerto = (mudo.address() as { port: number }).port;
  const inicio = Date.now();
  const r = await headAlOrigen('webmail.prueba.test', '127.0.0.1', { puerto });
  assert.ok('error' in r);
  assert.match((r as { error: Error }).error.message, /timeout|socket hang up/);
  assert.ok(Date.now() - inicio < 12_000);
});
