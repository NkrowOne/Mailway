import { domainToASCII, domainToUnicode } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { withLock } from '../core/locks';
import { randomId } from '../core/crypto';
import { badRequest, conflict, HttpError, isUniqueViolation, notFound } from '../core/errors';
import { getEngine } from '../engine';
import type { EngineDnsRecord } from '../engine/types';
import { resolveAlert } from './alerts';
import { audit } from './audit';
import { refreshAutoconfigForDomain } from './autoconfig';
import { requireAuth, requireClientAccess, type AuthedUser } from './auth';
import { assertWithinLimit } from './clients';
import { aplicarDnsDominio, moverReservaDominio, permiteInstancia, pideSoloCliente, reservaDeDominio } from './cloudflare';
import { checkDomainDns, type DomainDnsReport } from './deliverability';
import { borrarRemitenteConfiguracion } from './remitente';
import { forgetTransport } from './transactional';
import {
  categoriaDe,
  destinosMx,
  esObligatorio,
  evaluarConflicto,
  exigirMxPublico,
  generarZona,
  mxInternos,
  nombreFichero,
  registroPropiedad,
  registrosDelDominio,
  tokenPropiedad,
  type NivelZona,
} from './zonefile';
import { lookupMx, lookupTxt, type MxRecord } from '../core/dns';
import { getInstanceSettings } from './settings';

/** Registro TXT que demuestra la propiedad del dominio sin tocar el MX. */
export interface OwnershipRecord {
  type: 'TXT';
  name: string;
  content: string;
}

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
  /**
   * Cuándo quedó probado que el dominio es de su cliente (MX a este
   * servidor o TXT de verificación). null = pendiente: no se pueden crear
   * buzones ni alias. Una vez fijado no se borra.
   */
  ownershipVerifiedAt: number | null;
  /** TXT que prueba la propiedad sin cambiar el MX. */
  ownershipRecord: OwnershipRecord;
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
  owner_verified_at: number | null;
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
    ownershipVerifiedAt: row.owner_verified_at ?? null,
    ownershipRecord: ownershipRecord(row.domain),
  };
}

/* -------------------------- Propiedad del dominio ------------------------- */

/**
 * Token de verificación de propiedad de un dominio. Derivado del secreto de
 * la instancia: es estable (no hay que guardarlo) e imposible de adivinar.
 * Vive en zonefile.ts porque el TXT forma parte de la selección común de
 * registros (tabla, fichero de zona y Cloudflare).
 */
export function ownershipToken(domain: string): string {
  return tokenPropiedad(domain);
}

/**
 * Registro TXT que demuestra la propiedad sin tocar el MX (útil para
 * preparar los buzones antes de migrar el correo de otro proveedor).
 */
export function ownershipRecord(domain: string): OwnershipRecord {
  const r = registroPropiedad(domain);
  return { type: 'TXT', name: r.name, content: r.content };
}

function sinPuntoFinal(valor: string): string {
  return valor.trim().replace(/\.$/, '').toLowerCase();
}

/** Quita comillas y espacios de un TXT para comparar solo su texto. */
function textoTxt(valor: string): string {
  return valor.replace(/"\s*"/g, '').replace(/["\s]/g, '').toLowerCase();
}

/**
 * ¿Demuestra el DNS público que el dominio es de quien lo dio de alta?
 * - Sí, si algún MX apunta a este servidor (cualquier prioridad: controlar
 *   el MX es controlar el dominio).
 * - Sí, si el TXT de verificación contiene el token.
 * - null si alguna de las dos consultas no se pudo hacer y la otra no lo
 *   prueba: un corte de red no es un «no».
 * Función pura para poder probar la regla sin red.
 */
export function evaluarPropiedad(input: {
  mx: MxRecord[] | null;
  txt: string[] | null;
  /** Nombres de este servidor de correo (el de Ajustes y el MX que propone el motor). */
  hosts: string[];
  /** Contenido esperado del TXT (`mailway-verificacion=…`). */
  esperado: string;
}): boolean | null {
  const hosts = new Set(input.hosts.map(sinPuntoFinal).filter(Boolean));
  if (input.mx?.some((r) => hosts.has(sinPuntoFinal(r.exchange)))) return true;
  const esperado = textoTxt(input.esperado);
  if (esperado && input.txt?.some((t) => textoTxt(t).includes(esperado))) return true;
  if (input.mx === null || input.txt === null) return null;
  return false;
}

/**
 * Nombres de este servidor de correo: el de Ajustes y el destino MX que
 * propone el motor. Se descartan los que caen dentro del propio dominio
 * (mail.<dominio>): quien controla el dominio controla ese nombre, así que
 * apuntar el MX ahí no demuestra nada.
 */
function hostsDelServidor(domain: string, records: EngineDnsRecord[]): string[] {
  const deAjustes = getInstanceSettings().mailHostname;
  const delMotor = records
    .filter((r) => r.type.toUpperCase() === 'MX')
    .map((r) => r.content.trim().split(/\s+/).slice(-1)[0] || '');
  const dominio = sinPuntoFinal(domain);
  return [deAjustes, ...delMotor]
    .map(sinPuntoFinal)
    .filter((h) => h && h !== dominio && !h.endsWith(`.${dominio}`));
}

/**
 * Deja constancia de que la propiedad quedó probada. Nunca se borra: un MX
 * que se mueve después (migración, avería) no convierte el dominio en ajeno.
 */
export function marcarPropiedadComprobada(domainId: string): void {
  db.prepare('UPDATE domains SET owner_verified_at = COALESCE(owner_verified_at, ?) WHERE id = ?').run(
    now(),
    domainId,
  );
}

/**
 * Sin propiedad comprobada no se crean buzones ni alias: si no, un cliente
 * podría dar de alta un dominio ajeno (gmail.com) y el motor entregaría en
 * local el correo que otros clientes del servidor envían a ese dominio.
 * Se aplica a todos, también a la administración y a los tokens (Skyway
 * trabaja con un token de administrador en nombre de sus proyectos).
 */
export function assertDomainOwnership(domainId: string): void {
  const row = db.prepare('SELECT domain, owner_verified_at FROM domains WHERE id = ?').get(domainId) as
    | { domain: string; owner_verified_at: number | null }
    | undefined;
  if (!row) throw notFound('Dominio no encontrado.');
  if (row.owner_verified_at) return;
  throw conflict(
    `Antes de crear buzones o alias en ${domainToUnicode(row.domain) || row.domain} es necesario comprobar que el dominio es tuyo: apunta el registro MX a este servidor o añade el registro TXT de verificación que se indica en la ficha del dominio y pulsa «Verificar» en esa misma ficha.`,
    'domain_ownership_pending',
  );
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
      'El dominio no es válido. Introdúcelo sin «http://» ni rutas, por ejemplo: miempresa.com',
    );
  }
  return ascii;
}

/**
 * Comprueba la propiedad de un dominio que aún no la tiene probada: el MX
 * (cualquier prioridad) y el TXT de verificación. Solo se consulta mientras
 * esté pendiente, así que los dominios ya probados no pagan estas consultas.
 */
async function comprobarPropiedad(domain: DomainRecord, records: EngineDnsRecord[]): Promise<boolean | null> {
  const [mx, txt] = await Promise.all([lookupMx(domain.domain), lookupTxt(domain.ownershipRecord.name)]);
  return evaluarPropiedad({
    mx,
    txt,
    hosts: hostsDelServidor(domain.domain, records),
    esperado: domain.ownershipRecord.content,
  });
}

/**
 * Lanza la verificación DNS y persiste el resultado y el estado del dominio.
 * La usan la ficha («Medir el DNS ahora»), el vigilante y Cloudflare, así
 * que es también donde se prueba la propiedad del dominio.
 */
export async function refreshDomainDns(domainId: string): Promise<DomainRecord> {
  const domain = getDomain(domainId);
  const engine = getEngine();
  const records = await engine.getDnsRecords(domain.domain);
  const report = await checkDomainDns(domain.domain, records);
  if (domain.ownershipVerifiedAt === null) {
    const propiedad = await comprobarPropiedad(domain, records).catch(() => null);
    if (propiedad === true) marcarPropiedadComprobada(domainId);
  }

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
        domain: z.string({ required_error: 'Introduce el dominio.' }).min(3, 'Introduce el dominio.'),
        clientId: z.string().optional(),
        autoDns: z
          .boolean({ invalid_type_error: 'El campo «autoDns» debe ser verdadero o falso.' })
          .optional(),
      })
      .parse(req.body);

    const clientId = user.role === 'admin' ? body.clientId || '' : user.clientId!;
    if (!clientId) throw badRequest('Indica a qué cliente pertenece el dominio.');
    requireClientAccess(req, clientId);
    const domain = normalizeDomain(body.domain);
    // Todas las altas de dominio van en fila: entre comprobar que el dominio
    // no existe y guardarlo hay llamadas al motor, y dos altas simultáneas
    // del mismo dominio (de clientes distintos) acabarían con una borrando
    // en el motor el dominio que la otra acababa de crear.
    const id = await withLock('altas:dominios', async () => {
      assertWithinLimit(clientId, 'domains', 1, user.role === 'admin');
      const existing = db.prepare('SELECT 1 FROM domains WHERE domain = ?').get(domain);
      if (existing) throw conflict('Ese dominio ya está dado de alta en esta instancia.', 'domain_exists');
      // Si el administrador escribió el DNS de este dominio con una cuenta de
      // Cloudflare de la instancia, sus registros (MX, TXT de verificación)
      // siguen en la zona del operador aunque el dominio se haya borrado, y
      // probarían la propiedad al instante: solo ese cliente o el
      // administrador (no en nombre de un cliente) pueden volver a darlo de alta.
      const reserva = reservaDeDominio(domain);
      const comoAdministrador = user.role === 'admin' && !pideSoloCliente(req.query);
      if (reserva && reserva.client_id !== clientId && !comoAdministrador) {
        throw conflict(
          'Este dominio está reservado: su DNS lo configuró el administrador de la plataforma con su cuenta de Cloudflare. Solicita al administrador que lo dé de alta.',
          'domain_reserved',
        );
      }

      const engine = getEngine();
      // El motor adopta un dominio que ya existiera allí (p. ej. huérfano de un
      // borrado interrumpido): el panel es la fuente de verdad.
      await engine.createDomain(domain);
      try {
        await engine.ensureDkim(domain, 'mail');
      } catch (err) {
        // El dominio queda creado; el DKIM se puede regenerar desde el panel.
        req.log.warn({ err, domain }, 'No se ha podido generar el DKIM al crear el dominio');
      }

      const nuevoId = randomId('dom');
      try {
        db.prepare(
          `INSERT INTO domains (id, client_id, domain, dkim_selector, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(nuevoId, clientId, domain, 'mail', now());
      } catch (err) {
        // Si el dominio ya existe en la base (otra alta lo guardó entre la
        // comprobación y el INSERT), el dominio del motor es el de esa alta:
        // borrarlo dejaría sin correo un dominio que el panel muestra activo.
        if (isUniqueViolation(err)) {
          throw conflict('Ese dominio ya está dado de alta en esta instancia.', 'domain_exists');
        }
        // Cualquier otro fallo (p. ej. el cliente se borró en paralelo): se
        // deshace el dominio en el motor para no dejarlo huérfano.
        await engine.deleteDomain(domain).catch(() => undefined);
        throw err;
      }
      // El administrador decide a quién sirven esos registros: la reserva pasa al cliente nuevo.
      if (reserva && reserva.client_id !== clientId) moverReservaDominio(domain, clientId);
      return nuevoId;
    });
    audit(req, 'domain.created', { id, domain, clientId }, clientId);

    // DNS automático: si una cuenta de Cloudflare accesible contiene la zona,
    // se aplican los registros sin reemplazar nada que ya exista. Un fallo
    // aquí no deshace el alta: el dominio existe y el DNS se puede aplicar
    // después desde su ficha. `?soloCliente=1` limita las cuentas a las del
    // cliente, como en la ficha (lo envía Skyway para usuarios que no son
    // administradores).
    let cloudflare: ResultadoAutoDns | null = null;
    let cloudflareReason: string | undefined;
    if (body.autoDns) {
      try {
        // Solo crear: el alta no modifica nada de lo que ya hay en la zona (ni
        // el SPF, ni un proxy, ni un registro con el comentario de Mailway);
        // eso queda para «Aplicar» en la ficha, tras revisar el plan.
        const r = await aplicarDnsDominio(id, {
          replaceConflicts: false,
          includeRecommended: true,
          permitirInstancia: permiteInstancia(user, req.query),
          soloCrear: true,
        });
        if ('unavailable' in r) {
          cloudflareReason = r.unavailable;
        } else {
          cloudflare = { applied: r.applied, errors: r.errors, skipped: r.skipped };
          audit(
            req,
            'cloudflare.dns_applied',
            {
              domainId: id,
              domain,
              zone: r.zone.name,
              applied: r.applied.length,
              errors: r.errors.length,
              replaceConflicts: false,
            },
            clientId,
          );
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
                  : 'No se ha podido aplicar el DNS en Cloudflare. Vuelve a intentarlo desde la ficha del dominio.',
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
   * nombres de otras zonas; al final va el TXT de verificación de la
   * propiedad (categoría «verificacion»).
   */
  app.get('/api/domains/:id/dns', async (req) => {
    const { id } = req.params as { id: string };
    const { domain } = requireDomainAccess(req, id);
    const engine = getEngine();
    const delMotor = await engine.getDnsRecords(domain.domain);
    const records = registrosDelDominio(domain.domain, delMotor).map(
      (r) => ({ ...r, required: esObligatorio(r), category: categoriaDe(r) }),
    );
    // Una integración que muestre la tabla debe poder avisar igual que la
    // ficha: con un MX interno, el fichero de zona y Cloudflare responden 409.
    return { records, mxInternos: mxInternos(domain.domain, delMotor) };
  });

  /**
   * ¿Este dominio ya recibe correo en otro proveedor? Se consulta antes de
   * ofrecer la descarga: importar sobre un dominio en uso rompe su correo.
   */
  app.get('/api/domains/:id/conflicto', async (req) => {
    const { id } = req.params as { id: string };
    const { domain } = requireDomainAccess(req, id);
    const [mx, txt, dmarc, delMotor] = await Promise.all([
      lookupMx(domain.domain),
      lookupTxt(domain.domain),
      lookupTxt(`_dmarc.${domain.domain}`),
      // Sin respuesta del motor se compara solo con el nombre de Ajustes: un
      // motor caído no puede dejar sin aviso a quien va a importar la zona.
      getEngine()
        .getDnsRecords(domain.domain)
        .catch(() => null),
    ]);
    return evaluarConflicto({
      mx,
      txt,
      dmarc,
      mailHostname: getInstanceSettings().mailHostname,
      mxEsperados: delMotor ? destinosMx(domain.domain, delMotor) : null,
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
    exigirMxPublico(domain.domain, records);
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
    const { domain: antes } = requireDomainAccess(req, id);
    const domain = await refreshDomainDns(id);
    const auto = (req.query as { auto?: string }).auto === '1';
    const propiedadNueva = antes.ownershipVerifiedAt === null && domain.ownershipVerifiedAt !== null;
    if (!auto || domain.status !== antes.status || propiedadNueva) {
      audit(
        req,
        'domain.verified',
        { id, status: domain.status, ...(propiedadNueva ? { ownershipVerified: true } : {}) },
        domain.clientId,
      );
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
   * Orden: primero los alias de OTROS dominios que reenvían a buzones de
   * este (en el motor, los miembros de una lista deben existir), después los
   * alias propios, luego los buzones y, al final, el dominio. Cada elemento
   * se borra primero en el motor y, si se consigue, en la base de datos; así,
   * si el motor falla a mitad, el panel refleja exactamente lo que queda y un
   * segundo intento completa el trabajo.
   *
   * Las claves de API cuyo remitente es un buzón del dominio dejan de
   * funcionar con él (se eliminan en cascada): se cuentan en la
   * confirmación, en la respuesta y en la auditoría para que no desaparezcan
   * en silencio.
   */
  app.delete('/api/domains/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { domain } = requireDomainAccess(req, id);
    const mailboxCount = (
      db.prepare('SELECT COUNT(*) AS c FROM mailboxes WHERE domain_id = ?').get(id) as { c: number }
    ).c;
    const apiKeys = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM api_keys k JOIN mailboxes m ON m.id = k.sender_mailbox_id
           WHERE m.domain_id = ? AND k.revoked_at IS NULL`,
        )
        .get(id) as { c: number }
    ).c;
    const confirm = (req.query as { confirm?: string }).confirm === domain.domain;
    if (mailboxCount > 0 && !confirm) {
      const buzones = mailboxCount === 1 ? '1 buzón' : `${mailboxCount} buzones`;
      const claves =
        apiKeys === 0
          ? ''
          : apiKeys === 1
            ? ' y 1 clave de API que envía desde sus buzones (dejará de funcionar)'
            : ` y ${apiKeys} claves de API que envían desde sus buzones (dejarán de funcionar)`;
      throw conflict(
        `Este dominio tiene ${buzones} con su correo${claves}. Para eliminarlo todo definitivamente, confirma escribiendo el nombre del dominio.`,
        'needs_confirmation',
      );
    }
    const engine = getEngine();
    const fallidos: string[] = [];

    const externos = await retirarReenviosAlDominio(id, domain.domain, (err, email) =>
      req.log.warn({ err, email }, 'No se ha podido actualizar en el motor un alias que reenviaba al dominio'),
    );
    fallidos.push(...externos.fallidos);

    const aliases = db
      .prepare('SELECT id, local_part FROM aliases WHERE domain_id = ?')
      .all(id) as { id: string; local_part: string }[];
    for (const alias of aliases) {
      const email = `${alias.local_part}@${domain.domain}`;
      try {
        await engine.deleteAlias(email);
        db.prepare('DELETE FROM aliases WHERE id = ?').run(alias.id);
      } catch (err) {
        req.log.warn({ err, email }, 'No se ha podido borrar el alias en el motor');
        fallidos.push(email);
      }
    }

    // Si un alias de otro dominio no se pudo actualizar, los buzones a los
    // que reenvía se conservan: borrarlos dejaría la lista del motor con un
    // miembro inexistente. El reintento lo completa.
    const mailboxes = externos.fallidos.length > 0
      ? []
      : (db.prepare('SELECT id, local_part FROM mailboxes WHERE domain_id = ?').all(id) as {
          id: string;
          local_part: string;
        }[]);
    for (const mailbox of mailboxes) {
      const email = `${mailbox.local_part}@${domain.domain}`;
      try {
        await engine.deleteMailbox(email);
        db.prepare('DELETE FROM mailboxes WHERE id = ?').run(mailbox.id);
      } catch (err) {
        req.log.warn({ err, email }, 'No se ha podido borrar el buzón en el motor');
        fallidos.push(email);
      }
    }

    if (fallidos.length > 0) {
      const fallidosPropios = fallidos.length - externos.fallidos.length;
      audit(
        req,
        'domain.delete_partial',
        {
          id,
          domain: domain.domain,
          removed: mailboxes.length + aliases.length - fallidosPropios,
          failed: fallidos,
          aliasesUpdated: externos.actualizados,
          aliasesDeleted: externos.eliminados,
        },
        domain.clientId,
      );
      throw new HttpError(
        502,
        `No se han podido modificar en el servidor de correo: ${fallidos.join(', ')}. El resto se ha completado. Vuelve a intentarlo para terminar la eliminación del dominio.`,
        'partial_delete',
      );
    }

    // La cuenta oculta configuration@ (correos de configuración) va antes que
    // el dominio del motor. Si no se puede borrar, no se detiene el borrado:
    // queda huérfana sin que nadie conozca su contraseña y, si el dominio
    // vuelve a darse de alta, se adopta con una nueva.
    if (!(await borrarRemitenteConfiguracion(domain))) {
      req.log.warn({ domain: domain.domain }, 'No se ha podido borrar en el motor la cuenta remitente de configuración');
    }
    forgetTransport(`config:${id}`);

    await engine.deleteDomain(domain.domain);
    db.prepare('DELETE FROM domains WHERE id = ?').run(id);
    // El vigilante ya no volverá a mirar este dominio: su alerta quedaría
    // abierta para siempre en el panel del administrador y del cliente.
    resolveAlert(`domain_dns:${id}`);
    audit(
      req,
      'domain.deleted',
      {
        id,
        domain: domain.domain,
        mailboxes: mailboxCount,
        apiKeys,
        aliasesUpdated: externos.actualizados,
        aliasesDeleted: externos.eliminados,
      },
      domain.clientId,
    );
    return {
      ok: true,
      apiKeysRevoked: apiKeys,
      aliasesUpdated: externos.actualizados,
      aliasesDeleted: externos.eliminados,
    };
  });
}

/* ------------------- Alias de otros dominios al borrar ------------------- */

interface AliasAjeno {
  id: string;
  local_part: string;
  destinations_json: string;
  domain: string;
}

function destinosDe(json: string): string[] {
  try {
    const valor = JSON.parse(json) as unknown;
    return Array.isArray(valor) ? valor.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** true si la dirección es un buzón de esta instancia (destino interno de un alias). */
function esBuzonDeLaInstancia(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM mailboxes m JOIN domains d ON d.id = m.domain_id
         WHERE d.domain = ? AND m.local_part = ?`,
      )
      .get(email.slice(at + 1).toLowerCase(), email.slice(0, at).toLowerCase()),
  );
}

/**
 * Quita de los alias de OTROS dominios (de cualquier cliente: versiones
 * anteriores admitían destinos de otros clientes) los destinos que son
 * direcciones del dominio que se borra. Un alias que se queda sin destinos
 * no entrega a nadie y se elimina. Mismo criterio que el borrado de un
 * buzón suelto; cada alias se guarda en la base justo después de cambiarlo
 * en el motor para que ambos coincidan aunque algo falle a mitad.
 */
async function retirarReenviosAlDominio(
  domainId: string,
  domain: string,
  onError: (err: unknown, email: string) => void,
): Promise<{ actualizados: string[]; eliminados: string[]; fallidos: string[] }> {
  const engine = getEngine();
  const sufijo = `@${domain.toLowerCase()}`;
  const candidatos = db
    .prepare(
      `SELECT a.id, a.local_part, a.destinations_json, d.domain
       FROM aliases a JOIN domains d ON d.id = a.domain_id
       WHERE a.domain_id != ? AND lower(a.destinations_json) LIKE ?`,
    )
    .all(domainId, `%${sufijo}"%`) as AliasAjeno[];
  const actualizados: string[] = [];
  const eliminados: string[] = [];
  const fallidos: string[] = [];
  for (const alias of candidatos) {
    const destinos = destinosDe(alias.destinations_json);
    const restantes = destinos.filter((d) => !d.toLowerCase().endsWith(sufijo));
    if (restantes.length === destinos.length) continue;
    const email = `${alias.local_part}@${alias.domain}`;
    try {
      if (restantes.length === 0) {
        await engine.deleteAlias(email);
        db.prepare('DELETE FROM aliases WHERE id = ?').run(alias.id);
        eliminados.push(email);
      } else {
        const internos = restantes.filter(esBuzonDeLaInstancia);
        const externos = restantes.filter((d) => !internos.includes(d));
        await engine.upsertAlias(email, internos, externos);
        db.prepare('UPDATE aliases SET destinations_json = ? WHERE id = ?').run(JSON.stringify(restantes), alias.id);
        actualizados.push(email);
      }
    } catch (err) {
      onError(err, email);
      fallidos.push(email);
    }
  }
  return { actualizados, eliminados, fallidos };
}
