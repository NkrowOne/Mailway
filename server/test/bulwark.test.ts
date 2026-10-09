import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { HttpError } from '../src/core/errors';
import {
  analizarNombreRecursoBulwark,
  asegurarRecursosBulwark,
  ClienteAdminBulwark,
  ErrorBulwark,
  ID_APP_MI_BUZON,
  huellaBulwark,
  marcaPorHostBulwark,
  necesitaSincronizarBulwark,
  normalizarMarcaBulwark,
  politicaBulwark,
  politicaCoincide,
  recursoMarcaBulwark,
  sincronizarBulwark,
  type WebmailConMarca,
} from '../src/modules/bulwark';
import { analizarComoBulwark, bulwarkFalso, CONTRASENA } from './bulwark-falso';

const RAIZ = path.resolve(__dirname, '../..');
const leer = (relativa: string) => fs.readFileSync(path.join(RAIZ, relativa), 'utf8');

async function error(promesa: Promise<unknown>): Promise<HttpError> {
  try {
    await promesa;
  } catch (err) {
    assert.ok(err instanceof HttpError, `se esperaba HttpError: ${String(err)}`);
    return err;
  }
  assert.fail('se esperaba un error');
}

function sinSecretos(err: Error, ...secretos: string[]): void {
  const textoCompleto = `${err.message} ${String(err)} ${JSON.stringify(err)}`;
  for (const secreto of secretos) assert.ok(!textoCompleto.includes(secreto), 'el error no debe contener secretos');
}

const CLIENTE_A: WebmailConMarca = {
  host: 'Webmail.Cliente-A.test.',
  nombre: ' Correo de Cliente A ',
  empresa: 'Cliente A S.L.',
  logoClaroUrl: 'https://panel.mailway.test/api/public/marca/a/logo.svg',
  faviconUrl: '/api/admin/branding/domain__webmail.cliente-a.test__faviconUrl.png',
  colorTema: '#0D5C5E',
  miBuzonUrl: 'https://panel.cliente-a.test/mi-buzon',
};
const CLIENTE_B: WebmailConMarca = { host: 'webmail.b-cliente.test', nombre: 'Correo B' };

/* ----------------------------------- Marca ----------------------------------- */

test('marcaPorHostBulwark: campos de Bulwark, logotipos y orden por nombre', () => {
  const marca = marcaPorHostBulwark([CLIENTE_A, CLIENTE_B]);
  assert.deepEqual(marca, [
    { host: 'webmail.b-cliente.test', appName: 'Correo B' },
    {
      host: 'webmail.cliente-a.test',
      appName: 'Correo de Cliente A',
      faviconUrl: '/api/admin/branding/domain__webmail.cliente-a.test__faviconUrl.png',
      pwaThemeColor: '#0d5c5e',
      // Sin logotipo oscuro, el claro también en modo oscuro.
      appLogoLightUrl: 'https://panel.mailway.test/api/public/marca/a/logo.svg',
      appLogoDarkUrl: 'https://panel.mailway.test/api/public/marca/a/logo.svg',
      loginLogoLightUrl: 'https://panel.mailway.test/api/public/marca/a/logo.svg',
      loginLogoDarkUrl: 'https://panel.mailway.test/api/public/marca/a/logo.svg',
      loginCompanyName: 'Cliente A S.L.',
      loginWebsiteUrl: 'https://panel.cliente-a.test/mi-buzon',
    },
  ]);
  // Mismo JSON byte a byte con otro orden de entrada: las claves van en un orden fijo.
  assert.equal(JSON.stringify(marcaPorHostBulwark([CLIENTE_B, CLIENTE_A])), JSON.stringify(marca));
  assert.deepEqual(marcaPorHostBulwark([]), []);
});

test('marcaPorHostBulwark: Bulwark conserva todas las entradas y todos los campos', () => {
  const completo: WebmailConMarca = {
    host: 'webmail.completo.test',
    nombre: 'Correo completo',
    nombreCorto: 'Correo',
    descripcion: 'Correo web de Completo',
    empresa: 'Completo S.A.',
    logoClaroUrl: '/branding/clientes/completo/claro.svg',
    logoOscuroUrl: '/branding/clientes/completo/oscuro.svg',
    faviconUrl: 'https://cdn.completo.test/favicon.ico',
    iconoUrl: 'https://cdn.completo.test/icono.png',
    colorTema: '#abc',
    colorFondo: '#ffffff',
    miBuzonUrl: 'https://panel.completo.test/mi-buzon',
    privacidadUrl: 'https://completo.test/privacidad',
    avisoLegalUrl: 'https://completo.test/aviso-legal',
  };
  const marca = marcaPorHostBulwark([completo, CLIENTE_A, CLIENTE_B]);
  // El análisis de Bulwark (copia independiente) no descarta nada: el PATCH no dará 400.
  assert.deepEqual(analizarComoBulwark(marca), marca);
  assert.deepEqual(normalizarMarcaBulwark(marca), marca);
  // host y 15 campos: todos menos las capturas de la PWA, que Mailway no ofrece.
  assert.equal(Object.keys(marca.find((e) => e.host === 'webmail.completo.test')!).length, 16);
});

test('marcaPorHostBulwark: rechaza lo que Bulwark descartaría o no debe publicarse', () => {
  const casos: [string, Partial<WebmailConMarca>][] = [
    ['comodín', { host: '*.cliente.test' }],
    ['IP', { host: '192.0.2.10' }],
    ['con esquema', { host: 'https://webmail.cliente.test' }],
    ['sin nombre', { nombre: '   ' }],
    ['nombre con control', { nombre: 'Correo\u0007' }],
    ['nombre largo', { nombre: 'x'.repeat(61) }],
    ['javascript:', { miBuzonUrl: 'javascript:alert(1)' }],
    ['http en enlace', { miBuzonUrl: 'http://panel.cliente.test/mi-buzon' }],
    ['ruta en enlace', { privacidadUrl: '/privacidad' }],
    ['credenciales', { avisoLegalUrl: 'https://usuario:clave@cliente.test/aviso' }],
    ['data:', { logoClaroUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }],
    ['ruta ajena', { faviconUrl: '/api/auth/session' }],
    ['subida de carpeta', { faviconUrl: '/branding/../api/admin/config' }],
    ['protocolo relativo', { iconoUrl: '//otro.test/icono.png' }],
    ['color', { colorTema: 'red' }],
    ['color con alfa', { colorFondo: '#00000080' }],
  ];
  for (const [nombre, cambio] of casos) {
    assert.throws(
      () => marcaPorHostBulwark([{ host: 'webmail.cliente.test', nombre: 'Correo', ...cambio }]),
      (err: unknown) => err instanceof HttpError && err.status === 400 && err.code === 'bulwark_marca_invalida',
      nombre,
    );
  }
  assert.throws(
    () => marcaPorHostBulwark([CLIENTE_B, { ...CLIENTE_B, host: 'WEBMAIL.b-cliente.test' }]),
    /aparece dos veces/,
  );
});

test('normalizarMarcaBulwark: lee lo guardado como Bulwark', () => {
  assert.deepEqual(normalizarMarcaBulwark(null), []);
  assert.deepEqual(normalizarMarcaBulwark('no es json'), []);
  assert.deepEqual(
    normalizarMarcaBulwark(
      JSON.stringify([
        { host: 'B.test', appName: 'B', loginWebsiteUrl: '', desconocida: 'x' },
        { host: 'a.test', appName: 'A' },
        { host: 'b.test', appName: 'repetida' },
        { host: 'mal host' },
        7,
      ]),
    ),
    [
      { host: 'a.test', appName: 'A' },
      { host: 'b.test', appName: 'B' },
    ],
  );
});

/* ------------------------------ Política y huella ------------------------------ */

test('politicaBulwark: interruptores de Mailway y «Mi buzón» en la barra lateral', () => {
  const politica = politicaBulwark({ miBuzonUrl: 'https://panel.mailway.test/mi-buzon' });
  assert.equal(politica.features.pluginsEnabled, false);
  assert.equal(politica.features.pluginsUploadEnabled, false);
  assert.equal(politica.features.sidebarAppsEnabled, false);
  assert.equal(politica.features.userThemesEnabled, false);
  assert.equal(politica.features.debugModeEnabled, false);
  assert.equal(politica.features.filesEnabled, false);
  assert.equal(politica.features.calendarEnabled, true);
  assert.equal(politica.features.contactsEnabled, true);
  assert.deepEqual(politica.defaults, { senderFavicons: false });
  assert.deepEqual(politica.defaultSidebarApps, [
    {
      id: ID_APP_MI_BUZON,
      name: 'Mi buzón',
      url: 'https://panel.mailway.test/mi-buzon',
      icon: 'tabler:user-circle',
      openMode: 'tab',
      showOnMobile: true,
    },
  ]);
  assert.equal(politica.pushRelayUrl, '');
  assert.equal(politica.pushRelayUrlLocked, false);

  const otra = politicaBulwark({ archivos: true, calendario: false, contactos: false, relePush: 'https://push.mailway.test/' });
  assert.deepEqual(otra.defaultSidebarApps, []);
  assert.equal(otra.features.filesEnabled, true);
  assert.equal(otra.features.calendarEnabled, false);
  assert.equal(otra.features.calendarTasksEnabled, false);
  assert.equal(otra.features.contactsEnabled, false);
  assert.equal(otra.pushRelayUrl, 'https://push.mailway.test');
  assert.equal(otra.pushRelayUrlLocked, true);

  assert.throws(() => politicaBulwark({ miBuzonUrl: 'http://panel.test/mi-buzon' }), /https/);
  assert.throws(() => politicaBulwark({ relePush: 'javascript:alert(1)' }), /https/);
});

test('politicaCoincide: compara lo que fija Mailway e ignora los interruptores que no conoce', () => {
  const deseada = politicaBulwark({ miBuzonUrl: 'https://panel.mailway.test/mi-buzon' });
  const guardada = JSON.parse(JSON.stringify(deseada)) as Record<string, Record<string, unknown>>;
  guardada.features!.funcionDeLaVersion114 = true;
  assert.equal(politicaCoincide(guardada, deseada), true);
  assert.equal(politicaCoincide({ ...guardada, defaultSidebarApps: [] }, deseada), false);
  assert.equal(politicaCoincide({ ...guardada, features: { ...guardada.features, filesEnabled: true } }, deseada), false);
  assert.equal(politicaCoincide({ ...guardada, defaults: {} }, deseada), false);
  assert.equal(politicaCoincide(null, deseada), false);
});

test('huellaBulwark: estable ante el orden y sensible a cualquier cambio', () => {
  const politica = politicaBulwark({ miBuzonUrl: 'https://panel.mailway.test/mi-buzon' });
  const h1 = huellaBulwark({ marca: marcaPorHostBulwark([CLIENTE_A, CLIENTE_B]), politica });
  const h2 = huellaBulwark({ marca: marcaPorHostBulwark([CLIENTE_B, CLIENTE_A]), politica });
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(h1, h2);
  // Mismo contenido con las claves de la política en otro orden.
  const reordenada = Object.fromEntries(Object.entries(politica).reverse()) as typeof politica;
  assert.equal(huellaBulwark({ marca: marcaPorHostBulwark([CLIENTE_A, CLIENTE_B]), politica: reordenada }), h1);
  assert.notEqual(
    huellaBulwark({ marca: marcaPorHostBulwark([{ ...CLIENTE_A, nombre: 'Otro' }, CLIENTE_B]), politica }),
    h1,
  );
  assert.notEqual(huellaBulwark({ marca: marcaPorHostBulwark([CLIENTE_A, CLIENTE_B]), politica: politicaBulwark() }), h1);
});

test('necesitaSincronizarBulwark: huella distinta, nunca aplicada o revisión vencida', () => {
  const base = { huellaActual: 'h', huellaAplicada: 'h', aplicadaEn: 1_000, ahora: 2_000, revisionMs: 5_000 };
  assert.equal(necesitaSincronizarBulwark(base), false);
  assert.equal(necesitaSincronizarBulwark({ ...base, huellaAplicada: 'otra' }), true);
  assert.equal(necesitaSincronizarBulwark({ ...base, huellaAplicada: null }), true);
  assert.equal(necesitaSincronizarBulwark({ ...base, aplicadaEn: null }), true);
  assert.equal(necesitaSincronizarBulwark({ ...base, ahora: 6_000 }), true);
});

/* ------------------------------- Cliente HTTP -------------------------------- */

test('cliente: aplica la marca una sola vez y reutiliza la sesión', async () => {
  const falso = await bulwarkFalso();
  const cliente = new ClienteAdminBulwark({ url: `${falso.url}/`, contrasena: CONTRASENA });
  const marca = marcaPorHostBulwark([CLIENTE_A, CLIENTE_B]);

  assert.equal(await cliente.salud(), 'healthy');
  const primera = await cliente.aplicarMarca(marca);
  assert.deepEqual(primera, { cambiada: true, clavesFijadas: [] });
  assert.deepEqual(falso.marca, marca);

  const segunda = await cliente.aplicarMarca(marca);
  assert.equal(segunda.cambiada, false);
  assert.deepEqual(await cliente.leerMarca(), marca);
  // Un solo inicio de sesión y un solo PATCH.
  assert.equal(falso.inicios, 1);
  assert.equal(falso.llamadas.filter((l) => l.metodo === 'PATCH').length, 1);
  // De servidor a servidor: sin Origin ni Sec-Fetch-Site, con la cookie de sesión.
  for (const llamada of falso.llamadas) {
    assert.equal(llamada.origin, undefined);
    assert.equal(llamada.secFetchSite, undefined);
  }
  assert.ok(falso.llamadas.filter((l) => l.ruta === '/api/admin/config').every((l) => l.cookie?.startsWith('admin_session=')));
  // Una lista vacía también se aplica (se retira la marca de todos).
  assert.equal((await cliente.aplicarMarca([])).cambiada, true);
  assert.deepEqual(falso.marca, []);
});

test('cliente: si Bulwark da la sesión por caducada, inicia otra una sola vez', async () => {
  const falso = await bulwarkFalso();
  const cliente = new ClienteAdminBulwark({ url: falso.url, contrasena: CONTRASENA });
  await cliente.leerMarca();
  falso.caducarSesiones();
  assert.deepEqual(await cliente.leerMarca(), []);
  assert.equal(falso.inicios, 2);
});

test('cliente: contraseña rechazada, con un error claro y sin secretos', async () => {
  const falso = await bulwarkFalso();
  const otra = 'otra-clave-que-no-es-la-buena-987654321';
  const cliente = new ClienteAdminBulwark({ url: falso.url, contrasena: otra });
  const err = await error(cliente.aplicarMarca([]));
  assert.equal(err.status, 502);
  assert.equal(err.code, 'bulwark_credenciales');
  assert.match(err.message, /admin\.json/);
  sinSecretos(err, otra, CONTRASENA);
  assert.equal(falso.llamadas.filter((l) => l.metodo === 'PATCH').length, 0);
});

test('cliente: administración desactivada y límite de inicios de sesión', async () => {
  const falso = await bulwarkFalso();
  falso.adminDesactivado = true;
  const desactivada = await error(new ClienteAdminBulwark({ url: falso.url, contrasena: CONTRASENA }).leerMarca());
  assert.equal(desactivada.code, 'bulwark_admin_desactivado');

  falso.adminDesactivado = false;
  falso.limite = 0;
  const limitada = await error(new ClienteAdminBulwark({ url: falso.url, contrasena: CONTRASENA }).leerMarca());
  assert.equal(limitada.code, 'bulwark_limite');
  assert.ok(limitada instanceof ErrorBulwark);
  assert.equal(limitada.reintentarEnS, 612);
  assert.match(limitada.message, /612 s/);
});

test('cliente: Bulwark rechaza la marca o la petición por su origen', async () => {
  const falso = await bulwarkFalso();
  const cliente = new ClienteAdminBulwark({ url: falso.url, contrasena: CONTRASENA });
  // Entrada que Bulwark descartaría: el cliente ni siquiera la envía.
  const local = await error(cliente.aplicarMarca([{ host: '*.mal host' } as never]));
  assert.equal(local.code, 'bulwark_marca_invalida');
  assert.equal(falso.llamadas.length, 0);

  // Bulwark responde 400 por su cuenta (p. ej. una clave que esta versión no conoce).
  falso.marca = [{ host: 'webmail.viejo.test', appName: 'Viejo' }];
  const original = globalThis.fetch;
  const conClaveDesconocida: typeof fetch = (input, init) => {
    if (init?.method === 'PATCH') init = { ...init, body: JSON.stringify({ domainBranding: [], sinSoporte: 1 }) };
    return original(input, init);
  };
  const rechazada = await error(
    new ClienteAdminBulwark({ url: falso.url, contrasena: CONTRASENA, fetch: conClaveDesconocida }).aplicarMarca([]),
  );
  assert.equal(rechazada.code, 'bulwark_rechazo');
  assert.match(rechazada.message, /Unknown config keys: sinSoporte/);

  falso.exigirOrigen = true;
  const origen = await error(new ClienteAdminBulwark({ url: falso.url, contrasena: CONTRASENA }).leerMarca());
  assert.equal(origen.code, 'bulwark_origen');
});

test('cliente: tiempo agotado y conexión rechazada', async () => {
  const falso = await bulwarkFalso();
  falso.retrasoMs = 1_500;
  const lento = await error(new ClienteAdminBulwark({ url: falso.url, contrasena: CONTRASENA, tiempoMaximoMs: 200 }).salud());
  assert.equal(lento.code, 'bulwark_inaccesible');
  assert.match(lento.message, /no ha respondido en 1 s/);

  // Un puerto que nadie escucha.
  const libre = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const puerto = (s.address() as AddressInfo).port;
      s.close(() => resolve(puerto));
    });
  });
  const cerrado = await error(
    new ClienteAdminBulwark({ url: `http://127.0.0.1:${libre}`, contrasena: CONTRASENA }).aplicarMarca([]),
  );
  assert.equal(cerrado.code, 'bulwark_inaccesible');
  assert.match(cerrado.message, /ECONNREFUSED/);
  sinSecretos(cerrado, CONTRASENA);
});

test('cliente: varias peticiones a la vez comparten un único inicio de sesión', async () => {
  const falso = await bulwarkFalso();
  const cliente = new ClienteAdminBulwark({ url: falso.url, contrasena: CONTRASENA });
  await Promise.all([cliente.leerMarca(), cliente.leerMarca(), cliente.leerPolitica(), cliente.leerMarca()]);
  assert.equal(falso.inicios, 1);
});

test('cliente: la política se escribe solo si cambia y se lee completa', async () => {
  const falso = await bulwarkFalso();
  const cliente = new ClienteAdminBulwark({ url: falso.url, contrasena: CONTRASENA });
  const politica = politicaBulwark({ miBuzonUrl: 'https://panel.mailway.test/mi-buzon' });
  assert.deepEqual(await cliente.aplicarPolitica(politica), { cambiada: true });
  assert.equal(falso.politica.defaultSidebarApps && (falso.politica.defaultSidebarApps as unknown[]).length, 1);
  // El interruptor que Mailway no conoce sigue en Bulwark y no cuenta como diferencia.
  assert.equal((falso.politica.features as Record<string, unknown>).nuevaFuncion2027, true);
  assert.deepEqual(await cliente.aplicarPolitica(politica), { cambiada: false });
  assert.equal(falso.llamadas.filter((l) => l.metodo === 'PUT').length, 1);
  // La lectura lleva la sesión: la parte pública omitiría la app de «Mi buzón».
  assert.ok(falso.llamadas.filter((l) => l.ruta === '/api/admin/policy').every((l) => l.cookie));
});

test('sincronizarBulwark: aplica marca y política, devuelve la huella y avisa de claves fijadas', async () => {
  const falso = await bulwarkFalso();
  falso.fijadas = { appName: 'Puesto a mano', faviconUrl: '/branding/otro.svg' };
  const cliente = new ClienteAdminBulwark({ url: falso.url, contrasena: CONTRASENA });
  const deseado = {
    marca: marcaPorHostBulwark([CLIENTE_A]),
    politica: politicaBulwark({ miBuzonUrl: 'https://panel.mailway.test/mi-buzon' }),
  };
  const primera = await sincronizarBulwark(cliente, deseado);
  assert.equal(primera.huella, huellaBulwark(deseado));
  assert.equal(primera.marcaCambiada, true);
  assert.equal(primera.politicaCambiada, true);
  assert.deepEqual(primera.clavesFijadas, ['appName', 'faviconUrl']);
  const segunda = await sincronizarBulwark(cliente, deseado);
  assert.equal(segunda.marcaCambiada, false);
  assert.equal(segunda.politicaCambiada, false);
  assert.equal(falso.inicios, 1);
});

/* ----------------------------- Imágenes de marca ----------------------------- */

/** PNG mínimo de 16 × 16 con un byte de diferencia por «variante». */
function png(variante = 0): Buffer {
  const datos = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(datos, 0);
  datos.writeUInt32BE(13, 8);
  datos.write('IHDR', 12, 'latin1');
  datos.writeUInt32BE(16, 16);
  datos.writeUInt32BE(16, 20);
  datos[40] = variante;
  return datos;
}

test('recursoMarcaBulwark: el nombre depende del contenido y del hueco, y Bulwark lo admite', () => {
  const a = recursoMarcaBulwark(png(1), 'image/png', 'appLogoLightUrl');
  assert.match(a.nombre, /^domain__mw-[0-9a-f]{32}__appLogoLightUrl\.png$/);
  assert.equal(a.ruta, `/api/admin/branding/${a.nombre}`);
  assert.equal(a.host, `mw-${a.sha256.slice(0, 32)}`);
  // Otra imagen, otro nombre; la misma en otro hueco, también.
  assert.notEqual(recursoMarcaBulwark(png(2), 'image/png', 'appLogoLightUrl').nombre, a.nombre);
  assert.notEqual(recursoMarcaBulwark(png(1), 'image/png', 'faviconUrl').nombre, a.nombre);
  assert.equal(recursoMarcaBulwark(png(1), 'image/jpeg', 'appLogoLightUrl').nombre.endsWith('.jpg'), true);
  assert.deepEqual(analizarNombreRecursoBulwark(a.nombre), { host: a.host, hueco: 'appLogoLightUrl' });
  assert.equal(analizarNombreRecursoBulwark('domain__webmail.cliente.test__faviconUrl.png'), null);
  assert.equal(analizarNombreRecursoBulwark('appLogoLightUrl.png'), null);
  // La ruta pasa la validación de la marca (sin el sha de otro nombre).
  const marca = marcaPorHostBulwark([{ host: 'webmail.cliente.test', nombre: 'Correo', logoClaroUrl: a.ruta }]);
  assert.equal(marca[0]!.appLogoLightUrl, a.ruta);
  assert.throws(() => recursoMarcaBulwark(png(), 'image/svg+xml' as never, 'faviconUrl'), /PNG, JPEG o WebP|no es válida/);
});

test('asegurarRecursosBulwark: sube lo que falta o difiere, una vez, y la lectura no pide sesión', async () => {
  const falso = await bulwarkFalso();
  const cliente = new ClienteAdminBulwark({ url: falso.url, contrasena: CONTRASENA });
  const logo = recursoMarcaBulwark(png(1), 'image/png', 'appLogoLightUrl');
  const icono = recursoMarcaBulwark(png(2), 'image/png', 'pwaIconUrl');
  const subidos: string[] = [];

  const primera = await asegurarRecursosBulwark(cliente, [logo, icono, logo], (n) => subidos.push(n));
  assert.deepEqual(primera.subidos, [logo.nombre, icono.nombre]);
  assert.deepEqual(subidos, primera.subidos);
  assert.deepEqual(falso.ficheros.get(logo.nombre)?.datos, logo.datos);
  assert.equal(falso.ficheros.get(logo.nombre)?.tipo, 'image/png');
  // La subida añade su host sintético a domainBranding (lo retira la marca después).
  assert.ok(analizarComoBulwark(falso.marca).some((e) => e.host === logo.host));

  const antes = falso.llamadas.length;
  assert.deepEqual((await asegurarRecursosBulwark(cliente, [logo, icono])).subidos, []);
  const lecturas = falso.llamadas.slice(antes);
  assert.ok(lecturas.every((l) => l.metodo === 'GET' && l.cookie === undefined), 'comprobar no gasta inicios de sesión');

  // Un fichero estropeado en Bulwark se vuelve a subir.
  falso.ficheros.set(logo.nombre, { datos: Buffer.from('otra cosa'), tipo: 'image/png' });
  assert.deepEqual((await asegurarRecursosBulwark(cliente, [logo, icono])).subidos, [logo.nombre]);
  assert.equal(falso.inicios, 1);

  assert.equal(await cliente.leerRecurso(recursoMarcaBulwark(png(9), 'image/png', 'faviconUrl').nombre), null);
  await assert.rejects(cliente.leerRecurso('../admin.json'), (err: HttpError) => err.code === 'bulwark_marca_invalida');
});

test('retirarRecurso: borra el fichero con su host y nunca llama sin host', async () => {
  const falso = await bulwarkFalso();
  const cliente = new ClienteAdminBulwark({ url: falso.url, contrasena: CONTRASENA });
  const logo = recursoMarcaBulwark(png(3), 'image/png', 'appLogoDarkUrl');
  await cliente.subirRecurso(logo);
  await cliente.retirarRecurso(logo.nombre);
  assert.equal(falso.ficheros.has(logo.nombre), false);
  const borrado = falso.llamadas.find((l) => l.metodo === 'DELETE');
  assert.deepEqual(JSON.parse(borrado!.cuerpo), { slot: 'appLogoDarkUrl', host: logo.host });
  // Un nombre que no es del panel no se retira (sin host, Bulwark retiraría la marca de la instancia).
  const borrados = falso.llamadas.filter((l) => l.metodo === 'DELETE').length;
  await cliente.retirarRecurso('appLogoDarkUrl.png');
  await cliente.retirarRecurso('domain__webmail.cliente.test__appLogoDarkUrl.png');
  assert.equal(falso.llamadas.filter((l) => l.metodo === 'DELETE').length, borrados);
});

test('subirRecurso: si Bulwark guarda la imagen con otro nombre, es un error claro', async () => {
  const falso = await bulwarkFalso();
  const original = globalThis.fetch;
  const otroNombre: typeof fetch = async (input, init) => {
    const res = await original(input, init);
    if (init?.method !== 'POST' || !String(input).endsWith('/api/admin/branding')) return res;
    return new Response(JSON.stringify({ url: '/api/admin/branding/otro.png', filename: 'otro.png' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const cliente = new ClienteAdminBulwark({ url: falso.url, contrasena: CONTRASENA, fetch: otroNombre });
  const err = await error(cliente.subirRecurso(recursoMarcaBulwark(png(4), 'image/png', 'faviconUrl')));
  assert.equal(err.code, 'bulwark_error');
  assert.match(err.message, /otro nombre.*no es compatible/);
});

test('cliente: configuración inválida antes de ninguna petición', () => {
  assert.throws(() => new ClienteAdminBulwark({ url: 'mailway-bulwark:3000', contrasena: 'x' }), /http/);
  assert.throws(() => new ClienteAdminBulwark({ url: 'http://u:p@mailway-bulwark:3000', contrasena: 'x' }), /credenciales/);
  assert.throws(() => new ClienteAdminBulwark({ url: 'http://mailway-bulwark:3000', contrasena: '' }), /contraseña/);
});

/* -------------------------- Despliegue (deploy/bulwark) -------------------------- */

function rangosCanonicos(): string[] {
  return leer('deploy/bulwark/cloudflare/rangos.txt')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

test('rangos de Cloudflare: válidos, sin repetir y con cloudflare.conf generado', () => {
  const rangos = rangosCanonicos();
  assert.ok(rangos.length > 10);
  assert.equal(new Set(rangos).size, rangos.length);
  for (const rango of rangos) {
    const [ip, prefijo] = rango.split('/');
    const familia = net.isIP(ip ?? '');
    assert.ok(familia === 4 || familia === 6, rango);
    const bits = Number(prefijo);
    assert.ok(Number.isInteger(bits) && bits >= 8 && bits <= (familia === 4 ? 32 : 128), rango);
  }
  const generado = leer('deploy/bulwark/nginx/cloudflare.conf')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(generado, rangos.map((r) => `${r} 1;`));
  const comprobacion = spawnSync('bash', [path.join(RAIZ, 'deploy/bulwark/cloudflare/generar.sh'), '--comprobar'], {
    encoding: 'utf8',
  });
  assert.equal(comprobacion.status, 0, comprobacion.stderr);
});

test('rangos de Cloudflare: los mismos que usan Roundcube y el panel', () => {
  const rangos = rangosCanonicos();
  const php = leer('deploy/roundcube/mailway.php');
  const bloquePhp = /\$mailwayCloudflare = \[([\s\S]*?)\];/.exec(php);
  assert.ok(bloquePhp, 'no se encuentra $mailwayCloudflare en mailway.php');
  assert.deepEqual([...bloquePhp[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]), rangos);

  const ts = leer('server/src/modules/whitelabel.ts');
  const bloqueTs = /const RANGOS_CLOUDFLARE[^=]*= \[([\s\S]*?)\];/.exec(ts);
  assert.ok(bloqueTs, 'no se encuentra RANGOS_CLOUDFLARE en whitelabel.ts');
  assert.deepEqual(
    [...bloqueTs[1]!.matchAll(/\['([^']+)', (\d+)\]/g)].map((m) => `${m[1]}/${m[2]}`),
    rangos.filter((r) => net.isIP(r.split('/')[0]!) === 4),
  );
});

test('pasarela: incluye los rangos, una sola IP hacia Bulwark y el bloqueo de la administración', () => {
  const conf = leer('deploy/bulwark/nginx/nginx.conf');
  assert.match(conf, /include \/etc\/nginx\/mailway\/cloudflare\.conf;/);
  assert.match(conf, /proxy_set_header X-Forwarded-For \$mw_ip_real;/);
  assert.match(conf, /proxy_set_header CF-Connecting-IP "";/);
  assert.match(conf, /location ~\* \^\/\(\?:admin\|setup\)\(\?:\/\|\$\)/);
  assert.match(conf, /location ~\* \^\/api\/admin\(\?:\/\|\$\)/);
  assert.match(conf, /Strict-Transport-Security/);
  // El registro nunca lleva la cadena de consulta ($request, $request_uri, $args).
  const formato = /log_format mailway[\s\S]*?;\n/.exec(conf)?.[0] ?? '';
  assert.ok(formato.includes('$uri'));
  assert.doesNotMatch(formato, /\$request\b|\$request_uri|\$args|\$http_/);
});

test('marca de la instancia: las copias para Bulwark son las del panel', () => {
  assert.equal(leer('deploy/bulwark/marca/mailway/favicon.svg'), leer('web/public/favicon.svg'));
  assert.equal(leer('deploy/bulwark/marca/mailway/logo.svg'), leer('deploy/roundcube/mailway_theme/logo.svg'));
});

test('imágenes fijadas: README, entorno y ensayo usan las mismas', () => {
  const ensayo = leer('deploy/bulwark/prueba.sh');
  const readme = leer('deploy/bulwark/README.md');
  for (const imagen of [
    /ghcr\.io\/bulwarkmail\/webmail:1\.13\.0@sha256:[0-9a-f]{64}/,
    /nginx:1\.30\.5-alpine@sha256:[0-9a-f]{64}/,
  ]) {
    const enEnsayo = imagen.exec(ensayo)?.[0];
    assert.ok(enEnsayo, `falta ${imagen} en prueba.sh`);
    assert.ok(readme.includes(enEnsayo), `README y prueba.sh no fijan la misma imagen (${enEnsayo})`);
  }
  const entorno = leer('deploy/bulwark/bulwark.env');
  for (const linea of ['STALWART_FEATURES=false', 'STALWART_ADMIN_ACCESS=off', 'TRUSTED_PROXY_DEPTH=1', 'COOKIE_SECURE=true']) {
    assert.ok(entorno.split('\n').includes(linea), linea);
  }
  // Docker toma el valor literal: sin comillas ni comentarios en la misma línea.
  for (const linea of entorno.split('\n').filter((l) => l && !l.startsWith('#'))) {
    assert.match(linea, /^[A-Z][A-Z0-9_]*=[^"'#\s]*$/, linea);
  }
});
