import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { HttpError } from '../src/core/errors';
import {
  ClienteAdminBulwark,
  ErrorBulwark,
  ID_APP_MI_BUZON,
  huellaBulwark,
  marcaPorHostBulwark,
  necesitaSincronizarBulwark,
  normalizarMarcaBulwark,
  politicaBulwark,
  politicaCoincide,
  sincronizarBulwark,
  type WebmailConMarca,
} from '../src/modules/bulwark';

const RAIZ = path.resolve(__dirname, '../..');
const leer = (relativa: string) => fs.readFileSync(path.join(RAIZ, relativa), 'utf8');

/* ------------------------- Bulwark de administración falso ------------------------- */

/*
 * Copia independiente de lo que hace Bulwark 1.13.0 (no de nuestro módulo):
 * - lib/admin/domain-branding.ts: parseDomainBranding (nombre, comodín,
 *   repetidos, campos conocidos y no vacíos);
 * - app/api/admin/config: PATCH sustituye la clave y responde 400 si el
 *   análisis descarta alguna entrada;
 * - lib/security/same-origin.ts: rechaza escrituras con Sec-Fetch-Site
 *   distinto de same-origin u Origin de otro host;
 * - lib/admin/rate-limit.ts: cada intento de inicio de sesión cuenta, también
 *   los correctos;
 * - app/api/admin/policy: la lectura sin sesión es la parte pública.
 */
const CLAVES_MARCA = [
  'appName', 'appShortName', 'appDescription', 'faviconUrl', 'pwaIconUrl', 'pwaScreenshotMobileUrl',
  'pwaScreenshotDesktopUrl', 'pwaThemeColor', 'pwaBackgroundColor', 'appLogoLightUrl', 'appLogoDarkUrl',
  'loginLogoLightUrl', 'loginLogoDarkUrl', 'loginCompanyName', 'loginImprintUrl', 'loginPrivacyPolicyUrl',
  'loginWebsiteUrl',
];
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function analizarComoBulwark(raw: unknown): Record<string, string>[] {
  if (!Array.isArray(raw)) return [];
  const vistos = new Set<string>();
  const salida: Record<string, string>[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const host = (typeof rec.host === 'string' ? rec.host : '').trim().toLowerCase().replace(/\.+$/, '');
    if (!host || !HOST_RE.test(host) || vistos.has(host)) continue;
    vistos.add(host);
    const entrada: Record<string, string> = { host };
    for (const clave of CLAVES_MARCA) {
      const v = rec[clave];
      if (typeof v === 'string' && v.length > 0) entrada[clave] = v;
    }
    salida.push(entrada);
  }
  return salida;
}

interface Llamada {
  metodo: string;
  ruta: string;
  cookie: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  cuerpo: string;
}

interface BulwarkFalso {
  url: string;
  llamadas: Llamada[];
  inicios: number;
  marca: unknown;
  politica: Record<string, unknown>;
  /** Claves con source «admin» además de domainBranding. */
  fijadas: Record<string, unknown>;
  /** Inicios de sesión admitidos antes de responder 429. */
  limite: number;
  adminDesactivado: boolean;
  retrasoMs: number;
  /** Simula un proxy que añade Origin de otro sitio. */
  exigirOrigen: boolean;
  caducarSesiones(): void;
  close(): void;
}

const CONTRASENA = 'clave-de-administracion-de-prueba-0123456789';
const falsos: BulwarkFalso[] = [];
after(() => {
  for (const f of falsos) f.close();
});

async function bulwarkFalso(): Promise<BulwarkFalso> {
  const sesiones = new Set<string>();
  const falso: BulwarkFalso = {
    url: '',
    llamadas: [],
    inicios: 0,
    marca: [],
    politica: {
      restrictions: {},
      features: { pluginsEnabled: false, filesEnabled: true, calendarEnabled: true, nuevaFuncion2027: true },
      defaults: {},
      themePolicy: { disabledBuiltinThemes: [], disabledThemes: [], defaultThemeId: null },
      forceEnabledPlugins: [],
      approvedPlugins: [],
      forceEnabledThemes: [],
      pushRelays: [],
      pushRelayUrl: '',
      pushRelayUrlLocked: false,
      defaultSidebarApps: [],
    },
    fijadas: {},
    limite: 5,
    adminDesactivado: false,
    retrasoMs: 0,
    exigirOrigen: false,
    caducarSesiones: () => sesiones.clear(),
    close: () => {
      servidor.closeAllConnections();
      servidor.close();
    },
  };

  const mismoOrigen = (req: http.IncomingMessage): boolean => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '')) return true;
    const sitio = req.headers['sec-fetch-site'];
    if (sitio !== undefined) return sitio === 'same-origin';
    const origen = req.headers.origin;
    if (falso.exigirOrigen) return false;
    if (!origen) return true;
    return new URL(origen).host === (req.headers['x-forwarded-host'] ?? req.headers.host);
  };
  const sesionValida = (req: http.IncomingMessage): boolean => {
    const m = /(?:^|;\s*)admin_session=([^;]+)/.exec(req.headers.cookie ?? '');
    return Boolean(m && sesiones.has(m[1]!));
  };

  const servidor = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c) => (cuerpo += c));
    req.on('end', () => {
      const ruta = new URL(req.url ?? '/', 'http://bulwark').pathname;
      falso.llamadas.push({
        metodo: req.method ?? '',
        ruta,
        cookie: req.headers.cookie,
        origin: req.headers.origin,
        secFetchSite: req.headers['sec-fetch-site'] as string | undefined,
        cuerpo,
      });
      const json = (status: number, datos: unknown, cabeceras: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...cabeceras });
        res.end(JSON.stringify(datos));
      };
      const responder = () => {
        if (ruta === '/api/health') return json(200, { status: 'healthy' });
        if (ruta === '/api/admin/auth' && req.method === 'POST') {
          if (!mismoOrigen(req)) return json(403, { error: 'Cross-origin request rejected' });
          if (falso.adminDesactivado) return json(404, { error: 'Admin dashboard is not configured' });
          falso.inicios++;
          if (falso.inicios > falso.limite) {
            return json(429, { error: 'Too many login attempts. Try again later.' }, { 'retry-after': '612' });
          }
          let password: unknown;
          try {
            password = (JSON.parse(cuerpo) as { password?: unknown }).password;
          } catch {
            return json(400, { error: 'Password is required' });
          }
          if (password !== CONTRASENA) return json(401, { error: 'Invalid password' });
          const token = crypto.randomBytes(24).toString('base64');
          sesiones.add(encodeURIComponent(token));
          return json(200, { ok: true }, {
            'set-cookie': `admin_session=${encodeURIComponent(token)}; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=lax`,
          });
        }
        if (ruta === '/api/admin/policy' && req.method === 'GET') {
          if (sesionValida(req)) return json(200, falso.politica);
          return json(200, { ...falso.politica, defaultSidebarApps: [] }, { 'x-bulwark-policy-scope': 'public' });
        }
        if (ruta.startsWith('/api/admin/')) {
          if (!mismoOrigen(req)) return json(403, { error: 'Cross-origin request rejected' });
          if (!req.headers.cookie) return json(401, { error: 'Not authenticated' });
          if (!sesionValida(req)) return json(401, { error: 'Session expired' });
        }
        if (ruta === '/api/admin/config' && req.method === 'GET') {
          const config: Record<string, unknown> = {
            appName: { value: 'Correo Mailway', source: 'env' },
            sessionSecret: { source: 'env', hasValue: true },
            domainBranding: { value: falso.marca, source: Array.isArray(falso.marca) && falso.marca.length ? 'admin' : 'default' },
          };
          for (const [clave, valor] of Object.entries(falso.fijadas)) config[clave] = { value: valor, source: 'admin' };
          return json(200, config);
        }
        if (ruta === '/api/admin/config' && req.method === 'PATCH') {
          const cambios = JSON.parse(cuerpo) as Record<string, unknown>;
          const desconocidas = Object.keys(cambios).filter((k) => !['domainBranding', 'appName'].includes(k));
          if (desconocidas.length) return json(400, { error: `Unknown config keys: ${desconocidas.join(', ')}` });
          if ('domainBranding' in cambios) {
            const entrada = cambios.domainBranding;
            if (entrada != null && !Array.isArray(entrada)) return json(400, { error: 'domainBranding must be an array' });
            const analizada = analizarComoBulwark(entrada);
            if (analizada.length !== (Array.isArray(entrada) ? entrada.length : 0)) {
              return json(400, { error: 'One or more domainBranding entries are invalid (each needs a unique, valid host).' });
            }
            falso.marca = analizada;
          }
          return json(200, { ok: true });
        }
        if (ruta === '/api/admin/policy' && req.method === 'PUT') {
          const nueva = JSON.parse(cuerpo) as Record<string, unknown>;
          falso.politica = {
            ...falso.politica,
            ...nueva,
            features: {
              ...(falso.politica.features as Record<string, unknown>),
              ...((nueva.features as Record<string, unknown>) ?? {}),
            },
          };
          return json(200, { ok: true });
        }
        return json(404, { error: 'Not found' });
      };
      if (falso.retrasoMs > 0) setTimeout(responder, falso.retrasoMs);
      else responder();
    });
  });
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  falso.url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  falsos.push(falso);
  return falso;
}

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
