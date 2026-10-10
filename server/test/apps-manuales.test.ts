import { test, before } from 'node:test';
import type { TestContext as NodeTestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createAppPassword, revokeAppPassword } from '../src/modules/apppasswords';
import type { CambioDominioVista, PlanCambioDominio } from '../src/modules/domainmigrations';
import { setInstanceSettings } from '../src/modules/settings';
import { instalarDnsFalso } from './dns-falso';
import {
  adminContext,
  createClient,
  createDomain,
  createMailbox,
  crearCambioDeDominio,
  marcarDnsActivo,
  type TestContext,
} from './helpers';

/*
 * Contraseñas de aplicación creadas a mano en un cambio de dominio. Las de
 * Skyway («skyway:…») las pone al día Skyway y bloquean la baja; las demás
 * (un n8n, un bot en otro servidor, el móvil de alguien) siguen valiendo, pero
 * entran con el usuario del buzón, que cambia al actualizarlo o en la baja.
 * Nadie las pone al día: Mailway las nombra (`appsManuales`) y avisa
 * (`apps_manuales`) sin bloquear nada, para que Skyway y el panel lo digan.
 */

let ctx: TestContext;

const sesion = () => ({ cookie: ctx.adminCookie });

async function post(url: string, payload: Record<string, unknown> = {}) {
  return ctx.app.inject({ method: 'POST', url, headers: sesion(), payload });
}

async function vistaDe(id: string): Promise<CambioDominioVista> {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/domain-migrations/${id}`, headers: sesion() });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as CambioDominioVista;
}

before(async () => {
  ctx = await adminContext();
  // Que ningún dominio de la prueba aloje la instancia (bloquearía la baja).
  setInstanceSettings({ mailHostname: 'mail.servidor.test', publicIp: '203.0.113.10' });
});

/** Cliente con un dominio y sus buzones. */
async function escenario(dominio: string, buzones: string[]) {
  const { clientId } = await createClient(ctx);
  const viejo = await createDomain(ctx, clientId, dominio);
  const ids: Record<string, string> = {};
  for (const local of buzones) ids[local] = (await createMailbox(ctx, viejo.domainId, local)).mailboxId;
  return { clientId, viejo, ids };
}

/** Crea el cambio y lo deja «listo» (propiedad y DNS de dominio2.es dados por buenos). */
async function cambioListo(fromDomainId: string, nuevo: string): Promise<CambioDominioVista> {
  const creado = await crearCambioDeDominio(ctx, fromDomainId, nuevo);
  assert.equal(creado.statusCode, 201, creado.body);
  marcarDnsActivo(creado.vista.hacia.domainId!);
  const res = await post(`/api/domain-migrations/${creado.vista.id}/check`);
  assert.equal(res.statusCode, 200, res.body);
  const vista = res.json() as CambioDominioVista;
  assert.equal(vista.estado, 'listo', JSON.stringify(vista.compuertas));
  return vista;
}

/** El MX del dominio anterior apunta a otro proveedor: la baja puede seguir. */
function mxFuera(t: NodeTestContext, dominio: string): void {
  instalarDnsFalso(t, {
    mx: { [dominio]: [{ priority: 10, exchange: 'mx.otro-proveedor.test' }] },
    a: { 'mx.otro-proveedor.test': ['198.51.100.7'] },
  });
}

const aviso = (avisos: { code: string; mensaje: string }[]) => avisos.find((a) => a.code === 'apps_manuales');

test('plan y vista: las de Skyway en usadoPorApps, las creadas a mano en appsManuales y las revocadas en ninguna', async () => {
  const e = await escenario('manual-viejo.test', ['ana', 'luis']);
  await createAppPassword(e.ids.ana!, 'skyway:web', null);
  await createAppPassword(e.ids.ana!, 'n8n-a-mano', null);
  const vieja = await createAppPassword(e.ids.ana!, 'Portátil antiguo', null);
  await revokeAppPassword(e.ids.ana!, vieja.appPassword.id);

  const res = await post('/api/domain-migrations/plan', { fromDomainId: e.viejo.domainId, toDomain: 'manual-nuevo.test' });
  assert.equal(res.statusCode, 200, res.body);
  const plan = res.json() as PlanCambioDominio;
  assert.deepEqual(
    plan.buzones.map((b) => [b.de, b.usadoPorApps, b.appsManuales]),
    [
      ['ana@manual-viejo.test', ['skyway:web'], ['n8n-a-mano']],
      ['luis@manual-viejo.test', [], []],
    ],
  );
  // El aviso del plan nombra solo la activa creada a mano, y no bloquea.
  assert.deepEqual(plan.bloqueos, []);
  assert.equal(
    aviso(plan.avisos)?.mensaje,
    'Un buzón tiene una contraseña de aplicación creada a mano (n8n-a-mano). Tras actualizar su usuario o dar de baja manual-viejo.test, la aplicación que la usa tiene que entrar con la dirección nueva.',
  );
  // Las de Skyway siguen en su propio aviso.
  assert.ok(plan.avisos.some((a) => a.code === 'apps_smtp'));

  const listo = await cambioListo(e.viejo.domainId, 'manual-nuevo.test');
  const ana = listo.buzones.lista.find((b) => b.id === e.ids.ana)!;
  assert.deepEqual([ana.usadoPorApps, ana.appsManuales], [['skyway:web'], ['n8n-a-mano']]);
  assert.deepEqual(listo.buzones.lista.find((b) => b.id === e.ids.luis)!.appsManuales, []);
  // Antes de pasar ningún buzón está pendiente: el aviso de la vista aún no aplica.
  assert.equal(aviso(listo.avisos), undefined);

  const pasado = await post(`/api/domain-migrations/${listo.id}/switch`);
  assert.equal(pasado.statusCode, 200, pasado.body);
  const vista = pasado.json() as CambioDominioVista;
  const anaPasada = vista.buzones.lista.find((b) => b.id === e.ids.ana)!;
  assert.equal(anaPasada.pendiente, true);
  assert.deepEqual([anaPasada.usadoPorApps, anaPasada.appsManuales], [['skyway:web'], ['n8n-a-mano']]);
  assert.match(aviso(vista.avisos)?.mensaje ?? '', /^Un buzón tiene una contraseña de aplicación creada a mano \(n8n-a-mano\)\./);
});

test('aviso apps_manuales: solo con los buzones pendientes, sin bloquear la baja, y fuera tras la baja', async (t) => {
  const e = await escenario('aviso-manual-viejo.test', ['ana', 'luis', 'eva']);
  await createAppPassword(e.ids.ana!, 'n8n-a-mano', null);
  await createAppPassword(e.ids.ana!, 'Móvil de Ana', null);
  await createAppPassword(e.ids.luis!, 'n8n-a-mano', null);

  const listo = await cambioListo(e.viejo.domainId, 'aviso-manual-nuevo.test');
  const pasado = await post(`/api/domain-migrations/${listo.id}/switch`);
  assert.equal(pasado.statusCode, 200, pasado.body);
  const vista = pasado.json() as CambioDominioVista;
  assert.equal(vista.estado, 'pasado');
  // Los nombres no se repiten aunque los tengan varios buzones.
  assert.equal(
    aviso(vista.avisos)?.mensaje,
    '2 buzones tienen contraseñas de aplicación creadas a mano (n8n-a-mano, Móvil de Ana). Tras actualizar su usuario o dar de baja aviso-manual-viejo.test, las aplicaciones que las usan tienen que entrar con la dirección nueva.',
  );
  // Solo informa: la baja sigue disponible.
  assert.deepEqual(vista.bloqueosBaja, []);
  assert.equal(vista.puedeDarDeBaja, true);

  // Ana actualiza su usuario: ya no está pendiente y el aviso solo cuenta a Luis.
  const actualizado = await post(`/api/mailboxes/${e.ids.ana}/login-update`);
  assert.equal(actualizado.statusCode, 200, actualizado.body);
  const trasActualizar = await vistaDe(listo.id);
  assert.match(aviso(trasActualizar.avisos)?.mensaje ?? '', /^Un buzón tiene una contraseña de aplicación creada a mano \(n8n-a-mano\)\./);
  // La lista sigue nombrándolas: las aplicaciones de Ana también tienen que cambiar su usuario.
  assert.deepEqual(trasActualizar.buzones.lista.find((b) => b.id === e.ids.ana)!.appsManuales, ['n8n-a-mano', 'Móvil de Ana']);
  assert.equal(trasActualizar.puedeDarDeBaja, true);

  mxFuera(t, 'aviso-manual-viejo.test');
  const baja = await post(`/api/domain-migrations/${listo.id}/retire`, { confirm: 'aviso-manual-viejo.test' });
  assert.equal(baja.statusCode, 200, baja.body);
  const final = baja.json() as CambioDominioVista;
  assert.equal(final.estado, 'dado_de_baja');
  assert.equal(aviso(final.avisos), undefined);
  assert.equal(aviso((await vistaDe(listo.id)).avisos), undefined);
});
