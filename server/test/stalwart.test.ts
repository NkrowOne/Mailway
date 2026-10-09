import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../src/core/errors';
import { sha512Crypt, verifySha512Crypt } from '../src/core/sha512crypt';
import { RutaDeGestionAusente } from '../src/engine/errores';
import { Stalwart015Engine } from '../src/engine/stalwart';

/*
 * Driver de Stalwart 0.15 contra un `fetch` falso con la semántica real de su
 * API de gestión (comprobada en su código fuente):
 * - los errores de gestión vuelven con HTTP 200 y { error, item } sin «data»;
 * - «notFound» lleva en `item` el nombre que no existe (el principal de la
 *   ruta o un miembro de la lista);
 * - los miembros de una lista deben existir y se validan antes de escribir;
 * - un GET omite los campos vacíos (un buzón sin roles llega SIN «roles»);
 * - el rol «user» da los permisos de un buzón, entre ellos `authenticate`
 *   (entrar) y `email-receive` (recibir correo), y `disabledPermissions` los
 *   quita uno a uno (comprobado con el 0.15.5 real: sin el rol, el correo que
 *   llega se devuelve al remitente);
 * - roles, listas y grupos son una misma relación: «set roles» la reescribe
 *   entera (el principal sale de todas sus listas) y «addItem» solo añade;
 * - un HTTP 404 solo significa «ruta desconocida»;
 * - addItem de un secreto que no es $app$ sustituye la contraseña principal.
 */

interface Principal {
  type: 'individual' | 'list' | 'domain';
  secrets?: string[];
  roles?: string[];
  disabledPermissions?: string[];
  members?: string[];
  externalMembers?: string[];
}

interface Llamada {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

const principales = new Map<string, Principal>();
const ajustes = new Map<string, string>();
const llamadas: Llamada[] = [];
/** true = el servidor no conoce ninguna ruta (URL del motor mal configurada, o motor ya migrado). */
let rutaDesconocida = false;
/** true = el motor rechaza la contraseña de administración. */
let sinPermiso = false;
/**
 * Nombre en ejecución del motor (core.network.server_name): con el que genera
 * los registros DNS. null = no propone ningún MX; Error = fallo de gestión.
 */
let nombreEnEjecucion: string | null | Error = 'mail.acme.test';

function respuesta(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sinVacios(p: Principal): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(p).filter(([, v]) => !(Array.isArray(v) && v.length === 0) && v !== undefined),
  );
}

/** Como «set roles» en 0.15.5: reescribe roles, listas y grupos a la vez. */
function sacarDeLasListas(nombre: string): void {
  for (const p of principales.values()) {
    if (p.type === 'list' && p.members) p.members = p.members.filter((m) => m !== nombre);
  }
}

function faltaMiembro(miembros: unknown): string | null {
  if (!Array.isArray(miembros)) return null;
  for (const m of miembros as string[]) if (!principales.has(m)) return m;
  return null;
}

const fetchOriginal = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
  llamadas.push({ method, path: url.pathname, query: url.search, body });
  if (rutaDesconocida) return respuesta(404, { status: 404, title: 'Not Found' });
  if (sinPermiso) return respuesta(401, { status: 401, title: 'Unauthorized', detail: 'You have to authenticate first.' });

  // Como dns.rs de la v0.15.5: genera los registros de cualquier nombre, sin
  // exigir que el dominio exista, con el nombre en ejecución del servidor.
  if (url.pathname.startsWith('/api/dns/records/') && method === 'GET') {
    const dominio = decodeURIComponent(url.pathname.slice('/api/dns/records/'.length));
    if (nombreEnEjecucion instanceof Error) return respuesta(200, { error: 'other', details: nombreEnEjecucion.message });
    if (nombreEnEjecucion === null) return respuesta(200, { data: [] });
    return respuesta(200, {
      data: [
        { type: 'MX', name: `${dominio}.`, content: `10 ${nombreEnEjecucion}.` },
        { type: 'CNAME', name: `mail.${dominio}.`, content: `${nombreEnEjecucion}.` },
        { type: 'TXT', name: `${dominio}.`, content: 'v=spf1 mx ra=postmaster -all' },
      ],
    });
  }

  if (url.pathname === '/api/settings' && method === 'POST') {
    for (const op of body as { type: string; prefix: string | null; values: [string, string][] }[]) {
      if (op.type !== 'insert') continue;
      for (const [clave, valor] of op.values) ajustes.set(op.prefix ? `${op.prefix}.${clave}` : clave, valor);
    }
    return respuesta(200, { data: null });
  }
  if (url.pathname === '/api/settings/keys' && method === 'GET') {
    const claves = (url.searchParams.get('keys') ?? '').split(',').filter(Boolean);
    return respuesta(200, { data: Object.fromEntries(claves.map((c) => [c, ajustes.get(c) ?? null])) });
  }
  if (url.pathname === '/api/reload' && method === 'GET') {
    return respuesta(200, { data: { errors: {}, warnings: {} } });
  }

  if (url.pathname === '/api/principal' && method === 'GET') {
    const tipos = (url.searchParams.get('types') ?? '').split(',');
    const items = [...principales.entries()]
      .filter(([, p]) => tipos.includes(p.type))
      .map(([nombre]) => ({ name: nombre }));
    return respuesta(200, { data: { items, total: items.length } });
  }

  const nombre = decodeURIComponent(url.pathname.replace(/^\/api\/principal\/?/, ''));
  if (url.pathname === '/api/principal' && method === 'POST') {
    const nuevo = body as Principal & { name: string };
    if (principales.has(nuevo.name)) {
      return respuesta(200, { error: 'fieldAlreadyExists', field: 'name', value: nuevo.name });
    }
    const falta = faltaMiembro(nuevo.members);
    if (falta) return respuesta(200, { error: 'notFound', item: falta });
    principales.set(nuevo.name, {
      type: nuevo.type,
      secrets: nuevo.secrets,
      roles: nuevo.roles,
      disabledPermissions: nuevo.disabledPermissions,
      members: nuevo.members,
      externalMembers: nuevo.externalMembers,
    });
    return respuesta(200, { data: 1 });
  }
  const actual = principales.get(nombre);
  if (!actual) return respuesta(200, { error: 'notFound', item: nombre });
  if (method === 'GET') return respuesta(200, { data: { name: nombre, ...sinVacios(actual) } });
  if (method === 'DELETE') {
    principales.delete(nombre);
    return respuesta(200, { data: null });
  }
  if (method === 'PATCH') {
    const cambios = body as { action: string; field: keyof Principal; value: unknown }[];
    // Se valida todo antes de escribir nada, como Stalwart.
    for (const c of cambios) {
      const falta = c.field === 'members' ? faltaMiembro(c.value) : null;
      if (falta) return respuesta(200, { error: 'notFound', item: falta });
    }
    for (const c of cambios) {
      if (c.action === 'set') {
        (actual as unknown as Record<string, unknown>)[c.field] = c.value;
        if (c.field === 'roles') sacarDeLasListas(nombre);
      } else if (c.action === 'addItem' && c.field === 'roles') {
        const roles = actual.roles ?? [];
        if (!roles.includes(c.value as string)) actual.roles = [...roles, c.value as string];
      }
      if (c.field !== 'secrets') continue;
      const secretos = actual.secrets ?? [];
      const valor = String(c.value);
      if (c.action === 'addItem') {
        // Un secreto que no es $app$ sustituye la contraseña principal.
        actual.secrets = valor.startsWith('$app$')
          ? [...secretos, valor]
          : [valor, ...secretos.filter((x) => x.startsWith('$app$'))];
      }
      if (c.action === 'removeItem') actual.secrets = secretos.filter((x) => x !== valor);
    }
    return respuesta(200, { data: null });
  }
  return respuesta(404, { status: 404, title: 'Not Found' });
}) as typeof fetch;

after(() => {
  globalThis.fetch = fetchOriginal;
});

beforeEach(() => {
  principales.clear();
  ajustes.clear();
  llamadas.length = 0;
  rutaDesconocida = false;
  sinPermiso = false;
  nombreEnEjecucion = 'mail.acme.test';
});

const motor = new Stalwart015Engine({
  kind: 'stalwart',
  url: 'http://motor.test:8080',
  adminUser: 'admin',
  adminPassword: 'secreto',
  smtpHost: 'motor.test',
  smtpPort: 587,
  smtpSecure: false,
});

/** ¿Tiene el principal ese permiso? Como en 0.15.5: lo da el rol «user» y lo quita disabledPermissions. */
function tienePermiso(nombre: string, permiso: string): boolean {
  const p = principales.get(nombre);
  return Boolean(p?.roles?.includes('user')) && !(p?.disabledPermissions ?? []).includes(permiso);
}

function buzon(nombre: string, extra: Partial<Principal> = {}): void {
  principales.set(nombre, { type: 'individual', secrets: [sha512Crypt('clave-correcta')], roles: ['user'], ...extra });
}

/** Lo que se pide al motor al suspender y al reactivar un buzón. */
const SUSPENDER = [
  { action: 'addItem', field: 'roles', value: 'user' },
  { action: 'set', field: 'disabledPermissions', value: ['authenticate', 'authenticate-oauth'] },
];
const REACTIVAR = [
  { action: 'addItem', field: 'roles', value: 'user' },
  { action: 'set', field: 'disabledPermissions', value: [] },
];

/* --------------------------------- Alias ---------------------------------- */

test('upsertAlias de una lista existente: un único PATCH, sin borrarla', async () => {
  buzon('ana@acme.test');
  buzon('bob@acme.test');
  principales.set('ventas@acme.test', { type: 'list', members: ['ana@acme.test'], externalMembers: [] });

  await motor.upsertAlias('ventas@acme.test', ['ana@acme.test', 'bob@acme.test'], ['fuera@gmail.test']);

  assert.deepEqual(
    llamadas.map((l) => `${l.method} ${l.path}`),
    ['PATCH /api/principal/ventas%40acme.test'],
  );
  assert.deepEqual(llamadas[0]!.body, [
    { action: 'set', field: 'members', value: ['ana@acme.test', 'bob@acme.test'] },
    { action: 'set', field: 'externalMembers', value: ['fuera@gmail.test'] },
  ]);
  assert.deepEqual(principales.get('ventas@acme.test')?.members, ['ana@acme.test', 'bob@acme.test']);
  assert.deepEqual(principales.get('ventas@acme.test')?.externalMembers, ['fuera@gmail.test']);
});

test('upsertAlias de una lista que no existe: la crea con POST', async () => {
  buzon('ana@acme.test');
  await motor.upsertAlias('info@acme.test', ['ana@acme.test'], []);
  assert.deepEqual(
    llamadas.map((l) => l.method),
    ['PATCH', 'POST'],
  );
  assert.equal(principales.get('info@acme.test')?.type, 'list');
  assert.deepEqual(principales.get('info@acme.test')?.members, ['ana@acme.test']);
});

test('upsertAlias con un miembro inexistente falla sin tocar la lista', async () => {
  buzon('ana@acme.test');
  principales.set('ventas@acme.test', { type: 'list', members: ['ana@acme.test'], externalMembers: [] });

  await assert.rejects(
    motor.upsertAlias('ventas@acme.test', ['ana@acme.test', 'bob@acme.test'], []),
    (err: HttpError) => err.code === 'engine_not_found' && /bob@acme\.test/.test(err.message),
  );
  // Antes se borraba la lista y la creación fallaba: el alias desaparecía.
  assert.deepEqual(principales.get('ventas@acme.test')?.members, ['ana@acme.test']);
  assert.ok(!llamadas.some((l) => l.method === 'DELETE' || l.method === 'POST'));
});

/* ------------------------------ HTTP 404 real ------------------------------ */

test('un HTTP 404 (ruta desconocida) es RutaDeGestionAusente, nunca «no existe»', async () => {
  buzon('ana@acme.test');
  rutaDesconocida = true;

  await assert.rejects(motor.deleteMailbox('ana@acme.test'), (err: HttpError) => {
    assert.ok(err instanceof RutaDeGestionAusente, 'la fachada vuelve a averiguar la versión del motor');
    assert.equal(err.code, 'engine_error');
    assert.match(err.message, /no reconoce la ruta de gestión/);
    return true;
  });
  await assert.rejects(motor.deleteAlias('ventas@acme.test'), (err: HttpError) => err instanceof RutaDeGestionAusente);
  await assert.rejects(motor.deleteDomain('acme.test'), (err: HttpError) => err instanceof RutaDeGestionAusente);
  assert.equal(principales.has('ana@acme.test'), true);

  // Sin poder leer, las credenciales no son «no existe»: es un error del motor.
  await assert.rejects(motor.readMailboxCredentials('ana@acme.test'), (err: HttpError) => err instanceof RutaDeGestionAusente);
  const salud = await motor.ping();
  assert.equal(salud.ok, false);
  assert.equal(salud.api, 'rest015');
  assert.match(salud.detail ?? '', /Revisa la URL del motor/);
});

test('un HTTP 401 es un error de credenciales del motor', async () => {
  sinPermiso = true;
  await assert.rejects(motor.getMailboxUsage(), (err: HttpError) => {
    assert.equal(err.code, 'engine_auth_failed');
    assert.match(err.message, /usuario o la contraseña de administración/);
    return true;
  });
});

test('un borrado de algo que ya no existe ({ error: "notFound" }) sigue siendo idempotente', async () => {
  await motor.deleteMailbox('nadie@acme.test');
  await motor.deleteAlias('nada@acme.test');
});

/* ------------------------- Contraseñas del buzón --------------------------- */

test('createMailbox y setMailboxPassword envían el hash $6$, nunca la contraseña', async () => {
  const hash = sha512Crypt('una-clave-segura');
  await motor.createMailbox({ email: 'ana@acme.test', passwordHash: hash, displayName: 'Ana', quotaBytes: 1024 });
  assert.deepEqual(principales.get('ana@acme.test')?.secrets, [hash]);
  assert.ok(!JSON.stringify(llamadas).includes('una-clave-segura'));

  const app = await motor.addAppPassword('ana@acme.test', 'mw-movil-1a2b3c4d', 'abcd-efgh-jkmn-pqrs');
  const nuevo = sha512Crypt('otra-clave-segura');
  await motor.setMailboxPassword('ana@acme.test', nuevo);
  assert.deepEqual(principales.get('ana@acme.test')?.secrets, [nuevo, app.ref], 'conserva las de aplicación');

  // Un texto en claro quedaría legible en el motor: el driver lo rechaza.
  await assert.rejects(motor.setMailboxPassword('ana@acme.test', 'en-claro-por-error'), /cifrada en sha512-crypt/);
  await assert.rejects(
    motor.createMailbox({ email: 'bob@acme.test', passwordHash: 'en-claro-por-error' }),
    /cifrada en sha512-crypt/,
  );
  assert.equal(principales.has('bob@acme.test'), false);
});

test('addAppPassword devuelve el secreto propuesto y la referencia $app$ que guarda el motor', async () => {
  buzon('ana@acme.test');
  const creada = await motor.addAppPassword('ana@acme.test', 'mw-movil-1a2b3c4d', 'abcd-efgh-jkmn-pqrs');
  assert.equal(creada.secret, 'abcd-efgh-jkmn-pqrs', 'en 0.15 vale la contraseña que propone Mailway');
  assert.match(creada.ref, /^\$app\$mw-movil-1a2b3c4d\$\$6\$/);
  assert.ok(verifySha512Crypt('abcd-efgh-jkmn-pqrs', creada.ref.slice('$app$mw-movil-1a2b3c4d$'.length)));
  assert.ok(principales.get('ana@acme.test')?.secrets?.includes(creada.ref));

  await motor.removeAppPassword('ana@acme.test', creada.ref);
  assert.ok(!principales.get('ana@acme.test')?.secrets?.includes(creada.ref));
  assert.deepEqual(llamadas.at(-1)?.body, [{ action: 'removeItem', field: 'secrets', value: creada.ref }]);
});

/* ------------------------------- Suspensión -------------------------------- */

test('suspender un buzón le impide entrar, pero el correo le sigue llegando', async () => {
  buzon('ana@acme.test');
  await motor.updateMailbox('ana@acme.test', { suspended: true });
  assert.deepEqual(llamadas.at(-1)?.body, SUSPENDER);
  assert.equal(tienePermiso('ana@acme.test', 'authenticate'), false, 'no entra por IMAP, SMTP ni webmail');
  assert.equal(tienePermiso('ana@acme.test', 'authenticate-oauth'), false, 'ni con un token OAuth que tuviera');
  // Antes se le quitaba el rol «user» y con él email-receive: el correo rebotaba.
  assert.equal(tienePermiso('ana@acme.test', 'email-receive'), true, 'el correo le sigue llegando');
  assert.equal((await motor.readMailboxCredentials('ana@acme.test'))?.suspended, true);

  await motor.updateMailbox('ana@acme.test', { suspended: false });
  assert.deepEqual(llamadas.at(-1)?.body, REACTIVAR);
  assert.ok(tienePermiso('ana@acme.test', 'authenticate') && tienePermiso('ana@acme.test', 'email-receive'));
  assert.equal((await motor.readMailboxCredentials('ana@acme.test'))?.suspended, false);
});

test('suspender de nuevo un buzón suspendido como antes (sin el rol «user») le devuelve el correo', async () => {
  // Así lo dejaba la versión anterior: sin el rol, el motor devolvía su correo.
  buzon('ana@acme.test', { roles: [] });
  assert.equal(tienePermiso('ana@acme.test', 'email-receive'), false);

  await motor.updateMailbox('ana@acme.test', { suspended: true });
  assert.deepEqual(llamadas.at(-1)?.body, SUSPENDER);
  assert.equal(tienePermiso('ana@acme.test', 'email-receive'), true);
  assert.equal(tienePermiso('ana@acme.test', 'authenticate'), false);
  assert.equal((await motor.readMailboxCredentials('ana@acme.test'))?.suspended, true);
});

test('un buzón suspendido como antes (sin el rol «user») se reactiva del todo', async () => {
  buzon('ana@acme.test', { roles: [] });
  assert.equal((await motor.readMailboxCredentials('ana@acme.test'))?.suspended, true);
  await motor.updateMailbox('ana@acme.test', { suspended: false });
  assert.deepEqual(llamadas.at(-1)?.body, REACTIVAR);
  assert.ok(tienePermiso('ana@acme.test', 'authenticate') && tienePermiso('ana@acme.test', 'email-receive'));
  assert.equal((await motor.readMailboxCredentials('ana@acme.test'))?.suspended, false);
});

test('cambiar el nombre o la cuota no toca la suspensión', async () => {
  buzon('ana@acme.test', { disabledPermissions: ['authenticate', 'authenticate-oauth'] });
  await motor.updateMailbox('ana@acme.test', { displayName: 'Ana', quotaBytes: 1024 });
  assert.deepEqual(llamadas.at(-1)?.body, [
    { action: 'set', field: 'description', value: 'Ana' },
    { action: 'set', field: 'quota', value: 1024 },
  ]);
  assert.equal(tienePermiso('ana@acme.test', 'authenticate'), false);
});

test('suspender y reactivar no sacan al buzón de sus alias', async () => {
  buzon('ana@acme.test');
  buzon('bob@acme.test');
  principales.set('ventas@acme.test', { type: 'list', members: ['ana@acme.test', 'bob@acme.test'], externalMembers: [] });

  await motor.updateMailbox('ana@acme.test', { suspended: true });
  assert.deepEqual(principales.get('ventas@acme.test')?.members, ['ana@acme.test', 'bob@acme.test']);
  await motor.updateMailbox('ana@acme.test', { suspended: false });
  assert.deepEqual(principales.get('ventas@acme.test')?.members, ['ana@acme.test', 'bob@acme.test']);

  // Un buzón sin el rol (suspendido como antes) lo recupera sin salir de nada.
  principales.get('bob@acme.test')!.roles = [];
  await motor.updateMailbox('bob@acme.test', { suspended: true });
  assert.deepEqual(principales.get('bob@acme.test')?.roles, ['user']);
  assert.deepEqual(principales.get('ventas@acme.test')?.members, ['ana@acme.test', 'bob@acme.test']);
});

test('adoptar un buzón huérfano suspendido, de la forma actual o de la anterior, lo deja activo y fuera de las listas que le quedaran', async () => {
  for (const suspension of [{ disabledPermissions: ['authenticate', 'authenticate-oauth'] }, { roles: [] }]) {
    principales.clear();
    buzon('ana@acme.test', suspension);
    // Una lista huérfana del motor que el panel no conoce.
    principales.set('vieja@acme.test', { type: 'list', members: ['ana@acme.test'], externalMembers: [] });
    const hash = sha512Crypt('nueva-clave-segura');
    await motor.createMailbox({ email: 'ana@acme.test', passwordHash: hash });
    assert.deepEqual(
      (llamadas.at(-1)?.body as { field: string; value: unknown }[]).filter(
        (c) => c.field === 'roles' || c.field === 'disabledPermissions',
      ),
      [
        { action: 'set', field: 'roles', value: ['user'] },
        { action: 'set', field: 'disabledPermissions', value: [] },
      ],
    );
    assert.ok(tienePermiso('ana@acme.test', 'authenticate') && tienePermiso('ana@acme.test', 'email-receive'));
    const credenciales = await motor.readMailboxCredentials('ana@acme.test');
    assert.equal(credenciales?.suspended, false);
    assert.equal(credenciales?.passwordHash, hash);
    assert.deepEqual(principales.get('vieja@acme.test')?.members, []);
  }
});

/* ------------------------ readMailboxCredentials -------------------------- */

test('readMailboxCredentials: hash principal, contraseñas de aplicación y suspensión de las dos formas', async () => {
  const principal = sha512Crypt('clave-correcta');
  buzon('ana@acme.test', { secrets: [principal, '$app$mw-movil-1a2b$$6$sal$hash'] });
  assert.deepEqual(await motor.readMailboxCredentials('ana@acme.test'), {
    passwordHash: principal,
    appPasswords: [{ label: 'mw-movil-1a2b', hash: '$6$sal$hash', ref: '$app$mw-movil-1a2b$$6$sal$hash' }],
    suspended: false,
  });

  // Como suspende ahora: con el rol, sin permiso para autenticarse.
  principales.get('ana@acme.test')!.disabledPermissions = ['authenticate', 'authenticate-oauth'];
  assert.equal((await motor.readMailboxCredentials('ana@acme.test'))?.suspended, true);

  // Como suspendía antes: roles [] → el GET omite la clave.
  principales.get('ana@acme.test')!.disabledPermissions = [];
  principales.get('ana@acme.test')!.roles = [];
  assert.equal((await motor.readMailboxCredentials('ana@acme.test'))?.suspended, true);

  // Otro permiso desactivado no es una suspensión.
  principales.get('ana@acme.test')!.roles = ['user'];
  principales.get('ana@acme.test')!.disabledPermissions = ['email-send'];
  assert.equal((await motor.readMailboxCredentials('ana@acme.test'))?.suspended, false);

  // Un secreto que no es $6$ no se puede comprobar en el panel: «sin hash».
  buzon('bob@acme.test', { secrets: ['{SHA}otro-formato'] });
  assert.equal((await motor.readMailboxCredentials('bob@acme.test'))?.passwordHash, null);

  await assert.rejects(motor.readMailboxCredentials('nadie@acme.test'), (err: HttpError) => err.code === 'engine_not_found');
  // Una lista (alias) no es un buzón, aunque tuviera secretos.
  principales.set('lista@acme.test', { type: 'list', secrets: [principal], roles: ['user'] });
  await assert.rejects(motor.readMailboxCredentials('lista@acme.test'), (err: HttpError) => err.code === 'engine_not_found');
});

test('listDirectory devuelve dominios, cuentas y listas en minúsculas', async () => {
  principales.set('ACME.test', { type: 'domain' });
  buzon('Ana@acme.test');
  principales.set('ventas@acme.test', { type: 'list', members: [] });
  assert.deepEqual(await motor.listDirectory(), {
    domains: ['acme.test'],
    accounts: ['ana@acme.test'],
    lists: ['ventas@acme.test'],
  });
});

/* ------------------------- Ajustes por operaciones ------------------------- */

test('applyRecommended escribe nombre, X-Forwarded-For y redes exentas, y recarga', async () => {
  const resultado = await motor.applyRecommended({
    hostname: 'mail.acme.test',
    trustedNetworks: ['10.203.53.0/24'],
    maxAppPasswords: 100,
  });
  assert.deepEqual(resultado, { errors: [], warnings: [], restartRequired: [] });
  assert.equal(ajustes.get('server.hostname'), 'mail.acme.test');
  assert.equal(ajustes.get('http.use-x-forwarded'), 'true');
  assert.equal(ajustes.get('server.allowed-ip.10.203.53.0/24'), '');
  assert.ok(llamadas.some((l) => l.path === '/api/reload'), 'recarga la configuración');

  const estado = await motor.getSettingsStatus({ trustedNetworks: ['10.203.53.0/24', '10.9.9.0/24'] });
  assert.deepEqual(estado, {
    api: 'rest015',
    hostname: 'mail.acme.test',
    forwardedHeaders: true,
    trustedNetworks: ['10.203.53.0/24'],
    acme: null,
    certificateFiles: false,
    extra: {},
    restartRequired: [],
  });
});

test('configureAcme escribe el proveedor ACME de Mailway y el estado no devuelve el token', async () => {
  await motor.configureAcme({
    directory: 'https://acme-v02.api.letsencrypt.org/directory',
    token: 'token-de-cloudflare',
    contact: 'postmaster@acme.test',
    hostname: 'mail.acme.test',
    zone: 'acme.test',
  });
  assert.equal(ajustes.get('acme.mailway.secret'), 'token-de-cloudflare');
  assert.equal(ajustes.get('acme.mailway.challenge'), 'dns-01');
  assert.equal(ajustes.get('acme.mailway.origin'), 'acme.test');
  ajustes.set('certificate.mailway.cert', '%{file:/opt/stalwart/certs/mail.acme.test/cert.pem}%');

  const estado = await motor.getSettingsStatus({ trustedNetworks: [] });
  assert.deepEqual(estado.acme, {
    directory: 'https://acme-v02.api.letsencrypt.org/directory',
    challenge: 'dns-01',
    provider: 'cloudflare',
    contact: 'postmaster@acme.test',
    domain: 'mail.acme.test',
    zone: 'acme.test',
  });
  assert.equal(estado.certificateFiles, true);
  assert.ok(!JSON.stringify(estado).includes('token-de-cloudflare'));
});

/* --------------------------- Nombre en ejecución --------------------------- */

test('getRunningHostname lee el destino del MX que genera el motor, con un dominio reservado', async () => {
  nombreEnEjecucion = 'Mail.ACME.test';
  assert.equal(await motor.getRunningHostname(), 'mail.acme.test');
  assert.deepEqual(
    llamadas.map((l) => `${l.method} ${l.path}`),
    ['GET /api/dns/records/mailway.invalid'],
    'pregunta por un dominio que no existe: la ruta no lo exige',
  );

  // Sin server.hostname, Stalwart se presenta con el nombre del contenedor.
  nombreEnEjecucion = '3f2a1b4c5d6e';
  assert.equal(await motor.getRunningHostname(), '3f2a1b4c5d6e');

  nombreEnEjecucion = null;
  assert.equal(await motor.getRunningHostname(), null);
});

test('getRunningHostname propaga los errores de gestión (HTTP 200 con { error })', async () => {
  nombreEnEjecucion = new Error('Fallo simulado');
  await assert.rejects(motor.getRunningHostname(), (err: HttpError) => err.code === 'engine_error');
  rutaDesconocida = true;
  await assert.rejects(motor.getRunningHostname(), (err: HttpError) => /no reconoce la ruta/.test(err.message));
});
