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

/** Dominio de correo con su nombre en ASCII y, si lo tiene, en Unicode (ñ, acentos). */
export interface DominioPadre {
  domain: string;
  domainUnicode?: string;
}

export interface SubdominioInterpretado {
  /** Lo que va delante del dominio de correo (webmail, correo.web…). */
  prefijo: string;
  /** Dominio de correo escrito al final del texto, si lo había. */
  padre: string | null;
  error: string | null;
}

/**
 * Lee el campo «Subdominio» del alta de un dominio propio. El resto del panel
 * enseña a escribir nombres completos, así que es esperable recibir
 * «webmail.panaderiasol.es» en lugar de «webmail»: si el texto termina en un
 * dominio de correo comprobado, se separa y se elige ese dominio. Con puntos
 * y sin terminar en ninguno («webmail.otrodominio.com»), concatenarlo daría
 * un nombre que nadie va a crear en el DNS (webmail.otrodominio.com.panaderiasol.es).
 */
export function interpretarSubdominio(
  texto: string,
  verificados: DominioPadre[],
  pendientes: DominioPadre[] = [],
): SubdominioInterpretado {
  const t = texto
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.+$/, '');
  if (!t.includes('.')) return { prefijo: t, padre: null, error: null };
  const nombres = (d: DominioPadre) => [d.domain, d.domainUnicode].filter((n): n is string => Boolean(n));
  const terminaEn = (d: DominioPadre) => nombres(d).find((n) => t === n || t.endsWith(`.${n}`)) ?? null;
  const soloSubdominio = 'Escribe solo el subdominio (por ejemplo, webmail): el dominio de correo se elige en la lista.';
  // El más largo primero, por si hay a la vez un dominio y un subdominio suyo.
  const candidatos = verificados
    .map((d) => ({ d, nombre: terminaEn(d) }))
    .filter((c): c is { d: DominioPadre; nombre: string } => c.nombre !== null)
    .sort((a, b) => b.nombre.length - a.nombre.length);
  const elegido = candidatos[0];
  if (elegido) {
    if (t === elegido.nombre) return { prefijo: '', padre: elegido.d.domain, error: soloSubdominio };
    return { prefijo: t.slice(0, -(elegido.nombre.length + 1)), padre: elegido.d.domain, error: null };
  }
  const pendiente = pendientes.find((d) => terminaEn(d) !== null);
  if (pendiente) {
    return {
      prefijo: t,
      padre: null,
      error: `${pendiente.domainUnicode || pendiente.domain} todavía no tiene la propiedad comprobada: compruébala en «Dominios» antes de usarlo.`,
    };
  }
  return { prefijo: t, padre: null, error: soloSubdominio };
}

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
