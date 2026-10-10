import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { listAlerts } from '../src/modules/alerts';
import { getEngine } from '../src/engine';
import { evaluateHostnameAlert } from '../src/modules/engineops';
import { comandoInstalador } from '../src/modules/nombreservidor';
import { setInstanceSettings } from '../src/modules/settings';
import { instalarDnsFalso } from './dns-falso';
import { adminContext, createClient, createDomain, type TestContext } from './helpers';

/*
 * Cambiar el nombre del servidor de correo en Ajustes: antes se guardaba sin
 * decir nada. Ahora la web pide confirmación con lo que arrastra (los
 * dominios cuyo MX apunta al nombre actual, el A y el PTR del nombre nuevo,
 * el certificado y la orden del instalador), y el aviso del nombre del motor
 * dice cuántos dominios pasarán a pendientes al aplicarlo.
 */

const ACTUAL = 'mail.proveedor.test';
const NUEVO = 'correo.proveedor.test';
const IP = '203.0.113.10';

let ctx: TestContext;

function informeMx(mx: string): string {
  return JSON.stringify({
    checks: [{ id: 'mx', label: 'MX', type: 'MX', name: '@', expected: ACTUAL, found: mx, status: 'ok', required: true, help: '' }],
    requiredTotal: 1,
    requiredOk: 1,
    allRequiredOk: true,
    checkedAt: Date.now(),
  });
}

before(async () => {
  ctx = await adminContext();
  setInstanceSettings({ mailHostname: ACTUAL, publicIp: IP });
  // El motor de demostración se anuncia con el último nombre aplicado.
  await ctx.app.inject({ method: 'POST', url: '/api/engine/recommended', headers: { cookie: ctx.adminCookie } });
  const a = await createClient(ctx);
  const b = await createClient(ctx);
  const c = await createClient(ctx);
  const conMx = await createDomain(ctx, a.clientId, 'con-mx.test');
  const otroMx = await createDomain(ctx, b.clientId, 'otro-mx.test');
  await createDomain(ctx, c.clientId, 'sin-medir.test');
  db.prepare('UPDATE domains SET dns_status_json = ? WHERE id = ?').run(informeMx(`10 ${ACTUAL}.`), conMx.domainId);
  db.prepare('UPDATE domains SET dns_status_json = ? WHERE id = ?').run(informeMx('10 mx.otro-proveedor.test'), otroMx.domainId);
});

test('el impacto cuenta los dominios con el MX al nombre actual y mide el nombre nuevo', async (t) => {
  instalarDnsFalso(t, { a: { [NUEVO]: ['192.0.2.1'] }, ptr: { [IP]: [`${ACTUAL}.`] } });
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/settings/mail-hostname/impact?nombre=${encodeURIComponent(NUEVO.toUpperCase())}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    actual: string;
    nuevo: string;
    dominios: { total: number; conMxAlActual: number };
    registroA: { ips: string[]; apuntaAqui: boolean };
    ptr: { coincide: boolean };
    certificado: { cubre: boolean | null };
    comando: string;
    cambiaDominioBase: boolean;
  };
  assert.equal(body.actual, ACTUAL);
  assert.equal(body.nuevo, NUEVO);
  assert.deepEqual(body.dominios, { total: 3, conMxAlActual: 1 });
  assert.deepEqual(body.registroA.ips, ['192.0.2.1']);
  assert.equal(body.registroA.apuntaAqui, false);
  assert.equal(body.ptr.coincide, false);
  assert.equal(body.certificado.cubre, null, 'en demostración no hay certificado que medir');
  assert.equal(body.comando, `sudo MAILWAY_MAIL_HOST=${NUEVO} bash deploy/instalar.sh --actualizar`);
  assert.equal(body.cambiaDominioBase, false);
});

test('el impacto exige un nombre válido y la administración', async () => {
  const malo = await ctx.app.inject({
    method: 'GET',
    url: '/api/settings/mail-hostname/impact?nombre=no%20vale',
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(malo.statusCode, 400);
  const cliente = await createClient(ctx, { withUser: true });
  const ajeno = await ctx.app.inject({
    method: 'GET',
    url: `/api/settings/mail-hostname/impact?nombre=${NUEVO}`,
    headers: { cookie: cliente.userCookie! },
  });
  assert.equal(ajeno.statusCode, 403);
});

test('con otro dominio base, la orden también cambia MAILWAY_DOMINIO', () => {
  const r = comandoInstalador(ACTUAL, 'mail.otra-marca.test');
  assert.equal(r.cambiaDominioBase, true);
  assert.equal(r.comando, 'sudo MAILWAY_DOMINIO=otra-marca.test MAILWAY_MAIL_HOST=mail.otra-marca.test bash deploy/instalar.sh --actualizar');
});

test('con el motor anunciándose con el identificador del contenedor no se anuncia un traslado', () => {
  // Antes de aplicarle un nombre, Stalwart se anuncia con el identificador
  // del contenedor: su «dominio base» salía vacío y el diálogo decía que el
  // instalador trasladaría el webmail y el panel.
  const r = comandoInstalador('3f2a1b9c8d7e', 'mail.x.test');
  assert.equal(r.cambiaDominioBase, false);
  assert.equal(r.comando, 'sudo MAILWAY_MAIL_HOST=mail.x.test bash deploy/instalar.sh --actualizar');
  assert.equal(comandoInstalador(null, 'mail.x.test').cambiaDominioBase, false);
});

test('el dominio base lo decide el nombre del instalador, no el del motor', async (t) => {
  // El instalador deduce el dominio base de su MAIL_HOSTNAME (en el panel,
  // MAILWAY_MAIL_HOSTNAME), aunque el motor se anuncie con otro nombre.
  instalarDnsFalso(t, { a: {}, ptr: {} });
  const previo = config.mailHostnameDefault;
  config.mailHostnameDefault = 'mail.otra-marca.test';
  t.after(() => {
    config.mailHostnameDefault = previo;
  });
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/settings/mail-hostname/impact?nombre=${NUEVO}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { actual: string; comando: string; cambiaDominioBase: boolean };
  assert.equal(body.actual, ACTUAL, 'el MX se sigue contando contra el nombre del motor');
  assert.equal(body.cambiaDominioBase, true);
  assert.equal(body.comando, `sudo MAILWAY_DOMINIO=proveedor.test MAILWAY_MAIL_HOST=${NUEVO} bash deploy/instalar.sh --actualizar`);
});

test('con el identificador del contenedor en el motor, el MX se cuenta contra el nombre de Ajustes', async (t) => {
  instalarDnsFalso(t, { a: {}, ptr: {} });
  await getEngine().applyServerSettings({ 'server.hostname': '3f2a1b9c8d7e' });
  t.after(() => getEngine().applyServerSettings({ 'server.hostname': ACTUAL }));
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/settings/mail-hostname/impact?nombre=mail.x.test`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { actual: string; dominios: { conMxAlActual: number }; cambiaDominioBase: boolean };
  assert.equal(body.actual, ACTUAL);
  assert.equal(body.dominios.conMxAlActual, 1);
  // El dominio base sale del nombre de Ajustes (proveedor.test), no del identificador.
  assert.equal(body.cambiaDominioBase, true);
});

test('el aviso del nombre del motor no propone dejar el identificador del contenedor', () => {
  evaluateHostnameAlert(NUEVO, '3f2a1b9c8d7e');
  const aviso = listAlerts({}).find((a) => a.type === 'engine_hostname' && a.title.includes('3f2a1b9c8d7e'));
  assert.ok(aviso);
  assert.doesNotMatch(aviso.remedy, /Si el correcto es 3f2a1b9c8d7e/);
  assert.match(aviso.remedy, /Aplicar ajustes recomendados/);
});

test('el aviso del nombre del motor dice cuántos dominios pasarán a pendientes', () => {
  evaluateHostnameAlert(NUEVO, ACTUAL);
  const aviso = listAlerts({}).find((a) => a.type === 'engine_hostname');
  assert.ok(aviso);
  assert.match(aviso.message, /los 3 dominios de correo pasarán a exigir el MX hacia correo\.proveedor\.test/);
  assert.match(aviso.remedy, /Si el correcto es mail\.proveedor\.test, corrígelo en Ajustes → Identidad del servidor/);
});
