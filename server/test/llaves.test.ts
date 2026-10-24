import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, test } from 'node:test';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { retirarSesionesWebmailPendientes } from '../src/modules/llaves';
import { setInstanceSettings } from '../src/modules/settings';
import { adminContext, cookieFrom, createClient, createDomain, createMailbox, motorAcepta, setDomainOwnership } from './helpers';

/*
 * Llaves de acceso (passkeys) de punta a punta con un autenticador por
 * programa: genera la llave P-256, el attestationObject «none» y las firmas
 * igual que un gestor de verdad (Proton Pass, 1Password…), así que las rutas
 * pasan por la verificación real de @simplewebauthn/server.
 */

after(() => {
  setInstanceSettings({ panelUrl: '', webmailUrl: '' });
});

const PROTON_PASS = '50726f74-6f6e-5061-7373-50726f746f6e';
const ORIGEN = 'http://localhost';

/* ----------------------------- CBOR mínimo ------------------------------- */

function cabecera(mayor: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(mayor << 5) | n]);
  if (n < 256) return Buffer.from([(mayor << 5) | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = (mayor << 5) | 25;
  b.writeUInt16BE(n, 1);
  return b;
}

type Cbor = number | string | Buffer | Map<Cbor, Cbor>;

function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? cabecera(0, v) : cabecera(1, -1 - v);
  if (typeof v === 'string') {
    const t = Buffer.from(v, 'utf8');
    return Buffer.concat([cabecera(3, t.length), t]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([cabecera(2, v.length), v]);
  const partes: Buffer[] = [cabecera(5, v.size)];
  for (const [k, val] of v) partes.push(cbor(k), cbor(val));
  return Buffer.concat(partes);
}

/* ------------------------- Autenticador por programa ---------------------- */

const b64 = (b: Buffer) => b.toString('base64url');

class Autenticador {
  readonly claves = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly credId = crypto.randomBytes(16);
  contador = 0;
  userHandle: Buffer | null = null;

  constructor(private readonly aaguid = PROTON_PASS) {}

  private datos(rpId: string, flags: number, conCredencial: boolean): Buffer {
    const contador = Buffer.alloc(4);
    contador.writeUInt32BE(this.contador);
    const partes = [crypto.createHash('sha256').update(rpId).digest(), Buffer.from([flags]), contador];
    if (conCredencial) {
      const jwk = this.claves.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
      const cose = new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]);
      const largo = Buffer.alloc(2);
      largo.writeUInt16BE(this.credId.length);
      partes.push(Buffer.from(this.aaguid.replace(/-/g, ''), 'hex'), largo, this.credId, cbor(cose));
    }
    return Buffer.concat(partes);
  }

  registro(opciones: { challenge: string; rp: { id: string }; user: { id: string } }, origen = ORIGEN) {
    this.userHandle = Buffer.from(opciones.user.id, 'base64url');
    const cliente = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: opciones.challenge, origin: origen, crossOrigin: false }),
    );
    // UP + UV + BE + BS + AT: presente, verificado, sincronizable y sincronizada.
    const authData = this.datos(opciones.rp.id, 0x01 | 0x04 | 0x08 | 0x10 | 0x40, true);
    const attestation = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: b64(this.credId),
      rawId: b64(this.credId),
      type: 'public-key',
      response: { clientDataJSON: b64(cliente), attestationObject: b64(attestation), transports: ['internal'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  acceso(opciones: { challenge: string; rpId: string }, origen = ORIGEN, flags = 0x01 | 0x04 | 0x08 | 0x10) {
    this.contador += 1;
    const cliente = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: opciones.challenge, origin: origen, crossOrigin: false }),
    );
    const authData = this.datos(opciones.rpId, flags, false);
    const firma = crypto
      .createSign('SHA256')
      .update(Buffer.concat([authData, crypto.createHash('sha256').update(cliente).digest()]))
      .sign(this.claves.privateKey);
    return {
      id: b64(this.credId),
      rawId: b64(this.credId),
      type: 'public-key',
      response: {
        clientDataJSON: b64(cliente),
        authenticatorData: b64(authData),
        signature: b64(firma),
        userHandle: this.userHandle ? b64(this.userHandle) : undefined,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}

/* -------------------------------- Ayudas ---------------------------------- */

let ipSeq = 0;
const nuevaIp = () => `10.77.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

type App = Awaited<ReturnType<typeof adminContext>>['app'];

async function registrarEn(app: App, base: string, cookie: string, aut: Autenticador, nombre?: string) {
  const op = await app.inject({ method: 'POST', url: `${base}/llaves/opciones`, headers: { cookie }, payload: {} });
  assert.equal(op.statusCode, 200, op.body);
  const { desafio, opciones } = op.json();
  const res = await app.inject({
    method: 'POST',
    url: `${base}/llaves`,
    headers: { cookie },
    payload: { desafio, respuesta: aut.registro(opciones), ...(nombre ? { nombre } : {}) },
  });
  return res;
}

async function entrarCon(
  app: App,
  base: string,
  aut: Autenticador,
  extra: Record<string, unknown> = {},
  origen = ORIGEN,
) {
  const ip = nuevaIp();
  const op = await app.inject({ method: 'POST', url: `${base}/llave/opciones`, payload: {}, remoteAddress: ip });
  assert.equal(op.statusCode, 200, op.body);
  const { desafio, opciones } = op.json();
  return app.inject({
    method: 'POST',
    url: `${base}/llave/entrar`,
    payload: { desafio, respuesta: aut.acceso(opciones, origen), ...extra },
    remoteAddress: ip,
  });
}

async function entrarEnMiBuzon(app: App, email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/portal/login',
    payload: { email, password },
    remoteAddress: nuevaIp(),
  });
  assert.equal(res.statusCode, 200, res.body);
  return cookieFrom(res);
}

async function buzonDePrueba(nombre: string) {
  const ctx = await adminContext();
  const cliente = await createClient(ctx, { name: `Llaves ${nombre}` });
  const dominio = await createDomain(ctx, cliente.clientId, `${nombre}.llaves.test`);
  setDomainOwnership(dominio.domainId, true);
  const buzon = await createMailbox(ctx, dominio.domainId, 'ana');
  return { ctx, cliente, dominio, buzon };
}

/* ---------------------------- Usuarios del panel --------------------------- */

test('panel: registrar una llave, entrar con ella, renombrarla y borrarla', async () => {
  const { app, adminCookie } = await adminContext();
  const aut = new Autenticador();

  const reg = await registrarEn(app, '/api/auth', adminCookie, aut);
  assert.equal(reg.statusCode, 200, reg.body);
  const { llave } = reg.json();
  // Sin nombre, se llama como el gestor (por su AAGUID).
  assert.equal(llave.nombre, 'Proton Pass');
  assert.equal(llave.proveedor, 'Proton Pass');
  assert.equal(llave.host, 'localhost');
  assert.equal(llave.sincronizada, true);

  const lista = await app.inject({ method: 'GET', url: '/api/auth/llaves', headers: { cookie: adminCookie } });
  assert.equal(lista.statusCode, 200, lista.body);
  assert.equal(lista.json().llaves.length, 1);
  assert.equal(lista.json().hostActual, 'localhost');

  // Entrar sin contraseña: deja una sesión del panel que vale como cualquier otra.
  const entrada = await entrarCon(app, '/api/auth', aut);
  assert.equal(entrada.statusCode, 200, entrada.body);
  assert.equal(entrada.json().user.email, 'admin@mailway.test');
  const cookie = cookieFrom(entrada);
  const yo = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  assert.equal(yo.json().user.email, 'admin@mailway.test');
  const fila = db
    .prepare("SELECT detail FROM audit_log WHERE action = 'auth.login' ORDER BY id DESC LIMIT 1")
    .get() as { detail: string };
  assert.equal(JSON.parse(fila.detail).via, 'llave');
  // El contador de la llave se guarda (detecta clones).
  const contador = db.prepare('SELECT counter, last_used_at FROM user_passkeys WHERE id = ?').get(llave.id) as {
    counter: number;
    last_used_at: number;
  };
  assert.equal(contador.counter, 1);
  assert.ok(contador.last_used_at > 0);

  const renombrada = await app.inject({
    method: 'PATCH',
    url: `/api/auth/llaves/${llave.id}`,
    headers: { cookie: adminCookie },
    payload: { nombre: 'Proton Pass del portátil' },
  });
  assert.equal(renombrada.json().llave.nombre, 'Proton Pass del portátil');

  const borrada = await app.inject({ method: 'DELETE', url: `/api/auth/llaves/${llave.id}`, headers: { cookie: adminCookie } });
  assert.equal(borrada.statusCode, 200, borrada.body);
  const despues = await entrarCon(app, '/api/auth', aut);
  assert.equal(despues.statusCode, 401);
  assert.equal(despues.json().code, 'passkey_unknown');
});

test('panel: el desafío es de un solo uso y la firma debe ser del origen y con verificación', async () => {
  const { app, adminCookie } = await adminContext();
  const aut = new Autenticador();
  assert.equal((await registrarEn(app, '/api/auth', adminCookie, aut, 'Llave de pruebas')).statusCode, 200);

  const ip = nuevaIp();
  const op = await app.inject({ method: 'POST', url: '/api/auth/llave/opciones', payload: {}, remoteAddress: ip });
  const { desafio, opciones } = op.json();
  // Otro origen (una web que imita al panel): la firma no vale.
  const ajena = await app.inject({
    method: 'POST',
    url: '/api/auth/llave/entrar',
    payload: { desafio, respuesta: aut.acceso(opciones, 'https://panel-falso.example') },
    remoteAddress: ip,
  });
  assert.equal(ajena.statusCode, 401);
  assert.equal(ajena.json().code, 'passkey_invalid');
  // El mismo desafío ya no sirve, aunque la respuesta sea buena.
  const repetida = await app.inject({
    method: 'POST',
    url: '/api/auth/llave/entrar',
    payload: { desafio, respuesta: aut.acceso(opciones) },
    remoteAddress: ip,
  });
  assert.equal(repetida.statusCode, 400);
  assert.equal(repetida.json().code, 'passkey_challenge');

  // Sin verificación del usuario (sin PIN ni huella): no entra.
  const op2 = await app.inject({ method: 'POST', url: '/api/auth/llave/opciones', payload: {}, remoteAddress: ip });
  const sinUv = await app.inject({
    method: 'POST',
    url: '/api/auth/llave/entrar',
    payload: { desafio: op2.json().desafio, respuesta: aut.acceso(op2.json().opciones, ORIGEN, 0x01) },
    remoteAddress: ip,
  });
  assert.equal(sinUv.statusCode, 401);
  assert.equal(sinUv.json().code, 'passkey_invalid');
});

test('panel: la misma llave no se registra dos veces y hay un máximo por persona', async () => {
  const { app, adminCookie } = await adminContext();
  const aut = new Autenticador();
  assert.equal((await registrarEn(app, '/api/auth', adminCookie, aut)).statusCode, 200);
  const otra = await registrarEn(app, '/api/auth', adminCookie, aut);
  assert.equal(otra.statusCode, 409);
  assert.equal(otra.json().code, 'passkey_exists');

  const yo = db.prepare("SELECT id FROM users WHERE email = 'admin@mailway.test'").get() as { id: string };
  const ya = (db.prepare('SELECT COUNT(*) AS c FROM user_passkeys WHERE user_id = ?').get(yo.id) as { c: number }).c;
  for (let i = ya; i < 10; i++) {
    assert.equal((await registrarEn(app, '/api/auth', adminCookie, new Autenticador())).statusCode, 200);
  }
  const once = await app.inject({ method: 'POST', url: '/api/auth/llaves/opciones', headers: { cookie: adminCookie }, payload: {} });
  assert.equal(once.statusCode, 409);
  assert.equal(once.json().code, 'passkey_limit');
  db.prepare('DELETE FROM user_passkeys WHERE user_id = ?').run(yo.id);
});

test('panel: sin sesión no se gestionan llaves y solo en los nombres del panel', async () => {
  const { app } = await adminContext();
  const sin = await app.inject({ method: 'GET', url: '/api/auth/llaves' });
  assert.equal(sin.statusCode, 401);

  setInstanceSettings({ panelUrl: 'https://panel.mailway.test' });
  try {
    const otro = await app.inject({
      method: 'POST',
      url: '/api/auth/llave/opciones',
      payload: {},
      headers: { host: 'otro-nombre.example' },
      remoteAddress: nuevaIp(),
    });
    assert.equal(otro.statusCode, 400);
    assert.equal(otro.json().code, 'passkey_host');
    // El nombre del panel por http (sin TLS): WebAuthn no funcionaría.
    const sinTls = await app.inject({
      method: 'POST',
      url: '/api/auth/llave/opciones',
      payload: {},
      headers: { host: 'panel.mailway.test' },
      remoteAddress: nuevaIp(),
    });
    assert.equal(sinTls.statusCode, 400);
    assert.equal(sinTls.json().code, 'passkey_host');
  } finally {
    setInstanceSettings({ panelUrl: '' });
  }
});

/* -------------------------------- «Mi buzón» ------------------------------- */

test('Mi buzón: el titular añade una llave y entra con ella', async () => {
  const { ctx, buzon } = await buzonDePrueba('mibuzon');
  const cookie = await entrarEnMiBuzon(ctx.app, buzon.email, buzon.password);
  const aut = new Autenticador();
  const reg = await registrarEn(ctx.app, '/api/portal', cookie, aut, 'iPhone de Ana');
  assert.equal(reg.statusCode, 200, reg.body);
  assert.equal(reg.json().llave.nombre, 'iPhone de Ana');

  const lista = await ctx.app.inject({ method: 'GET', url: '/api/portal/llaves', headers: { cookie } });
  assert.equal(lista.json().llaves.length, 1);

  const entrada = await entrarCon(ctx.app, '/api/portal', aut);
  assert.equal(entrada.statusCode, 200, entrada.body);
  assert.equal(entrada.json().email, buzon.email);
  assert.equal(entrada.json().webmailUrl, undefined);
  const yo = await ctx.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie: cookieFrom(entrada) } });
  assert.equal(yo.statusCode, 200, yo.body);
  assert.equal(yo.json().email, buzon.email);

  // La llave de un titular no abre el panel (tablas y propósitos distintos).
  const enPanel = await entrarCon(ctx.app, '/api/auth', aut);
  assert.equal(enPanel.statusCode, 401);
  assert.equal(enPanel.json().code, 'passkey_unknown');
  // Y dice cuál hay que elegir: en el mismo nombre el gestor ofrece las dos.
  assert.match(enPanel.json().error, /«Mi buzón»/);
});

test('webmail: la llave abre Roundcube con una contraseña temporal que se canjea una vez', async () => {
  const { ctx, buzon } = await buzonDePrueba('webmail');
  setInstanceSettings({ webmailUrl: 'https://webmail.mailway.test', panelUrl: '' });
  const anterior = config.webmailToken;
  config.webmailToken = 'secreto-webmail-llaves';
  try {
    const cookie = await entrarEnMiBuzon(ctx.app, buzon.email, buzon.password);
    const aut = new Autenticador();
    assert.equal((await registrarEn(ctx.app, '/api/portal', cookie, aut)).statusCode, 200);

    // Sin el estado del webmail no hay sesión del webmail.
    const sinEstado = await entrarCon(ctx.app, '/api/portal', aut, { webmail: 'webmail.mailway.test' });
    assert.equal(sinEstado.statusCode, 400);
    assert.equal(sinEstado.json().code, 'passkey_state');

    const estado = crypto.randomBytes(24).toString('base64url');
    // Un webmail que no es suyo: entra en «Mi buzón», pero sin enlace al webmail.
    const ajeno = await entrarCon(ctx.app, '/api/portal', aut, { webmail: 'webmail.otro.example', estado });
    assert.equal(ajeno.statusCode, 200, ajeno.body);
    assert.equal(ajeno.json().webmailUrl, undefined);

    const entrada = await entrarCon(ctx.app, '/api/portal', aut, { webmail: 'webmail.mailway.test', estado });
    assert.equal(entrada.statusCode, 200, entrada.body);
    const url = new URL(entrada.json().webmailUrl);
    assert.equal(url.host, 'webmail.mailway.test');
    assert.equal(url.searchParams.get('_action'), 'plugin.mailway_llave');
    assert.equal(url.searchParams.get('_estado'), estado);
    const codigo = url.searchParams.get('_codigo')!;

    // Sin el secreto compartido del webmail, el código no se canjea.
    const sinToken = await ctx.app.inject({ method: 'POST', url: '/api/webmail/llave', payload: { codigo } });
    assert.equal(sinToken.statusCode, 401);

    const canje = await ctx.app.inject({
      method: 'POST',
      url: '/api/webmail/llave',
      headers: { 'x-mailway-token': 'secreto-webmail-llaves' },
      payload: { codigo },
    });
    assert.equal(canje.statusCode, 200, canje.body);
    const datos = canje.json() as { usuario: string; contrasena: string; sesion: string; expira: number };
    assert.equal(datos.usuario, buzon.email);
    assert.ok(datos.expira > Date.now() && datos.expira <= Date.now() + 12 * 3600_000);
    // El motor la acepta: Roundcube entra con ella en IMAP.
    assert.equal(await motorAcepta(buzon.email, datos.contrasena), true);
    // No se guarda recuperable ni sale en las contraseñas de aplicación del titular.
    const fila = db.prepare('SELECT secret_enc, code_hash FROM webmail_passkey_sessions WHERE id = ?').get(datos.sesion) as {
      secret_enc: string | null;
      code_hash: string | null;
    };
    assert.equal(fila.secret_enc, null);
    assert.equal(fila.code_hash, null);
    const apps = await ctx.app.inject({ method: 'GET', url: '/api/portal/app-passwords', headers: { cookie } });
    assert.equal(apps.json().appPasswords.length, 0);

    // Un solo uso.
    const otraVez = await ctx.app.inject({
      method: 'POST',
      url: '/api/webmail/llave',
      headers: { 'x-mailway-token': 'secreto-webmail-llaves' },
      payload: { codigo },
    });
    assert.equal(otraVez.statusCode, 404);
    assert.equal(otraVez.json().code, 'passkey_code_invalid');

    // Salir del webmail la retira del motor.
    const salir = await ctx.app.inject({
      method: 'POST',
      url: '/api/webmail/llave/salir',
      headers: { 'x-mailway-token': 'secreto-webmail-llaves' },
      payload: { sesion: datos.sesion },
    });
    assert.equal(salir.statusCode, 200, salir.body);
    await retirarSesionesWebmailPendientes();
    assert.equal(await motorAcepta(buzon.email, datos.contrasena), false);
  } finally {
    config.webmailToken = anterior;
    setInstanceSettings({ webmailUrl: '' });
  }
});

test('webmail: cambiar la contraseña, borrar la llave o caducar cierra las sesiones abiertas con llave', async () => {
  const { ctx, buzon } = await buzonDePrueba('cierre');
  setInstanceSettings({ webmailUrl: 'https://webmail.mailway.test', panelUrl: '' });
  const anterior = config.webmailToken;
  config.webmailToken = 'secreto-webmail-llaves';
  const canjear = async (aut: Autenticador) => {
    const estado = crypto.randomBytes(24).toString('base64url');
    const entrada = await entrarCon(ctx.app, '/api/portal', aut, { webmail: 'webmail.mailway.test', estado });
    assert.equal(entrada.statusCode, 200, entrada.body);
    const codigo = new URL(entrada.json().webmailUrl).searchParams.get('_codigo');
    const canje = await ctx.app.inject({
      method: 'POST',
      url: '/api/webmail/llave',
      headers: { 'x-mailway-token': 'secreto-webmail-llaves' },
      payload: { codigo },
    });
    assert.equal(canje.statusCode, 200, canje.body);
    return canje.json() as { contrasena: string; sesion: string };
  };
  try {
    let cookie = await entrarEnMiBuzon(ctx.app, buzon.email, buzon.password);
    const aut = new Autenticador();
    const reg = await registrarEn(ctx.app, '/api/portal', cookie, aut);
    const llaveId = reg.json().llave.id as string;

    // 1) Cambio de contraseña.
    const primera = await canjear(aut);
    assert.equal(await motorAcepta(buzon.email, primera.contrasena), true);
    const cambio = await ctx.app.inject({
      method: 'POST',
      url: '/api/portal/password',
      headers: { cookie },
      payload: { current: buzon.password, next: 'otra-clave-del-buzon-larga' },
    });
    assert.equal(cambio.statusCode, 200, cambio.body);
    await retirarSesionesWebmailPendientes();
    assert.equal(await motorAcepta(buzon.email, primera.contrasena), false);
    cookie = await entrarEnMiBuzon(ctx.app, buzon.email, 'otra-clave-del-buzon-larga');

    // 2) Caducidad (12 h): el vigilante la retira.
    const segunda = await canjear(aut);
    db.prepare('UPDATE webmail_passkey_sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1, segunda.sesion);
    await retirarSesionesWebmailPendientes();
    assert.equal(await motorAcepta(buzon.email, segunda.contrasena), false);

    // 3) Suspender el buzón.
    const suspendida = await canjear(aut);
    db.prepare("UPDATE mailboxes SET status = 'suspended' WHERE id = ?").run(buzon.mailboxId);
    await retirarSesionesWebmailPendientes();
    db.prepare("UPDATE mailboxes SET status = 'active' WHERE id = ?").run(buzon.mailboxId);
    assert.equal(await motorAcepta(buzon.email, suspendida.contrasena), false);

    // 4) Borrar la llave.
    const tercera = await canjear(aut);
    const borrada = await ctx.app.inject({ method: 'DELETE', url: `/api/portal/llaves/${llaveId}`, headers: { cookie } });
    assert.equal(borrada.statusCode, 200, borrada.body);
    await retirarSesionesWebmailPendientes();
    assert.equal(await motorAcepta(buzon.email, tercera.contrasena), false);
  } finally {
    config.webmailToken = anterior;
    setInstanceSettings({ webmailUrl: '' });
  }
});

test('webmail: Roundcube pregunta a qué «Mi buzón» mandar al titular', async () => {
  const { ctx } = await buzonDePrueba('portal');
  const anterior = config.webmailToken;
  config.webmailToken = 'secreto-webmail-llaves';
  setInstanceSettings({ webmailUrl: 'https://webmail.mailway.test', panelUrl: 'https://panel.mailway.test' });
  const pedir = (host: string, token = 'secreto-webmail-llaves') =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/webmail/llave/portal?host=${encodeURIComponent(host)}`,
      headers: { 'x-mailway-token': token },
    });
  try {
    const general = await pedir('webmail.mailway.test');
    assert.equal(general.statusCode, 200, general.body);
    assert.equal(general.json().portal, 'https://panel.mailway.test');
    assert.equal((await pedir('webmail.desconocido.example')).statusCode, 404);
    assert.equal((await pedir('webmail.mailway.test', 'otro')).statusCode, 401);
  } finally {
    config.webmailToken = anterior;
    setInstanceSettings({ webmailUrl: '', panelUrl: '' });
  }
});
