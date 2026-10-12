import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { decryptSecret, encryptSecret, generateMailboxPassword, randomId } from '../core/crypto';
import { HttpError, badRequest, forbidden, tooMany } from '../core/errors';
import { withLock } from '../core/locks';
import { audit } from './audit';
import { getClient } from './clients';
import { cambiarContrasenaBuzon } from './credenciales';
import { publicBaseUrl } from './connection';
import { assertDomainOwnership } from './domains';
import {
  alCambiarContrasenaBuzon,
  buzonDelPanel,
  insertarEnlace,
  marcarBuzonConfigurado,
  olvidarBuzonConfigurado,
  purgarEnlaces,
  type FilaEnlace,
  type Titular,
} from './portal';
import { NOMBRE_REMITENTE_CONFIGURACION, asegurarRemitenteConfiguracion } from './remitente';
import { getEngineSettings, getInstanceSettings } from './settings';
import { describeSmtpError, getTransport } from './transactional';

/**
 * Entrega de la configuración al titular de un buzón.
 *
 * En la puesta en marcha, el cliente ve qué buzones ya ha configurado su
 * titular (configured_at) y puede enviar a cada uno, a la dirección que elija
 * (su correo personal, el de otro trabajo…), un correo con su enlace de
 * configuración. Sale de configuration@<dominio del buzón> con el nombre
 * «Configura tu correo» (ver remitente.ts) y no menciona la plataforma: el
 * correo es del cliente, con su nombre.
 *
 * La respuesta nunca lleva la URL ni el token del enlace, y el registro de
 * envíos y la actividad tampoco: el enlace solo viaja dentro del correo.
 */

/** Correos de configuración por buzón en una hora (sobra para reintentar una errata). */
export const MAX_ENVIOS_POR_BUZON = 5;
/** Y por cliente: una puesta en marcha de un equipo grande cabe de sobra. */
export const MAX_ENVIOS_POR_CLIENTE = 50;
const VENTANA_ENVIOS_MS = 3600_000;

/**
 * Un enlace que caduca antes de esto no se reutiliza: el titular puede tardar
 * en abrir el correo y no debe encontrarse un enlace caducado.
 */
const MARGEN_REUTILIZACION_MS = 24 * 3600_000;

/* ------------------------------ Límites ----------------------------------- */

/**
 * Envíos en curso (aún sin fila en envios_configuracion), por buzón y por
 * cliente. Sin ellos, varias peticiones simultáneas pasarían todas la
 * comprobación antes de que ninguna anotara su envío.
 */
const enCurso = new Map<string, number>();

function sumarEnCurso(clave: string, delta: number): void {
  const valor = (enCurso.get(clave) ?? 0) + delta;
  if (valor <= 0) enCurso.delete(clave);
  else enCurso.set(clave, valor);
}

function enviosRecientes(columna: 'mailbox_id' | 'client_id', valor: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS c FROM envios_configuracion WHERE ${columna} = ? AND created_at >= ?`)
      .get(valor, now() - VENTANA_ENVIOS_MS) as { c: number }
  ).c;
}

/**
 * Reserva un envío dentro de los límites por hora (los fallidos también
 * cuentan: reintentar sin fin contra un SMTP que falla no ayuda a nadie).
 * Devuelve la función que libera la reserva una vez anotado el envío.
 */
function reservarEnvio(mailboxId: string, clientId: string): () => void {
  const claveBuzon = `buzon:${mailboxId}`;
  const claveCliente = `cliente:${clientId}`;
  if (enviosRecientes('mailbox_id', mailboxId) + (enCurso.get(claveBuzon) ?? 0) >= MAX_ENVIOS_POR_BUZON) {
    throw tooMany(
      `Ya se han enviado ${MAX_ENVIOS_POR_BUZON} correos de configuración de este buzón en la última hora. Espera un poco antes de volver a enviarlo.`,
      'too_many_setup_emails',
    );
  }
  if (enviosRecientes('client_id', clientId) + (enCurso.get(claveCliente) ?? 0) >= MAX_ENVIOS_POR_CLIENTE) {
    throw tooMany(
      `Se han enviado ${MAX_ENVIOS_POR_CLIENTE} correos de configuración en la última hora. Espera un poco antes de enviar más.`,
      'too_many_setup_emails',
    );
  }
  sumarEnCurso(claveBuzon, 1);
  sumarEnCurso(claveCliente, 1);
  let liberada = false;
  return () => {
    if (liberada) return;
    liberada = true;
    sumarEnCurso(claveBuzon, -1);
    sumarEnCurso(claveCliente, -1);
  };
}

/* ------------------------------- Enlace ----------------------------------- */

interface EnlaceParaEnviar {
  id: string;
  url: string;
  expiresAt: number;
  hasPassword: boolean;
  reused: boolean;
}

/**
 * El enlace más reciente que se puede volver a enviar: activo durante al
 * menos un día más, recuperable (token cifrado) y, según lo pedido, con la
 * contraseña dentro o sin ella. Sin contraseña nunca se reutiliza uno que la
 * lleva: quien la excluye puede estar enviándolo a una dirección compartida.
 */
function enlaceReutilizable(
  req: FastifyRequest,
  titular: Titular,
  conContrasena: boolean,
): EnlaceParaEnviar | null {
  // Primero se vacían los enlaces muertos (token y contraseña cifrados).
  purgarEnlaces();
  const filas = db
    .prepare(
      `SELECT * FROM setup_links
       WHERE mailbox_id = ? AND revoked_at IS NULL AND expires_at > ? AND token_enc IS NOT NULL
         AND password_enc IS ${conContrasena ? 'NOT NULL' : 'NULL'}
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(titular.id, now() + MARGEN_REUTILIZACION_MS) as FilaEnlace[];
  for (const fila of filas) {
    try {
      const token = decryptSecret(fila.token_enc!);
      // Una contraseña que ya no se puede descifrar (clave maestra cambiada)
      // no llegaría a la página: ese enlace no sirve como «con contraseña».
      if (conContrasena) decryptSecret(fila.password_enc!);
      return {
        id: fila.id,
        url: `${publicBaseUrl(req)}/conectar/${token}`,
        expiresAt: fila.expires_at,
        hasPassword: conContrasena,
        reused: true,
      };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Enlace nuevo. Con contraseña hay que generarla: el panel no guarda la
 * actual en claro. Como el reinicio, deja sin acceso a los dispositivos que
 * usaban la anterior (las contraseñas de aplicación siguen valiendo).
 */
async function enlaceNuevo(
  req: FastifyRequest,
  titular: Titular,
  conContrasena: boolean,
  ttlHours: number,
): Promise<EnlaceParaEnviar> {
  if (!conContrasena) return { ...insertarEnlace(req, titular, null, ttlHours), reused: false };
  const password = generateMailboxPassword();
  await cambiarContrasenaBuzon(titular, password);
  alCambiarContrasenaBuzon(titular.id);
  olvidarBuzonConfigurado(titular.id);
  return { ...insertarEnlace(req, titular, encryptSecret(password), ttlHours), reused: false };
}

/* ------------------------------- Mensaje ---------------------------------- */

const FORMATO_FECHA = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Madrid',
});
const FORMATO_HORA = new Intl.DateTimeFormat('es-ES', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Europe/Madrid',
});

/** «15 de octubre de 2026 a las 10:30» (hora de España): con validez de horas, el día no basta. */
export function fechaLargaConfiguracion(t: number): string {
  return `${FORMATO_FECHA.format(t)} a las ${FORMATO_HORA.format(t)}`;
}

function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Una sola línea: los nombres los escribe la gente y pueden traer saltos. */
function enUnaLinea(texto: string): string {
  return texto.replace(/\s+/g, ' ').trim();
}

export interface DatosCorreoConfiguracion {
  /** Dirección del buzón que se configura. */
  email: string;
  displayName: string;
  url: string;
  expiresAt: number;
  hasPassword: boolean;
  clientName: string;
  /** Quien lo envía desde el panel; null si no hay nombre. */
  senderName: string | null;
}

/**
 * Asunto y cuerpos (texto y HTML) del correo de configuración. Todo lo que se
 * interpola en el HTML va escapado: el nombre del buzón, el del cliente y el
 * de quien lo envía los escribe la gente.
 */
export function componerCorreoConfiguracion(datos: DatosCorreoConfiguracion): {
  subject: string;
  text: string;
  html: string;
} {
  const nombre = enUnaLinea(datos.displayName).split(' ')[0] ?? '';
  const saludo = nombre ? `Hola, ${nombre}:` : 'Hola:';
  const cliente = enUnaLinea(datos.clientName);
  const remitente = datos.senderName ? enUnaLinea(datos.senderName) : '';
  // Sin punto final doble con nombres como «Talleres Ruiz S.L.».
  const conPunto = (frase: string): string => (frase.endsWith('.') ? frase : `${frase}.`);
  const firma = conPunto(remitente ? `Te lo envía ${remitente} desde ${cliente}` : `Te lo envía ${cliente}`);
  const instrucciones = datos.hasPassword
    ? 'Para usarlo en el móvil o en el ordenador, abre este enlace y sigue los pasos para tu dispositivo. La contraseña ya va incluida, así que solo lleva un par de minutos.'
    : 'Para usarlo en el móvil o en el ordenador, abre este enlace y sigue los pasos para tu dispositivo; necesitarás la contraseña de tu buzón.';
  const validez = `El enlace es personal y vale hasta el ${fechaLargaConfiguracion(datos.expiresAt)}.`;
  const aviso = datos.hasPassword ? ' Como incluye tu contraseña, no lo reenvíes a nadie.' : '';

  const text = [
    saludo,
    '',
    `Ya tienes tu buzón de correo ${datos.email}.`,
    '',
    instrucciones,
    '',
    datos.url,
    '',
    `${validez}${aviso}`,
    '',
    firma,
    '',
  ].join('\n');

  const e = escaparHtml;
  const fuente = "font-family:Arial,Helvetica,sans-serif;";
  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(NOMBRE_REMITENTE_CONFIGURACION)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f5f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f5f5;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#ffffff;border:1px solid #dde4e4;border-radius:8px;">
<tr><td style="padding:32px 32px 8px 32px;${fuente}font-size:16px;line-height:24px;color:#1c2727;">
<p style="margin:0 0 16px 0;">${e(saludo)}</p>
<p style="margin:0 0 16px 0;">Ya tienes tu buzón de correo <strong>${e(datos.email)}</strong>.</p>
<p style="margin:0 0 24px 0;">${e(instrucciones)}</p>
</td></tr>
<tr><td align="center" style="padding:0 32px 24px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" bgcolor="#0d5c5e" style="border-radius:6px;background-color:#0d5c5e;">
<a href="${e(datos.url)}" style="display:inline-block;padding:12px 28px;${fuente}font-size:16px;line-height:24px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;">Configurar mi correo</a>
</td>
</tr></table>
</td></tr>
<tr><td style="padding:0 32px 24px 32px;${fuente}font-size:13px;line-height:20px;color:#576767;">
<p style="margin:0 0 4px 0;">Si el botón no funciona, copia esta dirección en el navegador:</p>
<p style="margin:0;word-break:break-all;"><a href="${e(datos.url)}" style="color:#0d5c5e;">${e(datos.url)}</a></p>
</td></tr>
<tr><td style="padding:16px 32px 32px 32px;border-top:1px solid #dde4e4;${fuente}font-size:14px;line-height:22px;color:#1c2727;">
<p style="margin:0 0 12px 0;">${e(validez)}${e(aviso)}</p>
<p style="margin:0;color:#576767;">${e(firma)}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;

  return { subject: `${NOMBRE_REMITENTE_CONFIGURACION} ${datos.email}`, text, html };
}

/* -------------------------------- Rutas ----------------------------------- */

const envioSchema = z.object({
  to: z
    .string({ required_error: 'Indica el correo al que enviar la configuración.' })
    .trim()
    .toLowerCase()
    .max(254, 'Introduce una dirección de correo válida.')
    .email('Introduce una dirección de correo válida.'),
  includePassword: z.boolean().optional().default(true),
  ttlHours: z
    .number()
    .int('La validez debe indicarse en horas enteras.')
    .min(1, 'La validez mínima del enlace es de 1 hora.')
    .max(720, 'La validez máxima del enlace es de 720 horas (30 días).')
    .optional()
    .default(168),
});

const marcaSchema = z.object({
  configured: z.boolean({
    required_error: 'Indica si el buzón está configurado.',
    invalid_type_error: 'Indica si el buzón está configurado.',
  }),
});

/** Dirección de quien envía, para que el titular pueda contestarle; solo si parece válida. */
function responderA(req: FastifyRequest): string | undefined {
  const email = req.user?.email?.trim();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

export function registerSetupEmailRoutes(app: FastifyInstance): void {
  /**
   * Marca a mano un buzón como configurado (o no): el titular puso los datos
   * a mano en su programa de correo y el panel no tiene forma de saberlo.
   */
  app.post('/api/mailboxes/:id/configured', async (req) => {
    const { id } = req.params as { id: string };
    const titular = buzonDelPanel(req, id);
    const body = marcaSchema.parse(req.body ?? {});
    if (body.configured) marcarBuzonConfigurado(titular.id);
    else olvidarBuzonConfigurado(titular.id);
    const row = db.prepare('SELECT configured_at FROM mailboxes WHERE id = ?').get(titular.id) as
      | { configured_at: number | null }
      | undefined;
    audit(
      req,
      'mailbox.marked_configured',
      { mailboxId: titular.id, email: titular.email, configured: body.configured },
      titular.clientId,
    );
    return { configuredAt: row?.configured_at ?? null };
  });

  /** Envía al titular, a la dirección indicada, un correo con su enlace de configuración. */
  app.post('/api/mailboxes/:id/setup-email', async (req) => {
    const { id } = req.params as { id: string };
    const titular = buzonDelPanel(req, id);
    const body = envioSchema.parse(req.body ?? {});

    // Igual que /v1/send: con el cliente suspendido no sale correo suyo.
    const client = getClient(titular.clientId);
    if (client.suspended) {
      throw forbidden(
        'La cuenta del cliente está suspendida: no se pueden enviar correos de configuración.',
        'client_suspended',
      );
    }
    if (titular.suspendido) {
      throw badRequest(
        'El buzón está suspendido. Reactívalo antes de enviar su configuración.',
        'mailbox_suspended',
      );
    }
    // El remitente es una cuenta del dominio: nunca en uno sin propiedad probada.
    assertDomainOwnership(titular.domainId);
    if (body.to === titular.email.toLowerCase()) {
      throw badRequest(
        'El buzón aún no está configurado en ningún sitio: envía el enlace a otro correo de esa persona.',
        'setup_email_same_mailbox',
      );
    }
    const engineSettings = getEngineSettings();
    if (!engineSettings) {
      throw new HttpError(
        503,
        'El servidor de correo aún no está configurado, así que no se puede enviar la configuración. Copia el enlace y envíalo tú.',
        'engine_not_configured',
      );
    }

    const liberar = reservarEnvio(titular.id, titular.clientId);
    try {
      // El remitente va antes que el enlace: si no se puede enviar (dirección
      // ocupada, motor caído), la contraseña del titular no se ha tocado.
      const remitente = await asegurarRemitenteConfiguracion({ id: titular.domainId, domain: titular.domain });
      // En la misma fila que el reinicio y las contraseñas de aplicación: dos
      // envíos a la vez no generan dos contraseñas (el segundo reutiliza el
      // enlace del primero).
      const enlace = await withLock(
        `contrasenas-app:${titular.id}`,
        async () =>
          enlaceReutilizable(req, titular, body.includePassword) ??
          (await enlaceNuevo(req, titular, body.includePassword, body.ttlHours)),
      );

      const mensaje = componerCorreoConfiguracion({
        email: titular.email,
        displayName: titular.displayName,
        url: enlace.url,
        expiresAt: enlace.expiresAt,
        hasPassword: enlace.hasPassword,
        clientName: client.name,
        senderName: req.user?.name?.trim() || null,
      });

      let status: 'sent' | 'failed' = 'sent';
      let error = '';
      // En demostración no hay SMTP: el envío se da por hecho, como en /v1/send.
      if (engineSettings.kind !== 'demo') {
        const { mailHostname } = getInstanceSettings();
        try {
          const transport = getTransport(
            `config:${titular.domainId}`,
            // La cuenta remitente no es un buzón: entra con su dirección.
            { usuario: remitente.email, remitente: remitente.email },
            remitente.password,
            engineSettings,
            mailHostname,
          );
          await transport.sendMail({
            from: { name: NOMBRE_REMITENTE_CONFIGURACION, address: remitente.email },
            to: body.to,
            replyTo: responderA(req),
            subject: mensaje.subject,
            text: mensaje.text,
            html: mensaje.html,
          });
        } catch (err) {
          status = 'failed';
          error = describeSmtpError(err, mailHostname || engineSettings.smtpHost);
          req.log.warn({ err, mailboxId: titular.id }, 'Correo de configuración rechazado por el SMTP del motor');
        }
      }

      const at = now();
      db.prepare(
        `INSERT INTO envios_configuracion (id, mailbox_id, client_id, recipient, status, error, link_id, sent_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomId('ecf'),
        titular.id,
        titular.clientId,
        body.to,
        status,
        error.slice(0, 300),
        enlace.id,
        req.user?.id ?? null,
        at,
      );
      audit(
        req,
        status === 'sent' ? 'mailbox.setup_email_sent' : 'mailbox.setup_email_failed',
        {
          mailboxId: titular.id,
          email: titular.email,
          to: body.to,
          linkId: enlace.id,
          reused: enlace.reused,
          hasPassword: enlace.hasPassword,
        },
        titular.clientId,
      );

      if (status === 'failed') {
        throw new HttpError(
          502,
          `No se ha podido enviar el correo de configuración: ${error.replace(/[.\s]+$/, '')}. Vuelve a intentarlo en unos minutos (se enviará el mismo enlace) o copia el enlace y envíalo tú.`,
          'setup_email_failed',
        );
      }
      return {
        sent: { to: body.to, at, status: 'sent' as const },
        link: { expiresAt: enlace.expiresAt, hasPassword: enlace.hasPassword },
        reused: enlace.reused,
      };
    } finally {
      liberar();
    }
  });
}
