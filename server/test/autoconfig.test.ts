import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import {
  refreshAutoconfigForDomain,
  refreshAutoconfigHosts,
  type HostCheck,
} from '../src/modules/autoconfig';
import {
  AUTOCONFIG_HOSTS_SETTING,
  readAutoconfigHostStates,
  type AutoconfigHostRecord,
} from '../src/modules/connection';
import { setInstanceSettings, setJsonSetting } from '../src/modules/settings';
import {
  adminContext,
  createClient,
  createDomain,
  createMailbox,
  type TestContext,
} from './helpers';

/**
 * Rutas públicas de autoconfiguración (Thunderbird, Autodiscover, MTA-STS),
 * perfil de Apple, datos de conexión y estado DNS de los hosts. Todo con la
 * app real y sin red: MAILWAY_DNS_OFFLINE=1 hace que cualquier consulta DNS
 * sea «no se pudo consultar»; los casos positivos se siembran en ajustes.
 */

let ctx: TestContext;
let clientA: Awaited<ReturnType<typeof createClient>>;
let clientB: Awaited<ReturnType<typeof createClient>>;
let domainA: { domainId: string; domain: string };
let mailbox: { mailboxId: string; email: string };

const MAIL_HOST = 'mail.proveedor.test';
const PANEL = 'https://panel.proveedor.test';

function record(state: AutoconfigHostRecord['state']): AutoconfigHostRecord {
  return {
    state,
    detail: 'sembrado',
    checkedAt: 1,
    changedAt: 1,
    lastAttemptAt: 1,
    lastAttemptInconclusive: false,
  };
}

before(async () => {
  ctx = await adminContext();
  setInstanceSettings({
    brandName: 'Correo Proveedor',
    mailHostname: MAIL_HOST,
    publicIp: '203.0.113.10',
    panelUrl: PANEL,
    webmailUrl: 'https://webmail.proveedor.test',
  });
  clientA = await createClient(ctx, { withUser: true });
  clientB = await createClient(ctx, { withUser: true });
  domainA = await createDomain(ctx, clientA.clientId, 'cliente-a.test');
  await createDomain(ctx, clientB.clientId, 'cliente-b.test');
  mailbox = await createMailbox(ctx, domainA.domainId, 'ana');
});

beforeEach(() => {
  setJsonSetting(AUTOCONFIG_HOSTS_SETTING, {});
});

/* ------------------------------- Thunderbird ------------------------------ */

test('Thunderbird: documento para una dirección de un dominio gestionado', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/mail/config-v1.1.xml?emailaddress=${encodeURIComponent('ana@cliente-a.test')}`,
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /^application\/xml/);
  assert.match(res.body, /<emailProvider id="cliente-a\.test">/);
  assert.match(res.body, /<domain>cliente-a\.test<\/domain>/);
  assert.match(res.body, /<hostname>mail\.proveedor\.test<\/hostname>/);
  assert.match(res.body, /<port>993<\/port>/);
  assert.match(res.body, /<username>%EMAILADDRESS%<\/username>/);
  assert.doesNotMatch(res.body, /%EMAILDOMAIN%/, 'con dirección no hace falta el comodín');
});

test('Thunderbird: sin dirección, el dominio sale del host autoconfig.<dominio>', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/.well-known/autoconfig/mail/config-v1.1.xml',
    headers: { host: 'autoconfig.cliente-a.test' },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<domain>cliente-a\.test<\/domain>/);
});

test('Thunderbird para Android: el host de la instancia sin dirección da el documento genérico', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/mail/config-v1.1.xml',
    headers: { host: 'autoconfig.proveedor.test' },
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /^application\/xml/);
  assert.match(res.body, /<domain>proveedor\.test<\/domain>/);
  assert.match(res.body, /<domain>%EMAILDOMAIN%<\/domain>/);
});

test('Thunderbird: por el host de la instancia con dirección, manda el dominio de la dirección', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/mail/config-v1.1.xml?emailaddress=ana%40cliente-a.test',
    headers: { host: 'autoconfig.proveedor.test' },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<emailProvider id="cliente-a\.test">/);
  assert.doesNotMatch(res.body, /%EMAILDOMAIN%/);
});

test('Thunderbird: un dominio que no es de esta instancia da 404', async () => {
  const porDireccion = await ctx.app.inject({
    method: 'GET',
    url: '/mail/config-v1.1.xml?emailaddress=alguien%40ajeno.test',
    headers: { host: 'autoconfig.proveedor.test' },
  });
  assert.equal(porDireccion.statusCode, 404);
  const porHost = await ctx.app.inject({
    method: 'GET',
    url: '/mail/config-v1.1.xml',
    headers: { host: 'autoconfig.ajeno.test' },
  });
  assert.equal(porHost.statusCode, 404);
  const basura = await ctx.app.inject({ method: 'GET', url: '/mail/config-v1.1.xml?emailaddress=no-es-correo' });
  assert.equal(basura.statusCode, 404);
});

/* ------------------------------- Autodiscover ----------------------------- */

function poxRequest(email: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">
  <Request>
    <EMailAddress>${email}</EMailAddress>
    <AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema>
  </Request>
</Autodiscover>`;
}

test('Autodiscover: POST con cuerpo XML devuelve IMAP y SMTP del dominio', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/autodiscover/autodiscover.xml',
    headers: { 'content-type': 'text/xml; charset=utf-8' },
    payload: poxRequest('ana@cliente-a.test'),
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /^text\/xml/);
  assert.match(res.body, /<Type>IMAP<\/Type>/);
  assert.match(res.body, /<Server>mail\.proveedor\.test<\/Server>/);
  assert.match(res.body, /<LoginName>ana@cliente-a\.test<\/LoginName>/);
  assert.doesNotMatch(res.body, /<Encryption>/, 'en 993/465 <Encryption>TLS</Encryption> significaría STARTTLS');
});

test('Autodiscover: la ruta no distingue mayúsculas', async () => {
  for (const url of ['/Autodiscover/Autodiscover.xml', '/AUTODISCOVER/AutoDiscover.XML']) {
    const res = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/xml' },
      payload: poxRequest('ana@cliente-a.test'),
    });
    assert.equal(res.statusCode, 200, url);
    assert.match(res.body, /<Server>mail\.proveedor\.test<\/Server>/, url);
  }
});

test('Autodiscover: un dominio ajeno responde 200 con el XML de error', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/autodiscover/autodiscover.xml',
    headers: { 'content-type': 'text/xml' },
    payload: poxRequest('alguien@ajeno.test'),
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<ErrorCode>600<\/ErrorCode>/);
});

test('Autodiscover: con Authorization (Thunderbird manda la contraseña real) sigue siendo 200, nunca 401', async () => {
  const basic = Buffer.from('ana@cliente-a.test:contraseña-real').toString('base64');
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/autodiscover/autodiscover.xml',
    headers: { 'content-type': 'text/xml', authorization: `Basic ${basic}` },
    payload: poxRequest('ana@cliente-a.test'),
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<Type>IMAP<\/Type>/);
  const bearer = await ctx.app.inject({
    method: 'POST',
    url: '/autodiscover/autodiscover.xml',
    headers: { 'content-type': 'text/xml', authorization: 'Bearer mwt_00000000_falso' },
    payload: poxRequest('ana@cliente-a.test'),
  });
  assert.equal(bearer.statusCode, 200);
});

test('Autodiscover: GET, cuerpo vacío, JSON roto o enorme responden 200 con error', async () => {
  const casos = [
    { method: 'GET' as const, payload: undefined, headers: {} },
    { method: 'POST' as const, payload: '', headers: { 'content-type': 'text/xml' } },
    { method: 'POST' as const, payload: '{"roto":', headers: { 'content-type': 'application/json' } },
    { method: 'POST' as const, payload: 'x'.repeat(100_000), headers: { 'content-type': 'text/xml' } },
  ];
  for (const caso of casos) {
    const res = await ctx.app.inject({ url: '/autodiscover/autodiscover.xml', ...caso });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<ErrorCode>600<\/ErrorCode>/);
  }
});

test('el analizador XML no afecta a las demás rutas', async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'text/xml' },
    payload: '<login/>',
  });
  // Fuera del ámbito de Autodiscover, un cuerpo XML sigue siendo un tipo no admitido.
  assert.equal(res.statusCode, 415);
});

test('Autodiscover v2: JSON con la URL del Autodiscover POX', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/autodiscover/autodiscover.json?Email=ana%40cliente-a.test&Protocol=AutodiscoverV1',
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    Protocol: 'AutodiscoverV1',
    Url: 'https://autodiscover.cliente-a.test/autodiscover/autodiscover.xml',
  });

  const porRuta = await ctx.app.inject({
    method: 'GET',
    url: '/autodiscover/autodiscover.json/v1.0/ana@cliente-a.test?Protocol=AutodiscoverV1',
  });
  assert.equal(porRuta.statusCode, 200);
  assert.equal(
    (porRuta.json() as { Url: string }).Url,
    'https://autodiscover.cliente-a.test/autodiscover/autodiscover.xml',
  );
});

test('Autodiscover v2: si solo el host de la instancia apunta aquí, se anuncia ese', async () => {
  setJsonSetting(AUTOCONFIG_HOSTS_SETTING, { 'autodiscover.proveedor.test': record('ok') });
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/Autodiscover/Autodiscover.json?Email=ana%40cliente-a.test&Protocol=AutodiscoverV1',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(
    (res.json() as { Url: string }).Url,
    'https://autodiscover.proveedor.test/autodiscover/autodiscover.xml',
  );
});

test('Autodiscover v2: dominio ajeno 404 y protocolo no admitido 400', async () => {
  const ajeno = await ctx.app.inject({
    method: 'GET',
    url: '/autodiscover/autodiscover.json?Email=x%40ajeno.test&Protocol=AutodiscoverV1',
  });
  assert.equal(ajeno.statusCode, 404);
  const ews = await ctx.app.inject({
    method: 'GET',
    url: '/autodiscover/autodiscover.json?Email=ana%40cliente-a.test&Protocol=Ews',
  });
  assert.equal(ews.statusCode, 400);
  assert.equal((ews.json() as { ErrorCode: string }).ErrorCode, 'InvalidProtocol');
});

/* --------------------------------- MTA-STS -------------------------------- */

test('MTA-STS: política en texto plano con CRLF para mta-sts.<dominio>', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/.well-known/mta-sts.txt',
    headers: { host: 'mta-sts.cliente-a.test' },
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /^text\/plain/);
  assert.equal(
    res.body,
    'version: STSv1\r\nmode: testing\r\nmx: mail.proveedor.test\r\nmax_age: 86400\r\n',
  );
});

test('MTA-STS: 404 para dominios ajenos y para hosts que no son mta-sts', async () => {
  for (const host of ['mta-sts.ajeno.test', 'panel.proveedor.test', 'cliente-a.test']) {
    const res = await ctx.app.inject({ method: 'GET', url: '/.well-known/mta-sts.txt', headers: { host } });
    assert.equal(res.statusCode, 404, host);
  }
});

/* ------------------------------ Perfil de Apple ---------------------------- */

test('perfil de Apple: exige sesión y acceso al cliente del buzón', async () => {
  const anon = await ctx.app.inject({ method: 'GET', url: `/api/mailboxes/${mailbox.mailboxId}/mobileconfig` });
  assert.equal(anon.statusCode, 401);
  const otro = await ctx.app.inject({
    method: 'GET',
    url: `/api/mailboxes/${mailbox.mailboxId}/mobileconfig`,
    headers: { cookie: clientB.userCookie! },
  });
  assert.equal(otro.statusCode, 403);
});

test('perfil de Apple: descarga como adjunto, sin contraseña', async () => {
  for (const cookie of [clientA.userCookie!, ctx.adminCookie]) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/mailboxes/${mailbox.mailboxId}/mobileconfig`,
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/x-apple-aspen-config');
    assert.equal(
      res.headers['content-disposition'],
      'attachment; filename="correo-ana_cliente-a.test.mobileconfig"',
    );
    assert.match(res.body, /<string>ana@cliente-a\.test<\/string>/);
    assert.match(res.body, /<string>mail\.proveedor\.test<\/string>/);
    assert.doesNotMatch(res.body, /<key>IncomingPassword<\/key>/);
  }
});

test('perfil de Apple: buzón inexistente 404', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/api/mailboxes/mbx_noexiste/mobileconfig',
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(res.statusCode, 404);
});

/* ---------------------------- Datos de conexión ---------------------------- */

test('datos de conexión: forma completa y URL de respaldo en el panel', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/mailboxes/${mailbox.mailboxId}/connection`,
    headers: { cookie: clientA.userCookie! },
  });
  assert.equal(res.statusCode, 200);
  const info = res.json() as Record<string, unknown>;
  assert.deepEqual(info, {
    email: 'ana@cliente-a.test',
    username: 'ana@cliente-a.test',
    imap: { host: MAIL_HOST, port: 993, security: 'SSL/TLS' },
    smtp: { host: MAIL_HOST, port: 465, security: 'SSL/TLS' },
    smtpAlt: { host: MAIL_HOST, port: 587, security: 'STARTTLS' },
    webmailUrl: 'https://webmail.proveedor.test',
    autoconfig: {
      // Sin DNS comprobado, el panel sirve las mismas rutas en su propio host.
      thunderbird: `${PANEL}/mail/config-v1.1.xml?emailaddress=ana%40cliente-a.test`,
      outlook: `${PANEL}/autodiscover/autodiscover.xml`,
      appleProfileUrl: `${PANEL}/api/mailboxes/${mailbox.mailboxId}/mobileconfig`,
    },
    portalUrl: `${PANEL}/mi-buzon`,
  });
});

test('datos de conexión: host propio si su DNS apunta aquí y webmail con la marca del cliente', async () => {
  setJsonSetting(AUTOCONFIG_HOSTS_SETTING, {
    'autoconfig.cliente-a.test': record('ok'),
    'autodiscover.proveedor.test': record('ok'),
  });
  db.prepare(
    `INSERT INTO client_domains (id, client_id, hostname, kind, status, activated_at, created_at)
     VALUES ('wld_conexion', ?, 'webmail.cliente-a.test', 'webmail', 'active', 1, 1)`,
  ).run(clientA.clientId);
  try {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/mailboxes/${mailbox.mailboxId}/connection`,
      headers: { cookie: ctx.adminCookie },
    });
    const info = res.json() as { webmailUrl: string; autoconfig: { thunderbird: string; outlook: string } };
    assert.equal(info.webmailUrl, 'https://webmail.cliente-a.test');
    assert.equal(
      info.autoconfig.thunderbird,
      'https://autoconfig.cliente-a.test/mail/config-v1.1.xml?emailaddress=ana%40cliente-a.test',
    );
    assert.equal(info.autoconfig.outlook, 'https://autodiscover.proveedor.test/autodiscover/autodiscover.xml');
  } finally {
    db.prepare(`DELETE FROM client_domains WHERE id = 'wld_conexion'`).run();
  }
});

test('datos de conexión: otro cliente no puede leerlos', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/mailboxes/${mailbox.mailboxId}/connection`,
    headers: { cookie: clientB.userCookie! },
  });
  assert.equal(res.statusCode, 403);
});

test('panel del cliente sin clientId (administrador) es 400, no 200 con error', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/api/dashboard/client',
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { code: string }).code, 'client_required');
});

/* ----------------------- Estado DNS de los hosts --------------------------- */

test('sin red, la comprobación conserva los estados conocidos y no inventa ninguno', async () => {
  setJsonSetting(AUTOCONFIG_HOSTS_SETTING, {
    'autoconfig.cliente-a.test': record('ok'),
    'autodiscover.cliente-a.test': record('pending'),
    'autoconfig.dominio-borrado.test': record('ok'),
  });
  const summary = await refreshAutoconfigHosts();
  const states = readAutoconfigHostStates();
  assert.equal(states['autoconfig.cliente-a.test']!.state, 'ok', 'un corte de red no retira la ruta');
  assert.equal(states['autoconfig.cliente-a.test']!.lastAttemptInconclusive, true);
  assert.equal(states['autodiscover.cliente-a.test']!.state, 'pending', 'ni la publica sin DNS');
  assert.equal(states['mta-sts.cliente-a.test']!.state, 'unknown');
  assert.equal(states['autoconfig.proveedor.test']!.state, 'unknown');
  assert.equal(states['autoconfig.dominio-borrado.test'], undefined, 'los hosts de dominios borrados se olvidan');
  assert.equal(summary.checked, 2 + 3 * 2, 'instancia (2) + 3 por dominio');
});

test('con respuesta, la comprobación cambia el estado; sin ella, lo mantiene', async () => {
  const check = async (host: string): Promise<HostCheck> =>
    host.startsWith('autoconfig.')
      ? { state: 'ok', detail: 'apunta aquí' }
      : { state: 'pending', detail: 'no existe' };
  const summary = await refreshAutoconfigHosts({ check });
  assert.equal(summary.ok, 3, 'autoconfig de la instancia y de los dos dominios');
  let states = readAutoconfigHostStates();
  assert.equal(states['autoconfig.cliente-b.test']!.state, 'ok');
  assert.equal(states['mta-sts.cliente-b.test']!.state, 'pending');

  await refreshAutoconfigHosts();
  states = readAutoconfigHostStates();
  assert.equal(states['autoconfig.cliente-b.test']!.state, 'ok');
  assert.equal(states['mta-sts.cliente-b.test']!.state, 'pending');
});

test('comprobar un solo dominio no toca los demás', async () => {
  setJsonSetting(AUTOCONFIG_HOSTS_SETTING, { 'autoconfig.cliente-b.test': record('pending') });
  const summary = await refreshAutoconfigForDomain('cliente-a.test', {
    check: async () => ({ state: 'ok', detail: 'apunta aquí' }),
  });
  assert.equal(summary.checked, 3);
  const states = readAutoconfigHostStates();
  assert.equal(states['mta-sts.cliente-a.test']!.state, 'ok');
  assert.equal(states['autoconfig.cliente-b.test']!.state, 'pending');
  assert.equal(states['autoconfig.proveedor.test'], undefined);
});

test('estado de la autoconfiguración: solo administradores, con los registros de la instancia', async () => {
  const cliente = await ctx.app.inject({
    method: 'GET',
    url: '/api/autoconfig/status',
    headers: { cookie: clientA.userCookie! },
  });
  assert.equal(cliente.statusCode, 403);

  setJsonSetting(AUTOCONFIG_HOSTS_SETTING, { 'autoconfig.cliente-a.test': record('ok') });
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/api/autoconfig/status',
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(res.statusCode, 200);
  const status = res.json() as {
    routingAvailable: boolean;
    instance: { base: string; hosts: { host: string; state: string }[] };
    domains: { domain: string; hosts: { host: string; state: string; routed: boolean }[] }[];
    records: { type: string; name: string; value: string }[];
  };
  assert.equal(status.routingAvailable, false, 'en las pruebas no hay contenedor del panel');
  assert.equal(status.instance.base, 'proveedor.test');
  assert.deepEqual(
    status.records.map((r) => `${r.type} ${r.name} ${r.value}`),
    [
      'CNAME autoconfig.proveedor.test mail.proveedor.test.',
      'CNAME autodiscover.proveedor.test mail.proveedor.test.',
    ],
  );
  const a = status.domains.find((d) => d.domain === 'cliente-a.test')!;
  const host = a.hosts.find((h) => h.host === 'autoconfig.cliente-a.test')!;
  assert.equal(host.state, 'ok');
  assert.equal(host.routed, false, 'sin contenedor del panel no se enruta');

  const refresh = await ctx.app.inject({
    method: 'POST',
    url: '/api/autoconfig/refresh',
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(refresh.statusCode, 200);
  assert.equal((refresh.json() as { summary: { checked: number } }).summary.checked, 8);
});
