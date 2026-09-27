import crypto from 'node:crypto';
import net from 'node:net';
import type { ConnectionOptions } from 'node:tls';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool';
import { z } from 'zod';
import { db, now } from '../core/db';
import {
  decryptSecret,
  encryptSecret,
  generateMailboxPassword,
  hashToken,
  newApiKey,
  randomId,
} from '../core/crypto';
import { badRequest, conflict, forbidden, notFound, tooMany, unauthorized } from '../core/errors';
import { getEngine } from '../engine';
import type { EngineSettings } from '../engine/types';
import { getEngineSettings, getInstanceSettings } from './settings';
import { audit } from './audit';
import { requireAuth, requireClientAccess } from './auth';
import { getClient, getPlan } from './clients';
import { getMailbox, type Mailbox } from './mailboxes';

/* ------------------------------ Claves de API ----------------------------- */

export interface ApiKeyInfo {
  id: string;
  clientId: string;
  name: string;
  prefix: string;
  senderMailboxId: string;
  senderEmail: string;
  dailyLimit: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  usedToday: number;
}

interface ApiKeyRow {
  id: string;
  client_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  sender_mailbox_id: string;
  smtp_password_enc: string;
  daily_limit: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  created_at: number;
}

/** Credenciales SMTP de una clave: { plain, stored } cifradas en la BD. */
function parseSmtpCredentials(encrypted: string): { plain: string; stored: string } {
  const raw = decryptSecret(encrypted);
  try {
    const parsed = JSON.parse(raw) as { plain?: string; stored?: string };
    return { plain: parsed.plain || '', stored: parsed.stored || '' };
  } catch {
    // Formato antiguo: solo la contraseña en claro.
    return { plain: raw, stored: '' };
  }
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function usedToday(keyId: string): number {
  const row = db
    .prepare('SELECT count FROM api_usage WHERE api_key_id = ? AND day = ?')
    .get(keyId, todayKey()) as { count: number } | undefined;
  return row?.count ?? 0;
}

/**
 * Reserva un envío del cupo diario de forma atómica y devuelve el nuevo total.
 * El incremento y la comprobación deben ser síncronos (sin await entre medias)
 * para que peticiones concurrentes no superen el límite: better-sqlite3 es
 * síncrono, así que este INSERT…RETURNING no cede el event loop.
 */
function reserveDailyUsage(keyId: string): number {
  const row = db
    .prepare(
      `INSERT INTO api_usage (api_key_id, day, count) VALUES (?, ?, 1)
       ON CONFLICT(api_key_id, day) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .get(keyId, todayKey()) as { count: number };
  return row.count;
}

/** Devuelve al cupo una reserva que finalmente se rechaza por exceder el límite. */
function releaseDailyUsage(keyId: string): void {
  db.prepare(
    'UPDATE api_usage SET count = count - 1 WHERE api_key_id = ? AND day = ? AND count > 0',
  ).run(keyId, todayKey());
}

/**
 * Límite diario efectivo de una clave (0 = ilimitado). El del plan acota
 * siempre al de la clave: se recalcula en cada envío, no solo al crearla,
 * por si el plan cambió después.
 */
export function effectiveDailyLimit(planDaily: number, keyDaily: number | null): number {
  if (planDaily > 0) return Math.min(keyDaily ?? planDaily, planDaily);
  return keyDaily ?? 0;
}

/**
 * Tamaño del contenido en bytes UTF-8. `String.length` cuenta unidades UTF-16:
 * un cuerpo con acentos o emojis se registraba más pequeño de lo que ocupa.
 */
export function messageSizeBytes(body: { html?: string; text?: string }): number {
  return Buffer.byteLength(body.html ?? '', 'utf8') + Buffer.byteLength(body.text ?? '', 'utf8');
}

function toInfo(row: ApiKeyRow): ApiKeyInfo {
  let senderEmail = '';
  try {
    senderEmail = getMailbox(row.sender_mailbox_id).email;
  } catch {
    senderEmail = '(buzón eliminado)';
  }
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    prefix: row.prefix,
    senderMailboxId: row.sender_mailbox_id,
    senderEmail,
    dailyLimit: row.daily_limit,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    usedToday: usedToday(row.id),
  };
}

/* ------------------------- Límite por minuto (RAM) ------------------------ */

const VENTANA_MINUTO_MS = 60_000;
const minuteBuckets = new Map<string, { windowStart: number; count: number }>();
let ultimaPodaMinuto = 0;

/**
 * Retira las ventanas ya caducadas. Sin esta poda el mapa crecía con cada clave
 * que alguna vez envió, aunque llevase meses sin usarse o estuviese revocada.
 * Se ejecuta como mucho una vez por minuto para no recorrer el mapa en cada envío.
 */
function podarVentanas(nowMs: number): void {
  if (nowMs - ultimaPodaMinuto < VENTANA_MINUTO_MS) return;
  ultimaPodaMinuto = nowMs;
  for (const [keyId, bucket] of minuteBuckets) {
    if (nowMs - bucket.windowStart >= VENTANA_MINUTO_MS) minuteBuckets.delete(keyId);
  }
}

export function checkPerMinute(keyId: string, limit: number, nowMs = Date.now()): void {
  podarVentanas(nowMs);
  // Un límite 0 o negativo se interpreta como «sin límite», igual que el diario.
  if (limit <= 0) return;
  const bucket = minuteBuckets.get(keyId);
  if (!bucket || nowMs - bucket.windowStart >= VENTANA_MINUTO_MS) {
    minuteBuckets.set(keyId, { windowStart: nowMs, count: 1 });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    throw tooMany(
      `Se ha superado el límite de ${limit} envíos por minuto del plan. Reintente en unos segundos.`,
    );
  }
}

/** Número de ventanas por minuto en memoria (para las pruebas de la poda). */
export function minuteBucketCount(): number {
  return minuteBuckets.size;
}

/* ------------------------------- Transportes ------------------------------ */

/**
 * ¿Es un nombre que solo se resuelve dentro de la red del despliegue? Un
 * servicio de Docker (`mailway-mail`), una IP o `localhost` nunca figuran en
 * el certificado del servidor de correo, que se emite para su nombre público.
 */
export function isInternalHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (net.isIP(h) !== 0 || h === 'localhost') return true;
  if (!h.includes('.')) return true;
  return /\.(internal|local|localhost|lan|docker)$/.test(h);
}

/**
 * Opciones TLS de la conexión SMTP con el motor.
 *
 * Al conectar por un nombre interno, el certificado de Stalwart es el del
 * nombre público (`mailHostname`): se verifica contra ese nombre (y se envía
 * como SNI) en lugar de desactivar la verificación. MAILWAY_SMTP_ALLOW_SELF_SIGNED=1
 * sigue siendo la salida explícita mientras el certificado aún no se ha emitido.
 */
export function smtpTlsOptions(
  smtpHost: string,
  mailHostname: string,
  allowSelfSigned: boolean,
): ConnectionOptions | undefined {
  const publico = mailHostname.trim().toLowerCase().replace(/\.$/, '');
  const servername =
    publico && publico !== smtpHost.trim().toLowerCase() && isInternalHost(smtpHost)
      ? publico
      : undefined;
  if (allowSelfSigned) {
    return servername ? { servername, rejectUnauthorized: false } : { rejectUnauthorized: false };
  }
  return servername ? { servername } : undefined;
}

type FabricaTransporte = (options: SMTPPool.Options) => Transporter;

const fabricaPorDefecto: FabricaTransporte = (options) => nodemailer.createTransport(options);
let fabricaTransporte: FabricaTransporte = fabricaPorDefecto;

/** Sustituye la creación de transportes (solo pruebas: evita abrir conexiones SMTP). */
export function setTransportFactoryForTests(factory: FabricaTransporte | null): void {
  fabricaTransporte = factory ?? fabricaPorDefecto;
}

interface TransporteCacheado {
  /** Ajustes y credencial con los que se creó; si cambian, se rehace. */
  huella: string;
  transport: Transporter;
  usadoEn: number;
}

/** Un transporte (con su pool de conexiones) por clave de API. */
const transports = new Map<string, TransporteCacheado>();
/** Un pool sin uso en este tiempo se cierra: sus conexiones ya no aportan nada. */
const TRANSPORTE_INACTIVO_MS = 10 * 60_000;
/** Tope de pools abiertos a la vez, para que la memoria y los sockets estén acotados. */
const MAX_TRANSPORTES = 100;

function cerrarTransporte(keyId: string): void {
  const entry = transports.get(keyId);
  if (!entry) return;
  transports.delete(keyId);
  try {
    entry.transport.close();
  } catch {
    // Cerrar un pool ya cerrado no debe impedir retirar la clave.
  }
}

function podarTransportes(nowMs: number): void {
  for (const [keyId, entry] of transports) {
    if (nowMs - entry.usadoEn > TRANSPORTE_INACTIVO_MS) cerrarTransporte(keyId);
  }
  // El mapa mantiene el orden de inserción y cada uso reinserta la entrada:
  // la primera es siempre la usada hace más tiempo.
  while (transports.size >= MAX_TRANSPORTES) {
    const oldest = transports.keys().next().value;
    if (oldest === undefined) break;
    cerrarTransporte(oldest);
  }
}

export function getTransport(
  keyId: string,
  senderEmail: string,
  smtpPassword: string,
  engineSettings: Pick<EngineSettings, 'smtpHost' | 'smtpPort' | 'smtpSecure'>,
  mailHostname: string,
  nowMs = Date.now(),
): Transporter {
  const allowSelfSigned = process.env.MAILWAY_SMTP_ALLOW_SELF_SIGNED === '1';
  // La huella incluye host/puerto/seguridad y la credencial: si el admin
  // cambia los ajustes del motor, el pool anterior se cierra y se rehace.
  const huella = [
    senderEmail,
    hashToken(smtpPassword).slice(0, 12),
    engineSettings.smtpHost,
    engineSettings.smtpPort,
    engineSettings.smtpSecure,
    mailHostname,
    allowSelfSigned,
  ].join(':');

  const cached = transports.get(keyId);
  if (cached && cached.huella === huella) {
    transports.delete(keyId);
    cached.usadoEn = nowMs;
    transports.set(keyId, cached);
    return cached.transport;
  }
  if (cached) cerrarTransporte(keyId);
  podarTransportes(nowMs);

  const transport = fabricaTransporte({
    pool: true,
    host: engineSettings.smtpHost,
    port: engineSettings.smtpPort,
    secure: engineSettings.smtpSecure,
    auth: { user: senderEmail, pass: smtpPassword },
    maxConnections: 3,
    tls: smtpTlsOptions(engineSettings.smtpHost, mailHostname, allowSelfSigned),
  });
  transports.set(keyId, { huella, transport, usadoEn: nowMs });
  return transport;
}

/** Número de transportes abiertos (para las pruebas de la poda). */
export function transportCount(): number {
  return transports.size;
}

/**
 * Olvida todo lo que se guarda en memoria de una clave revocada: su ventana
 * por minuto y su pool SMTP, que si no seguiría abierto contra el motor.
 */
export function forgetApiKey(keyId: string): void {
  minuteBuckets.delete(keyId);
  cerrarTransporte(keyId);
}

/**
 * Traduce los errores de certificado a un mensaje accionable: el texto de
 * Node («self-signed certificate», «Hostname/IP does not match…») no dice qué hacer.
 */
function describeSmtpError(err: unknown, host: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/certificate|self[- ]signed|altname|does not match/i.test(message)) {
    return `el certificado TLS del servidor de correo no es válido para ${host || 'el nombre configurado'}. El administrador debe completar la emisión del certificado del servidor de correo (${message.slice(0, 200)})`;
  }
  return message.slice(0, 500);
}

/* --------------------------------- Rutas ---------------------------------- */

const createKeySchema = z.object({
  clientId: z.string().optional(),
  name: z
    .string()
    .trim()
    .min(2, 'Indique un nombre reconocible, p. ej. «OTP producción».')
    .max(60, 'El nombre admite como máximo 60 caracteres.'),
  senderMailboxId: z.string().min(1, 'Seleccione el buzón remitente.'),
  dailyLimit: z.number().int().min(1, 'El límite diario debe ser de al menos 1 envío.').optional(),
});

export function registerApiKeyRoutes(app: FastifyInstance): void {
  app.get('/api/apikeys', async (req) => {
    const user = requireAuth(req);
    const { clientId } = req.query as { clientId?: string };
    const effectiveClient = user.role === 'admin' ? clientId : user.clientId!;
    const rows = effectiveClient
      ? (db
          .prepare('SELECT * FROM api_keys WHERE client_id = ? ORDER BY created_at DESC')
          .all(effectiveClient) as ApiKeyRow[])
      : (db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as ApiKeyRow[]);
    return { keys: rows.map(toInfo) };
  });

  app.post('/api/apikeys', async (req) => {
    const user = requireAuth(req);
    const body = createKeySchema.parse(req.body);
    const clientId = user.role === 'admin' ? body.clientId || '' : user.clientId!;
    if (!clientId) throw badRequest('Indique el cliente propietario de la clave.');
    requireClientAccess(req, clientId);

    const mailbox = getMailbox(body.senderMailboxId);
    const domain = db
      .prepare('SELECT client_id FROM domains WHERE id = ?')
      .get(mailbox.domainId) as { client_id: string };
    if (domain.client_id !== clientId) {
      throw badRequest('El buzón remitente debe pertenecer al mismo cliente que la clave.');
    }
    // Una clave con un remitente suspendido nacería inservible: /v1/send la
    // rechazaría en cada envío.
    if (mailbox.status === 'suspended') {
      throw badRequest(
        `El buzón remitente ${mailbox.email} está suspendido. Reactívelo o seleccione otro buzón.`,
        'sender_suspended',
      );
    }

    // Un límite por clave solo puede ACOTAR el del plan, nunca ampliarlo:
    // si no, un usuario cliente esquivaría el antiabuso de su propio plan.
    const plan = getPlan(getClient(clientId).planId);
    let dailyLimit: number | null = body.dailyLimit ?? null;
    if (plan.apiDailyLimit > 0) {
      dailyLimit = Math.min(dailyLimit ?? plan.apiDailyLimit, plan.apiDailyLimit);
    }

    // Contraseña de aplicación dedicada: la clave de API envía con ella sin
    // conocer (ni tocar) la contraseña real del buzón.
    const smtpPassword = generateMailboxPassword(24);
    const engine = getEngine();
    const { key, prefix, hash } = newApiKey();
    const id = randomId('key');
    const storedSecret = await engine.addAppPassword(
      mailbox.email,
      smtpPassword,
      `mailway-${prefix}`,
    );
    try {
      db.prepare(
        `INSERT INTO api_keys (id, client_id, name, prefix, key_hash, sender_mailbox_id,
           smtp_password_enc, daily_limit, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, clientId, body.name, prefix, hash, mailbox.id,
        encryptSecret(JSON.stringify({ plain: smtpPassword, stored: storedSecret })),
        dailyLimit, now(),
      );
    } catch (err) {
      // Sin fila en la BD, la contraseña de aplicación quedaría en el motor
      // como una credencial SMTP válida que nadie puede ver ni revocar.
      try {
        await engine.removeAppPassword(mailbox.email, storedSecret);
      } catch (rollbackErr) {
        req.log.error(
          { err: rollbackErr, mailbox: mailbox.email },
          'No se pudo retirar la contraseña de aplicación tras fallar el alta de la clave',
        );
      }
      throw err;
    }
    audit(req, 'apikey.created', { id, name: body.name, sender: mailbox.email });

    // La clave completa solo se muestra una vez.
    return { key, info: toInfo(db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow) };
  });

  app.delete('/api/apikeys/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow | undefined;
    if (!row) throw notFound('Clave no encontrada.');
    requireClientAccess(req, row.client_id);
    if (row.revoked_at) throw conflict('Esta clave ya estaba revocada.');
    db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(now(), id);
    forgetApiKey(id);
    // Se retira también la contraseña de aplicación del motor.
    try {
      const engine = getEngine();
      const mailbox = getMailbox(row.sender_mailbox_id);
      const credentials = parseSmtpCredentials(row.smtp_password_enc);
      if (credentials.stored) {
        await engine.removeAppPassword(mailbox.email, credentials.stored);
      }
    } catch (err) {
      req.log.warn({ err }, 'No se pudo retirar la contraseña de aplicación al revocar la clave');
    }
    audit(req, 'apikey.revoked', { id });
    return { ok: true };
  });

  /* Historial de envíos para el panel */
  app.get('/api/messages', async (req) => {
    const user = requireAuth(req);
    const { clientId, keyId, limit } = req.query as {
      clientId?: string;
      keyId?: string;
      limit?: string;
    };
    const effectiveClient = user.role === 'admin' ? clientId : user.clientId!;
    const max = Math.min(Math.max(Math.trunc(Number(limit)) || 100, 1), 500);
    let sql = 'SELECT * FROM messages';
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (effectiveClient) {
      where.push('client_id = ?');
      params.push(effectiveClient);
    }
    if (keyId) {
      where.push('api_key_id = ?');
      params.push(keyId);
    }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(max);
    const rows = db.prepare(sql).all(...params) as {
      id: string;
      client_id: string;
      api_key_id: string | null;
      from_address: string;
      to_json: string;
      subject: string;
      status: string;
      error: string;
      smtp_message_id: string;
      size_bytes: number;
      created_at: number;
    }[];
    return {
      messages: rows.map((r) => ({
        id: r.id,
        clientId: r.client_id,
        apiKeyId: r.api_key_id,
        from: r.from_address,
        to: JSON.parse(r.to_json) as string[],
        subject: r.subject,
        status: r.status,
        error: r.error,
        messageId: r.smtp_message_id,
        sizeBytes: r.size_bytes,
        createdAt: r.created_at,
      })),
    };
  });
}

/* ------------------------- API pública de envío --------------------------- */

/** Límite de cada cuerpo, en bytes como anuncia la documentación (2 MB). */
const MAX_CUERPO_BYTES = 2 * 1024 * 1024;

const cuerpo = (campo: string) =>
  z
    .string()
    // UTF-8 nunca ocupa menos bytes que caracteres: basta con medir los bytes.
    .refine((s) => Buffer.byteLength(s, 'utf8') <= MAX_CUERPO_BYTES, {
      message: `El campo «${campo}» supera el máximo de 2 MB.`,
    })
    .optional();

const sendSchema = z.object({
  to: z
    .union([z.string().email(), z.array(z.string().email()).min(1).max(50)])
    .transform((v) => (Array.isArray(v) ? v : [v])),
  subject: z.string().min(1, 'El asunto es obligatorio.').max(300),
  html: cuerpo('html'),
  text: cuerpo('text'),
  fromName: z.string().trim().max(80).optional(),
  replyTo: z.string().email().optional(),
  cc: z.array(z.string().email()).max(20).optional(),
  bcc: z.array(z.string().email()).max(20).optional(),
  headers: z.record(z.string().max(500)).optional(),
});

/** Comparación en tiempo constante de dos huellas hexadecimales. */
function mismaHuella(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function resolveApiKey(req: FastifyRequest): ApiKeyRow {
  const header = req.headers.authorization || '';
  if (!header.trim()) {
    throw unauthorized(
      'Falta la cabecera Authorization. Use: Authorization: Bearer mw_… (su clave de API).',
      'missing_api_key',
    );
  }
  const match = header.match(/^Bearer\s+(mw_[a-zA-Z0-9_-]+)$/);
  if (!match) {
    throw unauthorized(
      'La cabecera Authorization no contiene una clave de API válida. Formato: Bearer mw_….',
      'invalid_api_key',
    );
  }
  const key = match[1]!;
  const prefix = key.split('_')[1] || '';
  const row = db.prepare('SELECT * FROM api_keys WHERE prefix = ?').get(prefix) as
    | ApiKeyRow
    | undefined;
  if (!row || !mismaHuella(row.key_hash, hashToken(key))) {
    throw unauthorized('Clave de API no válida.', 'invalid_api_key');
  }
  if (row.revoked_at) throw unauthorized('Esta clave de API fue revocada.', 'revoked_api_key');
  return row;
}

/**
 * El buzón remitente de la clave, siempre que pueda enviar. Un buzón suspendido
 * no debe seguir saliendo por la API: la suspensión es precisamente para cortarlo.
 */
function resolveSender(keyRow: ApiKeyRow): Mailbox {
  let mailbox: Mailbox;
  try {
    mailbox = getMailbox(keyRow.sender_mailbox_id);
  } catch {
    throw forbidden(
      'El buzón remitente de esta clave ya no existe. Cree una clave nueva con otro remitente.',
      'sender_missing',
    );
  }
  if (mailbox.status === 'suspended') {
    throw forbidden(
      `El buzón remitente ${mailbox.email} está suspendido y no puede enviar correo. Reactívelo en el panel o utilice otra clave.`,
      'sender_suspended',
    );
  }
  return mailbox;
}

export function registerSendRoutes(app: FastifyInstance): void {
  app.post('/v1/send', async (req) => {
    const keyRow = resolveApiKey(req);
    const client = getClient(keyRow.client_id);
    // La clave es válida (no es un 401): es la cuenta la que no puede enviar.
    if (client.suspended) {
      throw forbidden(
        'La cuenta del cliente está suspendida: los envíos por API están bloqueados.',
        'client_suspended',
      );
    }
    const mailbox = resolveSender(keyRow);
    const plan = getPlan(client.planId);

    checkPerMinute(keyRow.id, plan.apiPerMinuteLimit);

    const effectiveDaily = effectiveDailyLimit(plan.apiDailyLimit, keyRow.daily_limit);

    // Se valida el cuerpo ANTES de reservar cupo: un envío malformado no debe
    // gastar cupo diario.
    const body = sendSchema.parse(req.body);
    if (!body.html && !body.text) {
      throw badRequest('Incluya «html», «text» o ambos con el contenido del mensaje.');
    }

    // Reserva atómica del cupo: incrementar y comprobar de forma síncrona
    // cierra la carrera con el await del envío (peticiones concurrentes ya no
    // pueden superar el límite entre la lectura y el incremento).
    const reserved = reserveDailyUsage(keyRow.id);
    if (effectiveDaily > 0 && reserved > effectiveDaily) {
      releaseDailyUsage(keyRow.id);
      throw tooMany(
        `Se ha alcanzado el límite diario de ${effectiveDaily} envíos. El contador se reinicia a medianoche UTC.`,
        'daily_limit_reached',
      );
    }

    const from = body.fromName
      ? { name: body.fromName, address: mailbox.email }
      : mailbox.email;

    const messageId = randomId('msg');
    const engineSettings = getEngineSettings();
    let status: 'sent' | 'failed' = 'sent';
    let error = '';
    let smtpMessageId = '';
    const sizeBytes = messageSizeBytes(body);

    if (engineSettings?.kind === 'demo') {
      smtpMessageId = `<demo-${messageId}@mailway>`;
    } else if (!engineSettings) {
      status = 'failed';
      error = 'el motor de correo no está configurado';
    } else {
      const { mailHostname } = getInstanceSettings();
      try {
        const transport = getTransport(
          keyRow.id,
          mailbox.email,
          parseSmtpCredentials(keyRow.smtp_password_enc).plain,
          engineSettings,
          mailHostname,
        );
        const result = await transport.sendMail({
          from,
          to: body.to,
          cc: body.cc,
          bcc: body.bcc,
          subject: body.subject,
          html: body.html,
          text: body.text,
          replyTo: body.replyTo,
          headers: body.headers,
        });
        smtpMessageId = result.messageId || '';
      } catch (err) {
        status = 'failed';
        error = describeSmtpError(err, mailHostname || engineSettings.smtpHost);
        req.log.warn({ err, key: keyRow.prefix }, 'Envío por API rechazado por el SMTP del motor');
      }
    }

    db.prepare(
      `INSERT INTO messages (id, client_id, api_key_id, from_address, to_json, subject,
         status, error, smtp_message_id, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      messageId, keyRow.client_id, keyRow.id, mailbox.email, JSON.stringify(body.to),
      body.subject, status, error, smtpMessageId, sizeBytes, now(),
    );
    // El cupo ya se reservó arriba (reserveDailyUsage); aquí no se vuelve a
    // incrementar. Un envío fallido conserva la reserva (evita reintentos
    // ilimitados ante un motor caído).
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), keyRow.id);

    if (status === 'failed') {
      return {
        id: messageId,
        status,
        error: `No se pudo entregar al servidor SMTP: ${error}`,
      };
    }
    return { id: messageId, status, messageId: smtpMessageId };
  });
}
