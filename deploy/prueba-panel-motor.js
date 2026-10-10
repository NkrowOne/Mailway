'use strict';
/**
 * Herramienta del motor SIMULADA, solo para las pruebas de la pila
 * (deploy/prueba-stack.py): ocupa el lugar de server/dist/tools/motor.js en un
 * contenedor de Node que hace de panel, con el mismo contrato que la real.
 *
 *   docker exec -u node <panel> node server/dist/tools/motor.js <orden> [opciones]
 *
 *   estado | capturar | mantenimiento on [--minutos N] | mantenimiento off |
 *   provisionar | tras-migrar
 *
 * Una línea JSON por la salida estándar (con `ok`), el texto para personas por
 * la de errores y código 0 (bien), 1 (problema) o 2 (uso incorrecto).
 *
 * Lo que «sabe el panel» (dominios, buzones, alias y suspendidos) lo escribe
 * la prueba en el fichero de estado (MAILWAY_PRUEBA_ESTADO), donde esta
 * herramienta guarda también el mantenimiento y los hashes copiados. Con
 * `"fallar": {"provisionar": true}` la orden provisionar falla a propósito:
 * así la prueba comprueba la vuelta atrás automática de la migración.
 *
 * Con Stalwart 0.16, «provisionar» aplica lo que el instalador comprueba
 * (nombre del servidor, X-Forwarded-For, la red interna exenta y la escucha
 * del 587 con STARTTLS, que pide reiniciar el motor mientras el puerto no
 * esté abierto), vuelve a suspender los buzones suspendidos y dice qué falta
 * en el motor de lo que conoce el panel. El panel real hace más (roles,
 * cupo de contraseñas de aplicación…): eso lo prueban sus propias pruebas
 * contra el motor real (server/test/motor016-real.test.ts).
 */
const fs = require('node:fs');
const net = require('node:net');

const ESTADO = process.env.MAILWAY_PRUEBA_ESTADO || '/app/datos/estado.json';
const URL_MOTOR = (process.env.STALWART_URL || 'http://mailway-mail:8080').replace(/\/+$/, '');
const AUTENTICACION = `Basic ${Buffer.from(
  `${process.env.STALWART_ADMIN_USER || 'admin'}:${process.env.STALWART_ADMIN_PASSWORD || ''}`,
).toString('base64')}`;
const NOMBRE = (process.env.MAILWAY_MAIL_HOSTNAME || '').toLowerCase();
const RED_INTERNA = process.env.MAILWAY_ENGINE_TRUSTED_NETWORK || '10.203.53.0/24';
const CAPACIDAD_016 = 'urn:stalwart:jmap';
const USO =
  'Uso: node server/dist/tools/motor.js estado | capturar | mantenimiento on [--minutos N] | mantenimiento off | provisionar | tras-migrar';
const AVISO_587 = 'Puerto 587 (envío con STARTTLS): se abre al reiniciar el contenedor del motor';

class ErrorDeUso extends Error {}

function leerEstado() {
  const estado = JSON.parse(fs.readFileSync(ESTADO, 'utf8'));
  for (const lista of ['dominios', 'buzones', 'alias', 'suspendidos']) estado[lista] = estado[lista] || [];
  estado.hashes = estado.hashes || {};
  estado.fallar = estado.fallar || {};
  return estado;
}

function guardarEstado(estado) {
  fs.writeFileSync(`${ESTADO}.tmp`, JSON.stringify(estado, null, 2));
  fs.renameSync(`${ESTADO}.tmp`, ESTADO);
}

function mantenimiento(estado) {
  const m = estado.mantenimiento;
  if (!m || typeof m.hasta !== 'number' || m.hasta <= Date.now()) return { activo: false, hasta: null };
  return { activo: true, hasta: m.hasta };
}

async function pedir(metodo, ruta, cuerpo) {
  const respuesta = await fetch(`${URL_MOTOR}${ruta}`, {
    method: metodo,
    headers: { Authorization: AUTENTICACION, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    redirect: 'manual',
    signal: AbortSignal.timeout(60_000),
  });
  const texto = await respuesta.text();
  let datos = null;
  try {
    datos = JSON.parse(texto);
  } catch {
    datos = null;
  }
  return { estado: respuesta.status, datos };
}

/** La misma detección que el panel: la sesión JMAP con la gestión de 0.16 o la API REST de 0.15. */
async function detectarApi() {
  const sesion = await pedir('GET', '/jmap/session');
  if (sesion.estado === 401) throw new Error('El motor rechaza las credenciales del panel.');
  const tiene = (objeto) => Boolean(objeto) && typeof objeto === 'object' && CAPACIDAD_016 in objeto;
  const s = sesion.datos || {};
  if (
    sesion.estado === 200 &&
    (tiene(s.capabilities) ||
      tiene(s.primaryAccounts) ||
      Object.values(s.accounts || {}).some((cuenta) => tiene(cuenta && cuenta.accountCapabilities)))
  ) {
    return 'jmap016';
  }
  const rest = await pedir('GET', '/api/principal?types=domain&page=1&limit=1');
  if (rest.estado === 401) throw new Error('El motor rechaza las credenciales del panel.');
  if (rest.estado === 200 && rest.datos && typeof rest.datos === 'object' && ('data' in rest.datos || 'error' in rest.datos)) {
    return 'rest015';
  }
  throw new Error(`El motor no responde con la API de 0.15 ni la de 0.16 (HTTP ${sesion.estado} y ${rest.estado}).`);
}

/** Petición JMAP de gestión de 0.16; devuelve las respuestas por su identificador. */
async function jmap(llamadas) {
  const r = await pedir('POST', '/jmap', { using: ['urn:ietf:params:jmap:core', CAPACIDAD_016], methodCalls: llamadas });
  if (r.estado !== 200 || !r.datos || !Array.isArray(r.datos.methodResponses)) {
    throw new Error(`El motor ha respondido HTTP ${r.estado} a la petición JMAP.`);
  }
  const respuestas = {};
  for (const [nombre, argumentos, id] of r.datos.methodResponses) {
    if (nombre === 'error') throw new Error(`Error JMAP en ${id}: ${argumentos.type} ${argumentos.description || ''}`.trim());
    respuestas[id] = argumentos;
  }
  return respuestas;
}

async function listar(objeto, propiedades) {
  const r = await jmap([[`x:${objeto}/get`, { ids: null, properties: propiedades }, 'g']]);
  return r.g.list || [];
}

/** ¿Acepta conexiones el puerto del motor? (una escucha nueva solo se abre al reiniciar) */
function puertoAbierto(puerto) {
  const host = new URL(URL_MOTOR).hostname;
  return new Promise((resolver) => {
    const conexion = net.connect({ host, port: puerto, timeout: 5000 });
    conexion.once('connect', () => {
      conexion.destroy();
      resolver(true);
    });
    conexion.once('timeout', () => {
      conexion.destroy();
      resolver(false);
    });
    conexion.once('error', () => resolver(false));
  });
}

function comprobarSet(respuesta, clave, que, errores) {
  const fallo = (respuesta.notCreated || {})[clave] || (respuesta.notUpdated || {})[clave];
  if (fallo) errores.push(`${que}: ${fallo.type}${fallo.description ? ` (${fallo.description})` : ''}`);
}

async function provisionar016(estado, resultado) {
  // 1. Ajustes: nombre, X-Forwarded-For, red interna exenta y escucha del 587.
  const r = await jmap([
    ['x:SystemSettings/get', { ids: ['singleton'], properties: ['defaultHostname'] }, 's'],
    ['x:Http/get', { ids: ['singleton'], properties: ['useXForwarded'] }, 'h'],
    ['x:AllowedIp/get', { ids: null, properties: ['address'] }, 'a'],
    ['x:NetworkListener/get', { ids: null, properties: ['name', 'protocol', 'bind', 'tlsImplicit'] }, 'l'],
  ]);
  const llamadas = [];
  if (NOMBRE && (r.s.list[0] || {}).defaultHostname !== NOMBRE) {
    llamadas.push(['x:SystemSettings/set', { update: { singleton: { defaultHostname: NOMBRE } } }, 's', 'el nombre del servidor']);
  }
  if ((r.h.list[0] || {}).useXForwarded !== true) {
    llamadas.push(['x:Http/set', { update: { singleton: { useXForwarded: true } } }, 'h', 'X-Forwarded-For']);
  }
  if (!(r.a.list || []).some((ip) => ip.address === RED_INTERNA)) {
    llamadas.push(['x:AllowedIp/set', { create: { red: { address: RED_INTERNA, reason: 'Red interna de Mailway' } } }, 'a', 'la red interna']);
  }
  const hay587 = (r.l.list || []).some(
    (e) => e.protocol === 'smtp' && !e.tlsImplicit && Object.keys(e.bind || {}).some((b) => b.endsWith(':587')),
  );
  if (!hay587) {
    llamadas.push([
      'x:NetworkListener/set',
      { create: { e: { name: 'submission', protocol: 'smtp', bind: { '[::]:587': true }, useTls: true, tlsImplicit: false } } },
      'e',
      'la escucha del 587',
    ]);
  }
  if (llamadas.length > 0) {
    const hechas = await jmap(llamadas.map(([metodo, argumentos, id]) => [metodo, argumentos, id]));
    for (const [, argumentos, id, que] of llamadas) {
      for (const clave of Object.keys(argumentos.update || argumentos.create)) comprobarSet(hechas[id], clave, que, resultado.errores);
      resultado.aplicados.push(que);
    }
  }
  if (!(await puertoAbierto(587))) resultado.restartRequired.push(AVISO_587);

  // 2. Suspensiones: sin permiso para autenticarse, como el panel.
  const cuentas = await listar('Account', ['emailAddress']);
  const porCorreo = new Map(cuentas.map((c) => [String(c.emailAddress || '').toLowerCase(), c.id]));
  for (const email of estado.suspendidos) {
    const id = porCorreo.get(email.toLowerCase());
    if (!id) {
      resultado.suspensiones.fallidas.push(email);
      continue;
    }
    const hecho = await jmap([
      [
        'x:Account/set',
        { update: { [id]: { permissions: { '@type': 'Merge', enabledPermissions: {}, disabledPermissions: { authenticate: true } } } } },
        'u',
      ],
    ]);
    if ((hecho.u.updated || {})[id] !== undefined) resultado.suspensiones.reaplicadas += 1;
    else resultado.suspensiones.fallidas.push(email);
  }

  // 3. Lo que conoce el panel frente a lo que tiene el motor.
  const dominios = new Set((await listar('Domain', ['name'])).map((d) => String(d.name).toLowerCase()));
  const listas = new Set((await listar('MailingList', ['emailAddress'])).map((l) => String(l.emailAddress).toLowerCase()));
  resultado.faltan.dominios = estado.dominios.filter((d) => !dominios.has(d.toLowerCase()));
  resultado.faltan.buzones = estado.buzones.filter((b) => !porCorreo.has(b.toLowerCase()));
  resultado.faltan.alias = estado.alias.filter((a) => !listas.has(a.toLowerCase()));
}

async function provisionar(io) {
  const estado = leerEstado();
  const resultado = {
    ok: false,
    api: null,
    aplicados: [],
    avisos: [],
    restartRequired: [],
    errores: [],
    suspensiones: { reaplicadas: 0, fallidas: [] },
    faltan: { dominios: [], buzones: [], alias: [] },
  };
  if (estado.fallar.provisionar) {
    resultado.errores.push('Fallo provocado por la prueba (fallar.provisionar).');
  } else {
    try {
      resultado.api = await detectarApi();
      // Con 0.15 no hay nada que provisionar en la prueba: lo tiene todo.
      if (resultado.api === 'jmap016') await provisionar016(estado, resultado);
    } catch (err) {
      resultado.errores.push(err.message);
    }
  }
  const faltan = resultado.faltan.dominios.length + resultado.faltan.buzones.length + resultado.faltan.alias.length;
  resultado.ok = resultado.errores.length === 0 && resultado.suspensiones.fallidas.length === 0 && faltan === 0;
  if (!resultado.ok) resultado.error = resultado.errores[0] || `Faltan ${faltan} elementos del panel en el motor.`;
  if (resultado.restartRequired.length > 0) io.err(`El motor necesita reiniciarse para aplicar: ${resultado.restartRequired.join('; ')}`);
  return resultado;
}

async function capturar(io) {
  const estado = leerEstado();
  const vacio = { capturados: 0, yaEstaban: 0, fallidos: [] };
  const api = await detectarApi();
  if (api !== 'rest015') return { ok: false, error: 'Los hashes solo se pueden copiar de Stalwart 0.15.', ...vacio };
  const resultado = { ok: true, ...vacio };
  for (const email of estado.buzones) {
    const r = await pedir('GET', `/api/principal/${encodeURIComponent(email)}`);
    const hash = ((r.datos && r.datos.data && r.datos.data.secrets) || []).find((s) => /^\$6\$/.test(s));
    if (!hash) {
      resultado.fallidos.push(email);
      continue;
    }
    if (estado.hashes[email] === hash) resultado.yaEstaban += 1;
    else resultado.capturados += 1;
    estado.hashes[email] = hash;
  }
  guardarEstado(estado);
  resultado.ok = resultado.fallidos.length === 0;
  if (!resultado.ok) resultado.error = `No se ha podido copiar la contraseña de ${resultado.fallidos.join(', ')}.`;
  io.err(`Copia de contraseñas: ${resultado.capturados} copiadas, ${resultado.yaEstaban} ya estaban.`);
  return resultado;
}

async function ejecutar(argv, io) {
  const [orden, ...resto] = argv;
  switch (orden) {
    case 'estado': {
      const estado = leerEstado();
      const conHash = estado.buzones.filter((b) => estado.hashes[b]).length;
      const resultado = {
        ok: true,
        api: null,
        mantenimiento: mantenimiento(estado),
        buzones: { total: estado.buzones.length, conHash, sinHash: estado.buzones.length - conHash },
        contrasenasAplicacion: { porApi: {}, invalidadas: 0 },
        credencialesInternas: { porApi: {}, invalidadas: 0 },
        // Como el panel: un cambio de dominio sin terminar impide migrar.
        bloqueo: estado.bloqueo || null,
      };
      try {
        resultado.api = await detectarApi();
      } catch (err) {
        resultado.ok = false;
        resultado.error = err.message;
      }
      return resultado;
    }
    case 'capturar':
      return capturar(io);
    case 'mantenimiento': {
      const [modo, opcion, valor] = resto;
      const estado = leerEstado();
      if (modo === 'on') {
        const minutos = opcion === '--minutos' ? Number(valor) : 120;
        if (!Number.isInteger(minutos) || minutos < 1 || minutos > 1440) throw new ErrorDeUso(USO);
        estado.mantenimiento = { desde: Date.now(), hasta: Date.now() + minutos * 60_000 };
        io.err(`Mantenimiento del motor activado durante ${minutos} minutos.`);
      } else if (modo === 'off') {
        estado.mantenimiento = null;
        io.err('Mantenimiento del motor desactivado.');
      } else {
        throw new ErrorDeUso(USO);
      }
      guardarEstado(estado);
      return { ok: true, ...mantenimiento(estado) };
    }
    case 'provisionar':
      return provisionar(io);
    case 'tras-migrar': {
      const api = await detectarApi();
      return {
        ok: true,
        api,
        credencialesInternas: { renovadas: 0, fallidas: [] },
        contrasenasInvalidadas: 0,
        contrasenasRecuperadas: 0,
        avisados: 0,
        avisosFallidos: [],
        sinCopia: 0,
      };
    }
    default:
      throw new ErrorDeUso(USO);
  }
}

const io = { out: (linea) => process.stdout.write(`${linea}\n`), err: (linea) => process.stderr.write(`${linea}\n`) };
ejecutar(process.argv.slice(2), io).then(
  (resultado) => {
    io.out(JSON.stringify(resultado));
    if (!resultado.ok && resultado.error) io.err(`Error: ${resultado.error}`);
    process.exitCode = resultado.ok ? 0 : 1;
  },
  (err) => {
    if (err instanceof ErrorDeUso) {
      io.err(err.message);
      process.exitCode = 2;
      return;
    }
    io.out(JSON.stringify({ ok: false, error: err.message }));
    io.err(`Error: ${err.message}`);
    process.exitCode = 1;
  },
);
