import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { channelsConfigured, dispatch, getChannels, type Severity } from '../core/notify';
import { isUniqueViolation, notFound } from '../core/errors';
import { setJsonSetting } from './settings';
import { audit } from './audit';
import { requireAdmin, requireAuth } from './auth';
import { getClient } from './clients';

export interface Alert {
  id: number;
  severity: Severity;
  type: string;
  clientId: string | null;
  title: string;
  message: string;
  remedy: string;
  createdAt: number;
  resolvedAt: number | null;
}

interface AlertRow {
  id: number;
  severity: Severity;
  type: string;
  client_id: string | null;
  title: string;
  message: string;
  remedy: string;
  dedupe_key: string | null;
  created_at: number;
  resolved_at: number | null;
}

function toAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    severity: row.severity,
    type: row.type,
    clientId: row.client_id,
    title: row.title,
    message: row.message,
    remedy: row.remedy,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export interface FireInput {
  severity: Severity;
  /** Identificador estable del tipo de problema (engine_down, dnsbl_listed...). */
  type: string;
  title: string;
  message: string;
  remedy?: string;
  clientId?: string | null;
  /**
   * Clave de deduplicación. Mientras exista una alerta abierta con esta clave
   * no se crea otra ni se vuelve a avisar: así un motor caído durante horas
   * no genera un aviso por minuto.
   */
  dedupeKey: string;
  /** Solo campana en el panel, sin enviar a Discord/Telegram/webhook. */
  quiet?: boolean;
}

/**
 * Abre una alerta si no había ya una igual abierta, y la envía a los canales.
 * Devuelve true si la alerta era nueva.
 */
export function fireAlert(input: FireInput): boolean {
  let inserted: { id: number } | undefined;
  try {
    inserted = db
      .prepare(
        `INSERT INTO alerts (severity, type, client_id, title, message, remedy, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.severity,
        input.type,
        input.clientId ?? null,
        input.title,
        input.message,
        input.remedy ?? '',
        input.dedupeKey,
        now(),
      ) as { id: number };
  } catch (err) {
    // El índice único parcial rechaza el INSERT: ya hay una alerta abierta
    // con esta clave. No es un error, es el dedupe funcionando. Cualquier
    // otro fallo (base bloqueada, cliente inexistente…) sí lo es: tragárselo
    // haría creer que el aviso ya estaba abierto cuando no se ha guardado.
    if (isUniqueViolation(err)) return false;
    throw err;
  }
  if (!inserted) return false;

  if (!input.quiet) {
    let clientName: string | null = null;
    if (input.clientId) {
      try {
        clientName = getClient(input.clientId).name;
      } catch {
        clientName = null;
      }
    }
    void dispatch({
      severity: input.severity,
      title: input.title,
      message: input.message,
      remedy: input.remedy,
      client: clientName,
    }).catch(() => undefined);
  }
  return true;
}

/**
 * Cierra las alertas abiertas de una clave. Si había alguna y se pide avisar,
 * manda un mensaje de recuperación (para no dejar al usuario con el susto).
 */
export function resolveAlert(dedupeKey: string, opts: { notify?: boolean; what?: string } = {}): void {
  const open = db
    .prepare('SELECT * FROM alerts WHERE dedupe_key = ? AND resolved_at IS NULL')
    .all(dedupeKey) as AlertRow[];
  if (open.length === 0) return;
  db.prepare('UPDATE alerts SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL').run(
    now(),
    dedupeKey,
  );
  if (opts.notify) {
    const first = open[0]!;
    void dispatch({
      severity: 'info',
      title: 'Resuelto: ' + (opts.what || first.title),
      message: 'El problema notificado anteriormente ya no está presente.',
    }).catch(() => undefined);
  }
}

/** ¿Hay una alerta abierta con esta clave? */
export function alertaAbierta(dedupeKey: string): boolean {
  return Boolean(
    db.prepare('SELECT 1 FROM alerts WHERE dedupe_key = ? AND resolved_at IS NULL LIMIT 1').get(dedupeKey),
  );
}

/**
 * Cierra las alertas abiertas de un tipo, salvo la de la clave `except`. Sirve
 * para los avisos cuya clave lleva los datos del problema (por ejemplo, los dos
 * nombres que no coinciden): si el problema cambia, el aviso anterior ya no
 * describe la situación y no debe quedarse abierto junto al nuevo.
 */
export function resolveAlertsOfType(
  type: string,
  opts: { except?: string; notify?: boolean; what?: string } = {},
): void {
  const keys = db
    .prepare('SELECT DISTINCT dedupe_key FROM alerts WHERE type = ? AND resolved_at IS NULL AND dedupe_key IS NOT NULL')
    .all(type) as { dedupe_key: string }[];
  for (const { dedupe_key: key } of keys) {
    if (key !== opts.except) resolveAlert(key, { notify: opts.notify, what: opts.what });
  }
}

export function listAlerts(opts: { clientId?: string; includeResolved?: boolean }): Alert[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeResolved) where.push('resolved_at IS NULL');
  if (opts.clientId) {
    where.push('client_id = ?');
    params.push(opts.clientId);
  }
  const sql = `SELECT * FROM alerts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY resolved_at IS NOT NULL, created_at DESC LIMIT 200`;
  return (db.prepare(sql).all(...params) as AlertRow[]).map(toAlert);
}

/**
 * El vigilante hace POST a estas URL desde el servidor: solo se aceptan
 * http(s), nunca `file:`, `data:` u otros esquemas que fetch trataría distinto.
 */
function esUrlHttp(valor: string): boolean {
  try {
    const url = new URL(valor);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

// Un único esquema con refine (y no `.url().or(z.literal(''))`): la unión de
// zod devuelve el mensaje genérico «Invalid input», en inglés y sin el campo.
const urlCanal = (campo: string) =>
  z
    .string()
    .trim()
    .max(2000, `La URL del ${campo} es demasiado larga.`)
    .refine(
      (u) => u === '' || esUrlHttp(u),
      `La URL del ${campo} no es válida: debe empezar por https://.`,
    );

const channelsSchema = z.object({
  webhookUrl: urlCanal('webhook genérico'),
  discordUrl: urlCanal('webhook de Discord'),
  telegramToken: z.string().trim().max(200),
  telegramChat: z.string().trim().max(60),
  /** Borra el token de Telegram guardado (vacío por sí solo significa «conservarlo»). */
  clearTelegramToken: z.boolean().optional(),
});

export function registerAlertRoutes(app: FastifyInstance): void {
  app.get('/api/alerts', async (req) => {
    const user = requireAuth(req);
    const { includeResolved } = req.query as { includeResolved?: string };
    if (user.role === 'admin') {
      return { alerts: listAlerts({ includeResolved: includeResolved === '1' }) };
    }
    return {
      alerts: listAlerts({ clientId: user.clientId!, includeResolved: includeResolved === '1' }),
    };
  });

  /** Descartar a mano una alerta (la cierra sin esperar al vigilante). */
  app.post('/api/alerts/:id/dismiss', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const alertId = Number(id);
    const row = Number.isSafeInteger(alertId)
      ? (db.prepare('SELECT id, resolved_at FROM alerts WHERE id = ?').get(alertId) as
          | { id: number; resolved_at: number | null }
          | undefined)
      : undefined;
    if (!row) throw notFound('Aviso no encontrado.');
    // Descartar dos veces (dos pestañas, doble clic) no es un error, pero solo
    // la primera cierra el aviso y queda en la auditoría.
    if (row.resolved_at === null) {
      db.prepare('UPDATE alerts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(
        now(),
        alertId,
      );
      audit(req, 'alert.dismissed', { id: alertId });
    }
    return { ok: true };
  });

  app.get('/api/notify/channels', async (req) => {
    requireAdmin(req);
    const c = getChannels();
    return {
      // El token de Telegram no se devuelve: solo si está puesto o no.
      channels: {
        webhookUrl: c.webhookUrl,
        discordUrl: c.discordUrl,
        telegramChat: c.telegramChat,
        hasTelegramToken: Boolean(c.telegramToken),
      },
      configured: channelsConfigured(),
    };
  });

  app.put('/api/notify/channels', async (req) => {
    requireAdmin(req);
    const body = channelsSchema.parse(req.body);
    // Token vacío = conservar el actual (para poder editar el resto sin
    // tener que volver a escribirlo).
    const current = getChannels();
    const { clearTelegramToken, ...channels } = body;
    setJsonSetting('notify', {
      ...channels,
      telegramToken: clearTelegramToken ? '' : channels.telegramToken || current.telegramToken,
    });
    audit(req, 'notify.channels_updated', { configured: channelsConfigured() });
    return { ok: true, configured: channelsConfigured() };
  });

  app.post('/api/notify/test', async (req) => {
    requireAdmin(req);
    const configured = channelsConfigured();
    if (configured.length === 0) {
      return {
        ok: false,
        error: 'Todavía no hay ningún canal configurado. Completa al menos uno y guarda los cambios.',
      };
    }
    const failures = await dispatch({
      severity: 'info',
      title: 'Aviso de prueba',
      message: 'Si recibes este mensaje, Mailway podrá avisarte por este canal cuando algo falle.',
      remedy: 'No es necesario hacer nada: se trata de una prueba.',
    });
    audit(req, 'notify.test_sent', { failures });
    return {
      ok: failures.length === 0,
      delivered: configured.filter((c) => !failures.includes(c)),
      failures,
    };
  });
}
