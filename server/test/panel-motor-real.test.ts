import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { verifySha512Crypt } from '../src/core/sha512crypt';
import { getEngine } from '../src/engine';
import type { EngineDnsRecord } from '../src/engine/types';
import { listAlerts } from '../src/modules/alerts';
import { capturarParaMigrar, estadoCambioMotor } from '../src/modules/cambiomotor';
import { leerHashBuzon } from '../src/modules/credenciales';
import { forgetApiKey, forgetTransport, parseSmtpCredentials } from '../src/modules/transactional';
import { runWatchdogOnce } from '../src/modules/watchdog';
import { adminContext, createClient, createDomain, createMailbox, type TestContext } from './helpers';
import { ClienteCorreo } from './protocolos-correo';

/*
 * El panel de extremo a extremo contra un motor de correo DE VERDAD: las
 * rutas reales (app.inject) con Stalwart 0.16 (JMAP) o 0.15 (API REST)
 * detrás, y el resultado comprobado por IMAP y SMTP, como lo vería un
 * programa de correo. El mismo código para las dos versiones; solo se separa
 * donde el motor se comporta distinto de verdad.
 *
 * Solo se ejecuta con un motor arrancado; si no, se omite entera:
 *
 *   eval "$(server/test/motor016-arrancar.sh)"    # o motor015-arrancar.sh
 *   cd server && node --test --import tsx --import ./test/env.ts \
 *     --import ./test/env-real.ts test/panel-motor-real.test.ts
 *   docker rm -f "$MAILWAY_TEST_MOTOR_CONTENEDOR"
 *
 * env-real.ts quita el modo demostración que fuerza env.ts; sin él (npm test)
 * la prueba se omite aunque estén las variables. Con 0.16 hace falta el
 * nombre del contenedor: el puerto 587 que crean los ajustes recomendados
 * solo se abre al reiniciar el motor, y la prueba lo reinicia.
 *
 * Usa nombres aleatorios: se puede repetir contra el mismo contenedor.
 */

const URL_MOTOR = (process.env.MAILWAY_TEST_MOTOR_URL ?? '').replace(/\/+$/, '');
const USUARIO_MOTOR = process.env.MAILWAY_TEST_MOTOR_USER || 'admin';
const CLAVE_MOTOR = process.env.MAILWAY_TEST_MOTOR_PASSWORD ?? '';
const API = process.env.MAILWAY_TEST_MOTOR_API ?? '';
const HOST = process.env.MAILWAY_TEST_MOTOR_HOST || '127.0.0.1';
const PUERTOS = {
  smtp: Number(process.env.MAILWAY_TEST_MOTOR_SMTP || 25),
  smtps: Number(process.env.MAILWAY_TEST_MOTOR_SMTPS || 465),
  submission: Number(process.env.MAILWAY_TEST_MOTOR_SUBMISSION || 587),
  imaps: Number(process.env.MAILWAY_TEST_MOTOR_IMAPS || 993),
};
const CONTENEDOR = process.env.MAILWAY_TEST_MOTOR_CONTENEDOR || '';

function motivoParaOmitir(): string | false {
  if (!URL_MOTOR || !CLAVE_MOTOR) {
    return 'Sin motor real: define MAILWAY_TEST_MOTOR_URL y MAILWAY_TEST_MOTOR_PASSWORD (server/test/motor016-arrancar.sh o motor015-arrancar.sh)';
  }
  if (config.demoMode) {
    return 'El panel sigue en modo demostración: ejecuta la prueba con --import ./test/env-real.ts después de env.ts';
  }
  if (API !== 'jmap016' && API !== 'rest015') {
    return 'MAILWAY_TEST_MOTOR_API debe ser jmap016 (Stalwart 0.16) o rest015 (Stalwart 0.15)';
  }
  if (API === 'jmap016' && !CONTENEDOR) {
    return 'Con Stalwart 0.16 hace falta MAILWAY_TEST_MOTOR_CONTENEDOR: el puerto 587 solo se abre al reiniciar el motor';
  }
  return false;
}

const omitir = motivoParaOmitir();
const es016 = API === 'jmap016';

const sufijo = crypto.randomBytes(3).toString('hex');
/**
 * Nombre del servidor de correo de la instancia: uno nuevo en cada ejecución
 * y distinto del que trae el motor al arrancar, para que «aplicados» quiera
 * decir que el panel lo ha cambiado (y que el motor ya se anuncia con él).
 */
const NOMBRE_SERVIDOR = `mail-${sufijo}.mailway.test`;
const DOMINIO = `e2e-${sufijo}.test`;
const ALIAS = `ventas@${DOMINIO}`;
const EXTERNO = `fuera@externo-${sufijo}.invalid`;
const REMITENTE_EXTERNO = `remitente@externo-${sufijo}.invalid`;

/** Etiquetas de Stalwart 0.16 que el panel no debe pedir publicar (zonefile.ts). */
const ETIQUETAS_NO_PUBLICADAS = ['ua-auto-config', '_ua-auto-config', '_validation-persist'];

const correo = new ClienteCorreo({ host: HOST, servername: NOMBRE_SERVIDOR, puertos: PUERTOS });

/* ------------------------------- Utilidades -------------------------------- */

async function hasta<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const limite = Date.now() + ms;
  let ultimo = await fn();
  while (!ok(ultimo) && Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 500));
    ultimo = await fn();
  }
  return ultimo;
}

function esperarOk(res: LightMyRequestResponse, que: string): any {
  assert.equal(res.statusCode, 200, `${que}: ${res.statusCode} ${res.body}`);
  return res.json();
}

async function reiniciarMotor(): Promise<void> {
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

/**
 * Anota las operaciones que el panel pide al motor mientras dura `fn`. Las
 * rutas usan siempre el objeto que devuelve getEngine() (el mismo mientras no
 * cambien los ajustes): se envuelven sus métodos y después se restauran.
 */
async function anotarLlamadasAlMotor<T>(fn: () => Promise<T>): Promise<{ resultado: T; llamadas: string[] }> {
  const motor = getEngine() as unknown as Record<string, unknown>;
  const llamadas: string[] = [];
  const nombres = Object.getOwnPropertyNames(Object.getPrototypeOf(motor)).filter(
    (n) => n !== 'constructor' && typeof motor[n] === 'function',
  );
  for (const nombre of nombres) {
    const original = motor[nombre] as (...args: unknown[]) => unknown;
    motor[nombre] = (...args: unknown[]) => {
      llamadas.push(nombre);
      return original.apply(motor, args);
    };
  }
  try {
    return { resultado: await fn(), llamadas };
  } finally {
    for (const nombre of nombres) delete motor[nombre];
  }
}

function etiqueta(nombre: string): string {
  return nombre.replace(/\.$/, '').toLowerCase().split('.')[0] ?? '';
}

/* --------------------------------- Prueba ---------------------------------- */

describe(`Panel contra un motor real (${API || 'sin motor'})`, { skip: omitir }, () => {
  let ctx: TestContext;
  let clientId = '';
  let domainId = '';
  let aliasId = '';
  let apiKeyId = '';
  /** Dominios que ha creado la prueba (para cerrar sus pools SMTP al final). */
  const dominiosCreados: string[] = [];
  /** ¿Tenía ya el motor la escucha del 587 antes de los ajustes recomendados? */
  let habia587 = false;
  const ana = { id: '', email: `ana@${DOMINIO}`, password: '' };
  const beto = { id: '', email: `beto@${DOMINIO}`, password: '' };
  const app = { id: '', secret: '' };

  /** Petición del administrador con su sesión del panel. */
  async function admin(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ): Promise<LightMyRequestResponse> {
    return ctx.app.inject({ method, url, headers: { cookie: ctx.adminCookie }, ...(payload ? { payload } : {}) });
  }

  /** Entrada en «Mi buzón»: el panel comprueba la contraseña del titular. */
  async function miBuzon(email: string, password: string): Promise<LightMyRequestResponse> {
    return ctx.app.inject({ method: 'POST', url: '/api/portal/login', payload: { email, password } });
  }

  after(async () => {
    // Si algo falló a mitad: el pool SMTP de la clave no debe retener el
    // proceso, y el dominio de la prueba no debe quedarse en el motor.
    if (apiKeyId) forgetApiKey(apiKeyId);
    if (ctx && domainId) {
      await admin('DELETE', `/api/domains/${domainId}?confirm=${DOMINIO}`).catch(() => undefined);
    }
    for (const id of dominiosCreados) forgetTransport(`config:${id}`);
  });

  test('detección: el panel guarda el motor de Ajustes y averigua su API', async () => {
    ctx = await adminContext();
    esperarOk(await admin('PUT', '/api/settings/instance', { mailHostname: NOMBRE_SERVIDOR }), 'identidad');
    // La misma ruta que Ajustes → Servidor de correo: prueba el motor y lo guarda.
    esperarOk(
      await admin('PUT', '/api/settings/engine', {
        kind: 'stalwart',
        url: URL_MOTOR,
        adminUser: USUARIO_MOTOR,
        adminPassword: CLAVE_MOTOR,
        smtpHost: HOST,
        smtpPort: PUERTOS.submission,
        smtpSecure: false,
      }),
      'motor',
    );
    const estado = esperarOk(await admin('GET', '/api/engine/status'), 'estado');
    assert.equal(estado.api, API);
    assert.deepEqual(estado.engine, { kind: 'stalwart', error: null });
    assert.equal(estado.hostname.expected, NOMBRE_SERVIDOR);
    // Aún sin los ajustes recomendados: el motor se anuncia con otro nombre.
    assert.notEqual(estado.hostname.running, NOMBRE_SERVIDOR);
    assert.equal(estado.recommendedApplied, false);
    // Con 0.16 el certificado lo trae el extractor de Traefik: sin ACME del motor.
    assert.equal(estado.acmeSupported, !es016);
    assert.equal(await getEngine().detectApi(), API);
    // 0.16 no trae el 587 (lo crean los ajustes recomendados); 0.15, sí.
    habia587 = !es016 || estado.extra.submission587 === true;
  });

  test('ajustes recomendados: aplicados (con reinicio en 0.16) y el 587 acepta STARTTLS', { timeout: 300_000 }, async () => {
    let aplicado = esperarOk(await admin('POST', '/api/engine/recommended'), 'ajustes recomendados');
    assert.deepEqual(aplicado.errors, []);
    assert.equal(aplicado.hostname, NOMBRE_SERVIDOR);
    if (!es016) {
      // En 0.15 todo se aplica con la recarga.
      assert.deepEqual(aplicado.restartRequired, []);
    } else if (!habia587) {
      // La escucha nueva del 587 se guarda, pero el puerto solo se abre al
      // reiniciar el contenedor: Ajustes lo dice hasta entonces.
      assert.equal(aplicado.restartRequired.length, 1, JSON.stringify(aplicado));
      const pendiente = esperarOk(await admin('GET', '/api/engine/status'), 'estado');
      assert.deepEqual(pendiente.restartRequired, aplicado.restartRequired);
      await assert.rejects(correo.ehloTrasStarttls(), 'el 587 no debe escuchar antes del reinicio');

      await reiniciarMotor();
      // El aviso desaparece solo: el motor ha arrancado de nuevo.
      const tras = esperarOk(await admin('GET', '/api/engine/status'), 'estado tras reiniciar');
      assert.deepEqual(tras.restartRequired, []);
      aplicado = esperarOk(await admin('POST', '/api/engine/recommended'), 'ajustes recomendados tras reiniciar');
      assert.deepEqual(aplicado.errors, []);
    }
    assert.deepEqual(aplicado.restartRequired, [], 'nada pendiente de reinicio');
    assert.equal(aplicado.running, NOMBRE_SERVIDOR, 'el motor ya se anuncia con el nombre de Ajustes');

    const estado = esperarOk(await admin('GET', '/api/engine/status'), 'estado');
    assert.equal(estado.recommendedApplied, true, JSON.stringify(estado));
    assert.deepEqual(estado.restartRequired, []);
    assert.equal(estado.forwardedHeaders, true);
    assert.deepEqual(estado.hostname, {
      configured: NOMBRE_SERVIDOR,
      expected: NOMBRE_SERVIDOR,
      ok: true,
      running: NOMBRE_SERVIDOR,
      runningOk: true,
      runningError: null,
    });
    if (es016) {
      assert.deepEqual(estado.extra, {
        submission587: true,
        maxAppPasswords: true,
        selfServiceBlocked: true,
        defaultDomain: true,
        logToStdout: true,
        authBanExpiry: true,
      });
      assert.ok(estado.extraChecks.every((c: { ok: boolean }) => c.ok));
    } else {
      assert.deepEqual(estado.extra, {});
    }

    // El 587 escucha y pasa a TLS: tras STARTTLS ofrece autenticación.
    const ehlo = await correo.ehloTrasStarttls();
    assert.match(ehlo, /AUTH/);
  });

  test('cliente y dominio: alta en el motor con DKIM y registros DNS para publicar', { timeout: 120_000 }, async () => {
    ({ clientId } = await createClient(ctx, { name: `Cliente e2e ${sufijo}` }));
    // Sin DNS público no se puede demostrar la propiedad: el ayudante la marca en la base.
    ({ domainId } = await createDomain(ctx, clientId, DOMINIO));
    dominiosCreados.push(domainId);
    assert.ok((await getEngine().listDirectory()).domains.includes(DOMINIO), 'el dominio existe en el motor');

    // DKIM: Ed25519 y RSA (en 0.16 los crea una tarea del motor, en segundo plano).
    type RegistroPanel = EngineDnsRecord & { required: boolean; category: string };
    const leerRegistros = async (): Promise<RegistroPanel[]> =>
      esperarOk(await admin('GET', `/api/domains/${domainId}/dns`), 'registros DNS').records;
    const dkim = <T extends EngineDnsRecord>(rs: T[]): T[] =>
      rs.filter((r) => r.type === 'TXT' && r.name.endsWith(`._domainkey.${DOMINIO}`));
    const registros = await hasta(leerRegistros, (rs) => {
      const claves = dkim(rs).map((r) => r.content);
      return claves.some((c) => c.includes('k=ed25519')) && claves.some((c) => c.includes('k=rsa'));
    });
    const claves = dkim(registros);
    assert.ok(claves.some((r) => r.content.includes('k=ed25519')), JSON.stringify(registros));
    assert.ok(claves.some((r) => r.content.includes('k=rsa')), JSON.stringify(registros));

    const mx = registros.filter((r) => r.type === 'MX');
    assert.equal(mx.length, 1, JSON.stringify(mx));
    assert.match(mx[0]!.content, new RegExp(`^\\d+ ${NOMBRE_SERVIDOR.replace(/\./g, '\\.')}$`));
    const spf = registros.find((r) => r.type === 'TXT' && r.name === DOMINIO && r.content.startsWith('v=spf1'));
    const dmarc = registros.find((r) => r.type === 'TXT' && r.name === `_dmarc.${DOMINIO}`);
    assert.ok(spf, 'falta el SPF');
    assert.match(dmarc?.content ?? '', /^v=DMARC1/);
    for (const r of [...mx, spf!, dmarc!, ...claves]) {
      assert.equal(r.category, 'obligatorio', `${r.type} ${r.name}`);
      assert.equal(r.required, true, `${r.type} ${r.name}`);
    }
    assert.ok(registros.some((r) => r.category === 'verificacion' && r.name === `_mailway.${DOMINIO}`));

    // Lo que Mailway no enruta no se pide publicar. 0.16 sí lo propone (PACC).
    assert.deepEqual(
      registros.filter((r) => ETIQUETAS_NO_PUBLICADAS.includes(etiqueta(r.name))),
      [],
    );
    if (es016) {
      const delMotor = await getEngine().getDnsRecords(DOMINIO);
      assert.ok(
        delMotor.some((r) => etiqueta(r.name) === 'ua-auto-config'),
        'el motor 0.16 propone la autoconfiguración PACC y el panel la deja fuera',
      );
    }

    // El fichero de zona para importar, con las claves reales: la RSA no cabe
    // en una cadena TXT y debe ir troceada en cadenas de 255 bytes como mucho.
    const zona = await admin('GET', `/api/domains/${domainId}/zonefile?nivel=completo`);
    assert.equal(zona.statusCode, 200, zona.body);
    assert.match(zona.body, new RegExp(`\\sMX\\s+\\d+\\s+${NOMBRE_SERVIDOR.replace(/\./g, '\\.')}\\.`));
    assert.ok(!zona.body.includes('ua-auto-config'));
    const cadenas = [...zona.body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? '');
    assert.ok(cadenas.some((c) => c.includes('k=rsa')), 'falta la clave RSA en el fichero de zona');
    for (const cadena of cadenas) assert.ok(Buffer.byteLength(cadena) <= 255, `cadena TXT de ${cadena.length} bytes`);
  });

  test('buzón: IMAP con la contraseña devuelta y comprobación en el panel con la copia local', async () => {
    // Sin contraseña en la petición: el panel genera una y la devuelve una vez.
    for (const buzon of [ana, beto]) {
      const alta = await createMailbox(ctx, domainId, buzon.email.split('@')[0]!);
      assert.equal(alta.email, buzon.email);
      assert.equal(typeof alta.password, 'string');
      buzon.id = alta.mailboxId;
      buzon.password = alta.password;
    }

    assert.equal(await correo.imapLogin(ana.email, ana.password), 'ok');
    assert.equal(await correo.imapLogin(beto.email, beto.password), 'ok');
    assert.equal(await correo.imapLogin(ana.email, `${ana.password}-no`), 'rechazado');

    // El panel guarda el mismo $6$ que recibió el motor.
    const copia = leerHashBuzon(ana.id);
    assert.ok(copia && verifySha512Crypt(ana.password, copia));
    if (!es016) assert.equal((await getEngine().readMailboxCredentials(ana.email))?.passwordHash, copia);

    // «Mi buzón» comprueba con la copia local: la correcta entra sin ninguna
    // llamada al motor; la incorrecta se rechaza sin pedirle que autentique
    // (a lo sumo, con 0.15, se lee su hash).
    const bien = await anotarLlamadasAlMotor(() => miBuzon(ana.email, ana.password));
    esperarOk(bien.resultado, 'Mi buzón con la contraseña correcta');
    assert.deepEqual(bien.llamadas, []);
    const mal = await anotarLlamadasAlMotor(() => miBuzon(ana.email, 'contraseña-equivocada'));
    assert.equal(mal.resultado.statusCode, 401, mal.resultado.body);
    assert.equal(mal.resultado.json().code, 'bad_credentials');
    assert.ok(mal.llamadas.every((n) => n === 'readMailboxCredentials'), mal.llamadas.join(', '));
  });

  test('vigilante: una vuelta contra el motor real no falla ni abre avisos', { timeout: 120_000 }, async () => {
    // En producción da una vuelta cada minuto contra el motor (salud, cola,
    // DNS de los dominios, nombre en ejecución, copia de las contraseñas…).
    // El aviso del certificado no cuenta: el del motor de prueba es autofirmado
    // (y solo se mide si su 993 está publicado en el 993 del anfitrión).
    const fallos: string[] = [];
    await runWatchdogOnce((m) => fallos.push(m));
    assert.deepEqual(fallos, []);
    assert.deepEqual(
      listAlerts({})
        .filter((a) => a.type !== 'engine_tls')
        .map((a) => `${a.type}: ${a.title}`),
      [],
    );
  });

  test('contraseña de aplicación desde el panel: IMAP y SMTP con el secreto que da el motor', async () => {
    const creada = esperarOk(
      await admin('POST', `/api/mailboxes/${ana.id}/app-passwords`, { name: 'Móvil de Ana' }),
      'contraseña de aplicación',
    );
    app.id = creada.appPassword.id;
    app.secret = creada.password;
    if (es016) {
      // 0.16 genera el secreto: el panel entrega el del motor.
      assert.match(app.secret, /^app_[A-Za-z0-9]+$/);
    } else {
      assert.match(app.secret, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    }
    assert.equal(await correo.imapLogin(ana.email, app.secret), 'ok');
    assert.equal(await correo.smtpLogin(465, ana.email, app.secret), 'ok');
    assert.equal(await correo.smtpLogin(587, ana.email, app.secret), 'ok');

    // En «Mi buzón» se reconoce (verificador local) pero no sirve para gestionar.
    const res = await miBuzon(ana.email, app.secret);
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().code, 'app_password_not_allowed');
  });

  test('cambio de contraseña desde el panel: la nueva entra, la antigua no y la de aplicación sigue', async () => {
    const antigua = ana.password;
    const nueva = `Nueva-${sufijo}-Clave`;
    esperarOk(await admin('POST', `/api/mailboxes/${ana.id}/password`, { password: nueva }), 'cambio de contraseña');
    ana.password = nueva;

    assert.equal(await correo.imapLogin(ana.email, nueva), 'ok');
    assert.equal(await correo.imapLogin(ana.email, antigua), 'rechazado');
    assert.equal(await correo.imapLogin(ana.email, app.secret), 'ok', 'la contraseña de aplicación sigue valiendo');
    assert.equal(await correo.smtpLogin(465, ana.email, app.secret), 'ok');

    esperarOk(await miBuzon(ana.email, nueva), 'Mi buzón con la contraseña nueva');
    const vieja = await miBuzon(ana.email, antigua);
    assert.equal(vieja.statusCode, 401, vieja.body);
    if (!es016) assert.equal((await getEngine().readMailboxCredentials(ana.email))?.passwordHash, leerHashBuzon(ana.id));
  });

  test('retirar la contraseña de aplicación: deja de valer en IMAP y SMTP', async () => {
    esperarOk(await admin('DELETE', `/api/mailboxes/${ana.id}/app-passwords/${app.id}`), 'retirada');
    assert.equal(await correo.imapLogin(ana.email, app.secret), 'rechazado');
    assert.equal(await correo.smtpLogin(465, ana.email, app.secret), 'rechazado');
    assert.equal(await correo.imapLogin(ana.email, ana.password), 'ok', 'la principal no se toca');
  });

  test('clave de API: /v1/send entrega por el puerto de envío del motor y llega por IMAP', { timeout: 120_000 }, async () => {
    const creada = esperarOk(
      await admin('POST', '/api/apikeys', { clientId, name: 'Envíos e2e', senderMailboxId: ana.id }),
      'clave de API',
    );
    apiKeyId = creada.info.id;
    const asunto = `API ${sufijo}`;
    const envio = await ctx.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: { authorization: `Bearer ${creada.key}` },
      payload: { to: beto.email, subject: asunto, text: 'Mensaje enviado por la API de envío de Mailway.' },
    });
    const enviado = esperarOk(envio, '/v1/send');
    assert.equal(enviado.status, 'sent', JSON.stringify(enviado));
    const recibidos = await hasta(() => correo.imapBuscar(beto.email, beto.password, asunto), (n) => n > 0, 60_000);
    assert.equal(recibidos, 1);

    // La credencial SMTP interna de la clave es una contraseña de aplicación
    // del remitente: al revocar la clave deja de valer en el motor.
    const fila = db.prepare('SELECT smtp_password_enc FROM api_keys WHERE id = ?').get(apiKeyId) as {
      smtp_password_enc: string;
    };
    const interna = parseSmtpCredentials(fila.smtp_password_enc).plain;
    assert.equal(await correo.smtpLogin(587, ana.email, interna), 'ok');
    esperarOk(await admin('DELETE', `/api/apikeys/${apiKeyId}`), 'revocar la clave');
    assert.equal(await correo.smtpLogin(587, ana.email, interna), 'rechazado');
  });

  test('correo «Configura tu correo»: sale de la cuenta oculta configuration@ y llega por IMAP', { timeout: 120_000 }, async () => {
    // A otra dirección del titular (aquí, el buzón de beto), sin contraseña en
    // el enlace para no cambiar la de ana.
    const envio = esperarOk(
      await admin('POST', `/api/mailboxes/${ana.id}/setup-email`, { to: beto.email, includePassword: false }),
      'correo de configuración',
    );
    assert.equal(envio.sent.status, 'sent');
    assert.ok(
      (await getEngine().listDirectory()).accounts.includes(`configuration@${DOMINIO}`),
      'la cuenta remitente existe en el motor',
    );
    const recibidos = await hasta(
      () => correo.imapBuscar(beto.email, beto.password, `Configura tu correo ${ana.email}`),
      (n) => n > 0,
      60_000,
    );
    assert.equal(recibidos, 1);
  });

  test('alias con destino interno y externo: lo que llega por el 25 entra en el buzón', { timeout: 120_000 }, async () => {
    const alta = esperarOk(
      await admin('POST', '/api/aliases', { domainId, localPart: 'ventas', destinations: [ana.email, EXTERNO] }),
      'alta del alias',
    );
    aliasId = alta.id;
    assert.deepEqual(alta.alias.externalDestinations, [EXTERNO]);
    assert.ok((await getEngine().listDirectory()).lists.includes(ALIAS), 'el alias existe en el motor');

    const asunto = `Alias ${sufijo}`;
    await correo.smtpEntregar({ de: REMITENTE_EXTERNO, para: ALIAS, asunto });
    const recibidos = await hasta(() => correo.imapBuscar(ana.email, ana.password, asunto), (n) => n > 0, 60_000);
    assert.equal(recibidos, 1);
  });

  test('suspensión del buzón y del cliente: el motor deja de aceptar sus contraseñas, pero no su correo', { timeout: 120_000 }, async () => {
    // La suspensión corta también las contraseñas de aplicación (dispositivos).
    const tableta = esperarOk(
      await admin('POST', `/api/mailboxes/${beto.id}/app-passwords`, { name: 'Tableta' }),
      'contraseña de aplicación',
    ).password as string;
    assert.equal(await correo.imapLogin(beto.email, tableta), 'ok');

    esperarOk(await admin('PATCH', `/api/mailboxes/${beto.id}`, { status: 'suspended' }), 'suspender el buzón');
    assert.equal(await correo.imapLogin(beto.email, beto.password), 'rechazado');
    assert.equal(await correo.imapLogin(beto.email, tableta), 'rechazado');
    assert.equal(await correo.smtpLogin(465, beto.email, tableta), 'rechazado');
    assert.equal(await correo.imapLogin(ana.email, ana.password), 'ok', 'los demás buzones siguen');
    // Suspendido no entra, pero el correo le sigue llegando (no rebota).
    const asunto = `Suspendido ${sufijo}`;
    await correo.smtpEntregar({ de: REMITENTE_EXTERNO, para: beto.email, asunto });

    // Con el cliente suspendido no entra nadie; al reactivarlo, el buzón que
    // ya estaba suspendido por su cuenta sigue suspendido.
    const suspendido = esperarOk(await admin('PATCH', `/api/clients/${clientId}`, { suspended: true }), 'suspender el cliente');
    assert.deepEqual(suspendido.suspension, { updated: 1, skipped: 1, failed: [] });
    assert.equal(await correo.imapLogin(ana.email, ana.password), 'rechazado');
    const reactivado = esperarOk(await admin('PATCH', `/api/clients/${clientId}`, { suspended: false }), 'reactivar el cliente');
    assert.deepEqual(reactivado.suspension, { updated: 1, skipped: 1, failed: [] });
    assert.equal(await correo.imapLogin(ana.email, ana.password), 'ok');
    // Suspender y reactivar no la saca del alias: con «set roles», Stalwart
    // 0.15.5 sacaba al buzón de todas sus listas.
    const asuntoAlias = `Alias tras suspender ${sufijo}`;
    await correo.smtpEntregar({ de: REMITENTE_EXTERNO, para: ALIAS, asunto: asuntoAlias });
    assert.equal(
      await hasta(() => correo.imapBuscar(ana.email, ana.password, asuntoAlias), (n) => n > 0, 60_000),
      1,
      'el correo del alias sigue llegando a ana',
    );
    assert.equal(await correo.imapLogin(beto.email, beto.password), 'rechazado', 'beto sigue suspendido');

    esperarOk(await admin('PATCH', `/api/mailboxes/${beto.id}`, { status: 'active' }), 'reactivar el buzón');
    assert.equal(await correo.imapLogin(beto.email, beto.password), 'ok');
    assert.equal(await correo.imapLogin(beto.email, tableta), 'ok');
    const recibidos = await hasta(() => correo.imapBuscar(beto.email, beto.password, asunto), (n) => n > 0, 60_000);
    assert.equal(recibidos, 1, 'el correo que llegó mientras estaba suspendido está en el buzón');
  });

  test('buzón sin copia local del hash: de 0.15 se recupera; con 0.16, restableciendo la contraseña', async () => {
    if (!es016) {
      // Un buzón sin copia local (anterior a la copia, o con otra clave maestra).
      db.prepare('DELETE FROM credenciales_buzon WHERE mailbox_id = ?').run(beto.id);
      assert.equal(leerHashBuzon(beto.id), null);
      assert.equal((await estadoCambioMotor()).buzones.sinHash, 1);

      // Lo mismo que `node server/dist/tools/motor.js capturar`.
      const captura = await capturarParaMigrar();
      assert.equal(captura.ok, true, captura.error);
      assert.equal(captura.capturados, 1);
      assert.deepEqual(captura.fallidos, []);
      const copia = leerHashBuzon(beto.id);
      assert.equal(copia, (await getEngine().readMailboxCredentials(beto.email))?.passwordHash);
      assert.ok(copia && verifySha512Crypt(beto.password, copia));
      assert.equal((await estadoCambioMotor()).buzones.sinHash, 0);

      // «Mi buzón» vuelve a comprobar con la copia, sin preguntar al motor.
      const entrada = await anotarLlamadasAlMotor(() => miBuzon(beto.email, beto.password));
      esperarOk(entrada.resultado, 'Mi buzón tras la copia');
      assert.deepEqual(entrada.llamadas, []);
    } else {
      const antes = leerHashBuzon(beto.id);
      const captura = await capturarParaMigrar();
      assert.equal(captura.ok, false);
      assert.match(captura.error ?? '', /solo se pueden copiar de Stalwart 0\.15/);
      assert.equal(leerHashBuzon(beto.id), antes, 'la copia local no se toca');

      // Sin copia, el panel no puede comprobar la contraseña (0.16 no da el
      // hash y nunca se le pide que autentique), aunque el motor la acepte.
      db.prepare('DELETE FROM credenciales_buzon WHERE mailbox_id = ?').run(beto.id);
      const sinCopia = await miBuzon(beto.email, beto.password);
      assert.equal(sinCopia.statusCode, 409, sinCopia.body);
      assert.equal(sinCopia.json().code, 'password_unverifiable');
      assert.equal(await correo.imapLogin(beto.email, beto.password), 'ok');

      // Lo que se indica al titular: restablecer la contraseña desde el panel.
      const restablecida = esperarOk(await admin('POST', `/api/mailboxes/${beto.id}/password`), 'restablecer');
      beto.password = restablecida.password;
      esperarOk(await miBuzon(beto.email, beto.password), 'Mi buzón tras restablecer');
      assert.equal(await correo.imapLogin(beto.email, beto.password), 'ok');
    }
  });

  test('borrados: alias, buzón y dominio (con lo que aún tenga) desaparecen del motor', { timeout: 120_000 }, async () => {
    esperarOk(await admin('DELETE', `/api/aliases/${aliasId}`), 'borrar el alias');
    assert.ok(!(await getEngine().listDirectory()).lists.includes(ALIAS), 'el alias sigue en el motor');

    esperarOk(await admin('DELETE', `/api/mailboxes/${beto.id}`), 'borrar el buzón');
    let directorio = await getEngine().listDirectory();
    assert.ok(!directorio.accounts.includes(beto.email), 'el buzón sigue en el motor');
    assert.ok(directorio.accounts.includes(ana.email));
    assert.equal(await correo.imapLogin(beto.email, beto.password), 'rechazado');

    // El dominio se borra con lo que aún tiene: un alias, un buzón con una
    // contraseña de aplicación y sus claves DKIM.
    esperarOk(
      await admin('POST', '/api/aliases', { domainId, localPart: 'info', destinations: [ana.email] }),
      'alta de otro alias',
    );
    const otraApp = esperarOk(
      await admin('POST', `/api/mailboxes/${ana.id}/app-passwords`, { name: 'Portátil' }),
      'otra contraseña de aplicación',
    );
    const borrado = await admin('DELETE', `/api/domains/${domainId}`);
    assert.equal(borrado.statusCode, 409, 'pide confirmación: tiene buzones');
    esperarOk(await admin('DELETE', `/api/domains/${domainId}?confirm=${DOMINIO}`), 'borrar el dominio');
    domainId = '';
    directorio = await getEngine().listDirectory();
    assert.ok(!directorio.domains.includes(DOMINIO), 'el dominio sigue en el motor');
    assert.deepEqual(
      [...directorio.accounts, ...directorio.lists].filter((d) => d.endsWith(`@${DOMINIO}`)),
      [],
      'quedan direcciones del dominio en el motor',
    );
    assert.equal(await correo.imapLogin(ana.email, ana.password), 'rechazado');
    assert.equal(await correo.imapLogin(ana.email, otraApp.password), 'rechazado');
  });

  test('el mismo dominio se puede volver a dar de alta y sus buzones nacen limpios', { timeout: 120_000 }, async () => {
    ({ domainId } = await createDomain(ctx, clientId, DOMINIO));
    dominiosCreados.push(domainId);
    const registros = await hasta(
      async () => esperarOk(await admin('GET', `/api/domains/${domainId}/dns`), 'registros DNS').records as EngineDnsRecord[],
      (rs) => rs.filter((r) => r.name.endsWith(`._domainkey.${DOMINIO}`)).length >= 2,
    );
    assert.ok(registros.filter((r) => r.name.endsWith(`._domainkey.${DOMINIO}`)).length >= 2, 'faltan las claves DKIM');

    const anterior = ana.password;
    const nueva = await createMailbox(ctx, domainId, 'ana');
    assert.equal(await correo.imapLogin(ana.email, nueva.password), 'ok');
    assert.equal(await correo.imapLogin(ana.email, anterior), 'rechazado');

    esperarOk(await admin('DELETE', `/api/domains/${domainId}?confirm=${DOMINIO}`), 'borrar el dominio');
    domainId = '';
    assert.ok(!(await getEngine().listDirectory()).domains.includes(DOMINIO));
    esperarOk(await admin('DELETE', `/api/clients/${clientId}`), 'borrar el cliente');
  });
});
