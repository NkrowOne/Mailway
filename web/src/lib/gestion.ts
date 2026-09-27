/**
 * Tipos y utilidades de la gestión de clientes, planes, buzones y alias.
 * Viven aparte de lib/api.ts para no mezclar áreas; los tipos compartidos
 * (Mailbox, Alias, Client, Plan) siguen en lib/api.ts.
 */
import { ApiError, type Client, type Mailbox, type Plan } from './api';

/* --------------------------------- Tipos ---------------------------------- */

export interface AppPasswordInfo {
  id: string;
  mailboxId: string;
  email: string;
  name: string;
  createdAt: number;
  revokedAt: number | null;
}

export interface ClientUser {
  id: string;
  email: string;
  name: string;
  disabled: boolean;
  lastLoginAt: number | null;
}

export interface ClientDetail extends Client {
  plan: Plan;
  users: ClientUser[];
}

export interface SuspensionResult {
  updated: number;
  skipped: number;
  failed: { email: string; error: string }[];
}

export interface BulkEntryResult {
  localPart: string;
  email: string;
  displayName: string;
  ok: boolean;
  error?: string;
  mailbox?: Mailbox;
  password?: string;
}

export interface BulkCapacity {
  used: number;
  max: number;
  remaining: number;
}

export interface BulkPreview {
  dryRun: true;
  capacity: BulkCapacity;
  valid: number;
  exceedsPlan: boolean;
  results: BulkEntryResult[];
}

export interface BulkResponse {
  results: BulkEntryResult[];
  created: number;
  failed: number;
  capacity: BulkCapacity;
}

/* ------------------------------- Utilidades ------------------------------- */

/** Mensaje de un error de la API listo para mostrar, o el genérico indicado. */
export function mensajeDe(err: unknown, generico: string): string {
  return err instanceof ApiError ? err.message : generico;
}

const numero = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });

/** Bytes en la unidad legible más cercana (formato español: coma decimal). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${numero.format(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${numero.format(mb)} MB`;
  return `${numero.format(mb / 1024)} GB`;
}

/** Megabytes de una cuota en MB o GB, en formato español. */
export function formatQuota(mb: number): string {
  if (mb >= 1024) return `${numero.format(mb / 1024)} GB`;
  return `${mb} MB`;
}

export type VeredictoUso = 'normal' | 'vigilar' | 'fuera' | 'sin-dato';

/**
 * Veredicto de ocupación: a partir del 80 % hay que vigilar; al llenarse, el
 * buzón deja de recibir correo. Sin dato del motor, no se finge un veredicto.
 */
export function veredictoUso(usedBytes: number | null, quotaMb: number): VeredictoUso {
  if (usedBytes === null || quotaMb <= 0) return 'sin-dato';
  const ratio = usedBytes / (quotaMb * 1024 * 1024);
  if (ratio >= 1) return 'fuera';
  if (ratio >= 0.8) return 'vigilar';
  return 'normal';
}

/** Orden «fuera de rango primero» de DESIGN.md. */
export const ordenVeredicto: Record<VeredictoUso, number> = {
  fuera: 0,
  vigilar: 1,
  'sin-dato': 2,
  normal: 3,
};

/** Mismas reglas que el servidor para el nombre de un buzón o alias. */
const LOCAL_PART_RE = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;

export function errorNombreBuzon(local: string): string | null {
  if (!local) return 'Falta el nombre.';
  if (!LOCAL_PART_RE.test(local)) {
    return 'Solo letras sin tilde, números, puntos, guiones y guiones bajos; sin símbolo al principio ni al final.';
  }
  if (local.includes('..')) return 'No puede contener dos puntos seguidos.';
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function esCorreoValido(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

export interface LineaAlta {
  linea: number;
  localPart: string;
  displayName: string;
  error: string | null;
}

/**
 * Interpreta la lista pegada del alta masiva: una dirección por línea,
 * «nombre» o «nombre, Nombre visible». Admite también «;» o tabulador (lo
 * que se pega desde una hoja de cálculo) y la dirección completa si es del
 * dominio elegido. Las líneas vacías o que empiezan por «#» se ignoran.
 */
export function parsearLista(texto: string, dominio: string): LineaAlta[] {
  const out: LineaAlta[] = [];
  texto.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [first = '', ...rest] = line.split(/[,;\t]/);
    let localPart = first.trim().toLowerCase();
    const displayName = rest.join(' ').replace(/\s+/g, ' ').trim();
    let error: string | null = null;
    if (localPart.includes('@')) {
      const [local = '', domain = ''] = localPart.split('@');
      if (dominio && domain !== dominio.toLowerCase()) {
        error = `La dirección no es del dominio ${dominio}.`;
      }
      localPart = local;
    }
    error = error ?? errorNombreBuzon(localPart);
    if (!error && displayName.length > 80) error = 'El nombre visible no puede superar los 80 caracteres.';
    out.push({ linea: i + 1, localPart, displayName, error });
  });
  const vistos = new Set<string>();
  for (const entrada of out) {
    if (!entrada.error && vistos.has(entrada.localPart)) entrada.error = 'Repetida en la lista.';
    vistos.add(entrada.localPart);
  }
  return out;
}

function campoCsv(value: string): string {
  return /[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * CSV de credenciales para Excel en español: separador «;» y BOM UTF-8 (sin
 * él, Excel lee mal las tildes y mete todo en una columna).
 */
export function csvCredenciales(filas: { email: string; displayName: string; password: string }[]): string {
  const cabecera = ['direccion', 'nombre_visible', 'contrasena'];
  const lineas = filas.map((f) => [f.email, f.displayName, f.password].map(campoCsv).join(';'));
  return `﻿${[cabecera.join(';'), ...lineas].join('\r\n')}\r\n`;
}

/** Descarga un texto como fichero sin pasar por el servidor. */
export function descargarTexto(nombre: string, contenido: string, tipo = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([contenido], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Se libera después: algunos navegadores aún están leyendo el blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** true si el cliente lo gestiona Skyway (referencia «skyway:…»). */
export function vinculadoConSkyway(externalRef: string | null | undefined): boolean {
  return Boolean(externalRef && externalRef.startsWith('skyway:'));
}
