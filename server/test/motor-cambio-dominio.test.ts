import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../src/core/errors';
import { sha512Crypt } from '../src/core/sha512crypt';
import { DemoEngine } from '../src/engine/demo';
import { StalwartEngine } from '../src/engine/stalwart';
import { fusionarDirecciones } from '../src/engine/types';
import { fakeStalwart } from './stalwart-falso';

/*
 * Contrato del motor para el cambio de dominio (dominio.es → dominio2.es):
 * getPrincipal, setAddresses, renamePrincipal, reloadDirectory y removeDkim,
 * más el endurecimiento de createMailbox (no adoptar un usuario viejo que
 * sigue en el motor con otras direcciones). Primero el driver real contra un
 * Stalwart falso con la semántica de la API de gestión de la v0.15.5; después
 * el motor de demostración, que debe comportarse igual.
 */

const SECRETO = 'secreto-motor';
const motorFalso = fakeStalwart(SECRETO);
let motor: StalwartEngine;

before(async () => {
  const url = await motorFalso.listen();
  motor = new StalwartEngine({
    kind: 'stalwart',
    url,
    adminUser: 'admin',
    adminPassword: SECRETO,
    smtpHost: '127.0.0.1',
    smtpPort: 587,
    smtpSecure: false,
  });
});

after(() => motorFalso.close());

beforeEach(() => {
  motorFalso.principals.clear();
  motorFalso.settings.clear();
  motorFalso.received.length = 0;
  motorFalso.reloadErrors = {};
  motorFalso.listasComoCadena = false;
});

const CLAVE = 'Clave-Principal-1';
const CLAVE_APP = 'Clave-App-Movil-1';

/** dominio viejo y nuevo, ana con contraseña y contraseña de aplicación, y la lista info con ana. */
function sembrar(): { ana: number; info: number; app: string } {
  motorFalso.crearPrincipal({ type: 'domain', name: 'viejo.test' });
  motorFalso.crearPrincipal({ type: 'domain', name: 'nuevo.test' });
  const app = `$app$movil$${sha512Crypt(CLAVE_APP)}`;
  const ana = motorFalso.crearPrincipal({
    type: 'individual',
    name: 'ana@viejo.test',
    secrets: [sha512Crypt(CLAVE), app],
    emails: ['ana@viejo.test'],
    roles: ['user'],
  });
  const info = motorFalso.crearPrincipal({
    type: 'list',
    name: 'info@viejo.test',
    emails: ['info@viejo.test'],
    members: [ana],
  });
  return { ana, info, app };
}

/** Peticiones de modificación recibidas (método y ruta), sin las lecturas. */
function escrituras(): string[] {
  return motorFalso.received.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
}

function cuerpos(metodo: string): unknown[] {
  return motorFalso.received.filter((r) => r.method === metodo).map((r) => JSON.parse(r.body) as unknown);
}

const codigo = (code: string) => (err: unknown) => err instanceof HttpError && err.code === code;

describe('driver de Stalwart', () => {
  test('getPrincipal: emails como lista, como cadena o ausente; null si no existe', async () => {
    sembrar();
    assert.deepEqual(await motor.getPrincipal('ana@viejo.test'), {
      id: motorFalso.principal('ana@viejo.test')!.id,
      type: 'individual',
      name: 'ana@viejo.test',
      emails: ['ana@viejo.test'],
    });

    // Un solo valor como cadena (Stalwart lo da así en algunos campos).
    motorFalso.listasComoCadena = true;
    const comoCadena = await motor.getPrincipal('ana@viejo.test');
    assert.deepEqual(comoCadena?.emails, ['ana@viejo.test']);
    motorFalso.listasComoCadena = false;

    // Un dominio no tiene direcciones: Stalwart omite el campo.
    const dominio = await motor.getPrincipal('viejo.test');
    assert.equal(dominio?.type, 'domain');
    assert.deepEqual(dominio?.emails, []);

    assert.equal(await motor.getPrincipal('nadie@viejo.test'), null);
    // Sin secretos: la lectura no los expone.
    assert.ok(!('secrets' in (comoCadena as object)));
  });

  test('setAddresses fusiona y envía un único PATCH «set emails»; sin cambios no envía nada', async () => {
    sembrar();

    // Pre-recepción: añade la nueva al final; la principal sigue siendo la vieja.
    assert.deepEqual(await motor.setAddresses('ana@viejo.test', { add: ['Ana@Nuevo.test'] }), [
      'ana@viejo.test',
      'ana@nuevo.test',
    ]);
    assert.deepEqual(escrituras(), ['PATCH /api/principal/ana%40viejo.test']);
    assert.deepEqual(cuerpos('PATCH'), [
      [{ action: 'set', field: 'emails', value: ['ana@viejo.test', 'ana@nuevo.test'] }],
    ]);

    // Repetirlo no envía nada (idempotente).
    motorFalso.received.length = 0;
    assert.deepEqual(await motor.setAddresses('ana@viejo.test', { add: ['ana@nuevo.test'] }), [
      'ana@viejo.test',
      'ana@nuevo.test',
    ]);
    assert.deepEqual(escrituras(), []);

    // Pasar: la nueva pasa a ser la principal y la vieja se conserva.
    assert.deepEqual(await motor.setAddresses('ana@viejo.test', { primary: 'ana@nuevo.test' }), [
      'ana@nuevo.test',
      'ana@viejo.test',
    ]);
    assert.deepEqual(motorFalso.principal('ana@viejo.test')!.emails, ['ana@nuevo.test', 'ana@viejo.test']);

    // Baja: quita la vieja y conserva las que no se mencionan.
    motorFalso.received.length = 0;
    assert.deepEqual(await motor.setAddresses('ana@viejo.test', { remove: ['ana@viejo.test'] }), ['ana@nuevo.test']);
    assert.equal(escrituras().length, 1);
    // Sin recargar: eso lo decide quien llama.
    assert.ok(!motorFalso.received.some((r) => r.path === '/api/reload'));
  });

  test('setAddresses: dominio sin dar de alta → engine_not_found; dirección de otro → engine_exists; sin tocar nada', async () => {
    sembrar();
    await assert.rejects(
      motor.setAddresses('ana@viejo.test', { add: ['ana@otro.test'] }),
      (err: HttpError) => err.code === 'engine_not_found' && /otro\.test/.test(err.message),
    );
    await assert.rejects(motor.setAddresses('ana@viejo.test', { add: ['info@viejo.test'] }), codigo('engine_exists'));
    await assert.rejects(motor.setAddresses('nadie@viejo.test', { add: ['nadie@nuevo.test'] }), codigo('engine_not_found'));
    assert.deepEqual(motorFalso.principal('ana@viejo.test')!.emails, ['ana@viejo.test']);
  });

  test('renamePrincipal: un solo PATCH [set name, set emails], nunca «members»; conserva id, secretos y listas', async () => {
    const { ana, info, app } = sembrar();
    await motor.setAddresses('ana@viejo.test', { add: ['ana@nuevo.test'] });
    await motor.setAddresses('info@viejo.test', { add: ['info@nuevo.test'] });
    motorFalso.received.length = 0;

    // Alias al pasar: nombre nuevo y las dos direcciones, a la vez.
    await motor.renamePrincipal('info@viejo.test', 'info@nuevo.test', {
      expectEmail: 'info@viejo.test',
      emails: ['info@nuevo.test', 'info@viejo.test'],
    });
    assert.deepEqual(escrituras(), ['PATCH /api/principal/info%40viejo.test']);
    assert.deepEqual(cuerpos('PATCH'), [
      [
        { action: 'set', field: 'name', value: 'info@nuevo.test' },
        { action: 'set', field: 'emails', value: ['info@nuevo.test', 'info@viejo.test'] },
      ],
    ]);
    assert.equal(motorFalso.principal('info@nuevo.test')?.id, info);

    // Buzón al actualizar dispositivos: solo el nombre.
    motorFalso.received.length = 0;
    await motor.renamePrincipal('ana@viejo.test', 'ana@nuevo.test', { expectEmail: 'ana@nuevo.test' });
    assert.deepEqual(cuerpos('PATCH'), [[{ action: 'set', field: 'name', value: 'ana@nuevo.test' }]]);
    const renombrada = motorFalso.principal('ana@nuevo.test')!;
    assert.equal(renombrada.id, ana, 'el número interno (y con él el correo) se conserva');
    assert.ok(renombrada.secrets.includes(app), 'la contraseña de aplicación se conserva');
    assert.equal(await motor.verifyCredentials('ana@nuevo.test', CLAVE), true);
    assert.equal(await motor.verifyCredentials('ana@nuevo.test', CLAVE_APP), true);
    assert.equal(await motor.verifyCredentials('ana@viejo.test', CLAVE), false);
    // La lista sigue entregando a ana, ya con su nombre nuevo (miembros por número).
    assert.deepEqual((await motorFalso.principal('info@nuevo.test'))!.members, [ana]);

    const todos = motorFalso.received.filter((r) => r.method === 'PATCH').map((r) => r.body);
    assert.ok(todos.every((b) => !b.includes('members')), 'renombrar nunca envía miembros');
    assert.ok(!motorFalso.received.some((r) => r.path === '/api/reload'), 'renombrar no recarga');
  });

  test('renamePrincipal es idempotente y distingue «ya hecho», «ocupado» y «no existe»', async () => {
    sembrar();
    await motor.setAddresses('ana@viejo.test', { primary: 'ana@nuevo.test' });
    await motor.renamePrincipal('ana@viejo.test', 'ana@nuevo.test', { expectEmail: 'ana@nuevo.test' });

    // Reintento tras una caída: el origen ya no existe y el destino tiene la dirección.
    motorFalso.received.length = 0;
    await motor.renamePrincipal('ana@viejo.test', 'ana@nuevo.test', { expectEmail: 'ana@nuevo.test' });
    assert.equal(motorFalso.principal('ana@nuevo.test')?.name, 'ana@nuevo.test');

    // El destino existe pero es otro principal (sin esa dirección).
    await assert.rejects(
      motor.renamePrincipal('ana@viejo.test', 'ana@nuevo.test', { expectEmail: 'otra@nuevo.test' }),
      codigo('engine_exists'),
    );
    // Los dos existen: el motor se niega (nombre ocupado) y no cambia nada.
    await assert.rejects(
      motor.renamePrincipal('info@viejo.test', 'ana@nuevo.test', { expectEmail: 'info@viejo.test' }),
      codigo('engine_exists'),
    );
    assert.equal(motorFalso.principal('info@viejo.test')?.type, 'list');
    // Ninguno de los dos.
    await assert.rejects(
      motor.renamePrincipal('luis@viejo.test', 'luis@nuevo.test', { expectEmail: 'luis@nuevo.test' }),
      codigo('engine_not_found'),
    );
    // Una dirección de un dominio que no existe no se toma por «origen inexistente».
    await assert.rejects(
      motor.renamePrincipal('info@viejo.test', 'info@nuevo.test', {
        expectEmail: 'info@viejo.test',
        emails: ['info@otro.test', 'info@viejo.test'],
      }),
      (err: HttpError) => err.code === 'engine_not_found' && /otro\.test/.test(err.message),
    );
    assert.equal(motorFalso.principal('info@viejo.test')?.name, 'info@viejo.test', 'PATCH atómico: nada cambia');
  });

  test('reloadDirectory: correcto sin errores y engine_error si la recarga los trae', async () => {
    await motor.reloadDirectory();
    assert.ok(motorFalso.received.some((r) => r.method === 'GET' && r.path === '/api/reload'));
    motorFalso.reloadErrors = { 'signature.rsa-viejo.test': 'referencia rota' };
    await assert.rejects(motor.reloadDirectory(), (err: HttpError) => {
      assert.equal(err.code, 'engine_error');
      assert.equal(err.status, 502);
      assert.match(err.message, /referencia rota/);
      return true;
    });
  });

  test('removeDkim borra solo las claves del dominio exacto ({type: delete, keys}) y recarga', async () => {
    sembrar();
    motorFalso.crearPrincipal({ type: 'domain', name: 'viejo.test.ejemplo' });
    for (const dominio of ['viejo.test', 'viejo.test.ejemplo', 'nuevo.test']) await motor.ensureDkim(dominio, '');
    const antes = [...motorFalso.settings.keys()];
    assert.ok(antes.some((k) => k.startsWith('signature.rsa-viejo.test.ejemplo.')));
    motorFalso.received.length = 0;

    const ids = await motor.removeDkim('viejo.test');
    assert.deepEqual(ids, ['ed25519-viejo.test', 'rsa-viejo.test']);
    const lectura = motorFalso.received.find((r) => r.path === '/api/settings/keys');
    assert.equal(lectura?.query, '?prefixes=signature');
    const [ops] = cuerpos('POST') as { type: string; keys: string[] }[][];
    assert.equal(ops!.length, 1);
    assert.equal(ops![0]!.type, 'delete');
    assert.ok(ops![0]!.keys.length > 0);
    assert.ok(ops![0]!.keys.every((k) => /^signature\.(rsa|ed25519)-viejo\.test\.[a-z0-9.-]+$/.test(k)));
    assert.ok(ops![0]!.keys.every((k) => !k.includes('viejo.test.ejemplo')), 'la trampa del prefijo');
    assert.ok(motorFalso.received.some((r) => r.path === '/api/reload'), 'recarga tras borrar');

    const restantes = [...motorFalso.settings.keys()];
    assert.ok(!restantes.some((k) => /^signature\.(rsa|ed25519)-viejo\.test\.(domain|private-key|selector)$/.test(k)));
    for (const id of ['rsa-viejo.test.ejemplo', 'ed25519-viejo.test.ejemplo', 'rsa-nuevo.test']) {
      assert.ok(restantes.includes(`signature.${id}.private-key`), `se conserva ${id}`);
      assert.ok(restantes.includes(`signature.${id}.domain`), `se conserva ${id}`);
    }

    // Repetirlo no borra nada ni recarga.
    motorFalso.received.length = 0;
    assert.deepEqual(await motor.removeDkim('viejo.test'), []);
    assert.deepEqual(escrituras(), []);
    assert.ok(!motorFalso.received.some((r) => r.path === '/api/reload'));
  });

  test('removeDkim propaga una recarga con errores', async () => {
    motorFalso.crearPrincipal({ type: 'domain', name: 'viejo.test' });
    await motor.ensureDkim('viejo.test', '');
    motorFalso.reloadErrors = { 'auth.dkim.sign': 'firma desconocida' };
    await assert.rejects(motor.removeDkim('viejo.test'), codigo('engine_error'));
  });

  test('createMailbox no adopta un principal con otras direcciones, ni una lista; sí el huérfano limpio', async () => {
    sembrar();
    // Usuario viejo que sigue en el motor con la dirección nueva (pendiente de actualizar).
    await motor.setAddresses('ana@viejo.test', { primary: 'ana@nuevo.test' });
    await assert.rejects(
      motor.createMailbox({ email: 'ana@viejo.test', password: 'Otra-Clave-1' }),
      (err: HttpError) => {
        assert.equal(err.code, 'engine_exists');
        assert.equal(err.message, 'El servidor de correo ya tiene un usuario con ese nombre y otras direcciones: no se adopta.');
        return true;
      },
    );
    assert.equal(await motor.verifyCredentials('ana@viejo.test', CLAVE), true, 'su contraseña no cambia');

    // Una lista con ese nombre tampoco se adopta.
    await assert.rejects(
      motor.createMailbox({ email: 'info@viejo.test', password: 'Otra-Clave-1' }),
      codigo('engine_exists'),
    );
    assert.equal(motorFalso.principal('info@viejo.test')?.type, 'list');

    // La dirección es de otro principal (con otro nombre): no hay nada que adoptar.
    await assert.rejects(
      motor.createMailbox({ email: 'ana@nuevo.test', password: 'Otra-Clave-1' }),
      codigo('engine_exists'),
    );

    // Huérfano limpio de un alta interrumpida: se adopta con la contraseña nueva.
    motorFalso.crearPrincipal({
      type: 'individual',
      name: 'luis@viejo.test',
      secrets: [sha512Crypt('Vieja-1'), `$app$x$${sha512Crypt('App-Vieja-1')}`],
      emails: ['luis@viejo.test'],
      roles: ['user'],
    });
    await motor.createMailbox({ email: 'luis@viejo.test', password: 'Nueva-Clave-1' });
    assert.equal(await motor.verifyCredentials('luis@viejo.test', 'Nueva-Clave-1'), true);
    assert.equal(await motor.verifyCredentials('luis@viejo.test', 'App-Vieja-1'), false);
  });

  test('upsertAlias de una lista que ya existe no toca sus direcciones (conserva la pre-recepción)', async () => {
    sembrar();
    await motor.setAddresses('info@viejo.test', { add: ['info@nuevo.test'] });
    await motor.upsertAlias('info@viejo.test', ['ana@viejo.test'], ['fuera@gmail.test']);
    assert.deepEqual(motorFalso.principal('info@viejo.test')!.emails, ['info@viejo.test', 'info@nuevo.test']);
    assert.deepEqual(motorFalso.principal('info@viejo.test')!.externalMembers, ['fuera@gmail.test']);
  });
});

describe('fusionarDirecciones', () => {
  test('quita, añade al final sin repetir y pone la principal la primera', () => {
    assert.deepEqual(fusionarDirecciones(['a@v.es'], { add: ['A@N.es', 'a@v.es'] }), ['a@v.es', 'a@n.es']);
    assert.deepEqual(fusionarDirecciones(['a@v.es', 'a@n.es'], { primary: 'a@n.es' }), ['a@n.es', 'a@v.es']);
    assert.deepEqual(fusionarDirecciones(['a@v.es'], { primary: 'a@n.es' }), ['a@n.es', 'a@v.es']);
    assert.deepEqual(fusionarDirecciones(['a@n.es', 'a@v.es', 'x@v.es'], { remove: ['a@v.es'] }), ['a@n.es', 'x@v.es']);
    assert.deepEqual(fusionarDirecciones(['a@v.es'], {}), ['a@v.es']);
  });
});

describe('motor de demostración', () => {
  let demo: DemoEngine;

  /** El mismo punto de partida que en el driver. */
  async function sembrarDemo(): Promise<void> {
    demo = new DemoEngine();
    await demo.createDomain('viejo.test');
    await demo.createDomain('nuevo.test');
    await demo.createMailbox({ email: 'ana@viejo.test', password: CLAVE });
    await demo.addAppPassword('ana@viejo.test', CLAVE_APP, 'movil');
    await demo.upsertAlias('info@viejo.test', ['ana@viejo.test']);
  }

  test('getPrincipal, setAddresses y cambiosSinRecargar con la misma semántica que el driver', async () => {
    await sembrarDemo();
    const ana = await demo.getPrincipal('ana@viejo.test');
    assert.equal(ana?.type, 'individual');
    assert.deepEqual(ana?.emails, ['ana@viejo.test']);
    assert.equal(await demo.getPrincipal('nadie@viejo.test'), null);
    assert.equal(demo.cambiosSinRecargar, false);

    // Sin cambios: ni escribe ni deja nada pendiente de recargar.
    assert.deepEqual(await demo.setAddresses('ana@viejo.test', { add: ['ana@viejo.test'] }), ['ana@viejo.test']);
    assert.equal(demo.cambiosSinRecargar, false);

    assert.deepEqual(await demo.setAddresses('ana@viejo.test', { add: ['ana@nuevo.test'] }), [
      'ana@viejo.test',
      'ana@nuevo.test',
    ]);
    assert.equal(demo.cambiosSinRecargar, true);
    await demo.reloadDirectory();
    assert.equal(demo.cambiosSinRecargar, false);
    assert.equal(demo.recargas, 1);

    assert.deepEqual(await demo.setAddresses('ana@viejo.test', { primary: 'ana@nuevo.test' }), [
      'ana@nuevo.test',
      'ana@viejo.test',
    ]);
    // Recibe en las dos, siempre en el mismo principal (su usuario sigue siendo el viejo).
    assert.equal(demo.entregar('ana@nuevo.test'), 'ana@viejo.test');
    assert.equal(demo.entregar('ANA@viejo.test'), 'ana@viejo.test');
    assert.equal(demo.entregar('luis@nuevo.test'), null);
    // Con el usuario viejo envía como la dirección nueva, pero no como una ajena.
    assert.equal(demo.puedeEnviarComo('ana@viejo.test', 'ana@nuevo.test'), true);
    assert.equal(demo.puedeEnviarComo('ana@viejo.test', 'otra@nuevo.test'), false);
  });

  test('unicidad de nombres y direcciones, y notFound si falta el dominio', async () => {
    await sembrarDemo();
    await assert.rejects(demo.setAddresses('ana@viejo.test', { add: ['info@viejo.test'] }), codigo('engine_exists'));
    await assert.rejects(
      demo.setAddresses('ana@viejo.test', { add: ['ana@otro.test'] }),
      (err: HttpError) => err.code === 'engine_not_found' && /otro\.test/.test(err.message),
    );
    await assert.rejects(demo.setAddresses('nadie@viejo.test', { add: ['x@nuevo.test'] }), codigo('engine_not_found'));
    assert.deepEqual((await demo.getPrincipal('ana@viejo.test'))?.emails, ['ana@viejo.test'], 'nada a medias');
    assert.equal(demo.cambiosSinRecargar, false);

    // Una dirección que ya tiene otro principal no se puede dar de alta como buzón.
    await demo.setAddresses('ana@viejo.test', { add: ['ana@nuevo.test'] });
    await assert.rejects(demo.createMailbox({ email: 'ana@nuevo.test', password: 'x' }), codigo('engine_exists'));
    // Nombre ocupado al renombrar.
    await assert.rejects(
      demo.renamePrincipal('info@viejo.test', 'ana@viejo.test', { expectEmail: 'info@viejo.test' }),
      codigo('engine_exists'),
    );
  });

  test('renombrar conserva id, contraseñas y listas; verifyCredentials por el nombre nuevo', async () => {
    await sembrarDemo();
    const antes = await demo.getPrincipal('ana@viejo.test');
    await demo.setAddresses('ana@viejo.test', { add: ['ana@nuevo.test'] });
    await demo.setAddresses('info@viejo.test', { add: ['info@nuevo.test'] });
    await demo.reloadDirectory();

    // Pasar: alias renombrado con las dos direcciones; el buzón cambia de principal.
    await demo.renamePrincipal('info@viejo.test', 'info@nuevo.test', {
      expectEmail: 'info@viejo.test',
      emails: ['info@nuevo.test', 'info@viejo.test'],
    });
    assert.equal(demo.cambiosSinRecargar, true);
    assert.equal(demo.entregar('info@viejo.test'), 'info@nuevo.test');
    assert.deepEqual((await demo.getPrincipal('info@nuevo.test'))?.emails, ['info@nuevo.test', 'info@viejo.test']);

    // Actualizar dispositivos: solo el nombre.
    await demo.renamePrincipal('ana@viejo.test', 'ana@nuevo.test', { expectEmail: 'ana@nuevo.test' });
    const despues = await demo.getPrincipal('ana@nuevo.test');
    assert.equal(despues?.id, antes?.id);
    assert.equal(await demo.getPrincipal('ana@viejo.test'), null);
    assert.equal(await demo.verifyCredentials('ana@nuevo.test', CLAVE), true);
    assert.equal(await demo.verifyCredentials('ana@nuevo.test', CLAVE_APP), true);
    assert.equal(await demo.verifyCredentials('ana@viejo.test', CLAVE), false);
    assert.equal(demo.puedeEnviarComo('ana@nuevo.test', 'ana@viejo.test'), true);
    assert.deepEqual([...(await demo.getMailboxUsage()).keys()], ['ana@nuevo.test']);

    // Idempotente, y los errores del contrato.
    await demo.renamePrincipal('ana@viejo.test', 'ana@nuevo.test', { expectEmail: 'ana@nuevo.test' });
    await assert.rejects(
      demo.renamePrincipal('ana@viejo.test', 'ana@nuevo.test', { expectEmail: 'otra@nuevo.test' }),
      codigo('engine_exists'),
    );
    await assert.rejects(
      demo.renamePrincipal('luis@viejo.test', 'luis@nuevo.test', { expectEmail: 'luis@nuevo.test' }),
      codigo('engine_not_found'),
    );

    // La lista sigue entregando a ana (miembros por id): un upsert con su nombre nuevo vale.
    await demo.upsertAlias('info@nuevo.test', ['ana@nuevo.test']);
    assert.deepEqual(
      (await demo.getPrincipal('info@nuevo.test'))?.emails,
      ['info@nuevo.test', 'info@viejo.test'],
      'upsertAlias de una lista que existe conserva sus direcciones',
    );
    // Un miembro que no es un nombre del motor falla sin tocar la lista.
    await assert.rejects(demo.upsertAlias('info@nuevo.test', ['ana@viejo.test']), codigo('engine_not_found'));

    // Cambiar la contraseña tras renombrar conserva la de aplicación.
    await demo.setMailboxPassword('ana@nuevo.test', 'Clave-Principal-2');
    assert.equal(await demo.verifyCredentials('ana@nuevo.test', 'Clave-Principal-2'), true);
    assert.equal(await demo.verifyCredentials('ana@nuevo.test', CLAVE), false);
    assert.equal(await demo.verifyCredentials('ana@nuevo.test', CLAVE_APP), true);
  });

  test('createMailbox no adopta un principal con otras direcciones; la suspensión va por nombre', async () => {
    await sembrarDemo();
    await demo.setAddresses('ana@viejo.test', { primary: 'ana@nuevo.test' });
    await assert.rejects(demo.createMailbox({ email: 'ana@viejo.test', password: 'Otra-1' }), (err: HttpError) => {
      assert.equal(err.code, 'engine_exists');
      assert.match(err.message, /no se adopta/);
      return true;
    });
    assert.equal(await demo.verifyCredentials('ana@viejo.test', CLAVE), true);
    await assert.rejects(demo.createMailbox({ email: 'info@viejo.test', password: 'Otra-1' }), codigo('engine_exists'));

    // El huérfano limpio sí se adopta (sin sus contraseñas de aplicación).
    await demo.createMailbox({ email: 'luis@viejo.test', password: 'Vieja-1' });
    await demo.addAppPassword('luis@viejo.test', 'App-1', 'x');
    await demo.createMailbox({ email: 'luis@viejo.test', password: 'Nueva-1' });
    assert.equal(await demo.verifyCredentials('luis@viejo.test', 'Nueva-1'), true);
    assert.equal(await demo.verifyCredentials('luis@viejo.test', 'App-1'), false);

    await demo.updateMailbox('ana@viejo.test', { suspended: true });
    assert.equal(await demo.verifyCredentials('ana@viejo.test', CLAVE), false);
    assert.equal(demo.puedeEnviarComo('ana@viejo.test', 'ana@nuevo.test'), true, 'el remitente no depende de la suspensión');
    await demo.updateMailbox('ana@viejo.test', { suspended: false });
    assert.equal(await demo.verifyCredentials('ana@viejo.test', CLAVE), true);

    // Las operaciones de buzón sobre un usuario que no existe fallan como en el motor.
    await assert.rejects(demo.setMailboxPassword('nadie@viejo.test', 'x'), codigo('engine_not_found'));
    await demo.deleteMailbox('nadie@viejo.test');
  });

  test('removeDkim borra solo el dominio exacto, recarga y lo anota; borrar el dominio deja de recibir', async () => {
    await sembrarDemo();
    await demo.createDomain('viejo.test.ejemplo');
    for (const d of ['viejo.test', 'viejo.test.ejemplo', 'nuevo.test']) await demo.ensureDkim(d, '');
    const recargas = demo.recargas;

    await demo.deleteDomain('viejo.test');
    assert.equal(demo.dominios.has('viejo.test'), false);
    assert.equal(demo.entregar('ana@viejo.test'), null, 'sin dominio, el motor rechaza el correo');
    assert.deepEqual(await demo.removeDkim('viejo.test'), ['ed25519-viejo.test', 'rsa-viejo.test']);
    assert.deepEqual(demo.dkimBorrados, ['viejo.test']);
    assert.equal(demo.recargas, recargas + 1);
    assert.deepEqual(await demo.removeDkim('viejo.test'), [], 'idempotente');
    assert.deepEqual(await demo.removeDkim('viejo.test.ejemplo'), ['ed25519-viejo.test.ejemplo', 'rsa-viejo.test.ejemplo']);
  });

  test('fallarProxima inyecta un engine_error en la llamada que coincide, una sola vez', async () => {
    await sembrarDemo();
    await demo.createMailbox({ email: 'luis@viejo.test', password: CLAVE });
    demo.fallarProxima('setAddresses', 'luis@viejo.test');

    // Otro nombre no lo consume.
    await demo.setAddresses('ana@viejo.test', { add: ['ana@nuevo.test'] });
    await assert.rejects(demo.setAddresses('LUIS@viejo.test', { add: ['luis@nuevo.test'] }), codigo('engine_error'));
    assert.deepEqual((await demo.getPrincipal('luis@viejo.test'))?.emails, ['luis@viejo.test']);
    // Reintentar funciona.
    await demo.setAddresses('luis@viejo.test', { add: ['luis@nuevo.test'] });

    // Sin nombre: la siguiente llamada a ese método, sea cual sea.
    demo.fallarProxima('reloadDirectory');
    await assert.rejects(demo.reloadDirectory(), codigo('engine_error'));
    assert.equal(demo.cambiosSinRecargar, true, 'una recarga fallida no limpia la marca');
    await demo.reloadDirectory();
    assert.equal(demo.cambiosSinRecargar, false);

    // verifyCredentials y ping no lanzan: «sin comprobar» y motor caído.
    demo.fallarProxima('verifyCredentials');
    assert.equal(await demo.verifyCredentials('ana@viejo.test', CLAVE), null);
    demo.fallarProxima('ping');
    assert.equal((await demo.ping()).ok, false);
    assert.equal((await demo.ping()).ok, true);
  });
});
