import { domainToASCII, domainToUnicode } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { clientLockKey, withLock } from '../core/locks';
import { randomId } from '../core/crypto';
import { badRequest, conflict, HttpError, isUniqueViolation, notFound } from '../core/errors';
import { engineConfigured, getEngine } from '../engine';
import type { EngineDnsRecord } from '../engine/types';
import { resolveAlert } from './alerts';
import { audit } from './audit';
import { refreshAutoconfigForDomain } from './autoconfig';
import { requireAuth, requireClientAccess, type AuthedUser } from './auth';
import { assertWithinLimit } from './clients';
import { aplicarDnsDominio, moverReservaDominio, permiteInstancia, pideSoloCliente, reservaDeDominio } from './cloudflare';
import { checkDomainDns, type DomainDnsReport } from './deliverability';
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
import { lookupA, lookupAaaa, lookupMx, lookupTxt, type MxRecord } from '../core/dns';
import { canonicalIpv6 } from '../core/hostnames';
import { sincronizarRecepcionExterna } from './recepcion';
import { dominiosPropiosDe, eliminarDominioPropio } from './whitelabel';
import { cambioAbiertoDeDominio, loginParaMotor, nombreEnMotor } from './direcciones';
import { getInstanceSettings, getSetting, setSetting } from './settings';

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
  /**
   * El MX público apunta a otro servidor (última medición definitiva): el
   * correo del dominio se recibe en otro proveedor y lo que se envía desde
   * aquí a sus direcciones sale por ese MX (modules/recepcion.ts).
   */
  recepcionExterna: boolean;
  /**
   * Cambio de dominio abierto en el que participa (dominio.es → dominio2.es),
   * o null. `pareja` es el otro dominio del cambio; `cuentaEnPlan` es false
   * para el origen: mientras dura el cambio no cuenta en el plan.
   */
  migracion: MigracionDominio | null;
}

export interface MigracionDominio {
  id: string;
  rol: 'origen' | 'destino';
  estado: string;
  pareja: string;
  cuentaEnPlan: boolean;
}

/** Papel del dominio en su cambio de dominio abierto, para la ficha, la lista y el resumen. */
function migracionDe(domainId: string): MigracionDominio | null {
  const cambio = cambioAbiertoDeDominio(domainId);
  if (!cambio) return null;
  return {
    id: cambio.id,
    rol: cambio.rol,
    estado: cambio.estado,
    pareja: cambio.rol === 'origen' ? cambio.toDomain : cambio.fromDomain,
    cuentaEnPlan: cambio.rol !== 'origen',
  };
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
  recepcion_externa: number;
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
    recepcionExterna: row.recepcion_externa === 1,
    migracion: migracionDe(row.id),
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
 * Sin propiedad comprobada no se crean buzones ni alias, y por tanto el
 * dominio tampoco existe en el motor (asegurarDominioEnMotor): si no, un
 * cliente podría dar de alta un dominio ajeno (gmail.com) y el motor
 * entregaría en local, o rechazaría, el correo que otros clientes del
 * servidor envían a ese dominio. Se aplica a todos, también a la
 * administración y a los tokens (Skyway trabaja con un token de
 * administrador en nombre de sus proyectos).
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

/**
 * Crea el dominio en el motor justo antes de su primer buzón o alias:
 * Stalwart rechaza un buzón cuyo dominio no existe como principal. Quien la
 * llama ya ha exigido la propiedad (assertDomainOwnership). Es idempotente:
 * el driver adopta un dominio que ya exista.
 */
export async function asegurarDominioEnMotor(domain: string): Promise<void> {
  await getEngine().createDomain(domain);
}

const CLAVE_RETIRADA = 'motor_dominios_sin_propiedad_retirados';

/**
 * Hasta la 1.2, el alta creaba el dominio en el motor antes de comprobar la
 * propiedad, así que un dominio ajeno dado de alta y nunca comprobado sigue
 * siendo local para el motor. Esta tarea, que se ejecuta una vez al arrancar
 * (y la repite el vigilante si el motor no respondía), lo retira del motor.
 *
 * Solo toca dominios sin propiedad comprobada y sin buzones ni alias (la
 * migración 004 marcó como comprobados los que los tenían). Cada uno se
 * vuelve a mirar dentro del cerrojo de su cliente, el mismo de las altas de
 * buzones y alias: si en ese momento se comprueba la propiedad y se crea un
 * buzón, no se le retira el dominio por debajo.
 */
export async function retirarDelMotorDominiosSinPropiedad(): Promise<{ retirados: string[]; fallidos: string[] } | null> {
  if (getSetting(CLAVE_RETIRADA) || !engineConfigured()) return null;
  const candidatos = db
    .prepare(
      `SELECT id, client_id, domain FROM domains d
       WHERE owner_verified_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM mailboxes m WHERE m.domain_id = d.id)
         AND NOT EXISTS (SELECT 1 FROM aliases a WHERE a.domain_id = d.id)`,
    )
    .all() as { id: string; client_id: string; domain: string }[];
  const retirados: string[] = [];
  const fallidos: string[] = [];
  for (const c of candidatos) {
    await withLock(clientLockKey(c.client_id), async () => {
      const sigue = db
        .prepare(
          `SELECT 1 FROM domains d WHERE d.id = ? AND owner_verified_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM mailboxes m WHERE m.domain_id = d.id)
             AND NOT EXISTS (SELECT 1 FROM aliases a WHERE a.domain_id = d.id)`,
        )
        .get(c.id);
      if (!sigue) return;
      try {
        // Idempotente: un dominio que el motor no tiene cuenta como retirado.
        await getEngine().deleteDomain(c.domain);
        retirados.push(c.domain);
      } catch {
        fallidos.push(c.domain);
      }
    });
  }
  // Con algún fallo (motor caído) se reintenta en la siguiente vuelta.
  if (fallidos.length === 0) setSetting(CLAVE_RETIRADA, String(now()));
  return { retirados, fallidos };
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
 * Normaliza lo que escribe el usuario: admite la URL completa (quita el
 * esquema, la ruta y el punto final) y dominios con «ñ» o acentos, que se
 * guardan en punycode porque el DNS y el motor de correo solo trabajan en
 * ASCII. NO quita «www.»: el correo en un subdominio es legítimo, así que
 * el alta lo pregunta (sinWwwSugerido y el código «domain_www»).
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
 * Dominio sin «www.» si lo que queda es un dominio válido: quien pega la URL
 * de la web (https://www.empresa.com/contacto) casi siempre quiere el correo
 * en empresa.com, no direcciones como ana@www.empresa.com. null si no empieza
 * por «www.» o si quitarlo no deja un dominio (www.es).
 */
export function sinWwwSugerido(domain: string): string | null {
  if (!domain.startsWith('www.')) return null;
  const resto = domain.slice(4);
  return DOMAIN_RE.test(resto) ? resto : null;
}

/**
 * Comprueba la propiedad de un dominio que aún no la tiene probada: el MX
 * (cualquier prioridad) y el TXT de verificación. Solo se consulta mientras
 * esté pendiente, así que los dominios ya probados no pagan estas consultas.
 */
async function comprobarPropiedad(
  domain: DomainRecord,
  records: EngineDnsRecord[],
  mx: MxRecord[] | null,
): Promise<boolean | null> {
  const txt = await lookupTxt(domain.ownershipRecord.name);
  return evaluarPropiedad({
    mx,
    txt,
    hosts: hostsDelServidor(domain.domain, records),
    esperado: domain.ownershipRecord.content,
  });
}

/**
 * ¿Recibe el dominio su correo en otro servidor? Sí si tiene MX y ninguno es
 * de este servidor (el nombre de Ajustes o el destino MX que propone el
 * motor). Un dominio sin MX no recibe en ningún otro sitio: se trata como
 * propio. null si no se pudo consultar: un corte de red no cambia nada.
 * Función pura para poder probar la regla sin red.
 */
export function evaluarRecepcionExterna(mx: MxRecord[] | null, propios: string[]): boolean | null {
  if (mx === null) return null;
  if (mx.length === 0) return false;
  const nuestros = new Set(propios.map(sinPuntoFinal).filter(Boolean));
  return !mx.some((r) => nuestros.has(sinPuntoFinal(r.exchange)));
}

/**
 * Confirma por IP lo que los nombres dan como recepción externa: un MX con
 * nombre propio (mx.cliente.es) cuyo A apunta a este servidor, o el nombre
 * anterior del servidor tras cambiarlo en Ajustes, también llevan el correo
 * aquí. Tratarlos como otro proveedor sacaría por MX el correo local (que
 * volvería a entrar desde Internet) y dejaría de validar los destinatarios
 * del dominio en las sesiones autenticadas.
 *
 * false si algún MX resuelve a la IP pública; true si todos se han podido
 * consultar y ninguno lo hace; null si alguno no se pudo consultar (como en
 * el resto de la medición, un corte de red no cambia nada). Sin IP pública
 * configurada, no hay con qué comparar y vale lo que dicen los nombres.
 */
export async function confirmarRecepcionExterna(mx: MxRecord[], publicIp: string): Promise<boolean | null> {
  const ip = publicIp.trim();
  if (!ip) return true;
  const v6 = ip.includes(':') ? canonicalIpv6(ip) : null;
  const destinos = [...new Set(mx.map((r) => sinPuntoFinal(r.exchange)).filter(Boolean))].slice(0, 10);
  let dudoso = false;
  for (const destino of destinos) {
    const direcciones = v6 ? await lookupAaaa(destino) : await lookupA(destino);
    if (direcciones === null) {
      dudoso = true;
      continue;
    }
    if (direcciones.some((d) => (v6 ? canonicalIpv6(d) === v6 : d.trim() === ip))) return false;
  }
  return dudoso ? null : true;
}

export interface MedicionDominio {
  domain: DomainRecord;
  /**
   * Resultado de la comprobación de la propiedad en esta medición: true o
   * false, null si el DNS no se pudo consultar y undefined si no hacía falta
   * (ya estaba comprobada).
   */
  propiedad: boolean | null | undefined;
}

/**
 * Lanza la verificación DNS y persiste el resultado y el estado del dominio.
 * La usan la ficha («Medir el DNS ahora»), el vigilante y Cloudflare, así
 * que es también donde se prueba la propiedad del dominio y se mide dónde
 * recibe su correo.
 */
export async function medirDominio(domainId: string): Promise<MedicionDominio> {
  const domain = getDomain(domainId);
  const engine = getEngine();
  const records = await engine.getDnsRecords(domain.domain);
  const mx = await lookupMx(domain.domain);
  const report = await checkDomainDns(domain.domain, records, { mx });
  let propiedad: boolean | null | undefined;
  if (domain.ownershipVerifiedAt === null) {
    propiedad = await comprobarPropiedad(domain, records, mx).catch(() => null);
    if (propiedad === true) marcarPropiedadComprobada(domainId);
  }
  const ajustes = getInstanceSettings();
  let externa = evaluarRecepcionExterna(mx, [ajustes.mailHostname, ...destinosMx(domain.domain, records)]);
  if (externa === true && mx) externa = await confirmarRecepcionExterna(mx, ajustes.publicIp).catch(() => null);

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
       verified_at = COALESCE(verified_at, ?),
       recepcion_externa = COALESCE(?, recepcion_externa)
     WHERE id = ?`,
  ).run(
    JSON.stringify(report),
    now(),
    newStatus,
    report.allRequiredOk ? now() : null,
    externa === null ? null : externa ? 1 : 0,
    domainId,
  );
  if (newStatus === 'active') {
    // Con el dominio en marcha, sus hosts autoconfig./autodiscover./mta-sts.
    // pueden publicarse ya en Traefik sin esperar a la vuelta horaria del
    // vigilante. En segundo plano: la verificación no espera a este DNS.
    void refreshAutoconfigForDomain(domainId).catch(() => undefined);
  }
  if (externa !== null && externa !== domain.recepcionExterna) {
    // El correo del dominio ha cambiado de servidor (traslado, baja): el
    // motor debe entregar ya donde dice el MX. En segundo plano y sin lanzar.
    void sincronizarRecepcionExterna().catch(() => undefined);
  }
  return { domain: getDomain(domainId), propiedad };
}

export async function refreshDomainDns(domainId: string): Promise<DomainRecord> {
  return (await medirDominio(domainId)).domain;
}

function requireDomainAccess(req: Parameters<typeof requireAuth>[0], domainId: string): {
  user: AuthedUser;
  domain: DomainRecord;
} {
  const domain = getDomain(domainId);
  const user = requireClientAccess(req, domain.clientId);
  return { user, domain };
}

/**
 * ¿Se dio de baja este dominio en un cambio de dominio de OTRO cliente? Tras
 * la baja, su TXT de verificación y quizá su MX siguen en el DNS de su antiguo
 * dueño y bastarían para «probar» la propiedad: queda reservado a ese cliente.
 */
function dadoDeBajaPorOtroCliente(domain: string, clientId: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM domain_migrations
         WHERE from_domain = ? AND estado = 'dado_de_baja' AND client_id <> ? LIMIT 1`,
      )
      .get(domain, clientId),
  );
}

/**
 * Comprueba si el dominio está reservado para otro cliente: su DNS lo escribió
 * el administrador con la cuenta de Cloudflare de la instancia, o lo dio de
 * baja otro cliente en un cambio de dominio. El administrador (no en nombre de
 * un cliente) puede darlo de alta igualmente. 409 domain_reserved.
 */
export function assertDominioNoReservado(domain: string, clientId: string, comoAdministrador: boolean): void {
  if (comoAdministrador) return;
  const reserva = reservaDeDominio(domain);
  if (reserva && reserva.client_id !== clientId) {
    throw conflict(
      'Este dominio está reservado: su DNS lo configuró el administrador de la plataforma con su cuenta de Cloudflare. Solicita al administrador que lo dé de alta.',
      'domain_reserved',
    );
  }
  if (dadoDeBajaPorOtroCliente(domain, clientId)) {
    throw conflict(
      'Este dominio perteneció a otro cliente de la plataforma. Solicita al administrador que lo dé de alta.',
      'domain_reserved',
    );
  }
}

/**
 * Alta de un dominio de correo con todas sus comprobaciones (plan, existencia
 * y reservas), su DKIM y la reserva de Cloudflare. Quien la llama ya tiene el
 * cerrojo 'altas:dominios': entre comprobar que el dominio no existe y
 * guardarlo hay llamadas al motor. La usan el alta de dominios y la creación
 * de un cambio de dominio (el dominio nuevo). Devuelve el id del dominio.
 */
export async function altaDeDominioSinCerrojo(input: {
  clientId: string;
  domain: string;
  /** Administrador que no actúa en nombre de un cliente (sin `soloCliente=1`): salta las reservas. */
  comoAdministrador: boolean;
  /** Quien pide es administrador (solo cambia el texto del límite del plan). */
  esAdministrador: boolean;
  /** Fallo del DKIM, que no impide el alta (se puede regenerar desde la ficha). */
  avisar?: (err: unknown) => void;
}): Promise<string> {
  const { clientId, domain } = input;
  assertWithinLimit(clientId, 'domains', 1, input.esAdministrador);
  const existing = db.prepare('SELECT 1 FROM domains WHERE domain = ?').get(domain);
  if (existing) throw conflict('Ese dominio ya está dado de alta en esta instancia.', 'domain_exists');
  // Si el administrador escribió el DNS de este dominio con una cuenta de
  // Cloudflare de la instancia, sus registros (MX, TXT de verificación)
  // siguen en la zona del operador aunque el dominio se haya borrado, y
  // probarían la propiedad al instante: solo ese cliente o el
  // administrador (no en nombre de un cliente) pueden volver a darlo de alta.
  // Lo mismo con un dominio que otro cliente dio de baja en un cambio de dominio.
  assertDominioNoReservado(domain, clientId, input.comoAdministrador);
  const reserva = reservaDeDominio(domain);

  // El dominio NO se crea en el motor al darlo de alta: para Stalwart, un
  // dominio que existe es local para todo el servidor (responde «550
  // Mailbox does not exist» a cualquier dirección que no tenga y entrega
  // en local lo demás). Dar de alta gmail.com, o el dominio de otro
  // cliente, dejaría a todos los clientes sin poder escribirle. Se crea
  // con el primer buzón o alias (asegurarDominioEnMotor), que exigen la
  // propiedad comprobada. Las claves DKIM y los registros DNS que propone
  // el motor no necesitan que el dominio exista.
  const engine = getEngine();
  try {
    await engine.ensureDkim(domain, 'mail');
  } catch (err) {
    input.avisar?.(err);
  }

  const nuevoId = randomId('dom');
  try {
    db.prepare(
      `INSERT INTO domains (id, client_id, domain, dkim_selector, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(nuevoId, clientId, domain, 'mail', now());
  } catch (err) {
    // Otra alta lo guardó entre la comprobación y el INSERT.
    if (isUniqueViolation(err)) {
      throw conflict('Ese dominio ya está dado de alta en esta instancia.', 'domain_exists');
    }
    throw err;
  }
  // El administrador decide a quién sirven esos registros: la reserva pasa al cliente nuevo.
  if (reserva && reserva.client_id !== clientId) moverReservaDominio(domain, clientId);
  return nuevoId;
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
        /** true = el correo va de verdad en www.<dominio> (ya se avisó). */
        confirmWww: z
          .boolean({ invalid_type_error: 'El campo «confirmWww» debe ser verdadero o falso.' })
          .optional(),
      })
      .parse(req.body);

    const clientId = user.role === 'admin' ? body.clientId || '' : user.clientId!;
    if (!clientId) throw badRequest('Indica a qué cliente pertenece el dominio.');
    requireClientAccess(req, clientId);
    const domain = normalizeDomain(body.domain);
    // No se quita en silencio: el correo en un subdominio es legítimo. Se
    // pregunta antes de gastar la plaza del plan y de crear el DNS bajo www.
    const sugerido = sinWwwSugerido(domain);
    if (sugerido && !body.confirmWww) {
      const visible = domainToUnicode(domain) || domain;
      const sugeridoVisible = domainToUnicode(sugerido) || sugerido;
      throw conflict(
        `«${visible}» empieza por «www.», que suele ser el nombre de la web. ¿Querías decir ${sugeridoVisible}? Con ${visible}, las direcciones serían como nombre@${visible} y todos sus registros DNS colgarían de www. Si es lo que quieres, confírmalo.`,
        'domain_www',
      );
    }
    // Todas las altas de dominio van en fila: entre comprobar que el dominio
    // no existe y guardarlo hay llamadas al motor, y dos altas simultáneas
    // del mismo dominio (de clientes distintos) acabarían con una borrando
    // en el motor el dominio que la otra acababa de crear.
    const id = await withLock('altas:dominios', () =>
      altaDeDominioSinCerrojo({
        clientId,
        domain,
        comoAdministrador: user.role === 'admin' && !pideSoloCliente(req.query),
        esAdministrador: user.role === 'admin',
        avisar: (err) => req.log.warn({ err, domain }, 'No se ha podido generar el DKIM al crear el dominio'),
      }),
    );
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
    const [mx, txt, dmarc, mtaSts, delMotor] = await Promise.all([
      lookupMx(domain.domain),
      lookupTxt(domain.domain),
      lookupTxt(`_dmarc.${domain.domain}`),
      // Una política MTA-STS del proveedor anterior puede retener el correo
      // durante días tras el cambio de MX: se avisa antes de hacerlo.
      lookupTxt(`_mta-sts.${domain.domain}`),
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
      mtaSts,
      domain: domain.domain,
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
    const { domain, propiedad } = await medirDominio(id);
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
    // La ficha distingue «el TXT no está» (false) de «no se pudo consultar
    // el DNS» (null): no son el mismo aviso.
    return { domain, ownershipCheck: propiedad ?? null };
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
    // Un dominio en un cambio abierto (origen o destino) se gestiona desde el
    // asistente: borrarlo aquí dejaría el cambio sin uno de sus dos dominios y
    // sin forma de volver ni de terminar.
    const cambio = cambioAbiertoDeDominio(id);
    if (cambio) {
      const visible = domainToUnicode(domain.domain) || domain.domain;
      throw conflict(
        `${visible} está en un cambio de dominio. Gestiónalo desde el asistente.`,
        'domain_migrating',
      );
    }
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
    // Su webmail y su panel de marca blanca (webmail.<dominio>) se van con él:
    // si no, los datos de conexión seguirían enlazándolos, se serviría la
    // marca del cliente en un nombre que ya no es suyo y otro cliente no
    // podría dar de alta ese nombre.
    const propios = dominiosPropiosDe(id);
    const confirm = (req.query as { confirm?: string }).confirm === domain.domain;
    if ((mailboxCount > 0 || propios.length > 0) && !confirm) {
      const partes: string[] = [];
      if (mailboxCount > 0) {
        const buzones = mailboxCount === 1 ? '1 buzón con su correo' : `${mailboxCount} buzones con su correo`;
        const claves =
          apiKeys === 0
            ? ''
            : apiKeys === 1
              ? ' y 1 clave de API que envía desde sus buzones (dejará de funcionar)'
              : ` y ${apiKeys} claves de API que envían desde sus buzones (dejarán de funcionar)`;
        partes.push(`${buzones}${claves}`);
      }
      if (propios.length > 0) {
        partes.push(
          `${propios.length === 1 ? 'el dominio de marca blanca' : 'los dominios de marca blanca'} ${propios.map((p) => p.hostname).join(', ')} (${propios.length === 1 ? 'dejará' : 'dejarán'} de publicarse)`,
        );
      }
      throw conflict(
        `Este dominio tiene ${partes.join('; además, ')}. Para eliminarlo todo definitivamente, confirma escribiendo el nombre del dominio.`,
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
        // Con su usuario del motor, que tras un cambio de dominio puede no ser
        // su dirección. Con un cambio de usuario a medias responde 409 y el
        // buzón queda para el reintento, cuando se sepa con qué nombre está.
        await engine.deleteMailbox(loginParaMotor(mailbox.id));
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

    await engine.deleteDomain(domain.domain);
    db.prepare('DELETE FROM domains WHERE id = ?').run(id);
    for (const propio of propios) {
      eliminarDominioPropio(propio.id);
      audit(req, 'whitelabel.domain_deleted', { id: propio.id, hostname: propio.hostname, withMailDomain: domain.domain }, domain.clientId);
    }
    // Sin el dominio en el motor, su regla de entrega por MX ya no sirve.
    if (domain.recepcionExterna) void sincronizarRecepcionExterna().catch(() => undefined);
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
        ...(propios.length > 0 ? { whitelabelDeleted: propios.map((p) => p.hostname) } : {}),
      },
      domain.clientId,
    );
    return {
      ok: true,
      apiKeysRevoked: apiKeys,
      whitelabelDeleted: propios.map((p) => p.hostname),
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
export function esBuzonDeLaInstancia(email: string): boolean {
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
 * buzones del dominio que se borra. Un alias que se queda sin destinos
 * no entrega a nadie y se elimina. Mismo criterio que el borrado de un
 * buzón suelto; cada alias se guarda en la base justo después de cambiarlo
 * en el motor para que ambos coincidan aunque algo falle a mitad.
 *
 * Solo los buzones, no cualquier dirección del dominio: una dirección que no
 * es un buzón de aquí es un reenvío externo y sigue siendo válida sin el
 * dominio. Si no, quien diera de alta gmail.com (sin poder probar la
 * propiedad) y lo borrara después dejaría sin esos destinos los alias de
 * todos los demás clientes.
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
  const buzones = new Set(
    (db.prepare('SELECT local_part FROM mailboxes WHERE domain_id = ?').all(domainId) as { local_part: string }[]).map(
      (m) => `${m.local_part.toLowerCase()}${sufijo}`,
    ),
  );
  const actualizados: string[] = [];
  const eliminados: string[] = [];
  const fallidos: string[] = [];
  if (buzones.size === 0) return { actualizados, eliminados, fallidos };
  // Cada alias se relee justo antes de usarlo y otra vez antes de guardarlo,
  // como al borrar un buzón: pasar o volver de un cambio de dominio reescriben
  // los destinos de toda la instancia mientras aquí se espera al motor, y
  // guardar la lista leída al principio devolvería direcciones que ya no son
  // las vigentes.
  const leerDestinos = (aliasId: string): string[] | null => {
    const fila = db.prepare('SELECT destinations_json FROM aliases WHERE id = ?').get(aliasId) as
      | { destinations_json: string }
      | undefined;
    return fila ? destinosDe(fila.destinations_json) : null;
  };
  const sinLosDelDominio = (destinos: string[]) => destinos.filter((d) => !buzones.has(d.toLowerCase()));
  for (const alias of candidatos) {
    const destinos = leerDestinos(alias.id);
    if (!destinos) continue;
    const restantes = sinLosDelDominio(destinos);
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
        // Los miembros de una lista van por nombre del motor, no por dirección.
        await engine.upsertAlias(email, internos.map(nombreEnMotor), externos);
        const actuales = leerDestinos(alias.id);
        if (actuales) {
          db.prepare('UPDATE aliases SET destinations_json = ? WHERE id = ?').run(
            JSON.stringify(sinLosDelDominio(actuales)),
            alias.id,
          );
        }
        actualizados.push(email);
      }
    } catch (err) {
      onError(err, email);
      fallidos.push(email);
    }
  }
  return { actualizados, eliminados, fallidos };
}
