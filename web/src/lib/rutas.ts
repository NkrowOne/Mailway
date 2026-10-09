/**
 * Tipos y utilidades de las rutas de Traefik, la autoconfiguración de
 * dispositivos y la marca blanca. Reflejan las respuestas de
 * server/src/modules/{autoconfig,whitelabel,connection}.ts.
 */
import type { ClientDomain, WhitelabelSetup } from './api';
import type { Veredicto } from '../ui/kit';

/* ---------------------------- Autoconfiguración ---------------------------- */

/** ok: apunta a este servidor · pending: falta o apunta a otro sitio · unknown: sin consultar. */
export type EstadoHost = 'ok' | 'pending' | 'unknown';
export type UsoHost = 'autoconfig' | 'autodiscover' | 'mta-sts';

export interface EstadoHostAutoconfig {
  host: string;
  purpose: UsoHost;
  state: EstadoHost;
  detail: string;
  checkedAt: number | null;
  lastAttemptAt: number | null;
  /** La última consulta no obtuvo respuesta y se conservó el estado anterior. */
  lastAttemptInconclusive: boolean;
  /** Traefik lo enruta al panel ahora mismo. */
  routed: boolean;
}

export interface EstadoAutoconfig {
  routingAvailable: boolean;
  panelBackend: string;
  underSkyway: boolean;
  mailHostname: string;
  publicIp: string;
  checkedAt: number | null;
  instance: { base: string | null; hosts: EstadoHostAutoconfig[] };
  domains: {
    domainId: string;
    domain: string;
    clientId: string;
    clientName: string;
    hosts: EstadoHostAutoconfig[];
  }[];
  records: { type: 'CNAME'; name: string; value: string; purpose: UsoHost }[];
}

export interface ResumenComprobacion {
  checked: number;
  ok: number;
  pending: number;
  unknown: number;
}

export const veredictoHost: Record<EstadoHost, Veredicto> = {
  ok: 'normal',
  pending: 'vigilar',
  unknown: 'sin-dato',
};

export const etiquetaHost: Record<EstadoHost, string> = {
  ok: 'Apunta aquí',
  pending: 'Sin DNS',
  unknown: 'Sin dato',
};

export const usoHost: Record<UsoHost, string> = {
  autoconfig: 'Thunderbird y Android',
  autodiscover: 'Outlook',
  'mta-sts': 'Política MTA-STS',
};

/** Peor estado de un conjunto, para ordenar «fuera de rango primero». */
export function peorEstado(estados: EstadoHost[]): EstadoHost {
  if (estados.includes('pending')) return 'pending';
  if (estados.includes('unknown')) return 'unknown';
  return 'ok';
}

/* --------------------------------- Traefik --------------------------------- */

export interface ConfiguracionTraefik extends WhitelabelSetup {
  tokenFromEnv: boolean;
  panelUrl: string;
  underSkyway: boolean;
  /** URL que Traefik sondea para leer las rutas. */
  providerEndpoint: string;
  /** docker-compose.override.yml exacto, generado en el servidor. */
  overrideSnippet: string;
  autoconfig: { routingAvailable: boolean; routedHosts: number };
  skywayBridge: { minVersion: string; endpoint: string; note: string };
}

/* ------------------------------- Marca blanca ------------------------------ */

export const MAX_DOMINIOS_PROPIOS = 5;

/** Cuenta de Cloudflare conectada (la gestiona el área de Cloudflare). */
export interface CuentaCloudflare {
  id: string;
  clientId: string | null;
  label: string;
  tokenHint: string;
  createdAt: number;
  lastVerifiedAt: number | null;
  lastError: string | null;
  zones?: string[];
}

export interface ResultadoCloudflareMarcaBlanca {
  applied: { action: string; type: string; name: string }[];
  errors: { type: string; name: string; error: string }[];
  /** Lo que no se ha tocado (un conflicto sin confirmar), con el motivo. */
  skipped: { type: string; name: string; reason: string }[];
  domain: ClientDomain;
}

/**
 * Cuenta de Cloudflare con la que se puede crear el registro de un nombre:
 * la del propio cliente o una de la instancia y, si se conocen sus zonas,
 * solo si alguna contiene el nombre.
 */
export function cuentaCloudflarePara(
  cuentas: CuentaCloudflare[],
  clientId: string,
  hostname: string,
): CuentaCloudflare | undefined {
  return cuentas.find(
    (c) =>
      (c.clientId === null || c.clientId === clientId) &&
      (!c.zones || c.zones.some((z) => hostname === z || hostname.endsWith(`.${z}`))),
  );
}

/* ---------------------------- Datos de conexión ---------------------------- */

/** Respuesta ampliada de GET /api/mailboxes/:id/connection. */
export interface ConexionBuzon {
  email: string;
  username: string;
  imap: { host: string; port: number; security: string };
  smtp: { host: string; port: number; security: string };
  smtpAlt: { host: string; port: number; security: string };
  webmailUrl: string;
  autoconfig: { thunderbird: string; outlook: string; appleProfileUrl: string };
  portalUrl: string;
}
