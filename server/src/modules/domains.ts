import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { randomId } from '../core/crypto';
import { badRequest, conflict, notFound } from '../core/errors';
import { getEngine } from '../engine';
import { audit } from './audit';
import { requireAuth, requireClientAccess, type AuthedUser } from './auth';
import { assertWithinLimit } from './clients';
import { checkDomainDns, type DomainDnsReport } from './deliverability';
import { evaluarConflicto, generarZona, nombreFichero, type NivelZona } from './zonefile';
import { lookupMx, lookupTxt } from '../core/dns';
import { getInstanceSettings } from './settings';

export interface DomainRecord {
  id: string;
  clientId: string;
  domain: string;
  status: 'pending_dns' | 'active' | 'error';
  dkimSelector: string;
  dnsStatus: Partial<DomainDnsReport>;
  lastCheckedAt: number | null;
  verifiedAt: number | null;
  createdAt: number;
}

interface DomainRow {
  id: string;
  client_id: string;
  domain: string;
  status: 'pending_dns' | 'active' | 'error';
  dkim_selector: string;
  dns_status_json: string;
  last_checked_at: number | null;
  verified_at: number | null;
  created_at: number;
}

function toDomain(row: DomainRow): DomainRecord {
  let dnsStatus: Partial<DomainDnsReport> = {};
  try {
    dnsStatus = JSON.parse(row.dns_status_json);
  } catch {
    // estado corrupto: se recalculará en la próxima verificación
  }
  return {
    id: row.id,
    clientId: row.client_id,
    domain: row.domain,
    status: row.status,
    dkimSelector: row.dkim_selector,
    dnsStatus,
    lastCheckedAt: row.last_checked_at,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
  };
}

export function getDomain(id: string): DomainRecord {
  const row = db.prepare('SELECT * FROM domains WHERE id = ?').get(id) as DomainRow | undefined;
  if (!row) throw notFound('Dominio no encontrado.');
  return toDomain(row);
}

export function listDomains(clientId?: string): DomainRecord[] {
  const rows = clientId
    ? (db
        .prepare('SELECT * FROM domains WHERE client_id = ? ORDER BY created_at DESC')
        .all(clientId) as DomainRow[])
    : (db.prepare('SELECT * FROM domains ORDER BY created_at DESC').all() as DomainRow[]);
  return rows.map(toDomain);
}

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function normalizeDomain(input: string): string {
  const domain = input.trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN_RE.test(domain)) {
    throw badRequest(
      'El dominio no es válido. Escríbelo sin "http://" ni "www", por ejemplo: miempresa.com',
    );
  }
  return domain;
}

/** Lanza la verificación DNS y persiste el resultado y el estado del dominio. */
export async function refreshDomainDns(domainId: string): Promise<DomainRecord> {
  const domain = getDomain(domainId);
  const engine = getEngine();
  const records = await engine.getDnsRecords(domain.domain);
  const report = await checkDomainDns(domain.domain, records);

  // Un check 'unknown' significa "no se pudo consultar el DNS" (fallo de red),
  // que es distinto de "el registro no existe" ('missing'/'mismatch'). Solo se
  // degrada el estado si hay un fallo DEFINITIVO; un corte de red temporal no
  // debe marcar como "sin configurar" un dominio que ya estaba verificado.
  const definitiveFailure = (report.checks ?? []).some(
    (c) => c.required && (c.status === 'missing' || c.status === 'mismatch'),
  );
  const newStatus = report.allRequiredOk
    ? 'active'
    : definitiveFailure
      ? 'pending_dns'
      : domain.status; // sin datos concluyentes: se conserva el estado previo

  db.prepare(
    `UPDATE domains SET dns_status_json = ?, last_checked_at = ?, status = ?,
       verified_at = COALESCE(verified_at, ?)
     WHERE id = ?`,
  ).run(
    JSON.stringify(report),
    now(),
    newStatus,
    report.allRequiredOk ? now() : null,
    domainId,
  );
  return getDomain(domainId);
}

function requireDomainAccess(req: Parameters<typeof requireAuth>[0], domainId: string): {
  user: AuthedUser;
  domain: DomainRecord;
} {
  const domain = getDomain(domainId);
  const user = requireClientAccess(req, domain.clientId);
  return { user, domain };
}

export function registerDomainRoutes(app: FastifyInstance): void {
  app.get('/api/domains', async (req) => {
    const user = requireAuth(req);
    if (user.role === 'admin') {
      const { clientId } = req.query as { clientId?: string };
      return { domains: listDomains(clientId) };
    }
    return { domains: listDomains(user.clientId!) };
  });

  app.post('/api/domains', async (req) => {
    const user = requireAuth(req);
    const body = z
      .object({
        domain: z.string().min(3),
        clientId: z.string().optional(),
      })
      .parse(req.body);

    const clientId = user.role === 'admin' ? body.clientId || '' : user.clientId!;
    if (!clientId) throw badRequest('Indica a qué cliente pertenece el dominio.');
    requireClientAccess(req, clientId);
    assertWithinLimit(clientId, 'domains');

    const domain = normalizeDomain(body.domain);
    const existing = db.prepare('SELECT 1 FROM domains WHERE domain = ?').get(domain);
    if (existing) throw conflict('Ese dominio ya está dado de alta en esta instancia.');

    const engine = getEngine();
    await engine.createDomain(domain);
    try {
      await engine.ensureDkim(domain, 'mail');
    } catch (err) {
      // El dominio queda creado; el DKIM se puede regenerar desde el panel.
      req.log.warn({ err, domain }, 'No se pudo generar DKIM al crear el dominio');
    }

    const id = randomId('dom');
    try {
      db.prepare(
        `INSERT INTO domains (id, client_id, domain, dkim_selector, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, clientId, domain, 'mail', now());
    } catch (err) {
      // Deshacemos el dominio en el motor para no dejarlo huérfano si el
      // INSERT falla (p. ej. el cliente se borró en paralelo).
      await engine.deleteDomain(domain).catch(() => undefined);
      throw err;
    }
    audit(req, 'domain.created', { id, domain, clientId });

    // Primera verificación inmediata para pintar el asistente con datos reales.
    const fresh = await refreshDomainDns(id).catch(() => getDomain(id));
    return { domain: fresh };
  });

  app.get('/api/domains/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { domain } = requireDomainAccess(req, id);
    return { domain };
  });

  /** Registros DNS que hay que crear (tabla para copiar y pegar). */
  app.get('/api/domains/:id/dns', async (req) => {
    const { id } = req.params as { id: string };
    const { domain } = requireDomainAccess(req, id);
    const engine = getEngine();
    const records = await engine.getDnsRecords(domain.domain);
    return { records };
  });

  /**
   * ¿Este dominio ya recibe correo en otro proveedor? Se consulta antes de
   * ofrecer la descarga: importar sobre un dominio en uso rompe su correo.
   */
  app.get('/api/domains/:id/conflicto', async (req) => {
    const { id } = req.params as { id: string };
    const { domain } = requireDomainAccess(req, id);
    const [mx, txt, dmarc] = await Promise.all([
      lookupMx(domain.domain),
      lookupTxt(domain.domain),
      lookupTxt(`_dmarc.${domain.domain}`),
    ]);
    return evaluarConflicto({
      mx,
      txt,
      dmarc,
      mailHostname: getInstanceSettings().mailHostname,
    });
  });

  /**
   * Fichero de zona BIND listo para importar en Cloudflare y equivalentes.
   * Evita el copiado a mano, que es donde se cuelan los DKIM truncados.
   */
  app.get('/api/domains/:id/zonefile', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { domain } = requireDomainAccess(req, id);
    const { nivel } = req.query as { nivel?: string };
    const elegido: NivelZona =
      nivel === 'obligatorios' || nivel === 'recomendados' || nivel === 'completo'
        ? nivel
        : 'recomendados';

    const engine = getEngine();
    const records = await engine.getDnsRecords(domain.domain);
    const zona = generarZona({ domain: domain.domain, records, nivel: elegido });

    audit(req, 'domain.zonefile_downloaded', { id, domain: domain.domain, nivel: elegido });
    reply
      .type('text/plain; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="${nombreFichero(domain.domain, elegido)}"`,
      );
    return zona;
  });

  /** Verificación en vivo: consulta el DNS público y actualiza el estado. */
  app.post('/api/domains/:id/verify', async (req) => {
    const { id } = req.params as { id: string };
    requireDomainAccess(req, id);
    const domain = await refreshDomainDns(id);
    audit(req, 'domain.verified', { id, status: domain.status });
    return { domain };
  });

  /** Regenera las claves DKIM en el motor (si se borraron o rotan). */
  app.post('/api/domains/:id/dkim', async (req) => {
    const { id } = req.params as { id: string };
    const { domain } = requireDomainAccess(req, id);
    const engine = getEngine();
    await engine.ensureDkim(domain.domain, domain.dkimSelector);
    audit(req, 'domain.dkim_regenerated', { id, domain: domain.domain });
    return { ok: true };
  });

  app.delete('/api/domains/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { domain } = requireDomainAccess(req, id);
    const mailboxCount = (
      db.prepare('SELECT COUNT(*) AS c FROM mailboxes WHERE domain_id = ?').get(id) as { c: number }
    ).c;
    const confirm = (req.query as { confirm?: string }).confirm === domain.domain;
    if (mailboxCount > 0 && !confirm) {
      throw conflict(
        `Este dominio tiene ${mailboxCount} buzón(es) con su correo dentro. Para borrarlo todo definitivamente, confirma escribiendo el dominio.`,
        'needs_confirmation',
      );
    }
    const engine = getEngine();
    // Primero el motor: si falla, no dejamos huérfanos en Mailway.
    const mailboxes = db
      .prepare('SELECT local_part FROM mailboxes WHERE domain_id = ?')
      .all(id) as { local_part: string }[];
    for (const mailbox of mailboxes) {
      await engine.deleteMailbox(`${mailbox.local_part}@${domain.domain}`);
    }
    const aliases = db
      .prepare('SELECT local_part FROM aliases WHERE domain_id = ?')
      .all(id) as { local_part: string }[];
    for (const alias of aliases) {
      await engine.deleteAlias(`${alias.local_part}@${domain.domain}`).catch(() => undefined);
    }
    await engine.deleteDomain(domain.domain);
    db.prepare('DELETE FROM domains WHERE id = ?').run(id);
    audit(req, 'domain.deleted', { id, domain: domain.domain, mailboxes: mailboxCount });
    return { ok: true };
  });
}
