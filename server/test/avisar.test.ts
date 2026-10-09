import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { db } from '../src/core/db';
import { fireAlert, listAlerts } from '../src/modules/alerts';
import { setJsonSetting } from '../src/modules/settings';
import { avisar, describirResultado, leerArgumentos, limpiarTexto } from '../src/tools/avisar';

/*
 * Herramienta de avisos desde la terminal (contrato de «mailway update
 * --auto»): abre incidencias en Avisos con la misma deduplicación que el
 * vigilante, las envía por los canales y no falla cuando no hay ninguno.
 * Nunca imprime las URL ni los tokens de los canales.
 */

const SERVIDOR = path.resolve(__dirname, '..');

/** Webhook local: guarda lo que recibe y responde con el código indicado. */
const recibidos: Record<string, unknown>[] = [];
let respuesta = 200;
const webhook = http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (trozo) => (cuerpo += trozo));
  req.on('end', () => {
    recibidos.push(JSON.parse(cuerpo) as Record<string, unknown>);
    res.writeHead(respuesta).end();
  });
});
let webhookUrl = '';

function canales(url = ''): void {
  setJsonSetting('notify', { webhookUrl: url, discordUrl: '', telegramToken: '', telegramChat: '' });
}

beforeEach(async () => {
  db.prepare('DELETE FROM alerts').run();
  canales();
  recibidos.length = 0;
  respuesta = 200;
  if (!webhookUrl) {
    await new Promise<void>((listo) => webhook.listen(0, '127.0.0.1', listo));
    webhookUrl = `http://127.0.0.1:${(webhook.address() as AddressInfo).port}/canal/token-del-canal`;
  }
});

after(() => webhook.close());

const base = {
  nivel: 'aviso',
  clave: 'actualizacion:revertida:3f2c1a9b',
  titulo: 'Actualización automática revertida',
  mensaje: 'La versión 1.3.1 no superó la comprobación y el servidor ha vuelto a la 1.3.0.',
  remedio: 'Revisa: sudo mailway auto-update status',
};

function abiertas() {
  return listAlerts({});
}

test('lee las opciones, también con «=», y rechaza las demás sin repetirlas', () => {
  assert.deepEqual(leerArgumentos(['--nivel', 'aviso', '--clave=a:b', '--titulo', 'T', '--mensaje', 'M']), {
    nivel: 'aviso',
    clave: 'a:b',
    titulo: 'T',
    mensaje: 'M',
  });
  assert.throws(() => leerArgumentos(['--token', 'sky_secreto123']), (err: Error) => {
    assert.match(err.message, /Opción --token: solo se admiten/);
    assert.ok(!err.message.includes('sky_secreto123'));
    return true;
  });
  assert.throws(() => leerArgumentos(['sky_secreto123']), /Opción no reconocida/);
  assert.throws(() => leerArgumentos(['--nivel', 'aviso', '--nivel', 'info']), /está repetida/);
  assert.throws(() => leerArgumentos(['--titulo']), /Falta el valor de --titulo/);
  assert.throws(() => leerArgumentos(['--titulo', '--mensaje', 'M']), /Falta el valor de --titulo/);
});

test('limpia colores, caracteres de control y espacios, y acorta', () => {
  assert.equal(limpiarTexto('\u001b[33m[aviso]\u001b[0m  mailway-webmail:\tunhealthy\r\n', 100), '[aviso] mailway-webmail: unhealthy');
  assert.equal(limpiarTexto('uno\r\ndos\n\n\n\ntres\u0007', 100, true), 'uno\ndos\n\ntres');
  assert.equal(limpiarTexto('abcdefghij', 5), 'abcd…');
});

test('valida el nivel, la clave y el título', async () => {
  await assert.rejects(avisar({ ...base, nivel: 'urgente' }), /info, aviso o critico/);
  await assert.rejects(avisar({ ...base, clave: 'Actualización revertida' }), /La clave solo admite/);
  await assert.rejects(avisar({ ...base, titulo: '\u001b[0m \u0007 ' }), /no puede quedar vacío/);
  const { titulo: _titulo, ...sinTitulo } = base;
  await assert.rejects(avisar(sinTitulo), /Indica el título/);
  assert.equal(abiertas().length, 0);
});

test('sin canales, abre la incidencia en Avisos y no la repite mientras siga abierta', async () => {
  const primero = await avisar(base);
  assert.deepEqual(primero, { registrado: true, repetido: false, enviados: [], fallidos: [] });
  assert.equal(describirResultado(primero, 'aviso'), 'Incidencia abierta en Avisos (no hay canales de aviso configurados).');
  const [alerta] = abiertas();
  assert.equal(alerta?.severity, 'warning');
  assert.equal(alerta?.type, 'actualizacion');
  assert.equal(alerta?.title, base.titulo);
  assert.equal(alerta?.remedy, base.remedio);

  const segundo = await avisar(base);
  assert.equal(segundo.repetido, true);
  assert.equal(describirResultado(segundo, 'aviso'), 'Ya había una incidencia abierta en Avisos con esta clave: no se repite.');
  assert.equal(abiertas().length, 1);
});

test('una situación nueva de la misma familia sustituye a la anterior; las de otras familias siguen', async () => {
  fireAlert({ severity: 'critical', type: 'engine_down', dedupeKey: 'engine_down', title: 'Motor caído', message: '', quiet: true });
  await avisar(base);
  await avisar({ ...base, nivel: 'critico', clave: 'actualizacion:sin-revertir:3f2c1a9b', titulo: 'Sin vuelta atrás' });
  const claves = abiertas().map((a) => `${a.type}/${a.severity}/${a.title}`).sort();
  assert.deepEqual(claves, ['actualizacion/critical/Sin vuelta atrás', 'engine_down/critical/Motor caído']);
  assert.equal(listAlerts({ includeResolved: true }).length, 3, 'la sustituida queda en el historial');
});

test('«info» cierra las incidencias de su familia sin abrir ninguna', async () => {
  await avisar(base);
  const resultado = await avisar({ nivel: 'info', clave: 'actualizacion:aplicada', titulo: 'Mailway actualizado' });
  assert.deepEqual(resultado, { registrado: false, repetido: false, enviados: [], fallidos: [] });
  assert.equal(describirResultado(resultado, 'info'), 'No hay canales de aviso configurados: no se envía nada.');
  assert.equal(abiertas().length, 0);
});

test('con un canal, envía el aviso y no muestra su URL', async () => {
  canales(webhookUrl);
  const resultado = await avisar({ ...base, nivel: 'critico', mensaje: 'Detalle:\n\u001b[33m[aviso]\u001b[0m webmail caído' });
  assert.deepEqual(resultado, { registrado: true, repetido: false, enviados: ['webhook'], fallidos: [] });
  assert.equal(recibidos.length, 1);
  assert.equal(recibidos[0]!.source, 'mailway');
  assert.equal(recibidos[0]!.severity, 'critical');
  assert.equal(recibidos[0]!.title, base.titulo);
  assert.equal(recibidos[0]!.message, 'Detalle:\n[aviso] webmail caído');
  const linea = describirResultado(resultado, 'critico');
  assert.equal(linea, 'Incidencia abierta en Avisos; enviado por webhook.');
  assert.ok(!linea.includes('token-del-canal'));

  // Una incidencia repetida no se vuelve a enviar.
  await avisar({ ...base, nivel: 'critico' });
  assert.equal(recibidos.length, 1);

  // «info» también llega a los canales.
  const info = await avisar({ nivel: 'info', clave: 'actualizacion:aplicada', titulo: 'Mailway actualizado a la versión 1.3.1' });
  assert.deepEqual(info.enviados, ['webhook']);
  assert.equal(recibidos[1]!.severity, 'info');
  assert.equal(describirResultado(info, 'info'), 'Aviso enviado por webhook.');
});

test('un canal que falla no impide registrar la incidencia', async () => {
  canales(webhookUrl);
  respuesta = 500;
  const resultado = await avisar(base);
  assert.deepEqual(resultado, { registrado: true, repetido: false, enviados: [], fallidos: ['webhook'] });
  assert.equal(describirResultado(resultado, 'aviso'), 'Incidencia abierta en Avisos; no se ha podido enviar por webhook.');
  assert.equal(abiertas().length, 1);
});

function ejecutar(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/tools/avisar.ts', ...args], {
    cwd: SERVIDOR,
    encoding: 'utf8',
    timeout: 60_000,
    env: process.env,
  });
}

test('desde la terminal: código 0 aunque el canal no responda, y una sola línea sin secretos', () => {
  // Puerto 9: conexión rechazada al instante (spawnSync bloquea este proceso,
  // así que el webhook local no podría contestar).
  canales('http://127.0.0.1:9/canal/token-del-canal');
  const r = ejecutar([
    '--nivel',
    'critico',
    '--clave',
    'actualizacion:sin-revertir:3f2c1a9b',
    '--titulo',
    'Actualización automática sin vuelta atrás',
    '--mensaje',
    'La versión anterior tampoco supera la comprobación.',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'Incidencia abierta en Avisos; no se ha podido enviar por webhook.\n');
  assert.ok(!r.stdout.includes('token-del-canal') && !r.stderr.includes('token-del-canal'));
  const [alerta] = abiertas();
  assert.equal(alerta?.severity, 'critical');
  assert.equal(alerta?.title, 'Actualización automática sin vuelta atrás');
});

test('desde la terminal: un error de uso termina con código 1 sin repetir lo recibido', () => {
  const r = ejecutar(['--nivel', 'aviso', '--token', 'sky_secreto123']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Opción --token: solo se admiten/);
  assert.ok(!r.stderr.includes('sky_secreto123') && !r.stdout.includes('sky_secreto123'));

  const sinClave = ejecutar(['--nivel', 'aviso', '--titulo', 'T']);
  assert.equal(sinClave.status, 1);
  assert.match(sinClave.stderr, /Indica la clave del aviso con --clave/);
  assert.equal(abiertas().length, 0);
});
