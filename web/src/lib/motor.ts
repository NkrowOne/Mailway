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

export interface EngineStatus {
  engine: { kind: 'stalwart' | 'demo' | null; error: string | null };
  hostname: { configured: string | null; expected: string | null; ok: boolean };
  trustedNetworks: string[];
  forwardedHeaders: boolean;
  recommendedApplied: boolean;
  tls: EngineTlsStatus;
  acme: EngineAcmeStatus;
  certificateFiles: boolean;
}

export interface RecommendedResult {
  applied: string[];
  hostname: string;
  errors: string[];
  warnings: string[];
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
  if (tls.error) return 'Sin medir';
  if (tls.selfSigned) return 'Autofirmado';
  if (tls.hostnameMatches === false) return 'Nombre incorrecto';
  if (tls.daysLeft !== null && tls.daysLeft < 0) return 'Caducado';
  return tls.issuer || 'Desconocido';
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
