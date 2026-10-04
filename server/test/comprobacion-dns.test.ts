import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { lookupAaaa } from '../src/core/dns';
import { upstream } from '../src/core/errors';
import { getEngine } from '../src/engine';
import type { EngineDnsRecord } from '../src/engine/types';
import { checkDomainDns, checkServerHealth, evaluarIpv6, type DnsCheck } from '../src/modules/deliverability';
import { getDomain, refreshDomainDns } from '../src/modules/domains';
import { setInstanceSettings } from '../src/modules/settings';
import { instalarDnsFalso } from './dns-falso';
import { adminContext, createClient, createDomain, type TestContext } from './helpers';

/*
 * Comprobación DNS de un dominio contra respuestas DNS concretas (dns-falso):
 * lo que debe darse por bueno y lo que no, sin depender de Internet.
 */

const D = 'ejemplo.es';
const SERVIDOR = 'mail.servidor.es';
const DKIM = 'v=DKIM1; k=ed25519; h=sha256; p=CLAVEPUBLICA';

/** Lo que propone Stalwart 0.15.5 para el dominio (lo obligatorio y un SRV). */
const delMotor: EngineDnsRecord[] = [
  { type: 'MX', name: `${D}.`, content: `10 ${SERVIDOR}.` },
  { type: 'TXT', name: `${D}.`, content: 'v=spf1 mx ra=postmaster -all' },
  { type: 'TXT', name: `202610e._domainkey.${D}.`, content: DKIM },
  { type: 'TXT', name: `_dmarc.${D}.`, content: `v=DMARC1; p=reject; rua=mailto:postmaster@${D}` },
  { type: 'SRV', name: `_imaps._tcp.${D}.`, content: `0 1 993 ${SERVIDOR}.` },
];

/** DNS publicado que coincide con lo que pide el motor. */
const publicado = {
  mx: { [D]: [{ priority: 10, exchange: SERVIDOR }] },
  txt: {
    [D]: ['v=spf1 mx -all'],
    [`202610e._domainkey.${D}`]: [DKIM],
    [`_dmarc.${D}`]: ['v=DMARC1; p=reject'],
  },
  srv: { [`_imaps._tcp.${D}`]: [{ priority: 0, weight: 1, port: 993, name: SERVIDOR }] },
};

function medida(informe: { checks: DnsCheck[] }, id: string): DnsCheck {
  const check = informe.checks.find((c) => c.id === id);
  assert.ok(check, `falta la medida ${id}: ${informe.checks.map((c) => c.id).join(', ')}`);
  return check;
}

let ctx: TestContext;

before(async () => {
  ctx = await adminContext();
  setInstanceSettings({ mailHostname: SERVIDOR, publicIp: '203.0.113.10' });
});

/* ------------------------------------ MX ---------------------------------- */

test('un MX único vale con cualquier prioridad (0, 5, 20) y un segundo MX propio no lo estropea', async (t) => {
  for (const mx of [
    [{ priority: 0, exchange: SERVIDOR }],
    [{ priority: 5, exchange: `${SERVIDOR}.` }],
    [{ priority: 20, exchange: SERVIDOR }],
    [
      { priority: 10, exchange: SERVIDOR },
      { priority: 20, exchange: SERVIDOR },
    ],
    [
      { priority: 10, exchange: SERVIDOR },
      { priority: 50, exchange: 'respaldo.otro.es' },
    ],
  ]) {
    await t.test(JSON.stringify(mx), async (st) => {
      instalarDnsFalso(st, { ...publicado, mx: { [D]: mx } });
      const informe = await checkDomainDns(D, delMotor);
      assert.equal(medida(informe, `mx:${D}`).status, 'ok');
      assert.equal(informe.allRequiredOk, true);
    });
  }
});

test('un MX interno que anuncia el motor nunca está en rango, ni aunque el DNS coincida', async (t) => {
  const interno: EngineDnsRecord[] = delMotor.map((r) =>
    r.type === 'MX' ? { ...r, content: '10 3f2a1b4c5d6e.' } : r,
  );
  // Sin red (modo de las pruebas): el veredicto no depende del DNS.
  const sinRed = medida(await checkDomainDns(D, interno), `mx:${D}`);
  assert.equal(sinRed.status, 'mismatch');
  assert.equal(sinRed.found, null);
  assert.match(sinRed.help, /«3f2a1b4c5d6e».*nombre interno/);

  instalarDnsFalso(t, { ...publicado, mx: { [D]: [{ priority: 10, exchange: '3f2a1b4c5d6e' }] } });
  const informe = await checkDomainDns(D, interno);
  const mx = medida(informe, `mx:${D}`);
  assert.equal(mx.status, 'mismatch');
  assert.equal(mx.found, '10 3f2a1b4c5d6e');
  assert.equal(informe.allRequiredOk, false);
});

/* ------------------------------------ SRV --------------------------------- */

test('un SRV con peso 0 vale: se comparan destino y puerto', async (t) => {
  instalarDnsFalso(t, {
    ...publicado,
    srv: { [`_imaps._tcp.${D}`]: [{ priority: 0, weight: 0, port: 993, name: SERVIDOR }] },
  });
  assert.equal(medida(await checkDomainDns(D, delMotor), `srv:_imaps._tcp.${D}`).status, 'ok');
});

test('un SRV con otro puerto no vale', async (t) => {
  instalarDnsFalso(t, {
    ...publicado,
    srv: { [`_imaps._tcp.${D}`]: [{ priority: 0, weight: 1, port: 143, name: SERVIDOR }] },
  });
  assert.equal(medida(await checkDomainDns(D, delMotor), `srv:_imaps._tcp.${D}`).status, 'mismatch');
});

/* ------------------------------------ SPF --------------------------------- */

test('SPF: +mx y mx:dominio valen; «mx» detrás de «all» no, y la ficha dice por qué', async (t) => {
  const spf = async (valor: string) => {
    let resultado: DnsCheck | undefined;
    await t.test(valor, async (st) => {
      instalarDnsFalso(st, { ...publicado, txt: { ...publicado.txt, [D]: [valor] } });
      resultado = medida(await checkDomainDns(D, delMotor), `spf:${D}`);
    });
    return resultado!;
  };
  assert.equal((await spf('v=spf1 +mx -all')).status, 'ok');
  assert.equal((await spf(`v=spf1 mx:${D} ~all`)).status, 'ok');
  assert.equal((await spf('v=spf1 ip4:203.0.113.10 -all')).status, 'ok', 'la IP del servidor también lo autoriza');
  const detras = await spf('v=spf1 include:_spf.google.com -all mx');
  assert.equal(detras.status, 'mismatch');
  assert.match(detras.help, /detrás de «all»/);
  const sinMx = await spf('v=spf1 include:_spf.google.com ~all');
  assert.equal(sinMx.status, 'mismatch');
  assert.match(sinMx.help, /Sustitúyelo por el valor indicado, que añade «a:mail\.servidor\.es» delante de «all»/);
  // Lo que se copia es el SPF actual con lo que falta, no el del servidor (T6).
  assert.equal(sinMx.suggested, 'v=spf1 include:_spf.google.com a:mail.servidor.es ~all');
});

test('SPF: «a:<servidor>» autoriza a este servidor esté donde esté el MX; «mx» solo con el MX aquí (T14)', async (t) => {
  const medir = async (valor: string, mx: { priority: number; exchange: string }[]) => {
    let resultado: DnsCheck | undefined;
    await t.test(`${valor} · MX ${mx.map((m) => m.exchange).join(',')}`, async (st) => {
      instalarDnsFalso(st, { ...publicado, mx: { [D]: mx }, txt: { ...publicado.txt, [D]: [valor] } });
      resultado = medida(await checkDomainDns(D, delMotor), `spf:${D}`);
    });
    return resultado!;
  };
  const google = [{ priority: 1, exchange: 'aspmx.l.google.com' }];
  assert.equal((await medir(`v=spf1 a:${SERVIDOR} -all`, google)).status, 'ok');
  assert.equal((await medir(`v=spf1 include:_spf.google.com a:${SERVIDOR} ~all`, google)).status, 'ok');
  assert.equal((await medir(`v=spf1 a:${SERVIDOR.toUpperCase()}/24 ~all`, google)).status, 'ok');
  const mxAjeno = await medir('v=spf1 mx -all', google);
  assert.equal(mxAjeno.status, 'mismatch', 'con el MX en Google, «mx» autoriza a Google, no a este servidor');
  assert.match(mxAjeno.help, /«mx» no basta mientras el MX del dominio apunte a otro proveedor/);
  assert.equal(mxAjeno.suggested, `v=spf1 mx a:${SERVIDOR} -all`);
  assert.equal((await medir('v=spf1 mx -all', [{ priority: 10, exchange: SERVIDOR }])).status, 'ok');
});

test('SPF: si añadir el servidor pasa de 10 consultas DNS, no se propone la fusión (T15)', async (t) => {
  // Seis include, cada uno con dos más anidados: ya son 18 consultas.
  const proveedores = ['_spf.google.com', 'spf.protection.outlook.com', 'servers.mcsv.net', 'sendgrid.net', '_spf.elasticemail.com', 'mail.zendesk.com'];
  const txt: Record<string, string[]> = { ...publicado.txt };
  for (const p of proveedores) txt[p] = [`v=spf1 include:a.${p} include:b.${p} ~all`];
  for (const p of proveedores) for (const sub of ['a', 'b']) txt[`${sub}.${p}`] = ['v=spf1 ip4:192.0.2.0/24 ~all'];
  const actual = `v=spf1 ${proveedores.map((p) => `include:${p}`).join(' ')} ~all`;
  txt[D] = [actual];
  instalarDnsFalso(t, { ...publicado, txt });
  const spf = medida(await checkDomainDns(D, delMotor), `spf:${D}`);
  assert.equal(spf.status, 'mismatch');
  assert.equal(spf.suggested, undefined, 'una fusión que rompe el SPF no se ofrece');
  assert.match(spf.help, /demasiadas consultas DNS/);
  assert.match(spf.help, /ip4:203\.0\.113\.10/);
});

test('dos SPF en el mismo nombre son un error aunque uno sea correcto', async (t) => {
  instalarDnsFalso(t, { ...publicado, txt: { ...publicado.txt, [D]: ['v=spf1 mx -all', 'v=spf1 include:x.es -all'] } });
  const spf = medida(await checkDomainDns(D, delMotor), `spf:${D}`);
  assert.equal(spf.status, 'mismatch');
  assert.match(spf.help, /Hay 2 registros SPF/);
});

/* ----------------------------------- DMARC -------------------------------- */

test('DMARC: la política se lee con espacios (p = reject)', async (t) => {
  instalarDnsFalso(t, {
    ...publicado,
    txt: { ...publicado.txt, [`_dmarc.${D}`]: ['v = DMARC1 ; p = reject ; rua=mailto:a@ejemplo.es'] },
  });
  assert.equal(medida(await checkDomainDns(D, delMotor), `dmarc:_dmarc.${D}`).status, 'ok');
});

test('DMARC: varios registros son un error, como con el SPF duplicado', async (t) => {
  instalarDnsFalso(t, {
    ...publicado,
    txt: { ...publicado.txt, [`_dmarc.${D}`]: ['v=DMARC1; p=reject', 'v=DMARC1; p=none'] },
  });
  const informe = await checkDomainDns(D, delMotor);
  const dmarc = medida(informe, `dmarc:_dmarc.${D}`);
  assert.equal(dmarc.status, 'mismatch');
  assert.match(dmarc.help, /Hay 2 registros DMARC/);
  assert.equal(informe.allRequiredOk, false);
});

test('DMARC: sin una política p válida no está en rango (sp no cuenta)', async (t) => {
  instalarDnsFalso(t, {
    ...publicado,
    txt: { ...publicado.txt, [`_dmarc.${D}`]: ['v=DMARC1; sp=reject; rua=mailto:a@ejemplo.es'] },
  });
  const dmarc = medida(await checkDomainDns(D, delMotor), `dmarc:_dmarc.${D}`);
  assert.equal(dmarc.status, 'mismatch');
  assert.match(dmarc.help, /p=none, p=quarantine o p=reject/);
});

/* ------------------------------------ AAAA -------------------------------- */

test('AAAA: se consulta de verdad y se compara en forma canónica', async (t) => {
  const conAaaa: EngineDnsRecord[] = [...delMotor, { type: 'AAAA', name: `ipv6.${D}.`, content: '2001:db8::25' }];
  const aaaa = async (direcciones: string[] | undefined) => {
    let resultado: DnsCheck | undefined;
    await t.test(String(direcciones), async (st) => {
      instalarDnsFalso(st, { ...publicado, aaaa: direcciones ? { [`ipv6.${D}`]: direcciones } : {} });
      resultado = medida(await checkDomainDns(D, conAaaa), `aaaa:ipv6.${D}`);
    });
    return resultado!;
  };
  assert.equal((await aaaa(['2001:0db8:0000:0000:0000:0000:0000:0025'])).status, 'ok');
  const ajena = await aaaa(['2001:db8::99']);
  assert.equal(ajena.status, 'mismatch');
  assert.match(ajena.help, /no es la de este servidor/);
  assert.equal((await aaaa(undefined)).status, 'missing');
});

test('AAAA: sin red no se consulta (modo sin red de las pruebas)', async () => {
  assert.equal(await lookupAaaa(SERVIDOR), null);
});

test('AAAA del servidor: avisa si su inverso no lleva al servidor y no avisa sin IPv6', async (t) => {
  assert.deepEqual(evaluarIpv6(SERVIDOR, [], []), { ok: true, ajenas: [] });
  assert.deepEqual(evaluarIpv6(SERVIDOR, null, []), { ok: null, ajenas: [] });
  assert.deepEqual(evaluarIpv6(SERVIDOR, ['2001:db8::25'], [[`${SERVIDOR}.`]]), { ok: true, ajenas: [] });
  assert.deepEqual(evaluarIpv6(SERVIDOR, ['2001:db8::25'], [null]), { ok: null, ajenas: [] });
  assert.deepEqual(evaluarIpv6(SERVIDOR, ['2001:db8::25', '2001:db8::26'], [[SERVIDOR], []]), {
    ok: false,
    ajenas: ['2001:db8::26'],
  });

  const sinRed = await checkServerHealth();
  assert.equal(sinRed.hostnameIpv6, null);
  assert.equal(sinRed.ipv6Ok, null);

  await t.test('AAAA de otra máquina', async (st) => {
    instalarDnsFalso(st, {
      a: { [SERVIDOR]: ['203.0.113.10'] },
      aaaa: { [SERVIDOR]: ['2001:db8::99'] },
      ptr: { '203.0.113.10': [SERVIDOR], '2001:db8::99': ['aparcado.registrador.example'] },
    });
    const salud = await checkServerHealth();
    assert.deepEqual(salud.hostnameIpv6, ['2001:db8::99']);
    assert.equal(salud.ipv6Ok, false);
    const aviso = salud.recommendations.find((r) => r.title.includes('AAAA'));
    assert.ok(aviso, 'avisa del AAAA');
    assert.equal(aviso.severity, 'warning');
    assert.match(aviso.detail, /si no es de este servidor, o el servidor no tiene IPv6, elimina el registro AAAA/);
  });

  await t.test('sin AAAA: solo IPv4, sin aviso', async (st) => {
    instalarDnsFalso(st, { a: { [SERVIDOR]: ['203.0.113.10'] }, ptr: { '203.0.113.10': [SERVIDOR] } });
    const salud = await checkServerHealth();
    assert.deepEqual(salud.hostnameIpv6, []);
    assert.equal(salud.ipv6Ok, true);
    assert.ok(!salud.recommendations.some((r) => r.title.includes('AAAA')));
  });
});

/* -------------------------- Registros que faltan en el motor --------------- */

test('si el motor no generó el DKIM, la comprobación lo marca y no da el dominio por bueno', async (t) => {
  instalarDnsFalso(t, publicado);
  const sinDkim = delMotor.filter((r) => !r.name.includes('_domainkey'));
  const informe = await checkDomainDns(D, sinDkim);
  const dkim = medida(informe, 'motor:dkim');
  assert.equal(dkim.status, 'missing');
  assert.equal(dkim.required, true);
  assert.equal(dkim.engineMissing, true);
  assert.equal(dkim.expected, '', 'no hay valor que copiar');
  assert.match(dkim.help, /no ha generado la clave DKIM/);
  assert.equal(informe.allRequiredOk, false, 'MX, SPF y DMARC en rango no bastan');
  assert.equal(informe.requiredOk, 3);
  assert.equal(informe.requiredTotal, 4);

  const completo = await checkDomainDns(D, delMotor);
  assert.ok(!completo.checks.some((c) => c.engineMissing));
  assert.equal(completo.allRequiredOk, true);
});

test('un dominio sin DKIM en el motor queda pendiente al medirlo', async (t) => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId, D);
  instalarDnsFalso(t, publicado);
  const engine = getEngine();
  const original = engine.getDnsRecords.bind(engine);
  engine.getDnsRecords = async () => delMotor.filter((r) => !r.name.includes('_domainkey'));
  try {
    const medido = await refreshDomainDns(domainId);
    assert.equal(medido.status, 'pending_dns');
    assert.equal(medido.dnsStatus.allRequiredOk, false);
  } finally {
    engine.getDnsRecords = original;
  }
  engine.getDnsRecords = async () => delMotor;
  try {
    assert.equal((await refreshDomainDns(domainId)).status, 'active');
  } finally {
    engine.getDnsRecords = original;
  }
});

/* ----------------------- Aviso de otro proveedor (ruta) -------------------- */

test('el aviso de otro proveedor compara con el MX del motor y, si el motor falla, con Ajustes', async (t) => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId, 'conflicto-motor.es');
  // El motor se anuncia como mx.servidor.es (no como en Ajustes) y el DNS ya apunta ahí.
  instalarDnsFalso(t, { mx: { 'conflicto-motor.es': [{ priority: 10, exchange: 'mx.servidor.es' }] } });
  const engine = getEngine();
  const original = engine.getDnsRecords.bind(engine);
  const pedir = async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/domains/${domainId}/conflicto`,
      headers: { cookie: ctx.adminCookie },
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as { hayOtroProveedor: boolean; aviso: string | null; mxInternos: string[] };
  };
  try {
    engine.getDnsRecords = async (dominio: string) => [
      { type: 'MX', name: `${dominio}.`, content: '10 mx.servidor.es.' },
    ];
    const conMotor = await pedir();
    assert.equal(conMotor.hayOtroProveedor, false, 'el MX que genera el motor es de este servidor');
    assert.deepEqual(conMotor.mxInternos, []);

    engine.getDnsRecords = async () => {
      throw upstream('El motor de correo no responde.', 'engine_unreachable');
    };
    const sinMotor = await pedir();
    assert.equal(sinMotor.hayOtroProveedor, true, 'sin motor se compara con Ajustes y el aviso no se pierde');
    assert.match(sinMotor.aviso ?? '', /mx\.servidor\.es/);
  } finally {
    engine.getDnsRecords = original;
  }
});

/* --------------------------- MX interno en las rutas ----------------------- */

test('con un MX interno no se exporta la zona y la ficha y la tabla lo avisan', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId, 'mx-interno.es');
  const engine = getEngine();
  const original = engine.getDnsRecords.bind(engine);
  engine.getDnsRecords = async (dominio: string) => [
    { type: 'MX', name: `${dominio}.`, content: '10 3f2a1b4c5d6e.' },
    { type: 'TXT', name: `${dominio}.`, content: 'v=spf1 mx ra=postmaster -all' },
  ];
  try {
    const zona = await ctx.app.inject({
      method: 'GET',
      url: `/api/domains/${domainId}/zonefile?nivel=completo`,
      headers: { cookie: ctx.adminCookie },
    });
    assert.equal(zona.statusCode, 409, zona.body);
    const error = zona.json() as { error: string; code: string };
    assert.equal(error.code, 'mx_hostname_internal');
    assert.match(error.error, /«3f2a1b4c5d6e».*nombre interno/);

    const conflicto = await ctx.app.inject({
      method: 'GET',
      url: `/api/domains/${domainId}/conflicto`,
      headers: { cookie: ctx.adminCookie },
    });
    const cuerpo = conflicto.json() as { mxInternos: string[]; avisoServidor: string | null };
    assert.deepEqual(cuerpo.mxInternos, ['3f2a1b4c5d6e']);
    assert.match(cuerpo.avisoServidor ?? '', /Ajustes → Servidor de correo/);

    const tabla = await ctx.app.inject({
      method: 'GET',
      url: `/api/domains/${domainId}/dns`,
      headers: { cookie: ctx.adminCookie },
    });
    assert.deepEqual((tabla.json() as { mxInternos: string[] }).mxInternos, ['3f2a1b4c5d6e']);

    const anotadas = db
      .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'domain.zonefile_downloaded' AND detail LIKE ?")
      .get(`%${domainId}%`) as { c: number };
    assert.equal(anotadas.c, 0, 'una descarga rechazada no se anota como hecha');

    const medido = await refreshDomainDns(domainId);
    assert.equal(medido.status, 'pending_dns', 'la entregabilidad lo da por incorrecto');
    assert.equal(getDomain(domainId).dnsStatus.checks?.find((c) => c.type === 'MX')?.status, 'mismatch');
  } finally {
    engine.getDnsRecords = original;
  }
});
