import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { badRequest, notFound } from '../core/errors';
import { tipoDeImagen } from '../core/imagenes';
import { getEngine } from '../engine';
import { audit } from './audit';
import { requireMailboxAccess } from './mailboxes';

/**
 * Perfil del buzón: nombre visible y foto. El titular los pone en el
 * onboarding (enlace de configuración) o en «Mi buzón», y quien administra
 * desde la ficha del buzón; el webmail usa el nombre para la identidad del
 * remitente y la foto como avatar. Aquí viven la validación, el
 * almacenamiento y la forma de servir la imagen, para que las tres vías
 * (panel, portal y enlace) se comporten igual.
 */

/**
 * La web la reduce a 256×256 JPEG (unos 20-40 KB) antes de subirla; el tope
 * deja margen a otros clientes de la API sin dejar que la base crezca con
 * fotos de varios megas.
 */
export const MAX_FOTO_BYTES = 512 * 1024;

/** Data URL de la foto: base64 de MAX_FOTO_BYTES más la cabecera. */
export const fotoSchema = z.object({
  photo: z.string().max(Math.ceil((MAX_FOTO_BYTES * 4) / 3) + 100),
});

export const nombreSchema = z.object({
  displayName: z.string().trim().max(80, 'El nombre visible no puede superar los 80 caracteres.'),
});

export interface Foto {
  mime: string;
  data: Buffer;
  updatedAt: number;
}

function fotoNoValida() {
  return badRequest(
    'La foto debe ser una imagen JPEG, PNG o WebP. Prueba con otra imagen.',
    'invalid_photo',
  );
}

/**
 * Decodifica y valida el data URL; lanza el error adecuado para la interfaz.
 * El tipo sale de los bytes (core/imagenes.ts), no del declarado: una
 * «imagen» que fuera HTML o SVG se serviría desde el dominio del panel.
 */
export function decodificarFoto(dataUrl: string): { mime: string; data: Buffer } {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(dataUrl.trim());
  if (!match) throw fotoNoValida();
  const data = Buffer.from(match[1]!, 'base64');
  if (data.length > MAX_FOTO_BYTES) {
    throw badRequest('La foto ocupa demasiado: el máximo es de 512 KB.', 'photo_too_large');
  }
  const mime = tipoDeImagen(data);
  if (!mime) throw fotoNoValida();
  return { mime, data };
}

export function leerFoto(mailboxId: string): Foto | null {
  const row = db
    .prepare('SELECT mime, data, updated_at FROM mailbox_photos WHERE mailbox_id = ?')
    .get(mailboxId) as { mime: string; data: Buffer; updated_at: number } | undefined;
  return row ? { mime: row.mime, data: row.data, updatedAt: row.updated_at } : null;
}

export function fechaFoto(mailboxId: string): number | null {
  const row = db.prepare('SELECT updated_at FROM mailbox_photos WHERE mailbox_id = ?').get(mailboxId) as
    | { updated_at: number }
    | undefined;
  return row?.updated_at ?? null;
}

/** Guarda (o sustituye) la foto y devuelve su fecha, que va en las URL. */
export function guardarFoto(mailboxId: string, dataUrl: string): number {
  const { mime, data } = decodificarFoto(dataUrl);
  // Estrictamente creciente: dos cambios en el mismo milisegundo darían la
  // misma URL y el navegador seguiría mostrando la foto anterior.
  const anterior = fechaFoto(mailboxId) ?? 0;
  const t = Math.max(now(), anterior + 1);
  db.prepare(
    `INSERT INTO mailbox_photos (mailbox_id, mime, data, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(mailbox_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
  ).run(mailboxId, mime, data, t);
  return t;
}

/** true si había foto. */
export function borrarFoto(mailboxId: string): boolean {
  return db.prepare('DELETE FROM mailbox_photos WHERE mailbox_id = ?').run(mailboxId).changes > 0;
}

/**
 * Sirve la imagen. `nosniff` y la CSP vacía impiden que el navegador la
 * interprete como otra cosa aunque alguien lograra colar bytes extraños;
 * la caché es privada porque la ruta exige sesión o el token del enlace.
 */
export function enviarFoto(reply: FastifyReply, foto: Foto | null): FastifyReply {
  if (!foto) throw notFound('Este buzón no tiene foto.', 'photo_not_found');
  return reply
    .header('Content-Type', foto.mime)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', "default-src 'none'")
    .header('Content-Disposition', 'inline')
    .header('Cache-Control', 'private, max-age=300')
    .send(foto.data);
}

/**
 * Cambia el nombre visible en el motor y en la base. Lo usan «Mi buzón» y el
 * enlace de configuración; el panel lo hace en su PATCH junto con la cuota y
 * el estado, en una sola llamada al motor.
 */
export async function cambiarNombreVisible(
  mailbox: { id: string; email: string; displayName: string },
  nombre: string,
): Promise<boolean> {
  if (nombre === mailbox.displayName) return false;
  // Primero el motor: si no responde, la base sigue diciendo lo mismo que él.
  await getEngine().updateMailbox(mailbox.email, { displayName: nombre });
  db.prepare('UPDATE mailboxes SET display_name = ? WHERE id = ?').run(nombre, mailbox.id);
  return true;
}

/** Rutas del panel (administración y usuarios del cliente dueño del buzón). */
export function registerProfileRoutes(app: FastifyInstance): void {
  app.get('/api/mailboxes/:id/photo', async (req, reply) => {
    const { id } = req.params as { id: string };
    requireMailboxAccess(req, id);
    return enviarFoto(reply, leerFoto(id));
  });

  app.put('/api/mailboxes/:id/photo', async (req) => {
    const { id } = req.params as { id: string };
    const { mailbox, domain } = requireMailboxAccess(req, id);
    const body = fotoSchema.parse(req.body ?? {});
    const photoUpdatedAt = guardarFoto(id, body.photo);
    audit(req, 'mailbox.photo_updated', { id, email: mailbox.email }, domain.clientId);
    return { photoUpdatedAt };
  });

  app.delete('/api/mailboxes/:id/photo', async (req) => {
    const { id } = req.params as { id: string };
    const { mailbox, domain } = requireMailboxAccess(req, id);
    if (borrarFoto(id)) audit(req, 'mailbox.photo_removed', { id, email: mailbox.email }, domain.clientId);
    return { ok: true };
  });
}
