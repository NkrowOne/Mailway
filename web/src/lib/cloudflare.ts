import type { QueryClient } from '@tanstack/react-query';
import type { DomainRecord } from './api';
import type { Veredicto } from '../ui/kit';

/*
  Tipos y utilidades de los dominios de correo y de la integración con
  Cloudflare (DNS automático). Viven aquí y no en lib/api.ts para no mezclar
  áreas: lib/api.ts es de otro equipo y estos tipos solo los usan Dominios,
  la ficha y Conexiones.
*/

/** TXT que demuestra la propiedad del dominio sin cambiar el MX. */
export interface RegistroPropiedad {
  type: 'TXT';
  name: string;
  content: string;
}

/** Dominio de correo con los campos que añade la integración. */
export type DominioCorreo = DomainRecord & {
  /** Nombre en Unicode para mostrar (los IDN se guardan en punycode). */
  domainUnicode?: string;
  cloudflare?: { accountId: string; zoneId: string } | null;
  dnsAppliedAt?: number | null;
  /**
   * Cuándo quedó probado que el dominio es de su cliente (MX a este servidor
   * o TXT de verificación). null = pendiente: no se pueden crear buzones ni
   * alias. Ausente en servidores anteriores a la verificación de propiedad.
   */
  ownershipVerifiedAt?: number | null;
  ownershipRecord?: RegistroPropiedad;
};

/** true si la propiedad del dominio está pendiente de comprobar. */
export function propiedadPendiente(d: DominioCorreo): boolean {
  return d.ownershipVerifiedAt === null;
}

/**
 * Última medición sin datos concluyentes: ningún registro obligatorio se ha
 * medido mal, pero alguno no se ha podido consultar. No es lo mismo que
 * «falta el registro» y no debe pintarse como fuera de rango.
 */
export function medicionIlegible(d: DominioCorreo): boolean {
  const obligatorios = (d.dnsStatus.checks ?? []).filter((c) => c.required);
  const definitivo = obligatorios.some((c) => c.status === 'missing' || c.status === 'mismatch');
  return !definitivo && obligatorios.some((c) => c.status === 'unknown');
}

/**
 * Veredicto de un dominio en listados y fichas. Uno que nunca funcionó y
 * espera su DNS es una tarea pendiente (ámbar); uno que funcionaba y ha
 * dejado de hacerlo es una avería (carmín); si el DNS no se pudo leer, no se
 * finge un veredicto. InicioCliente y ClienteDetalle deberían usar esta misma
 * función para no pintar el mismo dominio de dos colores.
 */
export function lecturaDominio(d: DominioCorreo): { veredicto: Veredicto; etiqueta: string } {
  if (d.status === 'active') return { veredicto: 'normal', etiqueta: 'Activo' };
  if (!d.lastCheckedAt) return { veredicto: 'sin-dato', etiqueta: 'Sin medir' };
  if (medicionIlegible(d)) return { veredicto: 'sin-dato', etiqueta: 'Sin dato' };
  if (d.verifiedAt) return { veredicto: 'fuera', etiqueta: 'DNS incorrecto' };
  return { veredicto: 'vigilar', etiqueta: 'DNS pendiente' };
}

/**
 * Tras dar de alta o eliminar un dominio: la lista, los paneles y el uso del
 * plan (ficha del cliente, lista de clientes y resumen del cliente).
 */
export function invalidarTrasAltaOBaja(queryClient: QueryClient, clientId?: string): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['domains'] }),
    queryClient.invalidateQueries({ queryKey: ['clients'] }),
    queryClient.invalidateQueries({ queryKey: clientId ? ['client', clientId] : ['client'] }),
    queryClient.invalidateQueries({ queryKey: ['client-dashboard'] }),
    queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] }),
  ]);
}

/**
 * Tras conectar o eliminar una cuenta de Cloudflare: cambia qué zonas se
 * pueden gestionar y, al eliminarla, los dominios pierden su asociación. Las
 * fichas (['domain', id]) y sus planes (['domain-cloudflare', id]) no
 * empiezan por ['domains'] y hay que invalidarlas aparte.
 */
export function invalidarTrasCambioDeCuenta(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['cloudflare-accounts'] }),
    queryClient.invalidateQueries({ queryKey: ['domains'] }),
    queryClient.invalidateQueries({ queryKey: ['domain'] }),
    queryClient.invalidateQueries({ queryKey: ['domain-cloudflare'] }),
    queryClient.invalidateQueries({ queryKey: ['cloudflare-instance-dns'] }),
  ]);
}

export interface CuentaCloudflare {
  id: string;
  /** null = cuenta de la instancia. */
  clientId: string | null;
  label: string;
  tokenHint: string;
  createdAt: number;
  lastVerifiedAt: number | null;
  lastError: string | null;
  zones?: string[];
  zonesTotal?: number;
}

export type AccionPlan = 'create' | 'update' | 'keep' | 'conflict';

export interface CambioPlan {
  action: AccionPlan;
  type: string;
  name: string;
  content: string;
  priority?: number;
  current?: string;
  reason: string;
  required: boolean;
  /** Solo en el DNS de la plataforma: zona a la que pertenece. */
  zone?: string;
}

export interface ZonaCloudflare {
  id: string;
  name: string;
  status: string;
  nameServers?: string[];
}

export interface PlanCloudflare {
  available: boolean;
  reason?: string;
  account?: { id: string; label: string };
  zone?: ZonaCloudflare;
  changes: CambioPlan[];
  summary: Record<AccionPlan, number>;
}

export interface PlanInstancia extends Omit<PlanCloudflare, 'zone'> {
  zones: ZonaCloudflare[];
  missing: string[];
}

export interface ResultadoAplicacion {
  applied: { action: string; type: string; name: string }[];
  errors: { type: string; name: string; error: string }[];
  skipped?: { type: string; name: string; reason: string }[];
}

/** Resultado del alta de un dominio con «Configurar el DNS automáticamente». */
export interface EstadoAltaDominio {
  autoDns: boolean;
  cloudflare: ResultadoAplicacion | null;
  cloudflareReason?: string;
}

/**
 * Asistente de tokens de Cloudflare con los dos permisos que necesita
 * Mailway ya marcados: leer zonas (Zone · Zone · Read) y editar el DNS
 * (Zone · DNS · Edit).
 */
export const URL_CREAR_TOKEN =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=*&zoneId=all&name=Mailway%20DNS';

export const textoAccion: Record<AccionPlan, string> = {
  create: 'Se creará',
  update: 'Se actualizará',
  keep: 'Se conserva',
  conflict: 'Conflicto',
};

/**
 * El veredicto de cada acción: lo que ya está bien, en rango; lo que se
 * modifica, a vigilar; lo que choca con otro registro, fuera de rango.
 */
export const veredictoAccion: Record<AccionPlan, Veredicto> = {
  keep: 'normal',
  create: 'sin-dato',
  update: 'vigilar',
  conflict: 'fuera',
};

const ordenAccion: Record<AccionPlan, number> = { conflict: 0, update: 1, create: 2, keep: 3 };

/** Orden de lectura: primero lo que reclama atención. */
export function ordenarCambios(cambios: CambioPlan[]): CambioPlan[] {
  return [...cambios].sort(
    (a, b) =>
      ordenAccion[a.action] - ordenAccion[b.action] ||
      Number(b.required) - Number(a.required) ||
      a.name.localeCompare(b.name),
  );
}

/** true si la zona contiene el dominio (es el propio dominio o un padre suyo). */
export function zonaCubre(zona: string, dominio: string): boolean {
  const z = zona.toLowerCase();
  const d = dominio.toLowerCase();
  return d === z || d.endsWith(`.${z}`);
}

/** Cuentas que el usuario puede usar para un cliente concreto. */
export function cuentasUtilizables(
  cuentas: CuentaCloudflare[],
  opts: { clientId: string | null; isAdmin: boolean },
): CuentaCloudflare[] {
  return cuentas.filter(
    (c) => (c.clientId === null && opts.isAdmin) || (opts.clientId !== null && c.clientId === opts.clientId),
  );
}

/** Nombre de dominio para mostrar: Unicode si es un IDN. */
export function nombreVisible(d: DominioCorreo): string {
  return d.domainUnicode || d.domain;
}

/** «ejemplo.es» o «_dmarc» dentro de una zona, para no repetir el dominio en cada fila. */
export function nombreCorto(nombre: string, dominio: string): string {
  if (nombre === dominio) return '@';
  return nombre.endsWith(`.${dominio}`) ? nombre.slice(0, -(dominio.length + 1)) : nombre;
}
