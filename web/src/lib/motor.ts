import type { Veredicto } from '../ui/kit';

/*
  Tipos y lecturas del servidor de correo (motor), compartidos por la hoja
  «Servidor de correo» de Ajustes y el resumen final de la puesta en marcha.
*/

export interface EngineTlsStatus {
  host: string;
  port: number;
  ok: boolean;
  issuer: string | null;
  subject: string | null;
  validFrom: string | null;
  validTo: string | null;
  daysLeft: number | null;
  selfSigned: boolean;
  hostnameMatches: boolean | null;
  authorizationError: string | null;
  via: 'publico' | 'interno' | null;
  publicError?: string;
  error?: string;
}

export interface EngineAcmeStatus {
  configured: boolean;
  provider: string | null;
  challenge?: string | null;
  contact?: string | null;
  domain?: string | null;
  zone?: string | null;
  accountId?: string | null;
  accountLabel?: string | null;
}

/** API de gestión del motor: Stalwart 0.15 (REST), Stalwart 0.16 (JMAP) o demostración. */
export type EngineApi = 'rest015' | 'jmap016' | 'demo';

/** Nombre del motor y de su API, tal y como se enseña en Ajustes. */
export function nombreMotor(api: EngineApi | null | undefined): string {
  if (api === 'rest015') return 'Stalwart 0.15 (API REST)';
  if (api === 'jmap016') return 'Stalwart 0.16 (JMAP)';
  if (api === 'demo') return 'Demostración';
  return 'Versión sin determinar';
}

/** Comprobación propia de la versión del motor (en 0.16: puerto 587, límite de contraseñas…). */
export interface ComprobacionMotor {
  key: string;
  label: string;
  ok: boolean;
}

export interface EngineStatus {
  engine: { kind: 'stalwart' | 'demo' | null; error: string | null };
  /** API detectada; null si el motor no respondió. */
  api: EngineApi | null;
  hostname: {
    /** `server.hostname` guardado en el motor. */
    configured: string | null;
    /** El de Ajustes → Identidad del servidor. */
    expected: string | null;
    /** Lo guardado en el motor coincide con lo de Ajustes. */
    ok: boolean;
    /** Nombre con el que el motor se anuncia de verdad (destino de su MX). */
    running?: string | null;
    /** El nombre en ejecución coincide con el de Ajustes; null si no se pudo comparar. */
    runningOk?: boolean | null;
    runningError?: string | null;
  };
  trustedNetworks: string[];
  forwardedHeaders: boolean;
  recommendedApplied: boolean;
  /** Comprobaciones propias de la versión, con su nombre. */
  extraChecks: ComprobacionMotor[];
  /** Cambios guardados que solo se aplican al reiniciar el contenedor del motor. */
  restartRequired: string[];
  tls: EngineTlsStatus;
  acme: EngineAcmeStatus;
  /** false con Stalwart 0.16: el certificado lo pone el extractor de Traefik. */
  acmeSupported: boolean;
  certificateFiles: boolean;
  /** Modo mantenimiento del motor (su cambio de versión). */
  maintenance: { active: boolean; until: number | null };
}

export interface RecommendedResult {
  applied: string[];
  hostname: string;
  /** Nombre en ejecución tras recargar; null si no se pudo leer. */
  running?: string | null;
  errors: string[];
  warnings: string[];
  /** Lo que el motor solo aplica al reiniciar su contenedor. */
  restartRequired?: string[];
}

export interface PlatformDnsRecord {
  role: 'mail' | 'panel' | 'webmail';
  host: string;
  expected: string | null;
  found: string[] | null;
  status: 'ok' | 'missing' | 'mismatch' | 'unknown';
}

export interface PlatformDns {
  publicIp: string | null;
  records: PlatformDnsRecord[];
  ptr: { ip: string; expected: string; found: string[] | null; status: PlatformDnsRecord['status'] } | null;
}

/** Cuenta de Cloudflare tal y como la lista Conexiones (solo lo que se usa aquí). */
export interface CuentaCloudflare {
  id: string;
  clientId: string | null;
  label: string;
  tokenHint: string;
  lastError: string;
}

/** Orden de lectura del parte: primero lo que está fuera de rango. */
export const ORDEN_VEREDICTO: Record<Veredicto, number> = { fuera: 0, vigilar: 1, 'sin-dato': 2, normal: 3 };

/** Veredicto del certificado: autofirmado o a menos de 7 días, fuera; a menos de 20, vigilar. */
export function veredictoTls(tls: EngineTlsStatus): Veredicto {
  if (tls.error) return 'sin-dato';
  if (tls.selfSigned || tls.hostnameMatches === false || tls.authorizationError) return 'fuera';
  if (tls.daysLeft === null) return 'sin-dato';
  if (tls.daysLeft < 7) return 'fuera';
  if (tls.daysLeft < 20) return 'vigilar';
  return 'normal';
}

/** Lectura en una línea del certificado, para la columna de valor. */
export function resumenTls(tls: EngineTlsStatus): string {
  if (tls.error) return 'Sin comprobar';
  if (tls.selfSigned) return 'Autofirmado';
  if (tls.hostnameMatches === false) return 'Nombre incorrecto';
  if (tls.daysLeft !== null && tls.daysLeft < 0) return 'Caducado';
  return tls.issuer || 'Desconocido';
}

/**
 * Veredicto del nombre con el que el motor se anuncia de verdad: fuera de
 * rango si no es el de Ajustes; sin dato si no se pudo leer; vigilar si en
 * Ajustes no hay nombre con el que compararlo.
 */
export function veredictoEnEjecucion(data: EngineStatus): Veredicto {
  const h = data.hostname;
  if (data.engine.error || h.runningError || !h.running) return 'sin-dato';
  if (h.runningOk === true) return 'normal';
  if (h.runningOk === false) return 'fuera';
  return 'vigilar';
}

/** Explicación del nombre en ejecución cuando no está en rango. */
export function notaEnEjecucion(data: EngineStatus): string | undefined {
  const h = data.hostname;
  // Con el motor sin responder ya hay una banda de error en la hoja.
  if (data.engine.error) return undefined;
  if (h.runningError) return `No se ha podido leer el nombre con el que se anuncia el motor: ${h.runningError}`;
  if (!h.running) return 'El motor no ha propuesto ningún registro MX, así que no se sabe con qué nombre se anuncia.';
  if (h.runningOk === true) return undefined;
  if (h.runningOk !== false) {
    return 'Indica el nombre del servidor de correo en «Identidad del servidor» para compararlo con el que usa el motor.';
  }
  if (h.configured && h.configured === h.expected) {
    return `El motor tiene guardado ${h.expected}, pero sigue anunciándose como ${h.running} en los registros que genera: la recarga no se ha aplicado o su configuración local (config.toml o las variables del contenedor) fija otro nombre. Corrígela y reinicia el motor, o vuelve a aplicar los ajustes recomendados.`;
  }
  return `El motor se anuncia como ${h.running}: los registros MX y SRV que propone a los dominios apuntan a ese nombre y no a ${h.expected}. Aplica los ajustes recomendados para fijarlo.`;
}

export function veredictoDns(status: PlatformDnsRecord['status']): Veredicto {
  return status === 'ok' ? 'normal' : status === 'unknown' ? 'sin-dato' : 'fuera';
}

export const textoDns: Record<PlatformDnsRecord['status'], string> = {
  ok: 'Correcto',
  missing: 'No existe',
  mismatch: 'Otra IP',
  unknown: 'Sin dato',
};

/** GET /api/settings/mail-hostname/impact: lo que arrastra cambiar el nombre del servidor. */
export interface ImpactoCambioNombre {
  /** Nombre con el que se anuncia hoy el motor (o el de Ajustes). */
  actual: string;
  nuevo: string;
  dominios: { total: number; conMxAlActual: number };
  registroA: { ips: string[] | null; ip: string; apuntaAqui: boolean | null };
  ptr: { ip: string; nombres: string[] | null; coincide: boolean | null } | null;
  certificado: { cubre: boolean | null; detalle: string };
  comando: string;
  cambiaDominioBase: boolean;
}
