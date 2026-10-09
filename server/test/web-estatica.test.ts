import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { config } from '../src/config';

/*
 * La web compilada que sirve el propio panel (@fastify/static). Se monta una
 * carpeta de prueba con un secreto justo al lado y se habla con un servidor
 * de verdad: app.inject() normaliza la URL y escondería los «../» que manda
 * un atacante tal cual.
 */

const INDICE = '<!doctype html><title>Panel de prueba</title><div id="root"></div>';
const APP_JS = "console.log('aplicación de prueba');\n";
const SECRETO = 'SECRETO-FUERA-DE-LA-WEB';
const SECRETO_VECINO = 'SECRETO-EN-UNA-CARPETA-VECINA';

let app: FastifyInstance;
let puerto: number;
let web: string;

before(async () => {
  const base = fs.mkdtempSync(path.join(config.dataDir, 'web-'));
  web = path.join(base, 'web');
  fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), INDICE);
  fs.writeFileSync(path.join(web, 'assets', 'app-1234.js'), APP_JS);
  fs.writeFileSync(path.join(web, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(base, 'secreto.txt'), SECRETO);
  // Misma raíz de nombre que la web: el clásico error de comparar prefijos.
  fs.mkdirSync(path.join(base, 'web-vecina'));
  fs.writeFileSync(path.join(base, 'web-vecina', 'secreto.txt'), SECRETO_VECINO);

  app = await buildApp({ logger: false, serveWeb: true, webDist: web });
  await app.listen({ port: 0, host: '127.0.0.1' });
  puerto = (app.server.address() as { port: number }).port;
});

after(async () => {
  await app.close();
});

interface Respuesta {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Petición HTTP con la ruta exacta, sin normalizar. */
function pedir(ruta: string, method = 'GET'): Promise<Respuesta> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: puerto, path: ruta, method, agent: false }, (res) => {
      const trozos: Buffer[] = [];
      res.on('data', (t: Buffer) => trozos.push(t));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(trozos).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

test('índice y recursos con sus tipos y cabeceras de caché', async () => {
  const indice = await pedir('/');
  assert.equal(indice.status, 200);
  assert.match(String(indice.headers['content-type']), /^text\/html/);
  assert.equal(indice.body, INDICE);
  assert.equal(indice.headers['cache-control'], 'public, max-age=0');
  assert.ok(indice.headers.etag, 'con ETag');
  assert.ok(indice.headers['last-modified'], 'con Last-Modified');

  const js = await pedir('/assets/app-1234.js');
  assert.equal(js.status, 200);
  assert.match(String(js.headers['content-type']), /^(application|text)\/javascript/);
  assert.equal(js.body, APP_JS);
  assert.equal(js.headers['cache-control'], 'public, max-age=0');

  const cabecera = await pedir('/assets/app-1234.js', 'HEAD');
  assert.equal(cabecera.status, 200);
  assert.equal(cabecera.headers['content-length'], String(Buffer.byteLength(APP_JS)));
  assert.equal(cabecera.body, '');

  const icono = await pedir('/favicon.svg');
  assert.equal(icono.status, 200);
  assert.match(String(icono.headers['content-type']), /^image\/svg\+xml/);
});

test('las rutas de la web y los recursos que no existen devuelven el índice; la API, 404', async () => {
  for (const ruta of ['/clientes/cli_1/buzones', '/mi-buzon', '/assets/no-existe.js', '/assets', '/assets/']) {
    const res = await pedir(ruta);
    assert.equal(res.status, 200, ruta);
    assert.match(String(res.headers['content-type']), /^text\/html/, ruta);
    assert.equal(res.headers.location, undefined, `${ruta}: sin redirecciones`);
    assert.equal(res.body, INDICE, ruta);
  }
  for (const ruta of ['/api/no-existe', '/v1/no-existe', '/forms/a/b']) {
    const res = await pedir(ruta);
    assert.equal(res.status, 404, ruta);
    assert.deepEqual(JSON.parse(res.body), { error: 'Ruta no encontrada.', code: 'not_found' }, ruta);
  }
});

test('ninguna variante de «../» sirve ficheros de fuera de la carpeta de la web', async () => {
  const rutas = [
    '/../secreto.txt',
    '/assets/../../secreto.txt',
    '/%2e%2e/secreto.txt',
    '/%2E%2E/secreto.txt',
    '/.%2e/secreto.txt',
    '/assets/%2e%2e/%2e%2e/secreto.txt',
    '/..%2fsecreto.txt',
    '/assets/..%2f..%2fsecreto.txt',
    '/..%5csecreto.txt',
    '/..\\secreto.txt',
    '//secreto.txt',
    '/%252e%252e/secreto.txt',
    '/index.html/../../secreto.txt',
    '/assets/app-1234.js/../../../secreto.txt',
    '/../web-vecina/secreto.txt',
    '/assets/../../web-vecina/secreto.txt',
    '/%2e%2e/web-vecina/secreto.txt',
    '/assets/%2e%2e%2f%2e%2e%2fweb-vecina%2fsecreto.txt',
  ];
  for (const ruta of rutas) {
    const res = await pedir(ruta);
    assert.ok([200, 400, 403, 404].includes(res.status), `${ruta}: ${res.status}`);
    assert.ok(!res.body.includes(SECRETO) && !res.body.includes(SECRETO_VECINO), `${ruta} no debe filtrar nada`);
    if (res.status === 200) assert.equal(res.body, INDICE, `${ruta}: si responde, con el índice`);
  }
});

test('solo se sirven los ficheros que había al arrancar', async () => {
  fs.writeFileSync(path.join(web, 'tarde.txt'), 'AÑADIDO-DESPUÉS');
  const res = await pedir('/tarde.txt');
  assert.equal(res.status, 200);
  assert.equal(res.body, INDICE, 'un fichero nuevo no se publica hasta reiniciar');
});
