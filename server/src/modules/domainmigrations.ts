import { domainToUnicode } from 'node:url';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { randomId } from '../core/crypto';
import { lookupA, lookupAaaa, lookupMx } from '../core/dns';
import { badRequest, conflict, forbidden, HttpError, isUniqueViolation, notFound } from '../core/errors';
import { canonicalIpv6 } from '../core/hostnames';
import { cambioLockKey, clientLockKey, withLock } from '../core/locks';
import { getEngine } from '../engine';
import type { EngineDnsRecord, EngineHealth } from '../engine/types';
import { fireAlert, resolveAlert } from './alerts';
import { audit, auditSystem } from './audit';
import { refreshAutoconfigHosts } from './autoconfig';
import { requireAuth, requireClientAccess } from './auth';
import { getClient, getClientUsage, getPlan } from './clients';
import { aplicarDnsDominio, aplicarDnsDominioPropio, claveCambio, permiteInstancia, pideSoloCliente } from './cloudflare';
import { publicBaseUrl } from './connection';
import {
  actualizarUsuarioEnCambio,
  appsManualesDe,
  appsSkywayDe,
  conciliarUsuariosEnCambio,
  dominiosExentos,
  errorBuzonUsadoPorApp,
  loginParaMotor,
  nombreEnMotor,
} from './direcciones';
import {
  altaDeDominioSinCerrojo,
  asegurarDominioEnMotor,
  assertDominioNoReservado,
  confirmarRecepcionExterna,
  esBuzonDeLaInstancia,
  getDomain,
  medirDominio,
  normalizeDomain,
  sinWwwSugerido,
  type DomainRecord,
} from './domains';
import { normalizarOrigen } from './forms';
import { exigirSinMantenimiento, mantenimientoActivo } from './mantenimiento';
import { crearEnlaceConfiguracion } from './portal';
import { sincronizarRecepcionExterna } from './recepcion';
import { borrarRemitenteConfiguracion } from './remitente';
import { getInstanceSettings, getJsonSetting, setJsonSetting } from './settings';
import {
  crearDominioPropio,
  dominiosPropiosDe,
  eliminarDominioPropio,
  getClientDomain,
  MAX_WHITELABEL_PER_CLIENT,
  refreshClientDomain,
  setPrimaryWebmail,
  type ClientDomain,
} from './whitelabel';
import { destinosMx } from './zonefile';

/**
 * Cambio de dominio de un cliente (dominio.es → dominio2.es): el «corte
 * sencillo» de la especificación.
 *
 *   preparando ⇄ listo ──Pasar──▶ pasando ──▶ pasado ──Dar de baja──▶ dando_de_baja ──▶ dado_de_baja
 *        └──Cancelar──▶ cancelada            └──Volver──▶ volviendo ──▶ listo
 *
 *   (con error, «pasando» y «volviendo» admiten también Volver y Cancelar, y
 *   «dando_de_baja», Reintentar la baja: nunca queda un cambio sin salida)
 *
 * - Preparar (asíncrono, lo avanzan «Comprobar» y el vigilante): en cuanto se
 *   prueba la propiedad de dominio2.es, cada buzón y alias del origen recibe
 *   también local@dominio2.es (pre-recepción) y se recarga el directorio.
 * - Pasar, volver, cancelar y dar de baja son síncronos, con los cerrojos
 *   altas:<cliente> → cambio:<id>, y dejan guardado el estado en curso antes
 *   de empezar: si algo falla, queda `error` y todo es idempotente para
 *   «Reintentar». Dentro del motor el buzón no se copia nunca: solo cambian sus
 *   direcciones y, al actualizar dispositivos, su nombre (direcciones.ts).
 * - El conjunto de buzones y alias que se mudan es fijo desde la creación
 *   (domain_migration_items): el origen no admite altas mientras el cambio
 *   esté abierto, y el destino tampoco hasta pasar (assertAltasPermitidas).
 */

/* ---------------------------------- Tipos --------------------------------- */

export type EstadoCambio =
  | 'preparando'
  | 'listo'
  | 'pasando'
  | 'pasado'
  | 'volviendo'
  | 'dando_de_baja'
  | 'dado_de_baja'
  | 'cancelada';

export interface AvisoCambio {
  code: string;
  mensaje: string;
}

export interface PlanCambioDominio {
  desde: { domainId: string; domain: string };
  hacia: { domain: string; existe: boolean; domainId: string | null };
  /**
   * `usadoPorApps`: contraseñas de aplicación de Skyway («skyway:…»), que
   * Skyway pone al día; `appsManuales`: las demás activas, que nadie pone al
   * día (solo informan, con el aviso `apps_manuales`).
   */
  buzones: { id: string; de: string; a: string; usadoPorApps: string[]; appsManuales: string[] }[];
  alias: { id: string; de: string; a: string }[];
  formularios: { id: string; name: string; origenesNuevos: string[] }[];
  webmail: { viejo: string | null; nuevo: string | null };
  avisos: AvisoCambio[];
  /** No vacío: la creación responde 409 o 400 con el código del primero. */
  bloqueos: AvisoCambio[];
}

export type IdCompuerta = 'motor' | 'cliente' | 'propiedad' | 'recepcion' | 'dns' | 'webmail';

export interface CompuertaCambio {
  id: IdCompuerta;
  ok: boolean;
  bloquea: boolean;
  titulo: string;
  detalle: string;
}

interface WebmailVista {
  id: string;
  hostname: string;
  status: string;
  principal: boolean;
}

export interface CambioDominioVista {
  id: string;
  clientId: string;
  origen: 'panel' | 'skyway';
  referenciaExterna: string | null;
  desde: { domainId: string | null; domain: string };
  hacia: { domainId: string | null; domain: string; cloudflare: boolean; recibeEnOtroProveedor: boolean };
  estado: EstadoCambio;
  paso: string;
  error: string | null;
  /** direcciones_at no es nulo: dominio2.es ya recibe en los buzones. */
  recepcionPreparada: boolean;
  compuertas: CompuertaCambio[];
  puedePasar: boolean;
  puedeVolver: boolean;
  puedeCancelar: boolean;
  puedeDarDeBaja: boolean;
  /** Sin consultar la red: apps SMTP e instancia (el MX se mide al pulsar). */
  bloqueosBaja: AvisoCambio[];
  buzones: {
    total: number;
    pendientes: number;
    lista: {
      id: string;
      email: string;
      login: string;
      pendiente: boolean;
      usadoPorApps: string[];
      /** Contraseñas de aplicación activas que no son de Skyway (aviso `apps_manuales`). */
      appsManuales: string[];
    }[];
  };
  alias: { total: number };
  webmail: { viejo: WebmailVista | null; nuevo: WebmailVista | null };
  nombresCloudflare: string[];
  avisos: AvisoCambio[];
  fechas: { creado: number; listo: number | null; pasado: number | null; terminado: number | null };
  /** El dominio nuevo lo dio de alta este cambio: cancelar lo elimina (si no tiene buzones ni alias). */
  creoDestino: boolean;
}

interface FilaCambio {
  id: string;
  client_id: string;
  from_domain_id: string | null;
  to_domain_id: string | null;
  from_domain: string;
  to_domain: string;
  estado: EstadoCambio;
  paso: string;
  error: string | null;
  origen: 'panel' | 'skyway';
  referencia_externa: string | null;
  creo_destino: number;
  creo_webmail_id: string | null;
  permitir_instancia: number;
  nombres_cloudflare_json: string;
  direcciones_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  listo_at: number | null;
  pasado_at: number | null;
  terminado_at: number | null;
}

type Registro = (msg: string) => void;

/* ------------------------------ Acceso a datos ----------------------------- */

const CERRADOS = `('dado_de_baja', 'cancelada')`;
const EN_PREPARACION = new Set<EstadoCambio>(['preparando', 'listo']);

function leer(id: string): FilaCambio | null {
  return (db.prepare('SELECT * FROM domain_migrations WHERE id = ?').get(id) as FilaCambio | undefined) ?? null;
}

function exigir(id: string): FilaCambio {
  const fila = leer(id);
  if (!fila) throw notFound('Cambio de dominio no encontrado.', 'migration_not_found');
  return fila;
}

type Columna =
  | 'estado'
  | 'paso'
  | 'error'
  | 'to_domain_id'
  | 'creo_destino'
  | 'creo_webmail_id'
  | 'nombres_cloudflare_json'
  | 'direcciones_at'
  | 'listo_at'
  | 'pasado_at'
  | 'terminado_at';

/** Actualiza columnas del cambio (nombres fijos del código, nunca de la petición). */
function actualizar(id: string, cambios: Partial<Record<Columna, string | number | null>>): void {
  const columnas = Object.keys(cambios) as Columna[];
  if (columnas.length === 0) return;
  const sets = columnas.map((c) => `${c} = ?`).join(', ');
  db.prepare(`UPDATE domain_migrations SET ${sets}, updated_at = ? WHERE id = ?`).run(
    ...columnas.map((c) => cambios[c] ?? null),
    now(),
    id,
  );
}

interface Item {
  item_id: string;
  local_part: string;
}

function itemsDe(id: string, tipo: 'buzon' | 'alias'): Item[] {
  return db
    .prepare(
      `SELECT item_id, local_part FROM domain_migration_items
       WHERE migration_id = ? AND tipo = ? ORDER BY local_part, item_id`,
    )
    .all(id, tipo) as Item[];
}

/** Alias del cambio que siguen existiendo (uno borrado durante el cambio se salta). */
function aliasVivos(id: string): Item[] {
  return itemsDe(id, 'alias').filter((i) => db.prepare('SELECT 1 FROM aliases WHERE id = ?').get(i.item_id));
}

interface BuzonDelCambio {
  id: string;
  local_part: string;
  usuario_motor: string | null;
  status: 'active' | 'suspended';
  domain: string;
}

/** Buzones del cambio que siguen existiendo, con su dirección y su usuario del motor. */
function buzonesDe(id: string): BuzonDelCambio[] {
  return db
    .prepare(
      `SELECT m.id, m.local_part, m.usuario_motor, m.status, d.domain
       FROM domain_migration_items i
       JOIN mailboxes m ON m.id = i.item_id
       JOIN domains d ON d.id = m.domain_id
       WHERE i.migration_id = ? AND i.tipo = 'buzon'
       ORDER BY m.local_part, m.id`,
    )
    .all(id) as BuzonDelCambio[];
}

function nombresCloudflare(fila: FilaCambio): string[] {
  try {
    const valor = JSON.parse(fila.nombres_cloudflare_json) as unknown;
    return Array.isArray(valor) ? valor.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Anota los A/AAAA/CNAME que el cambio creó en Cloudflare (Skyway los reserva para su proyecto). */
function anotarNombresCloudflare(id: string, aplicados: { type: string; name: string }[]): void {
  const nuevos = aplicados
    .filter((a) => ['A', 'AAAA', 'CNAME'].includes(a.type.toUpperCase()))
    .map((a) => a.name.toLowerCase().replace(/\.$/, ''));
  if (nuevos.length === 0) return;
  const fila = leer(id);
  if (!fila) return;
  const todos = [...new Set([...nombresCloudflare(fila), ...nuevos])];
  actualizar(id, { nombres_cloudflare_json: JSON.stringify(todos) });
}

/** Nombre para mostrar (Unicode si es un dominio internacionalizado). */
function visible(dominio: string): string {
  return domainToUnicode(dominio) || dominio;
}

function dominioOpcional(id: string | null): DomainRecord | null {
  if (!id) return null;
  try {
    return getDomain(id);
  } catch {
    return null;
  }
}

function mensajeDe(err: unknown): string {
  const texto = (err instanceof Error ? err.message : String(err)).trim();
  // Se encadena en frases («No se ha podido…: <mensaje>»): siempre con punto final.
  return /[.!?…»)]$/.test(texto) ? texto : `${texto}.`;
}

/** «El motor no responde» es un 503 para quien llama a una acción (el driver lo da como 502). */
function errorDeAccion(err: unknown): unknown {
  if (err instanceof HttpError && err.code === 'engine_unreachable' && err.status !== 503) {
    return new HttpError(503, err.message, 'engine_unreachable');
  }
  return err;
}

/** Alerta informativa «dominio2.es está listo para el cambio». */
function alertaListo(id: string): string {
  return `cambio_dominio:${id}:listo`;
}

function estadoNoValido(): HttpError {
  return conflict(
    'Esta acción no está disponible en el estado actual del cambio de dominio.',
    'migration_state',
  );
}

/**
 * Un cambio que nació en Skyway se pasa, se vuelve, se cancela y se da de baja
 * desde Skyway: allí van también la web, las variables y los despliegues, y
 * hacerlo solo aquí los dejaría desacompasados. Las acciones de las personas
 * («Actualizar mis dispositivos») no pasan por aquí.
 *
 * Skyway habla con el token de gestión de la administración: un token que se
 * crea un usuario del cliente (POST /api/tokens solo pide su sesión) no lo
 * es, y con él se saltaría esta regla.
 */
function esIntegracionDeAdministracion(req: FastifyRequest): boolean {
  return req.authVia?.kind === 'token' && req.user?.role === 'admin';
}

function exigirOrigen(req: FastifyRequest, fila: FilaCambio): void {
  if (fila.origen === 'skyway' && !esIntegracionDeAdministracion(req)) {
    throw conflict(
      'Este cambio de dominio se gestiona desde Skyway (proyecto vinculado). Continúa desde allí.',
      'migration_managed_externally',
    );
  }
}

/* ----------------------------- Usuarios del motor --------------------------- */

function esCodigo(err: unknown, code: string): boolean {
  return err instanceof HttpError && err.code === code;
}

function esNoEncontrado(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
}

/**
 * Usuario del motor de un buzón del cambio, o null si el buzón ya no existe
 * (se borró durante el cambio: se salta). Con un cambio de usuario a medias
 * (409 mailbox_login_updating) se concilia una vez y se vuelve a mirar: el
 * conciliador lo resuelve salvo justo después de un fallo sin respuesta del
 * motor, y entonces la acción queda con error para «Reintentar» más tarde.
 */
async function loginDeBuzon(mailboxId: string): Promise<string | null> {
  try {
    return loginParaMotor(mailboxId);
  } catch (err) {
    if (esNoEncontrado(err)) return null;
    if (!esCodigo(err, 'mailbox_login_updating')) throw err;
  }
  await conciliarUsuariosEnCambio();
  try {
    return loginParaMotor(mailboxId);
  } catch (err) {
    if (esNoEncontrado(err)) return null;
    throw err;
  }
}

/** actualizarUsuarioEnCambio con el mismo reintento tras conciliar. null si no había nada que cambiar. */
async function actualizarUsuarioDelCambio(mailboxId: string): Promise<{ de: string; a: string } | null> {
  try {
    return await actualizarUsuarioEnCambio(mailboxId);
  } catch (err) {
    if (esNoEncontrado(err)) return null;
    if (!esCodigo(err, 'mailbox_login_updating')) throw err;
  }
  await conciliarUsuariosEnCambio();
  try {
    return await actualizarUsuarioEnCambio(mailboxId);
  } catch (err) {
    if (esNoEncontrado(err)) return null;
    throw err;
  }
}

/* ------------------------------------ DNS ----------------------------------- */

function sinPunto(valor: string): string {
  return valor.trim().toLowerCase().replace(/\.$/, '');
}

/** ¿Alguna de estas IP es una de las de referencia? IPv6 en su forma canónica. */
function coincideIp(ips: string[], referencias: string[]): boolean {
  const normal = (ip: string) => (ip.includes(':') ? canonicalIpv6(ip) ?? ip : ip.trim());
  const refs = new Set(referencias.map(normal).filter(Boolean));
  return ips.some((ip) => refs.has(normal(ip)));
}

/**
 * ¿Llega a este servidor el correo del dominio? Lo mide el DNS público en ese
 * momento:
 * - un MX hacia aquí (por nombre, o un nombre propio cuyo A es este servidor) → true;
 * - sin MX, el correo va al A/AAAA del dominio: si apunta aquí → true;
 * - un MX nulo («0 .») o un MX a otro sitio → false;
 * - null si el DNS no se pudo consultar.
 *
 * La usan la baja (el MX del dominio viejo no puede apuntar aquí: el correo
 * que siguiera llegando se rechazaría y alimentaría el bloqueo automático de
 * IPs del motor) y la cancelación (al revés, con el dominio nuevo).
 */
export async function mxApuntaAqui(domain: string): Promise<boolean | null> {
  const mx = await lookupMx(domain);
  if (mx === null) return null;
  const { mailHostname, publicIp } = getInstanceSettings();
  // Node da el MX nulo con un destino vacío (o «.»): no recibe en ningún sitio.
  const reales = mx.filter((r) => sinPunto(r.exchange) !== '');
  if (reales.length === 0) {
    if (mx.length > 0) return false;
    const servidor = sinPunto(mailHostname);
    const [a, aaaa, aServidor, aaaaServidor] = await Promise.all([
      lookupA(domain),
      lookupAaaa(domain),
      servidor ? lookupA(servidor) : Promise.resolve([] as string[]),
      servidor ? lookupAaaa(servidor) : Promise.resolve([] as string[]),
    ]);
    if (a === null || aaaa === null) return null;
    const referencias = [publicIp, ...(aServidor ?? []), ...(aaaaServidor ?? [])].filter(Boolean);
    return coincideIp([...(a ?? []), ...(aaaa ?? [])], referencias);
  }
  let registros: EngineDnsRecord[] = [];
  try {
    registros = await getEngine().getDnsRecords(domain);
  } catch {
    // Sin motor se compara con el nombre de Ajustes y por IP.
  }
  const propios = new Set([mailHostname, ...destinosMx(domain, registros)].map(sinPunto).filter(Boolean));
  if (reales.some((r) => propios.has(sinPunto(r.exchange)))) return true;
  const externa = await confirmarRecepcionExterna(reales, publicIp).catch(() => null);
  return externa === null ? null : !externa;
}

/* -------------------------------- Formularios ------------------------------- */

function origenesDe(json: string): string[] {
  try {
    const valor = JSON.parse(json) as unknown;
    return Array.isArray(valor) ? valor.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Orígenes que habría que añadir a un formulario: por cada origen cuyo host es
 * el dominio viejo o cuelga de él, el mismo en el dominio nuevo. Los viejos se
 * conservan: la web puede seguir sirviéndose en ellos un tiempo.
 */
function origenesNuevos(origenes: string[], from: string, to: string): string[] {
  const nuevos: string[] = [];
  for (const origen of origenes) {
    let url: URL;
    try {
      url = new URL(origen);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (host !== from && !host.endsWith(`.${from}`)) continue;
    const otroHost = `${host.slice(0, host.length - from.length)}${to}`;
    try {
      const normalizado = normalizarOrigen(`${url.protocol}//${otroHost}${url.port ? `:${url.port}` : ''}`);
      if (!origenes.includes(normalizado) && !nuevos.includes(normalizado)) nuevos.push(normalizado);
    } catch {
      // Un origen que no se puede trasladar (no debería ocurrir) se deja como está.
    }
  }
  return nuevos;
}

function formulariosDe(clientId: string, from: string, to: string): PlanCambioDominio['formularios'] {
  const filas = db
    .prepare('SELECT id, name, allowed_origins_json FROM forms WHERE client_id = ? ORDER BY created_at')
    .all(clientId) as { id: string; name: string; allowed_origins_json: string }[];
  return filas
    .map((f) => ({ id: f.id, name: f.name, origenesNuevos: origenesNuevos(origenesDe(f.allowed_origins_json), from, to) }))
    .filter((f) => f.origenesNuevos.length > 0);
}

/* ---------------------------------- Webmail --------------------------------- */

/** Webmail con la marca del cliente que cuelga del dominio viejo: el principal, si no el activo, si no el primero. */
function webmailDelDominio(domainId: string | null): ClientDomain | null {
  if (!domainId) return null;
  const propios = dominiosPropiosDe(domainId).filter((d) => d.kind === 'webmail');
  return propios.find((d) => d.isPrimary) ?? propios.find((d) => d.status === 'active') ?? propios[0] ?? null;
}

function webmailViejo(fila: FilaCambio): ClientDomain | null {
  return webmailDelDominio(fila.from_domain_id);
}

/** El mismo nombre en el dominio nuevo (webmail.dominio.es → webmail.dominio2.es). */
function hostEnDestino(hostname: string, from: string, to: string): string {
  return `${hostname.slice(0, hostname.length - from.length)}${to}`;
}

function webmailPorNombre(clientId: string, hostname: string): ClientDomain | null {
  const fila = db
    .prepare('SELECT id FROM client_domains WHERE client_id = ? AND hostname = ?')
    .get(clientId, hostname) as { id: string } | undefined;
  return fila ? getClientDomain(fila.id) : null;
}

function webmailNuevo(fila: FilaCambio, viejo: ClientDomain | null): ClientDomain | null {
  if (fila.creo_webmail_id) {
    try {
      return getClientDomain(fila.creo_webmail_id);
    } catch {
      // Se eliminó a mano: se busca por nombre.
    }
  }
  if (!viejo) return null;
  return webmailPorNombre(fila.client_id, hostEnDestino(viejo.hostname, fila.from_domain, fila.to_domain));
}

function webmailVista(d: ClientDomain | null): WebmailVista | null {
  return d ? { id: d.id, hostname: d.hostname, status: d.status, principal: d.isPrimary } : null;
}

/** Webmail principal actual del cliente, si eligió uno. */
function principalDe(clientId: string): string | null {
  const fila = db
    .prepare("SELECT id FROM client_domains WHERE client_id = ? AND kind = 'webmail' AND is_primary = 1")
    .get(clientId) as { id: string } | undefined;
  return fila?.id ?? null;
}

/**
 * Pasa a principal el webmail `a` si está activo y el principal actual es `de`
 * o no hay ninguno elegido: un principal que el cliente eligió en otro dominio
 * no se toca. true si lo cambió.
 */
function moverWebmailPrincipal(clientId: string, de: ClientDomain | null, a: ClientDomain | null): boolean {
  if (!a || a.status !== 'active' || a.isPrimary || a.kind !== 'webmail') return false;
  const actual = principalDe(clientId);
  if (actual !== null && actual !== de?.id) return false;
  setPrimaryWebmail(a.id);
  return true;
}

/* -------------------------------- Compuertas -------------------------------- */

async function saludMotor(): Promise<EngineHealth> {
  try {
    return await getEngine().ping();
  } catch (err) {
    return { ok: false, detail: mensajeDe(err) };
  }
}

function compuertasDe(
  fila: FilaCambio,
  salud: EngineHealth,
  to: DomainRecord | null,
  webmail: { viejo: ClientDomain | null; nuevo: ClientDomain | null },
): CompuertaCambio[] {
  const hacia = visible(fila.to_domain);
  let suspendido = false;
  try {
    suspendido = getClient(fila.client_id).suspended;
  } catch {
    suspendido = true;
  }
  const pendientesDns = (to?.dnsStatus.checks ?? [])
    .filter((c) => c.required && c.status !== 'ok')
    .map((c) => c.label);
  const compuertas: CompuertaCambio[] = [
    {
      id: 'motor',
      ok: salud.ok,
      bloquea: true,
      titulo: 'Servidor de correo disponible',
      detalle: salud.ok
        ? 'El servidor de correo responde.'
        : `El servidor de correo no responde${salud.detail ? `: ${salud.detail}` : '.'}`,
    },
    {
      id: 'cliente',
      ok: !suspendido,
      bloquea: true,
      titulo: 'Cliente activo',
      detalle: suspendido ? 'El cliente está suspendido: reactívalo antes de pasar.' : 'El cliente está activo.',
    },
    {
      id: 'propiedad',
      ok: Boolean(to?.ownershipVerifiedAt),
      bloquea: true,
      titulo: `Propiedad de ${hacia} comprobada`,
      detalle: to?.ownershipVerifiedAt
        ? `Se ha comprobado que ${hacia} es tuyo.`
        : `Añade el registro TXT ${to?.ownershipRecord.name ?? `_mailway.${fila.to_domain}`} o apunta el MX de ${hacia} a este servidor.`,
    },
    {
      id: 'recepcion',
      ok: fila.direcciones_at !== null,
      bloquea: true,
      titulo: `${hacia} ya recibe en los buzones`,
      detalle:
        fila.direcciones_at !== null
          ? `Los buzones y alias ya tienen su dirección de ${hacia}.`
          : `Se prepara en cuanto se compruebe la propiedad de ${hacia}.`,
    },
    {
      id: 'dns',
      ok: to?.status === 'active',
      bloquea: true,
      titulo: `DNS de ${hacia} completo (MX, SPF y DKIM)`,
      detalle:
        to?.status === 'active'
          ? 'Los registros obligatorios están publicados.'
          : pendientesDns.length > 0
            ? `Faltan o no coinciden: ${pendientesDns.join(', ')}.`
            : 'Todavía no se ha podido comprobar el DNS.',
    },
  ];
  if (webmail.viejo) {
    const nombre = webmail.nuevo?.hostname ?? hostEnDestino(webmail.viejo.hostname, fila.from_domain, fila.to_domain);
    compuertas.push({
      id: 'webmail',
      ok: webmail.nuevo?.status === 'active',
      bloquea: false,
      titulo: `Webmail con tu marca en ${nombre}`,
      detalle:
        webmail.nuevo?.status === 'active'
          ? `${nombre} ya funciona con HTTPS.`
          : `Mientras ${nombre} no esté activo, el webmail sigue en ${webmail.viejo.hostname}.`,
    });
  }
  return compuertas;
}

/** Motivos para «Todavía no se puede pasar», en el orden de las compuertas. */
function motivoDe(c: CompuertaCambio, hacia: string): string {
  switch (c.id) {
    case 'motor':
      return 'el servidor de correo no responde';
    case 'cliente':
      return 'el cliente está suspendido';
    case 'propiedad':
      return `falta comprobar la propiedad de ${hacia}`;
    case 'recepcion':
      return `${hacia} todavía no recibe en los buzones`;
    case 'dns':
      return `el DNS de ${hacia} no está completo (MX, SPF y DKIM)`;
    default:
      return c.titulo;
  }
}

/* ------------------------------ Bloqueos de la baja ------------------------- */

function hostDeUrl(url: string): string {
  try {
    return url ? new URL(url).hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

/** ¿Aloja el dominio el servidor de correo, el panel o el webmail de la instancia? */
function alojaLaInstancia(domain: string): boolean {
  const inst = getInstanceSettings();
  return [sinPunto(inst.mailHostname), hostDeUrl(inst.panelUrl), hostDeUrl(inst.webmailUrl)]
    .filter(Boolean)
    .some((h) => h === domain || h.endsWith(`.${domain}`));
}

function errorInstancia(domain: string): HttpError {
  return conflict(
    `${visible(domain)} aloja el servidor de correo o el panel de esta plataforma y no se puede dar de baja desde aquí.`,
    'domain_hosts_instance',
  );
}

/** Buzones pendientes de actualizar que usa una aplicación de Skyway para enviar. */
function pendientesConApps(id: string): { buzon: BuzonDelCambio; apps: string[] }[] {
  return buzonesDe(id)
    .filter((b) => b.usuario_motor !== null)
    .map((buzon) => ({ buzon, apps: appsSkywayDe(buzon.id) }))
    .filter((x) => x.apps.length > 0);
}

/** Nombres de las aplicaciones de Skyway («skyway:tienda» → «tienda»), sin repetir. */
function nombresApps(apps: string[]): string[] {
  return [...new Set(apps.map((a) => a.slice('skyway:'.length)).filter(Boolean))];
}

/** «usa una aplicación para enviar (tienda)» o «usan varias aplicaciones para enviar (tienda, blog)». */
function quienLoUsa(apps: string[]): string {
  return apps.length > 1
    ? `usan varias aplicaciones para enviar (${apps.join(', ')})`
    : `usa una aplicación para enviar${apps.length === 1 ? ` (${apps[0]})` : ''}`;
}

/**
 * Buzones pendientes con contraseñas de aplicación creadas a mano, según hacia
 * dónde cambiaría su usuario. `alNuevo`: entran con su usuario de dominio.es
 * (tras «Pasar»); al actualizarlos o en la baja pasan a su dirección de
 * dominio2.es. `deVuelta`: los actualizaron antes de un «Volver» y entran con
 * su usuario de dominio2.es; cancelar o actualizarlos los devuelve a su
 * dirección de dominio.es, y volver a pasar los deja al día sin cambiar nada.
 * El mismo texto para los dos daría la instrucción contraria a la mitad.
 */
function pendientesConAppsManuales(fila: FilaCambio): {
  alNuevo: { buzon: BuzonDelCambio; apps: string[] }[];
  deVuelta: { buzon: BuzonDelCambio; apps: string[] }[];
} {
  const conApps = buzonesDe(fila.id)
    .filter((b) => b.usuario_motor !== null)
    .map((buzon) => ({ buzon, apps: appsManualesDe(buzon.id) }))
    .filter((x) => x.apps.length > 0);
  // Mismo criterio que appsConUsuarioNuevo (los que cancelar actualiza).
  const deVuelta = (b: BuzonDelCambio) => b.usuario_motor === `${b.local_part}@${fila.to_domain}`;
  return {
    alNuevo: conApps.filter((x) => !deVuelta(x.buzon)),
    deVuelta: conApps.filter((x) => deVuelta(x.buzon)),
  };
}

/** Nombres que caben en un aviso: con muchos buzones, la lista entera lo haría ilegible. */
const MAX_NOMBRES_AVISO = 5;

/** Piezas comunes de los dos textos de `apps_manuales` (singular y plural). */
function partesAppsManuales(apps: string[]): { lista: string; una: boolean } {
  const nombres = [...new Set(apps)];
  const lista =
    nombres.length > MAX_NOMBRES_AVISO
      ? `${nombres.slice(0, MAX_NOMBRES_AVISO).join(', ')} y ${nombres.length - MAX_NOMBRES_AVISO} más`
      : nombres.join(', ');
  return { lista, una: apps.length === 1 };
}

/**
 * Aviso `apps_manuales` (no bloquea). Una contraseña de aplicación creada a
 * mano (un programa de fuera, un bot en otro servidor, el móvil de alguien)
 * sigue valiendo tras el cambio, pero entra con el usuario del buzón, que pasa
 * a ser la dirección nueva al actualizarlo o en la baja. Skyway solo pone al
 * día sus servicios («skyway:…»): estas aplicaciones las cambia quien las
 * configuró.
 */
function avisoAppsManuales(buzones: number, apps: string[], desde: string): AvisoCambio {
  const { lista, una } = partesAppsManuales(apps);
  const sujeto = buzones === 1 ? 'Un buzón tiene' : `${buzones} buzones tienen`;
  const cuales = una ? 'una contraseña de aplicación creada a mano' : 'contraseñas de aplicación creadas a mano';
  const quien = una ? 'la aplicación que la usa tiene' : 'las aplicaciones que las usan tienen';
  return {
    code: 'apps_manuales',
    mensaje: `${sujeto} ${cuales} (${lista}). Tras actualizar su usuario o dar de baja ${desde}, ${quien} que entrar con la dirección nueva.`,
  };
}

/**
 * `apps_manuales` tras un «Volver», para los buzones que ya entraban con su
 * usuario de dominio2.es: sus aplicaciones siguen funcionando, y lo que las
 * obliga a cambiar es cancelar o actualizar el usuario (vuelve a la dirección
 * de dominio.es). En este estado no hay baja que mencionar.
 */
function avisoAppsManualesDeVuelta(buzones: number, apps: string[], desde: string, hacia: string): AvisoCambio {
  const { lista, una } = partesAppsManuales(apps);
  const sujeto = buzones === 1 ? 'Un buzón entra' : `${buzones} buzones entran`;
  const tiene = buzones === 1 ? 'tiene' : 'tienen';
  const cuales = una ? 'una contraseña de aplicación creada a mano' : 'contraseñas de aplicación creadas a mano';
  const quien = una ? 'la aplicación que la usa tiene' : 'las aplicaciones que las usan tienen';
  return {
    code: 'apps_manuales',
    mensaje: `${sujeto} con su usuario de ${hacia} y ${tiene} ${cuales} (${lista}). Si cancelas el cambio o actualizas su usuario, ${quien} que volver a entrar con su dirección de ${desde}; si vuelves a pasar, no cambia nada.`,
  };
}

/**
 * Buzones con aplicaciones de Skyway que hoy entran con su usuario de
 * dominio2.es (lo actualizaron antes de un «Volver»). Cancelar los devuelve a
 * local@dominio.es, y la aplicación, que envía con SMTP_USER =
 * local@dominio2.es, dejaría de enviar sin ningún aviso.
 */
function appsConUsuarioNuevo(fila: FilaCambio): { buzon: BuzonDelCambio; apps: string[] }[] {
  return buzonesDe(fila.id)
    .filter((b) => (b.usuario_motor ?? `${b.local_part}@${b.domain}`) === `${b.local_part}@${fila.to_domain}`)
    .map((buzon) => ({ buzon, apps: appsSkywayDe(buzon.id) }))
    .filter((x) => x.apps.length > 0);
}

/**
 * 409 mailbox_used_by_app al cancelar. Solo Skyway (con el token de la
 * administración) cancela con esos buzones, porque después actualiza las
 * variables de la aplicación y la vuelve a desplegar; desde el panel, primero
 * se revocan sus contraseñas de aplicación.
 */
function errorCancelarConApps(fila: FilaCambio, conApps: { buzon: BuzonDelCambio; apps: string[] }[]): HttpError {
  const apps = nombresApps(conApps.flatMap((x) => x.apps));
  const desde = visible(fila.from_domain);
  const hacia = visible(fila.to_domain);
  const direcciones = conApps.map((x) => `${x.buzon.local_part}@${desde}`);
  const que = apps.length > 1 ? 'las aplicaciones dejarían' : 'la aplicación dejaría';
  const sujeto =
    conApps.length === 1
      ? `${direcciones[0]} lo ${quienLoUsa(apps)} con su usuario de ${hacia}`
      : `Estos buzones los ${quienLoUsa(apps)} con su usuario de ${hacia}: ${direcciones.join(', ')}`;
  return conflict(
    `${sujeto}. Al cancelar, ${conApps.length === 1 ? 'el buzón volvería' : 'volverían'} a entrar con su dirección de ${desde} y ${que} de enviar. Revoca antes sus contraseñas de aplicación «skyway:…» y, después de cancelar, vuelve a conectar ${apps.length > 1 ? 'las aplicaciones' : 'la aplicación'} desde Skyway.`,
    'mailbox_used_by_app',
  );
}

function bloqueosBajaDe(fila: FilaCambio): AvisoCambio[] {
  const bloqueos: AvisoCambio[] = [];
  const conApps = pendientesConApps(fila.id);
  if (conApps.length > 0) {
    const apps = nombresApps(conApps.flatMap((x) => x.apps));
    const que = apps.length > 1 ? 'las aplicaciones no dejen' : 'la aplicación no deje';
    const direcciones = conApps.map((x) => `${x.buzon.local_part}@${x.buzon.domain}`);
    bloqueos.push({
      code: 'mailbox_used_by_app',
      mensaje:
        conApps.length === 1
          ? `${direcciones[0]} lo ${quienLoUsa(apps)}. Actualízalo desde Skyway para que ${que} de enviar, o revoca antes sus contraseñas de aplicación «skyway:…».`
          : `Estos buzones los ${quienLoUsa(apps)}: ${direcciones.join(', ')}. Actualízalos desde Skyway para que ${que} de enviar, o revoca antes sus contraseñas de aplicación «skyway:…».`,
    });
  }
  if (alojaLaInstancia(fila.from_domain)) {
    bloqueos.push({ code: 'domain_hosts_instance', mensaje: errorInstancia(fila.from_domain).message });
  }
  return bloqueos;
}

/* ----------------------------------- Vista ---------------------------------- */

/** Comparte la consulta al motor entre las vistas de una misma petición. */
interface ContextoVista {
  salud?: Promise<EngineHealth>;
}

function avisosDe(fila: FilaCambio, viejo: ClientDomain | null, nuevo: ClientDomain | null, to: DomainRecord | null): AvisoCambio[] {
  const avisos: AvisoCambio[] = [];
  const hacia = visible(fila.to_domain);
  if (viejo && !nuevo && fila.direcciones_at !== null && fila.estado !== 'cancelada') {
    const usados = (
      db.prepare('SELECT COUNT(*) AS c FROM client_domains WHERE client_id = ?').get(fila.client_id) as { c: number }
    ).c;
    if (usados >= MAX_WHITELABEL_PER_CLIENT) {
      avisos.push({
        code: 'whitelabel_limit',
        mensaje: `No se ha creado ${hostEnDestino(viejo.hostname, fila.from_domain, fila.to_domain)}: el cliente ya tiene el máximo de ${MAX_WHITELABEL_PER_CLIENT} dominios propios. Elimina uno que no se utilice y créalo en Marca blanca; mientras tanto, el webmail sigue en ${viejo.hostname}.`,
      });
    }
  }
  if (fila.estado === 'cancelada' && fila.creo_destino === 1 && to) {
    avisos.push({
      code: 'destino_conservado',
      mensaje: `${hacia} se ha conservado porque ya tiene buzones o alias propios. Si no lo necesitas, elimínalo desde su ficha.`,
    });
  }
  if (!['dado_de_baja', 'cancelada'].includes(fila.estado)) {
    const conApps = pendientesConApps(fila.id);
    if (conApps.length > 0) {
      const apps = nombresApps(conApps.flatMap((x) => x.apps));
      avisos.push({
        code: 'apps_smtp',
        mensaje: `${conApps.length === 1 ? 'Un buzón lo' : `${conApps.length} buzones los`} ${quienLoUsa(apps)}: su usuario se actualiza desde Skyway.`,
      });
    }
    const { alNuevo, deVuelta } = pendientesConAppsManuales(fila);
    const desde = visible(fila.from_domain);
    if (alNuevo.length > 0) {
      avisos.push(avisoAppsManuales(alNuevo.length, alNuevo.flatMap((x) => x.apps), desde));
    }
    if (deVuelta.length > 0) {
      avisos.push(avisoAppsManualesDeVuelta(deVuelta.length, deVuelta.flatMap((x) => x.apps), desde, hacia));
    }
  }
  return avisos;
}

async function vistaDe(fila: FilaCambio, ctx: ContextoVista = {}): Promise<CambioDominioVista> {
  const to = dominioOpcional(fila.to_domain_id);
  const viejo = webmailViejo(fila);
  const nuevo = webmailNuevo(fila, viejo);
  const conCompuertas = fila.estado === 'preparando' || fila.estado === 'listo' || fila.estado === 'pasando';
  let compuertas: CompuertaCambio[] = [];
  if (conCompuertas) {
    ctx.salud ??= saludMotor();
    compuertas = compuertasDe(fila, await ctx.salud, to, { viejo, nuevo });
  }
  const bloqueantesOk = compuertas.every((c) => !c.bloquea || c.ok);
  const bloqueosBaja = fila.estado === 'pasado' || fila.estado === 'dando_de_baja' ? bloqueosBajaDe(fila) : [];
  const buzones = buzonesDe(fila.id).map((b) => ({
    id: b.id,
    email: `${b.local_part}@${b.domain}`,
    login: b.usuario_motor ?? `${b.local_part}@${b.domain}`,
    pendiente: b.usuario_motor !== null,
    usadoPorApps: appsSkywayDe(b.id),
    appsManuales: appsManualesDe(b.id),
  }));
  const conError = fila.error !== null;
  // Un «Pasar» o un «Volver» que fallaron se pueden reintentar, volver o
  // cancelar, y una baja que falló se reintenta: ningún estado en curso con
  // error se queda sin salida (Skyway, además, solo ofrece lo que diga aquí).
  const aMedias = (fila.estado === 'pasando' || fila.estado === 'volviendo') && conError;
  return {
    id: fila.id,
    clientId: fila.client_id,
    origen: fila.origen,
    referenciaExterna: fila.referencia_externa,
    desde: { domainId: fila.from_domain_id, domain: fila.from_domain },
    hacia: {
      domainId: fila.to_domain_id,
      domain: fila.to_domain,
      cloudflare: Boolean(to?.cloudflare),
      recibeEnOtroProveedor: Boolean(to?.recepcionExterna),
    },
    estado: fila.estado,
    paso: fila.paso,
    error: fila.error,
    recepcionPreparada: fila.direcciones_at !== null,
    compuertas,
    puedePasar: (fila.estado === 'listo' && bloqueantesOk) || (fila.estado === 'pasando' && conError),
    puedeVolver: fila.estado === 'pasado' || aMedias,
    puedeCancelar: EN_PREPARACION.has(fila.estado) || aMedias,
    puedeDarDeBaja:
      (fila.estado === 'pasado' || (fila.estado === 'dando_de_baja' && conError)) && bloqueosBaja.length === 0,
    bloqueosBaja,
    buzones: { total: buzones.length, pendientes: buzones.filter((b) => b.pendiente).length, lista: buzones },
    alias: { total: aliasVivos(fila.id).length },
    webmail: { viejo: webmailVista(viejo), nuevo: webmailVista(nuevo) },
    nombresCloudflare: nombresCloudflare(fila),
    avisos: avisosDe(fila, viejo, nuevo, to),
    fechas: { creado: fila.created_at, listo: fila.listo_at, pasado: fila.pasado_at, terminado: fila.terminado_at },
    creoDestino: fila.creo_destino === 1,
  };
}

/** Vista de un cambio por id (para las rutas y las pruebas). */
export async function vistaCambio(id: string): Promise<CambioDominioVista> {
  return vistaDe(exigir(id));
}

/* ----------------------------------- Plan ----------------------------------- */

interface Bloqueo extends AvisoCambio {
  status: number;
}

function cambioAbiertoCon(dominios: string[]): FilaCambio | null {
  const marcas = dominios.map(() => '?').join(', ');
  return (
    (db
      .prepare(
        `SELECT * FROM domain_migrations
         WHERE estado NOT IN ${CERRADOS} AND (from_domain IN (${marcas}) OR to_domain IN (${marcas}))
         ORDER BY created_at LIMIT 1`,
      )
      .get(...dominios, ...dominios) as FilaCambio | undefined) ?? null
  );
}

/** El mismo cambio ya abierto (mismo origen y destino): crearlo otra vez lo devuelve (Skyway reintenta). */
function cambioIdentico(fromDomainId: string, to: string): FilaCambio | null {
  return (
    (db
      .prepare(
        `SELECT * FROM domain_migrations
         WHERE from_domain_id = ? AND to_domain = ? AND estado NOT IN ${CERRADOS} LIMIT 1`,
      )
      .get(fromDomainId, to) as FilaCambio | undefined) ?? null
  );
}

interface OpcionesPlan {
  /** Administrador que no actúa en nombre de un cliente: salta las reservas. */
  comoAdministrador: boolean;
  /**
   * Quién gestionaría el cambio. Con Skyway, el mismo cambio ya abierto solo
   * vale si es suyo (`referencia` undefined: el plan no sabe de qué proyecto
   * es, y solo descarta el que se lleva desde el panel).
   */
  gestor?: { origen: 'panel' | 'skyway'; referencia?: string | null };
}

/**
 * Crear otra vez el mismo cambio lo devuelve (Skyway reintenta tras una
 * respuesta perdida), pero Skyway no puede adoptar uno que no es suyo: el de
 * otro proyecto, o uno que se lleva desde el panel, que podría pasarse por su
 * cuenta y dejar a Skyway esperando un «listo» que ya no llegaría, sin poder
 * pasar, volver ni cancelar. Devuelve el bloqueo, o null si se puede devolver.
 */
function ajenoAlGestor(existente: FilaCambio, gestor: OpcionesPlan['gestor']): Bloqueo | null {
  if (gestor?.origen !== 'skyway') return null;
  const desde = visible(existente.from_domain);
  const hacia = visible(existente.to_domain);
  if (existente.origen !== 'skyway') {
    return {
      status: 409,
      code: 'migration_exists',
      mensaje: `${desde} ya está en un cambio de dominio a ${hacia} que se gestiona desde el panel de Mailway. Continúalo o cancélalo allí, o cambia solo la web.`,
    };
  }
  if (gestor.referencia !== undefined && existente.referencia_externa !== gestor.referencia) {
    return {
      status: 409,
      code: 'migration_exists',
      mensaje: `${desde} ya está en un cambio de dominio a ${hacia} que gestiona otro proyecto de Skyway.`,
    };
  }
  return null;
}

/**
 * Lo que pasaría al crear el cambio, sin efectos. Los bloqueos son los mismos
 * que comprueba la creación dentro de sus cerrojos.
 */
function calcularPlan(from: DomainRecord, to: string, opts: OpcionesPlan): PlanCambioDominio & { bloqueosHttp: Bloqueo[] } {
  const desde = visible(from.domain);
  const hacia = visible(to);
  const bloqueos: Bloqueo[] = [];
  const bloquear = (status: number, code: string, mensaje: string) => bloqueos.push({ status, code, mensaje });

  const destino = db.prepare('SELECT id, client_id FROM domains WHERE domain = ?').get(to) as
    | { id: string; client_id: string }
    | undefined;
  const propio = destino && destino.client_id === from.clientId ? destino : null;

  if (to === from.domain) {
    bloquear(400, 'migration_same_domain', 'El dominio nuevo tiene que ser distinto del actual.');
  } else if (to.endsWith(`.${from.domain}`) || from.domain.endsWith(`.${to}`)) {
    bloquear(400, 'migration_related_domains', 'El dominio nuevo no puede ser un subdominio del actual, ni al revés.');
  }
  const sugerido = sinWwwSugerido(to);
  if (sugerido) {
    bloquear(
      409,
      'domain_www',
      `«${hacia}» empieza por «www.», que suele ser el nombre de la web. ¿Querías decir ${visible(sugerido)}? Las direcciones de correo no deben colgar de www.`,
    );
  }
  let suspendido = false;
  try {
    suspendido = getClient(from.clientId).suspended;
  } catch {
    suspendido = true;
  }
  if (suspendido) {
    bloquear(
      400,
      'client_suspended',
      'Este cliente está suspendido. No es posible crear recursos ni credenciales hasta que se reactive.',
    );
  }
  if (from.ownershipVerifiedAt === null) {
    bloquear(
      409,
      'ownership_required',
      `Antes de cambiar de dominio hay que comprobar que ${desde} es tuyo: apunta su MX a este servidor o añade el registro TXT de verificación desde su ficha.`,
    );
  }
  if (destino && !propio) {
    bloquear(409, 'domain_exists', 'Ese dominio ya está dado de alta en esta instancia.');
  }
  if (!destino) {
    try {
      assertDominioNoReservado(to, from.clientId, opts.comoAdministrador);
    } catch (err) {
      if (err instanceof HttpError) bloquear(err.status, err.code, err.message);
      else throw err;
    }
  }
  if (propio) {
    const usado =
      db.prepare('SELECT 1 FROM mailboxes WHERE domain_id = ? LIMIT 1').get(propio.id) ||
      db.prepare('SELECT 1 FROM aliases WHERE domain_id = ? LIMIT 1').get(propio.id);
    if (usado) {
      bloquear(
        409,
        'migration_destination_in_use',
        `${hacia} ya tiene buzones o alias. Elige un dominio sin buzones ni alias, o elimínalos antes.`,
      );
    }
  }
  const identico = cambioIdentico(from.id, to);
  const ajeno = identico ? ajenoAlGestor(identico, opts.gestor) : null;
  if (ajeno) bloqueos.push(ajeno);
  const abierto = identico ? null : cambioAbiertoCon([from.domain, to]);
  if (abierto) {
    const afectado = [abierto.from_domain, abierto.to_domain].includes(from.domain) ? desde : hacia;
    bloquear(409, 'migration_exists', `${afectado} ya está en un cambio de dominio abierto.`);
  }
  if (!destino && !identico) {
    // La creación da de alta el dominio nuevo con el viejo ya exento del plan.
    const client = suspendido ? null : getClient(from.clientId);
    if (client) {
      const plan = getPlan(client.planId);
      const exentos = new Set([...dominiosExentos(from.clientId), from.id]);
      const cuentan = getClientUsage(from.clientId).domains - exentos.size;
      if (cuentan + 1 > plan.maxDomains) {
        bloquear(
          400,
          'plan_limit_reached',
          `Se ha alcanzado el máximo de dominios del plan «${plan.name}» (${plan.maxDomains}), incluso sin contar ${desde}. Solicita una ampliación del plan.`,
        );
      }
    }
  }

  const buzones = (
    db
      .prepare('SELECT id, local_part FROM mailboxes WHERE domain_id = ? ORDER BY local_part')
      .all(from.id) as { id: string; local_part: string }[]
  ).map((m) => ({
    id: m.id,
    de: `${m.local_part}@${from.domain}`,
    a: `${m.local_part}@${to}`,
    usadoPorApps: appsSkywayDe(m.id),
    appsManuales: appsManualesDe(m.id),
  }));
  const alias = (
    db
      .prepare('SELECT id, local_part FROM aliases WHERE domain_id = ? ORDER BY local_part')
      .all(from.id) as { id: string; local_part: string }[]
  ).map((a) => ({ id: a.id, de: `${a.local_part}@${from.domain}`, a: `${a.local_part}@${to}` }));

  const viejo = webmailDelDominio(from.id);
  const nombreNuevo = viejo ? hostEnDestino(viejo.hostname, from.domain, to) : null;

  const avisos: AvisoCambio[] = [];
  const conApps = buzones.filter((b) => b.usadoPorApps.length > 0);
  if (conApps.length > 0) {
    const apps = nombresApps(conApps.flatMap((b) => b.usadoPorApps));
    avisos.push({
      code: 'apps_smtp',
      mensaje: `${conApps.length === 1 ? 'Un buzón lo' : `${conApps.length} buzones los`} ${quienLoUsa(apps)}. ${apps.length > 1 ? 'Seguirán' : 'Seguirá'} enviando durante el cambio; su usuario se actualiza desde Skyway antes de dar de baja ${desde}.`,
    });
  }
  const conManuales = buzones.filter((b) => b.appsManuales.length > 0);
  if (conManuales.length > 0) {
    avisos.push(avisoAppsManuales(conManuales.length, conManuales.flatMap((b) => b.appsManuales), desde));
  }
  if (viejo && nombreNuevo) {
    const existe = db.prepare('SELECT 1 FROM client_domains WHERE hostname = ?').get(nombreNuevo);
    const usados = (
      db.prepare('SELECT COUNT(*) AS c FROM client_domains WHERE client_id = ?').get(from.clientId) as { c: number }
    ).c;
    if (!existe && usados >= MAX_WHITELABEL_PER_CLIENT) {
      avisos.push({
        code: 'whitelabel_limit',
        mensaje: `No cabe ${nombreNuevo}: el cliente ya tiene el máximo de ${MAX_WHITELABEL_PER_CLIENT} dominios propios. El webmail seguirá en ${viejo.hostname} hasta que elimines uno y lo crees.`,
      });
    }
  }
  if (alojaLaInstancia(from.domain)) {
    avisos.push({
      code: 'domain_hosts_instance',
      mensaje: `${desde} aloja el servidor de correo o el panel de esta plataforma: podrás pasar a ${hacia}, pero no dar de baja ${desde} desde aquí.`,
    });
  }

  return {
    desde: { domainId: from.id, domain: from.domain },
    hacia: { domain: to, existe: Boolean(destino), domainId: propio?.id ?? null },
    buzones,
    alias,
    formularios: formulariosDe(from.clientId, from.domain, to),
    webmail: { viejo: viejo?.hostname ?? null, nuevo: nombreNuevo },
    avisos,
    bloqueos: bloqueos.map(({ code, mensaje }) => ({ code, mensaje })),
    bloqueosHttp: bloqueos,
  };
}

/* --------------------------------- Preparar --------------------------------- */

/**
 * Pre-recepción: el dominio nuevo pasa a existir en el motor y cada buzón y
 * alias del cambio recibe también su dirección de dominio2.es. Desde ese
 * momento lo que llega a cualquiera de las dos entra en el mismo buzón, así
 * que el MX de dominio2.es puede cambiarse cuando se quiera.
 */
async function preRecepcion(fila: FilaCambio, to: DomainRecord, log?: Registro): Promise<void> {
  const engine = getEngine();
  // Si dominio2.es aún recibe en otro proveedor, el motor tiene que saberlo
  // ANTES de que el dominio exista en él: si no, lo que se envía desde aquí a
  // @dominio2.es se entregaría en estos buzones en vez de en su proveedor actual.
  if (to.recepcionExterna) await sincronizarRecepcionExterna();
  await asegurarDominioEnMotor(to.domain);
  await engine.ensureDkim(to.domain, to.dkimSelector);
  const buzones = itemsDe(fila.id, 'buzon');
  const alias = aliasVivos(fila.id);
  const total = buzones.length + alias.length;
  let k = 0;
  for (const b of buzones) {
    k += 1;
    actualizar(fila.id, { paso: `direcciones ${k}/${total}` });
    const login = await loginDeBuzon(b.item_id);
    if (login) await engine.setAddresses(login, { add: [`${b.local_part}@${to.domain}`] });
  }
  for (const a of alias) {
    k += 1;
    actualizar(fila.id, { paso: `direcciones ${k}/${total}` });
    await engine.setAddresses(`${a.local_part}@${fila.from_domain}`, { add: [`${a.local_part}@${to.domain}`] });
  }
  // Stalwart guarda en caché «esta dirección no existe»: sin recargar, las
  // direcciones nuevas podrían rechazarse durante un rato.
  await engine.reloadDirectory();
  actualizar(fila.id, { direcciones_at: now(), paso: '' });
  await crearWebmailNuevo(leer(fila.id) ?? fila, to, log);
}

/**
 * Si el cliente tenía un webmail con su marca en el dominio viejo, crea el
 * mismo nombre en el nuevo (webmail.dominio2.es) y, si la zona está en
 * Cloudflare, su registro. No para la preparación: sin plaza (máximo de
 * dominios propios) queda un aviso en la vista; otros fallos, en el registro.
 */
async function crearWebmailNuevo(fila: FilaCambio, to: DomainRecord, log?: Registro): Promise<void> {
  const viejo = webmailViejo(fila);
  if (!viejo) return;
  const hostname = hostEnDestino(viejo.hostname, fila.from_domain, fila.to_domain);
  // Ya existe (p. ej. el webmail automático de dominio2.es, que se crea al
  // comprobar su propiedad): webmailNuevo lo encuentra por su nombre y pasa a
  // ser el principal igual. Aquí ya se tiene el cerrojo del cliente, así que
  // asegurarWebmailDeDominio no puede estar creándolo a la vez.
  if (db.prepare('SELECT 1 FROM client_domains WHERE hostname = ?').get(hostname)) return;
  // El viejo era el automático: el nuevo también lo es (lo retira el
  // interruptor del cliente) y, como él, no vuelve si alguien lo descartó.
  const automatico = viejo.automatico;
  if (automatico && db.prepare('SELECT 1 FROM webmail_descartados WHERE hostname = ?').get(hostname)) return;
  let creado: ClientDomain;
  try {
    creado = crearDominioPropio(fila.client_id, hostname, 'webmail');
  } catch (err) {
    if (!esCodigo(err, 'whitelabel_limit')) log?.(`No se ha podido crear ${hostname}: ${mensajeDe(err)}`);
    return;
  }
  if (automatico) db.prepare('UPDATE client_domains SET automatico = 1 WHERE id = ?').run(creado.id);
  actualizar(fila.id, { creo_webmail_id: creado.id });
  auditSystem(
    'whitelabel.domain_created',
    { id: creado.id, hostname, kind: 'webmail', migrationId: fila.id, ...(automatico ? { automatico: true } : {}) },
    fila.client_id,
  );
  if (to.cloudflare) {
    try {
      const r = await aplicarDnsDominioPropio(creado.id, {
        replaceConflicts: false,
        soloCrear: true,
        permitirInstancia: fila.permitir_instancia === 1,
      });
      if (!('unavailable' in r)) anotarNombresCloudflare(fila.id, r.applied);
    } catch (err) {
      log?.(`No se ha podido crear en Cloudflare el registro de ${hostname}: ${mensajeDe(err)}`);
    }
  } else {
    void refreshClientDomain(creado.id).catch(() => undefined);
  }
}

/** Avance de la preparación con los cerrojos ya tomados (altas:<c> → cambio:<id>). */
async function avanzarSinCerrojo(id: string, errorMedida: string | null, log?: Registro): Promise<void> {
  const fila = leer(id);
  if (!fila || !EN_PREPARACION.has(fila.estado) || !fila.to_domain_id) return;
  const to = dominioOpcional(fila.to_domain_id);
  if (!to) return;
  const hacia = visible(fila.to_domain);
  let error = errorMedida ? `No se ha podido comprobar el DNS de ${hacia}: ${errorMedida}` : null;
  if (to.ownershipVerifiedAt !== null && fila.direcciones_at === null) {
    try {
      await preRecepcion(fila, to, log);
    } catch (err) {
      error = `No se ha podido preparar la recepción en ${hacia}: ${mensajeDe(err)} Se vuelve a intentar en la siguiente comprobación.`;
    }
  }
  const actual = leer(id)!;
  const viejo = webmailViejo(actual);
  const compuertas = compuertasDe(actual, await saludMotor(), dominioOpcional(actual.to_domain_id), {
    viejo,
    nuevo: webmailNuevo(actual, viejo),
  });
  const listo = compuertas.every((c) => !c.bloquea || c.ok);
  actualizar(id, {
    estado: listo ? 'listo' : 'preparando',
    error,
    ...(error === null ? { paso: '' } : {}),
    ...(listo && actual.estado !== 'listo' ? { listo_at: now() } : {}),
  });
  // «Está listo para el cambio» deja de ser cierto en cuanto falla una compuerta.
  if (!listo && actual.estado === 'listo') resolveAlert(alertaListo(id));
  if (listo && actual.estado !== 'listo') {
    fireAlert({
      severity: 'info',
      type: 'cambio_dominio',
      clientId: actual.client_id,
      dedupeKey: alertaListo(id),
      title: `${hacia} está listo para el cambio`,
      message: `Las comprobaciones para pasar de ${visible(actual.from_domain)} a ${hacia} están correctas.`,
      remedy:
        actual.origen === 'skyway'
          ? 'Continúa el cambio desde el proyecto en Skyway.'
          : `Pasa a ${hacia} desde la ficha de ${visible(actual.from_domain)}, en «Cambiar de dominio».`,
    });
  }
}

/**
 * Avanza la preparación: mide el DNS de dominio2.es (lo que puede probar su
 * propiedad), hace la pre-recepción si ya se puede y evalúa las compuertas
 * (preparando ⇄ listo). Idempotente; solo en preparando o listo. La medición
 * va fuera de los cerrojos: consulta el DNS y no debe frenar las altas del
 * cliente mientras tanto. Nunca lanza.
 */
export async function avanzarPreparacion(id: string, log?: Registro): Promise<void> {
  const inicial = leer(id);
  if (!inicial || !EN_PREPARACION.has(inicial.estado) || !inicial.to_domain_id) return;
  let errorMedida: string | null = null;
  try {
    await medirDominio(inicial.to_domain_id);
  } catch (err) {
    errorMedida = mensajeDe(err);
  }
  try {
    await withLock(clientLockKey(inicial.client_id), () =>
      withLock(cambioLockKey(id), () => avanzarSinCerrojo(id, errorMedida, log)),
    );
  } catch (err) {
    log?.(`cambio de dominio ${id}: ${mensajeDe(err)}`);
  }
}

/** Espera a una promesa como mucho `ms`; si vence, sigue en segundo plano. */
async function conPlazo(promesa: Promise<unknown>, ms: number): Promise<void> {
  let temporizador: NodeJS.Timeout | undefined;
  await Promise.race([
    promesa.catch(() => undefined),
    new Promise<void>((resolve) => {
      temporizador = setTimeout(resolve, ms);
      temporizador.unref?.();
    }),
  ]);
  if (temporizador) clearTimeout(temporizador);
}

/* ---------------------------------- Pasar ---------------------------------- */

/**
 * Ninguna parte local de los ítems que siguen existiendo está ya en el destino
 * como buzón o alias. Uno borrado durante el cambio no cuenta: tras «Volver»,
 * su nombre en dominio2.es puede ser ya de un buzón nuevo, y no hay nada que
 * mudar que pueda chocar con él.
 */
function colisionEnDestino(fila: FilaCambio): string | null {
  if (!fila.to_domain_id) return null;
  const locales = new Set([...buzonesDe(fila.id), ...aliasVivos(fila.id)].map((i) => i.local_part));
  const ocupadas = db
    .prepare(
      `SELECT local_part FROM mailboxes WHERE domain_id = ? AND id NOT IN
         (SELECT item_id FROM domain_migration_items WHERE migration_id = ?)
       UNION SELECT local_part FROM aliases WHERE domain_id = ? AND id NOT IN
         (SELECT item_id FROM domain_migration_items WHERE migration_id = ?)`,
    )
    .all(fila.to_domain_id, fila.id, fila.to_domain_id, fila.id) as { local_part: string }[];
  return ocupadas.find((o) => locales.has(o.local_part))?.local_part ?? null;
}

/* ----------------------------- Destinos de alias ---------------------------- */

/**
 * Dirección en `de` → la misma en `a` de cada buzón del cambio que sigue
 * existiendo. Uno borrado no entra: su dirección ya no está en ningún alias
 * (borrar un buzón la quita) y, tras «Volver», la del dominio nuevo puede ser
 * de otro buzón creado después.
 */
function mapaDeBuzones(fila: FilaCambio, de: string, a: string): Map<string, string> {
  return new Map(
    buzonesDe(fila.id).map((b) => [`${b.local_part}@${de}`.toLowerCase(), `${b.local_part}@${a}`.toLowerCase()]),
  );
}

interface AliasConDestinos {
  id: string;
  local_part: string;
  domain: string;
  destinations_json: string;
}

/** Alias de TODA la instancia con algún destino que es exactamente una de estas direcciones. */
function aliasQueApuntanA(direcciones: Set<string>, dominio: string): AliasConDestinos[] {
  if (direcciones.size === 0) return [];
  const candidatos = db
    .prepare(
      `SELECT a.id, a.local_part, d.domain, a.destinations_json
       FROM aliases a JOIN domains d ON d.id = a.domain_id
       WHERE lower(a.destinations_json) LIKE ?`,
    )
    .all(`%@${dominio}"%`) as AliasConDestinos[];
  return candidatos.filter((a) => origenesDe(a.destinations_json).some((d) => direcciones.has(d.toLowerCase())));
}

/** Par alias–destino que «Volver» no toca (no lo escribió el cambio). */
interface DestinoPrevio {
  alias: string;
  destino: string;
}

/**
 * Destinos que ya eran una dirección del dominio nuevo ANTES de pasar: p. ej.
 * un reenvío de otro cliente a ana@dominio2.es de cuando ese dominio aún no
 * estaba en la instancia. «Pasar» no los escribió, así que «Volver» no puede
 * convertirlos en ana@dominio.es. Se anotan en la tabla de ajustes, con una
 * clave por cambio, porque el esquema del cambio no tiene columna para ellos;
 * se borran al volver y al terminar.
 */
function claveDestinosPrevios(id: string): string {
  return `cambio_dominio:${id}:destinos_previos`;
}

/**
 * ¿Apuntaba aquí el MX de dominio.es al pasar? (true, false o null si no se
 * pudo consultar). «Volver» solo se frena si entonces sí y ahora no: el MX se
 * ha llevado a otro sitio durante la transición. Un dominio que nunca recibió
 * aquí (su MX ya estaba en otro proveedor) vuelve a su estado de antes.
 */
function claveMxOrigen(id: string): string {
  return `cambio_dominio:${id}:mx_origen_aqui`;
}

/** Olvida lo anotado al pasar: se hace al volver, al cancelar y al dar de baja. */
function olvidarNotasDePasar(id: string): void {
  db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(claveDestinosPrevios(id), claveMxOrigen(id));
}

/**
 * Reescribe en los alias de TODA la instancia los destinos que son
 * exactamente una dirección del mapa, salvo los pares de `conservar`
 * («<aliasId> <destino>»). Devuelve cuántos alias cambió.
 */
function reescribirDestinos(mapa: Map<string, string>, dominioViejo: string, conservar = new Set<string>()): number {
  let cambiados = 0;
  for (const alias of aliasQueApuntanA(new Set(mapa.keys()), dominioViejo)) {
    const destinos = origenesDe(alias.destinations_json);
    let cambia = false;
    const nuevos = destinos.map((d) => {
      const otro = mapa.get(d.toLowerCase());
      if (!otro || conservar.has(`${alias.id} ${d.toLowerCase()}`)) return d;
      cambia = true;
      return otro;
    });
    if (!cambia) continue;
    db.prepare('UPDATE aliases SET destinations_json = ? WHERE id = ?').run(JSON.stringify([...new Set(nuevos)]), alias.id);
    cambiados += 1;
  }
  return cambiados;
}

/**
 * Reenvíos de la instancia a un buzón que se muda. En el motor pueden ser
 * miembros externos POR DIRECCIÓN (un alias creado cuando dominio.es aún no
 * tenía la propiedad comprobada, p. ej. de otro cliente): seguirían apuntando
 * a ana@dominio.es y, en cuanto su MX dejara de apuntar aquí o tras la baja,
 * ese correo saldría a Internet mientras el panel enseña ana@dominio2.es. Se
 * vuelven a escribir con el buzón como miembro por su usuario del motor (es
 * decir, por id), como hacen el borrado de un buzón y el de un dominio:
 * entregan en el mismo buzón pase lo que pase con sus direcciones.
 */
async function reenviosAlMotor(fila: FilaCambio): Promise<void> {
  const engine = getEngine();
  const buzones = new Map(buzonesDe(fila.id).map((b) => [`${b.local_part}@${fila.from_domain}`.toLowerCase(), b.id]));
  const delCambio = new Set(itemsDe(fila.id, 'alias').map((a) => a.item_id));
  for (const alias of aliasQueApuntanA(new Set(buzones.keys()), fila.from_domain)) {
    const internos: string[] = [];
    const externos: string[] = [];
    for (const destino of origenesDe(alias.destinations_json)) {
      const buzonId = buzones.get(destino.toLowerCase());
      if (buzonId) {
        const login = await loginDeBuzon(buzonId);
        if (login) internos.push(login);
      } else if (esBuzonDeLaInstancia(destino)) {
        internos.push(nombreEnMotor(destino));
      } else {
        externos.push(destino);
      }
    }
    // Un alias del cambio ya se llama como el dominio nuevo (se acaba de renombrar).
    const nombre = delCambio.has(alias.id) ? `${alias.local_part}@${fila.to_domain}` : `${alias.local_part}@${alias.domain}`;
    await engine.upsertAlias(nombre, [...new Set(internos)], externos);
  }
}

async function motorPasar(fila: FilaCambio): Promise<void> {
  const engine = getEngine();
  const buzones = itemsDe(fila.id, 'buzon');
  const alias = aliasVivos(fila.id);
  const total = buzones.length + alias.length;
  let k = 0;
  for (const b of buzones) {
    k += 1;
    actualizar(fila.id, { paso: `motor ${k}/${total}` });
    const login = await loginDeBuzon(b.item_id);
    // [nueva, vieja]: el correo sale ya con la nueva y la vieja sigue recibiendo.
    if (login) await engine.setAddresses(login, { primary: `${b.local_part}@${fila.to_domain}` });
  }
  for (const a of alias) {
    k += 1;
    actualizar(fila.id, { paso: `motor ${k}/${total}` });
    const viejo = `${a.local_part}@${fila.from_domain}`;
    const nuevo = `${a.local_part}@${fila.to_domain}`;
    // El alias no tiene dispositivos: se renombra ya, conservando las
    // direcciones que tuviera (y la vieja, que sigue recibiendo).
    const actual = await engine.getPrincipal(viejo);
    const extra = (actual?.emails ?? []).filter((e) => e !== viejo && e !== nuevo);
    await engine.renamePrincipal(viejo, nuevo, { expectEmail: viejo, emails: [nuevo, viejo, ...extra] });
  }
  actualizar(fila.id, { paso: 'reenvíos' });
  await reenviosAlMotor(fila);
  await engine.reloadDirectory();
}

function basePasar(fila: FilaCambio): void {
  const from = fila.from_domain;
  const to = fila.to_domain;
  const params = { id: fila.id, from, to, fromId: fila.from_domain_id, toId: fila.to_domain_id };
  // usuario_motor: el usuario con el que entran hoy (el viejo), salvo quien ya
  // actualizó al nuevo antes de un «Volver»: ese queda al día.
  db.prepare(
    `UPDATE mailboxes SET
       usuario_motor = CASE WHEN COALESCE(usuario_motor, local_part || '@' || @from) = local_part || '@' || @to
                            THEN NULL ELSE COALESCE(usuario_motor, local_part || '@' || @from) END,
       semilla_perfil = COALESCE(semilla_perfil, local_part || '@' || @from),
       domain_id = @toId
     WHERE id IN (SELECT item_id FROM domain_migration_items WHERE migration_id = @id AND tipo = 'buzon')
       AND domain_id = @fromId`,
  ).run(params);
  db.prepare(
    `UPDATE aliases SET domain_id = @toId
     WHERE id IN (SELECT item_id FROM domain_migration_items WHERE migration_id = @id AND tipo = 'alias')
       AND domain_id = @fromId`,
  ).run(params);
  // Los destinos de alias son direcciones: los que apuntaban a un buzón que
  // se muda apuntan ya a su dirección nueva. En el motor ya van por id
  // (reenviosAlMotor). Antes se anota lo que ya apuntaba al dominio nuevo:
  // eso no lo escribe el cambio y «Volver» no lo toca.
  const mapa = mapaDeBuzones(fila, from, to);
  const nuevas = new Set(mapa.values());
  const previos: DestinoPrevio[] = aliasQueApuntanA(nuevas, to).flatMap((a) =>
    origenesDe(a.destinations_json)
      .map((d) => d.toLowerCase())
      .filter((d) => nuevas.has(d))
      .map((destino) => ({ alias: a.id, destino })),
  );
  setJsonSetting(claveDestinosPrevios(fila.id), previos);
  reescribirDestinos(mapa, from);
  // Formularios: la web servida en el dominio nuevo debe poder enviar.
  const formularios = db
    .prepare('SELECT id, allowed_origins_json FROM forms WHERE client_id = ?')
    .all(fila.client_id) as { id: string; allowed_origins_json: string }[];
  for (const f of formularios) {
    const actuales = origenesDe(f.allowed_origins_json);
    const nuevos = origenesNuevos(actuales, from, to);
    if (nuevos.length > 0) {
      db.prepare('UPDATE forms SET allowed_origins_json = ? WHERE id = ?').run(JSON.stringify([...actuales, ...nuevos]), f.id);
    }
  }
  const viejo = webmailViejo(fila);
  moverWebmailPrincipal(fila.client_id, viejo, webmailNuevo(fila, viejo));
  actualizar(fila.id, { estado: 'pasado', pasado_at: now(), paso: '', error: null });
}

/* ---------------------------------- Volver ---------------------------------- */

async function motorVolver(fila: FilaCambio): Promise<void> {
  const engine = getEngine();
  const buzones = itemsDe(fila.id, 'buzon');
  const alias = aliasVivos(fila.id);
  const total = buzones.length + alias.length;
  let k = 0;
  for (const b of buzones) {
    k += 1;
    actualizar(fila.id, { paso: `motor ${k}/${total}` });
    const login = await loginDeBuzon(b.item_id);
    if (login) await engine.setAddresses(login, { primary: `${b.local_part}@${fila.from_domain}` });
  }
  for (const a of alias) {
    k += 1;
    actualizar(fila.id, { paso: `motor ${k}/${total}` });
    const viejo = `${a.local_part}@${fila.from_domain}`;
    const nuevo = `${a.local_part}@${fila.to_domain}`;
    // Idempotente: un alias que no llegó a renombrarse (pasar falló antes) ya
    // se llama como el viejo y tiene la dirección nueva por la pre-recepción.
    const actual = await engine.getPrincipal(nuevo);
    const extra = (actual?.emails ?? []).filter((e) => e !== viejo && e !== nuevo);
    await engine.renamePrincipal(nuevo, viejo, { expectEmail: nuevo, emails: [viejo, nuevo, ...extra] });
  }
  await engine.reloadDirectory();
}

function baseVolver(fila: FilaCambio): void {
  const from = fila.from_domain;
  const to = fila.to_domain;
  const params = { id: fila.id, from, to, fromId: fila.from_domain_id, toId: fila.to_domain_id };
  // Quien ya actualizó sus dispositivos sigue entrando con su usuario nuevo:
  // volver no rompe ningún dispositivo.
  db.prepare(
    `UPDATE mailboxes SET
       usuario_motor = CASE WHEN usuario_motor = local_part || '@' || @from THEN NULL
                            WHEN usuario_motor IS NULL THEN local_part || '@' || @to
                            ELSE usuario_motor END,
       domain_id = @fromId
     WHERE id IN (SELECT item_id FROM domain_migration_items WHERE migration_id = @id AND tipo = 'buzon')
       AND domain_id = @toId`,
  ).run(params);
  db.prepare(
    `UPDATE aliases SET domain_id = @fromId
     WHERE id IN (SELECT item_id FROM domain_migration_items WHERE migration_id = @id AND tipo = 'alias')
       AND domain_id = @toId`,
  ).run(params);
  // Solo lo que escribió «Pasar», y los destinos que se crearon después con
  // la dirección nueva de un buzón del cambio (en el motor van por id). Si
  // «Pasar» nunca llegó a la base (falló antes), no hay nada que deshacer.
  const previos = getJsonSetting<DestinoPrevio[]>(claveDestinosPrevios(fila.id));
  if (previos) {
    const conservar = new Set(previos.map((p) => `${p.alias} ${p.destino}`));
    reescribirDestinos(mapaDeBuzones(fila, to, from), to, conservar);
  }
  olvidarNotasDePasar(fila.id);
  const viejo = webmailViejo(fila);
  moverWebmailPrincipal(fila.client_id, webmailNuevo(fila, viejo), viejo);
  actualizar(fila.id, { estado: 'listo', pasado_at: null, paso: '', error: null });
}

/**
 * Guarda el destino del cambio: el dominio nuevo si ya era del cliente, o lo
 * da de alta (con el viejo ya exento del plan, así que cabe aunque el plan
 * esté justo). Si falla, el cambio a medio crear se elimina (sus ítems van en
 * cascada): nada ha tocado todavía el motor.
 */
async function darDeAltaDestino(
  req: FastifyRequest,
  id: string,
  alta: { clientId: string; to: string; comoAdministrador: boolean; esAdministrador: boolean },
): Promise<void> {
  try {
    const destino = db.prepare('SELECT id FROM domains WHERE domain = ?').get(alta.to) as { id: string } | undefined;
    if (destino) {
      actualizar(id, { to_domain_id: destino.id, error: null });
      return;
    }
    const toId = await altaDeDominioSinCerrojo({
      clientId: alta.clientId,
      domain: alta.to,
      comoAdministrador: alta.comoAdministrador,
      esAdministrador: alta.esAdministrador,
      avisar: (err) => req.log.warn({ err, domain: alta.to }, 'No se ha podido generar el DKIM del dominio nuevo'),
    });
    actualizar(id, { to_domain_id: toId, creo_destino: 1, error: null });
    audit(req, 'domain.created', { id: toId, domain: alta.to, clientId: alta.clientId, migrationId: id }, alta.clientId);
  } catch (err) {
    db.prepare('DELETE FROM domain_migrations WHERE id = ?').run(id);
    throw err;
  }
}

/* -------------------------------- Rutas: datos ------------------------------- */

const crearSchema = z.object({
  fromDomainId: z.string({ required_error: 'Indica el dominio actual.' }).min(1, 'Indica el dominio actual.'),
  toDomain: z.string({ required_error: 'Introduce el dominio nuevo.' }).min(3, 'Introduce el dominio nuevo.').max(300),
  autoDns: z.boolean({ invalid_type_error: 'El campo «autoDns» debe ser verdadero o falso.' }).optional(),
  origen: z.enum(['panel', 'skyway'], { invalid_type_error: 'El origen debe ser «panel» o «skyway».' }).optional(),
  referenciaExterna: z
    .string({ invalid_type_error: 'La referencia externa debe ser un texto.' })
    .trim()
    .max(200, 'La referencia externa admite como máximo 200 caracteres.')
    .optional(),
});

const planSchema = crearSchema.pick({ fromDomainId: true, toDomain: true });

const vacioSchema = z.object({}).passthrough();

/** Caducidad de los enlaces de «Mensaje para tu equipo»: 7 días. */
const HORAS_ENLACE = 7 * 24;

const bajaSchema = z.object({
  confirm: z.string({ required_error: 'Escribe el dominio para confirmar.' }).max(300),
});

function cambioConAcceso(req: FastifyRequest): FilaCambio {
  const { id } = req.params as { id: string };
  const fila = exigir(id);
  requireClientAccess(req, fila.client_id);
  return fila;
}

/** Las dos acciones de las personas y del vigilante comparten estos cerrojos. */
function conCerrojos<T>(fila: FilaCambio, fn: () => Promise<T>): Promise<T> {
  return withLock(clientLockKey(fila.client_id), () => withLock(cambioLockKey(fila.id), fn));
}

/* ----------------------------------- Rutas ---------------------------------- */

export function registerDomainMigrationRoutes(app: FastifyInstance): void {
  /** Lo que pasaría al cambiar de dominio, sin efectos. */
  app.post('/api/domain-migrations/plan', async (req) => {
    const user = requireAuth(req);
    const body = planSchema.parse(req.body ?? {});
    const from = getDomain(body.fromDomainId);
    requireClientAccess(req, from.clientId);
    const to = normalizeDomain(body.toDomain);
    const { bloqueosHttp: _b, ...plan } = calcularPlan(from, to, {
      comoAdministrador: user.role === 'admin' && !pideSoloCliente(req.query),
      // El plan no dice el origen: con el token de la administración lo pide
      // Skyway, que no puede adoptar un cambio que se lleva desde el panel.
      gestor: esIntegracionDeAdministracion(req) ? { origen: 'skyway' } : undefined,
    });
    return plan;
  });

  app.post('/api/domain-migrations', async (req, reply) => {
    const user = requireAuth(req);
    const body = crearSchema.parse(req.body ?? {});
    // El cambio escribe en el motor desde el primer paso: no mientras cambia de versión.
    exigirSinMantenimiento();
    const inicial = getDomain(body.fromDomainId);
    const clientId = inicial.clientId;
    requireClientAccess(req, clientId);
    if (body.origen === 'skyway' && !esIntegracionDeAdministracion(req)) {
      throw forbidden(
        'Solo Skyway, con el token de gestión de la administración, puede crear un cambio de dominio de Skyway.',
        'token_required',
      );
    }
    const to = normalizeDomain(body.toDomain);
    const comoAdministrador = user.role === 'admin' && !pideSoloCliente(req.query);
    const permitirInstancia = permiteInstancia(user, req.query);
    const alta = { clientId, to, comoAdministrador, esAdministrador: user.role === 'admin' };
    const gestor = { origen: body.origen ?? 'panel', referencia: body.referenciaExterna || null } as const;

    const { id, creado, completado } = await withLock('altas:dominios', () =>
      withLock(clientLockKey(clientId), async () => {
        const existente = cambioIdentico(inicial.id, to);
        const ajeno = existente ? ajenoAlGestor(existente, gestor) : null;
        if (ajeno) throw new HttpError(ajeno.status, ajeno.mensaje, ajeno.code);
        if (existente?.to_domain_id) return { id: existente.id, creado: false, completado: false };
        const from = getDomain(inicial.id);
        const { bloqueosHttp } = calcularPlan(from, to, { comoAdministrador, gestor });
        const primero = bloqueosHttp[0];
        if (existente) {
          // Un reinicio cortó la creación mientras se daba de alta
          // dominio2.es (el cambio existe, pero sin destino): Skyway reintenta
          // y aquí se termina. Si ya no se puede, el cambio a medio crear se
          // retira, como cuando la creación falla.
          if (primero) {
            db.prepare('DELETE FROM domain_migrations WHERE id = ?').run(existente.id);
            throw new HttpError(primero.status, primero.mensaje, primero.code);
          }
          await darDeAltaDestino(req, existente.id, alta);
          return { id: existente.id, creado: false, completado: true };
        }
        if (primero) throw new HttpError(primero.status, primero.mensaje, primero.code);

        const nuevoId = randomId('dmg');
        const t = now();
        try {
          db.transaction(() => {
            db.prepare(
              `INSERT INTO domain_migrations (id, client_id, from_domain_id, from_domain, to_domain, estado,
                 origen, referencia_externa, permitir_instancia, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'preparando', ?, ?, ?, ?, ?, ?)`,
            ).run(
              nuevoId,
              clientId,
              from.id,
              from.domain,
              to,
              body.origen ?? 'panel',
              body.referenciaExterna || null,
              permitirInstancia ? 1 : 0,
              user.id,
              t,
              t,
            );
            // Desde aquí el conjunto que se muda es fijo: el origen no admite altas.
            db.prepare(
              `INSERT INTO domain_migration_items (migration_id, tipo, item_id, local_part)
               SELECT ?, 'buzon', id, local_part FROM mailboxes WHERE domain_id = ?`,
            ).run(nuevoId, from.id);
            db.prepare(
              `INSERT INTO domain_migration_items (migration_id, tipo, item_id, local_part)
               SELECT ?, 'alias', id, local_part FROM aliases WHERE domain_id = ?`,
            ).run(nuevoId, from.id);
          })();
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw conflict(`${visible(from.domain)} ya está en un cambio de dominio abierto.`, 'migration_exists');
          }
          throw err;
        }
        await darDeAltaDestino(req, nuevoId, alta);
        return { id: nuevoId, creado: true, completado: false };
      }),
    );

    if (creado || completado) {
      const fila = exigir(id);
      audit(
        req,
        'domain.migration_created',
        { id, from: fila.from_domain, to: fila.to_domain, origen: fila.origen },
        clientId,
      );
      if (body.autoDns !== false && fila.to_domain_id) {
        // Solo crea lo que falta: el MX únicamente si dominio2.es no tenía
        // ninguno (un dominio sin MX no recibe correo de nadie, y la
        // pre-recepción llega en esta misma petición). Si recibe en otro
        // proveedor, el cambio de MX es una acción aparte (POST …/mx).
        try {
          const r = await aplicarDnsDominio(fila.to_domain_id, {
            replaceConflicts: false,
            includeRecommended: true,
            soloCrear: true,
            permitirInstancia,
          });
          if (!('unavailable' in r)) {
            anotarNombresCloudflare(id, r.applied);
            audit(
              req,
              'cloudflare.dns_applied',
              {
                domainId: fila.to_domain_id,
                domain: fila.to_domain,
                zone: r.zone.name,
                applied: r.applied.length,
                errors: r.errors.length,
                replaceConflicts: false,
                migrationId: id,
              },
              clientId,
            );
          }
        } catch (err) {
          // Sin Cloudflare se sigue en modo guiado: la vista da los registros.
          req.log.warn({ err, domain: fila.to_domain }, 'No se ha podido aplicar el DNS del dominio nuevo en Cloudflare');
        }
      }
      // Si el DNS ya está (propiedad probada), la pre-recepción se hace ahora;
      // si tarda, la termina el vigilante.
      await conPlazo(avanzarPreparacion(id, (msg) => req.log.warn(msg)), 20_000);
    }
    reply.status(creado ? 201 : 200);
    return vistaDe(exigir(id));
  });

  app.get('/api/domain-migrations', async (req) => {
    const user = requireAuth(req);
    const q = req.query as { clientId?: string; domainId?: string };
    const clientId = user.role === 'admin' ? q.clientId || null : user.clientId;
    if (user.role !== 'admin' && !clientId) return { migraciones: [] };
    const where: string[] = [];
    const params: string[] = [];
    if (clientId) {
      where.push('client_id = ?');
      params.push(clientId);
    }
    if (q.domainId) {
      where.push('(from_domain_id = ? OR to_domain_id = ?)');
      params.push(q.domainId, q.domainId);
    }
    const filas = db
      .prepare(
        `SELECT * FROM domain_migrations ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC LIMIT 100`,
      )
      .all(...params) as FilaCambio[];
    const ctx: ContextoVista = {};
    const migraciones: CambioDominioVista[] = [];
    for (const fila of filas) migraciones.push(await vistaDe(fila, ctx));
    return { migraciones };
  });

  app.get('/api/domain-migrations/:id', async (req) => vistaDe(cambioConAcceso(req)));

  /** «Comprobar ahora» (y cada 30 s con el asistente abierto). */
  app.post('/api/domain-migrations/:id/check', async (req) => {
    const fila = cambioConAcceso(req);
    vacioSchema.parse(req.body ?? {});
    // Con el motor cambiando de versión no se avanza (lo retoma el vigilante
    // al terminar): el asistente sigue viendo el estado sin un error cada 30 s.
    if (!mantenimientoActivo()) await avanzarPreparacion(fila.id, (msg) => req.log.warn(msg));
    return vistaDe(exigir(fila.id));
  });

  /**
   * Cambia el MX de dominio2.es a este servidor en Cloudflare, reemplazando
   * solo el MX del proveedor actual. Solo tras la pre-recepción: antes, el
   * correo que llegara a @dominio2.es se rechazaría.
   */
  app.post('/api/domain-migrations/:id/mx', async (req) => {
    const user = requireAuth(req);
    const inicial = cambioConAcceso(req);
    exigirOrigen(req, inicial);
    vacioSchema.parse(req.body ?? {});
    await conCerrojos(inicial, async () => {
      const fila = exigir(inicial.id);
      if (!EN_PREPARACION.has(fila.estado) || fila.direcciones_at === null || !fila.to_domain_id) {
        throw estadoNoValido();
      }
      const to = getDomain(fila.to_domain_id);
      if (!to.cloudflare) {
        throw badRequest(
          `El DNS de ${visible(to.domain)} no está en Cloudflare: cambia el MX en tu proveedor de DNS.`,
          'cloudflare_unavailable',
        );
      }
      const r = await aplicarDnsDominio(to.id, {
        replaceConflicts: false,
        // El MX y lo que Cloudflare aplaza hasta él (el SPF y el DMARC de un
        // dominio que no los tenía), como «Hacer el cambio» en la ficha del
        // dominio: sin ellos la compuerta del DNS no se cumpliría nunca. Solo
        // se aplican junto con el MX (ejecutarPlan), y los demás conflictos
        // (autodiscover, un mail.<dominio> del hosting) se conservan.
        reemplazar: [
          claveCambio({ type: 'MX', name: to.domain }),
          claveCambio({ type: 'TXT', name: to.domain }),
          claveCambio({ type: 'TXT', name: `_dmarc.${to.domain}` }),
        ],
        includeRecommended: true,
        permitirInstancia: permiteInstancia(user, req.query),
      });
      if ('unavailable' in r) throw badRequest(r.unavailable, 'cloudflare_unavailable');
      anotarNombresCloudflare(fila.id, r.applied);
      const errorMx = r.errors.find((e) => e.type.toUpperCase() === 'MX');
      if (errorMx) {
        // El MX no ha cambiado: no se audita como tal, solo lo que sí se escribió.
        if (r.applied.length > 0) {
          audit(
            req,
            'cloudflare.dns_applied',
            {
              domainId: to.id,
              domain: to.domain,
              zone: r.zone.name,
              applied: r.applied.length,
              errors: r.errors.length,
              replaceConflicts: false,
              migrationId: fila.id,
            },
            fila.client_id,
          );
        }
        throw new HttpError(502, `Cloudflare no ha aceptado el cambio del MX: ${errorMx.error}`, 'cloudflare_error');
      }
      audit(
        req,
        'domain.migration_mx_changed',
        { id: fila.id, domain: to.domain, applied: r.applied.length, errors: r.errors.length },
        fila.client_id,
      );
    });
    await avanzarPreparacion(inicial.id, (msg) => req.log.warn(msg));
    return vistaDe(exigir(inicial.id));
  });

  /** Pasar a dominio2.es. */
  app.post('/api/domain-migrations/:id/switch', async (req) => {
    const inicial = cambioConAcceso(req);
    exigirOrigen(req, inicial);
    vacioSchema.parse(req.body ?? {});
    exigirSinMantenimiento();
    let hecho = false;
    await conCerrojos(inicial, async () => {
      const fila = exigir(inicial.id);
      if (fila.estado === 'pasado') return;
      if ((fila.estado !== 'listo' && fila.estado !== 'pasando') || !fila.to_domain_id || !fila.from_domain_id) {
        throw estadoNoValido();
      }
      const hacia = visible(fila.to_domain);
      // Siempre se vuelve a medir: el DNS puede haber cambiado desde «listo».
      try {
        await medirDominio(fila.to_domain_id);
      } catch {
        // Sin medición deciden las compuertas (el motor caído ya bloquea).
      }
      const viejo = webmailViejo(fila);
      const compuertas = compuertasDe(fila, await saludMotor(), dominioOpcional(fila.to_domain_id), {
        viejo,
        nuevo: webmailNuevo(fila, viejo),
      });
      const fallidas = compuertas.filter((c) => c.bloquea && !c.ok);
      if (fallidas.length > 0) {
        if (fila.estado === 'listo') {
          actualizar(fila.id, { estado: 'preparando' });
          resolveAlert(alertaListo(fila.id));
        }
        throw conflict(
          `Todavía no se puede pasar a ${hacia}: ${fallidas.map((c) => motivoDe(c, hacia)).join('; ')}.`,
          'migration_not_ready',
        );
      }
      const colision = colisionEnDestino(fila);
      if (colision) {
        throw conflict(
          `${colision} ya existe en ${hacia}. Cámbiale el nombre o elimínalo antes de continuar.`,
          'migration_collision',
        );
      }
      // Para «Volver»: si el MX de dominio.es recibía aquí al pasar.
      const mxOrigen = await mxApuntaAqui(fila.from_domain).catch(() => null);
      actualizar(fila.id, { estado: 'pasando', error: null });
      try {
        await motorPasar(fila);
        db.transaction(() => {
          basePasar(exigir(fila.id));
          setJsonSetting(claveMxOrigen(fila.id), mxOrigen);
        })();
      } catch (err) {
        actualizar(fila.id, { error: mensajeDe(err) });
        throw errorDeAccion(err);
      }
      hecho = true;
    });
    const fila = exigir(inicial.id);
    if (hecho) {
      resolveAlert(alertaListo(fila.id));
      // Los nombres de autoconfiguración de dominio2.es pueden publicarse ya.
      void refreshAutoconfigHosts().catch(() => undefined);
      audit(
        req,
        'domain.migration_switched',
        { id: fila.id, from: fila.from_domain, to: fila.to_domain, buzones: buzonesDe(fila.id).length, alias: aliasVivos(fila.id).length },
        fila.client_id,
      );
    }
    return vistaDe(fila);
  });

  /** Volver a dominio.es (desde «pasado», o desde «pasando» con error). */
  app.post('/api/domain-migrations/:id/rollback', async (req) => {
    const inicial = cambioConAcceso(req);
    exigirOrigen(req, inicial);
    vacioSchema.parse(req.body ?? {});
    exigirSinMantenimiento();
    await conCerrojos(inicial, async () => {
      const fila = exigir(inicial.id);
      const valido =
        fila.estado === 'pasado' || fila.estado === 'volviendo' || (fila.estado === 'pasando' && fila.error !== null);
      if (!valido || !fila.to_domain_id || !fila.from_domain_id) throw estadoNoValido();
      // Si el MX de dominio.es se ha llevado a otro sitio desde que se pasó
      // (el paso previo a la baja), volver haría salir el correo otra vez como
      // @dominio.es y las respuestas no llegarían a estos buzones. Solo desde
      // «pasado»: a medias («pasando» o «volviendo» con error), volver es la
      // salida y no se frena. Sin DNS tampoco: no se puede saber y volver es
      // la vía segura.
      const mxAlPasar = getJsonSetting<boolean | null>(claveMxOrigen(fila.id));
      if (fila.estado === 'pasado' && mxAlPasar === true && (await mxApuntaAqui(fila.from_domain)) === false) {
        const desde = visible(fila.from_domain);
        throw conflict(
          `El MX de ${desde} ya no apunta a este servidor. Si vuelves, el correo saldrá otra vez como @${desde} y las respuestas no llegarían a estos buzones. Apunta antes el MX de ${desde} a este servidor y vuelve a intentarlo.`,
          'migration_old_mx_elsewhere',
        );
      }
      actualizar(fila.id, { estado: 'volviendo', error: null });
      try {
        await motorVolver(fila);
        db.transaction(() => baseVolver(exigir(fila.id)))();
      } catch (err) {
        actualizar(fila.id, { error: mensajeDe(err) });
        throw errorDeAccion(err);
      }
    });
    const fila = exigir(inicial.id);
    void refreshAutoconfigHosts().catch(() => undefined);
    audit(req, 'domain.migration_rolled_back', { id: fila.id, from: fila.from_domain, to: fila.to_domain }, fila.client_id);
    return vistaDe(fila);
  });

  /**
   * Cancelar el cambio: antes de pasar, o tras un «Pasar» o un «Volver» que
   * fallaron (primero se vuelve a dominio.es). Si falla a medias, el cambio
   * queda con error y sin la pre-recepción dada por hecha: la preparación la
   * rehace y «Cancelar» se puede repetir.
   */
  app.post('/api/domain-migrations/:id/cancel', async (req) => {
    const inicial = cambioConAcceso(req);
    exigirOrigen(req, inicial);
    vacioSchema.parse(req.body ?? {});
    exigirSinMantenimiento();
    const resultado = await conCerrojos(inicial, async () => {
      const fila = exigir(inicial.id);
      const aMedias = (fila.estado === 'pasando' || fila.estado === 'volviendo') && fila.error !== null;
      if (!EN_PREPARACION.has(fila.estado) && !aMedias) throw estadoNoValido();
      // Las comprobaciones no cambian nada: si no pasan, el cambio sigue igual.
      if (!esIntegracionDeAdministracion(req)) {
        const conApps = appsConUsuarioNuevo(fila);
        if (conApps.length > 0) throw errorCancelarConApps(fila, conApps);
      }
      await comprobarCancelacion(fila);
      try {
        return await cancelarSinCerrojo(req, fila);
      } catch (err) {
        // Si falló al volver a dominio.es, el error es el de «Volver» (la
        // interfaz ya lo presenta así); si no, el de la cancelación.
        const enVolver = leer(fila.id)?.estado === 'volviendo';
        actualizar(fila.id, {
          error: enVolver ? mensajeDe(err) : `No se ha podido cancelar el cambio: ${mensajeDe(err)}`,
        });
        throw errorDeAccion(err);
      }
    });
    const fila = exigir(inicial.id);
    resolveAlert(alertaListo(fila.id));
    audit(
      req,
      'domain.migration_cancelled',
      {
        id: fila.id,
        from: fila.from_domain,
        to: fila.to_domain,
        destinoEliminado: resultado.destinoEliminado,
        volvio: resultado.volvio,
      },
      fila.client_id,
    );
    return vistaDe(fila);
  });

  /** Dar de baja dominio.es (tras pasar). */
  app.post('/api/domain-migrations/:id/retire', async (req) => {
    const inicial = cambioConAcceso(req);
    exigirOrigen(req, inicial);
    const body = bajaSchema.parse(req.body ?? {});
    exigirSinMantenimiento();
    const confirmado = body.confirm.trim().toLowerCase().replace(/\.$/, '');
    if (confirmado !== inicial.from_domain && confirmado !== visible(inicial.from_domain).toLowerCase()) {
      throw badRequest(`Escribe ${visible(inicial.from_domain)} exactamente para confirmar.`, 'confirm_mismatch');
    }
    const resultado = await conCerrojos(inicial, async () => {
      const fila = exigir(inicial.id);
      if ((fila.estado !== 'pasado' && fila.estado !== 'dando_de_baja') || !fila.from_domain_id) {
        throw estadoNoValido();
      }
      const conApps = pendientesConApps(fila.id);
      if (conApps.length > 0) throw errorBuzonUsadoPorApp(conApps.flatMap((x) => x.apps));
      if (alojaLaInstancia(fila.from_domain)) throw errorInstancia(fila.from_domain);
      const desde = visible(fila.from_domain);
      const mx = await mxApuntaAqui(fila.from_domain);
      if (mx === null) {
        throw new HttpError(
          503,
          `No se ha podido consultar el DNS de ${desde}. Vuelve a intentarlo en unos minutos.`,
          'dns_unknown',
        );
      }
      if (mx) {
        throw conflict(
          `El MX de ${desde} todavía apunta a este servidor (o no tiene MX y su registro A apunta aquí). Cámbialo o publica un MX nulo («0 .») antes de darlo de baja: si no, el correo que siga llegando a @${desde} se rechazaría y este servidor podría bloquear a quien lo envía.`,
          'migration_old_mx_here',
        );
      }
      actualizar(fila.id, { estado: 'dando_de_baja', error: null });
      try {
        return await darDeBajaSinCerrojo(req, fila);
      } catch (err) {
        actualizar(fila.id, { error: mensajeDe(err) });
        throw errorDeAccion(err);
      }
    });
    const fila = exigir(inicial.id);
    if (resultado.recepcionExterna) void sincronizarRecepcionExterna().catch(() => undefined);
    void refreshAutoconfigHosts().catch(() => undefined);
    for (const propio of resultado.propios) {
      audit(
        req,
        'whitelabel.domain_deleted',
        { id: propio.id, hostname: propio.hostname, withMailDomain: fila.from_domain },
        fila.client_id,
      );
    }
    audit(
      req,
      'domain.migration_retired',
      { id: fila.id, from: fila.from_domain, to: fila.to_domain, forzados: resultado.forzados },
      fila.client_id,
    );
    return vistaDe(fila);
  });

  /**
   * «Mensaje para tu equipo»: un enlace de configuración (7 días, sin
   * contraseña) por cada persona pendiente de actualizar sus dispositivos.
   */
  app.post('/api/domain-migrations/:id/setup-links', async (req) => {
    const fila = cambioConAcceso(req);
    vacioSchema.parse(req.body ?? {});
    if (getClient(fila.client_id).suspended) {
      throw badRequest(
        'El cliente está suspendido. Reactívalo antes de crear enlaces de configuración.',
        'client_suspended',
      );
    }
    // Un buzón que usa una aplicación de Skyway no lo actualiza su titular
    // (su enlace respondería 409 mailbox_used_by_app): lo hace Skyway.
    const pendientes = buzonesDe(fila.id).filter(
      (b) => b.usuario_motor !== null && b.status === 'active' && appsSkywayDe(b.id).length === 0,
    );
    const enlaces: { mailboxId: string; email: string; url: string; expiresAt: number }[] = [];
    for (const b of pendientes) {
      const email = `${b.local_part}@${b.domain}`;
      const enlace = crearEnlaceConfiguracion(req, b.id, HORAS_ENLACE);
      audit(
        req,
        'mailbox.setup_link_created',
        { mailboxId: b.id, email, linkId: enlace.id, hasPassword: false, ttlHours: HORAS_ENLACE, migrationId: fila.id },
        fila.client_id,
      );
      enlaces.push({ mailboxId: b.id, email, url: enlace.url, expiresAt: enlace.expiresAt });
    }
    return { enlaces };
  });
}

/* --------------------------------- Cancelar --------------------------------- */

/** ¿Tiene (o puede tener, tras un fallo a medias) direcciones de dominio2.es? */
function conPreRecepcion(fila: FilaCambio): boolean {
  return (
    fila.direcciones_at !== null ||
    fila.paso.startsWith('direcciones') ||
    fila.paso.startsWith('quitando') ||
    fila.estado === 'pasando' ||
    fila.estado === 'volviendo'
  );
}

/**
 * Antes de cancelar: si los buzones ya tienen sus direcciones de dominio2.es,
 * su MX no puede apuntar a este servidor. Quitarlas haría rechazar el correo
 * que ya llega (crítica C5), tanto si el dominio lo creó el cambio como si ya
 * existía (p. ej. se cambió el MX desde otro proveedor siguiendo el asistente).
 */
async function comprobarCancelacion(fila: FilaCambio): Promise<void> {
  if (!conPreRecepcion(fila)) return;
  const hacia = visible(fila.to_domain);
  const mx = await mxApuntaAqui(fila.to_domain);
  if (mx === null) {
    throw new HttpError(
      503,
      `No se ha podido consultar el DNS de ${hacia}. Vuelve a intentarlo en unos minutos.`,
      'dns_unknown',
    );
  }
  if (mx) {
    throw conflict(
      `El MX de ${hacia} ya apunta a este servidor. Cámbialo o quítalo antes de cancelar: si no, el correo que llegue a @${hacia} se rechazaría.`,
      'migration_new_mx_here',
    );
  }
}

async function cancelarSinCerrojo(
  req: FastifyRequest,
  inicial: FilaCambio,
): Promise<{ destinoEliminado: boolean; volvio: boolean }> {
  const engine = getEngine();
  let fila = inicial;
  const conDirecciones = conPreRecepcion(fila);

  // Tras un «Pasar» o un «Volver» que fallaron, primero se vuelve a
  // dominio.es: es lo mismo que «Volver» y deja el cambio en «listo».
  let volvio = false;
  if (fila.estado === 'pasando' || fila.estado === 'volviendo') {
    actualizar(fila.id, { estado: 'volviendo', error: null });
    await motorVolver(fila);
    db.transaction(() => baseVolver(exigir(fila.id)))();
    fila = exigir(fila.id);
    volvio = true;
  }
  const to = dominioOpcional(fila.to_domain_id);

  // Quien actualizó al usuario de dominio2.es antes de un «Volver» vuelve a
  // entrar con su dirección vigente (la de dominio.es).
  for (const b of buzonesDe(fila.id)) {
    if (b.usuario_motor !== `${b.local_part}@${fila.to_domain}`) continue;
    const cambio = await actualizarUsuarioDelCambio(b.id);
    if (cambio) {
      audit(req, 'mailbox.login_updated', { id: b.id, de: cambio.de, a: cambio.a, por: 'cancelacion' }, fila.client_id);
    }
  }

  if (conDirecciones) {
    const buzones = itemsDe(fila.id, 'buzon');
    const alias = aliasVivos(fila.id);
    const total = buzones.length + alias.length;
    // Antes de tocar el motor, la pre-recepción deja de darse por hecha: si
    // algo falla a medias, la vista no dirá «dominio2.es ya recibe en los
    // buzones» (alguien podría cambiar el MX a este servidor) y la siguiente
    // vuelta de la preparación la rehace entera, también tras un reinicio.
    if (fila.estado === 'listo') resolveAlert(alertaListo(fila.id));
    actualizar(fila.id, { estado: 'preparando', direcciones_at: null, paso: `quitando direcciones 0/${total}` });
    let k = 0;
    for (const b of buzones) {
      k += 1;
      actualizar(fila.id, { paso: `quitando direcciones ${k}/${total}` });
      const login = await loginDeBuzon(b.item_id);
      if (login) await engine.setAddresses(login, { remove: [`${b.local_part}@${fila.to_domain}`] });
    }
    for (const a of alias) {
      k += 1;
      actualizar(fila.id, { paso: `quitando direcciones ${k}/${total}` });
      try {
        await engine.setAddresses(`${a.local_part}@${fila.from_domain}`, { remove: [`${a.local_part}@${fila.to_domain}`] });
      } catch (err) {
        // Un alias que no existe en el motor no tiene direcciones que quitar.
        if (!esCodigo(err, 'engine_not_found')) throw err;
      }
    }
    await engine.reloadDirectory();
  }

  // El webmail nuevo lo creó este cambio: se va con él.
  if (fila.creo_webmail_id) {
    eliminarDominioPropio(fila.creo_webmail_id);
    actualizar(fila.id, { creo_webmail_id: null });
  }

  let destinoEliminado = false;
  if (fila.creo_destino === 1 && to) {
    const propias =
      db.prepare('SELECT 1 FROM mailboxes WHERE domain_id = ? LIMIT 1').get(to.id) ||
      db.prepare('SELECT 1 FROM aliases WHERE domain_id = ? LIMIT 1').get(to.id);
    if (!propias) {
      // Como en la baja: primero su cuenta remitente, si se llegó a crear.
      if (!(await borrarRemitenteConfiguracion(to))) throw remitenteSinRetirar(visible(to.domain));
      await engine.deleteDomain(to.domain);
      await engine.removeDkim(to.domain);
      for (const propio of dominiosPropiosDe(to.id)) eliminarDominioPropio(propio.id);
      db.prepare('DELETE FROM domains WHERE id = ?').run(to.id);
      resolveAlert(`domain_dns:${to.id}`);
      if (to.recepcionExterna) void sincronizarRecepcionExterna().catch(() => undefined);
      destinoEliminado = true;
      audit(req, 'domain.deleted', { id: to.id, domain: to.domain, migrationId: fila.id }, fila.client_id);
    }
  }

  db.transaction(() => {
    actualizar(fila.id, { estado: 'cancelada', terminado_at: now(), paso: '', error: null });
    olvidarNotasDePasar(fila.id);
  })();
  return { destinoEliminado, volvio };
}

/** La cuenta remitente del dominio sigue en el motor: se repite la operación. */
function remitenteSinRetirar(dominio: string): HttpError {
  return new HttpError(
    502,
    `No se ha podido retirar del servidor de correo la cuenta que envía los correos de configuración de ${dominio}. Vuelve a intentarlo.`,
    'engine_error',
  );
}

/* -------------------------------- Dar de baja ------------------------------- */

async function darDeBajaSinCerrojo(
  req: FastifyRequest,
  fila: FilaCambio,
): Promise<{ forzados: number; propios: ClientDomain[]; recepcionExterna: boolean }> {
  const engine = getEngine();
  const from = fila.from_domain;
  const fromId = fila.from_domain_id!;
  const desde = visible(from);

  // 1. Quien no actualizó sus dispositivos pasa ya al usuario nuevo.
  const pendientes = buzonesDe(fila.id).filter((b) => b.usuario_motor !== null);
  let forzados = 0;
  for (const [i, b] of pendientes.entries()) {
    actualizar(fila.id, { paso: `usuarios ${i + 1}/${pendientes.length}` });
    const cambio = await actualizarUsuarioDelCambio(b.id);
    if (cambio) {
      forzados += 1;
      audit(req, 'mailbox.login_updated', { id: b.id, de: cambio.de, a: cambio.a, por: 'baja' }, fila.client_id);
    }
  }

  // 2. Fuera las direcciones @dominio.es.
  const buzones = itemsDe(fila.id, 'buzon');
  const alias = aliasVivos(fila.id);
  const total = buzones.length + alias.length;
  let k = 0;
  const nombres: string[] = [];
  for (const b of buzones) {
    k += 1;
    actualizar(fila.id, { paso: `direcciones ${k}/${total}` });
    const login = await loginDeBuzon(b.item_id);
    if (!login) continue;
    await engine.setAddresses(login, { remove: [`${b.local_part}@${from}`] });
    nombres.push(login);
  }
  for (const a of alias) {
    k += 1;
    actualizar(fila.id, { paso: `direcciones ${k}/${total}` });
    const nombre = `${a.local_part}@${fila.to_domain}`;
    await engine.setAddresses(nombre, { remove: [`${a.local_part}@${from}`] });
    nombres.push(nombre);
  }
  await engine.reloadDirectory();
  // Antes de borrar el dominio del motor, ninguno puede conservar una
  // dirección suya: la baja de un dominio no toca los principales.
  const quedan: string[] = [];
  for (const nombre of nombres) {
    const p = await engine.getPrincipal(nombre);
    if (p?.emails.some((e) => e.toLowerCase().endsWith(`@${from}`))) quedan.push(nombre);
  }
  if (quedan.length > 0) {
    throw new HttpError(
      502,
      `En el servidor de correo, ${quedan.join(', ')} ${quedan.length === 1 ? 'conserva' : 'conservan'} direcciones de ${desde}. Revísalo y vuelve a intentarlo.`,
      'engine_error',
    );
  }

  // 3. El dominio y sus claves DKIM fuera del motor. Antes, la cuenta oculta
  // configuration@dominio.es (la que envía los correos de configuración): si
  // no, quedaría en el motor con una dirección de un dominio que ya no existe.
  actualizar(fila.id, { paso: 'dominio' });
  if (!(await borrarRemitenteConfiguracion({ id: fromId, domain: from }))) throw remitenteSinRetirar(desde);
  await engine.deleteDomain(from);
  await engine.removeDkim(from);

  // 4. Y fuera del panel.
  const anterior = dominioOpcional(fromId);
  const propios = dominiosPropiosDe(fromId);
  db.transaction(() => {
    const ocupado =
      db.prepare('SELECT 1 FROM mailboxes WHERE domain_id = ? LIMIT 1').get(fromId) ||
      db.prepare('SELECT 1 FROM aliases WHERE domain_id = ? LIMIT 1').get(fromId);
    if (ocupado) {
      throw conflict(
        `${desde} todavía tiene buzones o alias que no forman parte del cambio. Elimínalos o muévelos y vuelve a intentarlo.`,
        'migration_state',
      );
    }
    // El webmail viejo (webmail.dominio.es) deja de publicarse.
    for (const propio of propios) eliminarDominioPropio(propio.id);
    db.prepare('DELETE FROM domains WHERE id = ?').run(fromId);
    actualizar(fila.id, { estado: 'dado_de_baja', terminado_at: now(), paso: '', error: null });
    olvidarNotasDePasar(fila.id);
  })();
  // El vigilante ya no volverá a medir este dominio.
  resolveAlert(`domain_dns:${fromId}`);
  return { forzados, propios, recepcionExterna: Boolean(anterior?.recepcionExterna) };
}

/* ------------------------------ Arranque y vigilante ------------------------------ */

/**
 * Al arrancar, un estado en curso sin error es una acción que el reinicio
 * cortó: se marca para que la interfaz ofrezca «Reintentar». No se reanuda
 * sola: quien la lanzó decide (todas son idempotentes).
 */
export function marcarCambiosInterrumpidos(): number {
  const t = now();
  const enCurso = db
    .prepare(
      `UPDATE domain_migrations SET error = 'Interrumpido por un reinicio del panel. Pulsa «Reintentar».', updated_at = ?
       WHERE estado IN ('pasando', 'volviendo', 'dando_de_baja') AND error IS NULL`,
    )
    .run(t).changes;
  // Una creación que el reinicio cortó mientras se daba de alta dominio2.es:
  // el cambio existe sin destino y la preparación no puede avanzar. Crearlo
  // otra vez con el mismo dominio lo termina (Skyway lo hace al reintentar).
  const sinDestino = db
    .prepare(
      `UPDATE domain_migrations SET error = 'La preparación se interrumpió por un reinicio del panel antes de dar de alta el dominio nuevo. Cancela el cambio y vuelve a crearlo.', updated_at = ?
       WHERE estado = 'preparando' AND to_domain_id IS NULL AND error IS NULL`,
    )
    .run(t).changes;
  // Una cancelación cortada a mitad ya dejó de dar la pre-recepción por hecha
  // (la preparación la rehace): solo falta decirlo.
  const cancelando = db
    .prepare(
      `UPDATE domain_migrations SET error = 'La cancelación se interrumpió por un reinicio del panel. Vuelve a pulsar «Cancelar el cambio».', updated_at = ?
       WHERE estado = 'preparando' AND paso LIKE 'quitando%' AND error IS NULL`,
    )
    .run(t).changes;
  return enCurso + sinDestino + cancelando;
}

/**
 * Lo que hace el vigilante con los cambios de dominio: avanza la preparación
 * de los que esperan al DNS y, tras pasar (o tras la baja), convierte en
 * principal el webmail nuevo en cuanto está activo.
 */
export async function vigilarCambiosDeDominio(log?: Registro): Promise<void> {
  const enPreparacion = db
    .prepare("SELECT id FROM domain_migrations WHERE estado IN ('preparando', 'listo') ORDER BY created_at")
    .all() as { id: string }[];
  for (const { id } of enPreparacion) await avanzarPreparacion(id, log);

  // Tras pasar, y también tras una baja que llegó antes de que el webmail
  // nuevo estuviera activo (sin el viejo, el cliente se queda sin principal).
  // Las bajas, solo durante un mes: después, lo que haya es elección suya.
  const pasados = db
    .prepare(
      `SELECT * FROM domain_migrations
       WHERE estado IN ('pasado', 'dando_de_baja')
          OR (estado = 'dado_de_baja' AND creo_webmail_id IS NOT NULL AND terminado_at >= ?)`,
    )
    .all(now() - 30 * 24 * 3600_000) as FilaCambio[];
  for (const fila of pasados) {
    try {
      const viejo = webmailViejo(fila);
      moverWebmailPrincipal(fila.client_id, viejo, webmailNuevo(fila, viejo));
    } catch (err) {
      log?.(`cambio de dominio ${fila.id}: ${mensajeDe(err)}`);
    }
  }
}
