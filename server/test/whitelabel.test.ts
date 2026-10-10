import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { fireAlert } from '../src/modules/alerts';
import { setInstanceSettings } from '../src/modules/settings';
import { adminContext, createClient, createDomain, setDomainOwnership, type TestContext } from './helpers';

/**
 * Rutas de marca blanca: la regla de propiedad del nombre (subdominio de un
 * dominio de correo verificado del MISMO cliente), el límite por cliente, el
 * token de Traefik y los datos de conexión con Traefik para el administrador.
 */

let ctx: TestContext;
let clientA: Awaited<ReturnType<typeof createClient>>;
let clientB: Awaited<ReturnType<typeof createClient>>;

function verify(domainId: string): void {
  db.prepare(`UPDATE domains SET status = 'active', verified_at = ? WHERE id = ?`).run(Date.now(), domainId);
}

async function crear(cookie: string, payload: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url: '/api/whitelabel/domains', headers: { cookie }, payload });
}

before(async () => {
  ctx = await adminContext();
  setInstanceSettings({
    mailHostname: 'mail.proveedor.test',
    publicIp: '203.0.113.10',
    panelUrl: 'https://panel.proveedor.test',
  });
  clientA = await createClient(ctx, { withUser: true });
  clientB = await createClient(ctx, { withUser: true });
  // El primer plan admite un solo dominio; el cliente A necesita dos.
  db.prepare('UPDATE plans SET max_domains = 10 WHERE id = ?').run(clientA.planId);
  verify((await createDomain(ctx, clientA.clientId, 'empresa-a.test')).domainId);
  verify((await createDomain(ctx, clientB.clientId, 'empresa-b.test')).domainId);
  // Dominio del cliente A con la propiedad todavía sin comprobar.
  await createDomain(ctx, clientA.clientId, 'sin-verificar-a.test', { ownershipVerified: false });
});

beforeEach(() => {
  db.prepare('DELETE FROM client_domains').run();
});

test('un cliente puede dar de alta un subdominio de su dominio verificado', async () => {
  const res = await crear(clientA.userCookie!, { hostname: 'webmail.empresa-a.test' });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { domain: { hostname: string; clientId: string; status: string } };
  assert.equal(body.domain.hostname, 'webmail.empresa-a.test');
  assert.equal(body.domain.clientId, clientA.clientId);
  assert.equal(body.domain.status, 'pending_dns', 'sin red el DNS no se da por bueno');
});

test('no se puede usar un nombre bajo el dominio de OTRO cliente', async () => {
  const res = await crear(clientA.userCookie!, { hostname: 'webmail.empresa-b.test' });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { code: string }).code, 'hostname_not_owned');
});

test('no se puede usar un nombre ajeno a Mailway (p. ej. otra aplicación del servidor)', async () => {
  const res = await crear(clientA.userCookie!, { hostname: 'app.otra-aplicacion.test' });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { code: string }).code, 'hostname_not_owned');
});

test('el propio dominio de correo (sin subdominio) no vale', async () => {
  const res = await crear(clientA.userCookie!, { hostname: 'empresa-a.test' });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { code: string }).code, 'hostname_not_owned');
});

test('un nombre que repite un dominio del cliente se rechaza', async () => {
  // «webmail.empresa-a.test» escrito como subdominio de empresa-a.test.
  const doble = await crear(clientA.userCookie!, { hostname: 'webmail.empresa-a.test.empresa-a.test' });
  assert.equal(doble.statusCode, 400);
  assert.equal((doble.json() as { code: string }).code, 'hostname_repeats_domain');
  assert.match((doble.json() as { error: string }).error, /webmail\.empresa-a\.test, indica ese nombre/);
  // El nombre completo de otro dominio suyo, bajo el que sí está comprobado.
  const otro = await crear(clientA.userCookie!, { hostname: 'webmail.sin-verificar-a.test.empresa-a.test' });
  assert.equal(otro.statusCode, 400);
  assert.equal((otro.json() as { code: string }).code, 'hostname_repeats_domain');
  // Un subdominio de varios niveles legítimo sigue valiendo.
  const varios = await crear(clientA.userCookie!, { hostname: 'correo.web.empresa-a.test' });
  assert.equal(varios.statusCode, 200, varios.body);
});

test('la propiedad del dominio de correo tiene que estar comprobada', async () => {
  const res = await crear(clientA.userCookie!, { hostname: 'webmail.sin-verificar-a.test' });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { code: string }).code, 'domain_not_verified');
  assert.match((res.json() as { error: string }).error, /propiedad/);
});

test('cuenta la propiedad, no que el dominio esté activo', async () => {
  const activo = await createDomain(ctx, clientA.clientId, 'activo-sin-propiedad-a.test', { ownershipVerified: false });
  verify(activo.domainId);
  const rechazado = await crear(clientA.userCookie!, { hostname: 'webmail.activo-sin-propiedad-a.test' });
  assert.equal(rechazado.statusCode, 400);
  assert.equal((rechazado.json() as { code: string }).code, 'domain_not_verified');

  // Con la propiedad comprobada basta, aunque el resto del DNS siga pendiente.
  const pendiente = await createDomain(ctx, clientA.clientId, 'pendiente-con-propiedad-a.test', { ownershipVerified: false });
  setDomainOwnership(pendiente.domainId, true);
  const aceptado = await crear(clientA.userCookie!, { hostname: 'webmail.pendiente-con-propiedad-a.test' });
  assert.equal(aceptado.statusCode, 200, aceptado.body);
});

test('los nombres de autoconfiguración están reservados', async () => {
  for (const hostname of ['autoconfig.empresa-a.test', 'autodiscover.empresa-a.test', 'mta-sts.empresa-a.test']) {
    const res = await crear(clientA.userCookie!, { hostname });
    assert.equal(res.statusCode, 400, hostname);
    assert.equal((res.json() as { code: string }).code, 'reserved_hostname', hostname);
  }
});

test('máximo de 5 dominios propios por cliente', async () => {
  for (let i = 1; i <= 5; i++) {
    const res = await crear(clientA.userCookie!, { hostname: `webmail${i}.empresa-a.test` });
    assert.equal(res.statusCode, 200, res.body);
  }
  const sexto = await crear(clientA.userCookie!, { hostname: 'webmail6.empresa-a.test' });
  assert.equal(sexto.statusCode, 400);
  assert.equal((sexto.json() as { code: string }).code, 'whitelabel_limit');
});

test('un nombre ya dado de alta: el mismo cliente y tipo recibe el que hay; con otro tipo, 409', async () => {
  // El alta automática puede haberlo creado antes que quien lo pide (Skyway,
  // el propio cliente): pedirlo otra vez no es un error.
  const primero = await crear(clientA.userCookie!, { hostname: 'correo.empresa-a.test' });
  assert.equal(primero.statusCode, 200, primero.body);
  const otraVez = await crear(clientA.userCookie!, { hostname: 'correo.empresa-a.test' });
  assert.equal(otraVez.statusCode, 200, otraVez.body);
  assert.equal(
    (otraVez.json() as { domain: { id: string } }).domain.id,
    (primero.json() as { domain: { id: string } }).domain.id,
  );
  const original = config.traefik.panelBackend;
  config.traefik.panelBackend = 'http://mailway-panel:4100';
  try {
    const comoPanel = await crear(clientA.userCookie!, { hostname: 'correo.empresa-a.test', kind: 'panel' });
    assert.equal(comoPanel.statusCode, 409);
  } finally {
    config.traefik.panelBackend = original;
  }
});

test('el administrador tiene que indicar el cliente y se le aplica la misma regla', async () => {
  const sinCliente = await crear(ctx.adminCookie, { hostname: 'webmail.empresa-a.test' });
  assert.equal(sinCliente.statusCode, 400);
  assert.equal((sinCliente.json() as { code: string }).code, 'client_required');

  const cruzado = await crear(ctx.adminCookie, { hostname: 'webmail.empresa-a.test', clientId: clientB.clientId });
  assert.equal(cruzado.statusCode, 400);
  assert.equal((cruzado.json() as { code: string }).code, 'hostname_not_owned');

  const ok = await crear(ctx.adminCookie, { hostname: 'webmail.empresa-b.test', clientId: clientB.clientId });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((ok.json() as { domain: { clientId: string } }).domain.clientId, clientB.clientId);

  const inexistente = await crear(ctx.adminCookie, { hostname: 'webmail.empresa-b.test', clientId: 'cli_no' });
  assert.equal(inexistente.statusCode, 404);
});

test('eliminar un dominio propio cierra su alerta abierta', async () => {
  const res = await crear(clientA.userCookie!, { hostname: 'caido.empresa-a.test' });
  assert.equal(res.statusCode, 200, res.body);
  const id = (res.json() as { domain: { id: string } }).domain.id;
  fireAlert({
    severity: 'critical',
    type: 'whitelabel_broken',
    dedupeKey: `whitelabel:${id}`,
    clientId: clientA.clientId,
    title: 'Prueba',
    message: 'Prueba',
    quiet: true,
  });
  const borrar = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/whitelabel/domains/${id}`,
    headers: { cookie: clientA.userCookie! },
  });
  assert.equal(borrar.statusCode, 200);
  const abiertas = db
    .prepare('SELECT COUNT(*) AS c FROM alerts WHERE dedupe_key = ? AND resolved_at IS NULL')
    .get(`whitelabel:${id}`) as { c: number };
  assert.equal(abiertas.c, 0);
});

test('un cliente no puede crear dominios para otro indicando su clientId', async () => {
  const res = await crear(clientA.userCookie!, { hostname: 'webmail.empresa-b.test', clientId: clientB.clientId });
  // El clientId del cuerpo se ignora para usuarios de cliente: se valida contra el suyo.
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { code: string }).code, 'hostname_not_owned');
});

test('Traefik: el token fijado por entorno sustituye al generado', async () => {
  const original = config.traefikTokenOverride;
  config.traefikTokenOverride = 'token-fijo-del-instalador-123';
  try {
    const ok = await ctx.app.inject({
      method: 'GET',
      url: '/api/traefik/config',
      headers: { 'x-mailway-token': 'token-fijo-del-instalador-123' },
    });
    assert.equal(ok.statusCode, 200);
    const mal = await ctx.app.inject({
      method: 'GET',
      url: '/api/traefik/config',
      headers: { 'x-mailway-token': 'otro' },
    });
    assert.equal(mal.statusCode, 401);
  } finally {
    config.traefikTokenOverride = original;
  }
});

test('datos de conexión con Traefik: solo administradores, con el bloque exacto', async () => {
  const cliente = await ctx.app.inject({
    method: 'GET',
    url: '/api/whitelabel/setup',
    headers: { cookie: clientA.userCookie! },
  });
  assert.equal(cliente.statusCode, 403);

  const original = config.traefik.panelBackend;
  config.traefik.panelBackend = 'http://skyway-correo-panel:4100';
  try {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/whitelabel/setup',
      headers: { cookie: ctx.adminCookie },
    });
    assert.equal(res.statusCode, 200);
    const setup = res.json() as {
      token: string;
      providerEndpoint: string;
      overrideSnippet: string;
      panelUrl: string;
      autoconfig: { routingAvailable: boolean };
      skywayBridge: { minVersion: string; note: string };
    };
    assert.equal(setup.providerEndpoint, 'http://skyway-correo-panel:4100/api/traefik/config');
    assert.ok(setup.overrideSnippet.includes(`--providers.http.endpoint=${setup.providerEndpoint}`));
    assert.ok(setup.overrideSnippet.includes(`--providers.http.headers.X-Mailway-Token=${setup.token}`));
    assert.ok(setup.overrideSnippet.includes('--certificatesresolvers.le.acme.httpchallenge=true'));
    assert.equal(setup.panelUrl, 'https://panel.proveedor.test');
    assert.equal(setup.autoconfig.routingAvailable, true);
    assert.equal(setup.skywayBridge.minVersion, '0.34.0');
  } finally {
    config.traefik.panelBackend = original;
  }
});

/* --------------- Al eliminar el dominio de correo (CD-08) ------------------ */

test('eliminar un dominio de correo se lleva su webmail de marca blanca, que otro cliente puede volver a usar', async () => {
  const { domainId } = await createDomain(ctx, clientA.clientId, 'se-va-a.test');
  verify(domainId);
  const alta = await crear(clientA.userCookie!, { hostname: 'webmail.se-va-a.test' });
  assert.equal(alta.statusCode, 200, alta.body);

  const sinConfirmar = await ctx.app.inject({ method: 'DELETE', url: `/api/domains/${domainId}`, headers: { cookie: clientA.userCookie! } });
  assert.equal(sinConfirmar.statusCode, 409);
  assert.match((sinConfirmar.json() as { error: string }).error, /webmail\.se-va-a\.test \(dejará de publicarse\)/);

  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/domains/${domainId}?confirm=se-va-a.test`,
    headers: { cookie: clientA.userCookie! },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual((res.json() as { whitelabelDeleted: string[] }).whitelabelDeleted, ['webmail.se-va-a.test']);
  assert.equal(db.prepare("SELECT 1 FROM client_domains WHERE hostname = 'webmail.se-va-a.test'").get(), undefined);
  const auditado = db
    .prepare("SELECT 1 FROM audit_log WHERE action = 'whitelabel.domain_deleted' AND client_id = ? AND detail LIKE '%webmail.se-va-a.test%'")
    .get(clientA.clientId);
  assert.ok(auditado, 'aparece en la Actividad del cliente');

  // El dominio pasa a otro cliente: su webmail.<dominio> ya no está ocupado.
  db.prepare('UPDATE plans SET max_domains = 10 WHERE id = ?').run(clientB.planId);
  verify((await createDomain(ctx, clientB.clientId, 'se-va-a.test')).domainId);
  const deB = await crear(clientB.userCookie!, { hostname: 'webmail.se-va-a.test' });
  assert.equal(deB.statusCode, 200, deB.body);
});
