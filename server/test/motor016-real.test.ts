import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { HttpError } from '../src/core/errors';
import { sha512Crypt } from '../src/core/sha512crypt';
import { carpetasDeList } from './protocolos-correo';
import { RutaDeGestionAusente } from '../src/engine/errores';
import { ClienteJmap, ofreceGestion, type Argumentos, type SesionJmap } from '../src/engine/jmap';
import { Stalwart016Engine } from '../src/engine/stalwart016';
import type { EngineSettings } from '../src/engine/types';

/*
 * Driver de Stalwart 0.16 contra un Stalwart 0.16 DE VERDAD.
 *
 * Solo se ejecuta con un motor arrancado; si no, se omite entera:
 *
 *   eval "$(server/test/motor016-arrancar.sh)"
 *   cd server && node --test --import tsx --import ./test/env.ts test/motor016-real.test.ts
 *
 * Comprueba lo que las pruebas con el servidor falso no pueden: que el motor
 * acepta lo que le manda el driver y que el resultado se nota en los
 * protocolos (IMAP en 993, SMTP en 465, 587 y 25). Con
 * MAILWAY_TEST_STALWART016_GRABAR=1 graba además en fixtures/motor016/ las
 * respuestas reales que reproduce el servidor falso de motor016-unidad.
 *
 * Usa nombres aleatorios: se puede repetir contra el mismo contenedor.
 */

const URL_MOTOR = process.env.MAILWAY_TEST_STALWART016_URL ?? '';
const CLAVE = process.env.MAILWAY_TEST_STALWART016_PASSWORD ?? '';
const USUARIO = process.env.MAILWAY_TEST_STALWART016_USER || 'admin';
const HOST = process.env.MAILWAY_TEST_STALWART016_HOST || '127.0.0.1';
const PUERTO_SMTP = Number(process.env.MAILWAY_TEST_STALWART016_SMTP || 25);
const PUERTO_SMTPS = Number(process.env.MAILWAY_TEST_STALWART016_SMTPS || 465);
const PUERTO_SUBMISSION = Number(process.env.MAILWAY_TEST_STALWART016_SUBMISSION || 587);
const PUERTO_IMAPS = Number(process.env.MAILWAY_TEST_STALWART016_IMAPS || 993);
const NOMBRE_SERVIDOR = process.env.MAILWAY_TEST_STALWART016_HOSTNAME || 'mail.mailway.test';
const CONTENEDOR = process.env.MAILWAY_TEST_STALWART016_CONTENEDOR || '';
const GRABAR = process.env.MAILWAY_TEST_STALWART016_GRABAR === '1';
const DIR_FIXTURES = path.join(__dirname, 'fixtures', 'motor016');

const omitir =
  !URL_MOTOR || !CLAVE
    ? 'Sin Stalwart 0.16 real: define MAILWAY_TEST_STALWART016_URL y MAILWAY_TEST_STALWART016_PASSWORD (server/test/motor016-arrancar.sh)'
    : false;

/** Redes desde las que llega la prueba (el puente de Docker): exentas del baneo. */
const REDES = ['172.16.0.0/12', '127.0.0.0/8'];

const sufijo = crypto.randomBytes(3).toString('hex');
const DOMINIO = `m016-${sufijo}.test`;
const DOMINIO_OCUPADO = `m016o-${sufijo}.test`;
const ANA = `ana@${DOMINIO}`;
const BETO = `beto@${DOMINIO}`;
const HUERFANO = `huerfano@${DOMINIO}`;
const ALIAS = `ventas@${DOMINIO}`;
const EXTERNO = `fuera@externo-${sufijo}.invalid`;

function ajustes(extra: Partial<EngineSettings> = {}): EngineSettings {
  return {
    kind: 'stalwart',
    url: URL_MOTOR,
    adminUser: USUARIO,
    adminPassword: CLAVE,
    smtpHost: HOST,
    smtpPort: PUERTO_SUBMISSION,
    smtpSecure: false,
    ...extra,
  };
}

/* --------------------------- JMAP crudo y grabación ------------------------ */

const crudo = new ClienteJmap({ url: URL_MOTOR, usuario: USUARIO, clave: CLAVE });

async function llamar<T = Argumentos>(metodo: string, argumentos: Argumentos): Promise<T> {
  const respuestas = await crudo.peticion([[metodo, argumentos, 'c']]);
  return respuestas.de<T>('c');
}

/** Petición JMAP sin interpretar: el cuerpo tal cual (para grabarlo). */
async function jmapCrudo(
  llamadas: [string, Argumentos, string][],
  usuario = USUARIO,
  clave = CLAVE,
  using = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${URL_MOTOR}/jmap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${usuario}:${clave}`).toString('base64')}`,
    },
    body: JSON.stringify({ using, methodCalls: llamadas }),
  });
  const texto = await res.text();
  let body: unknown = texto;
  try {
    body = JSON.parse(texto);
  } catch {
    // se deja el texto
  }
  return { status: res.status, body };
}

function respuestaDe(body: any, id: string): any {
  return (body.methodResponses as [string, any, string][]).find((r) => r[2] === id)?.[1];
}

const grabado: Record<string, unknown> = {};
function grabar(nombre: string, datos: unknown): void {
  if (!GRABAR) return;
  grabado[nombre] = datos;
}

async function idsDe(objeto: string, filtro?: Argumentos): Promise<string[]> {
  const res = await llamar<{ ids?: string[] }>(`x:${objeto}/query`, filtro ? { filter: filtro } : {});
  return res.ids ?? [];
}

async function idDominio(nombre: string): Promise<string | undefined> {
  return (await idsDe('Domain', { name: nombre }))[0];
}

async function idCuenta(email: string): Promise<string | undefined> {
  const [local, dominio] = email.split('@') as [string, string];
  const dominioId = await idDominio(dominio);
  if (!dominioId) return undefined;
  return (await idsDe('Account', { name: local, domainId: dominioId }))[0];
}

async function leer<T = any>(objeto: string, ids: string[] | null, properties?: string[]): Promise<T[]> {
  const res = await llamar<{ list?: T[] }>(`x:${objeto}/get`, { ids, ...(properties ? { properties } : {}) });
  return res.list ?? [];
}

/** Lo que tocan los ajustes recomendados, para comparar antes y después. */
async function fotoDeAjustes(): Promise<string> {
  const foto: Record<string, unknown> = {};
  for (const [objeto, ids] of [
    ['SystemSettings', ['singleton']],
    ['Http', ['singleton']],
    ['Authentication', ['singleton']],
    ['Security', ['singleton']],
    ['AllowedIp', null],
    ['NetworkListener', null],
    ['Tracer', null],
    ['Role', null],
  ] as [string, string[] | null][]) {
    const lista = await leer<Record<string, unknown>>(objeto, ids);
    foto[objeto] = lista.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  foto.Domain = (await leer<{ name?: string }>('Domain', null, ['name'])).map((d) => d.name).sort();
  return JSON.stringify(foto);
}

/* ------------------------------- Protocolos -------------------------------- */

/** Conversación por líneas sobre un socket (IMAP o SMTP). */
class Conversacion {
  private texto = '';
  private cerrada = false;
  private espera: { patron: RegExp; resolver: (t: string) => void; rechazar: (e: Error) => void } | null = null;

  constructor(private socket: net.Socket) {
    this.escuchar(socket);
  }

  private escuchar(socket: net.Socket): void {
    socket.on('data', (d: Buffer) => {
      this.texto += d.toString('utf8');
      this.revisar();
    });
    socket.on('close', () => {
      this.cerrada = true;
      this.revisar();
    });
    socket.on('error', () => {
      this.cerrada = true;
      this.revisar();
    });
  }

  private revisar(): void {
    const e = this.espera;
    if (!e) return;
    if (e.patron.test(this.texto)) {
      const t = this.texto;
      this.texto = '';
      this.espera = null;
      e.resolver(t);
    } else if (this.cerrada) {
      this.espera = null;
      e.rechazar(new Error(`conexión cerrada sin respuesta (${JSON.stringify(this.texto.slice(-200))})`));
    }
  }

  esperar(patron: RegExp, ms = 15_000): Promise<string> {
    return new Promise((resolver, rechazar) => {
      const temporizador = setTimeout(() => {
        this.espera = null;
        rechazar(new Error(`sin respuesta en ${ms} ms (${JSON.stringify(this.texto.slice(-200))})`));
      }, ms);
      this.espera = {
        patron,
        resolver: (t) => {
          clearTimeout(temporizador);
          resolver(t);
        },
        rechazar: (err) => {
          clearTimeout(temporizador);
          rechazar(err);
        },
      };
      this.revisar();
    });
  }

  enviar(linea: string): void {
    this.socket.write(`${linea}\r\n`);
  }

  /** STARTTLS: el resto de la conversación va cifrada sobre el mismo socket. */
  async cifrar(): Promise<void> {
    const plano = this.socket;
    plano.removeAllListeners('data');
    const seguro = tls.connect({ socket: plano, rejectUnauthorized: false });
    await new Promise<void>((resolve, reject) => {
      seguro.once('secureConnect', () => resolve());
      seguro.once('error', reject);
    });
    this.socket = seguro;
    this.escuchar(seguro);
  }

  cerrar(): void {
    this.socket.destroy();
  }
}

/** El certificado del motor es el autofirmado de reserva: solo en pruebas. */
function conectarTls(puerto: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: HOST, port: puerto, rejectUnauthorized: false, servername: NOMBRE_SERVIDOR });
    s.once('secureConnect', () => resolve(s));
    s.once('error', reject);
  });
}

function conectarPlano(puerto: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: HOST, port: puerto });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

function comillas(valor: string): string {
  return `"${valor.replace(/(["\\])/g, '\\$1')}"`;
}

/** LOGIN por IMAP en 993: 'ok' o 'rechazado' (NO, o el motor cierra). */
async function imapLogin(usuario: string, clave: string): Promise<'ok' | 'rechazado'> {
  const c = new Conversacion(await conectarTls(PUERTO_IMAPS));
  try {
    await c.esperar(/^\* OK.*\r\n/m);
    c.enviar(`a1 LOGIN ${comillas(usuario)} ${comillas(clave)}`);
    const r = await c.esperar(/^a1 (OK|NO|BAD)[^\r\n]*\r\n/m).catch((err: Error) => {
      // Una cuenta sin permiso para autenticarse: el motor corta sin responder.
      if (/cerrada/.test(err.message)) return 'a1 NO cerrada';
      throw err;
    });
    return /^a1 OK/m.test(r) ? 'ok' : 'rechazado';
  } finally {
    c.cerrar();
  }
}

/**
 * Mensajes con ese asunto en todas las carpetas del buzón (búsqueda IMAP).
 * Todas, no solo INBOX: con salida a Internet (la CI) el filtro de spam del
 * motor lleva el mensaje de prueba, de un remitente sin SPF, DKIM ni DMARC, a
 * la de correo no deseado, y lo que se comprueba es que llegó al buzón.
 */
async function imapBuscar(usuario: string, clave: string, asunto: string): Promise<number> {
  const c = new Conversacion(await conectarTls(PUERTO_IMAPS));
  let n = 0;
  const orden = async (comando: string): Promise<{ ok: boolean; texto: string }> => {
    n += 1;
    const etiqueta = `a${n}`;
    c.enviar(`${etiqueta} ${comando}`);
    const texto = await c.esperar(new RegExp(`^${etiqueta} (OK|NO|BAD)[^\\r\\n]*\\r\\n`, 'm'));
    return { ok: new RegExp(`^${etiqueta} OK`, 'm').test(texto), texto };
  };
  try {
    await c.esperar(/^\* OK.*\r\n/m);
    assert.ok((await orden(`LOGIN ${comillas(usuario)} ${comillas(clave)}`)).ok, `IMAP rechaza a ${usuario}`);
    const carpetas = carpetasDeList((await orden('LIST "" "*"')).texto);
    let total = 0;
    for (const carpeta of carpetas.length > 0 ? carpetas : ['INBOX']) {
      if (!(await orden(`EXAMINE ${comillas(carpeta)}`)).ok) continue;
      const r = await orden(`SEARCH SUBJECT ${comillas(asunto)}`);
      const linea = /^\* SEARCH([^\r\n]*)/m.exec(r.texto)?.[1] ?? '';
      total += linea.trim() ? linea.trim().split(/\s+/).length : 0;
    }
    return total;
  } finally {
    c.cerrar();
  }
}

async function smtpEhlo(c: Conversacion): Promise<string> {
  c.enviar('EHLO prueba.mailway.test');
  return c.esperar(/^250 [^\r\n]*\r\n/m);
}

async function smtpAuth(c: Conversacion, usuario: string, clave: string): Promise<'ok' | 'rechazado'> {
  c.enviar(`AUTH PLAIN ${Buffer.from(`\0${usuario}\0${clave}`).toString('base64')}`);
  const r = await c.esperar(/^\d{3} [^\r\n]*\r\n/m).catch(() => '535 cerrada');
  return /^235 /m.test(r) ? 'ok' : 'rechazado';
}

/** AUTH PLAIN por SMTP: 465 con TLS implícito o 587 con STARTTLS. */
async function smtpLogin(modo: 465 | 587, usuario: string, clave: string): Promise<'ok' | 'rechazado'> {
  const c =
    modo === 465
      ? new Conversacion(await conectarTls(PUERTO_SMTPS))
      : new Conversacion(await conectarPlano(PUERTO_SUBMISSION));
  try {
    await c.esperar(/^220 [^\r\n]*\r\n/m);
    const ehlo = await smtpEhlo(c);
    if (modo === 587) {
      assert.match(ehlo, /STARTTLS/, 'el 587 debe anunciar STARTTLS');
      c.enviar('STARTTLS');
      await c.esperar(/^220 [^\r\n]*\r\n/m);
      await c.cifrar();
      await smtpEhlo(c);
    }
    return await smtpAuth(c, usuario, clave);
  } finally {
    c.cerrar();
  }
}

/** Envía un mensaje: por el 25 sin autenticar o por el 465 autenticado. */
async function smtpEnviar(opciones: {
  de: string;
  para: string;
  asunto: string;
  auth?: { usuario: string; clave: string };
  retener?: boolean;
}): Promise<void> {
  const c = opciones.auth
    ? new Conversacion(await conectarTls(PUERTO_SMTPS))
    : new Conversacion(await conectarPlano(PUERTO_SMTP));
  try {
    await c.esperar(/^220 [^\r\n]*\r\n/m);
    await smtpEhlo(c);
    if (opciones.auth) assert.equal(await smtpAuth(c, opciones.auth.usuario, opciones.auth.clave), 'ok');
    // HOLDFOR (RFC 4865, FUTURERELEASE) deja el mensaje en la cola una hora:
    // así hay algo pendiente sin depender de la red de salida.
    c.enviar(`MAIL FROM:<${opciones.de}>${opciones.retener ? ' HOLDFOR=3600' : ''}`);
    assert.match(await c.esperar(/^\d{3} [^\r\n]*\r\n/m), /^250 /m);
    c.enviar(`RCPT TO:<${opciones.para}>`);
    assert.match(await c.esperar(/^\d{3} [^\r\n]*\r\n/m), /^250 /m);
    c.enviar('DATA');
    assert.match(await c.esperar(/^\d{3} [^\r\n]*\r\n/m), /^354 /m);
    c.enviar(
      [
        `From: <${opciones.de}>`,
        `To: <${opciones.para}>`,
        `Subject: ${opciones.asunto}`,
        `Message-ID: <${crypto.randomUUID()}@prueba.mailway.test>`,
        `Date: ${new Date().toUTCString()}`,
        '',
        'Mensaje de la prueba del driver de Stalwart 0.16.',
        '.',
      ].join('\r\n'),
    );
    assert.match(await c.esperar(/^\d{3} [^\r\n]*\r\n/m), /^250 /m);
    c.enviar('QUIT');
  } finally {
    c.cerrar();
  }
}

async function hasta<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const limite = Date.now() + ms;
  let ultimo = await fn();
  while (!ok(ultimo) && Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 500));
    ultimo = await fn();
  }
  return ultimo;
}

async function reiniciarContenedor(): Promise<void> {
  execFileSync('docker', ['restart', CONTENEDOR], { stdio: 'ignore' });
  const listo = await hasta(
    async () => {
      try {
        return (await fetch(`${URL_MOTOR}/healthz/ready`, { signal: AbortSignal.timeout(2_000) })).ok;
      } catch {
        return false;
      }
    },
    (v) => v,
    120_000,
  );
  assert.ok(listo, 'el motor no vuelve a estar listo tras el reinicio');
}

/* --------------------------------- Prueba ---------------------------------- */

describe('Stalwart 0.16 real: driver JMAP', { skip: omitir }, () => {
  const motor = new Stalwart016Engine(ajustes());
  const claveAna1 = `Primera-${sufijo}-Clave`;
  const claveAna2 = `Segunda-${sufijo}-Clave`;
  const claveBeto = `Beto-${sufijo}-Clave`;
  let secretoApp = '';
  let refApp = '';

  after(() => {
    if (!GRABAR) return;
    fs.mkdirSync(DIR_FIXTURES, { recursive: true });
    for (const [nombre, datos] of Object.entries(grabado)) {
      const fichero = path.join(DIR_FIXTURES, nombre);
      fs.writeFileSync(fichero, typeof datos === 'string' ? datos : `${JSON.stringify(datos, null, 2)}\n`);
    }
  });

  test('sesión, ping y errores de transporte reales', async () => {
    const sesion = await fetch(`${URL_MOTOR}/jmap/session`, {
      headers: { authorization: `Basic ${Buffer.from(`${USUARIO}:${CLAVE}`).toString('base64')}` },
    });
    const cuerpoSesion = (await sesion.json()) as SesionJmap;
    // 0.16.25 no la pone en las capacidades generales, sino en las de la cuenta.
    assert.ok(ofreceGestion(cuerpoSesion));
    assert.ok('urn:stalwart:jmap' in (cuerpoSesion.primaryAccounts ?? {}));
    grabar('sesion.json', cuerpoSesion);

    assert.deepEqual(await motor.ping(), { ok: true, api: 'jmap016' });
    assert.equal(await motor.detectApi(), 'jmap016');

    // Errores de petición tal como los da el motor (los reproduce el falso).
    const sinCredenciales = await jmapCrudo([], USUARIO, 'clave-mala');
    assert.equal(sinCredenciales.status, 401);
    const rutaDesconocida = await fetch(`${URL_MOTOR}/jmap/no-existe`);
    const capacidad = await jmapCrudo([['x:Domain/query', {}, 'c']], USUARIO, CLAVE, [
      'urn:ietf:params:jmap:core',
      'urn:mailway:inexistente',
    ]);
    const metodo = await jmapCrudo([['x:NoExiste/get', { ids: null }, 'c']]);
    grabar('errores-peticion.json', {
      sinCredenciales,
      rutaDesconocida: { status: rutaDesconocida.status, body: await rutaDesconocida.json() },
      capacidadDesconocida: capacidad,
      metodoDesconocido: metodo,
    });
    assert.equal(respuestaDe(metodo.body, 'c').type, 'unknownMethod');
  });

  test('ajustes recomendados: se aplican, son idempotentes y el estado los refleja', async () => {
    const inicial = await jmapCrudo([
      ['x:SystemSettings/get', { ids: ['singleton'] }, 's'],
      ['x:Http/get', { ids: ['singleton'] }, 'h'],
      ['x:Authentication/get', { ids: ['singleton'] }, 'a'],
      ['x:Security/get', { ids: ['singleton'] }, 'g'],
      ['x:NetworkListener/get', { ids: null }, 'l'],
      ['x:Tracer/get', { ids: null }, 't'],
      ['x:Role/get', { ids: null }, 'r'],
      ['x:AllowedIp/get', { ids: null }, 'i'],
      ['x:Certificate/get', { ids: null }, 'c'],
      ['x:AcmeProvider/get', { ids: null }, 'p'],
      ['x:ClusterNode/get', { ids: null }, 'n'],
      ['x:Domain/get', { ids: null, properties: ['name'] }, 'd'],
    ]);
    grabar('ajustes-iniciales.json', inicial.body);

    const primera = await motor.applyRecommended({
      hostname: NOMBRE_SERVIDOR,
      trustedNetworks: REDES,
      maxAppPasswords: 100,
      permissiveCors: false,
    });
    assert.deepEqual(primera.errors, []);
    const habia587 = respuestaDe(inicial.body, 'l').list.some((e: any) => Object.keys(e.bind).some((b) => b.endsWith(':587')));
    if (!habia587) {
      assert.equal(primera.restartRequired?.length, 1, 'la escucha nueva del 587 exige reiniciar');
    }

    // Idempotente: la segunda vez no cambia nada.
    const antes = await fotoDeAjustes();
    const segunda = await motor.applyRecommended({ hostname: NOMBRE_SERVIDOR, trustedNetworks: REDES, maxAppPasswords: 100, permissiveCors: false });
    assert.deepEqual(segunda.errors, []);
    assert.equal(await fotoDeAjustes(), antes);

    const estado = await motor.getSettingsStatus({ trustedNetworks: [...REDES, '192.0.2.0/24'] });
    assert.equal(estado.api, 'jmap016');
    assert.equal(estado.hostname, NOMBRE_SERVIDOR);
    assert.equal(estado.forwardedHeaders, true);
    assert.deepEqual(estado.trustedNetworks, REDES);
    assert.equal(estado.acme, null);
    assert.equal(estado.certificateFiles, false);
    // Sin clientes con el correo web nuevo, el CORS cerrado no es una comprobación.
    assert.deepEqual(estado.extra, {
      submission587: true,
      maxAppPasswords: true,
      selfServiceBlocked: true,
      defaultDomain: true,
      logToStdout: true,
      authBanExpiry: true,
    });
    if (!habia587) assert.equal(estado.restartRequired.length, 1);
    // El bloqueo por fallos de acceso caduca a la hora (por defecto, nunca).
    const [seguridad] = await leer<{ authBanPeriod?: number | null }>('Security', ['singleton'], ['authBanPeriod']);
    assert.equal(seguridad?.authBanPeriod, 3_600_000);

    // CORS para el correo web nuevo: se abre cuando hace falta y se cierra después.
    await motor.applyRecommended({ hostname: NOMBRE_SERVIDOR, trustedNetworks: REDES, maxAppPasswords: 100, permissiveCors: true });
    const [abierto] = await leer<{ usePermissiveCors?: boolean }>('Http', ['singleton'], ['usePermissiveCors']);
    assert.equal(abierto?.usePermissiveCors, true);
    const conCors = await motor.getSettingsStatus({ trustedNetworks: REDES, permissiveCors: true });
    assert.equal(conCors.extra.permissiveCors, true);
    // Lo que pregunta el navegador antes de hablar JMAP desde webmail.<dominio>.
    const preflight = await fetch(`${URL_MOTOR}/jmap/`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://webmail.cliente.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*', 'el motor responde al preflight con CORS');
    // Sin nadie que lo necesite, está abierto de más.
    assert.equal((await motor.getSettingsStatus({ trustedNetworks: REDES, permissiveCors: false })).extra.permissiveCors, false);
    await motor.applyRecommended({ hostname: NOMBRE_SERVIDOR, trustedNetworks: REDES, maxAppPasswords: 100, permissiveCors: false });
    const [cerrado] = await leer<{ usePermissiveCors?: boolean }>('Http', ['singleton'], ['usePermissiveCors']);
    assert.equal(cerrado?.usePermissiveCors, false);
    assert.equal((await motor.getSettingsStatus({ trustedNetworks: REDES, permissiveCors: false })).extra.permissiveCors, undefined);

    // El dominio por defecto es el reservado del servidor y la raíz ya no
    // lleva al autoservicio del motor.
    const [sistema] = await leer<any>('SystemSettings', ['singleton']);
    const [reservado] = await leer<any>('Domain', [sistema.defaultDomainId], ['name']);
    assert.equal(reservado.name, NOMBRE_SERVIDOR);
    assert.equal((await fetch(`${URL_MOTOR}/`, { redirect: 'manual' })).status, 404);
    assert.equal(await motor.getRunningHostname(), NOMBRE_SERVIDOR);

    grabar(
      'ajustes-aplicados.json',
      (
        await jmapCrudo([
          ['x:SystemSettings/get', { ids: ['singleton'] }, 's'],
          ['x:Http/get', { ids: ['singleton'] }, 'h'],
          ['x:Authentication/get', { ids: ['singleton'] }, 'a'],
          ['x:NetworkListener/get', { ids: null }, 'l'],
          ['x:Tracer/get', { ids: null }, 't'],
          ['x:AllowedIp/get', { ids: null }, 'i'],
        ])
      ).body,
    );
    if (GRABAR) {
      grabar('recarga.json', (await jmapCrudo([['x:Action/set', { create: { r: { '@type': 'ReloadSettings' } } }, 'c']])).body);
    }

    if (CONTENEDOR) {
      // El registro de eventos ya sale por `docker logs` (antes no salía
      // nada: el de ficheros escribe donde la imagen no deja). Cualquier
      // petición sin X-Forwarded-For deja ahora un aviso.
      const desde = new Date(Date.now() - 1_000).toISOString();
      await llamar('x:Action/set', { create: { r: { '@type': 'ReloadTlsCertificates' } } });
      // Ojo: el trazador «Stdout» de Stalwart escribe en la salida de errores
      // del proceso; `docker logs` da las dos.
      const registro = await hasta(
        async () => {
          const r = spawnSync('docker', ['logs', '--since', desde, CONTENEDOR], { encoding: 'utf8' });
          return `${r.stdout ?? ''}${r.stderr ?? ''}`;
        },
        (texto) => texto.trim().length > 0,
        15_000,
      );
      assert.ok(registro.trim().length > 0, 'el motor debe escribir su registro en la salida estándar');

      // El 587 solo se abre al reiniciar; después, el aviso desaparece.
      await reiniciarContenedor();
      const tras = await motor.getSettingsStatus({ trustedNetworks: REDES });
      assert.deepEqual(tras.restartRequired, []);
      assert.equal(tras.extra.submission587, true);
    }
  });

  test('dominio: alta, adopción, DKIM y registros DNS', async () => {
    await motor.createDomain(DOMINIO);
    const id = await idDominio(DOMINIO);
    assert.ok(id);
    // Ya existe: se adopta sin error y sin duplicarlo.
    await motor.createDomain(DOMINIO.toUpperCase());
    assert.deepEqual(await idsDe('Domain', { name: DOMINIO }), [id]);
    const duplicado = await jmapCrudo([['x:Domain/set', { create: { d: { name: DOMINIO } } }, 'c']]);

    await motor.ensureDkim(DOMINIO, 'mail');
    const firmas = await leer<any>('DkimSignature', await idsDe('DkimSignature', { domainId: id }));
    assert.deepEqual(firmas.map((f) => f['@type']).sort(), ['Dkim1Ed25519Sha256', 'Dkim1RsaSha256']);
    // Una segunda vez no crea claves nuevas.
    await motor.ensureDkim(DOMINIO, 'mail');
    assert.equal((await idsDe('DkimSignature', { domainId: id })).length, 2);

    const registros = await motor.getDnsRecords(DOMINIO);
    const mx = registros.find((r) => r.type === 'MX');
    assert.deepEqual(mx, { type: 'MX', name: `${DOMINIO}.`, content: `10 ${NOMBRE_SERVIDOR}.` });
    for (const firma of firmas) {
      const dkim = registros.find((r) => r.type === 'TXT' && r.name === `${firma.selector}._domainkey.${DOMINIO}.`);
      assert.ok(dkim, `falta el DKIM ${firma.selector}`);
      // Una sola cadena sin comillas, con la clave pública entera (la RSA
      // supera los 255 bytes y el motor la parte en dos trozos).
      assert.ok(dkim.content.endsWith(`p=${firma.publicKey}`), dkim.content);
      assert.ok(!dkim.content.includes('"'));
    }
    assert.ok(registros.some((r) => r.type === 'TXT' && r.name === `${DOMINIO}.` && r.content === 'v=spf1 mx -all'));
    assert.ok(registros.some((r) => r.type === 'TXT' && r.name === `_dmarc.${DOMINIO}.` && r.content.startsWith('v=DMARC1; p=reject')));
    assert.ok(registros.some((r) => r.type === 'SRV' && r.name === `_submission._tcp.${DOMINIO}.` && r.content === `0 1 587 ${NOMBRE_SERVIDOR}.`));

    const [dominio] = await leer<any>('Domain', [id!]);
    grabar('dominio.json', {
      dominio,
      firmas,
      duplicado: respuestaDe(duplicado.body, 'c'),
    });
    grabar('zona-dominio.txt', dominio.dnsZoneFile);
  });

  test('buzón: alta con $6$, contraseñas de aplicación, cambio de contraseña y suspensión', async () => {
    await motor.createMailbox({
      email: ANA,
      passwordHash: sha512Crypt(claveAna1),
      displayName: 'Ana Prueba',
      quotaBytes: 50 * 1024 * 1024,
    });
    assert.equal(await imapLogin(ANA, claveAna1), 'ok');
    assert.equal(await smtpLogin(465, ANA, claveAna1), 'ok');

    // Contraseña de aplicación creada por el administrador para el buzón.
    const creada = await motor.addAppPassword(ANA, 'mw-prueba', 'propuesta-que-se-ignora');
    assert.match(creada.secret, /^app_[a-z0-9]+$/);
    assert.match(creada.ref, /^[a-z0-9]+:[a-z0-9]+$/);
    secretoApp = creada.secret;
    refApp = creada.ref;
    assert.equal(await imapLogin(ANA, secretoApp), 'ok');
    assert.equal(await smtpLogin(465, ANA, secretoApp), 'ok');
    if (CONTENEDOR) assert.equal(await smtpLogin(587, ANA, secretoApp), 'ok');

    // Cambiar la principal conserva la contraseña de aplicación.
    await motor.setMailboxPassword(ANA, sha512Crypt(claveAna2));
    assert.equal(await imapLogin(ANA, claveAna2), 'ok');
    assert.equal(await imapLogin(ANA, claveAna1), 'rechazado');
    assert.equal(await imapLogin(ANA, secretoApp), 'ok');

    // Nombre visible y cuota.
    await motor.updateMailbox(ANA, { displayName: 'Ana Cambiada', quotaBytes: 0 });
    const cuentaId = (await idCuenta(ANA))!;
    let [cuenta] = await leer<any>('Account', [cuentaId], ['description', 'quotas', 'credentials', 'permissions']);
    assert.equal(cuenta.description, 'Ana Cambiada');
    assert.deepEqual(cuenta.quotas, {});
    await motor.updateMailbox(ANA, { quotaBytes: 1234567 });
    [cuenta] = await leer<any>('Account', [cuentaId], ['quotas']);
    assert.deepEqual(cuenta.quotas, { maxDiskQuota: 1234567 });

    // Suspensión: no entra ni por IMAP ni por SMTP; al reactivarlo, sí.
    await motor.updateMailbox(ANA, { suspended: true });
    assert.equal(await imapLogin(ANA, claveAna2), 'rechazado');
    assert.equal(await smtpLogin(465, ANA, secretoApp), 'rechazado');
    await motor.updateMailbox(ANA, { suspended: false });
    assert.equal(await imapLogin(ANA, claveAna2), 'ok');
    assert.equal(await smtpLogin(465, ANA, secretoApp), 'ok');

    // El autoservicio está bloqueado: el titular no puede crearse otra por su cuenta.
    const propia = await jmapCrudo(
      [['x:AppPassword/set', { create: { k: { description: 'propia', permissions: { '@type': 'Inherit' } } } }, 'c']],
      ANA,
      claveAna2,
    );
    assert.equal(propia.body.methodResponses[0][0], 'error');
    assert.equal(propia.body.methodResponses[0][1].type, 'forbidden');

    // 0.16 no da los hashes.
    assert.equal(await motor.readMailboxCredentials(ANA), null);

    const [conCredenciales] = await leer<any>('Account', [cuentaId]);
    grabar('cuenta.json', conCredenciales);
  });

  test('alias con destino interno y externo: entrega por SMTP y lectura por IMAP', async () => {
    await motor.createMailbox({ email: BETO, passwordHash: sha512Crypt(claveBeto) });
    await motor.upsertAlias(ALIAS, [ANA], [EXTERNO]);
    const listaId = (await idsDe('MailingList', { text: 'ventas' }))[0]!;
    let [lista] = await leer<any>('MailingList', [listaId]);
    assert.equal(lista.emailAddress, ALIAS);
    assert.deepEqual(Object.keys(lista.recipients).sort(), [ANA, EXTERNO].sort());
    grabar('lista.json', lista);

    const asunto = `Alias ${sufijo}`;
    await smtpEnviar({ de: `remitente@externo-${sufijo}.invalid`, para: ALIAS, asunto });
    const recibidos = await hasta(() => imapBuscar(ANA, claveAna2, asunto), (n) => n > 0);
    assert.equal(recibidos, 1);

    // Sustituir los destinos no deja el alias fuera ni un momento.
    await motor.upsertAlias(ALIAS, [ANA, BETO], []);
    [lista] = await leer<any>('MailingList', [listaId]);
    assert.deepEqual(Object.keys(lista.recipients).sort(), [ANA, BETO].sort());

    // Un alias no puede ocupar la dirección de un buzón.
    await assert.rejects(motor.upsertAlias(BETO, [ANA]), (err: HttpError) => err.code === 'engine_exists');
    const choque = await jmapCrudo([
      ['x:MailingList/set', { create: { l: { name: 'beto', domainId: lista.domainId, recipients: {} } } }, 'c'],
    ]);
    grabar('errores-objeto.json', { listaContraCuenta: respuestaDe(choque.body, 'c') });

    const usos = await hasta(() => motor.getMailboxUsage(), (u) => (u.get(ANA) ?? 0) > 0);
    assert.ok((usos.get(ANA) ?? 0) > 0, 'el buzón con un mensaje debe ocupar algo');
    assert.equal(usos.get(BETO), 0);
    assert.ok([...usos.keys()].every((k) => k === k.toLowerCase()));

    const directorio = await motor.listDirectory();
    assert.ok(directorio.domains.includes(DOMINIO));
    assert.ok(directorio.domains.includes(NOMBRE_SERVIDOR));
    assert.ok(directorio.accounts.includes(ANA) && directorio.accounts.includes(BETO));
    assert.ok(directorio.lists.includes(ALIAS));

    await motor.deleteAlias(ALIAS);
    assert.deepEqual(await leer('MailingList', [listaId]), []);
    await motor.deleteAlias(ALIAS);
  });

  test('cola de salida: un mensaje retenido cuenta como pendiente', async () => {
    await smtpEnviar({
      de: ANA,
      para: EXTERNO,
      asunto: `Retenido ${sufijo}`,
      auth: { usuario: ANA, clave: claveAna2 },
      retener: true,
    });
    const resumen = await hasta(() => motor.getQueueSummary(), (r) => r.pending > 0, 10_000);
    assert.ok(resumen.pending >= 1);
    assert.equal(typeof resumen.oldestSeconds, 'number');
    assert.ok(resumen.oldestSeconds! >= 0 && resumen.oldestSeconds! < 3600);

    const cola = await jmapCrudo([
      ['x:QueuedMessage/query', { calculateTotal: true, sort: [{ property: 'due', isAscending: true }], limit: 500 }, 'q'],
      ['x:QueuedMessage/get', { '#ids': { resultOf: 'q', name: 'x:QueuedMessage/query', path: '/ids' } }, 'g'],
    ]);
    grabar('cola.json', cola.body);
    // Se retira para no dejar un mensaje esperando una hora.
    const ids: string[] = respuestaDe(cola.body, 'q').ids;
    await llamar('x:QueuedMessage/set', { destroy: ids }).catch(() => undefined);
  });

  test('buzón huérfano: se adopta con la contraseña nueva y sin las de aplicación antiguas', async () => {
    const dominioId = (await idDominio(DOMINIO))!;
    const viejo = `Vieja-${sufijo}-Clave`;
    const creado = await llamar<any>('x:Account/set', {
      create: {
        a: {
          '@type': 'User',
          name: 'huerfano',
          domainId: dominioId,
          credentials: { '0': { '@type': 'Password', secret: sha512Crypt(viejo) } },
          roles: { '@type': 'User' },
          permissions: { '@type': 'Merge', enabledPermissions: {}, disabledPermissions: { authenticate: true } },
          encryptionAtRest: { '@type': 'Disabled' },
        },
      },
    });
    const huerfanoId = creado.created.a.id as string;
    const app = await llamar<any>('x:AppPassword/set', {
      accountId: huerfanoId,
      create: { k: { description: 'antigua', permissions: { '@type': 'Inherit' } } },
    });
    const secretoViejo = app.created.k.secret as string;
    grabar('contrasena-aplicacion.json', {
      ...app,
      created: { k: { ...app.created.k, secret: `app_${'x'.repeat(secretoViejo.length - 4)}` } },
    });
    const duplicada = await jmapCrudo([
      ['x:Account/set', { create: { a: { '@type': 'User', name: 'huerfano', domainId: dominioId, roles: { '@type': 'User' }, permissions: { '@type': 'Inherit' }, encryptionAtRest: { '@type': 'Disabled' } } } }, 'c'],
    ]);

    const nueva = `Nueva-${sufijo}-Clave`;
    await motor.createMailbox({ email: HUERFANO, passwordHash: sha512Crypt(nueva), displayName: 'Adoptado' });
    assert.equal(await idCuenta(HUERFANO), huerfanoId);
    assert.equal(await imapLogin(HUERFANO, nueva), 'ok');
    assert.equal(await imapLogin(HUERFANO, secretoViejo), 'rechazado');
    const [cuenta] = await leer<any>('Account', [huerfanoId], ['credentials', 'description', 'permissions']);
    assert.deepEqual(Object.values(cuenta.credentials).map((c: any) => c['@type']), ['Password']);
    assert.equal(cuenta.description, 'Adoptado');
    assert.deepEqual(cuenta.permissions, { '@type': 'Inherit' });

    // Retirar por una referencia que ya no es una contraseña de aplicación
    // (el motor reutiliza los ids libres) no toca la principal.
    await motor.removeAppPassword(HUERFANO, `${huerfanoId}:${Object.values(cuenta.credentials).map((c: any) => c.credentialId)[0]}`);
    assert.equal(await imapLogin(HUERFANO, nueva), 'ok');
    const borrarPrincipal = await jmapCrudo([
      ['x:AppPassword/set', { accountId: huerfanoId, destroy: [Object.values(cuenta.credentials).map((c: any) => c.credentialId)[0]] }, 'c'],
    ]);
    const anteriores = JSON.parse(JSON.stringify(grabado['errores-objeto.json'] ?? {}));
    grabar('errores-objeto.json', {
      ...anteriores,
      cuentaDuplicada: respuestaDe(duplicada.body, 'c'),
      borrarPrincipal: respuestaDe(borrarPrincipal.body, 'c'),
    });
  });

  test('retirar contraseñas de aplicación y borrar buzones es idempotente', async () => {
    await motor.removeAppPassword(ANA, refApp);
    assert.equal(await imapLogin(ANA, secretoApp), 'rechazado');
    await motor.removeAppPassword(ANA, refApp);
    // Una referencia de 0.15 (el secreto guardado) no tiene nada que retirar.
    await motor.removeAppPassword(ANA, '$app$movil$6$abc$def');
    assert.equal(await imapLogin(ANA, claveAna2), 'ok');

    await motor.deleteMailbox(HUERFANO);
    await motor.deleteMailbox(HUERFANO);
    assert.equal(await idCuenta(HUERFANO), undefined);
    await assert.rejects(motor.setMailboxPassword(HUERFANO, sha512Crypt('x')), (err: HttpError) => err.code === 'engine_not_found');
  });

  test('borrado de dominios: con buzones da un error claro; con solo DKIM, se borra', async () => {
    await motor.createDomain(DOMINIO_OCUPADO);
    await motor.ensureDkim(DOMINIO_OCUPADO, 'mail');
    const ocupadoId = (await idDominio(DOMINIO_OCUPADO))!;
    await motor.createMailbox({ email: `ocupa@${DOMINIO_OCUPADO}`, passwordHash: sha512Crypt(`Ocupa-${sufijo}-1`) });
    await assert.rejects(motor.deleteDomain(DOMINIO_OCUPADO), (err: HttpError) => {
      assert.equal(err.code, 'engine_error');
      assert.match(err.message, /buzón/);
      return true;
    });
    // Sus claves DKIM siguen ahí: el dominio sigue en uso.
    assert.equal((await idsDe('DkimSignature', { domainId: ocupadoId })).length, 2);
    const enlazado = await jmapCrudo([['x:Domain/set', { destroy: [ocupadoId] }, 'c']]);

    // El dominio por defecto (el reservado) no se puede borrar.
    await assert.rejects(motor.deleteDomain(NOMBRE_SERVIDOR), (err: HttpError) => {
      assert.match(err.message, /ajustes del sistema/);
      return true;
    });
    const [sistema] = await leer<any>('SystemSettings', ['singleton']);
    const porDefecto = await jmapCrudo([['x:Domain/set', { destroy: [sistema.defaultDomainId] }, 'c']]);

    await motor.deleteMailbox(`ocupa@${DOMINIO_OCUPADO}`);
    const soloDkim = await jmapCrudo([['x:Domain/set', { destroy: [ocupadoId] }, 'c']]);
    await motor.deleteDomain(DOMINIO_OCUPADO);
    assert.equal(await idDominio(DOMINIO_OCUPADO), undefined);
    assert.deepEqual(await idsDe('DkimSignature', { domainId: ocupadoId }), []);
    await motor.deleteDomain(DOMINIO_OCUPADO);

    const anteriores = JSON.parse(JSON.stringify(grabado['errores-objeto.json'] ?? {}));
    grabar('errores-objeto.json', {
      ...anteriores,
      dominioEnlazado: respuestaDe(enlazado.body, 'c'),
      dominioPorDefecto: respuestaDe(porDefecto.body, 'c'),
      dominioSoloDkim: respuestaDe(soloDkim.body, 'c'),
    });
  });

  test('certificados, ACME y credenciales o ruta equivocadas', async () => {
    await motor.reloadCertificates();
    await assert.rejects(
      motor.configureAcme({ directory: 'https://acme.invalid/dir', token: 't', contact: 'a@b.c', hostname: NOMBRE_SERVIDOR, zone: 'b.c' }),
      (err: HttpError) => err.status === 409 && err.code === 'engine_unsupported',
    );

    const malaClave = new Stalwart016Engine(ajustes({ adminPassword: 'clave-equivocada' }));
    const salud = await malaClave.ping();
    assert.equal(salud.ok, false);
    assert.match(salud.detail ?? '', /401/);
    await assert.rejects(malaClave.createDomain(`x-${DOMINIO}`), (err: HttpError) => err.code === 'engine_auth_failed');

    const otraRuta = new Stalwart016Engine(ajustes({ url: `${URL_MOTOR}/no-existe` }));
    await assert.rejects(otraRuta.ping(), (err: unknown) => err instanceof RutaDeGestionAusente);
    await assert.rejects(otraRuta.createDomain(`x-${DOMINIO}`), (err: unknown) => err instanceof RutaDeGestionAusente);
  });

  test('limpieza: el dominio de la prueba se borra con sus firmas DKIM', async () => {
    await motor.deleteMailbox(ANA);
    await motor.deleteMailbox(BETO);
    const id = (await idDominio(DOMINIO))!;
    await motor.deleteDomain(DOMINIO);
    assert.equal(await idDominio(DOMINIO), undefined);
    assert.deepEqual(await idsDe('DkimSignature', { domainId: id }), []);
    await motor.deleteDomain(DOMINIO);
  });
});
