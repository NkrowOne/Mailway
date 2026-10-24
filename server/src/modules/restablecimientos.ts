import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { hashPassword, hashToken, randomId } from '../core/crypto';
import { HttpError, badRequest, forbidden, notFound, tooMany } from '../core/errors';
import { audit } from './audit';
import { createSession, requireAdmin } from './auth';
import { getClient } from './clients';
import { enUnaLinea, escaparHtml, fechaLargaConfiguracion } from './envioconfiguracion';
import { baseDelCliente, crearLimitador } from './invitaciones';
import { asegurarRemitenteConfiguracion } from './remitente';
import { getEngineSettings, getInstanceSettings } from './settings';
import { describeSmtpError, forgetTransport, getTransport } from './transactional';

/**
 * Restablecer el acceso al panel de un usuario de un cliente.
 *
 * Cuando alguien olvida su contraseña del panel, la administración le envía
 * por correo (a su propio correo o a otro que indique) un enlace para elegir
 * una contraseña nueva: así nadie le dicta una ni la ve. El enlace sirve una
 * sola vez, caduca pronto y el nuevo sustituye a los anteriores. Al usarlo se
 * cierran las sesiones abiertas con la contraseña anterior y se entra en el
 * panel con la nueva.
 *
 * El correo sale de configuration@<dominio del cliente> (la cuenta remitente
 * de remitente.ts), que ya pasa SPF, DKIM y DMARC con los registros del
 * cliente. Si no se puede enviar (sin dominio con propiedad comprobada, SMTP
 * caído), la administración recibe igualmente el enlace para enviarlo ella.
 *
 * Solo se guarda el hash del token: la URL se devuelve una única vez.
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const MIN_CONTRASENA = 10;

/** Envíos por usuario en una hora: sobra para corregir una dirección mal escrita. */
export const MAX_RESTABLECIMIENTOS_POR_USUARIO = 5;
const VENTANA_MS = 3600_000;

/** Nombre visible del remitente: el correo no habla de buzones, sino del panel. */
const NOMBRE_REMITENTE = 'Acceso al panel';

interface FilaRestablecimiento {
  id: string;
  user_id: string;
  client_id: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
}

interface UsuarioCliente {
  id: string;
  email: string;
  name: string;
  disabled: number;
  client_id: string;
}

function enlaceNoValido(): HttpError {
  return new HttpError(
    404,
    'Este enlace para restablecer la contraseña no es válido o ha caducado. Solicita uno nuevo a tu proveedor de correo.',
    'reset_invalid',
  );
}

function usuarioDelCliente(clientId: string, userId: string): UsuarioCliente {
  const row = db
    .prepare(`SELECT id, email, name, disabled, client_id FROM users WHERE id = ? AND client_id = ? AND role = 'client'`)
    .get(userId, clientId) as UsuarioCliente | undefined;
  if (!row) throw notFound('Usuario no encontrado.');
  return row;
}

/** Busca el enlace por su token y comprueba que se puede usar. */
function restablecimientoPorToken(token: string): { fila: FilaRestablecimiento; usuario: UsuarioCliente } {
  if (!TOKEN_RE.test(token)) throw enlaceNoValido();
  const fila = db
    .prepare('SELECT * FROM panel_password_resets WHERE token_hash = ?')
    .get(hashToken(token)) as FilaRestablecimiento | undefined;
  if (!fila || fila.used_at || fila.revoked_at || fila.expires_at <= now()) throw enlaceNoValido();
  // Se vuelve a mirar el usuario: puede haberse borrado o cambiado de cliente.
  const usuario = db
    .prepare(`SELECT id, email, name, disabled, client_id FROM users WHERE id = ? AND role = 'client'`)
    .get(fila.user_id) as UsuarioCliente | undefined;
  if (!usuario || usuario.client_id !== fila.client_id) throw enlaceNoValido();
  if (getClient(fila.client_id).suspended) {
    throw forbidden(
      'La cuenta de tu empresa está suspendida. Ponte en contacto con tu proveedor de correo.',
      'client_suspended',
    );
  }
  if (usuario.disabled) {
    throw forbidden(
      'Tu acceso al panel está deshabilitado. Ponte en contacto con tu proveedor de correo.',
      'user_disabled',
    );
  }
  return { fila, usuario };
}

/**
 * Dominio del cliente desde el que sale el correo: uno con la propiedad
 * comprobada (la cuenta remitente nunca se crea en otro). Primero el del
 * propio usuario, después el del destinatario y, si no, el más antiguo.
 */
function dominioRemitente(clientId: string, preferidos: string[]): { id: string; domain: string } | null {
  const filas = db
    .prepare(
      `SELECT id, domain FROM domains
       WHERE client_id = ? AND owner_verified_at IS NOT NULL
       ORDER BY created_at ASC`,
    )
    .all(clientId) as { id: string; domain: string }[];
  for (const preferido of preferidos) {
    const fila = filas.find((f) => f.domain.toLowerCase() === preferido.toLowerCase());
    if (fila) return fila;
  }
  return filas[0] ?? null;
}

function dominioDe(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

export interface DatosCorreoRestablecimiento {
  /** Usuario del panel (su correo de acceso). */
  email: string;
  name: string;
  url: string;
  expiresAt: number;
  clientName: string;
  brandName: string;
}

/**
 * Asunto y cuerpos del correo. Todo lo que se interpola en el HTML va
 * escapado: los nombres los escribe la gente.
 */
export function componerCorreoRestablecimiento(datos: DatosCorreoRestablecimiento): {
  subject: string;
  text: string;
  html: string;
} {
  const nombre = enUnaLinea(datos.name).split(' ')[0] ?? '';
  const saludo = nombre ? `Hola, ${nombre}:` : 'Hola:';
  const cliente = enUnaLinea(datos.clientName);
  const marca = enUnaLinea(datos.brandName);
  const intro = `Se ha recibido una solicitud para restablecer tu contraseña del panel de correo de ${cliente}. Tu usuario es ${datos.email}.`;
  const instrucciones = 'Para elegir una contraseña nueva, abre este enlace:';
  const validez = `El enlace es personal, solo se puede usar una vez y es válido hasta el ${fechaLargaConfiguracion(datos.expiresAt)}.`;
  const ignorar = 'Si no has pedido este cambio, ignora este mensaje: tu contraseña actual seguirá funcionando.';
  const firma = marca ? `Te lo envía ${marca}.` : '';

  const text = [saludo, '', intro, '', instrucciones, '', datos.url, '', validez, '', ignorar, '', firma, '']
    .filter((linea, i, todas) => !(linea === '' && todas[i - 1] === ''))
    .join('\n');

  const e = escaparHtml;
  const fuente = 'font-family:Arial,Helvetica,sans-serif;';
  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Restablecer tu contraseña</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f5f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f5f5;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#ffffff;border:1px solid #dde4e4;border-radius:8px;">
<tr><td style="padding:32px 32px 8px 32px;${fuente}font-size:16px;line-height:24px;color:#1c2727;">
<p style="margin:0 0 16px 0;">${e(saludo)}</p>
<p style="margin:0 0 16px 0;">Se ha recibido una solicitud para restablecer tu contraseña del panel de correo de ${e(cliente)}. Tu usuario es <strong>${e(datos.email)}</strong>.</p>
<p style="margin:0 0 24px 0;">${e(instrucciones)}</p>
</td></tr>
<tr><td align="center" style="padding:0 32px 24px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" bgcolor="#0d5c5e" style="border-radius:6px;background-color:#0d5c5e;">
<a href="${e(datos.url)}" style="display:inline-block;padding:12px 28px;${fuente}font-size:16px;line-height:24px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;">Elegir contraseña nueva</a>
</td>
</tr></table>
</td></tr>
<tr><td style="padding:0 32px 24px 32px;${fuente}font-size:13px;line-height:20px;color:#576767;">
<p style="margin:0 0 4px 0;">Si el botón no funciona, copia esta dirección en el navegador:</p>
<p style="margin:0;word-break:break-all;"><a href="${e(datos.url)}" style="color:#0d5c5e;">${e(datos.url)}</a></p>
</td></tr>
<tr><td style="padding:16px 32px 32px 32px;border-top:1px solid #dde4e4;${fuente}font-size:14px;line-height:22px;color:#1c2727;">
<p style="margin:0 0 12px 0;">${e(validez)}</p>
<p style="margin:0 0 12px 0;">${e(ignorar)}</p>
${firma ? `<p style="margin:0;color:#576767;">${e(firma)}</p>` : ''}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;

  return { subject: `Restablecer tu contraseña del panel de ${cliente}`, text, html };
}

/**
 * Envía el correo. Devuelve el error legible si no ha salido; nunca lanza:
 * aunque falle, la administración se queda con el enlace para enviarlo ella.
 */
async function enviarCorreo(
  req: FastifyRequest,
  clientId: string,
  usuario: UsuarioCliente,
  to: string,
  mensaje: { subject: string; text: string; html: string },
): Promise<string> {
  const ajustes = getEngineSettings();
  if (!ajustes) return 'el servidor de correo aún no está configurado';
  const dominio = dominioRemitente(clientId, [dominioDe(usuario.email), dominioDe(to)]);
  if (!dominio) return 'el cliente no tiene ningún dominio con la propiedad comprobada desde el que enviarlo';
  // En demostración no hay SMTP: el envío se da por hecho, como en /v1/send.
  if (ajustes.kind === 'demo') return '';
  const { mailHostname } = getInstanceSettings();
  const clave = `restablecer:${dominio.id}`;
  try {
    const remitente = await asegurarRemitenteConfiguracion(dominio);
    const transporte = getTransport(
      clave,
      { usuario: remitente.email, remitente: remitente.email },
      remitente.password,
      ajustes,
      mailHostname,
    );
    await transporte.sendMail({
      from: { name: NOMBRE_REMITENTE, address: remitente.email },
      to,
      subject: mensaje.subject,
      text: mensaje.text,
      html: mensaje.html,
    });
    return '';
  } catch (err) {
    req.log.warn({ err, userId: usuario.id }, 'Correo para restablecer el acceso al panel no enviado');
    if (err instanceof HttpError) return err.message.replace(/[.\s]+$/, '');
    return describeSmtpError(err, mailHostname || ajustes.smtpHost).replace(/[.\s]+$/, '');
  } finally {
    // Son envíos sueltos: no se deja la conexión SMTP abierta.
    forgetTransport(clave);
  }
}

const envioSchema = z.object({
  to: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, 'Introduce una dirección de correo válida.')
    .email('Introduce una dirección de correo válida.')
    .optional(),
  ttlHours: z
    .number()
    .int('La validez debe indicarse en horas enteras.')
    .min(1, 'La validez mínima del enlace es de 1 hora.')
    .max(168, 'La validez máxima del enlace es de 168 horas (7 días).')
    .optional()
    .default(24),
});

const usarSchema = z.object({
  password: z
    .string({ required_error: 'Elige una contraseña.' })
    .min(MIN_CONTRASENA, `La contraseña debe tener al menos ${MIN_CONTRASENA} caracteres.`)
    .max(200, 'La contraseña no puede superar los 200 caracteres.'),
});

export function registerPasswordResetRoutes(app: FastifyInstance): void {
  const limite = crearLimitador(60, 60_000);
  function limitar(req: FastifyRequest): void {
    if (!limite(req.ip || '')) {
      throw tooMany('Se han realizado demasiadas peticiones. Espera un minuto y vuelve a intentarlo.');
    }
  }

  /* ---------------------------- Administración ---------------------------- */

  app.post('/api/clients/:id/users/:userId/password-reset', async (req, reply) => {
    const admin = requireAdmin(req);
    const { id, userId } = req.params as { id: string; userId: string };
    const client = getClient(id);
    const usuario = usuarioDelCliente(id, userId);
    const body = envioSchema.parse(req.body ?? {});
    if (client.suspended) {
      throw badRequest('El cliente está suspendido. Reactívalo antes de restablecer el acceso de sus usuarios.', 'client_suspended');
    }
    if (usuario.disabled) {
      throw badRequest('El usuario está deshabilitado. Habilítalo antes de enviarle el enlace.', 'user_disabled');
    }
    const to = body.to ?? usuario.email.toLowerCase();

    const t = now();
    const recientes = (
      db
        .prepare('SELECT COUNT(*) AS c FROM panel_password_resets WHERE user_id = ? AND created_at >= ?')
        .get(userId, t - VENTANA_MS) as { c: number }
    ).c;
    if (recientes >= MAX_RESTABLECIMIENTOS_POR_USUARIO) {
      throw tooMany(
        `Ya se han enviado ${MAX_RESTABLECIMIENTOS_POR_USUARIO} enlaces a este usuario en la última hora. Vuelve a intentarlo más tarde.`,
      );
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const resetId = randomId('rst');
    const expiresAt = t + body.ttlHours * 3600_000;
    const url = `${baseDelCliente(req, id)}/restablecer/${token}`;
    // La fila se crea antes de enviar: el enlace del correo ya funciona
    // cuando llega, y el nuevo sustituye a los pendientes.
    db.transaction(() => {
      db.prepare(
        `UPDATE panel_password_resets SET revoked_at = ?
         WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      ).run(t, userId);
      db.prepare(
        `INSERT INTO panel_password_resets (id, user_id, client_id, token_hash, recipient, status, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'sent', ?, ?, ?)`,
      ).run(resetId, userId, id, hashToken(token), to, admin.id, t, expiresAt);
    })();

    const mensaje = componerCorreoRestablecimiento({
      email: usuario.email,
      name: usuario.name,
      url,
      expiresAt,
      clientName: client.name,
      brandName: getInstanceSettings().brandName,
    });
    const error = await enviarCorreo(req, id, usuario, to, mensaje);
    const status = error ? ('failed' as const) : ('sent' as const);
    db.prepare('UPDATE panel_password_resets SET status = ?, error = ? WHERE id = ?').run(
      status,
      error.slice(0, 300),
      resetId,
    );
    audit(
      req,
      status === 'sent' ? 'client.user_password_reset_sent' : 'client.user_password_reset_failed',
      { clientId: id, userId, email: usuario.email, to, resetId },
      id,
    );
    reply.header('Cache-Control', 'no-store');
    return {
      reset: {
        id: resetId,
        // Solo aquí y una vez: si el correo no sale, la administración lo envía.
        url,
        email: usuario.email,
        to,
        expiresAt,
        status,
        error: error || undefined,
      },
    };
  });

  /* ------------------------------- Público -------------------------------- */

  // Fuera de /api/public/ a propósito: usarlo abre una sesión del panel, así
  // que pasa por la protección CSRF de siempre (solo desde el propio panel).
  app.get('/api/password-reset/:token', async (req, reply) => {
    limitar(req);
    const { token } = req.params as { token: string };
    const { fila, usuario } = restablecimientoPorToken(token);
    reply.header('Cache-Control', 'no-store');
    return {
      email: usuario.email,
      name: usuario.name,
      clientName: getClient(fila.client_id).name,
      brandName: getInstanceSettings().brandName,
      expiresAt: fila.expires_at,
    };
  });

  app.post('/api/password-reset/:token', async (req, reply) => {
    limitar(req);
    const { token } = req.params as { token: string };
    const body = usarSchema.parse(req.body ?? {});
    // Comprobación y cambio en una transacción: dos clics seguidos no usan
    // el mismo enlace dos veces.
    const usuario = db.transaction(() => {
      const { fila, usuario } = restablecimientoPorToken(token);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.password), usuario.id);
      // Fuera las sesiones abiertas con la contraseña anterior (la de este
      // navegador se abre después).
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(usuario.id);
      db.prepare('UPDATE panel_password_resets SET used_at = ? WHERE id = ?').run(now(), fila.id);
      return { id: usuario.id, email: usuario.email, clientId: fila.client_id, resetId: fila.id };
    })();
    createSession(req, reply, usuario.id);
    // audit() toma el actor de la sesión de la petición, que aún no existía.
    db.prepare(
      `INSERT INTO audit_log (user_id, client_id, action, detail, ip, created_at)
       VALUES (?, ?, 'client.user_password_reset_used', ?, ?, ?)`,
    ).run(
      usuario.id,
      usuario.clientId,
      JSON.stringify({ resetId: usuario.resetId, email: usuario.email }),
      req.ip || '',
      now(),
    );
    return { ok: true, redirect: '/' };
  });
}
