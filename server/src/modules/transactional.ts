import type { FastifyInstance, FastifyRequest } from 'fastify';
import nodemailer, { type Transporter } from 'nodemailer';
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
import { badRequest, conflict, notFound, tooMany, unauthorized } from '../core/errors';
import { getEngine } from '../engine';
import { getEngineSettings } from './settings';
import { audit } from './audit';
import { requireAuth, requireClientAccess } from './auth';
import { getClient, getPlan } from './clients';
import { getMailbox } from './mailboxes';

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

const minuteBuckets = new Map<string, { windowStart: number; count: number }>();

function checkPerMinute(keyId: string, limit: number): void {
  const nowMs = Date.now();
  const bucket = minuteBuckets.get(keyId);
  if (!bucket || nowMs - bucket.windowStart >= 60_000) {
    minuteBuckets.set(keyId, { windowStart: nowMs, count: 1 });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    throw tooMany(
      `Has superado el límite de ${limit} envíos por minuto de tu plan. Reintenta en unos segundos.`,
    );
  }
}

/* ------------------------------- Transportes ------------------------------ */

const transports = new Map<string, Transporter>();

function getTransport(senderEmail: string, smtpPassword: string): Transporter {
  const engineSettings = getEngineSettings();
  if (!engineSettings) throw badRequest('El motor de correo no está configurado.');
  // La clave incluye host/puerto/seguridad: si el admin cambia los ajustes
  // del motor, el transporte cacheado deja de reutilizarse automáticamente.
  const cacheKey = [
    senderEmail,
    hashToken(smtpPassword).slice(0, 12),
    engineSettings.smtpHost,
    engineSettings.smtpPort,
    engineSettings.smtpSecure,
  ].join(':');
  let transport = transports.get(cacheKey);
  if (!transport) {
    transport = nodemailer.createTransport({
      host: engineSettings.smtpHost,
      port: engineSettings.smtpPort,
      secure: engineSettings.smtpSecure,
      auth: { user: senderEmail, pass: smtpPassword },
      pool: true,
      maxConnections: 3,
      tls:
        process.env.MAILWAY_SMTP_ALLOW_SELF_SIGNED === '1'
          ? { rejectUnauthorized: false }
          : undefined,
    });
    transports.set(cacheKey, transport);
  }
  return transport;
}

/* --------------------------------- Rutas ---------------------------------- */

const createKeySchema = z.object({
  clientId: z.string().optional(),
  name: z.string().trim().min(2, 'Ponle un nombre reconocible, p. ej. "OTP producción".').max(60),
  senderMailboxId: z.string().min(1, 'Elige el buzón remitente.'),
  dailyLimit: z.number().int().min(1).optional(),
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
    if (!clientId) throw badRequest('Indica el cliente propietario de la clave.');
    requireClientAccess(req, clientId);

    const mailbox = getMailbox(body.senderMailboxId);
    const domain = db
      .prepare('SELECT client_id FROM domains WHERE id = ?')
      .get(mailbox.domainId) as { client_id: string };
    if (domain.client_id !== clientId) {
      throw badRequest('El buzón remitente debe pertenecer al mismo cliente que la clave.');
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
    db.prepare(
      `INSERT INTO api_keys (id, client_id, name, prefix, key_hash, sender_mailbox_id,
         smtp_password_enc, daily_limit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, clientId, body.name, prefix, hash, mailbox.id,
      encryptSecret(JSON.stringify({ plain: smtpPassword, stored: storedSecret })),
      dailyLimit, now(),
    );
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
    const max = Math.min(Number(limit) || 100, 500);
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

const sendSchema = z.object({
  to: z
    .union([z.string().email(), z.array(z.string().email()).min(1).max(50)])
    .transform((v) => (Array.isArray(v) ? v : [v])),
  subject: z.string().min(1, 'El asunto es obligatorio.').max(300),
  html: z.string().max(2 * 1024 * 1024).optional(),
  text: z.string().max(2 * 1024 * 1024).optional(),
  fromName: z.string().trim().max(80).optional(),
  replyTo: z.string().email().optional(),
  cc: z.array(z.string().email()).max(20).optional(),
  bcc: z.array(z.string().email()).max(20).optional(),
  headers: z.record(z.string().max(500)).optional(),
});

function resolveApiKey(req: FastifyRequest): ApiKeyRow {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(mw_[a-zA-Z0-9_-]+)$/);
  if (!match) {
    throw unauthorized(
      'Falta la cabecera Authorization. Usa: Authorization: Bearer mw_xxx (tu clave de API).',
      'missing_api_key',
    );
  }
  const key = match[1]!;
  const prefix = key.split('_')[1] || '';
  const row = db.prepare('SELECT * FROM api_keys WHERE prefix = ?').get(prefix) as
    | ApiKeyRow
    | undefined;
  if (!row || row.key_hash !== hashToken(key)) {
    throw unauthorized('Clave de API no válida.', 'invalid_api_key');
  }
  if (row.revoked_at) throw unauthorized('Esta clave de API fue revocada.', 'revoked_api_key');
  return row;
}

export function registerSendRoutes(app: FastifyInstance): void {
  app.post('/v1/send', async (req) => {
    const keyRow = resolveApiKey(req);
    const client = getClient(keyRow.client_id);
    if (client.suspended) {
      throw unauthorized('La cuenta del cliente está suspendida.', 'client_suspended');
    }
    const plan = getPlan(client.planId);

    checkPerMinute(keyRow.id, plan.apiPerMinuteLimit);

    // Límite diario efectivo: el del plan acota siempre al de la clave
    // (0 = ilimitado). Se calcula aquí también, no solo al crear la clave,
    // por si el plan cambió después.
    const effectiveDaily =
      plan.apiDailyLimit > 0
        ? Math.min(keyRow.daily_limit ?? plan.apiDailyLimit, plan.apiDailyLimit)
        : keyRow.daily_limit ?? 0;

    // Se valida el cuerpo ANTES de reservar cupo: un envío malformado no debe
    // gastar cupo diario.
    const body = sendSchema.parse(req.body);
    if (!body.html && !body.text) {
      throw badRequest('Incluye "html", "text" o ambos con el contenido del mensaje.');
    }

    // Reserva atómica del cupo: incrementar y comprobar de forma síncrona
    // cierra la carrera con el await del envío (peticiones concurrentes ya no
    // pueden superar el límite entre la lectura y el incremento).
    const reserved = reserveDailyUsage(keyRow.id);
    if (effectiveDaily > 0 && reserved > effectiveDaily) {
      releaseDailyUsage(keyRow.id);
      throw tooMany(
        `Has alcanzado el límite diario de ${effectiveDaily} envíos. El contador se reinicia a medianoche UTC.`,
        'daily_limit_reached',
      );
    }

    const mailbox = getMailbox(keyRow.sender_mailbox_id);
    const from = body.fromName
      ? { name: body.fromName, address: mailbox.email }
      : mailbox.email;

    const messageId = randomId('msg');
    const engineSettings = getEngineSettings();
    let status: 'sent' | 'failed' = 'sent';
    let error = '';
    let smtpMessageId = '';
    let sizeBytes = (body.html?.length || 0) + (body.text?.length || 0);

    if (engineSettings?.kind === 'demo') {
      smtpMessageId = `<demo-${messageId}@mailway>`;
    } else {
      try {
        const transport = getTransport(mailbox.email, parseSmtpCredentials(keyRow.smtp_password_enc).plain);
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
        error = (err as Error).message.slice(0, 500);
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
