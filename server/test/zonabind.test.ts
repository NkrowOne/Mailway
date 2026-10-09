import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analizarZonaBind } from '../src/engine/zonabind';
import { normalizarTxt, trocearTxt } from '../src/core/cloudflare';
import { seleccionarRegistros } from '../src/modules/zonefile';

/*
 * Analizador de la zona BIND que da Stalwart 0.16 (`Domain.dnsZoneFile`).
 * La zona grabada viene de un Stalwart 0.16.25 real (motor016-real.test.ts):
 * el TXT del DKIM RSA llega partido en dos trozos de 255 bytes entre
 * paréntesis y en varias líneas.
 */

const ZONA_REAL = fs.readFileSync(path.join(__dirname, 'fixtures', 'motor016', 'zona-dominio.txt'), 'utf8');
const DOMINIO_REAL = /^(\S+)\. IN MX /m.exec(ZONA_REAL)![1]!;

test('zona real de 0.16.25: misma forma que los registros JSON de 0.15', () => {
  const registros = analizarZonaBind(ZONA_REAL);
  assert.ok(registros.length >= 15);
  for (const r of registros) {
    assert.ok(r.name.endsWith('.'), `nombre absoluto con punto final: ${r.name}`);
    assert.equal(r.type, r.type.toUpperCase());
  }

  const mx = registros.find((r) => r.type === 'MX');
  assert.equal(mx?.name, `${DOMINIO_REAL}.`);
  assert.match(mx!.content, /^10 \S+\.$/);

  // El DKIM RSA (dos trozos entre paréntesis) llega como UNA cadena sin
  // comillas, igual que lo daba 0.15.
  const rsa = registros.find((r) => r.type === 'TXT' && r.content.includes('k=rsa'));
  assert.ok(rsa);
  assert.match(rsa.name, new RegExp(`^v1-rsa-\\d{8}\\._domainkey\\.${DOMINIO_REAL.replace(/\./g, '\\.')}\\.$`));
  assert.ok(!rsa.content.includes('"'));
  assert.ok(rsa.content.startsWith('v=DKIM1; k=rsa; h=sha256; p=MII'));
  assert.ok(Buffer.byteLength(rsa.content) > 255, 'la clave entera, no solo el primer trozo');
  assert.match(rsa.content, /IDAQAB$/);

  const ed25519 = registros.find((r) => r.type === 'TXT' && r.content.includes('k=ed25519'));
  assert.match(ed25519!.content, /^v=DKIM1; k=ed25519; h=sha256; p=[A-Za-z0-9+/=]+$/);

  assert.ok(registros.some((r) => r.type === 'TXT' && r.name === `${DOMINIO_REAL}.` && r.content === 'v=spf1 mx -all'));
  assert.ok(registros.some((r) => r.type === 'SRV' && /^0 1 993 \S+\.$/.test(r.content)));
  assert.ok(registros.some((r) => r.type === 'CNAME' && r.name === `autoconfig.${DOMINIO_REAL}.`));
});

test('lo que analiza encaja con el resto del panel (selección, troceado)', () => {
  const registros = analizarZonaBind(ZONA_REAL);
  const seleccion = seleccionarRegistros(DOMINIO_REAL, registros);
  // La selección del panel quita los puntos finales y deja fuera lo que no publica.
  assert.ok(seleccion.some((r) => r.type === 'MX' && r.name === DOMINIO_REAL));
  assert.ok(!seleccion.some((r) => r.name.startsWith('_pop3s.')));
  const rsa = registros.find((r) => r.content.includes('k=rsa'))!;
  // Volver a trocearlo para publicarlo da otra vez los trozos del motor.
  assert.equal(normalizarTxt(trocearTxt(rsa.content)), rsa.content);
  assert.ok(ZONA_REAL.includes(`"${rsa.content.slice(0, 255)}"`));
  assert.ok(trocearTxt(rsa.content).startsWith(`"${rsa.content.slice(0, 255)}" "`));
});

test('escapes, comentarios, directivas, TTL y clase en cualquier orden', () => {
  const zona = [
    '$ORIGIN ejemplo.com.',
    '$TTL 3600',
    '; comentario de cabecera',
    '@ IN MX 10 mail.ejemplo.com. ; el MX',
    'www 300 IN CNAME servidor.otro.net.',
    'txt IN 600 TXT "con \\"comillas\\" y \\\\barra" "y; punto y coma"',
    '        IN TXT "segundo TXT del mismo nombre"',
    '_dmarc.ejemplo.com. TXT ( "v=DMARC1;"',
    '   " p=reject" ) ; cierre',
    'decimal IN TXT "a\\065b"',
    'caa IN CAA 0 issue "letsencrypt.org; accounturi=https://acme/1"',
    '_25._tcp.mail IN TLSA 3 1 1 ABCDEF',
    'raro IN TYPE65534 \\# 0',
    'linea que no se entiende',
    '',
  ].join('\r\n');
  assert.deepEqual(analizarZonaBind(zona), [
    { type: 'MX', name: 'ejemplo.com.', content: '10 mail.ejemplo.com.' },
    { type: 'CNAME', name: 'www.ejemplo.com.', content: 'servidor.otro.net.' },
    { type: 'TXT', name: 'txt.ejemplo.com.', content: 'con "comillas" y \\barray; punto y coma' },
    { type: 'TXT', name: 'txt.ejemplo.com.', content: 'segundo TXT del mismo nombre' },
    { type: 'TXT', name: '_dmarc.ejemplo.com.', content: 'v=DMARC1; p=reject' },
    { type: 'TXT', name: 'decimal.ejemplo.com.', content: 'aAb' },
    { type: 'CAA', name: 'caa.ejemplo.com.', content: '0 issue "letsencrypt.org; accounturi=https://acme/1"' },
    { type: 'TLSA', name: '_25._tcp.mail.ejemplo.com.', content: '3 1 1 ABCDEF' },
    { type: 'TYPE65534', name: 'raro.ejemplo.com.', content: '\\# 0' },
  ]);
});

test('zona vacía o sin registros reconocibles', () => {
  assert.deepEqual(analizarZonaBind(''), []);
  assert.deepEqual(analizarZonaBind('; solo un comentario\n\n'), []);
  assert.deepEqual(analizarZonaBind('$ORIGIN ejemplo.com.\n'), []);
});

test('TXT largo en varios trozos y UTF-8 escapado en decimal', () => {
  const trozo1 = 'a'.repeat(255);
  const trozo2 = 'b'.repeat(10);
  const zona = `largo.ejemplo.com. IN TXT (\n    "${trozo1}"\n    "${trozo2}"\n)\nutf.ejemplo.com. IN TXT "\\195\\177"\n`;
  const [largo, utf] = analizarZonaBind(zona);
  assert.equal(largo!.content, trozo1 + trozo2);
  assert.equal(utf!.content, 'ñ');
});
