import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diagnosticoSpf,
  esDmarc,
  esSpf,
  etiquetasDmarc,
  politicaDmarc,
  spfCubre,
} from '../src/core/mailauth';

/* Lo que propone Stalwart 0.15.5 para un dominio y para el propio servidor. */
const SPF_DOMINIO = 'v=spf1 mx ra=postmaster -all';
const SPF_SERVIDOR = 'v=spf1 a ra=postmaster -all';
const ctx = { nombre: 'ejemplo.es', ipServidor: '203.0.113.10' };

/* ----------------------------------- SPF ---------------------------------- */

test('valen mx, +mx, mx:dominio y sus variantes con prefijo de red', () => {
  for (const spf of [
    'v=spf1 mx -all',
    'v=spf1 +mx -all',
    'v=spf1 MX ~all',
    'v=spf1 mx:ejemplo.es -all',
    'v=spf1 mx:Ejemplo.ES. -all',
    'v=spf1 mx/24 -all',
    'v=spf1 mx:ejemplo.es/24//64 ?all',
    'v=spf1 include:_spf.google.com mx ~all',
    'v=spf1 mx',
    'v=spf1 mx redirect=_spf.otro.es',
  ]) {
    assert.equal(spfCubre(spf, SPF_DOMINIO, ctx), true, spf);
  }
});

test('el mecanismo tiene que ir antes de «all»: lo de detrás no se evalúa', () => {
  assert.equal(spfCubre('v=spf1 -all mx', SPF_DOMINIO, ctx), false);
  assert.equal(spfCubre('v=spf1 include:_spf.google.com ~all mx', SPF_DOMINIO, ctx), false);
  assert.equal(spfCubre('v=spf1 ?all +mx', SPF_DOMINIO, ctx), false);
  assert.deepEqual(diagnosticoSpf('v=spf1 -all mx', SPF_DOMINIO, ctx), { faltan: ['mx'], detrasDeAll: ['mx'] });
  assert.deepEqual(diagnosticoSpf('v=spf1 include:x.es -all', SPF_DOMINIO, ctx), { faltan: ['mx'], detrasDeAll: [] });
});

test('un calificador que no autoriza (-, ~, ?) no cuenta, ni «mx» dentro de otro mecanismo', () => {
  assert.equal(spfCubre('v=spf1 -mx -all', SPF_DOMINIO, ctx), false);
  assert.equal(spfCubre('v=spf1 ~mx -all', SPF_DOMINIO, ctx), false);
  assert.equal(spfCubre('v=spf1 include:_spf.mx.cloudflare.net ~all', SPF_DOMINIO, ctx), false);
  assert.equal(spfCubre('v=spf1 +all', SPF_DOMINIO, ctx), false, '+all no es una autorización de este servidor');
});

test('mx de otro dominio no equivale a mx: autoriza los servidores de ese dominio', () => {
  assert.equal(spfCubre('v=spf1 mx:otro-proveedor.com -all', SPF_DOMINIO, ctx), false);
  assert.equal(spfCubre('v=spf1 mx:ejemplo.es -all', SPF_DOMINIO), false, 'sin saber el nombre no se presupone');
});

test('a e ip4: valen para el SPF del servidor y una ip4 del servidor autoriza como mx', () => {
  const servidor = { nombre: 'mail.ejemplo.es', ipServidor: '203.0.113.10' };
  assert.equal(spfCubre('v=spf1 a -all', SPF_SERVIDOR, servidor), true);
  assert.equal(spfCubre('v=spf1 +a:mail.ejemplo.es -all', SPF_SERVIDOR, servidor), true);
  assert.equal(spfCubre('v=spf1 ip4:203.0.113.10 -all', SPF_SERVIDOR, servidor), true);
  assert.equal(spfCubre('v=spf1 ip4:203.0.113.0/24 -all', SPF_DOMINIO, ctx), true);
  assert.equal(spfCubre('v=spf1 ip4:198.51.100.7 -all', SPF_DOMINIO, ctx), false);
  assert.equal(spfCubre('v=spf1 ip4:203.0.113.10 -all', SPF_DOMINIO, { nombre: 'ejemplo.es' }), false, 'sin IP conocida no se compara');
  assert.equal(spfCubre('v=spf1 ip4:203.0.113.10 -all', 'v=spf1 ip4:203.0.113.10 -all'), true);
  assert.equal(
    spfCubre('v=spf1 include:_spf.proveedor.es -all', 'v=spf1 include:_spf.proveedor.es -all'),
    true,
    'un include que pide el motor se acepta tal cual, como hasta ahora',
  );
});

test('solo es un SPF lo que empieza por v=spf1 seguido de espacio', () => {
  assert.equal(esSpf('v=spf1 mx -all'), true);
  assert.equal(esSpf('V=SPF1'), true);
  assert.equal(esSpf('v=spf10 mx -all'), false);
  assert.equal(esSpf('v=DMARC1; p=none'), false);
});

/* ---------------------------------- DMARC --------------------------------- */

test('la política DMARC se lee con espacios alrededor de «=» y «;»', () => {
  assert.equal(politicaDmarc('v=DMARC1; p=reject'), 'reject');
  assert.equal(politicaDmarc('v=DMARC1; p = reject'), 'reject');
  assert.equal(politicaDmarc('v = DMARC1 ;p=Quarantine; rua=mailto:a@b.es'), 'quarantine');
  assert.equal(politicaDmarc('v=DMARC1;p=none'), 'none');
});

test('la política es la etiqueta p, no sp; sin una válida no hay política', () => {
  assert.equal(politicaDmarc('v=DMARC1; sp=none; p=reject'), 'reject');
  assert.equal(politicaDmarc('v=DMARC1; sp=reject'), null);
  assert.equal(politicaDmarc('v=DMARC1; p=rechazar'), null);
  assert.equal(politicaDmarc('v=DMARC1; rua=mailto:a@b.es'), null);
  assert.equal(politicaDmarc('p=reject; v=DMARC1'), null, 'v=DMARC1 tiene que ser la primera etiqueta');
  assert.equal(esDmarc('v=DMARC1'), true);
  assert.equal(esDmarc('v=spf1 mx -all'), false);
  assert.equal(etiquetasDmarc('v=DMARC1; p = reject ; p=none').get('p'), 'reject', 'manda la primera aparición');
});
