import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  esObligatorio,
  evaluarConflicto,
  filtrarPorNivel,
  generarZona,
  trocearTxt,
} from '../src/modules/zonefile';
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
  assert.match(zona, /^panaderialaura\.com\.\t3600\tIN\tTXT\t"v=spf1 mx -all"$/m);
  assert.match(zona, /^_dmarc\.panaderialaura\.com\.\t3600\tIN\tTXT\t"v=DMARC1; p=quarantine;"$/m);
});

test('la cabecera avisa de la nube naranja, que es el fallo que rompe el correo', () => {
  const zona = generarZona({ domain: dominio, records: registros, nivel: 'obligatorios' });
  assert.match(zona, /GRIS \(DNS only\)/);
  assert.match(zona, /nube naranja el correo NO funciona/);
});

test('avisa del SPF duplicado, que es el otro fallo silencioso al importar', () => {
  const zona = generarZona({ domain: dominio, records: registros, nivel: 'obligatorios' });
  assert.match(zona, /Importar NO borra lo que ya tengas/);
  assert.match(zona, /acabarás con dos y ninguno valdrá/);
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
  assert.match(c.aviso!, /rebote el correo/, 'con p=reject el fallo no es spam, es rebote');
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
