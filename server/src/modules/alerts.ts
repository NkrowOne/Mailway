import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { channelsConfigured, dispatch, getChannels, type Severity } from '../core/notify';
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
  } catch {
    // El índice único parcial rechaza el INSERT: ya hay una alerta abierta
    // con esta clave. No es un error, es el dedupe funcionando.
    return false;
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
      message: 'El problema que se avisó antes ya no está presente.',
    }).catch(() => undefined);
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

const channelsSchema = z.object({
  webhookUrl: z.string().url('URL no válida.').or(z.literal('')),
  discordUrl: z.string().url('URL no válida.').or(z.literal('')),
  telegramToken: z.string().trim().max(200),
  telegramChat: z.string().trim().max(60),
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
    db.prepare('UPDATE alerts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(
      now(),
      Number(id),
    );
    audit(req, 'alert.dismissed', { id });
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
    setJsonSetting('notify', {
      ...body,
      telegramToken: body.telegramToken || current.telegramToken,
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
        error: 'No hay ningún canal configurado todavía. Rellena al menos uno y guarda.',
      };
    }
    const failures = await dispatch({
      severity: 'info',
      title: 'Aviso de prueba',
      message: 'Si lees esto, Mailway puede avisarte por este canal cuando algo vaya mal.',
      remedy: 'No tienes que hacer nada: es solo una prueba.',
    });
    audit(req, 'notify.test_sent', { failures });
    return {
      ok: failures.length === 0,
      delivered: configured.filter((c) => !failures.includes(c)),
      failures,
    };
  });
}
