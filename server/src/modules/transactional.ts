import crypto from 'node:crypto';
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
import { HttpError, badRequest, conflict, forbidden, notFound, tooMany, unauthorized } from '../core/errors';
import { isInternalHost } from '../core/hostnames';
import { getEngine } from '../engine';
import type { EngineSettings } from '../engine/types';
import { getEngineSettings, getInstanceSettings } from './settings';
import { audit } from './audit';
import { requireAuth, requireClientAccess } from './auth';
import { assertClientActive, getClient, getPlan } from './clients';
import { getMailbox, type Mailbox } from './mailboxes';
import { bloquesClaveApi, publicBaseUrl } from './connection';

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

/* ------------------------- Cupo diario del cliente ------------------------ */

/*
 * El límite diario del plan es del CLIENTE, no de cada clave: si se aplicara
 * por clave, bastaría con crear diez claves para enviar diez veces el plan.
 * Lo enviado hoy se cuenta en `messages` (cada envío admitido deja su fila,
 * también los que el SMTP rechaza) y lo que está saliendo en este momento,
 * en memoria: comprobar y apuntar es síncrono, así que las peticiones
 * simultáneas no se cuelan entre la cuenta y la inserción.
 *
 * Los formularios web llevan su propio cupo (ver forms.ts), contado aparte:
 * los rellena cualquiera desde Internet, y si gastaran este, un formulario
 * atacado dejaría al cliente sin sus envíos por API (códigos de un solo uso,
 * recuperación de contraseña) hasta el día siguiente.
 */
const enviosEnCurso = new Map<string, number>();

export function inicioDelDiaUtc(t = now()): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Reserva un envío de un cupo diario (0 = sin límite). `registradosHoy` son
 * los envíos del día que ya tienen su fila en `messages`; los que están
 * saliendo se cuentan en memoria con `clave`. Devuelve la función que libera
 * la reserva: se llama cuando el envío ya tiene su fila (desde ahí cuenta la
 * base) o si se rechaza antes.
 */
export function reservarCupoDiario(
  clave: string,
  registradosHoy: number,
  limite: number,
  agotado: () => HttpError,
): () => void {
  if (limite > 0 && registradosHoy + (enviosEnCurso.get(clave) ?? 0) >= limite) throw agotado();
  enviosEnCurso.set(clave, (enviosEnCurso.get(clave) ?? 0) + 1);
  let liberada = false;
  return () => {
    if (liberada) return;
    liberada = true;
    const quedan = (enviosEnCurso.get(clave) ?? 1) - 1;
    if (quedan > 0) enviosEnCurso.set(clave, quedan);
    else enviosEnCurso.delete(clave);
  };
}

function enviosApiRegistradosHoy(clientId: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS c FROM messages WHERE client_id = ? AND source = 'api' AND created_at >= ?`)
      .get(clientId, inicioDelDiaUtc()) as { c: number }
  ).c;
}

/** Envíos por API del cliente en el día UTC en curso (los ya registrados y los que están saliendo). */
export function clientSentToday(clientId: string): number {
  return enviosApiRegistradosHoy(clientId) + (enviosEnCurso.get(`api:${clientId}`) ?? 0);
}

/** Reserva un envío por API del cupo diario del plan para el cliente (todas sus claves suman). */
export function reservarCupoCliente(clientId: string, limite: number): () => void {
  return reservarCupoDiario(`api:${clientId}`, enviosApiRegistradosHoy(clientId), limite, () =>
    tooMany(
      `Se ha alcanzado el límite diario de ${limite} envíos del plan para este cliente (sumando todas sus claves). El contador se reinicia a medianoche UTC.`,
      'daily_limit_reached',
    ),
  );
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

/**
 * Ventana de un minuto por clave de contador (en /v1/send, `cliente:<id>`:
 * el límite por minuto del plan es del cliente, sume las claves que sume).
 */
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
      `Se ha superado el límite de ${limit} envíos por minuto del plan. Reintenta en unos segundos.`,
    );
  }
}

/** Número de ventanas por minuto en memoria (para las pruebas de la poda). */
export function minuteBucketCount(): number {
  return minuteBuckets.size;
}

/* ------------------------------- Transportes ------------------------------ */

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

/** Cierra el pool SMTP de una credencial (una clave o un formulario) que ya no existe. */
export function forgetTransport(id: string): void {
  cerrarTransporte(id);
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
export function describeSmtpError(err: unknown, host: string): string {
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
    .min(2, 'Indica un nombre reconocible, p. ej. «OTP producción».')
    .max(60, 'El nombre admite como máximo 60 caracteres.'),
  senderMailboxId: z.string().min(1, 'Selecciona el buzón remitente.'),
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

  app.post('/api/apikeys', async (req, reply) => {
    const user = requireAuth(req);
    const body = createKeySchema.parse(req.body);
    const clientId = user.role === 'admin' ? body.clientId || '' : user.clientId!;
    if (!clientId) throw badRequest('Indica el cliente propietario de la clave.');
    requireClientAccess(req, clientId);
    assertClientActive(clientId);

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
        `El buzón remitente ${mailbox.email} está suspendido. Reactívalo o selecciona otro buzón.`,
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
    // Con el cliente dueño de la clave: lo que hace el administrador (o Skyway
    // con su token) debe aparecer también en la actividad de ese cliente.
    audit(req, 'apikey.created', { id, name: body.name, sender: mailbox.email }, clientId);

    // La clave completa solo se muestra una vez, y con ella los bloques listos
    // para copiar: sin la clave en claro no se pueden volver a generar.
    reply.header('Cache-Control', 'no-store');
    return {
      key,
      info: toInfo(db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow),
      snippets: bloquesClaveApi({ apiUrl: publicBaseUrl(req), key, from: mailbox.email, name: body.name }),
    };
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
    audit(req, 'apikey.revoked', { id, name: row.name }, row.client_id);
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
      form_id: string | null;
      source: 'api' | 'form';
    }[];
    return {
      messages: rows.map((r) => ({
        id: r.id,
        clientId: r.client_id,
        apiKeyId: r.api_key_id,
        formId: r.form_id ?? null,
        // Se conserva aunque el formulario (o la clave) se elimine después.
        source: r.source,
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

/* -------------------------------- Adjuntos -------------------------------- */

export const MAX_ADJUNTOS = 5;
/** Tope de los adjuntos de un mensaje, sumados y ya decodificados. */
export const MAX_ADJUNTOS_BYTES = 10 * 1024 * 1024;
/**
 * Tope de la petición de /v1/send: 10 MB de adjuntos ocupan unos 13,4 MB en
 * base64, más los dos cuerpos de 2 MB. El resto de la API sigue en 5 MB.
 */
export const MAX_PETICION_ENVIO_BYTES = 20 * 1024 * 1024;

const ZIP = (b: Buffer) => b.length >= 4 && b.readUInt32BE(0) === 0x504b0304;
/** Un texto no lleva bytes nulos: así no pasa un ejecutable con la etiqueta text/plain. */
const SIN_NULOS = (b: Buffer) => !b.subarray(0, 64 * 1024).includes(0);

/**
 * Tipos admitidos, sus extensiones y la firma que debe tener el contenido.
 * Lista cerrada a propósito: lo que viaja por la API sale con el dominio y la
 * IP del cliente, y un ejecutable o un HTML adjunto hunden la reputación de
 * ambos (y son la vía clásica del phishing). La primera extensión es la que
 * se añade si el nombre no trae ninguna.
 */
const TIPOS_ADJUNTO: Record<string, { extensiones: string[]; firma: (b: Buffer) => boolean }> = {
  'application/pdf': { extensiones: ['pdf'], firma: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  'text/calendar': {
    extensiones: ['ics', 'ical', 'ifb'],
    firma: (b) =>
      SIN_NULOS(b) &&
      /^(\ufeff)?\s*BEGIN:VCALENDAR/i.test(b.subarray(0, 256).toString('utf8')),
  },
  'text/plain': { extensiones: ['txt', 'text', 'log'], firma: SIN_NULOS },
  'text/csv': { extensiones: ['csv'], firma: SIN_NULOS },
  'application/json': { extensiones: ['json'], firma: SIN_NULOS },
  'image/png': {
    extensiones: ['png'],
    firma: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  'image/jpeg': { extensiones: ['jpg', 'jpeg'], firma: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { extensiones: ['gif'], firma: (b) => /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1')) },
  'image/webp': {
    extensiones: ['webp'],
    firma: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { extensiones: ['docx'], firma: ZIP },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { extensiones: ['xlsx'], firma: ZIP },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { extensiones: ['pptx'], firma: ZIP },
  'application/vnd.oasis.opendocument.text': { extensiones: ['odt'], firma: ZIP },
  'application/vnd.oasis.opendocument.spreadsheet': { extensiones: ['ods'], firma: ZIP },
  'application/vnd.oasis.opendocument.presentation': { extensiones: ['odp'], firma: ZIP },
};

const TIPOS_LEGIBLES =
  'PDF, calendario (.ics), imágenes PNG, JPEG, GIF y WebP, texto, CSV, JSON y documentos de Office (docx, xlsx, pptx) u OpenDocument (odt, ods, odp)';

export interface AdjuntoPreparado {
  filename: string;
  contentType: string;
  content: Buffer;
}

/**
 * Nombre de fichero que se puede poner en una cabecera y mostrar sin engaños:
 * sin rutas, sin caracteres de control ni marcas de dirección (U+202E
 * convierte «fdp.exe» en algo que se lee como «exe.pdf»), sin caracteres
 * reservados en Windows y sin puntos al principio o al final. Puede quedar
 * vacío: quien llama decide el nombre por defecto.
 */
export function sanearNombreAdjunto(nombre: string): string {
  let n = nombre.normalize('NFC');
  n = n.split(/[\\/]/).pop() ?? '';
  n = n.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  n = n.replace(/["<>:*?|]/g, '_');
  n = n.replace(/\s+/g, ' ').trim();
  n = n.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (n.length > 120) {
    const punto = n.lastIndexOf('.');
    const ext = punto > 0 && n.length - punto <= 12 ? n.slice(punto) : '';
    n = n.slice(0, 120 - ext.length).replace(/[.\s]+$/, '') + ext;
  }
  return n;
}

/**
 * Tipo de contenido admitido, reescrito en forma canónica. De los parámetros
 * solo se conservan `charset` y, en un calendario, `method` (REQUEST, CANCEL…:
 * es lo que convierte un .ics en una invitación con botones de respuesta).
 */
function tipoAdjunto(declarado: string, nombre: string): string {
  const [base = '', ...parametros] = declarado.split(';');
  const tipo = base.trim().toLowerCase();
  if (!TIPOS_ADJUNTO[tipo]) {
    throw badRequest(
      `El tipo «${tipo.slice(0, 80)}» del adjunto «${nombre}» no está admitido. Tipos admitidos: ${TIPOS_LEGIBLES}.`,
      'attachment_type_not_allowed',
    );
  }
  const extra: string[] = [];
  for (const parametro of parametros) {
    const [clave = '', valor = ''] = parametro.split('=').map((s) => s.trim().replace(/^"|"$/g, ''));
    if (clave.toLowerCase() === 'charset' && /^[A-Za-z0-9._-]{1,40}$/.test(valor)) {
      extra.push(`charset=${valor.toLowerCase()}`);
    } else if (clave.toLowerCase() === 'method' && tipo === 'text/calendar' && /^[A-Za-z-]{1,20}$/.test(valor)) {
      extra.push(`method=${valor.toUpperCase()}`);
    }
  }
  return [tipo, ...extra].join('; ');
}

const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Valida y decodifica los adjuntos de /v1/send. Lanza el error que verá la
 * aplicación: 400 si un adjunto no es válido y 413 si entre todos superan
 * MAX_ADJUNTOS_BYTES. El tamaño se estima antes de decodificar, para no
 * reservar memoria de más con una petición que se va a rechazar.
 */
export function prepararAdjuntos(
  lista: { filename: string; contentType: string; content: string }[],
): { adjuntos: AdjuntoPreparado[]; bytes: number } {
  const limpios = lista.map((a) => ({ ...a, content: a.content.replace(/\s+/g, '') }));
  const estimado = limpios.reduce((total, a) => total + Math.floor((a.content.length * 3) / 4), 0);
  const demasiado = () =>
    new HttpError(
      413,
      `Los adjuntos superan el máximo de ${MAX_ADJUNTOS_BYTES / (1024 * 1024)} MB por mensaje (sumados y una vez decodificados).`,
      'attachments_too_large',
    );
  if (estimado > MAX_ADJUNTOS_BYTES + 3 * limpios.length) throw demasiado();

  const adjuntos: AdjuntoPreparado[] = [];
  let bytes = 0;
  for (const adjunto of limpios) {
    const saneado = sanearNombreAdjunto(adjunto.filename);
    const visible = saneado || 'adjunto';
    const contentType = tipoAdjunto(adjunto.contentType, visible);
    const tipo = TIPOS_ADJUNTO[contentType.split(';')[0]!]!;
    const punto = saneado.lastIndexOf('.');
    const extension = punto > 0 ? saneado.slice(punto + 1).toLowerCase() : '';
    let filename = saneado;
    if (!extension || !saneado) {
      filename = `${saneado || 'adjunto'}.${tipo.extensiones[0]}`;
    } else if (!tipo.extensiones.includes(extension)) {
      // Sin esta comprobación, «factura.pdf.exe» declarado como PDF llegaría
      // al destinatario con la extensión que de verdad decide qué se ejecuta.
      throw badRequest(
        `El nombre «${saneado}» no corresponde al tipo ${contentType.split(';')[0]}: usa la extensión .${tipo.extensiones[0]}.`,
        'attachment_type_not_allowed',
      );
    }
    if (!BASE64_RE.test(adjunto.content) || adjunto.content.length % 4 === 1) {
      throw badRequest(
        `El contenido del adjunto «${filename}» no está codificado en base64.`,
        'attachment_invalid',
      );
    }
    const content = Buffer.from(adjunto.content, 'base64');
    if (content.length === 0) {
      throw badRequest(`El adjunto «${filename}» está vacío.`, 'attachment_invalid');
    }
    if (!tipo.firma(content)) {
      throw badRequest(
        `El contenido del adjunto «${filename}» no es un fichero de tipo ${contentType.split(';')[0]}.`,
        'attachment_invalid',
      );
    }
    bytes += content.length;
    if (bytes > MAX_ADJUNTOS_BYTES) throw demasiado();
    adjuntos.push({ filename, contentType, content });
  }
  return { adjuntos, bytes };
}

/* ----------------------------- Idempotencia ------------------------------- */

/** Lo que dura guardada la respuesta de un envío con Idempotency-Key. */
export const IDEMPOTENCIA_MS = 24 * 3600_000;
/**
 * Una reserva sin respuesta más antigua que esto se da por abandonada y el
 * reintento con la misma clave vuelve a enviar. Un envío termina mucho antes
 * (el SMTP del motor está en la misma red); si sigue sin respuesta, el
 * proceso que la hizo se detuvo a mitad, y sin este margen cada reintento
 * recibiría 409 durante 24 horas aunque el mensaje no hubiera salido.
 */
export const IDEMPOTENCIA_EN_CURSO_MAX_MS = 15 * 60_000;
/** De 1 a 200 caracteres ASCII imprimibles (los espacios de los extremos los quita Node). */
const IDEMPOTENCY_KEY_RE = /^[\x20-\x7e]{1,200}$/;

function leerIdempotencyKey(req: FastifyRequest): string | null {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return null;
  const valor = Array.isArray(raw) ? raw.join(', ') : raw;
  if (!valor.trim() || !IDEMPOTENCY_KEY_RE.test(valor)) {
    throw badRequest(
      'La cabecera Idempotency-Key debe tener entre 1 y 200 caracteres ASCII imprimibles (por ejemplo, un UUID).',
      'invalid_idempotency_key',
    );
  }
  return valor;
}

/** JSON con las claves ordenadas: el orden de los campos no hace distinto un cuerpo. */
function jsonEstable(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(jsonEstable).join(',')}]`;
  if (valor && typeof valor === 'object') {
    const objeto = valor as Record<string, unknown>;
    return `{${Object.keys(objeto)
      .filter((k) => objeto[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jsonEstable(objeto[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(valor) ?? 'null';
}

function sha256(texto: string): string {
  return crypto.createHash('sha256').update(texto).digest('hex');
}

let ultimaPodaIdempotencia = 0;

function podarIdempotencia(t: number): void {
  if (t - ultimaPodaIdempotencia < VENTANA_MINUTO_MS) return;
  ultimaPodaIdempotencia = t;
  db.prepare('DELETE FROM send_idempotency WHERE expires_at <= ?').run(t);
}

/**
 * Al arrancar el servidor no hay ningún envío en marcha: las reservas que
 * siguen sin respuesta las dejó un proceso anterior que se detuvo a mitad
 * (un redespliegue, falta de memoria). Se retiran para que el reintento con
 * la misma clave funcione al momento. Devuelve cuántas había.
 */
export function liberarIdempotenciaInterrumpida(): number {
  return db.prepare('DELETE FROM send_idempotency WHERE response_json IS NULL').run().changes;
}

type ResultadoIdempotencia =
  | { tipo: 'repeticion'; status: number; respuesta: unknown }
  | { tipo: 'reserva'; completar: (status: number, respuesta: unknown) => void; anular: () => void };

/**
 * Reserva la Idempotency-Key de una clave de API o devuelve la respuesta ya
 * guardada. Comprobar e insertar es síncrono (better-sqlite3), así que dos
 * reintentos simultáneos no pasan los dos: el segundo ve la fila en curso.
 * Solo se guardan los envíos que llegaron a ejecutarse (enviados o
 * rechazados por el SMTP); un 429 o un error interno anulan la reserva para
 * que el reintento con la misma clave funcione. Completar y anular solo
 * tocan la reserva propia (por su created_at): si se dio por abandonada y
 * otra petición la sustituyó, no la pisan.
 */
function reservarIdempotencia(apiKeyId: string, clave: string, cuerpoHash: string): ResultadoIdempotencia {
  const t = now();
  podarIdempotencia(t);
  const keyHash = sha256(clave);
  const fila = db
    .prepare('SELECT * FROM send_idempotency WHERE api_key_id = ? AND key_hash = ?')
    .get(apiKeyId, keyHash) as
    | {
        request_hash: string;
        status_code: number | null;
        response_json: string | null;
        created_at: number;
        expires_at: number;
      }
    | undefined;
  if (fila && fila.expires_at > t) {
    if (!mismaHuella(fila.request_hash, cuerpoHash)) {
      throw conflict(
        'Esta Idempotency-Key ya se usó con esta clave de API para un mensaje distinto. Usa una clave nueva para cada mensaje.',
        'idempotency_conflict',
      );
    }
    if (fila.response_json !== null) {
      return { tipo: 'repeticion', status: fila.status_code ?? 200, respuesta: JSON.parse(fila.response_json) };
    }
    if (t - fila.created_at < IDEMPOTENCIA_EN_CURSO_MAX_MS) {
      throw conflict(
        'Hay otra petición con la misma Idempotency-Key en curso. Reintenta en unos segundos.',
        'idempotency_in_progress',
      );
    }
    // Abandonada: se sustituye por una reserva nueva y el mensaje se envía.
  }
  if (fila) {
    db.prepare('DELETE FROM send_idempotency WHERE api_key_id = ? AND key_hash = ?').run(apiKeyId, keyHash);
  }
  db.prepare(
    `INSERT INTO send_idempotency (api_key_id, key_hash, request_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(apiKeyId, keyHash, cuerpoHash, t, t + IDEMPOTENCIA_MS);
  return {
    tipo: 'reserva',
    completar: (status, respuesta) => {
      db.prepare(
        `UPDATE send_idempotency SET status_code = ?, response_json = ?
         WHERE api_key_id = ? AND key_hash = ? AND created_at = ?`,
      ).run(status, JSON.stringify(respuesta), apiKeyId, keyHash, t);
    },
    anular: () => {
      db.prepare(
        `DELETE FROM send_idempotency
         WHERE api_key_id = ? AND key_hash = ? AND created_at = ? AND response_json IS NULL`,
      ).run(apiKeyId, keyHash, t);
    },
  };
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

/** Máximo de cabeceras adicionales por mensaje. */
const MAX_CABECERAS = 30;

/** Nombre de cabecera admitido: letras, cifras y guiones (RFC 5322, sin «:» ni espacios). */
const NOMBRE_CABECERA = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/**
 * Cabeceras que no se pueden poner a mano en `headers`. nodemailer calcula el
 * sobre SMTP con las de direcciones: un «Bcc» o un «Cc» puesto aquí añadía
 * destinatarios sin pasar por la comprobación de direcciones ni por los
 * límites de 50/20/20, y un «From» o un «Sender» cambiaba el remitente que
 * fija la clave. Las de estructura (Content-*, MIME-Version) romperían el
 * mensaje, y las de autenticación (DKIM, ARC, Authentication-Results) solo
 * sirven para falsificar comprobaciones. Lo que tiene campo propio (to, cc,
 * bcc, replyTo, subject) va por su campo.
 */
const CABECERA_RESERVADA =
  /^(from|sender|to|cc|bcc|reply-to|subject|date|return-path|delivered-to|envelope-to|received|received-spf|mime-version|content-.*|resent-.*|dkim-signature|arc-.*|authentication-results)$/i;

const cabecerasSchema = z
  .record(
    z
      .string()
      .max(500)
      // Un salto de línea en el valor empezaría otra cabecera.
      .refine((v) => !/[\r\n\0]/.test(v), {
        message: 'El valor de una cabecera no puede contener saltos de línea.',
      }),
  )
  .superRefine((cabeceras, ctx) => {
    const nombres = Object.keys(cabeceras);
    if (nombres.length > MAX_CABECERAS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Se admiten como máximo ${MAX_CABECERAS} cabeceras adicionales por mensaje.`,
      });
    }
    for (const nombre of nombres) {
      if (!NOMBRE_CABECERA.test(nombre)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [nombre],
          message: `«${nombre.slice(0, 64)}» no es un nombre de cabecera válido: usa solo letras, cifras y guiones (p. ej. X-Campaign).`,
        });
      } else if (CABECERA_RESERVADA.test(nombre)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [nombre],
          message: `La cabecera «${nombre}» no se puede indicar en «headers»: los destinatarios, el remitente y el asunto van en sus campos (to, cc, bcc, replyTo, subject) y la estructura del mensaje la pone Mailway.`,
        });
      }
    }
  });

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
  headers: cabecerasSchema.optional(),
  attachments: z
    .array(
      z.object({
        filename: z
          .string({ required_error: 'Cada adjunto necesita un nombre de fichero («filename»).' })
          .max(255, 'El nombre de un adjunto admite como máximo 255 caracteres.'),
        contentType: z
          .string({ required_error: 'Cada adjunto necesita su tipo («contentType»), por ejemplo application/pdf.' })
          .max(200),
        content: z
          .string({ required_error: 'Cada adjunto necesita su contenido en base64 («content»).' })
          .min(1, 'El contenido de un adjunto no puede estar vacío.'),
      }),
    )
    .max(MAX_ADJUNTOS, `Se admiten como máximo ${MAX_ADJUNTOS} adjuntos por mensaje.`)
    .optional(),
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
      'Falta la cabecera Authorization. Usa: Authorization: Bearer mw_… (tu clave de API).',
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
      'El buzón remitente de esta clave ya no existe. Crea una clave nueva con otro remitente.',
      'sender_missing',
    );
  }
  if (mailbox.status === 'suspended') {
    throw forbidden(
      `El buzón remitente ${mailbox.email} está suspendido y no puede enviar correo. Reactívalo en el panel o utiliza otra clave.`,
      'sender_suspended',
    );
  }
  return mailbox;
}

export function registerSendRoutes(app: FastifyInstance): void {
  // Tope propio: los adjuntos (hasta 10 MB decodificados) no caben en los
  // 5 MB del resto de la API.
  app.post('/v1/send', { bodyLimit: MAX_PETICION_ENVIO_BYTES }, async (req, reply) => {
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

    // Se valida el cuerpo ANTES de contar nada: un envío malformado no debe
    // gastar ni la ventana por minuto ni el cupo diario.
    const body = sendSchema.parse(req.body);
    if (!body.html && !body.text) {
      throw badRequest('Incluye «html», «text» o ambos con el contenido del mensaje.');
    }
    const adjuntos = prepararAdjuntos(body.attachments ?? []);

    // Un reintento con la misma Idempotency-Key recibe la respuesta original
    // sin volver a enviar ni gastar cupo. Va después de validar: un cuerpo no
    // válido no reserva nada.
    const idempotencyKey = leerIdempotencyKey(req);
    let reserva: Extract<ResultadoIdempotencia, { tipo: 'reserva' }> | null = null;
    if (idempotencyKey) {
      const resultado = reservarIdempotencia(keyRow.id, idempotencyKey, sha256(jsonEstable(body)));
      if (resultado.tipo === 'repeticion') {
        reply.header('Idempotent-Replayed', 'true');
        reply.status(resultado.status);
        return resultado.respuesta;
      }
      reserva = resultado;
    }

    try {
      // Los límites del plan son del cliente (todas sus claves suman); el
      // límite diario propio de una clave, si lo tiene, la acota además a ella.
      checkPerMinute(`cliente:${client.id}`, plan.apiPerMinuteLimit);
      const liberarCupoCliente = reservarCupoCliente(client.id, plan.apiDailyLimit);

      // Reserva atómica del cupo de la clave: incrementar y comprobar de forma
      // síncrona cierra la carrera con el await del envío.
      const effectiveDaily = effectiveDailyLimit(plan.apiDailyLimit, keyRow.daily_limit);
      const reserved = reserveDailyUsage(keyRow.id);
      if (effectiveDaily > 0 && reserved > effectiveDaily) {
        releaseDailyUsage(keyRow.id);
        liberarCupoCliente();
        throw tooMany(
          `Se ha alcanzado el límite diario de ${effectiveDaily} envíos de esta clave. El contador se reinicia a medianoche UTC.`,
          'daily_limit_reached',
        );
      }

      try {
        const respuesta = await enviar(req, keyRow, mailbox, body, adjuntos);
        reserva?.completar(200, respuesta);
        return respuesta;
      } finally {
        liberarCupoCliente();
      }
    } catch (err) {
      reserva?.anular();
      throw err;
    }
  });
}

/** Envía por el SMTP del motor y deja la fila en `messages` (que cuenta para el cupo). */
async function enviar(
  req: FastifyRequest,
  keyRow: ApiKeyRow,
  mailbox: Mailbox,
  body: z.infer<typeof sendSchema>,
  adjuntos: { adjuntos: AdjuntoPreparado[]; bytes: number },
): Promise<{ id: string; status: 'sent' | 'failed'; error?: string; messageId?: string }> {
  const from = body.fromName
    ? { name: body.fromName, address: mailbox.email }
    : mailbox.email;

  const messageId = randomId('msg');
  const engineSettings = getEngineSettings();
  let status: 'sent' | 'failed' = 'sent';
  let error = '';
  let smtpMessageId = '';
  const sizeBytes = messageSizeBytes(body) + adjuntos.bytes;

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
        attachments: adjuntos.adjuntos.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          content: a.content,
          contentDisposition: 'attachment' as const,
        })),
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
  // El cupo ya se reservó antes de llamar aquí; no se vuelve a incrementar.
  // Un envío fallido conserva la reserva y su fila cuenta para el cupo del
  // cliente (evita reintentos ilimitados ante un motor caído).
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), keyRow.id);

  if (status === 'failed') {
    return {
      id: messageId,
      status,
      error: `No se pudo entregar al servidor SMTP: ${error}`,
    };
  }
  return { id: messageId, status, messageId: smtpMessageId };
}
