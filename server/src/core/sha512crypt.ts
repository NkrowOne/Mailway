import crypto from 'node:crypto';

/**
 * Implementación de crypt(3) con SHA-512 ($6$), según la especificación de
 * Ulrich Drepper (https://www.akkadia.org/drepper/SHA-crypt.txt).
 *
 * Stalwart no hashea las contraseñas recibidas por su API de gestión: espera
 * el hash ya calculado. Este formato ($6$) es el que genera su propia CLI.
 */

const B64_ALPHABET = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const DEFAULT_ROUNDS = 5000;

function sha512(...parts: Buffer[]): Buffer {
  const hash = crypto.createHash('sha512');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

/** Codificación base64 propia de crypt(3): little-endian por grupos de 3 bytes. */
function b64From24bit(b2: number, b1: number, b0: number, chars: number): string {
  let w = (b2 << 16) | (b1 << 8) | b0;
  let out = '';
  for (let i = 0; i < chars; i++) {
    out += B64_ALPHABET[w & 0x3f];
    w >>>= 6;
  }
  return out;
}

function encodeDigest(digest: Buffer): string {
  const order: [number, number, number, number][] = [
    [0, 21, 42, 4], [22, 43, 1, 4], [44, 2, 23, 4], [3, 24, 45, 4],
    [25, 46, 4, 4], [47, 5, 26, 4], [6, 27, 48, 4], [28, 49, 7, 4],
    [50, 8, 29, 4], [9, 30, 51, 4], [31, 52, 10, 4], [53, 11, 32, 4],
    [12, 33, 54, 4], [34, 55, 13, 4], [56, 14, 35, 4], [15, 36, 57, 4],
    [37, 58, 16, 4], [59, 17, 38, 4], [18, 39, 60, 4], [40, 61, 19, 4],
    [62, 20, 41, 4],
  ];
  let out = '';
  for (const [i2, i1, i0, chars] of order) {
    out += b64From24bit(digest[i2]!, digest[i1]!, digest[i0]!, chars);
  }
  // Último byte (63) se codifica solo, en 2 caracteres.
  out += b64From24bit(0, 0, digest[63]!, 2);
  return out;
}

export function sha512Crypt(password: string, saltInput?: string, rounds = DEFAULT_ROUNDS): string {
  const pwd = Buffer.from(password, 'utf8');
  const saltStr = (saltInput ?? crypto.randomBytes(12).toString('base64url').replace(/[^a-zA-Z0-9./]/g, '').slice(0, 16)).slice(0, 16);
  const salt = Buffer.from(saltStr, 'utf8');

  // Digest B = SHA512(password + salt + password)
  const digestB = sha512(pwd, salt, pwd);

  // Digest A = SHA512(password + salt + trozos de B)
  const aParts: Buffer[] = [pwd, salt];
  let remaining = pwd.length;
  while (remaining > 64) {
    aParts.push(digestB);
    remaining -= 64;
  }
  aParts.push(digestB.subarray(0, remaining));
  // Por cada bit de la longitud: 1 → B, 0 → password
  for (let bits = pwd.length; bits > 0; bits >>= 1) {
    aParts.push(bits & 1 ? digestB : pwd);
  }
  let digestA = sha512(...aParts);

  // DP = SHA512(password × longitud), P = truncado/repetido a longitud
  const dpParts: Buffer[] = [];
  for (let i = 0; i < pwd.length; i++) dpParts.push(pwd);
  const digestDP = sha512(...(dpParts.length ? dpParts : [Buffer.alloc(0)]));
  const p = Buffer.alloc(pwd.length);
  for (let i = 0; i < pwd.length; i += 64) {
    digestDP.copy(p, i, 0, Math.min(64, pwd.length - i));
  }

  // DS = SHA512(salt × (16 + primer byte de A)), S = truncado a longitud de salt
  const dsParts: Buffer[] = [];
  const dsCount = 16 + digestA[0]!;
  for (let i = 0; i < dsCount; i++) dsParts.push(salt);
  const digestDS = sha512(...dsParts);
  const s = Buffer.alloc(salt.length);
  for (let i = 0; i < salt.length; i += 64) {
    digestDS.copy(s, i, 0, Math.min(64, salt.length - i));
  }

  // Iteraciones (rounds): mezcla alternada de P, S y el digest anterior
  let digestC = digestA;
  for (let i = 0; i < rounds; i++) {
    const parts: Buffer[] = [];
    parts.push(i % 2 ? p : digestC);
    if (i % 3) parts.push(s);
    if (i % 7) parts.push(p);
    parts.push(i % 2 ? digestC : p);
    digestC = sha512(...parts);
  }

  const roundsPrefix = rounds === DEFAULT_ROUNDS ? '' : `rounds=${rounds}$`;
  return `$6$${roundsPrefix}${saltStr}$${encodeDigest(digestC)}`;
}
