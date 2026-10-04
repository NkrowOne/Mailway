import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoriaDe,
  esObligatorio,
  esRegistroPropiedad,
  evaluarConflicto,
  exigirMxPublico,
  filtrarPorNivel,
  generarZona,
  mxInternos,
  registroPropiedad,
  registrosDelDominio,
  registrosWebExcluidos,
  seleccionarRegistros,
  trocearTxt,
} from '../src/modules/zonefile';
import { HttpError } from '../src/core/errors';
import type { EngineDnsRecord } from '../src/engine/types';

const dominio = 'panaderialaura.com';

// Una clave DKIM real de 2048 bits pasa de largo el límite de 255 bytes.
const clavePublica = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A' + 'B'.repeat(360);
const dkim = `v=DKIM1; k=rsa; p=${clavePublica}`;

const registros: EngineDnsRecord[] = [
  { type: 'MX', name: dominio, content: `10 mail.nkrow.com.` },
  { type: 'TXT', name: dominio, content: 'v=spf1 mx -all' },
  { type: 'TXT', name: `mail._domainkey.${dominio}`, content: dkim },
  { type: 'TXT', name: `_dmarc.${dominio}`, content: 'v=DMARC1; p=quarantine;' },
  { type: 'SRV', name: `_imaps._tcp.${dominio}`, content: '0 1 993 mail.nkrow.com.' },
  { type: 'CNAME', name: `autoconfig.${dominio}`, content: 'mail.nkrow.com.' },
  { type: 'TXT', name: `_mta-sts.${dominio}`, content: 'v=STSv1; id=20260812' },
  { type: 'TXT', name: `_smtp._tls.${dominio}`, content: 'v=TLSRPTv1; rua=mailto:a@b.c' },
];

/* ------------------------------ Troceado ---------------------------------- */

test('un TXT corto queda en una sola cadena entrecomillada', () => {
  assert.equal(trocearTxt('v=spf1 mx -all'), '"v=spf1 mx -all"');
});

test('una clave DKIM larga se trocea en cadenas de 255 bytes o menos', () => {
  const salida = trocearTxt(dkim);
  const cadenas = salida.match(/"[^"]*"/g)!;
  assert.ok(cadenas.length > 1, 'debe partirse en varias cadenas');
  for (const c of cadenas) {
    const contenido = c.slice(1, -1);
    assert.ok(
      Buffer.byteLength(contenido, 'utf8') <= 255,
      `cada cadena debe caber en 255 bytes, esta tiene ${Buffer.byteLength(contenido)}`,
    );
  }
  // Y lo más importante: al concatenarlas debe salir EXACTAMENTE el original.
  assert.equal(cadenas.map((c) => c.slice(1, -1)).join(''), dkim);
});

test('un TXT que ya venía troceado no se corrompe al volver a trocearlo', () => {
  const yaTroceado = '"v=DKIM1; k=rsa; " "p=ABC123"';
  assert.equal(trocearTxt(yaTroceado), '"v=DKIM1; k=rsa; p=ABC123"');
});

test('el troceo no parte un carácter multibyte por la mitad', () => {
  // 300 acentos = 600 bytes: el corte cae justo en mitad de un carácter.
  const salida = trocearTxt('é'.repeat(300));
  const cadenas = salida.match(/"[^"]*"/g)!;
  assert.equal(cadenas.map((c) => c.slice(1, -1)).join(''), 'é'.repeat(300));
  for (const c of cadenas) {
    assert.ok(Buffer.byteLength(c.slice(1, -1), 'utf8') <= 255);
  }
});

/* ------------------------------- Niveles ---------------------------------- */

test('obligatorios trae MX, SPF, DKIM y DMARC, y nada más', () => {
  const sel = filtrarPorNivel(registros, 'obligatorios');
  assert.equal(sel.length, 4);
  assert.ok(sel.every(esObligatorio));
  assert.ok(!sel.some((r) => r.type === 'SRV'), 'no debe colarse la autoconfiguración');
  assert.ok(!sel.some((r) => r.name.includes('_mta-sts')), 'ni MTA-STS');
});

test('recomendados añade la autoconfiguración pero no MTA-STS ni TLS-RPT', () => {
  const sel = filtrarPorNivel(registros, 'recomendados');
  assert.ok(sel.some((r) => r.type === 'SRV'));
  assert.ok(sel.some((r) => r.type === 'CNAME'));
  assert.ok(!sel.some((r) => r.name.includes('_mta-sts')));
  assert.ok(!sel.some((r) => r.name.includes('_smtp._tls')));
});

test('completo no se deja ningún registro del motor', () => {
  assert.equal(filtrarPorNivel(registros, 'completo').length, registros.length);
});

/* ------------------------------- La zona ---------------------------------- */

test('la zona sale en formato BIND con nombres absolutos', () => {
  const zona = generarZona({
    domain: dominio,
    records: registros,
    nivel: 'obligatorios',
    generadoEn: '2026-08-12T00:00:00.000Z',
  });
  assert.match(zona, /^\$TTL 3600$/m);
  assert.match(zona, /^panaderialaura\.com\.\t3600\tIN\tMX\t10 mail\.nkrow\.com\.$/m);
  // Mailway propone su SPF y su DMARC, no los del motor (T3/T15).
  assert.match(zona, /^panaderialaura\.com\.\t3600\tIN\tTXT\t"v=spf1 a:mail\.nkrow\.com ~all"$/m);
  assert.match(zona, /^_dmarc\.panaderialaura\.com\.\t3600\tIN\tTXT\t"v=DMARC1; p=none"$/m);
});

test('el SPF propuesto autoriza al servidor por su nombre y el DMARC empieza en p=none, sin informes a una dirección que no existe', () => {
  const sel = seleccionarRegistros(dominio, [
    { type: 'MX', name: `${dominio}.`, content: '10 mail.nkrow.com.' },
    { type: 'TXT', name: `${dominio}.`, content: 'v=spf1 mx ra=postmaster -all' },
    { type: 'TXT', name: `_dmarc.${dominio}.`, content: `v=DMARC1; p=reject; rua=mailto:postmaster@${dominio}; ruf=mailto:postmaster@${dominio}` },
  ]);
  assert.equal(sel.find((r) => r.name === dominio && r.type === 'TXT')!.content, 'v=spf1 a:mail.nkrow.com ~all');
  assert.equal(sel.find((r) => r.name === `_dmarc.${dominio}`)!.content, 'v=DMARC1; p=none');
});

test('la cabecera avisa de la nube naranja, que es el fallo que rompe el correo', () => {
  const zona = generarZona({ domain: dominio, records: registros, nivel: 'obligatorios' });
  assert.match(zona, /GRIS \(DNS only\)/);
  assert.match(zona, /nube naranja el correo NO funciona/);
});

test('avisa del SPF duplicado, que es el otro fallo silencioso al importar', () => {
  const zona = generarZona({ domain: dominio, records: registros, nivel: 'obligatorios' });
  assert.match(zona, /Importar NO borra los registros existentes/);
  assert.match(zona, /quedarán dos y ninguno será válido/);
});

test('solo avisa del fichero de política MTA-STS cuando el nivel lo incluye', () => {
  const completo = generarZona({ domain: dominio, records: registros, nivel: 'completo' });
  assert.match(completo, /well-known\/mta-sts\.txt/);

  const minimo = generarZona({ domain: dominio, records: registros, nivel: 'obligatorios' });
  assert.ok(
    !minimo.includes('well-known'),
    'sin MTA-STS en el fichero, ese aviso solo sería ruido',
  );
});

test('todas las líneas de comentario empiezan por ; para que el importador las ignore', () => {
  const zona = generarZona({ domain: dominio, records: registros, nivel: 'completo' });
  for (const linea of zona.split('\n')) {
    if (!linea.trim() || linea.startsWith('$')) continue;
    const esComentario = linea.startsWith(';');
    const esRegistro = /\tIN\t/.test(linea);
    assert.ok(esComentario || esRegistro, `línea que el importador no sabría leer: ${linea}`);
  }
});

/* -------------------------- Conflicto de proveedor ------------------------ */

test('detecta que el dominio ya recibe correo en otro proveedor', () => {
  const c = evaluarConflicto({
    mx: [{ priority: 50, exchange: 'mailserver.purelymail.com' }],
    txt: ['v=spf1 include:_spf.purelymail.com ~all'],
    dmarc: ['v=DMARC1; p=reject; ruf=mailto:dmarc@purelymail.com'],
    mailHostname: 'mail.nkrow.com',
  });
  assert.equal(c.hayOtroProveedor, true);
  assert.equal(c.dmarcPolitica, 'reject');
  assert.match(c.aviso!, /ya recibe correo en mailserver\.purelymail\.com/);
  assert.match(c.aviso!, /solo puede haber uno/, 'debe avisar del SPF duplicado');
  assert.match(c.aviso!, /provoca que se rechace/, 'con p=reject el fallo no es spam, es rechazo');
});

test('no avisa cuando el MX ya es el nuestro', () => {
  const c = evaluarConflicto({
    mx: [{ priority: 10, exchange: 'mail.nkrow.com.' }],
    txt: ['v=spf1 mx -all'],
    dmarc: ['v=DMARC1; p=quarantine'],
    mailHostname: 'mail.nkrow.com',
  });
  assert.equal(c.hayOtroProveedor, false);
  assert.equal(c.aviso, null);
});

test('un dominio sin correo todavía no genera aviso', () => {
  const c = evaluarConflicto({ mx: [], txt: [], dmarc: [], mailHostname: 'mail.nkrow.com' });
  assert.equal(c.hayOtroProveedor, false);
  assert.equal(c.aviso, null);
});

test('un fallo de red (null) no se confunde con "no hay nada"', () => {
  const c = evaluarConflicto({ mx: null, txt: null, dmarc: null, mailHostname: 'mail.nkrow.com' });
  assert.equal(c.hayOtroProveedor, false, 'sin datos no se puede afirmar que haya conflicto');
  assert.equal(c.spfActual, null);
});

/* ------------------- Selección común (comprobación, zona, Cloudflare) ------ */

// Lo que devuelve Stalwart para un dominio: con punto final, con escuchas que
// el despliegue no publica, TLSA y el SPF del propio servidor (otro dominio).
const delMotor: EngineDnsRecord[] = [
  { type: 'MX', name: `${dominio}.`, content: '10 mail.nkrow.com.' },
  { type: 'CNAME', name: `mail.${dominio}.`, content: 'mail.nkrow.com.' },
  { type: 'TXT', name: `202609e._domainkey.${dominio}.`, content: 'v=DKIM1; k=ed25519; h=sha256; p=AAAA' },
  { type: 'TXT', name: 'mail.nkrow.com.', content: 'v=spf1 a ra=postmaster -all' },
  { type: 'TXT', name: `${dominio}.`, content: 'v=spf1 mx ra=postmaster -all' },
  { type: 'SRV', name: `_submissions._tcp.${dominio}.`, content: '0 1 465 mail.nkrow.com.' },
  { type: 'SRV', name: `_submission._tcp.${dominio}.`, content: '0 1 587 mail.nkrow.com.' },
  { type: 'SRV', name: `_imap._tcp.${dominio}.`, content: '0 1 143 mail.nkrow.com.' },
  { type: 'SRV', name: `_imaps._tcp.${dominio}.`, content: '0 1 993 mail.nkrow.com.' },
  { type: 'SRV', name: `_pop3._tcp.${dominio}.`, content: '0 1 110 mail.nkrow.com.' },
  { type: 'SRV', name: `_pop3s._tcp.${dominio}.`, content: '0 1 995 mail.nkrow.com.' },
  { type: 'SRV', name: `_jmap._tcp.${dominio}.`, content: '0 1 443 mail.nkrow.com.' },
  { type: 'SRV', name: `_sieve._tcp.${dominio}.`, content: '0 1 4190 mail.nkrow.com.' },
  { type: 'CNAME', name: `autoconfig.${dominio}.`, content: 'mail.nkrow.com.' },
  { type: 'CNAME', name: `autodiscover.${dominio}.`, content: 'mail.nkrow.com.' },
  { type: 'CNAME', name: `mta-sts.${dominio}.`, content: 'mail.nkrow.com.' },
  { type: 'TXT', name: `_mta-sts.${dominio}.`, content: 'v=STSv1; id=123' },
  { type: 'TXT', name: `_dmarc.${dominio}.`, content: `v=DMARC1; p=reject; rua=mailto:postmaster@${dominio}` },
  { type: 'TXT', name: `_smtp._tls.${dominio}.`, content: `v=TLSRPTv1; rua=mailto:postmaster@${dominio}` },
  { type: 'TLSA', name: `_25._tcp.mail.${dominio}.`, content: '3 0 1 abcdef' },
  // Un nombre que «termina igual» pero es de otro dominio.
  { type: 'TXT', name: `otro${dominio}.`, content: 'v=spf1 -all' },
];

test('la selección quita los SRV de puertos no publicados', () => {
  const sel = seleccionarRegistros(dominio, delMotor);
  const srv = sel.filter((r) => r.type === 'SRV').map((r) => r.name.split('.')[0]);
  assert.deepEqual(srv.sort(), ['_imaps', '_jmap', '_submission', '_submissions']);
});

test('la selección quita TLSA y los nombres ajenos al dominio', () => {
  const sel = seleccionarRegistros(dominio, delMotor);
  assert.ok(!sel.some((r) => r.type === 'TLSA'));
  assert.ok(!sel.some((r) => r.name === 'mail.nkrow.com'), 'el SPF del servidor es de otra zona');
  assert.ok(!sel.some((r) => r.name === `otro${dominio}`), 'un sufijo no es un subdominio');
});

test('la selección deja nombres y destinos sin punto final', () => {
  const sel = seleccionarRegistros(dominio, delMotor);
  for (const r of sel) assert.ok(!r.name.endsWith('.'), `nombre con punto: ${r.name}`);
  const mx = sel.find((r) => r.type === 'MX')!;
  assert.equal(mx.content, '10 mail.nkrow.com');
  const cname = sel.find((r) => r.name === `autoconfig.${dominio}`)!;
  assert.equal(cname.content, 'mail.nkrow.com');
});

test('el fichero de zona vuelve a poner el punto final a los destinos', () => {
  const zona = generarZona({ domain: dominio, records: delMotor, nivel: 'completo' });
  assert.match(zona, /\tMX\t10 mail\.nkrow\.com\.$/m);
  assert.match(zona, /\tSRV\t0 1 993 mail\.nkrow\.com\.$/m);
  assert.match(zona, /^autoconfig\.panaderialaura\.com\.\t3600\tIN\tCNAME\tmail\.nkrow\.com\.$/m);
  assert.ok(!zona.includes('TLSA'), 'TLSA no se publica');
  assert.ok(!zona.includes('_pop3'), 'los SRV de POP3 no se publican');
});

test('MTA-STS y TLS-RPT son endurecimiento, no autoconfiguración', () => {
  const sel = seleccionarRegistros(dominio, delMotor);
  const cat = (name: string) => categoriaDe(sel.find((r) => r.name === name)!);
  assert.equal(cat(`mta-sts.${dominio}`), 'endurecimiento');
  assert.equal(cat(`_mta-sts.${dominio}`), 'endurecimiento');
  assert.equal(cat(`_smtp._tls.${dominio}`), 'endurecimiento');
  assert.equal(cat(`autoconfig.${dominio}`), 'autoconfiguracion');
  assert.equal(cat(`202609e._domainkey.${dominio}`), 'obligatorio');
  const recomendados = filtrarPorNivel(sel, 'recomendados');
  assert.ok(!recomendados.some((r) => r.name.startsWith('mta-sts.')), 'el CNAME de MTA-STS solo no sirve de nada');
});

test('el TXT de verificación de la propiedad va una sola vez y con lo recomendado', () => {
  const todos = registrosDelDominio(dominio, delMotor);
  const propios = todos.filter(esRegistroPropiedad);
  assert.equal(propios.length, 1);
  assert.equal(propios[0]!.name, `_mailway.${dominio}`);
  assert.equal(categoriaDe(propios[0]!), 'verificacion');
  assert.ok(!esObligatorio(propios[0]!));
  assert.ok(filtrarPorNivel(todos, 'recomendados').some(esRegistroPropiedad));
  assert.ok(!filtrarPorNivel(todos, 'obligatorios').some(esRegistroPropiedad));
  // Si el motor lo devolviera (no lo hace), no se duplica.
  assert.equal(registrosDelDominio(dominio, [...delMotor, registroPropiedad(dominio)]).filter(esRegistroPropiedad).length, 1);
  const zona = generarZona({ domain: dominio, records: delMotor, nivel: 'recomendados' });
  assert.match(zona, /demuestra que el dominio es tuyo/);
});

/* ----------------------- Registros de la web del dominio ------------------ */

// Registros que un motor podría proponer y que pisarían la web del cliente.
const conWeb: EngineDnsRecord[] = [
  ...registros,
  { type: 'A', name: `${dominio}.`, content: '203.0.113.10' },
  { type: 'AAAA', name: dominio, content: '2001:db8::25' },
  { type: 'CNAME', name: `www.${dominio}.`, content: 'mail.nkrow.com.' },
  { type: 'HTTPS', name: dominio, content: '1 . alpn="h2"' },
  { type: 'SVCB', name: `www.${dominio}`, content: '1 . port=443' },
  { type: 'CNAME', name: `mail.${dominio}.`, content: 'mail.nkrow.com.' },
  { type: 'A', name: `servidor.${dominio}.`, content: '203.0.113.10' },
];

test('la selección nunca incluye A, AAAA, CNAME, HTTPS ni SVCB del dominio raíz ni de www', () => {
  const sel = seleccionarRegistros(dominio, conWeb);
  const web = sel.filter(
    (r) => (r.name === dominio || r.name === `www.${dominio}`) && ['A', 'AAAA', 'CNAME', 'HTTPS', 'SVCB'].includes(r.type),
  );
  assert.deepEqual(web, []);
  // El correo del dominio raíz (MX, SPF) y los demás nombres siguen.
  assert.ok(sel.some((r) => r.type === 'MX' && r.name === dominio));
  assert.ok(sel.some((r) => r.type === 'TXT' && r.name === dominio));
  // mail.<dominio> tampoco (T7): Mailway no lo usa y pisaría el del proveedor anterior.
  assert.ok(!sel.some((r) => r.type === 'CNAME' && r.name === `mail.${dominio}`));
  assert.ok(sel.some((r) => r.type === 'A' && r.name === `servidor.${dominio}`));
  assert.equal(registrosWebExcluidos(dominio, conWeb).length, 5);
});

test('el fichero de zona dice al principio qué registros de la web ha dejado fuera', () => {
  const zona = generarZona({ domain: dominio, records: conWeb, nivel: 'completo', generadoEn: '2026-10-02T00:00:00Z' });
  const lineas = zona.split('\n');
  const aviso = lineas.findIndex((l) => l.includes('REGISTROS DE LA WEB EXCLUIDOS'));
  const importacion = lineas.findIndex((l) => l.includes('IMPORTACIÓN EN CLOUDFLARE'));
  assert.ok(aviso > 0 && aviso < importacion, 'el aviso va en la cabecera, antes que nada más');
  assert.ok(zona.includes(`;      ${dominio} A 203.0.113.10`));
  assert.ok(zona.includes(`;      www.${dominio} CNAME mail.nkrow.com.`));
  // Ninguna línea de registro (no comentario) los publica.
  const cuerpo = lineas.filter((l) => l && !l.startsWith(';') && !l.startsWith('$'));
  assert.ok(!cuerpo.some((l) => l.startsWith(`${dominio}.\t`) && /\t(A|AAAA|CNAME|HTTPS|SVCB)\t/.test(l)));
  assert.ok(!cuerpo.some((l) => l.startsWith(`www.${dominio}.\t`)));
  assert.ok(!cuerpo.some((l) => l.startsWith(`mail.${dominio}.\t`)), 'mail.<dominio> no se publica');
  assert.ok(zona.includes(`mail.${dominio} NO SE INCLUYE`), 'y la cabecera explica por qué');

  const sinWeb = generarZona({ domain: dominio, records: registros, nivel: 'completo' });
  assert.ok(!sinWeb.includes('REGISTROS DE LA WEB EXCLUIDOS'), 'sin nada excluido no hay aviso');
});

test('el CNAME mail.<dominio> que propone el motor no se publica ni reemplaza el del hosting', () => {
  const propuestos: EngineDnsRecord[] = [
    { type: 'MX', name: `${dominio}.`, content: '10 mail.nkrow.com.' },
    { type: 'CNAME', name: `mail.${dominio}.`, content: 'mail.nkrow.com.' },
    { type: 'CNAME', name: `autoconfig.${dominio}.`, content: 'mail.nkrow.com.' },
  ];
  const sel = seleccionarRegistros(dominio, propuestos);
  assert.deepEqual(sel.map((r) => r.name).sort(), [`autoconfig.${dominio}`, dominio]);
  const zona = generarZona({ domain: dominio, records: propuestos, nivel: 'recomendados' });
  assert.match(zona, /mantenlo así/);
});

/* ------------------------ MX del motor e interno --------------------------- */

test('el aviso de otro proveedor reconoce el MX que genera el motor como propio', () => {
  const base = {
    mx: [{ priority: 10, exchange: 'mx.servidor.es.' }],
    txt: [],
    dmarc: [],
    mailHostname: 'mail.servidor.es',
  };
  assert.equal(evaluarConflicto({ ...base, mxEsperados: ['mx.servidor.es'] }).hayOtroProveedor, false);
  const sinMotor = evaluarConflicto({ ...base, mxEsperados: null });
  assert.equal(sinMotor.hayOtroProveedor, true, 'sin motor se compara con Ajustes, como siempre');
  assert.match(sinMotor.aviso!, /ya recibe correo en mx\.servidor\.es/);
  const ajeno = evaluarConflicto({
    ...base,
    mx: [{ priority: 1, exchange: 'smtp.google.com' }],
    mxEsperados: ['mx.servidor.es'],
  });
  assert.equal(ajeno.hayOtroProveedor, true);
});

test('el aviso de otro proveedor lee DMARC con espacios y no da política con dos registros', () => {
  const ajeno = { mx: [{ priority: 1, exchange: 'smtp.google.com' }], txt: [], mailHostname: 'mail.nkrow.com' };
  assert.equal(evaluarConflicto({ ...ajeno, dmarc: ['v=DMARC1; sp=none; p = reject'] }).dmarcPolitica, 'reject');
  assert.equal(
    evaluarConflicto({ ...ajeno, dmarc: ['v=DMARC1; p=reject', 'v=DMARC1; p=none'] }).dmarcPolitica,
    null,
  );
});

test('un MX interno del motor se detecta y bloquea el fichero de zona con un código propio', () => {
  const internos: EngineDnsRecord[] = [
    { type: 'MX', name: `${dominio}.`, content: '10 3f2a1b4c5d6e.' },
    { type: 'TXT', name: `${dominio}.`, content: 'v=spf1 mx -all' },
  ];
  assert.deepEqual(mxInternos(dominio, internos), ['3f2a1b4c5d6e']);
  assert.deepEqual(mxInternos(dominio, registros), []);
  for (const destino of ['localhost', '10.0.0.5', 'mailway-mail', 'mail.local', 'stalwart.internal', 'mail.docker', 'mail.lan']) {
    assert.deepEqual(mxInternos(dominio, [{ type: 'MX', name: dominio, content: `10 ${destino}.` }]), [destino], destino);
  }
  assert.throws(
    () => exigirMxPublico(dominio, internos),
    (err: HttpError) => err.status === 409 && err.code === 'mx_hostname_internal' && /nombre interno/.test(err.message),
  );
  exigirMxPublico(dominio, registros);

  const conflicto = evaluarConflicto({ mx: [], txt: [], dmarc: [], mailHostname: '', mxEsperados: ['3f2a1b4c5d6e'] });
  assert.deepEqual(conflicto.mxInternos, ['3f2a1b4c5d6e']);
  assert.match(conflicto.avisoServidor!, /«3f2a1b4c5d6e»/);
  assert.equal(evaluarConflicto({ mx: [], txt: [], dmarc: [], mailHostname: 'mail.nkrow.com' }).avisoServidor, null);
});
