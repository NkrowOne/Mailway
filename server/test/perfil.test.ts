import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { db } from '../src/core/db';
import {
  adminContext,
  cookieFrom,
  createClient,
  createDomain,
  createMailbox,
  type TestContext,
} from './helpers';

/*
 * Perfil del buzón (nombre visible y foto) desde el panel, el enlace de
 * configuración, «Mi buzón» y el webmail.
 */

let ctx: TestContext;
let ipSeq = 0;
function nuevaIp(): string {
  ipSeq += 1;
  return `10.30.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

before(async () => {
  ctx = await adminContext();
});

/** PNG de 1×1 píxel, válido. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = `data:image/png;base64,${PNG_BASE64}`;
/** JPEG mínimo: solo importa la firma. */
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64')}`;

async function buzonDePrueba(opts: { withUser?: boolean } = {}) {
  const client = await createClient(ctx, { withUser: opts.withUser });
  const { domainId } = await createDomain(ctx, client.clientId);
  const mailbox = await createMailbox(ctx, domainId);
  return { ...client, ...mailbox, domainId };
}

function tokenDe(url: string): string {
  return /\/conectar\/([A-Za-z0-9_-]+)$/.exec(url)![1]!;
}

async function enlace(mailboxId: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${mailboxId}/setup-links`,
    headers: { cookie: ctx.adminCookie },
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body);
  return tokenDe((res.json() as { link: { url: string } }).link.url);
}

function auditoria(action: string, email: string): { client_id: string | null; detail: string }[] {
  return (
    db.prepare('SELECT client_id, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as {
      client_id: string | null;
      detail: string;
    }[]
  ).filter((a) => a.detail.includes(email));
}

test('panel: subir, ver y quitar la foto; el listado lleva su fecha', async () => {
  const b = await buzonDePrueba();
  const sinFoto = await ctx.app.inject({
    method: 'GET',
    url: `/api/mailboxes/${b.mailboxId}/photo`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(sinFoto.statusCode, 404);
  assert.equal(sinFoto.json().code, 'photo_not_found');

  const subida = await ctx.app.inject({
    method: 'PUT',
    url: `/api/mailboxes/${b.mailboxId}/photo`,
    headers: { cookie: ctx.adminCookie },
    payload: { photo: PNG },
  });
  assert.equal(subida.statusCode, 200, subida.body);
  const { photoUpdatedAt } = subida.json() as { photoUpdatedAt: number };

  const foto = await ctx.app.inject({
    method: 'GET',
    url: `/api/mailboxes/${b.mailboxId}/photo`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(foto.statusCode, 200);
  assert.equal(foto.headers['content-type'], 'image/png');
  assert.equal(foto.headers['x-content-type-options'], 'nosniff');
  assert.equal(foto.headers['content-security-policy'], "default-src 'none'");
  assert.deepEqual(foto.rawPayload, Buffer.from(PNG_BASE64, 'base64'));

  const lista = await ctx.app.inject({ method: 'GET', url: '/api/mailboxes', headers: { cookie: ctx.adminCookie } });
  const fila = (lista.json() as { mailboxes: { id: string; photoUpdatedAt: number | null }[] }).mailboxes.find(
    (m) => m.id === b.mailboxId,
  );
  assert.equal(fila?.photoUpdatedAt, photoUpdatedAt);

  // Cambiarla da otra fecha: la URL con ?v= cambia y el navegador no sirve la vieja.
  const otra = await ctx.app.inject({
    method: 'PUT',
    url: `/api/mailboxes/${b.mailboxId}/photo`,
    headers: { cookie: ctx.adminCookie },
    payload: { photo: JPEG },
  });
  assert.ok((otra.json() as { photoUpdatedAt: number }).photoUpdatedAt > photoUpdatedAt);

  const quitada = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/mailboxes/${b.mailboxId}/photo`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(quitada.statusCode, 200);
  const despues = await ctx.app.inject({
    method: 'GET',
    url: `/api/mailboxes/${b.mailboxId}/photo`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(despues.statusCode, 404);
  assert.equal(auditoria('mailbox.photo_updated', b.email).length, 2);
  assert.equal(auditoria('mailbox.photo_removed', b.email)[0]?.client_id, b.clientId);
});

test('solo se aceptan JPEG, PNG o WebP de verdad y de 512 KB como mucho', async () => {
  const b = await buzonDePrueba();
  const subir = (photo: string) =>
    ctx.app.inject({
      method: 'PUT',
      url: `/api/mailboxes/${b.mailboxId}/photo`,
      headers: { cookie: ctx.adminCookie },
      payload: { photo },
    });

  // Un SVG (o HTML) declarado como imagen se serviría desde el dominio del panel.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  for (const photo of [`data:image/svg+xml;base64,${svg}`, `data:image/png;base64,${svg}`, 'no-es-un-data-url', '']) {
    const res = await subir(photo);
    assert.equal(res.statusCode, 400, photo.slice(0, 30));
    assert.equal(res.json().code, 'invalid_photo');
  }

  const grande = Buffer.alloc(512 * 1024 + 1);
  Buffer.from(PNG_BASE64, 'base64').copy(grande);
  const res = await subir(`data:image/png;base64,${grande.toString('base64')}`);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'photo_too_large');

  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  const ok = await subir(`data:image/webp;base64,${webp.toString('base64')}`);
  assert.equal(ok.statusCode, 200, ok.body);
});

test('panel: solo quien gestiona el cliente del buzón ve o cambia su foto', async () => {
  const propio = await buzonDePrueba({ withUser: true });
  const ajeno = await createClient(ctx, { withUser: true });
  const deOtro = await ctx.app.inject({
    method: 'PUT',
    url: `/api/mailboxes/${propio.mailboxId}/photo`,
    headers: { cookie: ajeno.userCookie! },
    payload: { photo: PNG },
  });
  assert.equal(deOtro.statusCode, 403);
  const anonimo = await ctx.app.inject({ method: 'GET', url: `/api/mailboxes/${propio.mailboxId}/photo` });
  assert.equal(anonimo.statusCode, 401);
  const delCliente = await ctx.app.inject({
    method: 'PUT',
    url: `/api/mailboxes/${propio.mailboxId}/photo`,
    headers: { cookie: propio.userCookie! },
    payload: { photo: PNG },
  });
  assert.equal(delCliente.statusCode, 200, delCliente.body);
});

test('onboarding: el titular pone su nombre y su foto con el enlace', async () => {
  const b = await buzonDePrueba();
  const token = await enlace(b.mailboxId);

  const nombre = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/public/setup/${token}/profile`,
    payload: { displayName: '  Ana García  ' },
  });
  assert.equal(nombre.statusCode, 200, nombre.body);
  assert.equal(nombre.json().displayName, 'Ana García');
  const fila = db.prepare('SELECT display_name FROM mailboxes WHERE id = ?').get(b.mailboxId) as { display_name: string };
  assert.equal(fila.display_name, 'Ana García');

  const largo = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/public/setup/${token}/profile`,
    payload: { displayName: 'x'.repeat(81) },
  });
  assert.equal(largo.statusCode, 400);

  const pagina0 = await ctx.app.inject({ method: 'GET', url: `/api/public/setup/${token}` });
  assert.equal(pagina0.json().photoUrl, null);

  const foto = await ctx.app.inject({
    method: 'PUT',
    url: `/api/public/setup/${token}/photo`,
    payload: { photo: PNG },
  });
  assert.equal(foto.statusCode, 200, foto.body);
  const { photoUrl } = foto.json() as { photoUrl: string };
  assert.match(photoUrl, new RegExp(`^/api/public/setup/${token}/photo\\?v=\\d+$`));

  // La página y el perfil de Apple ya llevan el nombre nuevo.
  const pagina = await ctx.app.inject({ method: 'GET', url: `/api/public/setup/${token}` });
  assert.equal(pagina.json().displayName, 'Ana García');
  assert.equal(pagina.json().photoUrl, photoUrl);
  const perfil = await ctx.app.inject({ method: 'GET', url: `/api/public/setup/${token}/perfil.mobileconfig` });
  assert.ok(perfil.body.includes('Ana García'));
  const imagen = await ctx.app.inject({ method: 'GET', url: photoUrl });
  assert.equal(imagen.statusCode, 200);
  assert.equal(imagen.headers['content-type'], 'image/png');

  const quitar = await ctx.app.inject({ method: 'DELETE', url: `/api/public/setup/${token}/photo` });
  assert.equal(quitar.statusCode, 200);
  assert.equal((await ctx.app.inject({ method: 'GET', url: photoUrl })).statusCode, 404);
  assert.equal(auditoria('portal.profile_updated', b.email)[0]?.client_id, b.clientId);
  assert.equal(auditoria('portal.photo_updated', b.email).length, 1);

  // Un enlace revocado ya no sirve para cambiar nada.
  const linkId = (db.prepare('SELECT id FROM setup_links WHERE mailbox_id = ?').get(b.mailboxId) as { id: string }).id;
  await ctx.app.inject({
    method: 'DELETE',
    url: `/api/mailboxes/${b.mailboxId}/setup-links/${linkId}`,
    headers: { cookie: ctx.adminCookie },
  });
  const revocado = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/public/setup/${token}/profile`,
    payload: { displayName: 'Intruso' },
  });
  assert.equal(revocado.statusCode, 404);
  assert.equal(revocado.json().code, 'setup_link_invalid');
  const fotoRevocado = await ctx.app.inject({ method: 'PUT', url: `/api/public/setup/${token}/photo`, payload: { photo: PNG } });
  assert.equal(fotoRevocado.statusCode, 404);
});

test('«Mi buzón»: cambiar el nombre y la foto', async () => {
  const b = await buzonDePrueba();
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/portal/login',
    payload: { email: b.email, password: b.password },
    remoteAddress: nuevaIp(),
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = cookieFrom(login);

  const anonimo = await ctx.app.inject({ method: 'PATCH', url: '/api/portal/profile', payload: { displayName: 'X' } });
  assert.equal(anonimo.statusCode, 401);

  const nombre = await ctx.app.inject({
    method: 'PATCH',
    url: '/api/portal/profile',
    headers: { cookie },
    payload: { displayName: 'Departamento Legal' },
  });
  assert.equal(nombre.statusCode, 200, nombre.body);

  const foto = await ctx.app.inject({ method: 'PUT', url: '/api/portal/photo', headers: { cookie }, payload: { photo: PNG } });
  assert.equal(foto.statusCode, 200, foto.body);

  const me = await ctx.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } });
  assert.equal(me.json().displayName, 'Departamento Legal');
  assert.match(me.json().photoUrl, /^\/api\/portal\/photo\?v=\d+$/);
  const imagen = await ctx.app.inject({ method: 'GET', url: '/api/portal/photo', headers: { cookie } });
  assert.equal(imagen.statusCode, 200);

  await ctx.app.inject({ method: 'DELETE', url: '/api/portal/photo', headers: { cookie } });
  const sin = await ctx.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } });
  assert.equal(sin.json().photoUrl, null);
});

test('webmail: nombre para la identidad y fotos solo del mismo cliente', async () => {
  const b = await buzonDePrueba();
  const companero = await createMailbox(ctx, b.domainId);
  const otro = await buzonDePrueba();
  await ctx.app.inject({
    method: 'PATCH',
    url: `/api/mailboxes/${companero.mailboxId}`,
    headers: { cookie: ctx.adminCookie },
    payload: { displayName: 'Compañera' },
  });
  for (const id of [companero.mailboxId, otro.mailboxId]) {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/mailboxes/${id}/photo`,
      headers: { cookie: ctx.adminCookie },
      payload: { photo: PNG },
    });
  }

  const pedir = (url: string, payload: Record<string, string>, token?: string) =>
    ctx.app.inject({
      method: 'POST',
      url,
      headers: token ? { 'x-mailway-token': token } : {},
      payload,
    });

  const anterior = config.webmailToken;
  try {
    config.webmailToken = '';
    assert.equal((await pedir('/api/webmail/profile', { user: b.email }, 'lo-que-sea')).statusCode, 404);

    const token = 'secreto-compartido-perfil';
    config.webmailToken = token;
    assert.equal((await pedir('/api/webmail/profile', { user: b.email })).statusCode, 401);
    assert.equal((await pedir('/api/webmail/profile', { user: b.email }, 'otro')).statusCode, 401);

    const perfil = await pedir('/api/webmail/profile', { user: companero.email.toUpperCase() }, token);
    assert.equal(perfil.statusCode, 200, perfil.body);
    assert.deepEqual(perfil.json(), { name: 'Compañera', photo: true });
    const sinFoto = await pedir('/api/webmail/profile', { user: b.email }, token);
    assert.equal(sinFoto.json().photo, false);
    assert.equal((await pedir('/api/webmail/profile', { user: 'nadie@ninguno.test' }, token)).statusCode, 404);

    const mismoCliente = await pedir('/api/webmail/photo', { user: b.email, email: companero.email }, token);
    assert.equal(mismoCliente.statusCode, 200);
    assert.equal(mismoCliente.headers['content-type'], 'image/png');
    const otroCliente = await pedir('/api/webmail/photo', { user: b.email, email: otro.email }, token);
    assert.equal(otroCliente.statusCode, 404, 'la foto no cruza de un cliente a otro');
    const externo = await pedir('/api/webmail/photo', { user: b.email, email: 'alguien@gmail.com' }, token);
    assert.equal(externo.statusCode, 404);

    // El complemento de Roundcube puede enviar formulario en lugar de JSON.
    const formulario = await ctx.app.inject({
      method: 'POST',
      url: '/api/webmail/profile',
      headers: { 'x-mailway-token': token, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `user=${encodeURIComponent(companero.email)}`,
    });
    assert.equal(formulario.statusCode, 200, formulario.body);
  } finally {
    config.webmailToken = anterior;
  }
});

test('reiniciar la configuración quita la foto y conserva el nombre', async () => {
  const b = await buzonDePrueba();
  await ctx.app.inject({
    method: 'PATCH',
    url: `/api/mailboxes/${b.mailboxId}`,
    headers: { cookie: ctx.adminCookie },
    payload: { displayName: 'Legal' },
  });
  await ctx.app.inject({
    method: 'PUT',
    url: `/api/mailboxes/${b.mailboxId}/photo`,
    headers: { cookie: ctx.adminCookie },
    payload: { photo: PNG },
  });
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${b.mailboxId}/setup-reset`,
    headers: { cookie: ctx.adminCookie },
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().photoRemoved, true);
  const fila = db
    .prepare(
      'SELECT m.display_name, p.mailbox_id AS foto FROM mailboxes m LEFT JOIN mailbox_photos p ON p.mailbox_id = m.id WHERE m.id = ?',
    )
    .get(b.mailboxId) as { display_name: string; foto: string | null };
  assert.equal(fila.display_name, 'Legal');
  assert.equal(fila.foto, null);

  const otraVez = await ctx.app.inject({
    method: 'POST',
    url: `/api/mailboxes/${b.mailboxId}/setup-reset`,
    headers: { cookie: ctx.adminCookie },
    payload: {},
  });
  assert.equal(otraVez.json().photoRemoved, false);
});
