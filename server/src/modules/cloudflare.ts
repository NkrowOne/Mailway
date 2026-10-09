import crypto from 'node:crypto';
import { domainToUnicode } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
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
import { diagnosticoSpf, esDmarc, esSpf, politicaDmarc, type ContextoSpf } from '../core/mailauth';
import { getEngine } from '../engine';
import type { EngineDnsRecord } from '../engine/types';
import { audit } from './audit';
import { requireAdmin, requireAuth, requireClientAccess, type AuthedUser } from './auth';
import { getClient } from './clients';
import { instanceAutoconfigBase } from './connection';
import { getDomain, marcarPropiedadComprobada, refreshDomainDns, type DomainRecord } from './domains';
import { getInstanceSettings, getJsonSetting, setJsonSetting } from './settings';
import { getClientDomain, refreshClientDomain, type ClientDomain } from './whitelabel';
import { esObligatorio, exigirMxPublico, filtrarPorNivel, registrosDelDominio } from './zonefile';

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
      'No se ha podido descifrar el token de esta cuenta (la clave de Mailway ha cambiado). Elimina la cuenta y vuelve a conectarla.',
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
      'No se ha podido descifrar el token de esta cuenta (la clave de Mailway ha cambiado). Elimina la cuenta y vuelve a conectarla.',
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

/**
 * Cuentas que un usuario puede ver y usar. Con `soloCliente` (una integración
 * que actúa en nombre de un cliente con un token de administración), las de
 * la instancia no se listan: listar con `?refresh=1` ya usa su token, y sus
 * zonas son del operador, no del cliente.
 */
function cuentasVisibles(user: AuthedUser, clientId: string | undefined, soloCliente: boolean): CuentaRow[] {
  if (user.role === 'admin') {
    if (soloCliente) return clientId && clientId !== 'instancia' ? cuentasDeCliente(clientId) : [];
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
 * ¿Puede esta resolución usar la cuenta guardada en el dominio? Solo si es
 * del mismo cliente, o si es de la instancia y quien actúa puede usar las de
 * la instancia (el administrador sin `soloCliente`).
 */
function guardadaUtilizable(
  guardada: CuentaRow,
  opts: { clientId: string | null; permitirInstancia: boolean; permitirGuardadaDeInstancia?: boolean },
): boolean {
  if (guardada.client_id === null) return opts.permitirInstancia || opts.permitirGuardadaDeInstancia === true;
  return guardada.client_id === opts.clientId;
}

/**
 * Busca la cuenta cuyo token ve la zona de `hostname`: primero la guardada
 * en el dominio, luego las del cliente y, por último, las de la instancia.
 *
 * Las cuentas de la instancia solo se prueban a petición del administrador,
 * también cuando quedaron guardadas en el dominio porque el administrador
 * aplicó su DNS: el token del operador nunca se usa en una acción del
 * cliente. Si pudiera, le bastaría con dar de alta como dominio propio uno
 * que viva en la cuenta del administrador (o un subdominio suyo), esperar a
 * que el administrador aplicara su DNS una vez y, desde entonces, reescribir
 * esa zona cuando quisiera (con `replaceConflicts`, incluso su MX).
 */
export async function resolverZona(
  hostname: string,
  opts: {
    clientId: string | null;
    storedAccountId?: string | null;
    permitirInstancia: boolean;
    /**
     * Usar la cuenta guardada aunque sea de la instancia y quien actúa no
     * pueda usar las de la instancia. Solo el registro del webmail de marca
     * blanca (aplicarDnsMarcaBlanca): véase allí por qué es seguro.
     */
    permitirGuardadaDeInstancia?: boolean;
  },
): Promise<{ resolucion: Resolucion | null; motivo: string }> {
  const candidatas: CuentaRow[] = [];
  const guardada = opts.storedAccountId ? cuentaRow(opts.storedAccountId) : undefined;
  if (guardada && guardadaUtilizable(guardada, opts)) candidatas.push(guardada);
  // La cuenta del administrador asociada al dominio que no se ha podido usar:
  // el motivo lo explica, porque la ficha del dominio dice que el DNS se
  // aplicó con ella.
  const instanciaReservada = guardada?.client_id === null && !guardadaUtilizable(guardada, opts);
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

  const reservada =
    ' El DNS de este dominio lo configuró el administrador con la cuenta de Cloudflare de la instancia, que solo utiliza el administrador: para cambiarlo desde aquí, conecta una cuenta propia en Conexiones o solicita al administrador que vuelva a aplicarlo.';
  if (vistas.size === 0) {
    if (instanciaReservada) {
      return { resolucion: null, motivo: `No hay ninguna cuenta de Cloudflare propia conectada.${reservada}` };
    }
    const hayInstancia = !opts.permitirInstancia && cuentasDeInstancia().length > 0;
    return {
      resolucion: null,
      motivo: hayInstancia
        ? 'No hay ninguna cuenta de Cloudflare propia conectada. Las cuentas de la instancia solo las utiliza el administrador: conecta una cuenta en Conexiones o solicita al administrador que aplique el DNS.'
        : 'No hay ninguna cuenta de Cloudflare conectada. Conecta una en Conexiones para configurar el DNS automáticamente.',
    };
  }
  const detalle = errores.length > 0 ? ` Último error: ${errores[errores.length - 1]}` : '';
  return {
    resolucion: null,
    motivo: `Ninguna de las cuentas de Cloudflare conectadas contiene la zona de ${domainToUnicode(hostname) || hostname}. Comprueba que el dominio está en esa cuenta de Cloudflare y que el token incluye su zona.${detalle}${instanciaReservada ? reservada : ''}`,
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
  /**
   * Se publica con el proxy de Cloudflare (nube naranja). Solo el webmail de
   * marca blanca: protege su página de acceso, y el correo no pasa por él
   * (IMAP y SMTP van al nombre del servidor, siempre sin proxy).
   */
  proxied?: boolean;
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

/**
 * Comentario con el que ESTA instancia marca los registros que crea:
 * «Mailway» y una huella derivada de su secreto (no lo revela). Solo un
 * registro con exactamente este comentario cuenta como propio y se puede
 * actualizar (una clave DKIM nueva, un SRV que cambia de puerto). Uno de
 * otra instalación de Mailway que gestione la misma zona (pruebas, un
 * servidor anterior) o con un comentario que solo menciona «Mailway» es
 * ajeno: sale como conflicto y solo se sustituye con confirmación.
 */
export function comentarioPropio(): string {
  const huella = crypto.createHmac('sha256', config.secret).update('cloudflare:comentario').digest('hex').slice(0, 10);
  return `${COMENTARIO_MAILWAY} (instancia ${huella})`;
}

/** Cuerpo del registro para la API: sin proxy (salvo que se pida), TTL automático y marcado como de esta instancia. */
export function cuerpoRegistro(d: Deseado, comentario: string = comentarioPropio()): CfRegistroNuevo {
  const base = { type: d.type, name: d.name, ttl: 1, proxied: d.proxied === true, comment: comentario };
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

/** ¿Lo creó esta instancia? Comparación exacta con su comentario, nunca «contiene Mailway». */
function esPropio(r: CfRegistro, comentario: string): boolean {
  return (r.comment || '').trim() === comentario;
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
 * antes del primer «all», sin tocar el resto: los include de otros servicios
 * y el calificador final (~all, -all) son decisiones del titular. Usa la
 * misma lectura que la comprobación DNS (diagnosticoSpf): un «mx» escrito
 * detrás de «all» no cuenta, porque ningún receptor llega a leerlo.
 * Devuelve null si no falta nada.
 */
export function fusionarSpf(
  actual: string,
  deseado: string,
  ctx: ContextoSpf = {},
): { valor: string; anadidos: string[] } | null {
  const { faltan } = diagnosticoSpf(actual, deseado, ctx);
  if (faltan.length === 0) return null;
  const tokens = actual.trim().split(/\s+/);
  const indice = tokens.findIndex((t, i) => i > 0 && /^[-~?+]?all$/i.test(t));
  if (indice === -1) tokens.push(...faltan);
  else tokens.splice(indice, 0, ...faltan);
  return { valor: tokens.join(' '), anadidos: faltan };
}

const MOTIVO_PROXY =
  'Está en modo proxy (nube naranja): se cambiará a «Solo DNS», ya que el proxy de Cloudflare impide la conexión de los programas de correo.';

const MOTIVO_PROXY_ACTIVAR =
  'Está en «Solo DNS» (nube gris): se activará el proxy de Cloudflare para proteger la página de acceso del webmail.';

const MOTIVO_EMAIL_ROUTING =
  'Cloudflare Email Routing tiene bloqueado este registro. Desactiva Email Routing en el panel de Cloudflare (Email → Email Routing → Settings) y vuelve a revisar los cambios.';

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
  ctx: ContextoPlan,
): CambioInterno[] {
  const porNombre = new Map<string, CfRegistro[]>();
  for (const r of existentes) {
    const lista = porNombre.get(r.name) || [];
    lista.push(r);
    porNombre.set(r.name, lista);
  }
  return deseados.map((d) => planificarUno(d, porNombre.get(d.name) || [], ctx));
}

/**
 * Contexto del plan: el vértice de la zona, la IP pública y el comentario con
 * el que esta instancia marca sus registros (por defecto, `comentarioPropio`).
 */
export interface ContextoPlan {
  apex: string;
  publicIp?: string;
  comentario?: string;
}

function planificarUno(d: Deseado, aqui: CfRegistro[], ctx: ContextoPlan): CambioInterno {
  const comentario = ctx.comentario ?? comentarioPropio();
  const esMailway = (r: CfRegistro) => esPropio(r, comentario);
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
    operaciones: { ...vacias(), posts: [cuerpoRegistro(d, comentario)] },
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
    posts: [cuerpoRegistro(d, comentario)],
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
        if (d.proxied) {
          if (propio.proxied) return conservar('Ya existe con el valor correcto y el proxy de Cloudflare activo.', [propio]);
          if (propio.bloqueado) return enConflicto(MOTIVO_EMAIL_ROUTING, [propio], null);
          return {
            ...base,
            action: 'update',
            reason: MOTIVO_PROXY_ACTIVAR,
            current: describir(propio),
            operaciones: { ...vacias(), patches: [{ id: propio.id, proxied: true }] },
            reemplazo: null,
          };
        }
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
      const aEquivalentes =
        ctx.publicIp &&
        cnames.length === 0 &&
        aIp.length > 0 &&
        aIp.length === otros.length &&
        aIp.every((r) => r.content.trim() === ctx.publicIp);
      if (aEquivalentes && d.proxied) {
        const sinProxy = aIp.filter((r) => !r.proxied);
        if (sinProxy.length === 0) {
          return conservar('Existe un registro A que apunta a la IP del servidor con el proxy activo; es equivalente.', aIp);
        }
        if (sinProxy.some((r) => r.bloqueado)) return enConflicto(MOTIVO_EMAIL_ROUTING, sinProxy, null);
        return {
          ...base,
          action: 'update',
          reason: MOTIVO_PROXY_ACTIVAR,
          current: aIp.map(describir).join(' · '),
          operaciones: { ...vacias(), patches: sinProxy.map((r) => ({ id: r.id, proxied: true })) },
          reemplazo: null,
        };
      }
      if (aEquivalentes && aIp.every((r) => !r.proxied)) {
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
      const propios = mx.filter((r) => sinPunto(r.content) === d.content);
      const propio = propios[0];
      const ajenos = mx.filter((r) => sinPunto(r.content) !== d.content);
      // Mismo criterio que la comprobación DNS (veredictoMx): un MX ajeno con
      // prioridad menor o igual que la nuestra se queda con parte del correo;
      // uno con prioridad mayor es un respaldo y no impide recibir aquí.
      const mejorPropia = propios.length > 0 ? Math.min(...propios.map((r) => r.priority ?? 0)) : null;
      const porDelante = mejorPropia === null ? ajenos : ajenos.filter((r) => (r.priority ?? 0) <= mejorPropia);
      if (porDelante.length === 0) {
        if (propio && ajenos.length > 0) {
          return conservar(
            `Ya existe con el valor correcto. ${ajenos.length === 1 ? 'El MX' : 'Los MX'} de ${ajenos
              .map((r) => sinPunto(r.content))
              .join(', ')} ${ajenos.length === 1 ? 'tiene' : 'tienen'} menor preferencia y solo recibirá${ajenos.length === 1 ? '' : 'n'} correo si este servidor no responde; se conserva${ajenos.length === 1 ? '' : 'n'}.`,
            [...propios, ...ajenos],
          );
        }
        if (propio) {
          // Otra prioridad que la propuesta funciona igual: no se toca.
          return conservar(
            propio.priority !== undefined && propio.priority !== d.priority
              ? `Ya existe con prioridad ${propio.priority}; funciona igual que la propuesta.`
              : 'Ya existe con el valor correcto.',
            [propio],
          );
        }
        if (cnameEstorba) {
          return enConflicto(
            'Existe un CNAME con este nombre; impide publicar el MX.',
            cnames,
            borrarYCrear(cnames),
          );
        }
        return crear();
      }
      const hosts = porDelante.map((r) => sinPunto(r.content)).join(', ');
      const routing = ajenos.some((r) => esHostEmailRouting(r.content));
      let reason = `El dominio recibe hoy el correo en ${hosts}. Si se reemplazan estos MX, el correo dejará de llegar a ese proveedor.`;
      if (routing) {
        reason +=
          ' Pertenecen a Cloudflare Email Routing: desactívalo en el panel de Cloudflare (Email → Email Routing → Settings) antes de aplicar.';
      }
      return enConflicto(reason, ajenos, {
        ...vacias(),
        deletes: ajenos.map((r) => r.id),
        posts: propio ? [] : [cuerpoRegistro(d, comentario)],
      });
    }

    case 'TXT': {
      const txts = aqui.filter((r) => r.type === 'TXT');
      const valor = d.content.toLowerCase();

      if (esSpf(valor)) {
        const spfs = txts.filter((r) => esSpf(txtDe(r)));
        if (spfs.length === 0) {
          if (cnameEstorba) {
            return enConflicto('Existe un CNAME con este nombre; impide publicar el SPF.', cnames, borrarYCrear(cnames));
          }
          return crear();
        }
        if (spfs.length > 1) {
          // Nunca se corrige solo: decidir qué mecanismos sobran es del titular.
          return enConflicto(
            `Hay ${spfs.length} registros SPF con este nombre y solo puede existir uno: los servidores receptores los invalidan todos. Combínalos manualmente en un único registro v=spf1 que incluya «mx».`,
            spfs,
            null,
          );
        }
        const actual = spfs[0]!;
        const fusion = fusionarSpf(txtDe(actual), d.content, { nombre: d.name, ipServidor: ctx.publicIp });
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

      if (esDmarc(valor)) {
        const dmarcs = txts.filter((r) => esDmarc(txtDe(r)));
        if (dmarcs.length > 1) {
          // Igual que con dos SPF: con varios DMARC los receptores no aplican
          // ninguno, y elegir cuál se queda es del titular. La comprobación DNS
          // los da por incorrectos con el mismo criterio.
          return enConflicto(
            `Hay ${dmarcs.length} registros DMARC con este nombre y solo puede existir uno: los servidores receptores no aplican ninguno. Conserva manualmente una única política.`,
            dmarcs,
            null,
          );
        }
        if (dmarcs.length > 0) {
          const politica = politicaDmarc(txtDe(dmarcs[0]!));
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
            operaciones: { ...vacias(), puts: [{ id: txts[0]!.id, ...cuerpoRegistro(d, comentario) }] },
            reemplazo: null,
          };
        }
        return enConflicto('Ya existe otra clave DKIM con este selector.', txts, borrarYCrear(txts));
      }

      // Otros TXT (MTA-STS, TLS-RPT, verificación de propiedad…): se comparan
      // con los de su mismo tipo, reconocido por «v=…» o por la clave inicial
      // («mailway-verificacion=»). Sin prefijo, un segundo «Aplicar» intentaría
      // crear otra vez el mismo registro.
      const prefijo = valor.match(/^v=[a-z0-9]+/)?.[0] ?? valor.match(/^[a-z0-9-]+=/)?.[0];
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
          operaciones: { ...vacias(), puts: [{ id: mismos[0]!.id, ...cuerpoRegistro(d, comentario) }] },
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
            puts: [{ id: srvs[0]!.id, ...cuerpoRegistro(d, comentario) }],
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
        if (d.proxied) {
          if (propio.proxied) return conservar('Ya existe con el valor correcto y el proxy de Cloudflare activo.', [propio]);
          if (propio.bloqueado) return enConflicto(MOTIVO_EMAIL_ROUTING, [propio], null);
          return {
            ...base,
            action: 'update',
            reason: MOTIVO_PROXY_ACTIVAR,
            current: describir(propio),
            operaciones: { ...vacias(), patches: [{ id: propio.id, proxied: true }] },
            reemplazo: null,
          };
        }
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
  'cloudflare_token_ip_restricted',
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

function cuentaOperaciones(ops: Operaciones): number {
  return ops.deletes.length + ops.patches.length + ops.puts.length + ops.posts.length;
}

/**
 * Aplica las operaciones de un cambio en un lote atómico. «Ya existe un
 * registro idéntico» en el alta es justo el resultado buscado: se repite el
 * lote sin el alta para que lo demás (borrados, cambios) sí se aplique.
 */
async function aplicarCambio(cliente: CloudflareClient, zoneId: string, ops: Operaciones): Promise<void> {
  if (cuentaOperaciones(ops) === 0) return;
  try {
    await cliente.batch(zoneId, construirLote([ops]));
  } catch (err) {
    if (!(err instanceof CloudflareError) || !err.idempotente || ops.posts.length === 0) throw err;
    const sinAltas: Operaciones = { ...ops, posts: [] };
    if (cuentaOperaciones(sinAltas) === 0) return;
    await cliente.batch(zoneId, construirLote([sinAltas]));
  }
}

/**
 * Aplica un plan en un único lote. Si Cloudflare rechaza el lote por un
 * registro concreto (validación, un registro que ya existe, Email Routing…),
 * se aplica cada cambio en su propio lote para que los correctos no se
 * pierdan por uno erróneo, y el error se atribuye a su registro.
 *
 * Cada cambio va en un lote y no en llamadas sueltas: un reemplazo de MX es
 * «borrar los ajenos + crear el propio», y si el alta fallara después del
 * borrado (límite de peticiones, un error del propio registro) la zona se
 * quedaría sin ningún MX. En un lote, o se aplica entero o no se aplica.
 */
export async function ejecutarPlan(
  cliente: CloudflareClient,
  zoneId: string,
  cambios: CambioInterno[],
  opts: { replaceConflicts: boolean; soloCrear?: boolean },
): Promise<ResultadoAplicacion> {
  const skipped: ResultadoAplicacion['skipped'] = [];
  const aplicar: { cambio: CambioInterno; accion: string; ops: Operaciones }[] = [];
  for (const cambio of cambios) {
    if (opts.soloCrear && cambio.action === 'update') {
      // Alta automática: solo se crea lo que falta. Fusionar el SPF, quitar
      // un proxy o actualizar un registro existente es modificarlo, y eso
      // queda para «Aplicar» en la ficha del dominio, después de revisar el plan.
      skipped.push({
        type: cambio.type,
        name: cambio.name,
        reason: `Ya existe y el alta automática no modifica registros existentes. ${cambio.reason} Revisa el cambio y aplícalo desde la ficha del dominio.`,
      });
      continue;
    }
    if ((cambio.action === 'create' || cambio.action === 'update') && cambio.operaciones) {
      aplicar.push({ cambio, accion: cambio.action, ops: cambio.operaciones });
    } else if (cambio.action === 'conflict') {
      if (opts.replaceConflicts && !opts.soloCrear && cambio.reemplazo) {
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

  // Un lote por cambio. Los borrados compartidos (un CNAME que estorba a dos
  // cambios) solo van en el primer lote que lo consigue: repetirlos en el
  // siguiente haría fallar ese lote entero por «el registro ya no existe».
  const fallidos = new Map<CambioInterno, string>();
  const borrados = new Set<string>();
  let alguno = false;
  for (let i = 0; i < aplicar.length; i++) {
    const a = aplicar[i]!;
    const ops: Operaciones = { ...a.ops, deletes: a.ops.deletes.filter((id) => !borrados.has(id)) };
    try {
      await aplicarCambio(cliente, zoneId, ops);
      for (const id of ops.deletes) borrados.add(id);
      alguno = true;
    } catch (err) {
      if (err instanceof CloudflareError && ERRORES_GLOBALES.has(err.code)) {
        // Sin nada aplicado, el error es de toda la operación. Con algo ya
        // aplicado, se informa de lo hecho y lo pendiente queda como error:
        // cada lote es atómico, así que la zona no ha quedado a medias.
        if (!alguno) throw err;
        for (const pendiente of aplicar.slice(i)) fallidos.set(pendiente.cambio, err.message);
        break;
      }
      fallidos.set(a.cambio, mensajeDe(err));
    }
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

/**
 * Registros que Mailway quiere en Cloudflare para un dominio de correo. Con
 * lo recomendado va también el TXT de verificación de la propiedad: así,
 * aplicar en Cloudflare prueba la propiedad sin esperar a mover el MX.
 */
async function deseadosDeDominio(domain: string, includeRecommended: boolean): Promise<Deseado[]> {
  const records = await getEngine().getDnsRecords(domain);
  // Un MX interno escrito en la zona rompería el correo del dominio: ni el
  // plan ni la aplicación siguen adelante (409 mx_hostname_internal).
  exigirMxPublico(domain, records);
  const seleccion = filtrarPorNivel(
    registrosDelDominio(domain, records),
    includeRecommended ? 'recomendados' : 'obligatorios',
  );
  return seleccion.map(deseadoDe).filter((d): d is Deseado => d !== null);
}

/**
 * ¿Pide la petición `soloCliente=1`? Skyway usa un token de administrador en
 * nombre de sus proyectos y lo envía cuando quien actúa en Skyway no es
 * administrador (el propietario o un miembro de un espacio de trabajo).
 */
export function pideSoloCliente(query: unknown): boolean {
  const { soloCliente } = (query ?? {}) as { soloCliente?: unknown };
  return soloCliente === '1' || soloCliente === 'true';
}

/**
 * ¿Puede esta petición usar las cuentas de Cloudflare de la instancia?
 * Solo el administrador, y nunca con `soloCliente=1`: entonces el plan y la
 * aplicación se limitan a las cuentas del propio cliente, igual que para un
 * usuario del cliente. Tampoco sirve la cuenta de la instancia que el
 * administrador dejó asociada al dominio al aplicar su DNS (resolverZona).
 */
export function permiteInstancia(user: AuthedUser, query: unknown): boolean {
  if (pideSoloCliente(query)) return false;
  return user.role === 'admin';
}

/**
 * Las rutas que solo trabajan con las cuentas de la instancia (DNS de la
 * plataforma, certificado del motor) no se pueden usar en nombre de un
 * cliente: con `soloCliente=1` se rechazan aunque el token sea de
 * administración, en vez de usar el token del operador.
 */
export function rechazarSoloCliente(query: unknown): void {
  if (pideSoloCliente(query)) {
    throw forbidden(
      'Esta acción usa la cuenta de Cloudflare de la instancia y no se puede realizar en nombre de un cliente.',
      'cloudflare_instance_admin_only',
    );
  }
}

async function planDeDominio(
  domain: DomainRecord,
  includeRecommended: boolean,
  permitirInstancia: boolean,
): Promise<PlanDominio> {
  const { resolucion, motivo } = await resolverZona(domain.domain, {
    clientId: domain.clientId,
    storedAccountId: domain.cloudflare?.accountId ?? null,
    permitirInstancia,
  });
  if (!resolucion) {
    return { available: false, reason: motivo, changes: [], resolucion: null };
  }
  // Una cuenta del propio cliente se asocia ya al consultar. Una de la
  // instancia, solo cuando el administrador aplica: la asociación indica con
  // qué cuenta se configuró el DNS, y abrir la ficha no configura nada. Aun
  // asociada, el cliente nunca la usa (resolverZona).
  if (resolucion.cuenta.client_id !== null) guardarAsociacion(domain.id, resolucion);
  const deseados = await deseadosDeDominio(domain.domain, includeRecommended);
  const existentes = await existentesPara(
    resolucion.cliente,
    resolucion.zona.id,
    deseados.map((d) => d.name),
  );
  const { publicIp } = getInstanceSettings();
  // El vértice es el de la ZONA, no el dominio: con un dominio de correo que
  // es subdominio (envios.acme.es en la zona acme.es), un CNAME en su nombre
  // sí impide publicar el MX y el SPF, y debe salir como conflicto.
  const changes = planificar(deseados, existentes, { apex: sinPunto(resolucion.zona.name), publicIp });
  return {
    available: true,
    account: { id: resolucion.cuenta.id, label: resolucion.cuenta.label },
    zone: zonaPublica(resolucion.zona),
    changes,
    resolucion,
  };
}

/**
 * Escribir en una zona ACTIVA de Cloudflare el TXT de verificación (o el MX
 * a este servidor) prueba la propiedad sin esperar al DNS público, cuyos
 * resolutores pueden tener en caché durante media hora el «no existe» de la
 * primera medición. Cloudflare solo marca una zona como activa cuando la
 * delegación del dominio apunta a sus servidores de nombres, así que quien
 * escribe en ella controla el dominio. Una zona pendiente no prueba nada:
 * cualquiera puede añadir gmail.com a su cuenta de Cloudflare.
 */
export function pruebaPropiedadEnZona(
  domain: DomainRecord,
  zona: CfZona,
  cambios: CambioPlan[],
  resultado: ResultadoAplicacion,
): boolean {
  if (zona.status !== 'active') return false;
  const nombreTxt = domain.ownershipRecord.name.toLowerCase();
  const apex = domain.domain.toLowerCase();
  // «keep» del TXT o del MX = el nuestro ya está en la zona; «applied» = se
  // acaba de escribir. Un conflicto sin reemplazar no prueba nada.
  const esPrueba = (type: string, name: string) =>
    (type === 'TXT' && name === nombreTxt) || (type === 'MX' && name === apex);
  const conservado = cambios.some((c) => c.action === 'keep' && esPrueba(c.type, c.name));
  const aplicado = resultado.applied.some((a) => esPrueba(a.type, a.name));
  return conservado || aplicado;
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

/* ------------------- Reservas de los dominios del operador ----------------- */

interface ReservaRow {
  domain: string;
  client_id: string | null;
}

/** Cliente para el que el administrador escribió el DNS del dominio con una cuenta de la instancia. */
export function reservaDeDominio(domain: string): ReservaRow | undefined {
  return db.prepare('SELECT domain, client_id FROM cloudflare_reservas WHERE domain = ?').get(domain) as
    | ReservaRow
    | undefined;
}

/**
 * Anota (o actualiza) la reserva: los registros escritos en una zona del
 * operador siguen ahí aunque el dominio se borre, y un MX o el TXT de
 * verificación bastan para probar la propiedad. Mientras exista, solo ese
 * cliente (o el administrador) puede dar de alta el dominio.
 */
function reservarDominio(domain: string, clientId: string, r: Resolucion): void {
  db.prepare(
    `INSERT INTO cloudflare_reservas (domain, client_id, account_id, zone_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET client_id = excluded.client_id, account_id = excluded.account_id,
       zone_id = excluded.zone_id, updated_at = excluded.updated_at`,
  ).run(domain, clientId, r.cuenta.id, r.zona.id, now(), now());
}

/** El administrador da de alta un dominio reservado para un cliente: la reserva pasa a ese cliente. */
export function moverReservaDominio(domain: string, clientId: string): void {
  db.prepare('UPDATE cloudflare_reservas SET client_id = ?, updated_at = ? WHERE domain = ?').run(clientId, now(), domain);
}

/**
 * Aplica el DNS de correo de un dominio en Cloudflare. Devuelve null si
 * ninguna cuenta accesible contiene la zona (el alta con «autoDns» lo usa así).
 * `soloCrear` (el alta automática) crea lo que falta y no modifica nada de lo
 * que existe: ni fusiona el SPF, ni quita un proxy, ni actualiza un registro.
 */
export async function aplicarDnsDominio(
  domainId: string,
  opts: { replaceConflicts: boolean; includeRecommended: boolean; permitirInstancia: boolean; soloCrear?: boolean },
): Promise<ResultadoDominio | { unavailable: string }> {
  const domain = getDomain(domainId);
  // Quien llama decide expresamente si se pueden usar las cuentas de la
  // instancia (permiteInstancia): deducirlo aquí del rol pasaría por alto un
  // `soloCliente=1` de la petición.
  const plan = await planDeDominio(domain, opts.includeRecommended, opts.permitirInstancia);
  if (!plan.available || !plan.resolucion) return { unavailable: plan.reason || '' };
  const r = plan.resolucion;
  const resultado = await ejecutarPlan(r.cliente, r.zona.id, plan.changes, {
    replaceConflicts: opts.replaceConflicts,
    soloCrear: opts.soloCrear,
  });
  guardarAsociacion(domainId, r);
  if (r.cuenta.client_id === null && resultado.applied.length > 0) reservarDominio(domain.domain, domain.clientId, r);
  if (resultado.applied.length > 0) {
    db.prepare('UPDATE domains SET dns_applied_at = ? WHERE id = ?').run(now(), domainId);
  }
  if (domain.ownershipVerifiedAt === null && pruebaPropiedadEnZona(domain, r.zona, plan.changes, resultado)) {
    marcarPropiedadComprobada(domainId);
  }
  // La verificación no debe tapar el resultado: si el motor no responde, el
  // DNS ya está aplicado y se medirá en la siguiente vuelta del vigilante.
  const fresco = await refreshDomainDns(domainId).catch(() => getDomain(domainId));
  return { ...resultado, domain: fresco, zone: zonaPublica(r.zona) };
}

/* -------------------------- Marca blanca (webmail) ------------------------ */

/**
 * Cuenta y zona de Cloudflare con las que se aplicó el DNS del dominio de
 * correo del que cuelga `hostname` (el más específico del cliente).
 */
function asociacionDelDominioPadre(
  clientId: string,
  hostname: string,
): { accountId: string | null; zoneId: string | null } {
  const filas = db
    .prepare('SELECT domain, cloudflare_account_id, cloudflare_zone_id FROM domains WHERE client_id = ?')
    .all(clientId) as { domain: string; cloudflare_account_id: string | null; cloudflare_zone_id: string | null }[];
  const padre = filas
    .filter((d) => hostname.endsWith(`.${d.domain}`))
    .sort((a, b) => b.domain.length - a.domain.length)[0];
  return { accountId: padre?.cloudflare_account_id ?? null, zoneId: padre?.cloudflare_zone_id ?? null };
}

/** Registro que debe tener un dominio de marca blanca: CNAME al servidor de correo o, sin nombre, A a la IP. */
function deseadoDeMarcaBlanca(destino: ClientDomain): Deseado {
  const inst = getInstanceSettings();
  const mail = sinPunto(inst.mailHostname || '');
  const host = sinPunto(destino.hostname);
  // El webmail va con el proxy de Cloudflare: su página de acceso queda tras
  // el cortafuegos y los límites de Cloudflare, y el correo no se ve
  // afectado (va al nombre del servidor, sin proxy). El panel de marca
  // blanca no: su límite de intentos cuenta la IP de la conexión.
  const proxied = destino.kind === 'webmail';
  if (mail && mail !== host) {
    // El CNAME es preferible: si cambia la IP del servidor, no hay que tocar nada.
    return { type: 'CNAME', name: host, content: mail, required: true, proxied };
  }
  if (inst.publicIp) {
    return { type: 'A', name: host, content: inst.publicIp.trim(), required: true, proxyTolerado: false, proxied };
  }
  throw badRequest(
    'Configura en Ajustes el nombre del servidor de correo o la IP pública antes de configurar el DNS.',
    'instance_incomplete',
  );
}

/**
 * Busca la cuenta para el registro de un dominio de marca blanca. Además de
 * las cuentas del cliente (y las de la instancia si actúa la
 * administración), vale la cuenta con la que se aplicó el DNS del dominio de
 * correo del que cuelga, aunque sea de la instancia y actúe el cliente (o
 * Skyway en su nombre). Es la única excepción a «el token del operador nunca
 * se usa en una acción del cliente», y es segura porque:
 * - el nombre es un subdominio de un dominio de correo de ESE cliente, con la
 *   propiedad comprobada (assertHostnameAllowed);
 * - la administración ya escribió en esa zona para ese mismo dominio (por eso
 *   la cuenta quedó asociada), así que no abre ninguna zona nueva;
 * - solo se escribe un registro con un valor fijo (el servidor de correo o su
 *   IP), y con esa cuenta nunca se reemplaza lo que haya (aplicarDnsMarcaBlanca).
 */
async function resolverZonaMarcaBlanca(
  destino: { clientId: string; hostname: string },
  permitirInstancia: boolean,
): Promise<{ resolucion: Resolucion | null; motivo: string }> {
  const host = sinPunto(destino.hostname);
  const padre = asociacionDelDominioPadre(destino.clientId, host);
  const r = await resolverZona(host, {
    clientId: destino.clientId,
    storedAccountId: padre.accountId,
    permitirInstancia,
    permitirGuardadaDeInstancia: true,
  });
  // La excepción vale para la MISMA zona en la que ya escribió la
  // administración: si el token del operador viera además una zona más
  // específica para este nombre, esa no se ha abierto nunca a este cliente.
  if (
    r.resolucion &&
    r.resolucion.cuenta.client_id === null &&
    !permitirInstancia &&
    r.resolucion.zona.id !== padre.zoneId
  ) {
    return {
      resolucion: null,
      motivo:
        'La zona de este nombre está en la cuenta de Cloudflare de la instancia y no es la del dominio de correo que configuró el administrador: solicita al administrador que aplique el registro.',
    };
  }
  return r;
}

/**
 * Apunta un dominio de marca blanca a este servidor en Cloudflare (el webmail,
 * con proxy). `soloCrear` (el alta automática) crea el registro si falta y no
 * modifica uno existente, ni para activarle el proxy. Lanza
 * `400 cloudflare_unavailable` si ninguna cuenta utilizable ve la zona.
 */
export async function aplicarDnsMarcaBlanca(
  id: string,
  opts: { permitirInstancia: boolean; replaceConflicts: boolean; soloCrear: boolean },
): Promise<ResultadoAplicacion & { domain: ClientDomain; zone: string }> {
  const destino = getClientDomain(id);
  const deseado = deseadoDeMarcaBlanca(destino);
  const { resolucion, motivo } = await resolverZonaMarcaBlanca(destino, opts.permitirInstancia);
  if (!resolucion) throw badRequest(motivo, 'cloudflare_unavailable');
  // Con la cuenta de la instancia en nombre de quien no puede usarla (la
  // excepción de resolverZonaMarcaBlanca) no se reemplaza nada: un conflicto
  // se informa y se resuelve a mano.
  const enNombreDelCliente = resolucion.cuenta.client_id === null && !opts.permitirInstancia;
  const existentes = await existentesPara(resolucion.cliente, resolucion.zona.id, [deseado.name]);
  const inst = getInstanceSettings();
  const cambios = planificar([deseado], existentes, {
    apex: resolucion.zona.name,
    publicIp: inst.publicIp || undefined,
  });
  const resultado = await ejecutarPlan(resolucion.cliente, resolucion.zona.id, cambios, {
    replaceConflicts: opts.replaceConflicts && !enNombreDelCliente,
    soloCrear: opts.soloCrear,
  });
  const domain = await refreshClientDomain(id).catch(() => getClientDomain(id));
  return { ...resultado, domain, zone: resolucion.zona.name };
}

/** ¿Es este registro el del webmail: un CNAME al servidor de correo o un A a su IP? */
function apuntaAlServidor(r: CfRegistro): boolean {
  const inst = getInstanceSettings();
  const mail = sinPunto(inst.mailHostname || '');
  const ip = (inst.publicIp || '').trim();
  return (r.type === 'CNAME' && mail !== '' && sinPunto(r.content) === mail) || (r.type === 'A' && ip !== '' && r.content.trim() === ip);
}

/**
 * Antes del alta automática de webmail.<dominio>: ¿qué hay ya en Cloudflare
 * con ese nombre? «libre» si nada (aunque lo responda un comodín, como el de
 * la web), «propio» si ya apunta a este servidor, «ajeno» si es otra cosa (el
 * cliente lo usa para otro servicio: no se toca) y null si ninguna cuenta
 * utilizable ve la zona o Cloudflare no responde. Las cuentas son las que
 * escribirían el registro (resolverZonaMarcaBlanca, sin las de la instancia).
 */
export async function estadoWebmailEnCloudflare(
  clientId: string,
  hostname: string,
): Promise<'libre' | 'propio' | 'ajeno' | null> {
  const host = sinPunto(hostname);
  try {
    const { resolucion } = await resolverZonaMarcaBlanca({ clientId, hostname: host }, false);
    if (!resolucion) return null;
    const registros = await existentesPara(resolucion.cliente, resolucion.zona.id, [host]);
    if (registros.length === 0) return 'libre';
    return registros.every(apuntaAlServidor) ? 'propio' : 'ajeno';
  } catch {
    return null;
  }
}

/**
 * Al retirar un webmail automático (interruptor del cliente desactivado):
 * borra de Cloudflare el registro que escribió Mailway para él. Solo el
 * propio (con el comentario exacto de esta instancia) y que apunta a este
 * servidor; cualquier otro se deja. Con las mismas cuentas que lo crearon.
 * Devuelve si ha borrado algo; un fallo no impide retirar el webmail.
 */
export async function retirarRegistroMarcaBlanca(destino: ClientDomain): Promise<boolean> {
  const host = sinPunto(destino.hostname);
  try {
    const { resolucion } = await resolverZonaMarcaBlanca(destino, false);
    if (!resolucion) return false;
    const comentario = comentarioPropio();
    const propios = (await existentesPara(resolucion.cliente, resolucion.zona.id, [host])).filter(
      (r) => esPropio(r, comentario) && apuntaAlServidor(r),
    );
    for (const r of propios) await resolucion.cliente.deleteRecord(resolucion.zona.id, r.id);
    return propios.length > 0;
  } catch {
    return false;
  }
}

/**
 * Con el proxy de Cloudflare, el DNS público devuelve IP de Cloudflare y no
 * dice adónde apunta el nombre: se pregunta a Cloudflare. true si el nombre
 * tiene, con proxy, un CNAME al servidor de correo o un A a la IP pública;
 * false si no; null si ninguna cuenta ve la zona o Cloudflare no responde.
 * Es una lectura: también vale la cuenta de la instancia, porque solo dice
 * si un subdominio de un dominio verificado del cliente apunta aquí.
 */
export async function registroProxyApuntaAqui(destino: ClientDomain): Promise<boolean | null> {
  const host = sinPunto(destino.hostname);
  try {
    const { resolucion } = await resolverZonaMarcaBlanca(destino, true);
    if (!resolucion) return null;
    const registros = await existentesPara(resolucion.cliente, resolucion.zona.id, [host]);
    return registros.some((r) => r.proxied && apuntaAlServidor(r));
  } catch {
    return null;
  }
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
      motivo: 'Configura en Ajustes el nombre del servidor de correo y la IP pública antes de aplicar el DNS de la plataforma.',
    };
  }
  const deseados: Deseado[] = [{ type: 'A', name: mail, content: ip, required: true }];
  const nombres = new Set([mail]);
  for (const host of [hostDe(inst.webmailUrl), hostDe(inst.panelUrl)]) {
    if (!host || nombres.has(host) || /^[\d.]+$/.test(host) || host === 'localhost') continue;
    nombres.add(host);
    deseados.push({ type: 'A', name: host, content: ip, required: false, proxyTolerado: true });
  }
  // El mismo dominio base que sirve la autoconfiguración (connection.ts):
  // con un servidor de dos etiquetas (ejemplo.com) es el propio nombre.
  const base = instanceAutoconfigBase(mail);
  if (base) {
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
      reason: 'No hay ninguna cuenta de Cloudflare de la instancia conectada. Conecta una con el ámbito «Toda la instancia».',
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

/* ------------------------------ Conectar cuenta --------------------------- */

export const tokenSchema = z
  .string({ required_error: 'Introduce el token de Cloudflare.' })
  .trim()
  .min(20, 'El token de Cloudflare no parece completo.')
  .max(400, 'El token de Cloudflare es demasiado largo.')
  .refine((t) => !/\s/.test(t), 'El token no puede contener espacios.');

export const etiquetaSchema = z.string().trim().max(80, 'El nombre no puede superar 80 caracteres.');

const conexionSchema = z.object({ token: tokenSchema, label: etiquetaSchema.optional() });

export interface ConexionCloudflare {
  cuenta: CuentaCloudflare;
  /** false si el mismo token ya estaba conectado en ese ámbito (modo idempotente). */
  creada: boolean;
  /** true si se ha sustituido el token de la cuenta del instalador (modo idempotente). */
  sustituida: boolean;
}

/**
 * Conecta una cuenta de Cloudflare: comprueba el token y que vea alguna
 * zona, lo guarda cifrado y anota la acción con `auditar` (la ruta audita la
 * petición; la herramienta de terminal, como «Sistema»). El token nunca se
 * devuelve ni pasa a la auditoría.
 *
 * Con el mismo token ya conectado en el mismo ámbito (el mismo cliente, o la
 * instancia con `clientId` null), `siYaExiste: 'error'` responde 409 (la
 * ruta: así el formulario lo explica) y `'devolver'` devuelve la existente
 * sin tocarla (la herramienta del instalador, que puede repetirse).
 *
 * En modo `'devolver'` con un token DISTINTO para la instancia, si ya hay una
 * cuenta de la instancia creada desde la terminal (sin `created_by`: la del
 * instalador), se le sustituye el token en vez de añadir otra: el operador
 * rota su token repitiendo el instalador, y una segunda cuenta dejaría la
 * antigua (que se prueba primero) en uso, o fallando en cada alta si se
 * revocó. La cuenta conserva su identificador, así que los dominios
 * asociados a ella siguen asociados.
 */
export async function conectarCuentaCloudflare(opts: {
  token: string;
  label?: string;
  clientId: string | null;
  createdBy: string | null;
  siYaExiste: 'error' | 'devolver';
  auditar: (accion: string, detalle: Record<string, unknown>) => void;
}): Promise<ConexionCloudflare> {
  const { token, label: etiqueta } = conexionSchema.parse({ token: opts.token, label: opts.label });
  const clientId = opts.clientId;

  // Mismo token dos veces en el mismo ámbito: se avisa (o se reutiliza) en vez de duplicar.
  const mismas = clientId ? cuentasDeCliente(clientId) : cuentasDeInstancia();
  const existente = mismas.find((fila) => {
    try {
      return decryptSecret(fila.token_enc) === token;
    } catch {
      return false;
    }
  });
  if (existente) {
    if (opts.siYaExiste === 'error') throw conflict('Este token ya está conectado.', 'cloudflare_duplicate');
    // Se refrescan sus zonas: si el token ha dejado de valer, la cuenta lo
    // muestra (last_error) y quien la conecta de nuevo lo ve en el resultado.
    const cache = await zonasDeCuenta(existente, true);
    return { cuenta: toCuenta(cuentaRow(existente.id) || existente, cache), creada: false, sustituida: false };
  }

  const cliente = new CloudflareClient(token);
  await cliente.verifyToken();
  const zonas = await cliente.listZones();
  if (zonas.length === 0) {
    throw badRequest(
      'El token es válido, pero no da acceso a ninguna zona. Asigna el permiso «Zone · Zone · Read» e incluye las zonas de tus dominios.',
      'cloudflare_no_zones',
    );
  }
  const nombres = zonas.map((z) => z.name).sort((a, b) => a.localeCompare(b));
  const cache: CacheZonas = { zones: nombres.slice(0, 500), total: nombres.length, at: now() };

  // Rotación del token del instalador: misma cuenta, token nuevo (solo tras
  // verificarlo: un token que no vale deja la cuenta como estaba).
  const delInstalador = opts.siYaExiste === 'devolver' && clientId === null ? mismas.find((f) => f.created_by === null) : undefined;
  if (delInstalador) {
    const label = etiqueta || delInstalador.label;
    db.prepare(
      `UPDATE cloudflare_accounts SET token_enc = ?, token_hint = ?, label = ?, last_verified_at = ?, last_error = ''
       WHERE id = ?`,
    ).run(encryptSecret(token), pistaToken(token), label, now(), delInstalador.id);
    setJsonSetting(claveCache(delInstalador.id), cache);
    opts.auditar('cloudflare.account_token_replaced', {
      id: delInstalador.id,
      label,
      clientId: null,
      zones: nombres.length,
    });
    return { cuenta: toCuenta(cuentaRow(delInstalador.id)!, cache), creada: false, sustituida: true };
  }

  const id = randomId('cf');
  const label = etiqueta || zonas[0]!.accountName || 'Cloudflare';
  db.prepare(
    `INSERT INTO cloudflare_accounts (id, client_id, label, token_enc, token_hint, created_by,
       created_at, last_verified_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '')`,
  ).run(id, clientId, label, encryptSecret(token), pistaToken(token), opts.createdBy, now(), now());
  setJsonSetting(claveCache(id), cache);

  opts.auditar('cloudflare.account_connected', { id, label, clientId, zones: nombres.length });
  return { cuenta: toCuenta(cuentaRow(id)!, cache), creada: true, sustituida: false };
}

/* ---------------------------------- Rutas --------------------------------- */

const booleano = (campo: string) =>
  z.boolean({ invalid_type_error: `El campo «${campo}» debe ser verdadero o falso.` }).optional();

const aplicarSchema = z
  .object({
    replaceConflicts: booleano('replaceConflicts'),
    includeRecommended: booleano('includeRecommended'),
  })
  .nullish();

const reemplazoSchema = z.object({ replaceConflicts: booleano('replaceConflicts') }).nullish();

/**
 * Registro de un dominio de marca blanca. `soloCrear` lo pide quien lo crea
 * automáticamente al dar de alta el webmail (Skyway, para su administrador):
 * se crea si falta y nunca se modifica uno existente, ni para quitarle el proxy.
 */
const marcaBlancaSchema = z
  .object({ replaceConflicts: booleano('replaceConflicts'), soloCrear: booleano('soloCrear') })
  .nullish();

export function registerCloudflareRoutes(app: FastifyInstance): void {
  /**
   * Cuentas conectadas. El administrador ve todas; un cliente, las suyas.
   * Con `?soloCliente=1`, el administrador solo ve las del `?clientId` indicado.
   */
  app.get('/api/cloudflare/accounts', async (req) => {
    const user = requireAuth(req);
    const { clientId, refresh } = req.query as { clientId?: string; refresh?: string };
    const filas = cuentasVisibles(user, user.role === 'admin' ? clientId : undefined, pideSoloCliente(req.query));
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
        label: etiquetaSchema.optional(),
        clientId: z.string().trim().min(1, 'Selecciona un cliente.').nullable().optional(),
      })
      .parse(req.body);

    let clientId: string | null;
    if (user.role === 'admin') {
      clientId = body.clientId || null;
      // En nombre de un cliente no se conectan cuentas de la instancia: la
      // cuenta sería del operador y la usarían sus altas de dominios.
      if (!clientId && pideSoloCliente(req.query)) {
        throw forbidden(
          'En nombre de un cliente solo se pueden conectar cuentas de ese cliente: indica su «clientId».',
          'cloudflare_instance_admin_only',
        );
      }
      if (clientId) getClient(clientId);
    } else {
      if (!user.clientId) throw forbidden();
      if (body.clientId && body.clientId !== user.clientId) {
        throw forbidden('Solo puedes conectar cuentas de Cloudflare para tu propia organización.');
      }
      clientId = user.clientId;
    }

    const { cuenta } = await conectarCuentaCloudflare({
      token: body.token,
      label: body.label,
      clientId,
      createdBy: user.id,
      siYaExiste: 'error',
      auditar: (accion, detalle) => audit(req, accion, detalle),
    });
    return { account: cuenta };
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
    } else if (fila.client_id === null && pideSoloCliente(req.query)) {
      // En nombre de un cliente, la cuenta del operador no existe.
      throw notFound('Cuenta de Cloudflare no encontrada.');
    }
    db.prepare('DELETE FROM cloudflare_accounts WHERE id = ?').run(id);
    db.prepare('DELETE FROM settings WHERE key = ?').run(claveCache(id));
    audit(req, 'cloudflare.account_removed', { id, label: fila.label, clientId: fila.client_id });
    return { ok: true };
  });

  /** Plan de cambios del DNS de correo de un dominio (no modifica nada). */
  /*
   * `?soloCliente=1` (plan y aplicación): limita las cuentas a las del propio
   * cliente aunque quien llame sea administrador. Lo usa Skyway, que trabaja
   * con un token de administrador en nombre de usuarios que no lo son; véase
   * permiteInstancia().
   */
  app.get('/api/domains/:id/cloudflare', async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    const domain = getDomain(id);
    requireClientAccess(req, domain.clientId);
    const { includeRecommended } = req.query as { includeRecommended?: string };
    const plan = await planDeDominio(domain, includeRecommended !== 'false', permiteInstancia(user, req.query));
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
    const resultado = await aplicarDnsDominio(id, {
      replaceConflicts: body.replaceConflicts === true,
      includeRecommended: body.includeRecommended !== false,
      permitirInstancia: permiteInstancia(user, req.query),
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

  /** Marca blanca: apunta el dominio propio del cliente a este servidor (admite `?soloCliente=1`). */
  app.post('/api/whitelabel/domains/:id/cloudflare', async (req) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    const destino = getClientDomain(id);
    requireClientAccess(req, destino.clientId);
    const body = marcaBlancaSchema.parse(req.body) || {};
    const resultado = await aplicarDnsMarcaBlanca(id, {
      permitirInstancia: permiteInstancia(user, req.query),
      replaceConflicts: body.replaceConflicts === true,
      soloCrear: body.soloCrear === true,
    });
    audit(req, 'cloudflare.dns_applied', {
      whitelabelDomainId: id,
      hostname: resultado.domain.hostname,
      zone: resultado.zone,
      applied: resultado.applied.length,
      errors: resultado.errors.length,
    }, resultado.domain.clientId);
    return { applied: resultado.applied, errors: resultado.errors, skipped: resultado.skipped, domain: resultado.domain };
  });

  /** DNS de la plataforma: vista previa (solo administrador). */
  app.get('/api/cloudflare/instance-dns', async (req) => {
    requireAdmin(req);
    rechazarSoloCliente(req.query);
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
    rechazarSoloCliente(req.query);
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
