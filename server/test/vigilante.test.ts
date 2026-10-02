import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { listAlerts } from '../src/modules/alerts';
import { setInstanceSettings } from '../src/modules/settings';
import { checkWebmail } from '../src/modules/watchdog';
import { adminContext } from './helpers';

/*
 * Vigilante del webmail: una página de error no acredita que el webmail esté
 * en marcha. Solo una respuesta 2xx o una redirección (la del inicio de
 * sesión) lo hacen; un 404 o un 403 son la página de error de Traefik o de
 * otra aplicación servida en ese nombre.
 */

const WEBMAIL = 'https://webmail.mailway.test';

before(async () => {
  await adminContext();
  setInstanceSettings({ webmailUrl: WEBMAIL });
});

function avisoWebmail() {
  return listAlerts({}).find((a) => a.type === 'webmail_down') ?? null;
}

test('el webmail solo está bien con HTTP 2xx o 3xx', async (t) => {
  const fetchFalso = t.mock.method(globalThis, 'fetch');
  const responder = (status: number) =>
    fetchFalso.mock.mockImplementation(async () => new Response(null, { status }));

  for (const status of [404, 403, 401, 500, 502, 503]) {
    responder(200);
    await checkWebmail();
    assert.equal(avisoWebmail(), null, 'con 200 no hay aviso abierto');
    responder(status);
    await checkWebmail();
    const aviso = avisoWebmail();
    assert.ok(aviso, `HTTP ${status} abre el aviso`);
    assert.match(aviso.message, new RegExp(`HTTP ${status}`));
  }

  for (const status of [200, 204, 301, 302, 303, 307]) {
    responder(status);
    await checkWebmail();
    assert.equal(avisoWebmail(), null, `HTTP ${status} es un webmail que atiende`);
  }

  fetchFalso.mock.mockImplementation(async () => {
    throw new Error('connect ECONNREFUSED');
  });
  await checkWebmail();
  assert.match(avisoWebmail()?.message ?? '', /No hay respuesta desde https:\/\/webmail\.mailway\.test/);
});
