import type { FastifyInstance } from 'fastify';
import { db, now } from '../core/db';
import { badRequest } from '../core/errors';
import { getEngine, engineConfigured } from '../engine';
import { requireAdmin, requireAuth, requireClientAccess } from './auth';
import { getClient, getClientUsage, getPlan } from './clients';
import { webmailUrlForClient } from './connection';
import { listDomains } from './domains';
import { direccionesObligatorias } from './mailboxes';
import { getInstanceSettings } from './settings';

function count(sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

export function registerDashboardRoutes(app: FastifyInstance): void {
  /** Panel del administrador de la instancia. */
  app.get('/api/dashboard/admin', async (req) => {
    requireAdmin(req);
    const dayAgo = now() - 24 * 3600_000;
    const monthAgo = now() - 30 * 24 * 3600_000;

    let engineHealth: { ok: boolean; detail?: string } = {
      ok: false,
      detail: 'Motor sin configurar',
    };
    let queue = { pending: 0, oldestSeconds: null as number | null };
    if (engineConfigured()) {
      const engine = getEngine();
      engineHealth = await engine.ping();
      if (engineHealth.ok) {
        queue = await engine.getQueueSummary().catch(() => queue);
      }
    }

    return {
      totals: {
        clients: count('SELECT COUNT(*) AS c FROM clients'),
        domains: count('SELECT COUNT(*) AS c FROM domains'),
        domainsActive: count(`SELECT COUNT(*) AS c FROM domains WHERE status = 'active'`),
        mailboxes: count('SELECT COUNT(*) AS c FROM mailboxes'),
        apiKeys: count('SELECT COUNT(*) AS c FROM api_keys WHERE revoked_at IS NULL'),
      },
      messages: {
        last24h: count('SELECT COUNT(*) AS c FROM messages WHERE created_at >= ?', dayAgo),
        failed24h: count(
          `SELECT COUNT(*) AS c FROM messages WHERE created_at >= ? AND status = 'failed'`,
          dayAgo,
        ),
        last30d: count('SELECT COUNT(*) AS c FROM messages WHERE created_at >= ?', monthAgo),
      },
      engine: engineHealth,
      queue,
      instance: getInstanceSettings(),
    };
  });

  /** Panel del cliente: uso frente a límites y lista para el onboarding. */
  app.get('/api/dashboard/client', async (req) => {
    const user = requireAuth(req);
    const clientId = user.role === 'client' ? user.clientId! : (req.query as { clientId?: string }).clientId;
    if (!clientId) throw badRequest('Indica el cliente (parámetro clientId).', 'client_required');
    requireClientAccess(req, clientId);

    const client = getClient(clientId);
    const plan = getPlan(client.planId);
    const usage = getClientUsage(clientId);
    const domains = listDomains(clientId);
    const weekAgo = now() - 7 * 24 * 3600_000;

    const hasActiveDomain = domains.some((d) => d.status === 'active');
    const hasMailbox = usage.mailboxes > 0;
    const hasApiKey = usage.apiKeys > 0;
    const hasSentMessage =
      count('SELECT COUNT(*) AS c FROM messages WHERE client_id = ?', clientId) > 0;
    // postmaster@ y abuse@ solo se pueden crear con la propiedad comprobada:
    // se exigen en esos dominios (y sin ninguno, aún no toca).
    const verificados = domains.filter((d) => d.ownershipVerifiedAt !== null);
    const hasEssentialAddresses =
      verificados.length > 0 &&
      verificados.every((d) => direccionesObligatorias(d).every((a) => a.kind !== null));

    return {
      client: { id: client.id, name: client.name, suspended: client.suspended },
      plan,
      usage,
      domains,
      messages: {
        last7d: count(
          'SELECT COUNT(*) AS c FROM messages WHERE client_id = ? AND created_at >= ?',
          clientId,
          weekAgo,
        ),
        failed7d: count(
          `SELECT COUNT(*) AS c FROM messages WHERE client_id = ? AND created_at >= ? AND status = 'failed'`,
          clientId,
          weekAgo,
        ),
      },
      onboarding: {
        hasDomain: domains.length > 0,
        hasActiveDomain,
        hasMailbox,
        hasApiKey,
        hasSentMessage,
        ownershipVerified: verificados.length > 0,
        hasEssentialAddresses,
        mailboxes: usage.mailboxes,
      },
      // El webmail con la marca del cliente, si ya lo tiene en marcha.
      webmailUrl: webmailUrlForClient(clientId),
    };
  });
}
