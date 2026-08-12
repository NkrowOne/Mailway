import crypto from 'node:crypto';
import { config } from '../config';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

/** Hash de contraseñas de usuarios del panel (scrypt, sal aleatoria). */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(expected, actual);
}

function encryptionKey(): Buffer {
  return crypto.createHash('sha256').update(`mailway-enc:${config.secret}`).digest();
}

/** Cifrado AES-256-GCM para secretos que hay que recuperar (SMTP, motor). */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptSecret(stored: string): string {
  const [version, ivHex, tagHex, dataHex] = stored.split(':');
  if (version !== 'v1' || !ivHex || !tagHex || !dataHex) {
    throw new Error('Secreto cifrado con formato desconocido');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

/** Token de sesión opaco; en BD solo se guarda su hash. */
export function newSessionToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHmac('sha256', config.secret).update(token).digest('hex');
}

/**
 * Clave de API transaccional: `mw_<prefijo>_<secreto>`. El prefijo viaja en
 * claro para poder localizar la clave; el secreto solo se guarda hasheado.
 */
export function newApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = crypto.randomBytes(4).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');
  const key = `mw_${prefix}_${secret}`;
  return { key, prefix, hash: hashToken(key) };
}

/** Contraseña aleatoria legible para buzones (sin caracteres ambiguos). */
export function generateMailboxPassword(length = 16): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  while (out.length < length) {
    const byte = crypto.randomBytes(1)[0]!;
    if (byte < Math.floor(256 / alphabet.length) * alphabet.length) {
      out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}
