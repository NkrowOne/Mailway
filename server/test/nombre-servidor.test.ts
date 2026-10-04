import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { listAlerts } from '../src/modules/alerts';
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

test('el aviso del nombre del motor dice cuántos dominios pasarán a pendientes', () => {
  evaluateHostnameAlert(NUEVO, ACTUAL);
  const aviso = listAlerts({}).find((a) => a.type === 'engine_hostname');
  assert.ok(aviso);
  assert.match(aviso.message, /los 3 dominios de correo pasarán a exigir el MX hacia correo\.proveedor\.test/);
  assert.match(aviso.remedy, /Si el correcto es mail\.proveedor\.test, corrígelo en Ajustes → Identidad del servidor/);
});
