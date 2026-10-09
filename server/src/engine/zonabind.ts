import type { EngineDnsRecord } from './types';

/**
 * Analizador de ficheros de zona BIND para los registros que propone Stalwart.
 *
 * En 0.15 el motor daba los registros en JSON (`[{type, name, content}]`); en
 * 0.16 solo los da como texto BIND (`Domain.dnsZoneFile`, serializado por el
 * crate dns-update 0.5.9):
 *
 *     cliente.com. IN MX 10 mail.ejemplo.com.
 *     v1-rsa-20261009._domainkey.cliente.com. IN TXT (
 *         "v=DKIM1; k=rsa; h=sha256; p=MIIBIjAN…"
 *         "…IDAQAB"
 *     )
 *
 * El resto del panel (comprobación DNS, fichero de zona, Cloudflare) trabaja
 * con la forma de 0.15, así que aquí se devuelve exactamente esa forma:
 * - el nombre tal cual, absoluto y con su punto final (`cliente.com.`);
 * - el contenido de MX, SRV y CNAME tal cual, con el punto final del destino;
 * - un TXT como UNA sola cadena, sin comillas y con los trozos de 255 bytes
 *   ya unidos: un DKIM de 2048 bits partido en dos llega entero, como lo daba
 *   0.15. Partirlo para publicarlo es cosa de quien lo publica (trocearTxt).
 *
 * No filtra nada: qué registros se piden al usuario lo decide el panel
 * (seleccionarRegistros). Acepta también lo que un serializador BIND normal
 * podría escribir (comentarios, `$ORIGIN`, `$TTL`, TTL y clase en cualquier
 * orden, nombres relativos o `@`), para no romperse si el motor cambia de
 * serializador.
 */

const CLASES = new Set(['IN', 'CH', 'HS', 'CS']);

/** Tipos de registro conocidos; además se acepta la forma genérica TYPEnnn. */
const TIPOS = new Set([
  'A', 'AAAA', 'AFSDB', 'APL', 'CAA', 'CDNSKEY', 'CDS', 'CERT', 'CNAME', 'CSYNC', 'DHCID', 'DLV',
  'DNAME', 'DNSKEY', 'DS', 'EUI48', 'EUI64', 'HINFO', 'HIP', 'HTTPS', 'IPSECKEY', 'KEY', 'KX', 'LOC',
  'MX', 'NAPTR', 'NS', 'NSEC', 'NSEC3', 'NSEC3PARAM', 'OPENPGPKEY', 'PTR', 'RP', 'RRSIG', 'SIG',
  'SMIMEA', 'SOA', 'SPF', 'SRV', 'SSHFP', 'SVCB', 'TA', 'TKEY', 'TLSA', 'TSIG', 'TXT', 'URI', 'ZONEMD',
]);

/** TTL en segundos (`3600`) o con unidades (`1h30m`). */
const TTL = /^(\d+[smhdw]?)+$/i;

interface Ficha {
  /** Texto del trozo: sin comillas si iba entrecomillado (ya sin escapes). */
  texto: string;
  /** Tal como venía en el fichero (con comillas y escapes). */
  original: string;
  entrecomillado: boolean;
}

/** Decodifica el contenido de una cadena entrecomillada (`\"`, `\\`, `\DDD`). */
function sinEscapes(crudo: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < crudo.length; i++) {
    const c = crudo[i]!;
    if (c === '\\' && i + 1 < crudo.length) {
      const resto = crudo.slice(i + 1, i + 4);
      if (/^\d{3}$/.test(resto)) {
        bytes.push(Number(resto) & 0xff);
        i += 3;
      } else {
        bytes.push(...Buffer.from(crudo[i + 1]!, 'utf8'));
        i += 1;
      }
      continue;
    }
    bytes.push(...Buffer.from(c, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Parte el fichero en registros lógicos (una línea, o varias unidas por
 * paréntesis) y cada uno en fichas. Los comentarios (`;` fuera de comillas)
 * se descartan. `continua` indica que la línea empezaba con espacio: hereda
 * el nombre del registro anterior.
 */
function registrosLogicos(texto: string): { fichas: Ficha[]; continua: boolean }[] {
  const salida: { fichas: Ficha[]; continua: boolean }[] = [];
  let fichas: Ficha[] = [];
  let continua = false;
  let profundidad = 0;
  let inicioDeRegistro = true;

  const cerrarRegistro = () => {
    if (fichas.length > 0) salida.push({ fichas, continua });
    fichas = [];
    inicioDeRegistro = true;
  };

  let i = 0;
  while (i < texto.length) {
    const c = texto[i]!;
    if (c === '\n' || c === '\r') {
      if (profundidad === 0) cerrarRegistro();
      i++;
      continue;
    }
    if (inicioDeRegistro) {
      // Primer carácter de una línea nueva (fuera de paréntesis).
      continua = c === ' ' || c === '\t';
      inicioDeRegistro = false;
    }
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === ';') {
      while (i < texto.length && texto[i] !== '\n') i++;
      continue;
    }
    if (c === '(') {
      profundidad++;
      i++;
      continue;
    }
    if (c === ')') {
      profundidad = Math.max(0, profundidad - 1);
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let crudo = '';
      while (j < texto.length && texto[j] !== '"') {
        if (texto[j] === '\\' && j + 1 < texto.length) {
          crudo += texto[j]! + texto[j + 1]!;
          j += 2;
          continue;
        }
        crudo += texto[j]!;
        j++;
      }
      fichas.push({ texto: sinEscapes(crudo), original: texto.slice(i, Math.min(j + 1, texto.length)), entrecomillado: true });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < texto.length && !/[\s;()"]/.test(texto[j]!)) j++;
    const palabra = texto.slice(i, j);
    fichas.push({ texto: palabra, original: palabra, entrecomillado: false });
    i = j;
  }
  cerrarRegistro();
  return salida;
}

function esTipo(valor: string): boolean {
  const v = valor.toUpperCase();
  return TIPOS.has(v) || /^TYPE\d+$/.test(v);
}

/** Nombre absoluto: `@` es el origen; uno relativo cuelga del origen si se conoce. */
function absoluto(nombre: string, origen: string | null): string {
  if (nombre === '@') return origen ?? nombre;
  if (nombre.endsWith('.') || !origen) return nombre;
  return origen === '.' ? `${nombre}.` : `${nombre}.${origen}`;
}

export function analizarZonaBind(texto: string): EngineDnsRecord[] {
  const registros: EngineDnsRecord[] = [];
  let origen: string | null = null;
  let anterior: string | null = null;

  for (const { fichas, continua } of registrosLogicos(texto)) {
    const primera = fichas[0]!;
    if (!primera.entrecomillado && primera.texto.startsWith('$')) {
      const directiva = primera.texto.toUpperCase();
      if (directiva === '$ORIGIN' && fichas[1]) {
        const valor = fichas[1].texto;
        origen = valor.endsWith('.') ? valor : `${valor}.`;
      }
      // $TTL, $INCLUDE y $GENERATE no cambian los nombres ni los datos.
      continue;
    }

    let pos = 0;
    let nombre: string | null;
    if (continua) {
      nombre = anterior;
    } else {
      nombre = absoluto(primera.texto, origen);
      pos = 1;
    }

    // TTL y clase opcionales, en cualquier orden, antes del tipo.
    while (pos < fichas.length) {
      const f = fichas[pos]!;
      if (f.entrecomillado) break;
      if (esTipo(f.texto) && !(CLASES.has(f.texto.toUpperCase()))) break;
      if (CLASES.has(f.texto.toUpperCase()) || TTL.test(f.texto)) {
        pos++;
        continue;
      }
      break;
    }
    const fichaTipo = fichas[pos];
    if (!nombre || !fichaTipo || fichaTipo.entrecomillado || !esTipo(fichaTipo.texto)) {
      // Línea que no se entiende: se ignora en vez de inventar un registro.
      continue;
    }
    anterior = nombre;
    const type = fichaTipo.texto.toUpperCase();
    const datos = fichas.slice(pos + 1);
    const content =
      type === 'TXT' || type === 'SPF'
        ? datos.map((d) => d.texto).join('')
        : datos.map((d) => (d.entrecomillado ? d.original : d.texto)).join(' ');
    registros.push({ type, name: nombre, content });
  }
  return registros;
}
