import { domainToASCII, domainToUnicode } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { randomId } from '../core/crypto';
import { badRequest, conflict, HttpError, notFound } from '../core/errors';
import { getEngine } from '../engine';
import { audit } from './audit';
import { refreshAutoconfigForDomain } from './autoconfig';
import { requireAuth, requireClientAccess, type AuthedUser } from './auth';
import { assertWithinLimit } from './clients';
import { aplicarDnsDominio } from './cloudflare';
import { checkDomainDns, type DomainDnsReport } from './deliverability';
import {
  categoriaDe,
  esObligatorio,
  evaluarConflicto,
  generarZona,
  nombreFichero,
  seleccionarRegistros,
  type NivelZona,
} from './zonefile';
import { lookupMx, lookupTxt } from '../core/dns';
import { getInstanceSettings } from './settings';

export interface DomainRecord {
  id: string;
  clientId: string;
  /** Nombre en ASCII (punycode para los dominios con «ñ» o acentos). */
  domain: string;
  /** El mismo nombre en Unicode, para mostrarlo. Igual a `domain` si no es IDN. */
  domainUnicode: string;
  status: 'pending_dns' | 'active' | 'error';
  dkimSelector: string;
  dnsStatus: Partial<DomainDnsReport>;
  lastCheckedAt: number | null;
  verifiedAt: number | null;
  createdAt: number;
  /** Cuenta y zona de Cloudflare donde vive su DNS, si Mailway lo gestiona. */
  cloudflare: { accountId: string; zoneId: string } | null;
  /** Última vez que Mailway aplicó su DNS en Cloudflare. */
  dnsAppliedAt: number | null;
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
  cloudflare_account_id: string | null;
  cloudflare_zone_id: string | null;
  dns_applied_at: number | null;
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
    domainUnicode: domainToUnicode(row.domain) || row.domain,
    status: row.status,
    dkimSelector: row.dkim_selector,
    dnsStatus,
    lastCheckedAt: row.last_checked_at,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    cloudflare:
      row.cloudflare_account_id && row.cloudflare_zone_id
        ? { accountId: row.cloudflare_account_id, zoneId: row.cloudflare_zone_id }
        : null,
    dnsAppliedAt: row.dns_applied_at ?? null,
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

/**
 * Etiquetas de 1 a 63 caracteres y un dominio de primer nivel alfabético o
 * internacionalizado (xn--…), ya en ASCII.
 */
const DOMAIN_RE =
  /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * Normaliza lo que escribe el usuario: admite la URL completa o «www.» por
 * descuido y dominios con «ñ» o acentos, que se guardan en punycode porque
 * el DNS y el motor de correo solo trabajan en ASCII.
 */
export function normalizeDomain(input: string): string {
  const limpio = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '');
  const ascii = limpio ? domainToASCII(limpio) : '';
  if (!ascii || !DOMAIN_RE.test(ascii)) {
    throw badRequest(
      'El dominio no es válido. Introdúzcalo sin «http://» ni rutas, por ejemplo: miempresa.com',
    );
  }
  return ascii;
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
  if (newStatus === 'active') {
    // Con el dominio en marcha, sus hosts autoconfig./autodiscover./mta-sts.
    // pueden publicarse ya en Traefik sin esperar a la vuelta horaria del
    // vigilante. En segundo plano: la verificación no espera a este DNS.
    void refreshAutoconfigForDomain(domainId).catch(() => undefined);
  }
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

/** Resultado de configurar el DNS en Cloudflare al dar de alta el dominio. */
interface ResultadoAutoDns {
  applied: { action: string; type: string; name: string }[];
  errors: { type: string; name: string; error: string }[];
  skipped: { type: string; name: string; reason: string }[];
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
        domain: z.string({ required_error: 'Introduzca el dominio.' }).min(3, 'Introduzca el dominio.'),
        clientId: z.string().optional(),
        autoDns: z
          .boolean({ invalid_type_error: 'El campo «autoDns» debe ser verdadero o falso.' })
          .optional(),
      })
      .parse(req.body);

    const clientId = user.role === 'admin' ? body.clientId || '' : user.clientId!;
    if (!clientId) throw badRequest('Indique a qué cliente pertenece el dominio.');
    requireClientAccess(req, clientId);
    assertWithinLimit(clientId, 'domains');

    const domain = normalizeDomain(body.domain);
    const existing = db.prepare('SELECT 1 FROM domains WHERE domain = ?').get(domain);
    if (existing) throw conflict('Ese dominio ya está dado de alta en esta instancia.');

    const engine = getEngine();
    // El motor adopta un dominio que ya existiera allí (p. ej. huérfano de un
    // borrado interrumpido): el panel es la fuente de verdad.
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
      // Se deshace el dominio en el motor para no dejarlo huérfano si el
      // INSERT falla (p. ej. el cliente se borró en paralelo).
      await engine.deleteDomain(domain).catch(() => undefined);
      throw err;
    }
    audit(req, 'domain.created', { id, domain, clientId });

    // DNS automático: si una cuenta de Cloudflare accesible contiene la zona,
    // se aplican los registros sin reemplazar nada que ya exista. Un fallo
    // aquí no deshace el alta: el dominio existe y el DNS se puede aplicar
    // después desde su ficha.
    let cloudflare: ResultadoAutoDns | null = null;
    let cloudflareReason: string | undefined;
    if (body.autoDns) {
      try {
        const r = await aplicarDnsDominio(id, user, { replaceConflicts: false, includeRecommended: true });
        if ('unavailable' in r) {
          cloudflareReason = r.unavailable;
        } else {
          cloudflare = { applied: r.applied, errors: r.errors, skipped: r.skipped };
          audit(req, 'cloudflare.dns_applied', {
            domainId: id,
            domain,
            zone: r.zone.name,
            applied: r.applied.length,
            errors: r.errors.length,
            replaceConflicts: false,
          });
        }
      } catch (err) {
        cloudflare = {
          applied: [],
          errors: [
            {
              type: '',
              name: domain,
              error:
                err instanceof HttpError
                  ? err.message
                  : 'No se ha podido aplicar el DNS en Cloudflare. Vuelva a intentarlo desde la ficha del dominio.',
            },
          ],
          skipped: [],
        };
      }
    }

    // Primera verificación inmediata para pintar el asistente con datos reales
    // (si se aplicó en Cloudflare, ya se midió al aplicar).
    const fresh =
      cloudflare && cloudflare.applied.length > 0
        ? getDomain(id)
        : await refreshDomainDns(id).catch(() => getDomain(id));
    return {
      domain: fresh,
      cloudflare,
      ...(cloudflareReason ? { cloudflareReason } : {}),
    };
  });

  app.get('/api/domains/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { domain } = requireDomainAccess(req, id);
    return { domain };
  });

  /**
   * Registros DNS que hay que crear (tabla para copiar y pegar, o para que
   * una integración los cree). Pasan por la misma selección que la
   * comprobación y Cloudflare: sin SRV de puertos cerrados, sin TLSA y sin
   * nombres de otras zonas.
   */
  app.get('/api/domains/:id/dns', async (req) => {
    const { id } = req.params as { id: string };
    const { domain } = requireDomainAccess(req, id);
    const engine = getEngine();
    const records = seleccionarRegistros(domain.domain, await engine.getDnsRecords(domain.domain)).map(
      (r) => ({ ...r, required: esObligatorio(r), category: categoriaDe(r) }),
    );
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

    audit(req, 'domain.zonefile_downloaded', { id, domain: domain.domain, nivel: elegido }, domain.clientId);
    reply
      .type('text/plain; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="${nombreFichero(domain.domain, elegido)}"`,
      );
    return zona;
  });

  /**
   * Verificación en vivo: consulta el DNS público y actualiza el estado.
   * Con `?auto=1` (sondeo de la web tras aplicar el DNS) no se audita cada
   * vuelta: serían veinte entradas idénticas en la actividad.
   */
  app.post('/api/domains/:id/verify', async (req) => {
    const { id } = req.params as { id: string };
    requireDomainAccess(req, id);
    const antes = getDomain(id).status;
    const domain = await refreshDomainDns(id);
    const auto = (req.query as { auto?: string }).auto === '1';
    if (!auto || domain.status !== antes) {
      audit(req, 'domain.verified', { id, status: domain.status }, domain.clientId);
    }
    return { domain };
  });

  /** Regenera las claves DKIM en el motor (si se borraron o rotan). */
  app.post('/api/domains/:id/dkim', async (req) => {
    const { id } = req.params as { id: string };
    const { domain } = requireDomainAccess(req, id);
    const engine = getEngine();
    await engine.ensureDkim(domain.domain, domain.dkimSelector);
    audit(req, 'domain.dkim_regenerated', { id, domain: domain.domain }, domain.clientId);
    return { ok: true };
  });

  /**
   * Borrado completo: buzones, alias y dominio, en el motor y en Mailway.
   *
   * Cada buzón se borra primero en el motor y, si se consigue, en la base de
   * datos; así, si el motor falla a mitad, el panel refleja exactamente lo
   * que queda y un segundo intento completa el trabajo. El dominio solo se
   * borra cuando ya no le queda nada.
   */
  app.delete('/api/domains/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { domain } = requireDomainAccess(req, id);
    const mailboxCount = (
      db.prepare('SELECT COUNT(*) AS c FROM mailboxes WHERE domain_id = ?').get(id) as { c: number }
    ).c;
    const confirm = (req.query as { confirm?: string }).confirm === domain.domain;
    if (mailboxCount > 0 && !confirm) {
      throw conflict(
        `Este dominio tiene ${mailboxCount} buzón(es) con su correo. Para eliminarlo todo definitivamente, confirme escribiendo el nombre del dominio.`,
        'needs_confirmation',
      );
    }
    const engine = getEngine();
    const fallidos: string[] = [];

    const mailboxes = db
      .prepare('SELECT id, local_part FROM mailboxes WHERE domain_id = ?')
      .all(id) as { id: string; local_part: string }[];
    for (const mailbox of mailboxes) {
      const email = `${mailbox.local_part}@${domain.domain}`;
      try {
        await engine.deleteMailbox(email);
        db.prepare('DELETE FROM mailboxes WHERE id = ?').run(mailbox.id);
      } catch (err) {
        req.log.warn({ err, email }, 'No se pudo borrar el buzón en el motor');
        fallidos.push(email);
      }
    }

    const aliases = db
      .prepare('SELECT id, local_part FROM aliases WHERE domain_id = ?')
      .all(id) as { id: string; local_part: string }[];
    for (const alias of aliases) {
      const email = `${alias.local_part}@${domain.domain}`;
      try {
        await engine.deleteAlias(email);
        db.prepare('DELETE FROM aliases WHERE id = ?').run(alias.id);
      } catch (err) {
        req.log.warn({ err, email }, 'No se pudo borrar el alias en el motor');
        fallidos.push(email);
      }
    }

    const borrados = mailboxes.length + aliases.length - fallidos.length;
    if (fallidos.length > 0) {
      audit(req, 'domain.delete_partial', { id, domain: domain.domain, removed: borrados, failed: fallidos }, domain.clientId);
      throw new HttpError(
        502,
        `No se han podido eliminar del servidor de correo: ${fallidos.join(', ')}. El resto se ha eliminado. Vuelva a intentarlo para completar la eliminación del dominio.`,
        'partial_delete',
      );
    }

    await engine.deleteDomain(domain.domain);
    db.prepare('DELETE FROM domains WHERE id = ?').run(id);
    audit(req, 'domain.deleted', { id, domain: domain.domain, mailboxes: mailboxCount }, domain.clientId);
    return { ok: true };
  });
}
