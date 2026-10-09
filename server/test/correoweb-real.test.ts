import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { listAlerts } from '../src/modules/alerts';
import {
  comprobarSaludBulwark,
  esperarTareasCorreoWeb,
  leerEstadoSincronizacion,
  sincronizarCorreoWeb,
} from '../src/modules/correoweb';
import { adminContext, createClient, createDomain, type TestContext } from './helpers';

/*
 * El correo web nuevo de extremo a extremo contra contenedores DE VERDAD:
 * Stalwart 0.16.25 y Bulwark 1.13.0 (la imagen fijada en
 * deploy/bulwark/README.md, con su configuración de referencia). Comprueba
 * que elegir Bulwark para el primer cliente abre el CORS del motor (y fija la
 * caducidad del bloqueo), que la sincronización del panel deja la marca, sus
 * imágenes y la política en Bulwark, que una segunda pasada no escribe nada y
 * que volver a Roundcube lo deshace todo.
 *
 * Solo se ejecuta con los dos contenedores; si no, se omite entera:
 *
 *   eval "$(MOTOR016_CONTENEDOR=… server/test/motor016-arrancar.sh)"
 *   # Bulwark con la configuración de deploy/bulwark/README.md y su API en
 *   # MAILWAY_TEST_BULWARK_URL (contraseña en MAILWAY_TEST_BULWARK_PASSWORD).
 *   cd server && node --test --import tsx --import ./test/env.ts \
 *     --import ./test/env-real.ts test/correoweb-real.test.ts
 *
 * MAILWAY_TEST_BULWARK_CONTENEDOR (opcional) permite leer el registro de
 * auditoría de Bulwark para contar sus escrituras.
 */

const URL_MOTOR = (process.env.MAILWAY_TEST_MOTOR_URL ?? '').replace(/\/+$/, '');
const USUARIO_MOTOR = process.env.MAILWAY_TEST_MOTOR_USER || 'admin';
const CLAVE_MOTOR = process.env.MAILWAY_TEST_MOTOR_PASSWORD ?? '';
const URL_BULWARK = (process.env.MAILWAY_TEST_BULWARK_URL ?? '').replace(/\/+$/, '');
const CLAVE_BULWARK = process.env.MAILWAY_TEST_BULWARK_PASSWORD ?? '';
const CONTENEDOR_BULWARK = process.env.MAILWAY_TEST_BULWARK_CONTENEDOR ?? '';

function motivoParaOmitir(): string | false {
  if (!URL_MOTOR || !CLAVE_MOTOR || process.env.MAILWAY_TEST_MOTOR_API !== 'jmap016') {
    return 'Sin Stalwart 0.16 real: server/test/motor016-arrancar.sh';
  }
  if (!URL_BULWARK || !CLAVE_BULWARK) return 'Sin Bulwark real: define MAILWAY_TEST_BULWARK_URL y MAILWAY_TEST_BULWARK_PASSWORD';
  if (config.demoMode) return 'El panel sigue en modo demostración: ejecuta la prueba con --import ./test/env-real.ts';
  return false;
}

const omitir = motivoParaOmitir();
const sufijo = crypto.randomBytes(3).toString('hex');
const NOMBRE_SERVIDOR = `mail-${sufijo}.mailway.test`;
const PANEL = 'https://panel.mwf1.test';

/* ------------------------------- Utilidades -------------------------------- */

const TABLA_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(datos: Buffer): number {
  let c = 0xffffffff;
  for (const b of datos) c = TABLA_CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG de verdad (Bulwark lo decodifica para el icono): un cuadrado de un color. */
function pngReal(lado: number, rgb: [number, number, number]): Buffer {
  const trozo = (tipo: string, datos: Buffer) => {
    const cuerpo = Buffer.concat([Buffer.from(tipo, 'latin1'), datos]);
    const longitud = Buffer.alloc(4);
    longitud.writeUInt32BE(datos.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(cuerpo));
    return Buffer.concat([longitud, cuerpo, crc]);
  };
  const cabecera = Buffer.alloc(13);
  cabecera.writeUInt32BE(lado, 0);
  cabecera.writeUInt32BE(lado, 4);
  cabecera.set([8, 2, 0, 0, 0], 8);
  const fila = Buffer.concat([Buffer.from([0]), Buffer.alloc(lado * 3).fill(Buffer.from(rgb))]);
  const pixeles = zlib.deflateSync(Buffer.concat(Array.from({ length: lado }, () => fila)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', cabecera),
    trozo('IDAT', pixeles),
    trozo('IEND', Buffer.alloc(0)),
  ]);
}

/** Lectura de Bulwark como la haría un navegador en ese nombre (Host del webmail). */
function pedirBulwark(ruta: string, host: string): Promise<{ status: number; tipo: string; cuerpo: Buffer }> {
  const url = new URL(URL_BULWARK + ruta);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers: { host } },
      (res) => {
        const trozos: Buffer[] = [];
        res.on('data', (t: Buffer) => trozos.push(t));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, tipo: String(res.headers['content-type'] ?? ''), cuerpo: Buffer.concat(trozos) }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function jmapMotor(llamadas: unknown[]): Promise<any[]> {
  const res = await fetch(`${URL_MOTOR}/jmap`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${USUARIO_MOTOR}:${CLAVE_MOTOR}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: llamadas }),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { methodResponses: any[] }).methodResponses;
}

async function ajustesDelMotor(): Promise<{ cors: boolean; caducidad: number | null }> {
  const [http1, seguridad] = await jmapMotor([
    ['x:Http/get', { ids: ['singleton'], properties: ['usePermissiveCors'] }, 'h'],
    ['x:Security/get', { ids: ['singleton'], properties: ['authBanPeriod'] }, 'g'],
  ]);
  return { cors: http1[1].list[0].usePermissiveCors, caducidad: seguridad[1].list[0].authBanPeriod };
}

/** Acciones del registro de auditoría de Bulwark (si se conoce su contenedor). */
function auditoriaBulwark(): string[] {
  if (!CONTENEDOR_BULWARK) return [];
  const texto = execFileSync('docker', ['exec', CONTENEDOR_BULWARK, 'cat', '/app/data/admin-state/audit.log'], {
    encoding: 'utf8',
  });
  return texto
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { action?: string }).action ?? '');
}

/**
 * Intermediario entre el panel y Bulwark que anota cada petición (método y
 * ruta): así se ve qué pide de verdad el panel, también con la sesión que
 * reutiliza su cliente compartido.
 */
const vistas: { metodo: string; ruta: string }[] = [];
let intermediario: http.Server | null = null;

function arrancarIntermediario(): Promise<string> {
  const destino = new URL(URL_BULWARK);
  intermediario = http.createServer((req, res) => {
    vistas.push({ metodo: req.method ?? 'GET', ruta: (req.url ?? '').split('?')[0]! });
    const salida = http.request(
      {
        hostname: destino.hostname,
        port: destino.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: destino.host },
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    salida.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(salida);
  });
  return new Promise((resolve) => {
    intermediario!.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(intermediario!.address() as AddressInfo).port}`);
    });
  });
}

/** Peticiones del panel a Bulwark mientras dura `fn`. */
async function peticionesABulwark(fn: () => Promise<unknown>): Promise<{ metodo: string; ruta: string }[]> {
  const desde = vistas.length;
  await fn();
  return vistas.slice(desde);
}

/* --------------------------------- Prueba ---------------------------------- */

describe('correo web nuevo contra Stalwart 0.16 y Bulwark reales', { skip: omitir }, () => {
  let ctx: TestContext;
  let clientId = '';
  let hosts: string[] = [];
  /** Entradas del registro de Bulwark anteriores a esta ejecución (se puede repetir). */
  let auditoriaPrevia = 0;
  const bulwarkOriginal = { ...config.bulwark };

  before(async () => {
    ctx = await adminContext();
    const admin = (method: 'PUT', url: string, payload: Record<string, unknown>) =>
      ctx.app.inject({ method, url, headers: { cookie: ctx.adminCookie }, payload });
    // Como Ajustes: identidad de la instancia y motor (la ruta lo prueba antes de guardarlo).
    const identidad = await admin('PUT', '/api/settings/instance', { mailHostname: NOMBRE_SERVIDOR, panelUrl: PANEL });
    assert.equal(identidad.statusCode, 200, identidad.body);
    const motor = await admin('PUT', '/api/settings/engine', {
      kind: 'stalwart',
      url: URL_MOTOR,
      adminUser: USUARIO_MOTOR,
      adminPassword: CLAVE_MOTOR,
      smtpHost: '127.0.0.1',
      smtpPort: 587,
      smtpSecure: false,
    });
    assert.equal(motor.statusCode, 200, motor.body);
    auditoriaPrevia = auditoriaBulwark().length;
    config.bulwark.url = await arrancarIntermediario();
    config.bulwark.adminPassword = CLAVE_BULWARK;
    config.bulwark.backendUrl = 'http://mailway-bulwark-gw:8080';
    const cliente = await createClient(ctx, { name: `Cliente Real ${sufijo}` });
    clientId = cliente.clientId;
    const { domain } = await createDomain(ctx, clientId, `real-${sufijo}.test`);
    hosts = [`webmail.${domain}`, `correo.${domain}`];
    // Webmail propios ya en servicio (sin DNS de verdad no se pueden activar por la ruta).
    for (const [i, hostname] of hosts.entries()) {
      db.prepare(
        `INSERT INTO client_domains (id, client_id, hostname, kind, status, activated_at, created_at)
         VALUES (?, ?, ?, 'webmail', 'active', ?, ?)`,
      ).run(`wld_real${sufijo}${i}`, clientId, hostname, Date.now(), Date.now());
    }
  });

  after(async () => {
    await esperarTareasCorreoWeb();
    Object.assign(config.bulwark, bulwarkOriginal);
    intermediario?.closeAllConnections();
    intermediario?.close();
  });

  test('elegir el correo web nuevo abre el CORS del motor y fija la caducidad del bloqueo', async () => {
    const antes = await ajustesDelMotor();
    assert.equal(antes.cors, false, 'el motor recién puesto en marcha no tiene CORS');
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/clients/${clientId}/webmail`,
      headers: { cookie: ctx.adminCookie },
      payload: { motor: 'bulwark' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().motor, 'bulwark');
    assert.equal(res.json().enServicio, 'bulwark');
    const despues = await ajustesDelMotor();
    assert.equal(despues.cors, true);
    assert.equal(despues.caducidad, 3_600_000);
    // El preflight que hace el navegador desde webmail.<dominio>.
    const preflight = await fetch(`${URL_MOTOR}/jmap/`, {
      method: 'OPTIONS',
      headers: {
        origin: `https://${hosts[0]}`,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    // El estado del motor lo da por aplicado.
    const estado = await ctx.app.inject({ method: 'GET', url: '/api/engine/status', headers: { cookie: ctx.adminCookie } });
    const extra = estado.json().extra as Record<string, boolean>;
    assert.equal(extra.permissiveCors, true);
    assert.equal(extra.authBanExpiry, true);
  });

  test('la marca, sus imágenes y la política llegan a Bulwark; la segunda pasada no escribe', async () => {
    const logo = pngReal(64, [13, 92, 94]);
    const icono = pngReal(256, [122, 46, 140]);
    for (const [hueco, datos] of [
      ['logoClaro', logo],
      ['icono', icono],
    ] as [string, Buffer][]) {
      const r = await ctx.app.inject({
        method: 'PUT',
        url: `/api/clients/${clientId}/webmail/marca/imagenes/${hueco}`,
        headers: { cookie: ctx.adminCookie },
        payload: { imagen: `data:image/png;base64,${datos.toString('base64')}` },
      });
      assert.equal(r.statusCode, 200, r.body);
    }
    const marca = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/clients/${clientId}/webmail/marca`,
      headers: { cookie: ctx.adminCookie },
      payload: { nombre: 'Correo de Real', empresa: 'Real S.L.', avisoLegalUrl: 'https://real.test/aviso' },
    });
    assert.equal(marca.statusCode, 200, marca.body);
    await esperarTareasCorreoWeb();
    const estadoSync = leerEstadoSincronizacion();
    assert.equal(estadoSync.error, null, JSON.stringify(estadoSync.error));
    assert.equal(estadoSync.webmails, 2);

    // Lo que ve un navegador en cada webmail del cliente.
    for (const host of hosts) {
      const res = await pedirBulwark('/api/config', host);
      assert.equal(res.status, 200);
      const config1 = JSON.parse(res.cuerpo.toString('utf8')) as Record<string, unknown>;
      assert.equal(config1.appName, 'Correo de Real');
      assert.equal(config1.loginCompanyName, 'Real S.L.');
      assert.equal(config1.loginImprintUrl, 'https://real.test/aviso');
      assert.equal(config1.loginWebsiteUrl, `${PANEL}/mi-buzon`);
      assert.match(String(config1.loginLogoLightUrl), /^\/api\/admin\/branding\/domain__mw-[0-9a-f]{32}__appLogoLightUrl\.png$/);
      const imagen = await pedirBulwark(String(config1.loginLogoLightUrl), host);
      assert.equal(imagen.status, 200);
      assert.equal(imagen.tipo, 'image/png');
      assert.deepEqual(imagen.cuerpo, logo, 'Bulwark sirve los bytes que subió el panel');
      const pwa = await pedirBulwark('/api/pwa-icon/192', host);
      assert.equal(pwa.status, 200, 'Bulwark genera el icono de la aplicación con la imagen subida');
      assert.equal(pwa.tipo, 'image/png');
    }
    // Un nombre sin marca propia sigue con la de la instancia.
    const otro = JSON.parse((await pedirBulwark('/api/config', 'webmail.otro-cliente.test')).cuerpo.toString('utf8')) as Record<string, unknown>;
    assert.notEqual(otro.appName, 'Correo de Real');
    // La política de Mailway (parte pública).
    const politica = JSON.parse((await pedirBulwark('/api/admin/policy', hosts[0]!)).cuerpo.toString('utf8')) as {
      features: Record<string, boolean>;
    };
    assert.equal(politica.features.pluginsEnabled, false);
    assert.equal(politica.features.sidebarAppsEnabled, false);
    assert.equal(politica.features.filesEnabled, false);

    // Segunda pasada sin cambios: ni siquiera habla con Bulwark.
    const sinCambios = await peticionesABulwark(async () => assert.equal((await sincronizarCorreoWeb()).estado, 'al_dia'));
    assert.deepEqual(sinCambios, []);
    // Forzada: lo compara todo, solo lee.
    const auditoriaAntes = auditoriaBulwark();
    let resultado: Awaited<ReturnType<typeof sincronizarCorreoWeb>> | null = null;
    const forzada = await peticionesABulwark(async () => {
      resultado = await sincronizarCorreoWeb({ forzar: true });
    });
    assert.equal(resultado!.estado, 'aplicada');
    assert.equal(resultado!.marcaCambiada, false);
    assert.equal(resultado!.politicaCambiada, false);
    assert.equal(resultado!.imagenesSubidas, 0);
    assert.equal(resultado!.imagenesRetiradas, 0);
    assert.ok(forzada.some((p) => p.ruta === '/api/admin/config'), JSON.stringify(forzada));
    assert.deepEqual(
      forzada.filter((p) => p.metodo !== 'GET'),
      [],
      'la segunda pasada no escribe ni inicia sesión otra vez',
    );
    assert.equal(vistas.filter((p) => p.ruta === '/api/admin/auth').length, 1, 'una sola sesión de administración en toda la prueba');
    if (CONTENEDOR_BULWARK) {
      assert.deepEqual(auditoriaBulwark(), auditoriaAntes, 'Bulwark no anota ningún cambio');
      const deEstaPrueba = auditoriaBulwark().slice(auditoriaPrevia);
      assert.equal(deEstaPrueba.filter((a) => a === 'admin.login').length, 1, 'una sola sesión de administración');
    }

    // El vigilante y el resumen del panel de administración lo ven al día.
    assert.equal(await comprobarSaludBulwark(), true);
    assert.deepEqual(
      listAlerts({}).filter((a) => a.type.startsWith('bulwark_')),
      [],
      'sin avisos del correo web nuevo',
    );
    const panel = await ctx.app.inject({ method: 'GET', url: '/api/dashboard/admin', headers: { cookie: ctx.adminCookie } });
    const resumen = panel.json().bulwark as { salud: { ok: boolean }; enServicio: boolean; clientes: number; sincronizacion: { pendiente: boolean } };
    assert.equal(resumen.salud.ok, true);
    assert.equal(resumen.enServicio, true);
    assert.equal(resumen.clientes, 1);
    assert.equal(resumen.sincronizacion.pendiente, false);
  });

  test('cambiar una imagen retira la anterior de Bulwark', async () => {
    const antes = JSON.parse((await pedirBulwark('/api/config', hosts[0]!)).cuerpo.toString('utf8')) as Record<string, string>;
    const nuevo = pngReal(64, [200, 120, 0]);
    const r = await ctx.app.inject({
      method: 'PUT',
      url: `/api/clients/${clientId}/webmail/marca/imagenes/logoClaro`,
      headers: { cookie: ctx.adminCookie },
      payload: { imagen: `data:image/png;base64,${nuevo.toString('base64')}` },
    });
    assert.equal(r.statusCode, 200);
    await esperarTareasCorreoWeb();
    const despues = JSON.parse((await pedirBulwark('/api/config', hosts[0]!)).cuerpo.toString('utf8')) as Record<string, string>;
    assert.notEqual(despues.loginLogoLightUrl, antes.loginLogoLightUrl);
    assert.deepEqual((await pedirBulwark(despues.loginLogoLightUrl!, hosts[0]!)).cuerpo, nuevo);
    assert.equal((await pedirBulwark(antes.loginLogoLightUrl!, hosts[0]!)).status, 404, 'la versión anterior ya no está');
  });

  test('volver a Roundcube cierra el CORS (en segundo plano) y saca la marca de Bulwark', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/clients/${clientId}/webmail`,
      headers: { cookie: ctx.adminCookie },
      payload: { motor: 'roundcube' },
    });
    assert.equal(res.statusCode, 200);
    await esperarTareasCorreoWeb();
    assert.equal((await ajustesDelMotor()).cors, false);
    assert.equal((await ajustesDelMotor()).caducidad, 3_600_000, 'la caducidad del bloqueo se queda');
    const config1 = JSON.parse((await pedirBulwark('/api/config', hosts[0]!)).cuerpo.toString('utf8')) as Record<string, unknown>;
    assert.notEqual(config1.appName, 'Correo de Real');
    assert.deepEqual(leerEstadoSincronizacion().recursos, []);
  });
});
