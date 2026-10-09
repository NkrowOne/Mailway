// Parte del ensayo de Bulwark (deploy/bulwark/prueba.sh) con un Chromium real
// (Playwright): acceso en la pantalla del cliente, bandeja de entrada por JMAP
// directo al motor (CORS y CSP de verdad), «Mi buzón» en la barra lateral,
// sin pestaña Seguridad y sin peticiones a terceros. Con MWB_PESTANA_SEGUNDOS
// mide además qué hace una pestaña abierta cuando el panel cambia la
// contraseña del buzón (cuántos 401 llegan al motor desde la IP del usuario).
//
// La lanza prueba.sh, que pasa por el entorno:
//   MWB_PLAYWRIGHT          módulo de Playwright (por defecto, «playwright»)
//   MWB_PUERTO_TRAEFIK      puerto local de Traefik (127.0.0.1)
//   MWB_PUERTO_MOTOR        puerto local de la API del motor
//   MWB_ADMIN_MOTOR         contraseña del administrador de recuperación del motor
//   MWB_BUZON, MWB_CLAVE    buzón de prueba y su contraseña
//   MWB_CUENTA_ID           id de la cuenta en el motor (para cambiar la contraseña)
//   MWB_ASUNTO              asunto del mensaje que hay en su bandeja
//   MWB_PESTANA_SEGUNDOS    0 para no medir la pestaña abierta
//
// Salida como la del ensayo: «ok - …», «FALLO - …» e «info - …»; código 1 si
// alguna comprobación falla.

'use strict';

const { execFileSync } = require('node:child_process');

const { chromium } = require(process.env.MWB_PLAYWRIGHT || 'playwright');

const PUERTO = process.env.MWB_PUERTO_TRAEFIK;
const WEBMAIL = 'https://webmail.cliente.test';
const PROPIOS = new Set(['webmail.cliente.test', 'mail.mwb.test']);
const PESTANA_MS = Number(process.env.MWB_PESTANA_SEGUNDOS || 0) * 1000;

let fallos = 0;
const ok = (texto) => console.log(`ok - ${texto}`);
const fallo = (texto, detalle) => {
  console.log(`FALLO - ${texto}`);
  if (detalle) console.log(`        ${detalle}`);
  fallos++;
};
const comprobar = (texto, condicion, detalle) => (condicion ? ok(texto) : fallo(texto, detalle));

async function jmapAdmin(cuerpo) {
  const r = await fetch(`http://127.0.0.1:${process.env.MWB_PUERTO_MOTOR}/jmap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`admin:${process.env.MWB_ADMIN_MOTOR}`).toString('base64')}`,
    },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: cuerpo }),
  });
  return r.json();
}

(async () => {
  // Los nombres de la prueba van a Traefik en 127.0.0.1, sin proxy: el
  // navegador conserva el nombre (SNI, Host y Origin) y solo cambia el destino.
  const navegador = await chromium.launch({
    args: [
      '--no-proxy-server',
      `--host-resolver-rules=MAP webmail.cliente.test 127.0.0.1:${PUERTO}, MAP mail.mwb.test 127.0.0.1:${PUERTO}`,
    ],
  });
  // La CA del ensayo no está en el almacén del navegador.
  const contexto = await navegador.newContext({ ignoreHTTPSErrors: true, locale: 'es-ES' });
  const pagina = await contexto.newPage();
  const ajenos = new Set();
  const csp = [];
  const motor = [];
  contexto.on('request', (r) => {
    const host = new URL(r.url()).hostname;
    if (!PROPIOS.has(host)) ajenos.add(host);
  });
  pagina.on('console', (m) => {
    if (/Content Security Policy|Refused to (connect|load|frame|execute)/i.test(m.text())) csp.push(m.text().slice(0, 200));
  });
  pagina.on('response', (r) => {
    const url = new URL(r.url());
    if (url.hostname === 'mail.mwb.test') motor.push({ t: Date.now(), estado: r.status(), ruta: `${r.request().method()} ${url.pathname}` });
  });

  await pagina.goto(`${WEBMAIL}/`, { waitUntil: 'networkidle' });
  comprobar('el navegador llega a la pantalla de acceso en español', /\/es\/login$/.test(pagina.url()), pagina.url());
  comprobar('con el nombre del cliente en el título', (await pagina.title()) === 'Correo de Cliente', await pagina.title());

  await pagina.fill('#username', process.env.MWB_BUZON);
  await pagina.fill('#password', process.env.MWB_CLAVE);
  await pagina.click('button[type="submit"]');
  await pagina.waitForURL(/\/mail/, { timeout: 30000 }).catch(() => {});
  const visto = await pagina
    .getByText(process.env.MWB_ASUNTO)
    .first()
    .waitFor({ timeout: 30000 })
    .then(() => true, () => false);
  comprobar('acceso con el buzón y bandeja de entrada visible en el navegador', visto, pagina.url());
  comprobar(
    'el navegador habla JMAP directamente con el motor',
    motor.some((m) => m.estado === 200 && m.ruta === 'POST /jmap/'),
    JSON.stringify(motor.slice(-5)),
  );
  const miBuzon = await pagina.locator('[title="Mi buzón"], [aria-label="Mi buzón"], a[href^="https://panel.mwb.test/mi-buzon"]').count();
  comprobar('«Mi buzón» en la barra lateral', miBuzon > 0);
  const galleta = (await contexto.cookies()).find((c) => c.name === 'jmap_stalwart_ctx');
  comprobar('cookie de sesión de Bulwark Secure y HttpOnly', Boolean(galleta && galleta.secure && galleta.httpOnly));

  // Dentro de la aplicación: una carga completa perdería la sesión, que sin
  // «Recordarme» vive en la memoria de la pestaña.
  await pagina.locator('[data-tour="nav-settings"]').first().click();
  await pagina.getByText('Apariencia', { exact: true }).first().waitFor({ timeout: 15000 }).catch(() => {});
  const seguridad = await pagina.getByText('Seguridad', { exact: true }).count();
  const apariencia = await pagina.getByText('Apariencia', { exact: true }).count();
  comprobar('en Ajustes no está la pestaña Seguridad (contraseña y 2FA van por «Mi buzón»)', apariencia > 0 && seguridad === 0,
    `Apariencia ${apariencia}, Seguridad ${seguridad}`);
  comprobar('ninguna violación de la CSP', csp.length === 0, csp.join(' | '));
  comprobar('ninguna petición del navegador a terceros', ajenos.size === 0, [...ajenos].join(', '));

  if (PESTANA_MS > 0) {
    await pagina.goBack({ waitUntil: 'networkidle' }).catch(() => {});
    const nuevo = execFileSync('openssl', ['passwd', '-6', `Nueva-${Date.now()}`], { encoding: 'utf8' }).trim();
    const t0 = Date.now();
    // Umbral alto mientras se mide: interesa el ritmo de reintentos, no que el
    // bloqueo de prueba (10 fallos) lo corte a la mitad.
    const r = await jmapAdmin([
      ['x:Security/set', { update: { singleton: { authBanRate: { count: 1000, period: 86400000 } } } }, 'u'],
      ['x:Action/set', { create: { r: { '@type': 'ReloadSettings' } } }, 'r'],
      ['x:Account/set', { update: { [process.env.MWB_CUENTA_ID]: { 'credentials/0/secret': nuevo } } }, 'a'],
    ]);
    comprobar('el panel cambia la contraseña del buzón con la pestaña abierta', Boolean(r.methodResponses?.[2]?.[1]?.updated));
    await pagina.waitForTimeout(PESTANA_MS);
    const despues = motor.filter((m) => m.t >= t0);
    const rechazos = despues.filter((m) => m.estado === 401);
    const minutos = PESTANA_MS / 60000;
    console.log(
      `info - pestaña abierta ${PESTANA_MS / 1000} s tras el cambio: ${rechazos.length} respuestas 401 del motor ` +
        `(${(rechazos.length / minutos).toFixed(1)} por minuto) desde la IP del usuario; ` +
        `instantes (s): ${rechazos.map((m) => Math.round((m.t - t0) / 1000)).join(' ')}`,
    );
    const porRuta = {};
    for (const m of rechazos) porRuta[m.ruta] = (porRuta[m.ruta] || 0) + 1;
    console.log(`info - 401 por petición: ${JSON.stringify(porRuta)}`);
    const enAcceso = /\/login/.test(pagina.url());
    console.log(`info - la pestaña ${enAcceso ? 'vuelve a la pantalla de acceso' : `sigue en ${new URL(pagina.url()).pathname} reintentando`}`);
    const aviso = await pagina.getByText(/Conexión perdida/).count();
    if (aviso) console.log('info - aviso visible: «Conexión perdida. Intentando reconectar…»');
  }

  await navegador.close();
  process.exit(fallos > 0 ? 1 : 0);
})().catch((err) => {
  console.log(`FALLO - el navegador no pudo completar la prueba: ${err.message.split('\n')[0]}`);
  process.exit(1);
});
