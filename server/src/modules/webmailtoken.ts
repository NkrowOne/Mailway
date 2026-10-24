import crypto from 'node:crypto';
import { config } from '../config';

/**
 * Secreto compartido entre Roundcube y el panel (cabecera X-Mailway-Token).
 * Comparación en tiempo constante (también en longitud, gracias al hash). Lo
 * usan las rutas /api/webmail/* del portal y las de las llaves de acceso.
 */
export function tokenWebmailValido(recibido: unknown): boolean {
  if (typeof recibido !== 'string' || !config.webmailToken) return false;
  const a = crypto.createHash('sha256').update(recibido).digest();
  const b = crypto.createHash('sha256').update(config.webmailToken).digest();
  return crypto.timingSafeEqual(a, b);
}
