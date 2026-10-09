import { test, before, beforeEach, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { dimensionesImagen, tipoDeImagen } from '../src/core/imagenes';
import { getEngine } from '../src/engine';
import { anotarApiDelMotor, olvidarApiDelMotorParaPruebas, ultimaApiDelMotor } from '../src/engine/apiconocida';
import type { EngineSettingsStatus, MailEngine, RecommendedInput } from '../src/engine/types';
import { listAlerts } from '../src/modules/alerts';
import { analizarNombreRecursoBulwark } from '../src/modules/bulwark';
import {
  calcularEstadoDeseado,
  comprobarSaludBulwark,
  esperarTareasCorreoWeb,
  leerEstadoSincronizacion,
  sincronizarCorreoWeb,
  vigilarCorreoWebNuevo,
} from '../src/modules/correoweb';
import { activarMantenimiento, desactivarMantenimiento } from '../src/modules/mantenimiento';
import { deleteSetting, setInstanceSettings } from '../src/modules/settings';
import { runWatchdogOnce } from '../src/modules/watchdog';
import { corsPermisivoNecesario, estadoBulwark } from '../src/modules/webmailmotor';
import { analizarComoBulwark, bulwarkFalso, CONTRASENA, type BulwarkFalso } from './bulwark-falso';
import {
  adminContext,
  cookieFrom,
  createClient,
  createDomain,
  createMailbox,
  type TestContext,
} from './helpers';

/*
 * Correo web por cliente (Roundcube o el nuevo, Bulwark): la elección, la
 * marca con sus imágenes, la sincronización con la API de administración
 * (contra el Bulwark falso de bulwark-falso.ts), el CORS del motor, el
 * vigilante y lo que ven «Mi buzón» y el panel de control.
 *
 * Stalwart 0.16 se simula sobre el motor de demostración: dice que habla
 * JMAP y lleva la cuenta del CORS que le piden los ajustes recomendados.
 */

const HOST = 'mail.mailway.test';
const PANEL = 'https://panel.mailway.test';
const BACKEND = 'http://mailway-bulwark-gw:8080';
let ctx: TestContext;

const bulwarkOriginal = { ...config.bulwark };

function configurarBulwark(url: string, adminPassword = CONTRASENA, backendUrl = BACKEND): void {
  config.bulwark.url = url;
  config.bulwark.adminPassword = adminPassword;
  config.bulwark.backendUrl = backendUrl;
}

function quitarBulwark(): void {
  config.bulwark.url = '';
  config.bulwark.adminPassword = '';
  config.bulwark.backendUrl = '';
}

before(async () => {
  ctx = await adminContext();
  setInstanceSettings({ mailHostname: HOST, panelUrl: PANEL });
});

afterEach(async () => {
  await esperarTareasCorreoWeb();
  Object.assign(config.bulwark, bulwarkOriginal);
  deleteSetting('bulwark_sincronizacion');
  db.prepare(`UPDATE clients SET webmail_motor = 'roundcube'`).run();
  db.prepare(`DELETE FROM alerts WHERE dedupe_key LIKE 'bulwark:%'`).run();
  olvidarApiDelMotorParaPruebas();
});

/* -------------------------------- Ayudas ---------------------------------- */

function como(cookie: string, method: 'GET' | 'PUT' | 'PATCH' | 'DELETE' | 'POST', url: string, payload?: object) {
  return ctx.app.inject({ method, url, headers: { cookie }, payload });
}

function comoAdmin(method: 'GET' | 'PUT' | 'PATCH' | 'DELETE' | 'POST', url: string, payload?: object) {
  return como(ctx.adminCookie, method, url, payload);
}

/** PNG con la cabecera IHDR de las dimensiones dadas; `variante` cambia un byte (otro sha256). */
function png(ancho = 64, alto = 64, variante = 0): Buffer {
  const datos = Buffer.alloc(80);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(datos, 0);
  datos.writeUInt32BE(13, 8);
  datos.write('IHDR', 12, 'latin1');
  datos.writeUInt32BE(ancho, 16);
  datos.writeUInt32BE(alto, 20);
  datos[60] = variante;
  return datos;
}

/** JPEG con una APP0 y un SOF0 de las dimensiones dadas. */
function jpeg(ancho = 120, alto = 40): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(alto, 5);
  sof.writeUInt16BE(ancho, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

/** WebP de los tres tipos de trozo: con pérdida (VP8), sin pérdida (VP8L) y extendido (VP8X). */
function webp(tipo: 'VP8 ' | 'VP8L' | 'VP8X', ancho = 48, alto = 32): Buffer {
  const datos = Buffer.alloc(40);
  datos.write('RIFF', 0, 'latin1');
  datos.writeUInt32LE(32, 4);
  datos.write('WEBP', 8, 'latin1');
  datos.write(tipo, 12, 'latin1');
  datos.writeUInt32LE(20, 16);
  if (tipo === 'VP8 ') {
    datos.set([0x9d, 0x01, 0x2a], 23);
    datos.writeUInt16LE(ancho, 26);
    datos.writeUInt16LE(alto, 28);
  } else if (tipo === 'VP8L') {
    datos[20] = 0x2f;
    datos.writeUInt32LE(((ancho - 1) & 0x3fff) | (((alto - 1) & 0x3fff) << 14), 21);
  } else {
    datos.writeUIntLE(ancho - 1, 24, 3);
    datos.writeUIntLE(alto - 1, 27, 3);
  }
  return datos;
}

function dataUrl(datos: Buffer, tipo = 'image/png'): string {
  return `data:${tipo};base64,${datos.toString('base64')}`;
}

let secuencia = 0;

/** Cliente con un dominio comprobado y sus webmail propios en el estado indicado. */
async function clienteConWebmails(estados: string[] = ['active']): Promise<{ clientId: string; hosts: string[]; domain: string; domainId: string }> {
  const { clientId } = await createClient(ctx, { name: `Correo Cliente ${++secuencia}` });
  const { domain, domainId } = await createDomain(ctx, clientId, `cliente${secuencia}-correoweb.test`);
  const hosts: string[] = [];
  for (const [i, estado] of estados.entries()) {
    const hostname = `${i === 0 ? 'webmail' : `correo${i}`}.${domain}`;
    db.prepare(
      `INSERT INTO client_domains (id, client_id, hostname, kind, status, activated_at, created_at)
       VALUES (?, ?, ?, 'webmail', ?, ?, ?)`,
    ).run(`wld_cw${secuencia}_${i}`, clientId, hostname, estado, estado === 'active' ? Date.now() : null, Date.now());
    hosts.push(hostname);
  }
  return { clientId, hosts, domain, domainId };
}

/**
 * Convierte el motor de demostración en un «Stalwart 0.16» que lleva la cuenta
 * del CORS que le aplican los ajustes recomendados.
 */
function simular016(opciones: { corsInicial?: boolean; fallaAplicar?: boolean } = {}) {
  const crudo = getEngine({ saltarMantenimiento: true }) as MailEngine & Record<string, unknown>;
  const estado = { cors: opciones.corsInicial ?? false, aplicados: [] as RecommendedInput[] };
  crudo.detectApi = async () => 'jmap016';
  // El vigilante y el panel de control hacen ping: también anota la versión.
  crudo.ping = async () => ({ ok: true, api: 'jmap016' });
  crudo.getSettingsStatus = async (input: { trustedNetworks: string[]; permissiveCors?: boolean }): Promise<EngineSettingsStatus> => {
    const deseado = input.permissiveCors ?? false;
    const extra: Record<string, boolean> = { authBanExpiry: true };
    if (deseado || estado.cors) extra.permissiveCors = estado.cors === deseado;
    return {
      api: 'jmap016',
      hostname: HOST,
      forwardedHeaders: true,
      trustedNetworks: input.trustedNetworks,
      acme: null,
      certificateFiles: false,
      extra,
      restartRequired: [],
    };
  };
  crudo.applyRecommended = async (input: RecommendedInput) => {
    estado.aplicados.push(input);
    if (opciones.fallaAplicar) return { errors: ['La recarga ha fallado (simulado).'], warnings: [], restartRequired: [] };
    estado.cors = input.permissiveCors;
    return { errors: [], warnings: [], restartRequired: [] };
  };
  return {
    estado,
    restaurar: () => {
      delete (crudo as Record<string, unknown>).detectApi;
      delete (crudo as Record<string, unknown>).ping;
      delete (crudo as Record<string, unknown>).getSettingsStatus;
      delete (crudo as Record<string, unknown>).applyRecommended;
    },
  };
}

function auditoria(action: string): { client_id: string | null; detail: Record<string, unknown> }[] {
  return (
    db.prepare('SELECT client_id, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as {
      client_id: string | null;
      detail: string;
    }[]
  ).map((r) => ({ client_id: r.client_id, detail: JSON.parse(r.detail) as Record<string, unknown> }));
}

/* ------------------------------- Migración -------------------------------- */

test('migración 015: el correo web de cada cliente empieza en Roundcube y solo admite los dos valores', async () => {
  const { clientId } = await createClient(ctx);
  assert.equal((db.prepare('SELECT webmail_motor FROM clients WHERE id = ?').get(clientId) as { webmail_motor: string }).webmail_motor, 'roundcube');
  assert.throws(() => db.prepare(`UPDATE clients SET webmail_motor = 'otro' WHERE id = ?`).run(clientId), /CHECK/);
  // La ficha del cliente lo enseña.
  const ficha = await comoAdmin('GET', `/api/clients/${clientId}`);
  assert.equal(ficha.json().client.webmailMotor, 'roundcube');

  // Las imágenes solo en sus cuatro huecos y con sus tres tipos; se van con el cliente.
  assert.throws(
    () =>
      db.prepare(
        `INSERT INTO webmail_marca_imagenes (client_id, hueco, mime, data, sha256, ancho, alto, updated_at)
         VALUES (?, 'fondo', 'image/png', x'00', 'x', 1, 1, 1)`,
      ).run(clientId),
    /CHECK/,
  );
  assert.throws(
    () =>
      db.prepare(
        `INSERT INTO webmail_marca_imagenes (client_id, hueco, mime, data, sha256, ancho, alto, updated_at)
         VALUES (?, 'favicon', 'image/svg+xml', x'00', 'x', 1, 1, 1)`,
      ).run(clientId),
    /CHECK/,
  );
  await comoAdmin('PATCH', `/api/clients/${clientId}/webmail/marca`, { nombre: 'Correo de prueba' });
  await comoAdmin('PUT', `/api/clients/${clientId}/webmail/marca/imagenes/favicon`, { imagen: dataUrl(png()) });
  assert.equal((await comoAdmin('DELETE', `/api/clients/${clientId}`)).statusCode, 200);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM webmail_marca WHERE client_id = ?').get(clientId) as { c: number }).c, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM webmail_marca_imagenes WHERE client_id = ?').get(clientId) as { c: number }).c, 0);
});

/* -------------------------------- Imágenes -------------------------------- */

describe('imágenes de marca: tipo y tamaño por el contenido', () => {
  test('tipoDeImagen y dimensionesImagen leen PNG, JPEG y los tres WebP', () => {
    assert.equal(tipoDeImagen(png()), 'image/png');
    assert.deepEqual(dimensionesImagen(png(200, 50), 'image/png'), { ancho: 200, alto: 50 });
    assert.equal(tipoDeImagen(jpeg()), 'image/jpeg');
    assert.deepEqual(dimensionesImagen(jpeg(320, 90), 'image/jpeg'), { ancho: 320, alto: 90 });
    for (const tipo of ['VP8 ', 'VP8L', 'VP8X'] as const) {
      assert.equal(tipoDeImagen(webp(tipo)), 'image/webp', tipo);
      assert.deepEqual(dimensionesImagen(webp(tipo, 300, 120), 'image/webp'), { ancho: 300, alto: 120 }, tipo);
    }
    assert.equal(tipoDeImagen(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.equal(tipoDeImagen(Buffer.from('GIF89a......')), null);
    // Cabeceras rotas: sin dimensiones.
    assert.equal(dimensionesImagen(png().subarray(0, 20), 'image/png'), null);
    assert.equal(dimensionesImagen(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]), 'image/jpeg'), null);
  });

  test('la ruta acepta PNG, JPEG y WebP y rechaza SVG, GIF, lo que no cabe y lo desproporcionado', async () => {
    const { clientId } = await createClient(ctx);
    const url = `/api/clients/${clientId}/webmail/marca/imagenes/logoClaro`;
    for (const [datos, tipo] of [
      [png(400, 100), 'image/png'],
      [jpeg(400, 100), 'image/jpeg'],
      [webp('VP8X', 400, 100), 'image/webp'],
    ] as [Buffer, string][]) {
      const res = await comoAdmin('PUT', url, { imagen: dataUrl(datos, tipo) });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().imagen.tipo, tipo);
      assert.equal(res.json().imagen.ancho, 400);
    }
    const casos: [string, string, string][] = [
      ['SVG', dataUrl(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml'), 'invalid_image'],
      ['SVG que se declara PNG', dataUrl(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png'), 'invalid_image'],
      ['GIF', dataUrl(Buffer.from('GIF89a\u0001\u0000\u0001\u0000'), 'image/gif'), 'invalid_image'],
      ['texto sin data URL', 'https://otro.test/logo.png', 'invalid_image'],
      ['demasiado grande', dataUrl(Buffer.concat([png(), Buffer.alloc(512 * 1024)])), 'image_too_large'],
      ['demasiado pequeña', dataUrl(png(8, 8)), 'image_dimensions'],
      ['desproporcionada', dataUrl(png(100_000, 100_000)), 'image_dimensions'],
    ];
    for (const [nombre, imagen, code] of casos) {
      const res = await comoAdmin('PUT', url, { imagen });
      assert.equal(res.statusCode, 400, `${nombre}: ${res.body}`);
      assert.equal(res.json().code, code, nombre);
      assert.ok(typeof res.json().error === 'string' && res.json().error.length > 0);
    }
    // Un hueco que no existe.
    const otro = await comoAdmin('PUT', `/api/clients/${clientId}/webmail/marca/imagenes/fondo`, { imagen: dataUrl(png()) });
    assert.equal(otro.statusCode, 404);
    assert.equal(otro.json().code, 'brand_slot_not_found');

    // Se sirve con las cabeceras que impiden interpretarla como otra cosa.
    const vista = await comoAdmin('GET', url);
    assert.equal(vista.statusCode, 200);
    assert.equal(vista.headers['content-type'], 'image/webp');
    assert.equal(vista.headers['x-content-type-options'], 'nosniff');
    assert.equal(vista.headers['content-security-policy'], "default-src 'none'");
    // Y se quita.
    assert.equal((await comoAdmin('DELETE', url)).statusCode, 200);
    assert.equal((await comoAdmin('GET', url)).statusCode, 404);
    assert.deepEqual(
      auditoria('client.webmail_brand_image_updated').filter((a) => a.client_id === clientId).map((a) => a.detail.type),
      ['image/png', 'image/jpeg', 'image/webp'],
    );
    assert.equal(auditoria('client.webmail_brand_image_removed').filter((a) => a.client_id === clientId).length, 1);
  });
});

/* --------------------------------- Guardas -------------------------------- */

describe('quién puede hacer qué', () => {
  test('la marca la edita el propio cliente o la administración; nunca otro cliente', async () => {
    const a = await createClient(ctx, { withUser: true });
    const b = await createClient(ctx, { withUser: true });
    const propia = await como(a.userCookie!, 'PATCH', `/api/clients/${a.clientId}/webmail/marca`, {
      nombre: 'Correo de A',
      empresa: 'A S.L.',
      privacidadUrl: 'https://a.test/privacidad',
    });
    assert.equal(propia.statusCode, 200, propia.body);
    assert.equal(propia.json().marca.nombre, 'Correo de A');
    for (const [method, url, payload] of [
      ['PATCH', `/api/clients/${a.clientId}/webmail/marca`, { nombre: 'Intruso' }],
      ['PUT', `/api/clients/${a.clientId}/webmail/marca/imagenes/favicon`, { imagen: dataUrl(png()) }],
      ['DELETE', `/api/clients/${a.clientId}/webmail/marca/imagenes/favicon`, undefined],
      ['GET', `/api/clients/${a.clientId}/webmail/marca/imagenes/favicon`, undefined],
      ['GET', `/api/clients/${a.clientId}/webmail`, undefined],
    ] as ['PATCH' | 'PUT' | 'DELETE' | 'GET', string, object | undefined][]) {
      const res = await como(b.userCookie!, method, url, payload);
      assert.equal(res.statusCode, 403, `${method} ${url}`);
      assert.equal(res.json().code, 'forbidden');
    }
    assert.equal((await comoAdmin('GET', `/api/clients/${a.clientId}/webmail`)).json().marca.nombre, 'Correo de A');
    // Auditoría en la actividad del cliente, sin valores.
    const anotacion = auditoria('client.webmail_brand_updated').find((x) => x.client_id === a.clientId);
    assert.deepEqual(anotacion?.detail.fields, ['nombre', 'empresa', 'privacidadUrl']);
  });

  test('el cliente no elige el correo web, ni con su sesión ni con su token; tampoco ve lo de la instancia', async () => {
    configurarBulwark('http://mailway-bulwark:3000');
    const a = await createClient(ctx, { withUser: true });
    const sesion = await como(a.userCookie!, 'PUT', `/api/clients/${a.clientId}/webmail`, { motor: 'bulwark' });
    assert.equal(sesion.statusCode, 403);
    const token = await como(a.userCookie!, 'POST', '/api/tokens', { name: 'Integración del cliente' });
    assert.equal(token.statusCode, 200, token.body);
    const conToken = await ctx.app.inject({
      method: 'PUT',
      url: `/api/clients/${a.clientId}/webmail`,
      headers: { authorization: `Bearer ${(token.json() as { token: string }).token}` },
      payload: { motor: 'bulwark' },
    });
    assert.equal(conToken.statusCode, 403);
    assert.equal(conToken.json().code, 'forbidden');
    assert.equal((db.prepare('SELECT webmail_motor FROM clients WHERE id = ?').get(a.clientId) as { webmail_motor: string }).webmail_motor, 'roundcube');

    const vista = await como(a.userCookie!, 'GET', `/api/clients/${a.clientId}/webmail`);
    assert.equal(vista.statusCode, 200);
    assert.equal(vista.json().motor, 'roundcube');
    assert.equal('bulwark' in vista.json(), false, 'el cliente no ve el estado de la instalación');
    assert.equal('bulwark' in (await comoAdmin('GET', `/api/clients/${a.clientId}/webmail`)).json(), true);
  });

  test('validación de la marca: largos, controles y enlaces que no son https', async () => {
    const { clientId } = await createClient(ctx);
    const url = `/api/clients/${clientId}/webmail/marca`;
    for (const cuerpo of [
      { nombre: 'x'.repeat(61) },
      { nombreCorto: 'x'.repeat(31) },
      { empresa: 'Empresa\u0007' },
      { privacidadUrl: 'http://cliente.test/privacidad' },
      { avisoLegalUrl: 'javascript:alert(1)' },
      { avisoLegalUrl: 'https://usuario:clave@cliente.test/aviso' },
      { nombre: 7 },
    ]) {
      const res = await comoAdmin('PATCH', url, cuerpo);
      assert.equal(res.statusCode, 400, JSON.stringify(cuerpo));
      assert.equal(res.json().code, 'validation');
      assert.ok(/[áéíóúñ]|debe|puede|demasiado/i.test(res.json().error), res.json().error);
    }
    // Vacío = valor por defecto (el nombre del cliente).
    const res = await comoAdmin('PATCH', url, { nombre: '' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().marca.nombre, '');
    assert.match(res.json().marca.nombrePorDefecto, /^Cliente /);
  });
});

/* --------------------------- Elección del motor --------------------------- */

describe('elegir el correo web', () => {
  test('sin Bulwark instalado (o a medias), 409 bulwark_unavailable; volver a Roundcube siempre se puede', async () => {
    const { clientId } = await createClient(ctx);
    quitarBulwark();
    let res = await comoAdmin('PUT', `/api/clients/${clientId}/webmail`, { motor: 'bulwark' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'bulwark_unavailable');
    assert.match(res.json().error, /no está instalado/);

    // A medias: falta el destino de Traefik.
    configurarBulwark('http://mailway-bulwark:3000', CONTRASENA, '');
    res = await comoAdmin('PUT', `/api/clients/${clientId}/webmail`, { motor: 'bulwark' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'bulwark_unavailable');
    assert.match(res.json().error, /MAILWAY_BULWARK_BACKEND_URL/);
    assert.equal(estadoBulwark().configurado, true);

    res = await comoAdmin('PUT', `/api/clients/${clientId}/webmail`, { motor: 'roundcube' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().motor, 'roundcube');
    res = await comoAdmin('PUT', `/api/clients/${clientId}/webmail`, { motor: 'otro' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'validation');
  });

  test('con el motor 0.15 (o el de demostración), 409 bulwark_requires_016', async () => {
    configurarBulwark('http://mailway-bulwark:3000');
    const { clientId } = await createClient(ctx);
    const crudo = getEngine({ saltarMantenimiento: true }) as MailEngine & Record<string, unknown>;
    crudo.detectApi = async () => 'rest015';
    try {
      const res = await comoAdmin('PUT', `/api/clients/${clientId}/webmail`, { motor: 'bulwark' });
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().code, 'bulwark_requires_016');
      assert.equal(ultimaApiDelMotor(), 'rest015', 'la versión averiguada queda anotada');
      const vista = (await comoAdmin('GET', `/api/clients/${clientId}/webmail`)).json();
      assert.equal(vista.bulwark.disponible, true);
      assert.equal(vista.bulwark.motor016, false);
    } finally {
      delete (crudo as Record<string, unknown>).detectApi;
    }
    const demo = await comoAdmin('PUT', `/api/clients/${clientId}/webmail`, { motor: 'bulwark' });
    assert.equal(demo.json().code, 'bulwark_requires_016');
  });

  test('el primer cliente abre el CORS antes de guardarse; el segundo no lo toca; el último que vuelve lo cierra', async () => {
    configurarBulwark('http://mailway-bulwark:3000');
    const motor = simular016();
    try {
      const a = await createClient(ctx);
      const b = await createClient(ctx);
      assert.equal(corsPermisivoNecesario(), false);

      let res = await comoAdmin('PUT', `/api/clients/${a.clientId}/webmail`, { motor: 'bulwark' });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().motor, 'bulwark');
      assert.equal(res.json().enServicio, 'bulwark');
      assert.equal(motor.estado.aplicados.length, 1);
      assert.equal(motor.estado.aplicados[0]!.permissiveCors, true);
      assert.equal(motor.estado.aplicados[0]!.hostname, HOST);
      assert.equal(motor.estado.cors, true);
      assert.equal(corsPermisivoNecesario(), true);
      const anotado = auditoria('client.webmail_changed').at(-1)!;
      assert.equal(anotado.client_id, a.clientId);
      assert.deepEqual(anotado.detail, { webmail: 'bulwark', previous: 'roundcube', corsApplied: true });

      res = await comoAdmin('PUT', `/api/clients/${b.clientId}/webmail`, { motor: 'bulwark' });
      assert.equal(res.statusCode, 200);
      assert.equal(motor.estado.aplicados.length, 1, 'con el CORS ya abierto no se vuelven a aplicar los ajustes');
      assert.equal(auditoria('client.webmail_changed').at(-1)!.detail.corsApplied, false);

      // Vuelve uno: el otro sigue necesitándolo.
      await comoAdmin('PUT', `/api/clients/${a.clientId}/webmail`, { motor: 'roundcube' });
      await esperarTareasCorreoWeb();
      assert.equal(motor.estado.cors, true);
      // Vuelve el último: se cierra en segundo plano.
      res = await comoAdmin('PUT', `/api/clients/${b.clientId}/webmail`, { motor: 'roundcube' });
      assert.equal(res.statusCode, 200);
      await esperarTareasCorreoWeb();
      assert.equal(motor.estado.cors, false);
      assert.equal(motor.estado.aplicados.at(-1)!.permissiveCors, false);
      assert.equal(auditoria('engine.recommended_applied').at(-1)!.detail.permissiveCors, false);
    } finally {
      motor.restaurar();
    }
  });

  test('si el CORS no se puede abrir, el cliente sigue con Roundcube (502 bulwark_cors_failed)', async () => {
    configurarBulwark('http://mailway-bulwark:3000');
    const motor = simular016({ fallaAplicar: true });
    try {
      const { clientId } = await createClient(ctx);
      const res = await comoAdmin('PUT', `/api/clients/${clientId}/webmail`, { motor: 'bulwark' });
      assert.equal(res.statusCode, 502);
      assert.equal(res.json().code, 'bulwark_cors_failed');
      assert.match(res.json().error, /sigue con Roundcube/);
      assert.equal((db.prepare('SELECT webmail_motor FROM clients WHERE id = ?').get(clientId) as { webmail_motor: string }).webmail_motor, 'roundcube');
    } finally {
      motor.restaurar();
    }
  });

  test('durante el mantenimiento del motor no se elige el nuevo (503)', async () => {
    configurarBulwark('http://mailway-bulwark:3000');
    const { clientId } = await createClient(ctx);
    activarMantenimiento(5);
    try {
      const res = await comoAdmin('PUT', `/api/clients/${clientId}/webmail`, { motor: 'bulwark' });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().code, 'engine_maintenance');
      assert.equal((await comoAdmin('PUT', `/api/clients/${clientId}/webmail`, { motor: 'roundcube' })).statusCode, 200);
    } finally {
      desactivarMantenimiento();
    }
  });
});

/* ----------------------------- Sincronización ----------------------------- */

describe('sincronización con Bulwark', () => {
  let falso: BulwarkFalso;
  beforeEach(async () => {
    falso = await bulwarkFalso();
    configurarBulwark(falso.url);
    anotarApiDelMotor('jmap016');
  });

  async function clienteConBulwark(estados?: string[]) {
    const datos = await clienteConWebmails(estados);
    db.prepare(`UPDATE clients SET webmail_motor = 'bulwark' WHERE id = ?`).run(datos.clientId);
    return datos;
  }

  test('marca, imágenes y política en Bulwark con una sola sesión; la segunda pasada no escribe nada', async () => {
    const { clientId, hosts } = await clienteConBulwark(['active', 'active', 'pending_dns']);
    const otro = await clienteConWebmails(['active']); // con Roundcube: no lleva marca en Bulwark
    await comoAdmin('PATCH', `/api/clients/${clientId}/webmail/marca`, { empresa: 'Empresa Uno S.L.', avisoLegalUrl: 'https://uno.test/aviso' });
    await comoAdmin('PUT', `/api/clients/${clientId}/webmail/marca/imagenes/logoClaro`, { imagen: dataUrl(png(300, 80, 1)) });
    await comoAdmin('PUT', `/api/clients/${clientId}/webmail/marca/imagenes/icono`, { imagen: dataUrl(png(512, 512, 2)) });
    await esperarTareasCorreoWeb();

    const marca = analizarComoBulwark(falso.marca);
    assert.deepEqual(marca.map((e) => e.host), [hosts[1], hosts[0]].sort(), 'solo los webmail en servicio del cliente con Bulwark');
    assert.ok(!marca.some((e) => e.host === otro.hosts[0]));
    const entrada = marca.find((e) => e.host === hosts[0])!;
    assert.equal(entrada.appName, (db.prepare('SELECT name FROM clients WHERE id = ?').get(clientId) as { name: string }).name);
    assert.equal(entrada.loginCompanyName, 'Empresa Uno S.L.');
    assert.equal(entrada.appDescription, 'Correo web de Empresa Uno S.L.');
    assert.equal(entrada.loginImprintUrl, 'https://uno.test/aviso');
    assert.equal(entrada.loginWebsiteUrl, `${PANEL}/mi-buzon`);
    // El logotipo claro también para el oscuro y para la pantalla de acceso; el icono, aparte.
    assert.match(entrada.appLogoLightUrl!, /^\/api\/admin\/branding\/domain__mw-[0-9a-f]{32}__appLogoLightUrl\.png$/);
    assert.equal(entrada.appLogoDarkUrl, entrada.appLogoLightUrl);
    assert.equal(entrada.loginLogoLightUrl, entrada.appLogoLightUrl);
    assert.match(entrada.pwaIconUrl!, /__pwaIconUrl\.png$/);
    assert.equal(entrada.faviconUrl, undefined);
    // Los ficheros que nombra la marca existen en Bulwark con los bytes del panel.
    for (const url of [entrada.appLogoLightUrl!, entrada.pwaIconUrl!]) {
      const nombre = url.split('/').pop()!;
      assert.ok(analizarNombreRecursoBulwark(nombre));
      assert.ok(falso.ficheros.has(nombre), nombre);
    }
    assert.equal(falso.ficheros.size, 2);
    // La política de Mailway, con «Mi buzón» de la instancia.
    assert.equal((falso.politica.features as Record<string, unknown>).pluginsEnabled, false);
    assert.deepEqual((falso.politica.defaultSidebarApps as { url: string }[]).map((a) => a.url), [`${PANEL}/mi-buzon`]);
    assert.equal(falso.inicios, 1, 'un solo inicio de sesión para todos los cambios');

    // Al día: ni siquiera se habla con Bulwark.
    const antes = falso.llamadas.length;
    assert.equal((await sincronizarCorreoWeb()).estado, 'al_dia');
    assert.equal(falso.llamadas.length, antes);

    // Forzada: compara todo, pero no escribe nada y reutiliza la sesión.
    const escriturasAntes = falso.escrituras().length;
    const forzada = await sincronizarCorreoWeb({ forzar: true });
    assert.equal(forzada.estado, 'aplicada');
    assert.equal(forzada.marcaCambiada, false);
    assert.equal(forzada.politicaCambiada, false);
    assert.equal(forzada.imagenesSubidas, 0);
    assert.equal(forzada.imagenesRetiradas, 0);
    assert.equal(falso.escrituras().length, escriturasAntes);
    assert.equal(falso.inicios, 1);

    // Auditoría del sistema solo con recuentos.
    const sincronizada = auditoria('bulwark.synced');
    assert.ok(sincronizada.length >= 1);
    for (const { detail } of sincronizada) {
      for (const valor of Object.values(detail)) assert.ok(typeof valor === 'number' || typeof valor === 'boolean', JSON.stringify(detail));
    }
  });

  test('cambiar una imagen sube la nueva, retira la anterior y la marca la sigue; quitar Bulwark limpia', async () => {
    const { clientId, hosts } = await clienteConBulwark();
    await comoAdmin('PUT', `/api/clients/${clientId}/webmail/marca/imagenes/favicon`, { imagen: dataUrl(png(32, 32, 7)) });
    await esperarTareasCorreoWeb();
    const primera = analizarComoBulwark(falso.marca).find((e) => e.host === hosts[0])!.faviconUrl!;
    await comoAdmin('PUT', `/api/clients/${clientId}/webmail/marca/imagenes/favicon`, { imagen: dataUrl(png(32, 32, 8)) });
    await esperarTareasCorreoWeb();
    const segunda = analizarComoBulwark(falso.marca).find((e) => e.host === hosts[0])!.faviconUrl!;
    assert.notEqual(segunda, primera, 'otra imagen, otra dirección');
    assert.deepEqual([...falso.ficheros.keys()], [segunda.split('/').pop()]);
    assert.equal(falso.llamadas.filter((l) => l.metodo === 'DELETE').length, 1);
    assert.deepEqual(leerEstadoSincronizacion().recursos, [segunda.split('/').pop()]);

    // Vuelve a Roundcube: su marca y sus imágenes salen de Bulwark.
    await comoAdmin('PUT', `/api/clients/${clientId}/webmail`, { motor: 'roundcube' });
    await esperarTareasCorreoWeb();
    assert.deepEqual(analizarComoBulwark(falso.marca), []);
    assert.equal(falso.ficheros.size, 0);
    assert.deepEqual(leerEstadoSincronizacion().recursos, []);
    assert.equal(falso.inicios, 1);
  });

  test('un webmail que entra o sale de servicio se sincroniza sin esperar al vigilante', async () => {
    const { clientId, hosts } = await clienteConBulwark(['active', 'issuing']);
    assert.equal((await sincronizarCorreoWeb()).estado, 'aplicada');
    assert.deepEqual(analizarComoBulwark(falso.marca).map((e) => e.host), [hosts[0]]);
    const { applyClientDomainCheck } = await import('../src/modules/whitelabel');
    applyClientDomainCheck(`wld_cw${secuencia}_1`, { status: 'ok', detail: 'ok' }, { ok: true, detail: 'HTTPS responde' });
    await new Promise((r) => setTimeout(r, 50));
    await esperarTareasCorreoWeb();
    assert.deepEqual(analizarComoBulwark(falso.marca).map((e) => e.host).sort(), [...hosts].sort());
    // Borrado a mano: también.
    const borrado = await comoAdmin('DELETE', `/api/whitelabel/domains/wld_cw${secuencia}_0`);
    assert.equal(borrado.statusCode, 200);
    await new Promise((r) => setTimeout(r, 50));
    await esperarTareasCorreoWeb();
    assert.deepEqual(analizarComoBulwark(falso.marca).map((e) => e.host), [hosts[1]]);
    assert.ok(clientId);
  });

  test('si Bulwark limita los inicios de sesión, espera lo que pide y después reintenta', async () => {
    await clienteConBulwark();
    falso.limite = 0;
    const t0 = Date.now();
    const fallo = await sincronizarCorreoWeb({ ahora: t0 });
    assert.equal(fallo.estado, 'error');
    assert.equal(fallo.error?.codigo, 'bulwark_limite');
    assert.equal(fallo.reintentarDesde, t0 + 612_000);
    assert.equal(leerEstadoSincronizacion().fallosSeguidos, 1);

    // Antes de tiempo, ni se intenta (no gasta otro inicio).
    const llamadas = falso.llamadas.length;
    const espera = await sincronizarCorreoWeb({ ahora: t0 + 600_000 });
    assert.equal(espera.estado, 'pendiente');
    assert.equal(falso.llamadas.length, llamadas);
    // El vigilante tampoco.
    await vigilarCorreoWebNuevo();
    assert.equal(falso.llamadas.filter((l) => l.ruta === '/api/admin/auth').length, 1);

    falso.limite = 100;
    const despues = await sincronizarCorreoWeb({ ahora: t0 + 612_000 });
    assert.equal(despues.estado, 'aplicada');
    assert.equal(leerEstadoSincronizacion().fallosSeguidos, 0);
    assert.equal(leerEstadoSincronizacion().reintentarDesde, null);
  });

  test('fallos seguidos: espera creciente, aviso bulwark:marca al tercero y se cierra al recuperarse', async () => {
    await clienteConBulwark();
    configurarBulwark(falso.url, 'otra-clave-que-no-es-la-buena');
    let t = Date.now();
    for (let i = 1; i <= 3; i++) {
      const r = await sincronizarCorreoWeb({ ahora: t });
      assert.equal(r.estado, 'error');
      assert.equal(r.error?.codigo, 'bulwark_credenciales');
      assert.ok(!r.error!.mensaje.includes('otra-clave-que-no-es-la-buena'), 'sin la contraseña en el error');
      assert.equal(r.reintentarDesde, t + 60_000 * 2 ** (i - 1));
      const aviso = listAlerts({}).find((a) => a.type === 'bulwark_marca' && a.resolvedAt === null);
      assert.equal(Boolean(aviso), i >= 3, `fallo ${i}`);
      t = r.reintentarDesde!;
    }
    configurarBulwark(falso.url);
    assert.equal((await sincronizarCorreoWeb({ ahora: t })).estado, 'aplicada');
    assert.equal(listAlerts({}).find((a) => a.type === 'bulwark_marca' && a.resolvedAt === null), undefined);
  });

  test('si el motor vuelve a 0.15, la marca de sus clientes sale de Bulwark (sus webmail vuelven a Roundcube)', async () => {
    await clienteConBulwark();
    assert.equal((await sincronizarCorreoWeb()).estado, 'aplicada');
    assert.equal(analizarComoBulwark(falso.marca).length, 1);
    anotarApiDelMotor('rest015');
    assert.equal(calcularEstadoDeseado().marca.length, 0);
    assert.equal((await sincronizarCorreoWeb()).estado, 'aplicada');
    assert.deepEqual(analizarComoBulwark(falso.marca), []);
  });

  test('una marca que Bulwark descartaría deja solo a ese cliente con la de la instancia', async () => {
    const malo = await clienteConBulwark();
    const bueno = await clienteConBulwark();
    // Un dato inválido colado por debajo de las rutas (que lo validan).
    db.prepare(`INSERT INTO webmail_marca (client_id, aviso_legal_url, updated_at) VALUES (?, 'http://inseguro.test', 1)`).run(malo.clientId);
    const deseado = calcularEstadoDeseado();
    assert.deepEqual(deseado.descartados, [malo.clientId]);
    assert.deepEqual(deseado.marca.map((e) => e.host), bueno.hosts);
    assert.equal((await sincronizarCorreoWeb()).estado, 'aplicada');
    assert.deepEqual(analizarComoBulwark(falso.marca).map((e) => e.host), bueno.hosts);
  });
});

/* -------------------------------- Vigilante ------------------------------- */

describe('vigilante del correo web nuevo', () => {
  test('salud: aviso bulwark:salud al segundo fallo seguido y se cierra al responder', async () => {
    const falso = await bulwarkFalso();
    configurarBulwark(falso.url);
    falso.enfermo = true;
    assert.equal(await comprobarSaludBulwark(), false);
    assert.equal(listAlerts({}).find((a) => a.type === 'bulwark_salud' && a.resolvedAt === null), undefined, 'un fallo suelto no avisa');
    assert.equal(await comprobarSaludBulwark(), false);
    const aviso = listAlerts({}).find((a) => a.type === 'bulwark_salud' && a.resolvedAt === null);
    assert.ok(aviso);
    assert.equal(aviso.severity, 'critical');
    falso.enfermo = false;
    assert.equal(await comprobarSaludBulwark(), true);
    assert.equal(listAlerts({}).find((a) => a.type === 'bulwark_salud' && a.resolvedAt === null), undefined);
  });

  test('a medias avisa; sin configurar no hace nada', async () => {
    configurarBulwark('http://mailway-bulwark:3000', '', BACKEND);
    assert.equal(await comprobarSaludBulwark(), false);
    const aviso = listAlerts({}).find((a) => a.type === 'bulwark_salud' && a.resolvedAt === null);
    assert.match(aviso?.message ?? '', /MAILWAY_BULWARK_ADMIN_PASSWORD/);
    quitarBulwark();
    assert.equal(await comprobarSaludBulwark(), false);
    assert.equal(listAlerts({}).find((a) => a.type === 'bulwark_salud' && a.resolvedAt === null), undefined);
  });

  test('el vigilante sincroniza lo pendiente, pero nada durante el mantenimiento del motor', async () => {
    const falso = await bulwarkFalso();
    configurarBulwark(falso.url);
    const motor = simular016();
    try {
      const { clientId } = await clienteConWebmails();
      db.prepare(`UPDATE clients SET webmail_motor = 'bulwark' WHERE id = ?`).run(clientId);
      activarMantenimiento(5);
      try {
        await runWatchdogOnce();
        assert.equal(falso.llamadas.length, 0, 'durante el mantenimiento no se habla con Bulwark');
      } finally {
        desactivarMantenimiento();
      }
      await runWatchdogOnce();
      assert.ok(falso.llamadas.some((l) => l.ruta === '/api/health'));
      assert.equal(analizarComoBulwark(falso.marca).length, 1);
      assert.equal(leerEstadoSincronizacion().error, null);
    } finally {
      motor.restaurar();
    }
  });
});

/* ------------------------ «Mi buzón» y panel de control ------------------------ */

test('«Mi buzón»: tras cambiar la contraseña, aviso de cerrar el correo web solo si es el nuevo', async () => {
  configurarBulwark('http://mailway-bulwark:3000');
  anotarApiDelMotor('jmap016');
  const { clientId, domainId } = await clienteConWebmails(['active']);
  const buzon = await createMailbox(ctx, domainId);
  const entrar = async (password: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/portal/login',
      payload: { email: buzon.email, password },
      remoteAddress: `198.51.100.${++secuencia % 250}`,
    });
    assert.equal(res.statusCode, 200, res.body);
    return cookieFrom(res);
  };
  let cookie = await entrar(buzon.password);
  assert.equal((await como(cookie, 'GET', '/api/portal/me')).json().newWebmail, false);
  let cambio = await como(cookie, 'POST', '/api/portal/password', { current: buzon.password, next: 'Contraseña-Nueva-1' });
  assert.equal(cambio.statusCode, 200, cambio.body);
  assert.equal(cambio.json().reopenWebmail, false, 'con Roundcube no hace falta');

  db.prepare(`UPDATE clients SET webmail_motor = 'bulwark' WHERE id = ?`).run(clientId);
  cookie = await entrar('Contraseña-Nueva-1');
  assert.equal((await como(cookie, 'GET', '/api/portal/me')).json().newWebmail, true);
  cambio = await como(cookie, 'POST', '/api/portal/password', { current: 'Contraseña-Nueva-1', next: 'Contraseña-Nueva-2' });
  assert.equal(cambio.json().reopenWebmail, true);

  // Con el motor 0.15 sus webmail van a Roundcube: sin aviso.
  anotarApiDelMotor('rest015');
  cookie = await entrar('Contraseña-Nueva-2');
  assert.equal((await como(cookie, 'GET', '/api/portal/me')).json().newWebmail, false);
});

test('panel de control: el estado del correo web nuevo solo si está configurado', async () => {
  quitarBulwark();
  assert.equal((await comoAdmin('GET', '/api/dashboard/admin')).json().bulwark, null);
  const falso = await bulwarkFalso();
  configurarBulwark(falso.url);
  const motor = simular016();
  try {
    const { clientId } = await clienteConWebmails(['active']);
    db.prepare(`UPDATE clients SET webmail_motor = 'bulwark' WHERE id = ?`).run(clientId);
    let resumen = (await comoAdmin('GET', '/api/dashboard/admin')).json().bulwark;
    assert.equal(resumen.disponible, true);
    assert.equal(resumen.enServicio, true);
    assert.equal(resumen.salud.ok, true);
    assert.equal(resumen.clientes, 1);
    assert.equal(resumen.sincronizacion.pendiente, true);
    await sincronizarCorreoWeb();
    resumen = (await comoAdmin('GET', '/api/dashboard/admin')).json().bulwark;
    assert.equal(resumen.sincronizacion.pendiente, false);
    assert.equal(resumen.sincronizacion.error, null);
    falso.enfermo = true;
    resumen = (await comoAdmin('GET', '/api/dashboard/admin')).json().bulwark;
    assert.equal(resumen.salud.ok, false);
    assert.match(resumen.salud.detalle, /503/);
  } finally {
    motor.restaurar();
  }
});
