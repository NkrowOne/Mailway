import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { upstream } from '../src/core/errors';
import { getEngine } from '../src/engine';
import { fireAlert } from '../src/modules/alerts';
import { spfCubre } from '../src/core/mailauth';
import { checkDomainDns, veredictoMx } from '../src/modules/deliverability';
import {
  evaluarPropiedad,
  getDomain,
  normalizeDomain,
  ownershipRecord,
  refreshDomainDns,
  sinWwwSugerido,
  type DomainRecord,
} from '../src/modules/domains';
import { intervaloDeMedicion } from '../src/modules/watchdog';
import type { EngineDnsRecord } from '../src/engine/types';
import { adminContext, createClient, createDomain, createMailbox, type TestContext } from './helpers';
import { instalarDnsFalso } from './dns-falso';

let ctx: TestContext;

before(async () => {
  ctx = await adminContext();
});

/**
 * Dominio con la propiedad ya comprobada. Sin red, la comprobación real
 * nunca la da por buena: createDomain la fija en la base, como haría una
 * medición con el MX o el TXT de verificación publicados.
 */
function dominioPropio(clientId: string, nombre: string): Promise<{ domainId: string; domain: string }> {
  return createDomain(ctx, clientId, nombre, { ownershipVerified: true });
}

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

test('un dominio que empieza por «www.» se pregunta antes de darlo de alta', async () => {
  const { clientId } = await createClient(ctx);
  const alta = (payload: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: '/api/domains', headers: { cookie: ctx.adminCookie }, payload: { clientId, ...payload } });
  const res = await alta({ domain: 'https://www.Panadería-Sol.com.es/contacto' });
  assert.equal(res.statusCode, 409, res.body);
  const cuerpo = res.json() as { error: string; code: string };
  assert.equal(cuerpo.code, 'domain_www');
  assert.match(cuerpo.error, /¿Querías decir panadería-sol\.com\.es\?/);
  assert.equal(db.prepare("SELECT 1 FROM domains WHERE domain LIKE 'www.%'").get(), undefined, 'no se crea nada');

  // Confirmado, el subdominio es legítimo.
  const confirmado = await alta({ domain: 'www.correo-en-www.es', confirmWww: true });
  assert.equal(confirmado.statusCode, 200, confirmado.body);
  assert.equal((confirmado.json() as { domain: DomainRecord }).domain.domain, 'www.correo-en-www.es');
  // «www.es» no tiene otra lectura: no se pregunta.
  assert.equal(sinWwwSugerido('www.es'), null);
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
  assert.match((res.json() as { error: string }).error, /Introdúcelo/);
});

/* ---------------------------------- Borrado -------------------------------- */

test('si el motor falla al borrar un buzón, se informa y el panel refleja lo que queda', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId, domain } = await dominioPropio(clientId, 'borrado-parcial.es');
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
  assert.equal((reintento.json() as { ok: boolean }).ok, true);
  assert.equal(db.prepare('SELECT 1 FROM domains WHERE id = ?').get(domainId), undefined);
});

test('borrar un dominio con buzones exige confirmarlo escribiendo su nombre', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await dominioPropio(clientId, 'confirmar.es');
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
  const medidos = informe.checks.filter((c) => !c.engineMissing);
  assert.deepEqual(medidos.map((c) => c.name).sort(), [d, d, `_imaps._tcp.${d}`].sort());
  assert.ok(informe.checks.every((c) => !c.name.endsWith('.')));
  // Sin red, nada de lo que se mide se da por bueno ni por malo.
  assert.ok(medidos.every((c) => c.status === 'unknown'));
  // El motor no ha devuelto DKIM ni DMARC: constan como pendientes, no se omiten.
  assert.deepEqual(
    informe.checks.filter((c) => c.engineMissing).map((c) => c.id).sort(),
    ['motor:dkim', 'motor:dmarc'],
  );
  assert.equal(informe.requiredTotal, 4);
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
    'un dominio activo no necesita medirse cada 10 minutos',
  );
});

/* ------------------------------ Propiedad --------------------------------- */

test('un dominio nuevo tiene la propiedad pendiente y expone su TXT de verificación', async () => {
  const { clientId } = await createClient(ctx);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/domains',
    headers: { cookie: ctx.adminCookie },
    payload: { domain: 'propiedad-nueva.es', clientId },
  });
  assert.equal(res.statusCode, 200, res.body);
  const { domain } = res.json() as { domain: DomainRecord };
  assert.equal(domain.ownershipVerifiedAt, null);
  assert.equal(domain.ownershipRecord.type, 'TXT');
  assert.equal(domain.ownershipRecord.name, '_mailway.propiedad-nueva.es');
  assert.match(domain.ownershipRecord.content, /^mailway-verificacion=[0-9a-f]{32}$/);
  assert.deepEqual(domain.ownershipRecord, ownershipRecord('propiedad-nueva.es'));
  // Estable y distinto por dominio: no se guarda, se deriva del secreto.
  assert.notEqual(ownershipRecord('otro.es').content, domain.ownershipRecord.content);

  // Sin red no se puede probar nada: sigue pendiente tras medir.
  const medido = await refreshDomainDns(domain.id);
  assert.equal(medido.ownershipVerifiedAt, null);
});

test('«Verificar» distingue un TXT que no está de un DNS que no se pudo consultar', async (t) => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId, 'verificar-txt.es', { ownershipVerified: false });
  const verificar = async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/domains/${domainId}/verify`,
      headers: { cookie: ctx.adminCookie },
    });
    assert.equal(res.statusCode, 200, res.body);
    return (res.json() as { ownershipCheck: boolean | null }).ownershipCheck;
  };
  // Sin red: no se sabe, y la ficha no debe decir que el TXT no está.
  assert.equal(await verificar(), null);
  // Con DNS que responde y sin el TXT: ahora sí, no se encuentra.
  instalarDnsFalso(t, { mx: { 'verificar-txt.es': [{ priority: 10, exchange: 'mx.otro.test' }] } });
  assert.equal(await verificar(), false);
});

test('la propiedad probada se conserva aunque el DNS deje de verse', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await dominioPropio(clientId, 'propiedad-fija.es');
  const antes = getDomain(domainId).ownershipVerifiedAt;
  assert.ok(antes);
  const medido = await refreshDomainDns(domainId);
  assert.equal(medido.ownershipVerifiedAt, antes, 'una medición sin datos no la borra');
});

test('la propiedad se prueba con el MX a este servidor o con el TXT, y un corte no es un «no»', () => {
  const esperado = ownershipRecord('prueba.es').content;
  const hosts = ['mail.proveedor.es'];
  const google = [{ priority: 1, exchange: 'smtp.google.com' }];
  assert.equal(
    evaluarPropiedad({ mx: [{ priority: 20, exchange: 'mail.proveedor.es.' }], txt: [], hosts, esperado }),
    true,
    'cualquier prioridad vale: quien pone el MX controla el dominio',
  );
  assert.equal(evaluarPropiedad({ mx: google, txt: [esperado], hosts, esperado }), true);
  assert.equal(
    evaluarPropiedad({ mx: [], txt: [`"${esperado.slice(0, 20)}" "${esperado.slice(20)}"`], hosts, esperado }),
    true,
    'un TXT troceado también cuenta',
  );
  assert.equal(evaluarPropiedad({ mx: google, txt: [], hosts, esperado }), false);
  assert.equal(
    evaluarPropiedad({ mx: [], txt: ['mailway-verificacion=00000000000000000000000000000000'], hosts, esperado }),
    false,
    'un token ajeno no prueba nada',
  );
  assert.equal(evaluarPropiedad({ mx: null, txt: [], hosts, esperado }), null);
  assert.equal(evaluarPropiedad({ mx: [], txt: null, hosts, esperado }), null);
  assert.equal(evaluarPropiedad({ mx: null, txt: [esperado], hosts, esperado }), true);
  assert.equal(
    evaluarPropiedad({ mx: [{ priority: 10, exchange: 'mail.proveedor.es' }], txt: [], hosts: [], esperado }),
    false,
  );
});

test('el TXT de verificación va en la tabla de registros y en el fichero de zona recomendado', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId, domain } = await createDomain(ctx, clientId, 'zona-propiedad.es');
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/domains/${domainId}/dns`,
    headers: { cookie: ctx.adminCookie },
  });
  const { records } = res.json() as {
    records: { type: string; name: string; content: string; required: boolean; category: string }[];
  };
  const txt = records.find((r) => r.name === `_mailway.${domain}`);
  assert.ok(txt, 'la tabla incluye el TXT de verificación');
  assert.equal(txt.type, 'TXT');
  assert.equal(txt.required, false);
  assert.equal(txt.category, 'verificacion');
  assert.equal(txt.content, ownershipRecord(domain).content);

  const recomendado = await ctx.app.inject({
    method: 'GET',
    url: `/api/domains/${domainId}/zonefile?nivel=recomendados`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.ok(
    recomendado.body.includes(`_mailway.${domain}.\t3600\tIN\tTXT\t"${ownershipRecord(domain).content}"`),
    recomendado.body,
  );
  const minimo = await ctx.app.inject({
    method: 'GET',
    url: `/api/domains/${domainId}/zonefile?nivel=obligatorios`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.ok(!minimo.body.includes('mailway-verificacion='), 'lo obligatorio no lo necesita: el MX ya prueba la propiedad');
});

/* ----------------------------- Alta concurrente --------------------------- */

test('si el INSERT choca con otra alta del mismo dominio: 409 y el dominio del motor no se toca', async () => {
  const a = await createClient(ctx);
  const b = await createClient(ctx);
  const engine = getEngine();
  const dkim = engine.ensureDkim.bind(engine);
  const borrar = engine.deleteDomain.bind(engine);
  const borrados: string[] = [];
  // Simula la otra alta: mientras esta espera al motor (las claves DKIM),
  // otra fila con el mismo dominio llega a la base (lo que el cerrojo evita
  // en un proceso).
  engine.ensureDkim = async (domain: string, selector: string) => {
    db.prepare('INSERT INTO domains (id, client_id, domain, created_at) VALUES (?, ?, ?, ?)').run(
      'dom_carrera',
      b.clientId,
      domain,
      Date.now(),
    );
    return dkim(domain, selector);
  };
  engine.deleteDomain = async (domain: string) => {
    borrados.push(domain);
    return borrar(domain);
  };
  try {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/domains',
      headers: { cookie: ctx.adminCookie },
      payload: { domain: 'carrera.es', clientId: a.clientId },
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((res.json() as { code: string }).code, 'domain_exists');
    assert.deepEqual(borrados, [], 'el dominio del motor es el de la otra alta: no se borra');
    const fila = db.prepare('SELECT client_id FROM domains WHERE domain = ?').get('carrera.es') as { client_id: string };
    assert.equal(fila.client_id, b.clientId);
  } finally {
    engine.ensureDkim = dkim;
    engine.deleteDomain = borrar;
  }
});

/* ---------------------- El motor y la propiedad del dominio ---------------------- */

/**
 * El alta crea el dominio en el motor, como en la 1.4: con Stalwart 0.16 sus
 * claves DKIM y los registros que hay que publicar (con los que se comprueba
 * la propiedad) solo existen así. Sin la propiedad comprobada no se crean
 * buzones ni alias, y cada uno vuelve a asegurar el dominio en el motor.
 */
test('el alta crea el dominio en el motor; buzones y alias exigen la propiedad y lo vuelven a asegurar', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const engine = getEngine();
  const crear = engine.createDomain.bind(engine);
  const creados: string[] = [];
  engine.createDomain = async (domain: string) => {
    creados.push(domain);
    return crear(domain);
  };
  try {
    const alta = await ctx.app.inject({
      method: 'POST',
      url: '/api/domains',
      headers: { cookie: cliente.userCookie! },
      payload: { domain: 'gmail.com' },
    });
    assert.equal(alta.statusCode, 200, alta.body);
    const { domain } = alta.json() as { domain: DomainRecord };
    assert.equal(domain.ownershipVerifiedAt, null);
    assert.deepEqual(creados, ['gmail.com'], 'el alta crea el dominio en el motor');

    // Sin propiedad, ni buzones ni alias: el motor sigue sin recibir nada.
    const buzon = await ctx.app.inject({
      method: 'POST',
      url: '/api/mailboxes',
      headers: { cookie: cliente.userCookie! },
      payload: { domainId: domain.id, localPart: 'ana' },
    });
    assert.equal(buzon.statusCode, 409);
    assert.deepEqual(creados, ['gmail.com']);

    // Con la propiedad comprobada, el primer buzón lo vuelve a asegurar (idempotente).
    db.prepare('UPDATE domains SET owner_verified_at = ? WHERE id = ?').run(Date.now(), domain.id);
    const ana = await ctx.app.inject({
      method: 'POST',
      url: '/api/mailboxes',
      headers: { cookie: cliente.userCookie! },
      payload: { domainId: domain.id, localPart: 'ana' },
    });
    assert.equal(ana.statusCode, 200, ana.body);
    assert.deepEqual(creados, ['gmail.com', 'gmail.com']);

    // Un alias también lo asegura (es idempotente en el motor).
    const alias = await ctx.app.inject({
      method: 'POST',
      url: '/api/aliases',
      headers: { cookie: cliente.userCookie! },
      payload: { domainId: domain.id, localPart: 'info', destinations: ['ana@gmail.com'] },
    });
    assert.equal(alias.statusCode, 200, alias.body);
    assert.deepEqual(creados, ['gmail.com', 'gmail.com', 'gmail.com']);
  } finally {
    engine.createDomain = crear;
  }
});

test('un dominio ajeno dado de alta sin probar la propiedad no impide a otros clientes reenviar a él', async () => {
  const intruso = await createClient(ctx, { withUser: true });
  const otro = await createClient(ctx, { withUser: true });
  db.prepare('UPDATE plans SET max_domains = 10, max_aliases = 10 WHERE id = ?').run(intruso.planId);
  const alta = await ctx.app.inject({
    method: 'POST',
    url: '/api/domains',
    headers: { cookie: intruso.userCookie! },
    payload: { domain: 'correo-ajeno.es' },
  });
  assert.equal(alta.statusCode, 200, alta.body);
  const ajeno = (alta.json() as { domain: DomainRecord }).domain;
  assert.equal(ajeno.ownershipVerifiedAt, null);

  const propio = await dominioPropio(otro.clientId, 'empresa-reenvio.es');
  const engine = getEngine();
  const upsert = engine.upsertAlias.bind(engine);
  const llamadas: { internos: string[]; externos: string[] }[] = [];
  engine.upsertAlias = async (a: string, internos: string[], externos: string[] = []) => {
    llamadas.push({ internos, externos });
    return upsert(a, internos, externos);
  };
  try {
    const alias = await ctx.app.inject({
      method: 'POST',
      url: '/api/aliases',
      headers: { cookie: otro.userCookie! },
      payload: { domainId: propio.domainId, localPart: 'info', destinations: ['dueno@correo-ajeno.es'] },
    });
    assert.equal(alias.statusCode, 200, alias.body);
    assert.deepEqual(llamadas, [{ internos: [], externos: ['dueno@correo-ajeno.es'] }], 'sale a Internet como externo');
    // Tampoco el propio intruso queda atado: para él también es externo.
    const suyo = await dominioPropio(intruso.clientId, 'intruso-propio.es');
    const delIntruso = await ctx.app.inject({
      method: 'POST',
      url: '/api/aliases',
      headers: { cookie: intruso.userCookie! },
      payload: { domainId: suyo.domainId, localPart: 'info', destinations: ['dueno@correo-ajeno.es'] },
    });
    assert.equal(delIntruso.statusCode, 200, delIntruso.body);

    // Borrarlo después no se lleva los reenvíos de los demás: no eran buzones de aquí.
    const baja = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/domains/${ajeno.id}`,
      headers: { cookie: intruso.userCookie! },
    });
    assert.equal(baja.statusCode, 200, baja.body);
    const cuerpo = baja.json() as { aliasesUpdated: string[]; aliasesDeleted: string[] };
    assert.deepEqual(cuerpo.aliasesUpdated, []);
    assert.deepEqual(cuerpo.aliasesDeleted, []);
    const destinos = db
      .prepare('SELECT destinations_json FROM aliases WHERE id = ?')
      .get((alias.json() as { id: string }).id) as { destinations_json: string };
    assert.deepEqual(JSON.parse(destinos.destinations_json), ['dueno@correo-ajeno.es']);
  } finally {
    engine.upsertAlias = upsert;
  }
});

/* ------------------------- Borrado: alias y claves ------------------------ */

test('borrar un dominio actualiza los alias de otros dominios, cuenta las claves y cierra su alerta', async () => {
  const { clientId, planId } = await createClient(ctx);
  db.prepare('UPDATE plans SET max_domains = 10 WHERE id = ?').run(planId);
  const origen = await dominioPropio(clientId, 'se-borra.es');
  const destino = await dominioPropio(clientId, 'se-queda.es');
  const ana = await createMailbox(ctx, origen.domainId, 'ana');
  const bea = await createMailbox(ctx, destino.domainId, 'bea');

  // Alias de OTRO dominio que reenvían a un buzón del dominio que se borra.
  const alias = (id: string, local: string, destinos: string[]) =>
    db
      .prepare('INSERT INTO aliases (id, domain_id, local_part, destinations_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, destino.domainId, local, JSON.stringify(destinos), Date.now());
  alias('ali_mixto', 'ventas', [ana.email, bea.email, 'fuera@externo.test']);
  alias('ali_solo', 'avisos', [ana.email]);

  db.prepare(
    `INSERT INTO api_keys (id, client_id, name, prefix, key_hash, sender_mailbox_id, smtp_password_enc, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('key_borrado', clientId, 'Tienda', 'mw_pruebaborr', 'x', ana.mailboxId, 'x', Date.now());

  fireAlert({
    severity: 'critical',
    type: 'domain_dns_broken',
    dedupeKey: `domain_dns:${origen.domainId}`,
    clientId,
    title: 'Prueba',
    message: 'Prueba',
    quiet: true,
  });

  const engine = getEngine();
  const upsert = engine.upsertAlias.bind(engine);
  const llamadas: { alias: string; internos: string[]; externos: string[] }[] = [];
  engine.upsertAlias = async (a: string, internos: string[], externos: string[] = []) => {
    llamadas.push({ alias: a, internos, externos });
    return upsert(a, internos, externos);
  };
  try {
    const sinConfirmar = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/domains/${origen.domainId}`,
      headers: { cookie: ctx.adminCookie },
    });
    assert.equal(sinConfirmar.statusCode, 409);
    assert.match((sinConfirmar.json() as { error: string }).error, /1 clave de API/);

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/domains/${origen.domainId}?confirm=${origen.domain}`,
      headers: { cookie: ctx.adminCookie },
    });
    assert.equal(res.statusCode, 200, res.body);
    const cuerpo = res.json() as { apiKeysRevoked: number; aliasesUpdated: string[]; aliasesDeleted: string[] };
    assert.equal(cuerpo.apiKeysRevoked, 1);
    assert.deepEqual(cuerpo.aliasesUpdated, ['ventas@se-queda.es']);
    assert.deepEqual(cuerpo.aliasesDeleted, ['avisos@se-queda.es']);
  } finally {
    engine.upsertAlias = upsert;
  }

  assert.deepEqual(llamadas, [
    { alias: 'ventas@se-queda.es', internos: [bea.email], externos: ['fuera@externo.test'] },
  ]);
  const ventas = db.prepare('SELECT destinations_json FROM aliases WHERE id = ?').get('ali_mixto') as {
    destinations_json: string;
  };
  assert.deepEqual(JSON.parse(ventas.destinations_json), [bea.email, 'fuera@externo.test']);
  assert.equal(db.prepare('SELECT 1 FROM aliases WHERE id = ?').get('ali_solo'), undefined, 'sin destinos, el alias se elimina');
  assert.equal(db.prepare('SELECT 1 FROM api_keys WHERE id = ?').get('key_borrado'), undefined);
  const abiertas = db
    .prepare('SELECT COUNT(*) AS c FROM alerts WHERE dedupe_key = ? AND resolved_at IS NULL')
    .get(`domain_dns:${origen.domainId}`) as { c: number };
  assert.equal(abiertas.c, 0, 'la alerta del dominio borrado se cierra');
});

/* ------------------------------ Veredicto MX ------------------------------ */

test('un MX de otro proveedor con igual o mayor preferencia deja el MX fuera de rango', () => {
  const propio = 'mail.servidor.es';
  assert.deepEqual(veredictoMx([{ priority: 10, exchange: 'mail.servidor.es.' }], propio), {
    propio: true,
    ajenosPorDelante: [],
  });
  assert.deepEqual(
    veredictoMx(
      [
        { priority: 1, exchange: 'smtp.google.com' },
        { priority: 10, exchange: 'mail.servidor.es' },
      ],
      propio,
    ),
    { propio: true, ajenosPorDelante: ['smtp.google.com'] },
  );
  assert.deepEqual(
    veredictoMx(
      [
        { priority: 10, exchange: 'mail.servidor.es' },
        { priority: 10, exchange: 'mx.otro.es' },
      ],
      propio,
    ).ajenosPorDelante,
    ['mx.otro.es'],
    'con la misma prioridad se reparten el correo',
  );
  assert.deepEqual(
    veredictoMx(
      [
        { priority: 10, exchange: 'mail.servidor.es' },
        { priority: 50, exchange: 'respaldo.otro.es' },
      ],
      propio,
    ),
    { propio: true, ajenosPorDelante: [] },
    'un respaldo con menor preferencia no impide recibir aquí',
  );
  assert.equal(veredictoMx([{ priority: 1, exchange: 'smtp.google.com' }], propio).propio, false);
});
