import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { upstream } from '../src/core/errors';
import { getEngine } from '../src/engine';
import { checkDomainDns, spfCubre } from '../src/modules/deliverability';
import { normalizeDomain, type DomainRecord } from '../src/modules/domains';
import { intervaloDeMedicion } from '../src/modules/watchdog';
import type { EngineDnsRecord } from '../src/engine/types';
import { adminContext, createClient, createDomain, createMailbox, type TestContext } from './helpers';

let ctx: TestContext;

before(async () => {
  ctx = await adminContext();
});

/* ----------------------------- Nombre del dominio ------------------------- */

test('los dominios con «ñ» se guardan en punycode y se muestran en Unicode', async () => {
  const { clientId } = await createClient(ctx);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/domains',
    headers: { cookie: ctx.adminCookie },
    payload: { domain: 'Panadería-Ñandú.es', clientId },
  });
  assert.equal(res.statusCode, 200, res.body);
  const { domain } = res.json() as { domain: DomainRecord; cloudflare: unknown };
  assert.equal(domain.domain, 'xn--panadera-and-yfb2d0h.es');
  assert.equal(domain.domainUnicode, 'panadería-ñandú.es');
  assert.equal(domain.cloudflare, null, 'sin Cloudflare, el campo existe y vale null');
  assert.equal((res.json() as { cloudflare: unknown }).cloudflare, null);
});

test('se aceptan TLD internacionalizados y se limpian URL y punto final', () => {
  assert.equal(normalizeDomain('ejemplo.xn--p1ai'), 'ejemplo.xn--p1ai');
  assert.equal(normalizeDomain('пример.рф'), 'xn--e1afmkfd.xn--p1ai');
  assert.equal(normalizeDomain('https://Ejemplo.COM/contacto'), 'ejemplo.com');
  assert.equal(normalizeDomain('ejemplo.com.'), 'ejemplo.com');
});

test('un dominio no válido se rechaza con un mensaje claro', async () => {
  for (const malo of ['sin-punto', 'a..b.com', '-empieza.com', 'ejemplo.c', 'espacio en.com']) {
    assert.throws(() => normalizeDomain(malo), /no es válido/, malo);
  }
  const { clientId } = await createClient(ctx);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/domains',
    headers: { cookie: ctx.adminCookie },
    payload: { domain: 'no valido', clientId },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /Introdúzcalo/);
});

/* ---------------------------------- Borrado -------------------------------- */

test('si el motor falla al borrar un buzón, se informa y el panel refleja lo que queda', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId, domain } = await createDomain(ctx, clientId, 'borrado-parcial.es');
  const a = await createMailbox(ctx, domainId, 'ana');
  const b = await createMailbox(ctx, domainId, 'bea');

  const engine = getEngine();
  const original = engine.deleteMailbox.bind(engine);
  engine.deleteMailbox = async (email: string) => {
    if (email === b.email) throw upstream('El motor de correo no responde.', 'engine_unreachable');
    return original(email);
  };
  try {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/domains/${domainId}?confirm=${domain}`,
      headers: { cookie: ctx.adminCookie },
    });
    assert.equal(res.statusCode, 502);
    const cuerpo = res.json() as { error: string; code: string };
    assert.equal(cuerpo.code, 'partial_delete');
    assert.match(cuerpo.error, /bea@borrado-parcial\.es/);

    const restantes = db.prepare('SELECT local_part FROM mailboxes WHERE domain_id = ?').all(domainId) as {
      local_part: string;
    }[];
    assert.deepEqual(restantes.map((r) => r.local_part), ['bea'], 'el buzón borrado en el motor desaparece del panel');
    assert.ok(db.prepare('SELECT 1 FROM domains WHERE id = ?').get(domainId), 'el dominio sigue mientras le quede algo');
    assert.ok(a.mailboxId);
  } finally {
    engine.deleteMailbox = original;
  }

  const reintento = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/domains/${domainId}?confirm=${domain}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(reintento.statusCode, 200, reintento.body);
  assert.deepEqual(reintento.json(), { ok: true });
  assert.equal(db.prepare('SELECT 1 FROM domains WHERE id = ?').get(domainId), undefined);
});

test('borrar un dominio con buzones exige confirmarlo escribiendo su nombre', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId, 'confirmar.es');
  await createMailbox(ctx, domainId);
  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/domains/${domainId}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(res.statusCode, 409);
  assert.equal((res.json() as { code: string }).code, 'needs_confirmation');
});

/* -------------------------------- Verificación ---------------------------- */

test('la verificación automática (sondeo) no llena la actividad', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId, 'sondeo.es');
  const contar = () =>
    (
      db
        .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'domain.verified' AND detail LIKE ?")
        .get(`%${domainId}%`) as { c: number }
    ).c;
  for (let i = 0; i < 3; i++) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/domains/${domainId}/verify?auto=1`,
      headers: { cookie: ctx.adminCookie },
    });
    assert.equal(res.statusCode, 200);
  }
  assert.equal(contar(), 0);
  await ctx.app.inject({ method: 'POST', url: `/api/domains/${domainId}/verify`, headers: { cookie: ctx.adminCookie } });
  assert.equal(contar(), 1);
});

test('la comprobación DNS solo mide los registros seleccionados', async () => {
  const d = 'medir.es';
  const records: EngineDnsRecord[] = [
    { type: 'MX', name: `${d}.`, content: '10 mail.servidor.es.' },
    { type: 'TXT', name: `${d}.`, content: 'v=spf1 mx ra=postmaster -all' },
    { type: 'SRV', name: `_imap._tcp.${d}.`, content: '0 1 143 mail.servidor.es.' },
    { type: 'SRV', name: `_pop3s._tcp.${d}.`, content: '0 1 995 mail.servidor.es.' },
    { type: 'SRV', name: `_imaps._tcp.${d}.`, content: '0 1 993 mail.servidor.es.' },
    { type: 'TLSA', name: `_25._tcp.mail.${d}.`, content: '3 1 1 abc' },
    { type: 'TXT', name: 'mail.servidor.es.', content: 'v=spf1 a -all' },
  ];
  const informe = await checkDomainDns(d, records);
  const nombres = informe.checks.map((c) => c.name);
  assert.deepEqual(nombres.sort(), [d, d, `_imaps._tcp.${d}`].sort());
  assert.equal(informe.requiredTotal, 2);
  assert.ok(informe.checks.every((c) => !c.name.endsWith('.')));
  // Sin red, nada se da por bueno ni por malo.
  assert.ok(informe.checks.every((c) => c.status === 'unknown'));
});

test('GET /dns devuelve la misma selección, marcando lo obligatorio', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId, domain } = await createDomain(ctx, clientId, 'registros.es');
  const res = await ctx.app.inject({ method: 'GET', url: `/api/domains/${domainId}/dns`, headers: { cookie: ctx.adminCookie } });
  assert.equal(res.statusCode, 200);
  const { records } = res.json() as { records: { type: string; name: string; content: string; required: boolean; category: string }[] };
  assert.ok(records.length > 0);
  const mx = records.find((r) => r.type === 'MX')!;
  assert.equal(mx.name, domain);
  assert.equal(mx.content, `10 mail.${domain}`);
  assert.equal(mx.required, true);
  assert.equal(mx.category, 'obligatorio');
});

test('un SPF propio vale si incluye los mecanismos que pide el motor', () => {
  assert.equal(spfCubre('v=spf1 include:_spf.google.com mx ~all', 'v=spf1 mx ra=postmaster -all'), true);
  assert.equal(spfCubre('v=spf1 +mx -all', 'v=spf1 mx -all'), true);
  assert.equal(
    spfCubre('v=spf1 include:_spf.mx.cloudflare.net ~all', 'v=spf1 mx -all'),
    false,
    'contener «mx» dentro de otro mecanismo no cuenta',
  );
});

/* ------------------------------- Vigilante -------------------------------- */

test('el vigilante mide cada 10 minutos lo pendiente reciente y cada hora el resto', () => {
  const ahora = Date.UTC(2026, 8, 27, 12);
  const minuto = 60_000;
  const hora = 60 * minuto;
  const dia = 24 * hora;
  const base = { status: 'pending_dns', createdAt: ahora - 30 * dia, dnsAppliedAt: null } as unknown as DomainRecord;

  assert.equal(intervaloDeMedicion({ ...base, dnsAppliedAt: ahora - 2 * hora }, ahora), 10 * minuto);
  assert.equal(intervaloDeMedicion({ ...base, dnsAppliedAt: ahora - 3 * dia }, ahora), hora);
  assert.equal(intervaloDeMedicion({ ...base, createdAt: ahora - 2 * dia }, ahora), 10 * minuto);
  assert.equal(intervaloDeMedicion(base, ahora), hora);
  assert.equal(
    intervaloDeMedicion({ ...base, status: 'active', dnsAppliedAt: ahora - minuto }, ahora),
    hora,
    'un dominio en reparto no necesita medirse cada 10 minutos',
  );
});
