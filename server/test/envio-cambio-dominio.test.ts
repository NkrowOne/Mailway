import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Transporter } from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool';
import { config } from '../src/config';
import { db } from '../src/core/db';
import { getEngine } from '../src/engine';
import { resetFormLimitsForTests } from '../src/modules/forms';
import { setEngineSettings } from '../src/modules/settings';
import { setTransportFactoryForTests } from '../src/modules/transactional';
import { adminContext, createClient, createDomain, createMailbox, type TestContext } from './helpers';

/*
 * Envío durante un cambio de dominio: las claves de API y los formularios
 * autentican en el SMTP del motor con el usuario del motor (el anterior,
 * mientras el buzón está pendiente de actualizar) y el mensaje sale con la
 * dirección nueva. Al actualizar el usuario, la huella del transporte cambia y
 * el pool se rehace con las credenciales al día.
 */

const ORIGEN = 'https://www.envio-nuevo.test';

let ctx: TestContext;
let clientId: string;
let mailboxId: string;
let login: string;
let email: string;
let clave: { key: string; id: string };
let formulario: { id: string; publicKey: string };

interface Transporte {
  options: SMTPPool.Options;
  enviados: Mail.Options[];
  cerrado: boolean;
}
const transportes: Transporte[] = [];

before(async () => {
  ctx = await adminContext();
  ({ clientId } = await createClient(ctx));
  const plan = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/clients/${clientId}`,
    headers: { cookie: ctx.adminCookie },
    payload: { planId: 'plan_agencia' },
  });
  assert.equal(plan.statusCode, 200, plan.body);
  const viejo = await createDomain(ctx, clientId, 'envio-viejo.test');
  const nuevo = await createDomain(ctx, clientId, 'envio-nuevo.test');
  ({ mailboxId } = await createMailbox(ctx, viejo.domainId, 'ventas'));
  login = `ventas@${viejo.domain}`;
  email = `ventas@${nuevo.domain}`;

  // La clave y el formulario nacen antes del cambio, con el buzón en el viejo.
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/apikeys',
    headers: { cookie: ctx.adminCookie },
    payload: { clientId, name: 'Tienda', senderMailboxId: mailboxId },
  });
  assert.equal(res.statusCode, 200, res.body);
  clave = { key: (res.json() as { key: string }).key, id: (res.json() as { info: { id: string } }).info.id };
  const form = await ctx.app.inject({
    method: 'POST',
    url: '/api/forms',
    headers: { cookie: ctx.adminCookie },
    payload: { clientId, name: 'Contacto', recipientMailboxId: mailboxId, allowedOrigins: [ORIGEN] },
  });
  assert.equal(form.statusCode, 200, form.body);
  formulario = (form.json() as { form: { id: string; publicKey: string } }).form;

  // «Pasar»: las dos direcciones en el motor y el buzón en el dominio nuevo,
  // entrando todavía con su usuario anterior.
  await getEngine().createDomain(nuevo.domain);
  await getEngine().setAddresses(login, { add: [email], primary: email });
  db.prepare('UPDATE mailboxes SET domain_id = ?, usuario_motor = ? WHERE id = ?').run(nuevo.domainId, login, mailboxId);

  setTransportFactoryForTests((options) => {
    const registro: Transporte = { options, enviados: [], cerrado: false };
    transportes.push(registro);
    return {
      sendMail: async (mensaje: Mail.Options) => {
        registro.enviados.push(mensaje);
        return { messageId: `<prueba-${registro.enviados.length}@mailway>` };
      },
      close: () => {
        registro.cerrado = true;
      },
    } as unknown as Transporter;
  });
  // Sin el motor de demostración, /v1/send y los formularios usan el
  // transporte SMTP (aquí, el falso). Desde aquí nada más llama al motor.
  config.demoMode = false;
  setEngineSettings({
    kind: 'stalwart',
    url: 'http://mailway-mail:8080',
    adminUser: 'admin',
    adminPassword: 'x',
    smtpHost: 'mailway-mail',
    smtpPort: 587,
    smtpSecure: false,
  });
});

after(() => {
  config.demoMode = true;
  setTransportFactoryForTests(null);
});

beforeEach(() => {
  resetFormLimitsForTests();
});

let ipSeq = 0;
function enviarApi() {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/send',
    headers: { authorization: `Bearer ${clave.key}` },
    payload: { to: 'cliente@ejemplo.org', subject: 'Pedido', text: 'Gracias por tu pedido.' },
  });
}
function enviarFormulario() {
  return ctx.app.inject({
    method: 'POST',
    url: `/forms/${formulario.publicKey}`,
    remoteAddress: `198.51.100.${(ipSeq++ % 250) + 1}`,
    headers: { accept: 'application/json', origin: ORIGEN },
    payload: { nombre: 'Ana', email: 'ana@ejemplo.org', mensaje: 'Hola.' },
  });
}

function usuarioSmtp(t: Transporte): unknown {
  return (t.options.auth as { user?: string } | undefined)?.user;
}

function remitente(mensaje: Mail.Options): string {
  const from = mensaje.from;
  return typeof from === 'string' ? from : (from as { address: string }).address;
}

test('tras pasar, la API y los formularios autentican con el usuario anterior y envían con la dirección nueva', async () => {
  const api = await enviarApi();
  assert.equal(api.statusCode, 200, api.body);
  assert.equal(api.json().status, 'sent');
  const deLaClave = transportes.at(-1)!;
  assert.equal(usuarioSmtp(deLaClave), login);
  assert.equal(remitente(deLaClave.enviados[0]!), email);
  const fila = db.prepare('SELECT from_address FROM messages WHERE api_key_id = ?').get(clave.id) as { from_address: string };
  assert.equal(fila.from_address, email);

  const form = await enviarFormulario();
  assert.equal(form.statusCode, 200, form.body);
  const delFormulario = transportes.at(-1)!;
  assert.notEqual(delFormulario, deLaClave);
  assert.equal(usuarioSmtp(delFormulario), login);
  assert.equal(remitente(delFormulario.enviados[0]!), email);
  assert.equal(delFormulario.enviados[0]!.to, email);

  // Un segundo envío reutiliza el mismo pool: nada ha cambiado.
  const creados = transportes.length;
  assert.equal((await enviarApi()).statusCode, 200);
  assert.equal(transportes.length, creados);
});

test('con un cambio de usuario a medias no se envía ni se gasta cupo', async () => {
  db.prepare('UPDATE mailboxes SET usuario_cambiando_a = ? WHERE id = ?').run(email, mailboxId);
  try {
    const usados = (
      db.prepare('SELECT COALESCE(SUM(count), 0) AS c FROM api_usage WHERE api_key_id = ?').get(clave.id) as { c: number }
    ).c;
    const api = await enviarApi();
    assert.equal(api.statusCode, 409, api.body);
    assert.equal(api.json().code, 'mailbox_login_updating');
    assert.equal(
      (db.prepare('SELECT COALESCE(SUM(count), 0) AS c FROM api_usage WHERE api_key_id = ?').get(clave.id) as { c: number }).c,
      usados,
    );
    const form = await enviarFormulario();
    assert.equal(form.statusCode, 503, form.body);
    assert.equal(form.json().code, 'form_unavailable');
  } finally {
    db.prepare('UPDATE mailboxes SET usuario_cambiando_a = NULL WHERE id = ?').run(mailboxId);
  }
});

test('tras actualizar el usuario, la huella cambia y el pool se rehace con el usuario nuevo', async () => {
  const anteriores = transportes.filter((t) => !t.cerrado);
  // Lo que deja «Actualizar mis dispositivos» (el renombrado se prueba en usuario-motor).
  db.prepare('UPDATE mailboxes SET usuario_motor = NULL, login_anterior = ? WHERE id = ?').run(login, mailboxId);

  const creados = transportes.length;
  const api = await enviarApi();
  assert.equal(api.statusCode, 200, api.body);
  assert.equal(transportes.length, creados + 1, 'otro transporte para la clave');
  const deLaClave = transportes.at(-1)!;
  assert.equal(usuarioSmtp(deLaClave), email);
  assert.equal(remitente(deLaClave.enviados[0]!), email);

  const form = await enviarFormulario();
  assert.equal(form.statusCode, 200, form.body);
  assert.equal(transportes.length, creados + 2, 'otro transporte para el formulario');
  assert.equal(usuarioSmtp(transportes.at(-1)!), email);

  assert.ok(anteriores.length >= 2);
  assert.ok(anteriores.every((t) => t.cerrado), 'los pools con el usuario anterior se cierran');
});
