import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { createAppPassword } from '../src/modules/apppasswords';
import { randomId } from '../src/core/crypto';
import {
  marcarCambiosInterrumpidos,
  vigilarCambiosDeDominio,
  type CambioDominioVista,
  type PlanCambioDominio,
} from '../src/modules/domainmigrations';
import { getDomain, ownershipRecord } from '../src/modules/domains';
import { getMailbox } from '../src/modules/mailboxes';
import { getInstanceSettings, setInstanceSettings } from '../src/modules/settings';
import { reviewDomainDns } from '../src/modules/watchdog';
import { MAX_WHITELABEL_PER_CLIENT } from '../src/modules/whitelabel';
import { instalarDnsFalso, type ZonaDns } from './dns-falso';
import {
  adminContext,
  createClient,
  createDomain,
  createMailbox,
  crearCambioDeDominio,
  marcarDnsActivo,
  motorDemo,
  setDomainOwnership,
  type TestContext,
} from './helpers';

/*
 * Cambio de dominio de un cliente (dominio.es → dominio2.es) de punta a punta
 * con las rutas reales y el motor de demostración, que modela los principales
 * de Stalwart (nombre, direcciones, id que sobrevive al renombrado). Sin red,
 * salvo donde se instala un DNS de mentira: la propiedad por TXT y el MX que
 * miden la cancelación y la baja.
 */

const SERVIDOR = 'mail.servidor.test';
const IP_SERVIDOR = '203.0.113.10';

let ctx: TestContext;
let adminToken: string;

const sesion = () => ({ cookie: ctx.adminCookie });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function post(url: string, payload: Record<string, unknown> = {}, headers: Record<string, string> = sesion()) {
  return ctx.app.inject({ method: 'POST', url, headers, payload });
}

async function get(url: string, headers: Record<string, string> = sesion()) {
  return ctx.app.inject({ method: 'GET', url, headers });
}

async function tokenDe(cookie: string, name: string): Promise<string> {
  const res = await post('/api/tokens', { name }, { cookie });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { token: string }).token;
}

before(async () => {
  ctx = await adminContext();
  setInstanceSettings({ mailHostname: SERVIDOR, publicIp: IP_SERVIDOR });
  adminToken = await tokenDe(ctx.adminCookie, 'Skyway');
});

interface Escenario {
  clientId: string;
  userCookie: string;
  viejo: { domainId: string; domain: string };
  buzones: Record<string, { mailboxId: string; email: string; password: string }>;
  alias: Record<string, string>;
}

/**
 * Cliente con un dominio, sus buzones y sus alias. `plan` por defecto es el
 * de la agencia (varios dominios); `webmail` añade un webmail con su marca,
 * activo y principal, en webmail.<dominio>.
 */
async function escenario(
  dominio: string,
  opts: { buzones?: string[]; alias?: Record<string, string[]>; plan?: string; webmail?: boolean } = {},
): Promise<Escenario> {
  const { clientId, userCookie } = await createClient(ctx, { withUser: true });
  if (opts.plan !== 'plan_basico') {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/clients/${clientId}`,
      headers: sesion(),
      payload: { planId: opts.plan ?? 'plan_agencia' },
    });
    assert.equal(res.statusCode, 200, res.body);
  }
  const viejo = await createDomain(ctx, clientId, dominio);
  const buzones: Escenario['buzones'] = {};
  for (const local of opts.buzones ?? []) buzones[local] = await createMailbox(ctx, viejo.domainId, local);
  const alias: Escenario['alias'] = {};
  for (const [local, destinos] of Object.entries(opts.alias ?? {})) {
    const res = await post('/api/aliases', { domainId: viejo.domainId, localPart: local, destinations: destinos });
    assert.equal(res.statusCode, 200, res.body);
    alias[local] = (res.json() as { id: string }).id;
  }
  if (opts.webmail) {
    db.prepare(
      `INSERT INTO client_domains (id, client_id, hostname, kind, status, created_at, activated_at, is_primary)
       VALUES (?, ?, ?, 'webmail', 'active', ?, ?, 1)`,
    ).run(`wld_${dominio.replace(/\W/g, '_')}`, clientId, `webmail.${dominio}`, Date.now(), Date.now());
  }
  return { clientId, userCookie: userCookie!, viejo, buzones, alias };
}

/** Crea el cambio y lo deja «listo» (propiedad y DNS de dominio2.es dados por buenos). */
async function cambioListo(e: Escenario, nuevo: string, opts: Parameters<typeof crearCambioDeDominio>[3] = {}) {
  const creado = await crearCambioDeDominio(ctx, e.viejo.domainId, nuevo, opts);
  assert.equal(creado.statusCode, 201, creado.body);
  marcarDnsActivo(creado.vista.hacia.domainId!);
  const comprobado = await post(`/api/domain-migrations/${creado.vista.id}/check`, {}, opts.headers ?? sesion());
  assert.equal(comprobado.statusCode, 200, comprobado.body);
  const vista = comprobado.json() as CambioDominioVista;
  assert.equal(vista.estado, 'listo', JSON.stringify(vista.compuertas));
  return vista;
}

function fila(mailboxId: string) {
  return db
    .prepare('SELECT domain_id, usuario_motor, semilla_perfil, login_anterior FROM mailboxes WHERE id = ?')
    .get(mailboxId) as { domain_id: string; usuario_motor: string | null; semilla_perfil: string | null; login_anterior: string | null };
}

function destinos(aliasId: string): string[] {
  const f = db.prepare('SELECT destinations_json FROM aliases WHERE id = ?').get(aliasId) as { destinations_json: string };
  return JSON.parse(f.destinations_json) as string[];
}

async function accion(
  id: string,
  nombre: string,
  payload: Record<string, unknown> = {},
  headers: Record<string, string> = sesion(),
) {
  return post(`/api/domain-migrations/${id}/${nombre}`, payload, headers);
}

/** Miembros de una lista en el motor de demostración: por id (buzones) y externos (por dirección). */
function listaEnMotor(nombre: string): { members: number[]; externalMembers: string[] } | undefined {
  type ConBuscar = { buscar(n: string): { members: number[]; externalMembers: string[] } | undefined };
  return (motorDemo() as unknown as ConBuscar).buscar(nombre);
}

/** El MX de estos dominios apunta a otro proveedor (para cancelar y dar de baja). */
function mxFuera(t: Parameters<typeof instalarDnsFalso>[0], ...dominios: string[]): ZonaDns {
  const zona: ZonaDns = {
    mx: Object.fromEntries(dominios.map((d) => [d, [{ priority: 10, exchange: 'mx.otro-proveedor.test' }]])),
    a: { 'mx.otro-proveedor.test': ['198.51.100.7'] },
  };
  instalarDnsFalso(t, zona);
  return zona;
}

function alertaAbierta(clave: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM alerts WHERE dedupe_key = ? AND resolved_at IS NULL').get(clave));
}

/* ---------------------------------- Plan ---------------------------------- */

test('plan: bloqueos y resumen sin efectos', async () => {
  const e = await escenario('plan-viejo.test', { buzones: ['ana'], alias: { info: ['ana@plan-viejo.test'] } });
  const plan = async (toDomain: string, fromDomainId = e.viejo.domainId) => {
    const res = await post('/api/domain-migrations/plan', { fromDomainId, toDomain });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as PlanCambioDominio;
  };
  const codigos = (p: PlanCambioDominio) => p.bloqueos.map((b) => b.code);

  const bueno = await plan('plan-nuevo.test');
  assert.deepEqual(bueno.bloqueos, []);
  assert.deepEqual(bueno.hacia, { domain: 'plan-nuevo.test', existe: false, domainId: null });
  assert.deepEqual(bueno.buzones.map((b) => [b.de, b.a]), [['ana@plan-viejo.test', 'ana@plan-nuevo.test']]);
  assert.deepEqual(bueno.alias.map((a) => [a.de, a.a]), [['info@plan-viejo.test', 'info@plan-nuevo.test']]);
  assert.equal(db.prepare('SELECT 1 FROM domains WHERE domain = ?').get('plan-nuevo.test'), undefined, 'el plan no crea nada');

  assert.ok(codigos(await plan('plan-viejo.test')).includes('migration_same_domain'));
  assert.ok(codigos(await plan('correo.plan-viejo.test')).includes('migration_related_domains'));
  assert.ok(codigos(await plan('www.plan-otro.test')).includes('domain_www'));

  const ajeno = await createClient(ctx);
  await createDomain(ctx, ajeno.clientId, 'ajeno-plan.test');
  assert.ok(codigos(await plan('ajeno-plan.test')).includes('domain_exists'));

  const usado = await createDomain(ctx, e.clientId, 'usado-plan.test');
  await createMailbox(ctx, usado.domainId, 'eva');
  assert.ok(codigos(await plan('usado-plan.test')).includes('migration_destination_in_use'));

  const vacio = await createDomain(ctx, e.clientId, 'vacio-plan.test');
  const conVacio = await plan('vacio-plan.test');
  assert.deepEqual(conVacio.bloqueos, []);
  assert.deepEqual(conVacio.hacia, { domain: 'vacio-plan.test', existe: true, domainId: vacio.domainId });

  const sinPropiedad = await createDomain(ctx, e.clientId, 'sinprop-plan.test', { ownershipVerified: false });
  assert.ok(codigos(await plan('otro-plan.test', sinPropiedad.domainId)).includes('ownership_required'));

  // La creación responde con el código y el estado del bloqueo.
  const mismo = await crearCambioDeDominio(ctx, e.viejo.domainId, 'plan-viejo.test');
  assert.equal(mismo.statusCode, 400);
  assert.equal((mismo.vista as unknown as { code: string }).code, 'migration_same_domain');
  const existe = await crearCambioDeDominio(ctx, e.viejo.domainId, 'ajeno-plan.test');
  assert.equal(existe.statusCode, 409);
  assert.equal((existe.vista as unknown as { code: string }).code, 'domain_exists');

  // Un dominio solo puede estar en un cambio abierto, como origen o como destino.
  const abierto = await crearCambioDeDominio(ctx, e.viejo.domainId, 'plan-nuevo.test');
  assert.equal(abierto.statusCode, 201, abierto.body);
  assert.ok(codigos(await plan('plan-tercero.test')).includes('migration_exists'));
  assert.ok(codigos(await plan('plan-nuevo.test', vacio.domainId)).includes('migration_exists'));

  db.prepare('UPDATE clients SET suspended = 1 WHERE id = ?').run(e.clientId);
  try {
    assert.ok(codigos(await plan('plan-cuarto.test', vacio.domainId)).includes('client_suspended'));
  } finally {
    db.prepare('UPDATE clients SET suspended = 0 WHERE id = ?').run(e.clientId);
  }
});

/* -------------------------------- Creación -------------------------------- */

test('crear: 201 y después 200 (idempotente); el dominio anterior no cuenta en el plan', async () => {
  // Plan Básico: un solo dominio. El nuevo cabe porque el viejo queda exento.
  const e = await escenario('basico-viejo.test', { buzones: ['ana'], plan: 'plan_basico' });
  const primero = await crearCambioDeDominio(ctx, e.viejo.domainId, 'basico-nuevo.test');
  assert.equal(primero.statusCode, 201, primero.body);
  assert.equal(primero.vista.estado, 'preparando');
  assert.equal(primero.vista.creoDestino, true);
  assert.equal(primero.vista.buzones.total, 1);

  const segundo = await crearCambioDeDominio(ctx, e.viejo.domainId, 'basico-nuevo.test');
  assert.equal(segundo.statusCode, 200, segundo.body);
  assert.equal(segundo.vista.id, primero.vista.id);

  // Un tercer dominio ya no cabe.
  const tercero = await post('/api/domains', { domain: 'basico-tercero.test', clientId: e.clientId });
  assert.equal(tercero.statusCode, 400, tercero.body);
  assert.equal(tercero.json().code, 'plan_limit_reached');

  const dominios = (await get(`/api/domains?clientId=${e.clientId}`)).json().domains as {
    domain: string;
    migracion: { rol: string; cuentaEnPlan: boolean; pareja: string } | null;
  }[];
  const viejo = dominios.find((d) => d.domain === 'basico-viejo.test')!;
  const nuevo = dominios.find((d) => d.domain === 'basico-nuevo.test')!;
  assert.deepEqual(
    { rol: viejo.migracion?.rol, cuenta: viejo.migracion?.cuentaEnPlan, pareja: viejo.migracion?.pareja },
    { rol: 'origen', cuenta: false, pareja: 'basico-nuevo.test' },
  );
  assert.equal(nuevo.migracion?.rol, 'destino');
  assert.equal(nuevo.migracion?.cuentaEnPlan, true);

  // Mientras dura el cambio no se crean buzones en ninguno de los dos.
  const enOrigen = await post('/api/mailboxes', { domainId: e.viejo.domainId, localPart: 'nuevo' });
  assert.equal(enOrigen.json().code, 'domain_migrating');
});

test('acceso: otro cliente recibe 403; el listado solo da los suyos', async () => {
  const e = await escenario('acceso-viejo.test', { buzones: ['ana'] });
  const { vista } = await crearCambioDeDominio(ctx, e.viejo.domainId, 'acceso-nuevo.test');
  const otro = await createClient(ctx, { withUser: true });
  const ajeno = { cookie: otro.userCookie! };

  assert.equal((await get(`/api/domain-migrations/${vista.id}`, ajeno)).statusCode, 403);
  assert.equal((await accion(vista.id, 'check', {}, ajeno)).statusCode, 403);
  assert.equal(
    (await post('/api/domain-migrations/plan', { fromDomainId: e.viejo.domainId, toDomain: 'x-acceso.test' }, ajeno)).statusCode,
    403,
  );
  assert.equal(
    (await post('/api/domain-migrations', { fromDomainId: e.viejo.domainId, toDomain: 'x-acceso.test' }, ajeno)).statusCode,
    403,
  );
  assert.deepEqual((await get('/api/domain-migrations', ajeno)).json().migraciones, []);

  const propio = { cookie: e.userCookie };
  assert.equal((await get(`/api/domain-migrations/${vista.id}`, propio)).statusCode, 200);
  const lista = (await get(`/api/domain-migrations?domainId=${e.viejo.domainId}`, propio)).json().migraciones as CambioDominioVista[];
  assert.deepEqual(lista.map((m) => m.id), [vista.id]);
});

test('token de administración con soloCliente respeta las reservas del dominio nuevo', async () => {
  const e = await escenario('reserva-viejo.test', { buzones: ['ana'] });
  const otro = await createClient(ctx);
  db.prepare(
    `INSERT INTO cloudflare_reservas (domain, client_id, account_id, zone_id, created_at, updated_at)
     VALUES ('reserva-nuevo.test', ?, NULL, 'zona', ?, ?)`,
  ).run(otro.clientId, Date.now(), Date.now());

  const enNombreDelCliente = await crearCambioDeDominio(ctx, e.viejo.domainId, 'reserva-nuevo.test', {
    headers: bearer(adminToken),
    query: 'soloCliente=1',
  });
  assert.equal(enNombreDelCliente.statusCode, 409, enNombreDelCliente.body);
  assert.equal((enNombreDelCliente.vista as unknown as { code: string }).code, 'domain_reserved');
  assert.equal(db.prepare('SELECT 1 FROM domain_migrations WHERE to_domain = ?').get('reserva-nuevo.test'), undefined);

  const comoAdministrador = await crearCambioDeDominio(ctx, e.viejo.domainId, 'reserva-nuevo.test', {
    headers: bearer(adminToken),
  });
  assert.equal(comoAdministrador.statusCode, 201, comoAdministrador.body);
});

/* ------------------------------- Preparación ------------------------------ */

test('propiedad por TXT: pre-recepción de buzones y alias, recarga y webmail nuevo', async (t) => {
  const e = await escenario('txt-viejo.test', {
    buzones: ['ana'],
    alias: { info: ['ana@txt-viejo.test'] },
    webmail: true,
  });
  const registro = ownershipRecord('txt-nuevo.test');
  instalarDnsFalso(t, { txt: { [registro.name]: [registro.content] } });
  const motor = motorDemo();
  const recargas = motor.recargas;

  const { statusCode, vista, body } = await crearCambioDeDominio(ctx, e.viejo.domainId, 'txt-nuevo.test');
  assert.equal(statusCode, 201, body);
  assert.equal(vista.recepcionPreparada, true);
  const compuerta = (id: string) => vista.compuertas.find((c) => c.id === id)!;
  assert.equal(compuerta('propiedad').ok, true);
  assert.equal(compuerta('recepcion').ok, true);
  assert.equal(compuerta('dns').ok, false);
  assert.equal(compuerta('webmail').bloquea, false);
  assert.equal(vista.estado, 'preparando');
  assert.equal(vista.puedePasar, false);

  assert.deepEqual((await motor.getPrincipal('ana@txt-viejo.test'))?.emails, ['ana@txt-viejo.test', 'ana@txt-nuevo.test']);
  assert.deepEqual((await motor.getPrincipal('info@txt-viejo.test'))?.emails, ['info@txt-viejo.test', 'info@txt-nuevo.test']);
  assert.ok(motor.recargas > recargas, 'se recarga el directorio tras cambiar direcciones');
  assert.equal(motor.cambiosSinRecargar, false);
  assert.equal(motor.entregar('ana@txt-nuevo.test'), 'ana@txt-viejo.test', 'la dirección nueva entra en el mismo buzón');
  assert.equal(motor.entregar('info@txt-nuevo.test'), 'info@txt-viejo.test');

  assert.equal(vista.webmail.viejo?.hostname, 'webmail.txt-viejo.test');
  assert.equal(vista.webmail.nuevo?.hostname, 'webmail.txt-nuevo.test');
  // Mientras tanto, el usuario sigue siendo el de siempre: nadie está pendiente.
  assert.equal(vista.buzones.pendientes, 0);
});

test('el vigilante avanza la preparación cuando se prueba la propiedad', async () => {
  const e = await escenario('vigila-viejo.test', { buzones: ['ana'] });
  const { vista } = await crearCambioDeDominio(ctx, e.viejo.domainId, 'vigila-nuevo.test');
  assert.equal(vista.recepcionPreparada, false);
  setDomainOwnership(vista.hacia.domainId!, true);
  await vigilarCambiosDeDominio();
  const despues = (await get(`/api/domain-migrations/${vista.id}`)).json() as CambioDominioVista;
  assert.equal(despues.recepcionPreparada, true);
  assert.equal(motorDemo().entregar('ana@vigila-nuevo.test'), 'ana@vigila-viejo.test');
});

/* ---------------------------------- Pasar --------------------------------- */

test('pasar: compuertas, filas, usuario anterior, alias, destinos de otro cliente, orígenes y webmail', async () => {
  const e = await escenario('pasa-viejo.test', {
    buzones: ['ana', 'luis'],
    alias: { info: ['ana@pasa-viejo.test', 'luis@pasa-viejo.test'] },
    webmail: true,
  });
  // Un alias de otro cliente que reenvía a ana (versiones anteriores lo permitían).
  const otro = await createClient(ctx);
  const dominioOtro = await createDomain(ctx, otro.clientId, 'otro-pasa.test');
  db.prepare(
    `INSERT INTO aliases (id, domain_id, local_part, destinations_json, created_at) VALUES (?, ?, 'reenvio', ?, ?)`,
  ).run('als_ajeno_pasa', dominioOtro.domainId, JSON.stringify(['ana@pasa-viejo.test', 'fuera@ejemplo.net']), Date.now());
  const form = await post('/api/forms', {
    clientId: e.clientId,
    name: 'Contacto',
    recipientMailboxId: e.buzones.ana!.mailboxId,
    allowedOrigins: ['https://www.pasa-viejo.test', 'https://otra-web.test'],
  });
  assert.equal(form.statusCode, 200, form.body);
  const formId = (form.json() as { form: { id: string } }).form.id;

  const creado = await crearCambioDeDominio(ctx, e.viejo.domainId, 'pasa-nuevo.test');
  const id = creado.vista.id;
  // Sin la propiedad ni el DNS del dominio nuevo no se puede pasar.
  const pronto = await accion(id, 'switch');
  assert.equal(pronto.statusCode, 409, pronto.body);
  assert.equal(pronto.json().code, 'migration_state');

  marcarDnsActivo(creado.vista.hacia.domainId!);
  assert.equal(((await accion(id, 'check')).json() as CambioDominioVista).estado, 'listo');
  assert.equal(alertaAbierta(`cambio_dominio:${id}:listo`), true);
  // «Pasar» vuelve a evaluar las compuertas: si el DNS deja de estar
  // completo, 409 con el motivo y el cambio vuelve a «preparando» (y deja de
  // decir que está listo).
  db.prepare("UPDATE domains SET status = 'pending_dns' WHERE id = ?").run(creado.vista.hacia.domainId);
  const sinDns = await accion(id, 'switch');
  assert.equal(sinDns.statusCode, 409, sinDns.body);
  assert.equal(sinDns.json().code, 'migration_not_ready');
  assert.match(sinDns.json().error, /el DNS de pasa-nuevo\.test no está completo/);
  assert.equal(((await get(`/api/domain-migrations/${id}`)).json() as CambioDominioVista).estado, 'preparando');
  assert.equal(alertaAbierta(`cambio_dominio:${id}:listo`), false);
  marcarDnsActivo(creado.vista.hacia.domainId!);
  const listo = (await accion(id, 'check')).json() as CambioDominioVista;
  assert.equal(listo.estado, 'listo');
  assert.equal(listo.puedePasar, true);
  // El webmail nuevo ya está activo (en la realidad, al emitirse su certificado).
  db.prepare("UPDATE client_domains SET status = 'active', activated_at = ? WHERE hostname = ?").run(
    Date.now(),
    'webmail.pasa-nuevo.test',
  );

  const res = await accion(id, 'switch');
  assert.equal(res.statusCode, 200, res.body);
  const vista = res.json() as CambioDominioVista;
  assert.equal(vista.estado, 'pasado');
  assert.equal(vista.buzones.pendientes, 2);
  assert.equal(vista.puedeVolver, true);

  // Filas: dirección nueva, usuario anterior y semilla del perfil de Apple.
  const ana = fila(e.buzones.ana!.mailboxId);
  assert.equal(ana.domain_id, creado.vista.hacia.domainId);
  assert.equal(ana.usuario_motor, 'ana@pasa-viejo.test');
  assert.equal(ana.semilla_perfil, 'ana@pasa-viejo.test');
  const buzon = getMailbox(e.buzones.ana!.mailboxId);
  assert.equal(buzon.email, 'ana@pasa-nuevo.test');
  assert.equal(buzon.login, 'ana@pasa-viejo.test');
  assert.equal(buzon.loginPending, true);

  // Motor: el buzón sale con la nueva y recibe en las dos; entra con el usuario de siempre.
  const motor = motorDemo();
  assert.deepEqual((await motor.getPrincipal('ana@pasa-viejo.test'))?.emails, ['ana@pasa-nuevo.test', 'ana@pasa-viejo.test']);
  assert.equal(await motor.verifyCredentials('ana@pasa-viejo.test', e.buzones.ana!.password), true);
  assert.equal(motor.puedeEnviarComo('ana@pasa-viejo.test', 'ana@pasa-nuevo.test'), true);
  assert.equal(motor.entregar('ana@pasa-viejo.test'), 'ana@pasa-viejo.test');
  // El alias se renombra (no tiene dispositivos) y conserva la dirección vieja.
  assert.equal(await motor.getPrincipal('info@pasa-viejo.test'), null);
  assert.deepEqual((await motor.getPrincipal('info@pasa-nuevo.test'))?.emails, ['info@pasa-nuevo.test', 'info@pasa-viejo.test']);
  assert.equal(motor.entregar('info@pasa-viejo.test'), 'info@pasa-nuevo.test');
  assert.equal(motor.cambiosSinRecargar, false);

  // Destinos de alias de toda la instancia y orígenes del formulario.
  assert.deepEqual(destinos(e.alias.info!), ['ana@pasa-nuevo.test', 'luis@pasa-nuevo.test']);
  assert.deepEqual(destinos('als_ajeno_pasa'), ['ana@pasa-nuevo.test', 'fuera@ejemplo.net']);
  const origenes = JSON.parse(
    (db.prepare('SELECT allowed_origins_json FROM forms WHERE id = ?').get(formId) as { allowed_origins_json: string })
      .allowed_origins_json,
  ) as string[];
  assert.deepEqual(origenes, ['https://www.pasa-viejo.test', 'https://otra-web.test', 'https://www.pasa-nuevo.test']);

  // El webmail nuevo pasa a ser el principal.
  assert.equal(vista.webmail.nuevo?.principal, true);
  assert.equal(vista.webmail.viejo?.principal, false);

  // Repetir no hace nada.
  const otraVez = await accion(id, 'switch');
  assert.equal(otraVez.statusCode, 200);
  assert.equal((otraVez.json() as CambioDominioVista).estado, 'pasado');

  // Ya se pueden crear buzones en el dominio nuevo.
  const alta = await post('/api/mailboxes', { domainId: creado.vista.hacia.domainId, localPart: 'marta' });
  assert.equal(alta.statusCode, 200, alta.body);
});

test('un fallo del motor en el buzón k deja «pasando» con error y «Reintentar» termina', async () => {
  const e = await escenario('falla-viejo.test', { buzones: ['ana', 'luis'] });
  const vista = await cambioListo(e, 'falla-nuevo.test');
  const motor = motorDemo();
  motor.fallarProxima('setAddresses', 'luis@falla-viejo.test');

  const fallo = await accion(vista.id, 'switch');
  assert.equal(fallo.statusCode, 502, fallo.body);
  assert.equal(fallo.json().code, 'engine_error');
  const aMedias = (await get(`/api/domain-migrations/${vista.id}`)).json() as CambioDominioVista;
  assert.equal(aMedias.estado, 'pasando');
  assert.match(aMedias.error ?? '', /fallo inyectado/);
  assert.equal(aMedias.puedePasar, true);
  assert.equal(aMedias.puedeVolver, true);
  // Inocuo: las dos direcciones reciben y nadie ha cambiado de usuario.
  assert.equal(fila(e.buzones.ana!.mailboxId).domain_id, e.viejo.domainId);
  assert.equal(motor.entregar('luis@falla-nuevo.test'), 'luis@falla-viejo.test');

  const reintento = await accion(vista.id, 'switch');
  assert.equal(reintento.statusCode, 200, reintento.body);
  const final = reintento.json() as CambioDominioVista;
  assert.equal(final.estado, 'pasado');
  assert.equal(final.error, null);
  assert.deepEqual((await motor.getPrincipal('luis@falla-viejo.test'))?.emails, ['luis@falla-nuevo.test', 'luis@falla-viejo.test']);
});

test('origen Skyway: con la sesión no se pasa (409); con el token, sí', async () => {
  const e = await escenario('sky-viejo.test', { buzones: ['ana'] });
  const conSesion = await post('/api/domain-migrations', {
    fromDomainId: e.viejo.domainId,
    toDomain: 'sky-nuevo.test',
    autoDns: false,
    origen: 'skyway',
  });
  assert.equal(conSesion.statusCode, 403, conSesion.body);
  assert.equal(conSesion.json().code, 'token_required');
  // Un token que se crea un usuario del cliente no es el de Skyway (el de la administración).
  const tokenCliente = await tokenDe(e.userCookie, 'Mío');
  const conTokenCliente = await post(
    '/api/domain-migrations',
    { fromDomainId: e.viejo.domainId, toDomain: 'sky-nuevo.test', autoDns: false, origen: 'skyway' },
    bearer(tokenCliente),
  );
  assert.equal(conTokenCliente.statusCode, 403, conTokenCliente.body);
  assert.equal(conTokenCliente.json().code, 'token_required');

  const vista = await cambioListo(e, 'sky-nuevo.test', {
    headers: bearer(adminToken),
    payload: { origen: 'skyway', referenciaExterna: 'skyway:project:p1' },
  });
  assert.equal(vista.origen, 'skyway');
  assert.equal(vista.referenciaExterna, 'skyway:project:p1');

  const panel = await accion(vista.id, 'switch');
  assert.equal(panel.statusCode, 409, panel.body);
  assert.equal(panel.json().code, 'migration_managed_externally');
  for (const accionSkyway of ['switch', 'cancel']) {
    const delCliente = await accion(vista.id, accionSkyway, {}, bearer(tokenCliente));
    assert.equal(delCliente.json().code, 'migration_managed_externally', accionSkyway);
  }
  const integracion = await accion(vista.id, 'switch', {}, bearer(adminToken));
  assert.equal(integracion.statusCode, 200, integracion.body);

  // Las acciones de las personas no dependen del origen.
  const actualizar = await post(`/api/mailboxes/${e.buzones.ana!.mailboxId}/login-update`);
  assert.equal(actualizar.statusCode, 200, actualizar.body);
  assert.equal(getMailbox(e.buzones.ana!.mailboxId).login, 'ana@sky-nuevo.test');
});

/* ------------------------------ Actualizar y volver ------------------------ */

test('actualizar, volver y pasar otra vez: nadie pierde su usuario y los alias vuelven', async () => {
  const e = await escenario('vuelve-viejo.test', {
    buzones: ['ana', 'luis'],
    alias: { info: ['ana@vuelve-viejo.test'] },
  });
  const { id } = await cambioListo(e, 'vuelve-nuevo.test');
  assert.equal((await accion(id, 'switch')).statusCode, 200);
  const motor = motorDemo();

  // Ana actualiza sus dispositivos: entra ya con su dirección nueva.
  const actualizar = await post(`/api/mailboxes/${e.buzones.ana!.mailboxId}/login-update`);
  assert.equal(actualizar.statusCode, 200, actualizar.body);
  assert.equal(fila(e.buzones.ana!.mailboxId).usuario_motor, null);
  assert.equal(fila(e.buzones.ana!.mailboxId).login_anterior, 'ana@vuelve-viejo.test');
  assert.equal(await motor.verifyCredentials('ana@vuelve-nuevo.test', e.buzones.ana!.password), true);

  const volver = await accion(id, 'rollback');
  assert.equal(volver.statusCode, 200, volver.body);
  const vista = volver.json() as CambioDominioVista;
  assert.equal(vista.estado, 'listo');
  assert.equal(vista.fechas.pasado, null);

  // Ana sigue entrando con su usuario nuevo; Luis vuelve a estar al día.
  assert.equal(fila(e.buzones.ana!.mailboxId).usuario_motor, 'ana@vuelve-nuevo.test');
  assert.equal(fila(e.buzones.ana!.mailboxId).domain_id, e.viejo.domainId);
  assert.equal(getMailbox(e.buzones.ana!.mailboxId).email, 'ana@vuelve-viejo.test');
  assert.equal(await motor.verifyCredentials('ana@vuelve-nuevo.test', e.buzones.ana!.password), true);
  assert.deepEqual((await motor.getPrincipal('ana@vuelve-nuevo.test'))?.emails, ['ana@vuelve-viejo.test', 'ana@vuelve-nuevo.test']);
  assert.equal(fila(e.buzones.luis!.mailboxId).usuario_motor, null);
  assert.deepEqual((await motor.getPrincipal('luis@vuelve-viejo.test'))?.emails, ['luis@vuelve-viejo.test', 'luis@vuelve-nuevo.test']);
  // El alias vuelve a llamarse como antes y sus destinos, a las direcciones viejas.
  assert.deepEqual((await motor.getPrincipal('info@vuelve-viejo.test'))?.emails, ['info@vuelve-viejo.test', 'info@vuelve-nuevo.test']);
  assert.equal(await motor.getPrincipal('info@vuelve-nuevo.test'), null);
  assert.deepEqual(destinos(e.alias.info!), ['ana@vuelve-viejo.test']);

  // Pasar otra vez normaliza: Ana queda al día y Luis, pendiente.
  const otraVez = await accion(id, 'switch');
  assert.equal(otraVez.statusCode, 200, otraVez.body);
  assert.equal(fila(e.buzones.ana!.mailboxId).usuario_motor, null);
  assert.equal(fila(e.buzones.luis!.mailboxId).usuario_motor, 'luis@vuelve-viejo.test');
  assert.equal(getMailbox(e.buzones.ana!.mailboxId).loginPending, false);
});

/* -------------------------- Mensaje para tu equipo ------------------------- */

test('mensaje para tu equipo: un enlace de 7 días, sin contraseña, por persona pendiente', async () => {
  const e = await escenario('equipo-viejo.test', { buzones: ['ana', 'luis', 'tienda'] });
  // El buzón de una aplicación de Skyway no lo actualiza una persona: su
  // enlace respondería 409 mailbox_used_by_app.
  await createAppPassword(e.buzones.tienda!.mailboxId, 'skyway:tienda', null);
  const { id } = await cambioListo(e, 'equipo-nuevo.test');
  assert.equal((await accion(id, 'switch')).statusCode, 200);
  // Ana ya actualizó: no necesita enlace.
  assert.equal((await post(`/api/mailboxes/${e.buzones.ana!.mailboxId}/login-update`)).statusCode, 200);

  const otro = await createClient(ctx, { withUser: true });
  assert.equal((await accion(id, 'setup-links', {}, { cookie: otro.userCookie! })).statusCode, 403);

  const antes = Date.now();
  const res = await accion(id, 'setup-links', {}, { cookie: e.userCookie });
  assert.equal(res.statusCode, 200, res.body);
  const { enlaces } = res.json() as { enlaces: { mailboxId: string; email: string; url: string; expiresAt: number }[] };
  assert.deepEqual(
    enlaces.map((l) => [l.mailboxId, l.email]),
    [[e.buzones.luis!.mailboxId, 'luis@equipo-nuevo.test']],
  );
  const siete = 7 * 24 * 3600_000;
  assert.ok(enlaces[0]!.expiresAt >= antes + siete && enlaces[0]!.expiresAt <= Date.now() + siete);

  // El enlace funciona y enseña el usuario con el que entra hoy.
  const token = enlaces[0]!.url.split('/conectar/')[1]!;
  const abierto = await ctx.app.inject({ method: 'GET', url: `/api/public/setup/${token}` });
  assert.equal(abierto.statusCode, 200, abierto.body);
  const datos = abierto.json() as { email: string; login: string; loginPending: boolean; hasPassword: boolean };
  assert.deepEqual(
    [datos.email, datos.login, datos.loginPending, datos.hasPassword],
    ['luis@equipo-nuevo.test', 'luis@equipo-viejo.test', true, false],
  );
  const auditado = db
    .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'mailbox.setup_link_created' AND detail LIKE ?")
    .get(`%${id}%`) as { c: number };
  assert.equal(auditado.c, 1);
});

/* --------------------------------- Cancelar -------------------------------- */

test('cancelar: con el MX nuevo aquí no se puede; sin él, se quitan las direcciones y el destino creado se elimina', async (t) => {
  const e = await escenario('cancela-viejo.test', {
    buzones: ['ana'],
    alias: { info: ['ana@cancela-viejo.test'] },
    webmail: true,
  });
  const vista = await cambioListo(e, 'cancela-nuevo.test');
  const toId = vista.hacia.domainId!;
  assert.equal(vista.webmail.nuevo?.hostname, 'webmail.cancela-nuevo.test');

  // Sin DNS no se sabe si ya llega correo a @cancela-nuevo.test.
  const sinDns = await accion(vista.id, 'cancel');
  assert.equal(sinDns.statusCode, 503, sinDns.body);
  assert.equal(sinDns.json().code, 'dns_unknown');

  const zona: ZonaDns = { mx: { 'cancela-nuevo.test': [{ priority: 10, exchange: SERVIDOR }] } };
  instalarDnsFalso(t, zona);
  const conMx = await accion(vista.id, 'cancel');
  assert.equal(conMx.statusCode, 409, conMx.body);
  assert.equal(conMx.json().code, 'migration_new_mx_here');

  zona.mx = { 'cancela-nuevo.test': [{ priority: 10, exchange: 'mx.otro-proveedor.test' }] };
  const res = await accion(vista.id, 'cancel');
  assert.equal(res.statusCode, 200, res.body);
  const cancelada = res.json() as CambioDominioVista;
  assert.equal(cancelada.estado, 'cancelada');
  assert.equal(cancelada.hacia.domainId, null);

  const motor = motorDemo();
  assert.deepEqual((await motor.getPrincipal('ana@cancela-viejo.test'))?.emails, ['ana@cancela-viejo.test']);
  assert.deepEqual((await motor.getPrincipal('info@cancela-viejo.test'))?.emails, ['info@cancela-viejo.test']);
  assert.equal(motor.dominios.has('cancela-nuevo.test'), false);
  assert.ok(motor.dkimBorrados.includes('cancela-nuevo.test'));
  assert.equal(db.prepare('SELECT 1 FROM domains WHERE id = ?').get(toId), undefined);
  assert.equal(db.prepare('SELECT 1 FROM client_domains WHERE hostname = ?').get('webmail.cancela-nuevo.test'), undefined);

  // El origen vuelve a admitir altas.
  const alta = await post('/api/mailboxes', { domainId: e.viejo.domainId, localPart: 'nuevo' });
  assert.equal(alta.statusCode, 200, alta.body);
});

/* ------------------------------- Dar de baja ------------------------------ */

test('dar de baja: confirmación, apps, DNS y MX; después el dominio queda reservado a su cliente', async (t) => {
  const e = await escenario('baja-viejo.test', {
    buzones: ['ana', 'luis'],
    alias: { info: ['ana@baja-viejo.test'] },
    webmail: true,
  });
  const vista = await cambioListo(e, 'baja-nuevo.test');
  const toId = vista.hacia.domainId!;
  assert.equal((await accion(vista.id, 'switch')).statusCode, 200);
  // La tienda envía con el buzón de Ana (contraseña de aplicación de Skyway).
  await createAppPassword(e.buzones.ana!.mailboxId, 'skyway:tienda', null);

  const mal = await accion(vista.id, 'retire', { confirm: 'otro.test' });
  assert.equal(mal.statusCode, 400);
  assert.equal(mal.json().code, 'confirm_mismatch');

  const pasado = (await get(`/api/domain-migrations/${vista.id}`)).json() as CambioDominioVista;
  assert.deepEqual(pasado.bloqueosBaja.map((b) => b.code), ['mailbox_used_by_app']);
  assert.match(pasado.bloqueosBaja[0]!.mensaje, /^ana@baja-nuevo\.test lo usa una aplicación para enviar \(tienda\)\. Actualízalo desde Skyway/);
  assert.equal(pasado.puedeDarDeBaja, false);
  const conApps = await accion(vista.id, 'retire', { confirm: 'baja-viejo.test' });
  assert.equal(conApps.statusCode, 409, conApps.body);
  assert.equal(conApps.json().code, 'mailbox_used_by_app');
  // Desde el panel tampoco se actualiza: lo hace Skyway, con su token.
  const desdePanel = await post(`/api/mailboxes/${e.buzones.ana!.mailboxId}/login-update`);
  assert.equal(desdePanel.json().code, 'mailbox_used_by_app');
  const desdeSkyway = await post(`/api/mailboxes/${e.buzones.ana!.mailboxId}/login-update`, {}, bearer(adminToken));
  assert.equal(desdeSkyway.statusCode, 200, desdeSkyway.body);

  const sinDns = await accion(vista.id, 'retire', { confirm: 'baja-viejo.test' });
  assert.equal(sinDns.statusCode, 503, sinDns.body);
  assert.equal(sinDns.json().code, 'dns_unknown');

  const zona: ZonaDns = {
    mx: { 'baja-viejo.test': [{ priority: 10, exchange: SERVIDOR }] },
    a: { 'mx.otro-proveedor.test': ['198.51.100.7'] },
  };
  instalarDnsFalso(t, zona);
  const mxAqui = await accion(vista.id, 'retire', { confirm: 'baja-viejo.test' });
  assert.equal(mxAqui.statusCode, 409, mxAqui.body);
  assert.equal(mxAqui.json().code, 'migration_old_mx_here');
  // Sin MX, el correo va al A del dominio: si es este servidor, tampoco.
  zona.mx = {};
  zona.a = { 'baja-viejo.test': [IP_SERVIDOR] };
  const aAqui = await accion(vista.id, 'retire', { confirm: 'baja-viejo.test' });
  assert.equal(aAqui.json().code, 'migration_old_mx_here');
  assert.equal((await get(`/api/domain-migrations/${vista.id}`)).json().estado, 'pasado', 'las comprobaciones no cambian el estado');

  zona.mx = { 'baja-viejo.test': [{ priority: 10, exchange: 'mx.otro-proveedor.test' }] };
  zona.a = { 'mx.otro-proveedor.test': ['198.51.100.7'] };
  const motor = motorDemo();
  const res = await accion(vista.id, 'retire', { confirm: 'baja-viejo.test' });
  assert.equal(res.statusCode, 200, res.body);
  const final = res.json() as CambioDominioVista;
  assert.equal(final.estado, 'dado_de_baja');
  assert.equal(final.desde.domainId, null);

  // Luis no había actualizado: se le ha cambiado el usuario.
  assert.equal(fila(e.buzones.luis!.mailboxId).usuario_motor, null);
  assert.equal(fila(e.buzones.luis!.mailboxId).login_anterior, 'luis@baja-viejo.test');
  assert.equal(await motor.verifyCredentials('luis@baja-nuevo.test', e.buzones.luis!.password), true);
  const forzado = db
    .prepare("SELECT detail FROM audit_log WHERE action = 'mailbox.login_updated' AND detail LIKE ?")
    .get(`%${e.buzones.luis!.mailboxId}%`) as { detail: string };
  assert.equal(JSON.parse(forzado.detail).por, 'baja');
  const retirado = db
    .prepare("SELECT detail FROM audit_log WHERE action = 'domain.migration_retired' AND detail LIKE ?")
    .get(`%${vista.id}%`) as { detail: string };
  assert.equal(JSON.parse(retirado.detail).forzados, 1);

  // Ninguna dirección @baja-viejo.test, el dominio y su DKIM fuera del motor.
  assert.deepEqual((await motor.getPrincipal('ana@baja-nuevo.test'))?.emails, ['ana@baja-nuevo.test']);
  assert.deepEqual((await motor.getPrincipal('luis@baja-nuevo.test'))?.emails, ['luis@baja-nuevo.test']);
  assert.deepEqual((await motor.getPrincipal('info@baja-nuevo.test'))?.emails, ['info@baja-nuevo.test']);
  assert.equal(motor.entregar('ana@baja-viejo.test'), null);
  assert.equal(motor.dominios.has('baja-viejo.test'), false);
  assert.ok(motor.dkimBorrados.includes('baja-viejo.test'));
  // La fila del dominio y el webmail viejo, eliminados; el nuevo sigue.
  assert.equal(db.prepare('SELECT 1 FROM domains WHERE id = ?').get(e.viejo.domainId), undefined);
  assert.equal(db.prepare('SELECT 1 FROM client_domains WHERE hostname = ?').get('webmail.baja-viejo.test'), undefined);
  assert.ok(db.prepare('SELECT 1 FROM domains WHERE id = ?').get(toId));

  // El dominio dado de baja queda reservado a su cliente.
  const otro = await createClient(ctx, { withUser: true });
  const ajeno = await post('/api/domains', { domain: 'baja-viejo.test' }, { cookie: otro.userCookie! });
  assert.equal(ajeno.statusCode, 409, ajeno.body);
  assert.equal(ajeno.json().code, 'domain_reserved');
  const enNombre = await post(
    '/api/domains?soloCliente=1',
    { domain: 'baja-viejo.test', clientId: otro.clientId },
    bearer(adminToken),
  );
  assert.equal(enNombre.json().code, 'domain_reserved');
  const administracion = await post('/api/domains', { domain: 'baja-viejo.test', clientId: otro.clientId });
  assert.equal(administracion.statusCode, 200, administracion.body);
});

/* --------------------------- Dominios e integraciones ------------------------ */

test('un dominio en un cambio abierto no se puede borrar (ni el origen ni el destino)', async () => {
  const e = await escenario('borra-viejo.test', { buzones: ['ana'] });
  const { vista } = await crearCambioDeDominio(ctx, e.viejo.domainId, 'borra-nuevo.test');
  for (const id of [vista.desde.domainId!, vista.hacia.domainId!]) {
    const res = await ctx.app.inject({ method: 'DELETE', url: `/api/domains/${id}?confirm=x`, headers: sesion() });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().code, 'domain_migrating');
  }
});

test('integraciones: la función se anuncia y el resumen da el usuario y el cambio', async () => {
  const info = await get('/api/integrations/info', bearer(adminToken));
  assert.equal(info.json().features.domainMigrations, true);

  const e = await escenario('resumen-viejo.test', { buzones: ['ana'] });
  const { id } = await cambioListo(e, 'resumen-nuevo.test');
  assert.equal((await accion(id, 'switch')).statusCode, 200);
  const resumen = (await get(`/api/integrations/clients/${e.clientId}/summary`, bearer(adminToken))).json() as {
    mailboxes: { email: string; login: string; loginPending: boolean }[];
    domains: { domain: string; migracion: { rol: string; estado: string } | null }[];
  };
  assert.deepEqual(
    resumen.mailboxes.map((m) => [m.email, m.login, m.loginPending]),
    [['ana@resumen-nuevo.test', 'ana@resumen-viejo.test', true]],
  );
  const origen = resumen.domains.find((d) => d.domain === 'resumen-viejo.test')!;
  assert.deepEqual({ rol: origen.migracion?.rol, estado: origen.migracion?.estado }, { rol: 'origen', estado: 'pasado' });
});

test('al arrancar, una acción en curso sin error queda marcada para «Reintentar»', async () => {
  const e = await escenario('arranque-viejo.test', { buzones: ['ana'] });
  const { id } = await cambioListo(e, 'arranque-nuevo.test');
  assert.equal((await accion(id, 'switch')).statusCode, 200);
  db.prepare("UPDATE domain_migrations SET estado = 'dando_de_baja', error = NULL WHERE id = ?").run(id);
  assert.ok(marcarCambiosInterrumpidos() >= 1);
  const vista = (await get(`/api/domain-migrations/${id}`)).json() as CambioDominioVista;
  assert.equal(vista.error, 'Interrumpido por un reinicio del panel. Pulsa «Reintentar».');
  // Las que ya tenían su error no se tocan.
  assert.equal(marcarCambiosInterrumpidos(), 0);
});

/* ------------------------- Revisión: fallos a medias ------------------------- */

test('reenvíos: el motor deja de guardarlos por la dirección vieja y «Volver» solo deshace lo que escribió «Pasar»', async () => {
  // Otro cliente reenvía a direcciones de dominios que todavía no están en la
  // instancia: el motor las guarda como miembros externos, por dirección.
  const b = await createClient(ctx);
  const dominioB = await createDomain(ctx, b.clientId, 'reenvia-b.test');
  const aViejo = await post('/api/aliases', {
    domainId: dominioB.domainId,
    localPart: 'aviejo',
    destinations: ['ana@reenvia-viejo.test'],
  });
  assert.equal(aViejo.statusCode, 200, aViejo.body);
  const aNuevo = await post('/api/aliases', {
    domainId: dominioB.domainId,
    localPart: 'anuevo',
    destinations: ['ana@reenvia-nuevo.test'],
  });
  assert.equal(aNuevo.statusCode, 200, aNuevo.body);
  const idViejo = (aViejo.json() as { id: string }).id;
  const idNuevo = (aNuevo.json() as { id: string }).id;
  assert.deepEqual(listaEnMotor('aviejo@reenvia-b.test')?.externalMembers, ['ana@reenvia-viejo.test']);

  const e = await escenario('reenvia-viejo.test', { buzones: ['ana'] });
  const vista = await cambioListo(e, 'reenvia-nuevo.test');
  assert.equal((await accion(vista.id, 'switch')).statusCode, 200);
  const ana = await motorDemo().getPrincipal('ana@reenvia-viejo.test');

  // El panel enseña la dirección nueva y el motor entrega por el buzón (por
  // id): tras la baja de reenvia-viejo.test, ese correo ya no sale a Internet.
  assert.deepEqual(destinos(idViejo), ['ana@reenvia-nuevo.test']);
  assert.deepEqual(listaEnMotor('aviejo@reenvia-b.test')?.members, [ana!.id]);
  assert.deepEqual(listaEnMotor('aviejo@reenvia-b.test')?.externalMembers, []);
  // Lo que ya apuntaba al dominio nuevo no lo ha escrito el cambio.
  assert.deepEqual(destinos(idNuevo), ['ana@reenvia-nuevo.test']);
  assert.deepEqual(listaEnMotor('anuevo@reenvia-b.test')?.externalMembers, ['ana@reenvia-nuevo.test']);

  // Un alias del propio cliente que se crea después de pasar, en otro de sus dominios.
  const otro = await createDomain(ctx, e.clientId, 'reenvia-otro.test');
  const propio = await post('/api/aliases', {
    domainId: otro.domainId,
    localPart: 'equipo',
    destinations: ['ana@reenvia-nuevo.test'],
  });
  assert.equal(propio.statusCode, 200, propio.body);

  assert.equal((await accion(vista.id, 'rollback')).statusCode, 200);
  assert.deepEqual(destinos(idViejo), ['ana@reenvia-viejo.test']);
  assert.deepEqual(destinos(idNuevo), ['ana@reenvia-nuevo.test'], 'volver no toca lo que no escribió pasar');
  assert.deepEqual(destinos((propio.json() as { id: string }).id), ['ana@reenvia-viejo.test']);
  assert.deepEqual(listaEnMotor('aviejo@reenvia-b.test')?.members, [ana!.id]);
});

test('volver desde «pasando» con error deshace lo que «Pasar» hizo a medias', async () => {
  const e = await escenario('mvuelve-viejo.test', {
    buzones: ['ana'],
    alias: { info: ['ana@mvuelve-viejo.test'], ventas: ['ana@mvuelve-viejo.test'] },
  });
  const vista = await cambioListo(e, 'mvuelve-nuevo.test');
  const motor = motorDemo();
  // «info» se renombra; «ventas» falla.
  motor.fallarProxima('renamePrincipal', 'ventas@mvuelve-viejo.test');
  assert.equal((await accion(vista.id, 'switch')).statusCode, 502);
  const aMedias = (await get(`/api/domain-migrations/${vista.id}`)).json() as CambioDominioVista;
  assert.equal(aMedias.estado, 'pasando');
  assert.equal(aMedias.puedeVolver, true);
  assert.equal(aMedias.puedeCancelar, true);
  assert.ok(await motor.getPrincipal('info@mvuelve-nuevo.test'));

  const volver = await accion(vista.id, 'rollback');
  assert.equal(volver.statusCode, 200, volver.body);
  const listo = volver.json() as CambioDominioVista;
  assert.equal(listo.estado, 'listo');
  assert.equal(listo.error, null);
  assert.deepEqual((await motor.getPrincipal('ana@mvuelve-viejo.test'))?.emails, ['ana@mvuelve-viejo.test', 'ana@mvuelve-nuevo.test']);
  assert.equal(await motor.getPrincipal('info@mvuelve-nuevo.test'), null);
  for (const local of ['info', 'ventas']) {
    assert.deepEqual((await motor.getPrincipal(`${local}@mvuelve-viejo.test`))?.emails, [
      `${local}@mvuelve-viejo.test`,
      `${local}@mvuelve-nuevo.test`,
    ]);
  }
  assert.equal(fila(e.buzones.ana!.mailboxId).domain_id, e.viejo.domainId);
  assert.equal(fila(e.buzones.ana!.mailboxId).usuario_motor, null);
  assert.deepEqual(destinos(e.alias.info!), ['ana@mvuelve-viejo.test']);
});

test('Skyway: si «Pasar» falla, «Cancelar» vuelve a dominio.es y cancela (sin callejón sin salida)', async (t) => {
  const e = await escenario('scancela-viejo.test', { buzones: ['ana'] });
  const skyway = bearer(adminToken);
  const vista = await cambioListo(e, 'scancela-nuevo.test', { headers: skyway, payload: { origen: 'skyway' } });
  const motor = motorDemo();
  motor.fallarProxima('setAddresses', 'ana@scancela-viejo.test');
  assert.equal((await accion(vista.id, 'switch', {}, skyway)).statusCode, 502);
  const aMedias = (await get(`/api/domain-migrations/${vista.id}`)).json() as CambioDominioVista;
  assert.equal(aMedias.estado, 'pasando');
  assert.equal(aMedias.puedeCancelar, true);

  mxFuera(t, 'scancela-nuevo.test');
  const res = await accion(vista.id, 'cancel', {}, skyway);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as CambioDominioVista).estado, 'cancelada');
  assert.deepEqual((await motor.getPrincipal('ana@scancela-viejo.test'))?.emails, ['ana@scancela-viejo.test']);
  assert.equal(motor.dominios.has('scancela-nuevo.test'), false);
  const auditado = db
    .prepare("SELECT detail FROM audit_log WHERE action = 'domain.migration_cancelled' AND detail LIKE ?")
    .get(`%${vista.id}%`) as { detail: string };
  assert.equal(JSON.parse(auditado.detail).volvio, true);
});

test('cancelar que falla a mitad deja el error, no da la recepción por hecha y se puede repetir', async (t) => {
  const e = await escenario('cfalla-viejo.test', { buzones: ['ana', 'luis'] });
  const vista = await cambioListo(e, 'cfalla-nuevo.test');
  mxFuera(t, 'cfalla-nuevo.test');
  const motor = motorDemo();
  motor.fallarProxima('setAddresses', 'luis@cfalla-viejo.test');

  const fallo = await accion(vista.id, 'cancel');
  assert.equal(fallo.statusCode, 502, fallo.body);
  const tras = (await get(`/api/domain-migrations/${vista.id}`)).json() as CambioDominioVista;
  assert.equal(tras.estado, 'preparando');
  assert.match(tras.error ?? '', /^No se ha podido cancelar el cambio: .*fallo inyectado/);
  // Ana ya no recibe en la dirección nueva, y la vista no dice lo contrario.
  assert.equal(motor.entregar('ana@cfalla-nuevo.test'), null);
  assert.equal(tras.recepcionPreparada, false);
  // Si lo que la corta es un reinicio, al arrancar queda dicho.
  db.prepare('UPDATE domain_migrations SET error = NULL WHERE id = ?').run(vista.id);
  assert.ok(marcarCambiosInterrumpidos() >= 1);
  assert.match(
    ((await get(`/api/domain-migrations/${vista.id}`)).json() as CambioDominioVista).error ?? '',
    /La cancelación se interrumpió por un reinicio del panel/,
  );
  assert.equal(tras.compuertas.find((c) => c.id === 'recepcion')?.ok, false);
  assert.equal(tras.puedePasar, false);

  // La preparación la rehace en su siguiente vuelta…
  await vigilarCambiosDeDominio();
  assert.equal(motor.entregar('ana@cfalla-nuevo.test'), 'ana@cfalla-viejo.test');
  assert.equal(((await get(`/api/domain-migrations/${vista.id}`)).json() as CambioDominioVista).recepcionPreparada, true);
  // …y «Cancelar» se puede repetir.
  const otra = await accion(vista.id, 'cancel');
  assert.equal(otra.statusCode, 200, otra.body);
  assert.equal((otra.json() as CambioDominioVista).estado, 'cancelada');
  assert.equal(motor.entregar('ana@cfalla-nuevo.test'), null);
});

test('cancelar con un dominio nuevo que ya existía: si su MX ya apunta aquí, 409', async (t) => {
  const e = await escenario('cexiste-viejo.test', { buzones: ['ana'] });
  await createDomain(ctx, e.clientId, 'cexiste-nuevo.test');
  const vista = await cambioListo(e, 'cexiste-nuevo.test');
  assert.equal(vista.creoDestino, false);
  instalarDnsFalso(t, { mx: { 'cexiste-nuevo.test': [{ priority: 10, exchange: SERVIDOR }] } });
  const res = await accion(vista.id, 'cancel');
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, 'migration_new_mx_here');
  assert.equal(motorDemo().entregar('ana@cexiste-nuevo.test'), 'ana@cexiste-viejo.test');
  const sigue = (await get(`/api/domain-migrations/${vista.id}`)).json() as CambioDominioVista;
  assert.deepEqual([sigue.estado, sigue.error], ['listo', null], 'una comprobación que no pasa no cambia el cambio');
});

test('una baja que falla a mitad se puede reintentar (también desde Skyway)', async (t) => {
  const e = await escenario('bfalla-viejo.test', { buzones: ['ana', 'luis'], alias: { info: ['ana@bfalla-viejo.test'] } });
  const vista = await cambioListo(e, 'bfalla-nuevo.test');
  assert.equal((await accion(vista.id, 'switch')).statusCode, 200);
  mxFuera(t, 'bfalla-viejo.test');
  motorDemo().fallarProxima('setAddresses', 'luis@bfalla-nuevo.test');

  const fallo = await accion(vista.id, 'retire', { confirm: 'bfalla-viejo.test' });
  assert.equal(fallo.statusCode, 502, fallo.body);
  const aMedias = (await get(`/api/domain-migrations/${vista.id}`)).json() as CambioDominioVista;
  assert.equal(aMedias.estado, 'dando_de_baja');
  assert.match(aMedias.error ?? '', /fallo inyectado/);
  assert.equal(aMedias.puedeDarDeBaja, true);
  assert.equal(aMedias.puedeVolver, false);

  const reintento = await accion(vista.id, 'retire', { confirm: 'bfalla-viejo.test' });
  assert.equal(reintento.statusCode, 200, reintento.body);
  assert.equal((reintento.json() as CambioDominioVista).estado, 'dado_de_baja');
  assert.deepEqual((await motorDemo().getPrincipal('luis@bfalla-nuevo.test'))?.emails, ['luis@bfalla-nuevo.test']);
});

test('un buzón borrado durante el cambio no cuenta al volver ni al pasar otra vez', async () => {
  const e = await escenario('borrado-viejo.test', { buzones: ['ana', 'luis'] });
  const vista = await cambioListo(e, 'borrado-nuevo.test');
  assert.equal((await accion(vista.id, 'switch')).statusCode, 200);
  const borrar = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/mailboxes/${e.buzones.luis!.mailboxId}`,
    headers: sesion(),
  });
  assert.equal(borrar.statusCode, 200, borrar.body);
  // Otro luis, ya en el dominio nuevo, y un alias que reenvía a él.
  const nuevoLuis = await post('/api/mailboxes', { domainId: vista.hacia.domainId, localPart: 'luis' });
  assert.equal(nuevoLuis.statusCode, 200, nuevoLuis.body);
  const otro = await createDomain(ctx, e.clientId, 'borrado-otro.test');
  const equipo = await post('/api/aliases', {
    domainId: otro.domainId,
    localPart: 'equipo',
    destinations: ['luis@borrado-nuevo.test'],
  });
  assert.equal(equipo.statusCode, 200, equipo.body);

  const volver = await accion(vista.id, 'rollback');
  assert.equal(volver.statusCode, 200, volver.body);
  assert.equal((volver.json() as CambioDominioVista).buzones.total, 1);
  // El alias sigue apuntando al luis nuevo, que se queda en el dominio nuevo.
  assert.deepEqual(destinos((equipo.json() as { id: string }).id), ['luis@borrado-nuevo.test']);

  const otraVez = await accion(vista.id, 'switch');
  assert.equal(otraVez.statusCode, 200, otraVez.body);
  assert.equal((otraVez.json() as CambioDominioVista).estado, 'pasado');
});

test('el dominio anterior de un cambio ya pasado no abre la alerta de DNS roto', async (t) => {
  const e = await escenario('alerta-viejo.test', { buzones: ['ana'] });
  marcarDnsActivo(e.viejo.domainId);
  const control = await createDomain(ctx, e.clientId, 'alerta-control.test');
  marcarDnsActivo(control.domainId);
  const vista = await cambioListo(e, 'alerta-nuevo.test');
  assert.equal((await accion(vista.id, 'switch')).statusCode, 200);

  // Como pide la baja, el MX del dominio anterior deja de apuntar aquí.
  const nulo = [{ priority: 0, exchange: '' }];
  instalarDnsFalso(t, { mx: { 'alerta-viejo.test': nulo, 'alerta-control.test': nulo } });
  await reviewDomainDns(getDomain(control.domainId));
  assert.equal(alertaAbierta(`domain_dns:${control.domainId}`), true, 'un dominio sin cambio sí avisa');
  await reviewDomainDns(getDomain(e.viejo.domainId));
  assert.equal(alertaAbierta(`domain_dns:${e.viejo.domainId}`), false);
});

test('una creación cortada por un reinicio se marca y crearla otra vez la termina', async () => {
  const e = await escenario('corte-viejo.test', { buzones: ['ana'] });
  // Como si el panel se hubiera reiniciado mientras daba de alta el dominio nuevo.
  const id = randomId('dmg');
  const t0 = Date.now();
  db.prepare(
    `INSERT INTO domain_migrations (id, client_id, from_domain_id, from_domain, to_domain, estado, created_at, updated_at)
     VALUES (?, ?, ?, 'corte-viejo.test', 'corte-nuevo.test', 'preparando', ?, ?)`,
  ).run(id, e.clientId, e.viejo.domainId, t0, t0);
  db.prepare(
    `INSERT INTO domain_migration_items (migration_id, tipo, item_id, local_part) VALUES (?, 'buzon', ?, 'ana')`,
  ).run(id, e.buzones.ana!.mailboxId);
  assert.ok(marcarCambiosInterrumpidos() >= 1);
  const marcada = (await get(`/api/domain-migrations/${id}`)).json() as CambioDominioVista;
  assert.match(marcada.error ?? '', /se interrumpió por un reinicio del panel/);
  assert.equal(marcada.hacia.domainId, null);

  const otra = await crearCambioDeDominio(ctx, e.viejo.domainId, 'corte-nuevo.test');
  assert.equal(otra.statusCode, 200, otra.body);
  assert.equal(otra.vista.id, id);
  assert.ok(otra.vista.hacia.domainId);
  assert.equal(otra.vista.creoDestino, true);
  assert.equal(otra.vista.error, null);
});

test('un cambio de usuario a medias se concilia antes de pasar', async () => {
  const e = await escenario('marca-viejo.test', { buzones: ['ana'] });
  const vista = await cambioListo(e, 'marca-nuevo.test');
  // El panel cayó tras marcar el cambio de usuario y antes de renombrar.
  db.prepare('UPDATE mailboxes SET usuario_cambiando_a = ? WHERE id = ?').run(
    'ana@marca-nuevo.test',
    e.buzones.ana!.mailboxId,
  );
  const res = await accion(vista.id, 'switch');
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(fila(e.buzones.ana!.mailboxId).usuario_motor, 'ana@marca-viejo.test');
  const marca = db.prepare('SELECT usuario_cambiando_a FROM mailboxes WHERE id = ?').get(e.buzones.ana!.mailboxId) as {
    usuario_cambiando_a: string | null;
  };
  assert.equal(marca.usuario_cambiando_a, null);
});

test('avisos: sin plaza para el webmail nuevo, y un dominio que aloja la plataforma no se da de baja', async () => {
  const e = await escenario('aviso-viejo.test', { buzones: ['ana'], webmail: true });
  // El cliente ya tiene el máximo de dominios propios (el webmail viejo y otros).
  for (let i = 1; i < MAX_WHITELABEL_PER_CLIENT; i++) {
    db.prepare(
      `INSERT INTO client_domains (id, client_id, hostname, kind, status, created_at, is_primary)
       VALUES (?, ?, ?, 'webmail', 'pending_dns', ?, 0)`,
    ).run(`wld_aviso_${i}`, e.clientId, `web${i}.aviso-otro.test`, Date.now());
  }
  const codigos = (lista: { code: string }[]) => lista.map((a) => a.code);
  const plan = async () =>
    (await post('/api/domain-migrations/plan', { fromDomainId: e.viejo.domainId, toDomain: 'aviso-nuevo.test' })).json() as PlanCambioDominio;
  assert.ok(codigos((await plan()).avisos).includes('whitelabel_limit'));

  const anterior = getInstanceSettings().mailHostname;
  setInstanceSettings({ mailHostname: 'mail.aviso-viejo.test' });
  try {
    assert.ok(codigos((await plan()).avisos).includes('domain_hosts_instance'));
    const vista = await cambioListo(e, 'aviso-nuevo.test');
    assert.ok(codigos(vista.avisos).includes('whitelabel_limit'));
    assert.equal(vista.webmail.nuevo, null);
    assert.equal((await accion(vista.id, 'switch')).statusCode, 200);
    const pasado = (await get(`/api/domain-migrations/${vista.id}`)).json() as CambioDominioVista;
    assert.deepEqual(codigos(pasado.bloqueosBaja), ['domain_hosts_instance']);
    assert.equal(pasado.puedeDarDeBaja, false);
    const baja = await accion(vista.id, 'retire', { confirm: 'aviso-viejo.test' });
    assert.equal(baja.statusCode, 409, baja.body);
    assert.equal(baja.json().code, 'domain_hosts_instance');
  } finally {
    setInstanceSettings({ mailHostname: anterior });
  }
});

test('tras una baja temprana, el webmail nuevo pasa a principal en cuanto se activa', async (t) => {
  const e = await escenario('wbaja-viejo.test', { buzones: ['ana'], webmail: true });
  const vista = await cambioListo(e, 'wbaja-nuevo.test');
  assert.equal(vista.webmail.nuevo?.status, 'pending_dns');
  assert.equal((await accion(vista.id, 'switch')).statusCode, 200);
  mxFuera(t, 'wbaja-viejo.test');
  const baja = await accion(vista.id, 'retire', { confirm: 'wbaja-viejo.test' });
  assert.equal(baja.statusCode, 200, baja.body);
  // El webmail viejo (el principal) ya no existe y el nuevo aún no está activo.
  db.prepare("UPDATE client_domains SET status = 'active', activated_at = ? WHERE hostname = ?").run(
    Date.now(),
    'webmail.wbaja-nuevo.test',
  );
  await vigilarCambiosDeDominio();
  const principal = db
    .prepare("SELECT hostname FROM client_domains WHERE client_id = ? AND kind = 'webmail' AND is_primary = 1")
    .get(e.clientId) as { hostname: string } | undefined;
  assert.equal(principal?.hostname, 'webmail.wbaja-nuevo.test');
});

/* ------------------- Aplicaciones de Skyway, origen y MX ------------------- */

test('cancelar tras volver: un buzón que una aplicación de Skyway usa con su usuario nuevo solo lo cancela Skyway', async (t) => {
  const e = await escenario('appcancela-viejo.test', { buzones: ['ana'] });
  const app = await createAppPassword(e.buzones.ana!.mailboxId, 'skyway:tienda', null);
  const { id } = await cambioListo(e, 'appcancela-nuevo.test');
  assert.equal((await accion(id, 'switch')).statusCode, 200);
  // Skyway actualiza el buzón de la tienda (SMTP_USER = ana@appcancela-nuevo.test) y después se vuelve.
  const actualizado = await post(`/api/mailboxes/${e.buzones.ana!.mailboxId}/login-update`, {}, bearer(adminToken));
  assert.equal(actualizado.statusCode, 200, actualizado.body);
  assert.equal((await accion(id, 'rollback')).statusCode, 200);
  assert.equal(fila(e.buzones.ana!.mailboxId).usuario_motor, 'ana@appcancela-nuevo.test');
  mxFuera(t, 'appcancela-nuevo.test');
  const motor = motorDemo();

  // Desde el panel, cancelar devolvería el buzón a ana@appcancela-viejo.test y la tienda dejaría de enviar.
  const panel = await accion(id, 'cancel');
  assert.equal(panel.statusCode, 409, panel.body);
  assert.equal(panel.json().code, 'mailbox_used_by_app');
  assert.match(
    panel.json().error,
    /^ana@appcancela-viejo\.test lo usa una aplicación para enviar \(tienda\) con su usuario de appcancela-nuevo\.test\. Al cancelar/,
  );
  assert.equal(((await get(`/api/domain-migrations/${id}`)).json() as CambioDominioVista).estado, 'listo');
  assert.equal(await motor.verifyCredentials('ana@appcancela-nuevo.test', app.password), true, 'la tienda sigue enviando');

  // Skyway cancela con su token y después pone al día las variables de la aplicación.
  const skyway = await accion(id, 'cancel', {}, bearer(adminToken));
  assert.equal(skyway.statusCode, 200, skyway.body);
  assert.equal((skyway.json() as CambioDominioVista).estado, 'cancelada');
  assert.equal(await motor.verifyCredentials('ana@appcancela-viejo.test', app.password), true);
});

test('crear: Skyway no adopta un cambio que se lleva desde el panel ni el de otro proyecto', async () => {
  const e = await escenario('adopta-viejo.test', { buzones: ['ana'] });
  const delPanel = await crearCambioDeDominio(ctx, e.viejo.domainId, 'adopta-nuevo.test');
  assert.equal(delPanel.statusCode, 201, delPanel.body);
  const pedir = { fromDomainId: e.viejo.domainId, toDomain: 'adopta-nuevo.test' };

  // Skyway (con el token de la administración) lo ve ya en el plan.
  const planSkyway = await post('/api/domain-migrations/plan', pedir, bearer(adminToken));
  assert.equal(planSkyway.statusCode, 200, planSkyway.body);
  const bloqueos = (planSkyway.json() as PlanCambioDominio).bloqueos;
  assert.deepEqual(bloqueos.map((b) => b.code), ['migration_exists']);
  assert.match(bloqueos[0]!.mensaje, /se gestiona desde el panel de Mailway/);
  // Para el panel, el mismo cambio no es un bloqueo: lo continúa.
  assert.deepEqual(((await post('/api/domain-migrations/plan', pedir)).json() as PlanCambioDominio).bloqueos, []);

  const comoSkyway = { ...pedir, autoDns: false, origen: 'skyway', referenciaExterna: 'skyway:project:p-adopta' };
  const adoptar = await post('/api/domain-migrations', comoSkyway, bearer(adminToken));
  assert.equal(adoptar.statusCode, 409, adoptar.body);
  assert.equal(adoptar.json().code, 'migration_exists');
  const sigue = (await get(`/api/domain-migrations/${delPanel.vista.id}`)).json() as CambioDominioVista;
  assert.deepEqual([sigue.origen, sigue.referenciaExterna], ['panel', null]);

  // Uno de Skyway: el mismo proyecto lo recupera al reintentar; otro proyecto, no.
  const e2 = await escenario('adopta2-viejo.test', { buzones: ['ana'] });
  const deSkyway = { ...comoSkyway, fromDomainId: e2.viejo.domainId, toDomain: 'adopta2-nuevo.test' };
  const creado = await post('/api/domain-migrations', deSkyway, bearer(adminToken));
  assert.equal(creado.statusCode, 201, creado.body);
  const reintento = await post('/api/domain-migrations', deSkyway, bearer(adminToken));
  assert.equal(reintento.statusCode, 200, reintento.body);
  assert.equal(reintento.json().id, creado.json().id);
  const otroProyecto = await post(
    '/api/domain-migrations',
    { ...deSkyway, referenciaExterna: 'skyway:project:p-otro' },
    bearer(adminToken),
  );
  assert.equal(otroProyecto.statusCode, 409, otroProyecto.body);
  assert.equal(otroProyecto.json().code, 'migration_exists');
  assert.match(otroProyecto.json().error, /otro proyecto de Skyway/);
  // El panel lo encuentra (y lo enseña gestionado desde Skyway).
  const desdePanel = await post('/api/domain-migrations', { ...pedir, fromDomainId: e2.viejo.domainId, toDomain: 'adopta2-nuevo.test', autoDns: false });
  assert.equal(desdePanel.statusCode, 200, desdePanel.body);
  assert.equal((desdePanel.json() as CambioDominioVista).origen, 'skyway');
});

/** DNS completo de un dominio tal como lo pide el motor de demostración (MX, SPF, DKIM y DMARC). */
function dnsCompleto(dominio: string): { mx: NonNullable<ZonaDns['mx']>; txt: NonNullable<ZonaDns['txt']> } {
  return {
    mx: { [dominio]: [{ priority: 10, exchange: `mail.${dominio}` }] },
    txt: {
      [dominio]: ['v=spf1 mx -all'],
      [`mail._domainkey.${dominio}`]: ['v=DKIM1; k=rsa; p=DEMO...'],
      [`_dmarc.${dominio}`]: [`v=DMARC1; p=quarantine; rua=mailto:postmaster@${dominio}`],
    },
  };
}

test('volver: si el MX de dominio.es se ha llevado a otro sitio desde que se pasó, 409; si ya estaba fuera, se vuelve', async (t) => {
  const e = await escenario('vuelvemx-viejo.test', { buzones: ['ana'] });
  const fuera = await escenario('fuera-viejo.test', { buzones: ['ana'] });
  const a = dnsCompleto('vuelvemx-nuevo.test');
  const b = dnsCompleto('fuera-nuevo.test');
  const otro = [{ priority: 10, exchange: 'mx.otro-proveedor.test' }];
  const zona: ZonaDns = {
    mx: { ...a.mx, ...b.mx, 'vuelvemx-viejo.test': [{ priority: 10, exchange: SERVIDOR }], 'fuera-viejo.test': otro },
    txt: { ...a.txt, ...b.txt },
    a: { 'mx.otro-proveedor.test': ['198.51.100.7'] },
  };
  instalarDnsFalso(t, zona);

  const { id } = await cambioListo(e, 'vuelvemx-nuevo.test');
  const pasado = await accion(id, 'switch');
  assert.equal(pasado.statusCode, 200, pasado.body);
  // Tras pasar, el origen ya no admite altas ni se puede cancelar: el texto lo dice.
  const alta = await post('/api/mailboxes', { domainId: e.viejo.domainId, localPart: 'nuevo' });
  assert.equal(alta.json().code, 'domain_migrating');
  assert.equal(alta.json().error, 'vuelvemx-viejo.test está en un cambio de dominio: crea los buzones y alias en vuelvemx-nuevo.test.');

  // El paso previo a la baja: el MX de dominio.es pasa a otro proveedor.
  zona.mx!['vuelvemx-viejo.test'] = otro;
  const frenado = await accion(id, 'rollback');
  assert.equal(frenado.statusCode, 409, frenado.body);
  assert.equal(frenado.json().code, 'migration_old_mx_elsewhere');
  assert.equal(((await get(`/api/domain-migrations/${id}`)).json() as CambioDominioVista).estado, 'pasado');
  zona.mx!['vuelvemx-viejo.test'] = [{ priority: 10, exchange: SERVIDOR }];
  const vuelto = await accion(id, 'rollback');
  assert.equal(vuelto.statusCode, 200, vuelto.body);
  assert.equal((vuelto.json() as CambioDominioVista).estado, 'listo');

  // Un dominio que nunca recibió aquí vuelve a su estado de antes.
  const otroCambio = await cambioListo(fuera, 'fuera-nuevo.test');
  assert.equal((await accion(otroCambio.id, 'switch')).statusCode, 200);
  const sinFreno = await accion(otroCambio.id, 'rollback');
  assert.equal(sinFreno.statusCode, 200, sinFreno.body);
});

/* ------------------------------ Cloudflare ------------------------------ */

interface RegistroCf {
  id: string;
  zoneId: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  proxied: boolean;
  ttl: number;
  comment: string | null;
  data?: Record<string, unknown>;
}

/**
 * Cloudflare de mentira, lo justo para aplicar el DNS de un dominio: verificar
 * el token, zonas, listado de registros y lotes (el completo, con sus códigos
 * de error, está en cloudflare.test.ts). Sustituye fetch durante la prueba.
 */
function instalarCloudflareFalso(t: Parameters<typeof instalarDnsFalso>[0], zonas: string[]) {
  const zonasCf = zonas.map((name) => ({
    id: `zona_${name.replace(/\W/g, '_')}`,
    name,
    status: 'active',
    account: { id: 'acc1', name: 'Cuenta' },
    name_servers: ['ana.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
  }));
  let registros: RegistroCf[] = [];
  let seq = 0;
  const respuesta = (status: number, cuerpo: unknown) =>
    new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } });
  const ok = (result: unknown, lista = false) =>
    respuesta(200, {
      success: true,
      errors: [],
      messages: [],
      result,
      ...(lista ? { result_info: { page: 1, per_page: 1000, total_pages: 1 } } : {}),
    });
  const desde = (zoneId: string, b: Record<string, unknown>, id?: string): RegistroCf => ({
    id: id ?? `rec_${++seq}`,
    zoneId,
    type: String(b.type),
    name: String(b.name).toLowerCase(),
    content: String(b.content ?? ''),
    priority: b.priority as number | undefined,
    proxied: Boolean(b.proxied),
    ttl: Number(b.ttl ?? 1),
    comment: (b.comment as string | undefined) ?? null,
    data: b.data as Record<string, unknown> | undefined,
  });
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, Record<string, unknown>[]>) : {};
    const path = url.pathname.replace(/^\/client\/v4/, '');
    if (path === '/user/tokens/verify') return ok({ id: 'tok', status: 'active' });
    if (path === '/zones') {
      const name = url.searchParams.get('name');
      return ok(zonasCf.filter((z) => !name || z.name === name), true);
    }
    const m = path.match(/^\/zones\/([^/]+)\/dns_records(\/batch)?$/);
    if (m && !m[2] && method === 'GET') {
      const name = url.searchParams.get('name');
      const type = url.searchParams.get('type');
      return ok(
        registros.filter((r) => r.zoneId === m[1] && (!name || r.name === name) && (!type || r.type === type)),
        true,
      );
    }
    if (m && m[2] && method === 'POST') {
      const zoneId = m[1]!;
      const res = { deletes: [] as RegistroCf[], patches: [] as RegistroCf[], puts: [] as RegistroCf[], posts: [] as RegistroCf[] };
      for (const d of body.deletes ?? []) {
        res.deletes.push(...registros.filter((r) => r.id === d.id));
        registros = registros.filter((r) => r.id !== d.id);
      }
      for (const p of body.puts ?? []) {
        const nuevo = desde(zoneId, p, String(p.id));
        registros = registros.map((r) => (r.id === nuevo.id ? nuevo : r));
        res.puts.push(nuevo);
      }
      for (const p of body.patches ?? []) {
        const r = registros.find((x) => x.id === p.id);
        if (r && p.content !== undefined) r.content = String(p.content);
        if (r) res.patches.push(r);
      }
      for (const p of body.posts ?? []) {
        const nuevo = desde(zoneId, p);
        registros.push(nuevo);
        res.posts.push(nuevo);
      }
      return ok(res);
    }
    return respuesta(404, { success: false, errors: [{ code: 7000, message: 'No route for that URI' }], messages: [], result: null });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return {
    registro(zona: string, r: { type: string; name: string; content: string; priority?: number }) {
      registros.push(desde(`zona_${zona.replace(/\W/g, '_')}`, r));
    },
    mx(nombre: string): string[] {
      return registros.filter((r) => r.type === 'MX' && r.name === nombre).map((r) => r.content);
    },
    /**
     * El DNS público que resultaría de la zona, leído en cada consulta: lo que
     * se escribe en Cloudflare se ve al medir el dominio justo después.
     */
    dns(): ZonaDns {
      const de = <T>(tipo: string, valor: (r: RegistroCf) => T): Record<string, T[]> => {
        const tabla: Record<string, T[]> = {};
        for (const r of registros.filter((x) => x.type === tipo)) (tabla[r.name] ??= []).push(valor(r));
        return tabla;
      };
      // Un TXT largo viaja troceado («"parte1" "parte2"»): el DNS lo da entero.
      const txt = (c: string) => (c.startsWith('"') ? c.slice(1, -1).split('" "').join('') : c);
      return {
        get mx() {
          return de('MX', (r) => ({ priority: r.priority ?? 10, exchange: r.content }));
        },
        get txt() {
          return de('TXT', (r) => txt(r.content));
        },
        get a() {
          return de('A', (r) => r.content);
        },
        get cname() {
          return de('CNAME', (r) => r.content);
        },
      };
    },
  };
}

test('Cloudflare: el DNS automático no toca el MX de otro proveedor y «Cambiar el MX» lo hace tras la pre-recepción', async (t) => {
  const cf = instalarCloudflareFalso(t, ['cf-nuevo.test']);
  // dominio2.es recibe hoy en otro proveedor.
  cf.registro('cf-nuevo.test', { type: 'MX', name: 'cf-nuevo.test', content: 'mx.otro-proveedor.test', priority: 10 });
  const cuenta = await post('/api/cloudflare/accounts', { token: 'cfut_cambiodedominio0123456789abcdefghijklmno' });
  assert.equal(cuenta.statusCode, 200, cuenta.body);
  const cuentaId = (cuenta.json() as { account: { id: string } }).account.id;
  t.after(async () => {
    await ctx.app.inject({ method: 'DELETE', url: `/api/cloudflare/accounts/${cuentaId}`, headers: sesion() });
  });

  // Sin la pre-recepción, el MX no se puede cambiar.
  const guiado = await escenario('cfguiado-viejo.test', { buzones: ['ana'] });
  const sinRecepcion = await crearCambioDeDominio(ctx, guiado.viejo.domainId, 'cfguiado-nuevo.test');
  const pronto = await accion(sinRecepcion.vista.id, 'mx');
  assert.equal(pronto.statusCode, 409, pronto.body);
  assert.equal(pronto.json().code, 'migration_state');

  const e = await escenario('cf-viejo.test', { buzones: ['ana'] });
  const creado = await crearCambioDeDominio(ctx, e.viejo.domainId, 'cf-nuevo.test', { payload: { autoDns: true } });
  assert.equal(creado.statusCode, 201, creado.body);
  assert.equal(creado.vista.hacia.cloudflare, true);
  // Escribir en la zona prueba la propiedad: la pre-recepción va en la misma petición.
  assert.equal(creado.vista.recepcionPreparada, true);
  assert.equal(motorDemo().entregar('ana@cf-nuevo.test'), 'ana@cf-viejo.test');
  // Solo se crea lo que faltaba: el MX del proveedor actual sigue.
  assert.deepEqual(cf.mx('cf-nuevo.test'), ['mx.otro-proveedor.test']);

  // Desde aquí, el DNS público es el de la zona: lo que escribe «Cambiar el
  // MX» se mide al momento, como haría el vigilante.
  instalarDnsFalso(t, cf.dns());
  const mx = await accion(creado.vista.id, 'mx');
  assert.equal(mx.statusCode, 200, mx.body);
  // El MX que propone el motor (el de demostración lo da como mail.<dominio>).
  assert.deepEqual(cf.mx('cf-nuevo.test'), ['mail.cf-nuevo.test']);
  // Con el MX van el SPF y el DMARC que Cloudflare aplaza mientras el correo
  // está en otro proveedor: sin ellos el DNS no se completaría nunca.
  const zona = cf.dns();
  assert.ok(zona.txt?.['cf-nuevo.test']?.some((v) => v.startsWith('v=spf1')), JSON.stringify(zona.txt));
  assert.ok(zona.txt?.['_dmarc.cf-nuevo.test']?.some((v) => v.startsWith('v=DMARC1')), JSON.stringify(zona.txt));
  const vista = mx.json() as CambioDominioVista;
  assert.equal(vista.estado, 'listo', JSON.stringify(vista.compuertas));
  assert.equal(vista.puedePasar, true);
  const auditado = db
    .prepare("SELECT 1 FROM audit_log WHERE action = 'domain.migration_mx_changed' AND detail LIKE ?")
    .get(`%${creado.vista.id}%`);
  assert.ok(auditado);
});
