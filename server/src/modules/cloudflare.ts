import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { decryptSecret, encryptSecret, randomId } from '../core/crypto';
import { badRequest, conflict, forbidden, notFound } from '../core/errors';
import {
  CloudflareClient,
  CloudflareError,
  COMENTARIO_MAILWAY,
  normalizarTxt,
  pistaToken,
  trocearTxt,
  type CfLote,
  type CfRegistro,
  type CfRegistroNuevo,
  type CfZona,
} from '../core/cloudflare';
import { getEngine } from '../engine';
import type { EngineDnsRecord } from '../engine/types';
import { audit } from './audit';
import { requireAdmin, requireAuth, requireClientAccess, type AuthedUser } from './auth';
import { getClient } from './clients';
import { mecanismosSpf } from './deliverability';
import { getDomain, refreshDomainDns, type DomainRecord } from './domains';
import { getInstanceSettings, getJsonSetting, setJsonSetting } from './settings';
import { getClientDomain, refreshClientDomain, type ClientDomain } from './whitelabel';
import { esObligatorio, filtrarPorNivel, seleccionarRegistros } from './zonefile';

/**
 * Integración con Cloudflare: el DNS de correo de un dominio en un clic.
 *
 * Principios:
 * - Nunca se aplica nada sin plan: primero se lee lo que hay en la zona y se
 *   calcula qué crear, qué actualizar, qué conservar y qué entra en conflicto.
 * - Lo que ya funciona se respeta: un SPF existente se fusiona (no se
 *   sustituye), un DMARC existente se conserva, y los MX de otro proveedor
 *   solo se reemplazan con confirmación explícita, porque hacerlo corta el
 *   correo que hoy llega a ese proveedor.
 * - Todo va en un único lote transaccional: el dominio no queda a medias.
 * - Los registros de correo nunca van con el proxy de Cloudflare: SMTP e IMAP
 *   no atraviesan la nube naranja.
 */

/* ------------------------------- Cuentas ---------------------------------- */

interface CuentaRow {
  id: string;
  client_id: string | null;
  label: string;
  token_enc: string;
  token_hint: string;
  created_by: string | null;
  created_at: number;
  last_verified_at: number | null;
  last_error: string;
}

export interface CuentaCloudflare {
  id: string;
  /** null = cuenta de la instancia (del administrador). */
  clientId: string | null;
  label: string;
  tokenHint: string;
  createdAt: number;
  lastVerifiedAt: number | null;
  lastError: string | null;
  /** Nombres de zona visibles para el token (hasta 50, para mostrar). */
  zones?: string[];
  /** Total de zonas visibles, aunque se muestren solo 50. */
  zonesTotal?: number;
}

interface CacheZonas {
  zones: string[];
  total: number;
  at: number;
}

const CACHE_ZONAS_MS = 10 * 60_000;
const MAX_ZONAS_MOSTRADAS = 50;

function claveCache(id: string): string {
  return `cloudflare_zonas:${id}`;
}

function toCuenta(row: CuentaRow, cache: CacheZonas | null): CuentaCloudflare {
  return {
    id: row.id,
    clientId: row.client_id,
    label: row.label,
    tokenHint: row.token_hint,
    createdAt: row.created_at,
    lastVerifiedAt: row.last_verified_at,
    lastError: row.last_error || null,
    ...(cache ? { zones: cache.zones.slice(0, MAX_ZONAS_MOSTRADAS), zonesTotal: cache.total } : {}),
  };
}

function cuentaRow(id: string): CuentaRow | undefined {
  return db.prepare('SELECT * FROM cloudflare_accounts WHERE id = ?').get(id) as CuentaRow | undefined;
}

function cuentasDeCliente(clientId: string): CuentaRow[] {
  return db
    .prepare('SELECT * FROM cloudflare_accounts WHERE client_id = ? ORDER BY created_at')
    .all(clientId) as CuentaRow[];
}

function cuentasDeInstancia(): CuentaRow[] {
  return db
    .prepare('SELECT * FROM cloudflare_accounts WHERE client_id IS NULL ORDER BY created_at')
    .all() as CuentaRow[];
}

function marcarVerificada(id: string): void {
  db.prepare("UPDATE cloudflare_accounts SET last_verified_at = ?, last_error = '' WHERE id = ?").run(
    now(),
    id,
  );
}

function marcarError(id: string, mensaje: string): void {
  db.prepare('UPDATE cloudflare_accounts SET last_error = ? WHERE id = ?').run(mensaje.slice(0, 500), id);
}

/**
 * Cliente de Cloudflare de una cuenta. Si el secreto de Mailway cambió, el
 * token ya no se puede descifrar: se informa como error de la cuenta en vez
 * de devolver un 500 genérico.
 */
function clienteDe(row: CuentaRow): CloudflareClient {
  let token: string;
  try {
    token = decryptSecret(row.token_enc);
  } catch {
    throw new CloudflareError(
      400,
      'No se ha podido descifrar el token de esta cuenta (la clave de Mailway ha cambiado). Elimine la cuenta y vuelva a conectarla.',
      'cloudflare_token_unreadable',
    );
  }
  return new CloudflareClient(token);
}

/**
 * Token en claro de una cuenta, para procesos del servidor que lo necesitan
 * tal cual (p. ej. el reto DNS-01 de ACME del motor de correo). Nunca debe
 * devolverse por la API ni registrarse; quien lo use comprueba antes que el
 * usuario puede usar esa cuenta (las de la instancia, solo el administrador).
 */
export function tokenDeCuenta(id: string): { token: string; clientId: string | null; label: string } {
  const fila = cuentaRow(id);
  if (!fila) throw notFound('Cuenta de Cloudflare no encontrada.');
  let token: string;
  try {
    token = decryptSecret(fila.token_enc);
  } catch {
    throw badRequest(
      'No se ha podido descifrar el token de esta cuenta (la clave de Mailway ha cambiado). Elimine la cuenta y vuelva a conectarla.',
      'cloudflare_token_unreadable',
    );
  }
  return { token, clientId: fila.client_id, label: fila.label };
}

function mensajeDe(err: unknown): string {
  if (err instanceof CloudflareError) return err.message;
  return 'Se ha producido un error inesperado al consultar Cloudflare.';
}

/** Zonas de una cuenta, con caché de 10 minutos (listarlas cuesta peticiones). */
async function zonasDeCuenta(row: CuentaRow, forzar = false): Promise<CacheZonas | null> {
  const cache = getJsonSetting<CacheZonas>(claveCache(row.id));
  if (!forzar && cache && now() - cache.at < CACHE_ZONAS_MS) return cache;
  try {
    const zonas = await clienteDe(row).listZones();
    const nombres = zonas.map((z) => z.name).sort((a, b) => a.localeCompare(b));
    const nueva: CacheZonas = {
      zones: nombres.slice(0, 500),
      total: nombres.length,
      at: now(),
    };
    setJsonSetting(claveCache(row.id), nueva);
    marcarVerificada(row.id);
    return nueva;
  } catch (err) {
    marcarError(row.id, mensajeDe(err));
    return cache;
  }
}

/** Cuentas que un usuario puede ver y usar. */
function cuentasVisibles(user: AuthedUser, clientId?: string): CuentaRow[] {
  if (user.role === 'admin') {
    if (clientId === 'instancia') return cuentasDeInstancia();
    if (clientId) return cuentasDeCliente(clientId);
    return db.prepare('SELECT * FROM cloudflare_accounts ORDER BY created_at').all() as CuentaRow[];
  }
  return user.clientId ? cuentasDeCliente(user.clientId) : [];
}

/* ----------------------- Resolución de cuenta y zona ---------------------- */

export interface Resolucion {
  cuenta: CuentaRow;
  cliente: CloudflareClient;
  zona: CfZona;
}

/**
 * Busca la cuenta cuyo token ve la zona de `hostname`: primero la guardada
 * en el dominio, luego las del cliente y, por último, las de la instancia.
 *
 * Las cuentas de la instancia solo se prueban a petición del administrador.
 * Si un cliente pudiera usarlas, le bastaría con dar de alta como dominio
 * propio uno que viva en la cuenta del administrador (o un subdominio suyo)
 * para escribir en esa zona. Una cuenta de la instancia que quedó asociada
 * al dominio porque el administrador aplicó su DNS sí sirve después para el
 * cliente: esa asociación la ha decidido el administrador.
 */
export async function resolverZona(
  hostname: string,
  opts: { clientId: string | null; storedAccountId?: string | null; permitirInstancia: boolean },
): Promise<{ resolucion: Resolucion | null; motivo: string }> {
  const candidatas: CuentaRow[] = [];
  const guardada = opts.storedAccountId ? cuentaRow(opts.storedAccountId) : undefined;
  if (guardada && (guardada.client_id === null || guardada.client_id === opts.clientId)) {
    candidatas.push(guardada);
  }
  if (opts.clientId) candidatas.push(...cuentasDeCliente(opts.clientId));
  if (opts.permitirInstancia) candidatas.push(...cuentasDeInstancia());

  const vistas = new Set<string>();
  const errores: string[] = [];
  for (const cuenta of candidatas) {
    if (vistas.has(cuenta.id)) continue;
    vistas.add(cuenta.id);
    try {
      const cliente = clienteDe(cuenta);
      const zona = await cliente.findZoneFor(hostname);
      marcarVerificada(cuenta.id);
      if (zona) return { resolucion: { cuenta, cliente, zona }, motivo: '' };
    } catch (err) {
      // Un token caducado no debe impedir probar las demás cuentas, pero
      // los límites de peticiones sí se comunican tal cual.
      if (err instanceof CloudflareError && err.code === 'cloudflare_rate_limited') throw err;
      const mensaje = mensajeDe(err);
      marcarError(cuenta.id, mensaje);
      errores.push(`${cuenta.label}: ${mensaje}`);
    }
  }

  if (vistas.size === 0) {
    const hayInstancia = !opts.permitirInstancia && cuentasDeInstancia().length > 0;
    return {
      resolucion: null,
      motivo: hayInstancia
        ? 'No hay ninguna cuenta de Cloudflare propia conectada. Las cuentas de la instancia solo las utiliza el administrador: conecte una cuenta en Conexiones o solicite al administrador que aplique el DNS.'
        : 'No hay ninguna cuenta de Cloudflare conectada. Conecte una en Conexiones para configurar el DNS automáticamente.',
    };
  }
  const detalle = errores.length > 0 ? ` Último error: ${errores[errores.length - 1]}` : '';
  return {
    resolucion: null,
    motivo: `Ninguna de las cuentas de Cloudflare conectadas contiene la zona de ${hostname}. Compruebe que el dominio está en esa cuenta de Cloudflare y que el token incluye su zona.${detalle}`,
  };
}

/* ---------------------------------- Plan ---------------------------------- */

export type AccionPlan = 'create' | 'update' | 'keep' | 'conflict';

export interface CambioPlan {
  action: AccionPlan;
  type: string;
  name: string;
  /** Valor que quedará publicado (en un MX, el servidor; la prioridad va aparte). */
  content: string;
  priority?: number;
  /** Lo que hay ahora en Cloudflare, si hay algo. */
  current?: string;
  reason: string;
  required: boolean;
}

interface Operaciones {
  deletes: string[];
  patches: ({ id: string } & Partial<CfRegistroNuevo>)[];
  puts: ({ id: string } & CfRegistroNuevo)[];
  posts: CfRegistroNuevo[];
}

export interface CambioInterno extends CambioPlan {
  /** Operaciones de un alta o una actualización. */
  operaciones: Operaciones | null;
  /** Operaciones para sustituir lo existente si se confirma el reemplazo. */
  reemplazo: Operaciones | null;
}

/** Registro deseado, ya en la forma en que se compara con Cloudflare. */
export interface Deseado {
  type: string;
  /** FQDN sin punto final, en minúsculas. */
  name: string;
  /** MX/CNAME: destino; TXT: texto plano; A: IP; SRV: "prioridad peso puerto destino". */
  content: string;
  priority?: number;
  data?: { priority: number; weight: number; port: number; target: string };
  required: boolean;
  /**
   * Hosts web (panel, webmail): el proxy de Cloudflare no les impide
   * funcionar, así que un proxy activo se respeta. En los de correo no.
   */
  proxyTolerado?: boolean;
}

const vacias = (): Operaciones => ({ deletes: [], patches: [], puts: [], posts: [] });

function sinPunto(valor: string): string {
  return valor.trim().replace(/\.$/, '').toLowerCase();
}

/** Convierte un registro del motor (ya seleccionado) en uno deseado. */
export function deseadoDe(record: EngineDnsRecord): Deseado | null {
  const type = record.type.toUpperCase();
  const name = sinPunto(record.name);
  const required = esObligatorio(record);
  const content = record.content.trim();
  if (type === 'MX') {
    const partes = content.split(/\s+/);
    const destino = sinPunto(partes[partes.length - 1] || '');
    const prioridad = partes.length > 1 ? Number(partes[0]) : 10;
    return { type, name, content: destino, priority: Number.isFinite(prioridad) ? prioridad : 10, required };
  }
  if (type === 'SRV') {
    const [p, w, puerto, destino] = content.split(/\s+/);
    const data = {
      priority: Number(p) || 0,
      weight: Number(w) || 0,
      port: Number(puerto) || 0,
      target: sinPunto(destino || ''),
    };
    if (!data.port || !data.target) return null;
    return {
      type,
      name,
      content: `${data.priority} ${data.weight} ${data.port} ${data.target}`,
      data,
      required,
    };
  }
  if (type === 'TXT') return { type, name, content: normalizarTxt(content), required };
  if (type === 'CNAME') return { type, name, content: sinPunto(content), required };
  if (type === 'A' || type === 'AAAA') return { type, name, content, required };
  return null;
}

/** Cuerpo del registro para la API: sin proxy, TTL automático y marcado como de Mailway. */
export function cuerpoRegistro(d: Deseado): CfRegistroNuevo {
  const base = { type: d.type, name: d.name, ttl: 1, proxied: false, comment: COMENTARIO_MAILWAY };
  if (d.type === 'MX') return { ...base, content: d.content, priority: d.priority ?? 10 };
  if (d.type === 'SRV' && d.data) return { ...base, data: { ...d.data } };
  if (d.type === 'TXT') return { ...base, content: trocearTxt(d.content) };
  return { ...base, content: d.content };
}

/** Descripción legible de un registro existente. */
function describir(r: CfRegistro): string {
  let valor: string;
  if (r.type === 'MX') valor = `${r.priority ?? ''} ${r.content}`.trim();
  else if (r.type === 'SRV' && r.data) {
    valor = `${r.data.priority ?? 0} ${r.data.weight ?? 0} ${r.data.port ?? 0} ${sinPunto(r.data.target || '')}`;
  } else if (r.type === 'TXT') valor = normalizarTxt(r.content);
  else valor = r.content;
  return `${r.type} ${valor}${r.proxied ? ' (con proxy)' : ''}`;
}

function esMailway(r: CfRegistro): boolean {
  return (r.comment || '').toLowerCase().includes(COMENTARIO_MAILWAY.toLowerCase());
}

function txtDe(r: CfRegistro): string {
  return normalizarTxt(r.content);
}

function clavePublicaDkim(valor: string): string {
  const m = valor.replace(/\s|"/g, '').match(/p=([^;]*)/);
  return m ? m[1]! : valor.trim();
}

function mismoSrv(r: CfRegistro, d: Deseado): boolean {
  if (!d.data) return false;
  let data = r.data;
  if (!data) {
    // Sin «data», el contenido es «peso puerto destino» y la prioridad va aparte.
    const [w, puerto, destino] = r.content.trim().split(/\s+/);
    data = { priority: r.priority, weight: Number(w), port: Number(puerto), target: destino };
  }
  return (
    Number(data.priority ?? 0) === d.data.priority &&
    Number(data.weight ?? 0) === d.data.weight &&
    Number(data.port ?? 0) === d.data.port &&
    sinPunto(data.target || '') === d.data.target
  );
}

/**
 * Añade al SPF actual los mecanismos que faltan (normalmente «mx») justo
 * antes del «all» final, sin tocar el resto: los include de otros servicios
 * y el calificador final (~all, -all) son decisiones del titular.
 * Devuelve null si no falta nada.
 */
export function fusionarSpf(actual: string, deseado: string): { valor: string; anadidos: string[] } | null {
  const presentes = new Set(mecanismosSpf(actual));
  const faltan = mecanismosSpf(deseado).filter((m) => !presentes.has(m));
  if (faltan.length === 0) return null;
  const tokens = actual.trim().split(/\s+/);
  let indice = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (/^[-~?+]?all$/i.test(tokens[i]!)) {
      indice = i;
      break;
    }
  }
  if (indice === -1) tokens.push(...faltan);
  else tokens.splice(indice, 0, ...faltan);
  return { valor: tokens.join(' '), anadidos: faltan };
}

const MOTIVO_PROXY =
  'Está en modo proxy (nube naranja): se cambiará a «Solo DNS», ya que el proxy de Cloudflare impide la conexión de los programas de correo.';

const MOTIVO_EMAIL_ROUTING =
  'Cloudflare Email Routing tiene bloqueado este registro. Desactive Email Routing en el panel de Cloudflare (Email → Email Routing → Settings) y vuelva a revisar los cambios.';

function esHostEmailRouting(host: string): boolean {
  return /(^|\.)mx\.cloudflare\.net$/.test(sinPunto(host));
}

/**
 * Calcula el plan para un conjunto de registros deseados frente a lo que ya
 * existe en la zona. Función pura: todo lo que decide está en sus argumentos.
 */
export function planificar(
  deseados: Deseado[],
  existentes: CfRegistro[],
  ctx: { apex: string; publicIp?: string },
): CambioInterno[] {
  const porNombre = new Map<string, CfRegistro[]>();
  for (const r of existentes) {
    const lista = porNombre.get(r.name) || [];
    lista.push(r);
    porNombre.set(r.name, lista);
  }
  return deseados.map((d) => planificarUno(d, porNombre.get(d.name) || [], ctx));
}

function planificarUno(
  d: Deseado,
  aqui: CfRegistro[],
  ctx: { apex: string; publicIp?: string },
): CambioInterno {
  const base = {
    type: d.type,
    name: d.name,
    content: d.content,
    ...(d.priority !== undefined && d.type === 'MX' ? { priority: d.priority } : {}),
    required: d.required,
  };
  const crear = (reason = 'No existe en la zona.'): CambioInterno => ({
    ...base,
    action: 'create',
    reason,
    operaciones: { ...vacias(), posts: [cuerpoRegistro(d)] },
    reemplazo: null,
  });
  const conservar = (reason: string, actual?: CfRegistro[]): CambioInterno => ({
    ...base,
    action: 'keep',
    reason,
    ...(actual?.length ? { current: actual.map(describir).join(' · ') } : {}),
    operaciones: null,
    reemplazo: null,
  });
  const enConflicto = (reason: string, actual: CfRegistro[], reemplazo: Operaciones | null): CambioInterno => ({
    ...base,
    action: 'conflict',
    reason,
    current: actual.map(describir).join(' · '),
    operaciones: null,
    // Un registro bloqueado por Cloudflare no se puede reemplazar por la API.
    reemplazo: actual.some((r) => r.bloqueado) ? null : reemplazo,
  });
  const borrarYCrear = (aBorrar: CfRegistro[]): Operaciones => ({
    ...vacias(),
    deletes: aBorrar.map((r) => r.id),
    posts: [cuerpoRegistro(d)],
  });

  // Un CNAME no admite otros registros con su mismo nombre (salvo en el
  // vértice, donde Cloudflare lo aplana). Aplica a todo lo que no es CNAME.
  const cnames = aqui.filter((r) => r.type === 'CNAME');
  const cnameEstorba = d.type !== 'CNAME' && d.name !== ctx.apex && cnames.length > 0;

  switch (d.type) {
    case 'CNAME': {
      const otros = aqui.filter((r) => r.type !== 'CNAME');
      const propio = cnames.find((r) => sinPunto(r.content) === d.content);
      if (propio && cnames.length === 1 && otros.length === 0) {
        if (!propio.proxied) return conservar('Ya existe con el valor correcto.', [propio]);
        if (propio.bloqueado) return enConflicto(MOTIVO_EMAIL_ROUTING, [propio], null);
        return {
          ...base,
          action: 'update',
          reason: MOTIVO_PROXY,
          current: describir(propio),
          operaciones: { ...vacias(), patches: [{ id: propio.id, proxied: false }] },
          reemplazo: null,
        };
      }
      if (aqui.length === 0) return crear();
      // Un A que ya apunta a la IP del servidor equivale al CNAME.
      const aIp = otros.filter((r) => r.type === 'A');
      if (
        ctx.publicIp &&
        cnames.length === 0 &&
        aIp.length > 0 &&
        aIp.length === otros.length &&
        aIp.every((r) => r.content.trim() === ctx.publicIp && !r.proxied)
      ) {
        return conservar('Existe un registro A que apunta a la IP del servidor; es equivalente.', aIp);
      }
      const reason =
        cnames.length > 0
          ? `Ya existe un CNAME que apunta a ${cnames.map((r) => sinPunto(r.content)).join(', ')}.`
          : 'Ya existen otros registros con este nombre y un CNAME no puede convivir con ellos.';
      return enConflicto(reason, aqui, borrarYCrear(aqui));
    }

    case 'MX': {
      const mx = aqui.filter((r) => r.type === 'MX');
      const propio = mx.find((r) => sinPunto(r.content) === d.content);
      const ajenos = mx.filter((r) => r !== propio);
      if (ajenos.length === 0) {
        if (propio) return conservar('Ya existe con el valor correcto.', [propio]);
        if (cnameEstorba) {
          return enConflicto(
            'Existe un CNAME con este nombre; impide publicar el MX.',
            cnames,
            borrarYCrear(cnames),
          );
        }
        return crear();
      }
      const hosts = ajenos.map((r) => sinPunto(r.content)).join(', ');
      const routing = ajenos.some((r) => esHostEmailRouting(r.content));
      let reason = `El dominio recibe hoy el correo en ${hosts}. Si se reemplazan estos MX, el correo dejará de llegar a ese proveedor.`;
      if (routing) {
        reason +=
          ' Pertenecen a Cloudflare Email Routing: desactívelo en el panel de Cloudflare (Email → Email Routing → Settings) antes de aplicar.';
      }
      return enConflicto(reason, ajenos, {
        ...vacias(),
        deletes: ajenos.map((r) => r.id),
        posts: propio ? [] : [cuerpoRegistro(d)],
      });
    }

    case 'TXT': {
      const txts = aqui.filter((r) => r.type === 'TXT');
      const valor = d.content.toLowerCase();

      if (valor.startsWith('v=spf1')) {
        const spfs = txts.filter((r) => txtDe(r).toLowerCase().startsWith('v=spf1'));
        if (spfs.length === 0) {
          if (cnameEstorba) {
            return enConflicto('Existe un CNAME con este nombre; impide publicar el SPF.', cnames, borrarYCrear(cnames));
          }
          return crear();
        }
        if (spfs.length > 1) {
          // Nunca se corrige solo: decidir qué mecanismos sobran es del titular.
          return enConflicto(
            `Hay ${spfs.length} registros SPF con este nombre y solo puede existir uno: los servidores receptores los invalidan todos. Combínelos manualmente en un único registro v=spf1 que incluya «mx».`,
            spfs,
            null,
          );
        }
        const actual = spfs[0]!;
        const fusion = fusionarSpf(txtDe(actual), d.content);
        if (!fusion) {
          return conservar('El SPF actual ya autoriza a los servidores de correo del dominio.', [actual]);
        }
        if (actual.bloqueado) return enConflicto(MOTIVO_EMAIL_ROUTING, [actual], null);
        return {
          ...base,
          content: fusion.valor,
          action: 'update',
          reason: `Se añadirá «${fusion.anadidos.join(' ')}» al SPF existente, conservando sus demás mecanismos y su política final.`,
          current: txtDe(actual),
          // Solo cambia el contenido: el TTL y el comentario son del titular.
          operaciones: { ...vacias(), patches: [{ id: actual.id, content: trocearTxt(fusion.valor) }] },
          reemplazo: null,
        };
      }

      if (valor.startsWith('v=dmarc1')) {
        const dmarcs = txts.filter((r) => txtDe(r).toLowerCase().startsWith('v=dmarc1'));
        if (dmarcs.length > 0) {
          const politica = txtDe(dmarcs[0]!).match(/p=(\w+)/i)?.[1]?.toLowerCase();
          return conservar(
            `Ya existe una política DMARC${politica ? ` (p=${politica})` : ''}; se conserva para no alterar la política del dominio.`,
            dmarcs,
          );
        }
        if (cnames.length > 0) {
          return conservar(
            `El DMARC está delegado mediante un CNAME a ${sinPunto(cnames[0]!.content)}; se conserva.`,
            cnames,
          );
        }
        return crear();
      }

      if (d.name.includes('._domainkey.')) {
        const clave = clavePublicaDkim(d.content);
        const mismo = txts.find((r) => clavePublicaDkim(txtDe(r)) === clave);
        if (mismo) return conservar('Ya existe con la clave correcta.', [mismo]);
        if (cnameEstorba) {
          return enConflicto('Existe un CNAME con este nombre; impide publicar la clave DKIM.', cnames, borrarYCrear(cnames));
        }
        if (txts.length === 0) return crear();
        if (txts.length === 1 && esMailway(txts[0]!)) {
          return {
            ...base,
            action: 'update',
            reason: 'La clave DKIM ha cambiado en el servidor de correo; se actualizará el registro creado por Mailway.',
            current: describir(txts[0]!),
            operaciones: { ...vacias(), puts: [{ id: txts[0]!.id, ...cuerpoRegistro(d) }] },
            reemplazo: null,
          };
        }
        return enConflicto('Ya existe otra clave DKIM con este selector.', txts, borrarYCrear(txts));
      }

      // Otros TXT (MTA-STS, TLS-RPT…): se comparan con los de su mismo tipo.
      const prefijo = valor.match(/^v=[a-z0-9]+/)?.[0];
      const mismos = prefijo ? txts.filter((r) => txtDe(r).toLowerCase().startsWith(prefijo)) : [];
      const normal = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
      if (mismos.some((r) => normal(txtDe(r)) === normal(d.content))) {
        return conservar('Ya existe con el valor correcto.', mismos);
      }
      if (cnameEstorba) {
        return enConflicto('Existe un CNAME con este nombre; impide publicar el registro.', cnames, borrarYCrear(cnames));
      }
      if (mismos.length === 0) return crear();
      if (mismos.length === 1 && esMailway(mismos[0]!)) {
        return {
          ...base,
          action: 'update',
          reason: 'El valor ha cambiado en el servidor de correo; se actualizará el registro creado por Mailway.',
          current: describir(mismos[0]!),
          operaciones: { ...vacias(), puts: [{ id: mismos[0]!.id, ...cuerpoRegistro(d) }] },
          reemplazo: null,
        };
      }
      return enConflicto('Ya existe un registro del mismo tipo con otro valor.', mismos, borrarYCrear(mismos));
    }

    case 'SRV': {
      const srvs = aqui.filter((r) => r.type === 'SRV');
      const igual = srvs.find((r) => mismoSrv(r, d));
      if (igual) return conservar('Ya existe con el valor correcto.', [igual]);
      if (cnameEstorba) {
        return enConflicto('Existe un CNAME con este nombre; impide publicar el SRV.', cnames, borrarYCrear(cnames));
      }
      if (srvs.length === 0) return crear();
      if (srvs.every(esMailway)) {
        return {
          ...base,
          action: 'update',
          reason: 'El servidor o el puerto han cambiado; se actualizará el registro creado por Mailway.',
          current: srvs.map(describir).join(' · '),
          operaciones: {
            ...vacias(),
            deletes: srvs.slice(1).map((r) => r.id),
            puts: [{ id: srvs[0]!.id, ...cuerpoRegistro(d) }],
          },
          reemplazo: null,
        };
      }
      return enConflicto('Ya existe un registro SRV que apunta a otro servidor.', srvs, borrarYCrear(srvs));
    }

    case 'A':
    case 'AAAA': {
      const mismos = aqui.filter((r) => r.type === d.type);
      if (cnames.length > 0) {
        return enConflicto(
          `Existe un CNAME con este nombre (apunta a ${sinPunto(cnames[0]!.content)}); impide publicar el registro ${d.type}.`,
          cnames,
          borrarYCrear(cnames),
        );
      }
      const propio = mismos.find((r) => r.content.trim() === d.content);
      if (propio && mismos.length === 1) {
        if (!propio.proxied) return conservar('Ya existe con el valor correcto.', [propio]);
        if (d.proxyTolerado) {
          return conservar(
            'Ya existe; el proxy de Cloudflare está activo, lo que es compatible con el acceso web.',
            [propio],
          );
        }
        return {
          ...base,
          action: 'update',
          reason: MOTIVO_PROXY,
          current: describir(propio),
          operaciones: { ...vacias(), patches: [{ id: propio.id, proxied: false }] },
          reemplazo: null,
        };
      }
      if (mismos.length === 0) return crear();
      return enConflicto(
        `Ya existe un registro ${d.type} que apunta a ${mismos.map((r) => r.content).join(', ')}.`,
        mismos,
        borrarYCrear(mismos),
      );
    }

    default:
      return conservar('Tipo de registro no gestionado por Mailway.');
  }
}

export function resumenDe(cambios: CambioPlan[]): Record<AccionPlan, number> {
  const out: Record<AccionPlan, number> = { create: 0, update: 0, keep: 0, conflict: 0 };
  for (const c of cambios) out[c.action] += 1;
  return out;
}

/** Quita las operaciones internas antes de devolver el plan por la API. */
function publico(c: CambioInterno & { zone?: string }): CambioPlan & { zone?: string } {
  const { operaciones: _o, reemplazo: _r, ...resto } = c;
  return resto;
}

/* --------------------------------- Aplicar -------------------------------- */

export interface ResultadoAplicacion {
  applied: { action: string; type: string; name: string }[];
  errors: { type: string; name: string; error: string }[];
  /** Conflictos que no se han tocado (falta confirmar el reemplazo o no es posible). */
  skipped: { type: string; name: string; reason: string }[];
}

/** Errores que afectan a todo el token o a la conexión: no tiene sentido reintentar uno a uno. */
const ERRORES_GLOBALES = new Set([
  'cloudflare_token_invalid',
  'cloudflare_token_malformed',
  'cloudflare_token_unreadable',
  'cloudflare_forbidden',
  'cloudflare_rate_limited',
  'cloudflare_timeout',
  'cloudflare_unreachable',
  'cloudflare_batch_too_large',
]);

/** Une las operaciones de varios cambios en un único lote. */
export function construirLote(grupos: Operaciones[]): CfLote {
  const deletes = new Set<string>();
  const lote: Required<CfLote> = { deletes: [], patches: [], puts: [], posts: [] };
  for (const g of grupos) {
    for (const id of g.deletes) {
      // Dos cambios pueden pedir borrar el mismo CNAME que les estorba.
      if (!deletes.has(id)) {
        deletes.add(id);
        lote.deletes.push({ id });
      }
    }
    lote.patches.push(...g.patches);
    lote.puts.push(...g.puts);
    lote.posts.push(...g.posts);
  }
  return lote;
}

/**
 * Aplica un plan en un único lote. Si Cloudflare rechaza el lote por un
 * registro concreto (validación, un registro que ya existe, Email Routing…),
 * se aplican los cambios uno a uno para que los correctos no se pierdan por
 * uno erróneo, y el error se atribuye a su registro.
 */
export async function ejecutarPlan(
  cliente: CloudflareClient,
  zoneId: string,
  cambios: CambioInterno[],
  opts: { replaceConflicts: boolean },
): Promise<ResultadoAplicacion> {
  const skipped: ResultadoAplicacion['skipped'] = [];
  const aplicar: { cambio: CambioInterno; accion: string; ops: Operaciones }[] = [];
  for (const cambio of cambios) {
    if ((cambio.action === 'create' || cambio.action === 'update') && cambio.operaciones) {
      aplicar.push({ cambio, accion: cambio.action, ops: cambio.operaciones });
    } else if (cambio.action === 'conflict') {
      if (opts.replaceConflicts && cambio.reemplazo) {
        aplicar.push({ cambio, accion: 'replace', ops: cambio.reemplazo });
      } else {
        skipped.push({
          type: cambio.type,
          name: cambio.name,
          reason: cambio.reemplazo
            ? 'Conflicto sin confirmar: no se ha modificado.'
            : `No se puede reemplazar automáticamente. ${cambio.reason}`,
        });
      }
    }
  }
  if (aplicar.length === 0) return { applied: [], errors: [], skipped };

  const aplicados = () => aplicar.map((a) => ({ action: a.accion, type: a.cambio.type, name: a.cambio.name }));
  try {
    await cliente.batch(zoneId, construirLote(aplicar.map((a) => a.ops)));
    return { applied: aplicados(), errors: [], skipped };
  } catch (err) {
    if (!(err instanceof CloudflareError) || ERRORES_GLOBALES.has(err.code)) throw err;
  }

  // Uno a uno, por fases (borrados, cambios, sustituciones, altas), igual que
  // el lote: así un CNAME que estorba se borra antes de crear lo nuevo.
  const fallidos = new Map<CambioInterno, string>();
  const intentar = async (a: (typeof aplicar)[number], paso: () => Promise<unknown>, esBorrado = false) => {
    if (fallidos.has(a.cambio)) return;
    try {
      await paso();
    } catch (err) {
      // «Ya existe idéntico» es el resultado buscado; borrar algo que ya no
      // existe, también.
      if (err instanceof CloudflareError && err.idempotente) return;
      if (esBorrado && err instanceof CloudflareError && err.code === 'cloudflare_not_found') return;
      if (err instanceof CloudflareError && ERRORES_GLOBALES.has(err.code)) throw err;
      fallidos.set(a.cambio, mensajeDe(err));
    }
  };
  const borrados = new Set<string>();
  for (const a of aplicar) {
    for (const id of a.ops.deletes) {
      if (borrados.has(id)) continue;
      borrados.add(id);
      await intentar(a, () => cliente.deleteRecord(zoneId, id), true);
    }
  }
  for (const a of aplicar) {
    for (const { id, ...cambios } of a.ops.patches) await intentar(a, () => cliente.patchRecord(zoneId, id, cambios));
  }
  for (const a of aplicar) {
    for (const { id, ...registro } of a.ops.puts) await intentar(a, () => cliente.updateRecord(zoneId, id, registro));
  }
  for (const a of aplicar) {
    for (const registro of a.ops.posts) await intentar(a, () => cliente.createRecord(zoneId, registro));
  }

  return {
    applied: aplicar
      .filter((a) => !fallidos.has(a.cambio))
      .map((a) => ({ action: a.accion, type: a.cambio.type, name: a.cambio.name })),
    errors: aplicar
      .filter((a) => fallidos.has(a.cambio))
      .map((a) => ({ type: a.cambio.type, name: a.cambio.name, error: fallidos.get(a.cambio)! })),
    skipped,
  };
}

/** Registros existentes en la zona para los nombres deseados (una consulta por nombre). */
async function existentesPara(cliente: CloudflareClient, zoneId: string, nombres: string[]): Promise<CfRegistro[]> {
  const unicos = [...new Set(nombres)];
  const out: CfRegistro[] = [];
  // De cuatro en cuatro: rápido sin acercarse al límite de peticiones.
  for (let i = 0; i < unicos.length; i += 4) {
    const lotes = await Promise.all(unicos.slice(i, i + 4).map((name) => cliente.listRecords(zoneId, { name })));
    for (const lista of lotes) out.push(...lista);
  }
  return out;
}

/* ------------------------- Plan de un dominio de correo ------------------- */

interface ZonaPublica {
  id: string;
  name: string;
  status: string;
  nameServers: string[];
}

function zonaPublica(z: CfZona): ZonaPublica {
  return { id: z.id, name: z.name, status: z.status, nameServers: z.nameServers };
}

interface PlanDominio {
  available: boolean;
  reason?: string;
  account?: { id: string; label: string };
  zone?: ZonaPublica;
  changes: CambioInterno[];
  resolucion: Resolucion | null;
}

/** Registros que Mailway quiere en Cloudflare para un dominio de correo. */
async function deseadosDeDominio(domain: string, includeRecommended: boolean): Promise<Deseado[]> {
  const records = await getEngine().getDnsRecords(domain);
  const seleccion = filtrarPorNivel(
    seleccionarRegistros(domain, records),
    includeRecommended ? 'recomendados' : 'obligatorios',
  );
  return seleccion.map(deseadoDe).filter((d): d is Deseado => d !== null);
}

async function planDeDominio(
  domain: DomainRecord,
  user: AuthedUser,
  includeRecommended: boolean,
): Promise<PlanDominio> {
  const { resolucion, motivo } = await resolverZona(domain.domain, {
    clientId: domain.clientId,
    storedAccountId: domain.cloudflare?.accountId ?? null,
    permitirInstancia: user.role === 'admin',
  });
  if (!resolucion) {
    return { available: false, reason: motivo, changes: [], resolucion: null };
  }
  // Una cuenta del propio cliente se asocia ya al consultar. Una de la
  // instancia, solo cuando el administrador aplica: si bastara con que él
  // abriera la ficha, el cliente podría usar la cuenta del administrador
  // sobre un dominio que este nunca ha decidido gestionar.
  if (resolucion.cuenta.client_id !== null) guardarAsociacion(domain.id, resolucion);
  const deseados = await deseadosDeDominio(domain.domain, includeRecommended);
  const existentes = await existentesPara(
    resolucion.cliente,
    resolucion.zona.id,
    deseados.map((d) => d.name),
  );
  const { publicIp } = getInstanceSettings();
  const changes = planificar(deseados, existentes, { apex: domain.domain, publicIp });
  return {
    available: true,
    account: { id: resolucion.cuenta.id, label: resolucion.cuenta.label },
    zone: zonaPublica(resolucion.zona),
    changes,
    resolucion,
  };
}

function guardarAsociacion(domainId: string, r: Resolucion): void {
  db.prepare('UPDATE domains SET cloudflare_account_id = ?, cloudflare_zone_id = ? WHERE id = ?').run(
    r.cuenta.id,
    r.zona.id,
    domainId,
  );
}

export interface ResultadoDominio extends ResultadoAplicacion {
  domain: DomainRecord;
  zone: ZonaPublica;
}

/**
 * Aplica el DNS de correo de un dominio en Cloudflare. Devuelve null si
 * ninguna cuenta accesible contiene la zona (el alta con «autoDns» lo usa así).
 */
export async function aplicarDnsDominio(
  domainId: string,
  user: AuthedUser,
  opts: { replaceConflicts: boolean; includeRecommended: boolean },
): Promise<ResultadoDominio | { unavailable: string }> {
  const domain = getDomain(domainId);
  const plan = await planDeDominio(domain, user, opts.includeRecommended);
  if (!plan.available || !plan.resolucion) return { unavailable: plan.reason || '' };
  const r = plan.resolucion;
  const resultado = await ejecutarPlan(r.cliente, r.zona.id, plan.changes, {
    replaceConflicts: opts.replaceConflicts,
  });
  guardarAsociacion(domainId, r);
  if (resultado.applied.length > 0) {
    db.prepare('UPDATE domains SET dns_applied_at = ? WHERE id = ?').run(now(), domainId);
  }
  // La verificación no debe tapar el resultado: si el motor no responde, el
  // DNS ya está aplicado y se medirá en la siguiente vuelta del vigilante.
  const fresco = await refreshDomainDns(domainId).catch(() => getDomain(domainId));
  return { ...resultado, domain: fresco, zone: zonaPublica(r.zona) };
}

/* ---------------------- DNS de la plataforma (instancia) ------------------ */

function hostDe(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Registros de la propia plataforma: el nombre del servidor de correo, el
 * webmail y el panel apuntan a la IP pública; autoconfig/autodiscover del
 * dominio base apuntan al servidor. Thunderbird, cuando no encuentra
 * autoconfiguración en el dominio del usuario, la busca en
 * autoconfig.<dominio del MX>: con estos dos CNAME todos los dominios de los
 * clientes (cuyo MX es este servidor) se autoconfiguran sin DNS propio.
 */
export function deseadosDeInstancia(): { deseados: Deseado[]; motivo: string } {
  const inst = getInstanceSettings();
  const mail = sinPunto(inst.mailHostname || '');
  const ip = (inst.publicIp || '').trim();
  if (!mail || !ip) {
    return {
      deseados: [],
      motivo: 'Configure en Ajustes el nombre del servidor de correo y la IP pública antes de aplicar el DNS de la plataforma.',
    };
  }
  const deseados: Deseado[] = [{ type: 'A', name: mail, content: ip, required: true }];
  const nombres = new Set([mail]);
  for (const host of [hostDe(inst.webmailUrl), hostDe(inst.panelUrl)]) {
    if (!host || nombres.has(host) || /^[\d.]+$/.test(host) || host === 'localhost') continue;
    nombres.add(host);
    deseados.push({ type: 'A', name: host, content: ip, required: false, proxyTolerado: true });
  }
  const base = mail.split('.').slice(1).join('.');
  if (base.includes('.')) {
    for (const prefijo of ['autoconfig', 'autodiscover']) {
      const name = `${prefijo}.${base}`;
      if (nombres.has(name)) continue;
      nombres.add(name);
      deseados.push({ type: 'CNAME', name, content: mail, required: false });
    }
  }
  return { deseados, motivo: '' };
}

interface GrupoInstancia {
  resolucion: Resolucion;
  cambios: (CambioInterno & { zone: string })[];
}

async function planDeInstancia(): Promise<{
  available: boolean;
  reason?: string;
  account?: { id: string; label: string };
  grupos: GrupoInstancia[];
  sinZona: string[];
}> {
  const { deseados, motivo } = deseadosDeInstancia();
  if (deseados.length === 0) return { available: false, reason: motivo, grupos: [], sinZona: [] };
  if (cuentasDeInstancia().length === 0) {
    return {
      available: false,
      reason: 'No hay ninguna cuenta de Cloudflare de la instancia conectada. Conecte una con el ámbito «Toda la instancia».',
      grupos: [],
      sinZona: [],
    };
  }
  const grupos = new Map<string, { resolucion: Resolucion; deseados: Deseado[] }>();
  const sinZona: string[] = [];
  let ultimoMotivo = '';
  for (const d of deseados) {
    // Si ya se conoce una zona que contiene el nombre, no se vuelve a buscar.
    const conocida = [...grupos.values()].find(
      (g) => d.name === g.resolucion.zona.name || d.name.endsWith(`.${g.resolucion.zona.name}`),
    );
    if (conocida) {
      conocida.deseados.push(d);
      continue;
    }
    const { resolucion, motivo: m } = await resolverZona(d.name, { clientId: null, permitirInstancia: true });
    if (!resolucion) {
      sinZona.push(d.name);
      ultimoMotivo = m;
      continue;
    }
    const clave = `${resolucion.cuenta.id}|${resolucion.zona.id}`;
    const grupo = grupos.get(clave) || { resolucion, deseados: [] };
    grupo.deseados.push(d);
    grupos.set(clave, grupo);
  }
  if (grupos.size === 0) return { available: false, reason: ultimoMotivo, grupos: [], sinZona };

  const { publicIp } = getInstanceSettings();
  const out: GrupoInstancia[] = [];
  for (const g of grupos.values()) {
    const existentes = await existentesPara(
      g.resolucion.cliente,
      g.resolucion.zona.id,
      g.deseados.map((d) => d.name),
    );
    const cambios = planificar(g.deseados, existentes, { apex: g.resolucion.zona.name, publicIp }).map((c) => ({
      ...c,
      zone: g.resolucion.zona.name,
    }));
    out.push({ resolucion: g.resolucion, cambios });
  }
  const primera = out[0]!.resolucion.cuenta;
  return { available: true, account: { id: primera.id, label: primera.label }, grupos: out, sinZona };
}

/* ---------------------------------- Rutas --------------------------------- */

const tokenSchema = z
  .string({ required_error: 'Introduzca el token de Cloudflare.' })
  .trim()
  .min(20, 'El token de Cloudflare no parece completo.')
  .max(400, 'El token de Cloudflare es demasiado largo.')
  .refine((t) => !/\s/.test(t), 'El token no puede contener espacios.');

const booleano = (campo: string) =>
  z.boolean({ invalid_type_error: `El campo «${campo}» debe ser verdadero o falso.` }).optional();

const aplicarSchema = z
  .object({
    replaceConflicts: booleano('replaceConflicts'),
    includeRecommended: booleano('includeRecommended'),
  })
  .nullish();

const reemplazoSchema = z.object({ replaceConflicts: booleano('replaceConflicts') }).nullish();

export function registerCloudflareRoutes(app: FastifyInstance): void {
  /** Cuentas conectadas. El administrador ve todas; un cliente, las suyas. */
  app.get('/api/cloudflare/accounts', async (req) => {
    const user = requireAuth(req);
    const { clientId, refresh } = req.query as { clientId?: string; refresh?: string };
    const filas = cuentasVisibles(user, user.role === 'admin' ? clientId : undefined);
    const accounts = await Promise.all(
      filas.map(async (fila) => {
        const cache = await zonasDeCuenta(fila, refresh === '1');
        return toCuenta(cuentaRow(fila.id) || fila, cache);
      }),
    );
    return { accounts };
  });

  app.post('/api/cloudflare/accounts', async (req) => {
    const user = requireAuth(req);
    const body = z
      .object({
        token: tokenSchema,
        label: z.string().trim().max(80, 'El nombre no puede superar 80 caracteres.').optional(),
        clientId: z.string().trim().min(1, 'Seleccione un cliente.').nullable().optional(),
      })
      .parse(req.body);

    let clientId: string | null;
    if (user.role === 'admin') {
      clientId = body.clientId || null;
      if (clientId) getClient(clientId);
    } else {
      if (!user.clientId) throw forbidden();
      if (body.clientId && body.clientId !== user.clientId) {
        throw forbidden('Solo puede conectar cuentas de Cloudflare para su propia organización.');
      }
      clientId = user.clientId;
    }

    // Mismo token dos veces en el mismo ámbito: se avisa en vez de duplicar.
    const mismas = clientId ? cuentasDeCliente(clientId) : cuentasDeInstancia();
    const duplicado = mismas.some((fila) => {
      try {
        return decryptSecret(fila.token_enc) === body.token;
      } catch {
        return false;
      }
    });
    if (duplicado) throw conflict('Este token ya está conectado.', 'cloudflare_duplicate');

    const cliente = new CloudflareClient(body.token);
    await cliente.verifyToken();
    const zonas = await cliente.listZones();
    if (zonas.length === 0) {
      throw badRequest(
        'El token es válido, pero no da acceso a ninguna zona. Asigne el permiso «Zone · Zone · Read» e incluya las zonas de sus dominios.',
        'cloudflare_no_zones',
      );
    }

    const id = randomId('cf');
    const label = body.label || zonas[0]!.accountName || 'Cloudflare';
    db.prepare(
      `INSERT INTO cloudflare_accounts (id, client_id, label, token_enc, token_hint, created_by,
         created_at, last_verified_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '')`,
    ).run(id, clientId, label, encryptSecret(body.token), pistaToken(body.token), user.id, now(), now());
    const nombres = zonas.map((z) => z.name).sort((a, b) => a.localeCompare(b));
    const cache: CacheZonas = { zones: nombres.slice(0, 500), total: nombres.length, at: now() };
    setJsonSetting(claveCache(id), cache);

    audit(req, 'cloudflare.account_connected', { id, label, clientId, zones: nombres.length });
    return { account: toCuenta(cuentaRow(id)!, cache) };
  });

  app.delete('/api/cloudflare/accounts/:id', async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    const fila = cuentaRow(id);
    if (!fila) throw notFound('Cuenta de Cloudflare no encontrada.');
    if (user.role !== 'admin') {
      // Se responde igual que si no existiera: no se revela qué cuentas hay.
      if (fila.client_id === null || fila.client_id !== user.clientId) {
        throw notFound('Cuenta de Cloudflare no encontrada.');
      }
    }
    db.prepare('DELETE FROM cloudflare_accounts WHERE id = ?').run(id);
    db.prepare('DELETE FROM settings WHERE key = ?').run(claveCache(id));
    audit(req, 'cloudflare.account_removed', { id, label: fila.label, clientId: fila.client_id });
    return { ok: true };
  });

  /** Plan de cambios del DNS de correo de un dominio (no modifica nada). */
  app.get('/api/domains/:id/cloudflare', async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    const domain = getDomain(id);
    requireClientAccess(req, domain.clientId);
    const { includeRecommended } = req.query as { includeRecommended?: string };
    const plan = await planDeDominio(domain, user, includeRecommended !== 'false');
    const changes = plan.changes.map(publico);
    return {
      available: plan.available,
      ...(plan.reason ? { reason: plan.reason } : {}),
      ...(plan.account ? { account: plan.account } : {}),
      ...(plan.zone ? { zone: plan.zone } : {}),
      changes,
      summary: resumenDe(changes),
    };
  });

  app.post('/api/domains/:id/cloudflare/apply', async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    const domain = getDomain(id);
    requireClientAccess(req, domain.clientId);
    const body = aplicarSchema.parse(req.body) || {};
    const resultado = await aplicarDnsDominio(id, user, {
      replaceConflicts: body.replaceConflicts === true,
      includeRecommended: body.includeRecommended !== false,
    });
    if ('unavailable' in resultado) throw badRequest(resultado.unavailable, 'cloudflare_unavailable');
    audit(req, 'cloudflare.dns_applied', {
      domainId: id,
      domain: domain.domain,
      zone: resultado.zone.name,
      applied: resultado.applied.length,
      errors: resultado.errors.length,
      replaceConflicts: body.replaceConflicts === true,
    }, domain.clientId);
    return { applied: resultado.applied, errors: resultado.errors, skipped: resultado.skipped, domain: resultado.domain };
  });

  /** Marca blanca: apunta el dominio propio del cliente a este servidor. */
  app.post('/api/whitelabel/domains/:id/cloudflare', async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    const destino = getClientDomain(id);
    requireClientAccess(req, destino.clientId);
    const body = reemplazoSchema.parse(req.body) || {};

    const inst = getInstanceSettings();
    const mail = sinPunto(inst.mailHostname || '');
    const host = sinPunto(destino.hostname);
    let deseado: Deseado;
    if (mail && mail !== host) {
      // El CNAME es preferible: si cambia la IP del servidor, no hay que tocar nada.
      deseado = { type: 'CNAME', name: host, content: mail, required: true };
    } else if (inst.publicIp) {
      deseado = { type: 'A', name: host, content: inst.publicIp.trim(), required: true, proxyTolerado: false };
    } else {
      throw badRequest(
        'Configure en Ajustes el nombre del servidor de correo o la IP pública antes de configurar el DNS.',
        'instance_incomplete',
      );
    }

    const { resolucion, motivo } = await resolverZona(host, {
      clientId: destino.clientId,
      permitirInstancia: user.role === 'admin',
    });
    if (!resolucion) throw badRequest(motivo, 'cloudflare_unavailable');
    const existentes = await existentesPara(resolucion.cliente, resolucion.zona.id, [host]);
    const cambios = planificar([deseado], existentes, {
      apex: resolucion.zona.name,
      publicIp: inst.publicIp || undefined,
    });
    const resultado = await ejecutarPlan(resolucion.cliente, resolucion.zona.id, cambios, {
      replaceConflicts: body.replaceConflicts === true,
    });
    const domain: ClientDomain = await refreshClientDomain(id).catch(() => getClientDomain(id));
    audit(req, 'cloudflare.dns_applied', {
      whitelabelDomainId: id,
      hostname: host,
      zone: resolucion.zona.name,
      applied: resultado.applied.length,
      errors: resultado.errors.length,
    }, domain.clientId);
    return { ...resultado, domain };
  });

  /** DNS de la plataforma: vista previa (solo administrador). */
  app.get('/api/cloudflare/instance-dns', async (req) => {
    requireAdmin(req);
    const plan = await planDeInstancia();
    const changes = plan.grupos.flatMap((g) => g.cambios.map(publico));
    return {
      available: plan.available,
      ...(plan.reason ? { reason: plan.reason } : {}),
      ...(plan.account ? { account: plan.account } : {}),
      zones: plan.grupos.map((g) => zonaPublica(g.resolucion.zona)),
      missing: plan.sinZona,
      changes,
      summary: resumenDe(changes),
    };
  });

  app.post('/api/cloudflare/instance-dns', async (req) => {
    requireAdmin(req);
    const body = reemplazoSchema.parse(req.body) || {};
    const plan = await planDeInstancia();
    if (!plan.available) throw badRequest(plan.reason || 'No es posible aplicar el DNS de la plataforma.', 'cloudflare_unavailable');
    const total: ResultadoAplicacion = { applied: [], errors: [], skipped: [] };
    for (const g of plan.grupos) {
      const r = await ejecutarPlan(g.resolucion.cliente, g.resolucion.zona.id, g.cambios, {
        replaceConflicts: body.replaceConflicts === true,
      });
      total.applied.push(...r.applied);
      total.errors.push(...r.errors);
      total.skipped.push(...r.skipped);
    }
    audit(req, 'cloudflare.dns_applied', {
      scope: 'instance',
      zones: plan.grupos.map((g) => g.resolucion.zona.name),
      applied: total.applied.length,
      errors: total.errors.length,
      replaceConflicts: body.replaceConflicts === true,
    });
    return { ...total, missing: plan.sinZona };
  });
}
