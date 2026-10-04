import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { createAppPassword } from '../src/modules/apppasswords';
import {
  marcarCambiosInterrumpidos,
  vigilarCambiosDeDominio,
  type CambioDominioVista,
  type PlanCambioDominio,
} from '../src/modules/domainmigrations';
import { ownershipRecord } from '../src/modules/domains';
import { getMailbox } from '../src/modules/mailboxes';
import { setInstanceSettings } from '../src/modules/settings';
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
  // «Pasar» vuelve a evaluar las compuertas: si el DNS deja de estar
  // completo, 409 con el motivo y el cambio vuelve a «preparando».
  db.prepare("UPDATE domains SET status = 'pending_dns' WHERE id = ?").run(creado.vista.hacia.domainId);
  const sinDns = await accion(id, 'switch');
  assert.equal(sinDns.statusCode, 409, sinDns.body);
  assert.equal(sinDns.json().code, 'migration_not_ready');
  assert.match(sinDns.json().error, /el DNS de pasa-nuevo\.test no está completo/);
  assert.equal(((await get(`/api/domain-migrations/${id}`)).json() as CambioDominioVista).estado, 'preparando');
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

  const vista = await cambioListo(e, 'sky-nuevo.test', {
    headers: bearer(adminToken),
    payload: { origen: 'skyway', referenciaExterna: 'skyway:project:p1' },
  });
  assert.equal(vista.origen, 'skyway');
  assert.equal(vista.referenciaExterna, 'skyway:project:p1');

  const panel = await accion(vista.id, 'switch');
  assert.equal(panel.statusCode, 409, panel.body);
  assert.equal(panel.json().code, 'migration_managed_externally');
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
  const e = await escenario('equipo-viejo.test', { buzones: ['ana', 'luis'] });
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
