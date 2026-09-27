import { ApiError } from './api';

/*
  Tipos y utilidades del portal del titular del buzón (enlace de
  configuración y «Mi buzón») y del componente ConectarBuzon del panel.
*/

export interface PuntoConexion {
  host: string;
  port: number;
  security: string;
}

/** Forma de GET /api/mailboxes/:id/connection (los campos opcionales son ampliaciones). */
export interface DatosConexion {
  email: string;
  username: string;
  imap: PuntoConexion;
  smtp: PuntoConexion;
  smtpAlt: PuntoConexion;
  webmailUrl: string;
  autoconfig?: { thunderbird?: string; outlook?: string; appleProfileUrl?: string };
  portalUrl?: string;
}

/** GET /api/public/setup/:token */
export interface SetupPublico {
  email: string;
  displayName: string;
  brandName: string;
  connection: DatosConexion;
  password?: string;
  hasPassword: boolean;
  expiresAt: number;
  portalUrl: string;
  appleProfileUrl: string;
  thunderbirdAndroidQr: string;
}

/** GET /api/portal/me */
export interface PortalMe {
  email: string;
  displayName: string;
  domain: string;
  quotaMb: number;
  usedBytes: number | null;
  usageCheckedAt: number | null;
  brandName: string;
  connection: DatosConexion;
  webmailUrl: string;
  appleProfileUrl: string;
  thunderbirdAndroidQr: string;
}

export interface ContrasenaAplicacion {
  id: string;
  mailboxId: string;
  email: string;
  name: string;
  createdAt: number;
  revokedAt: number | null;
}

/** Fila de GET /api/mailboxes/:id/setup-links */
export interface EnlaceConfiguracion {
  id: string;
  createdAt: number;
  expiresAt: number;
  lastOpenedAt: number | null;
  revokedAt: number | null;
  hasPassword: boolean;
}

/** Respuesta de POST /api/mailboxes/:id/setup-links: la URL solo existe aquí. */
export interface EnlaceCreado {
  id: string;
  url: string;
  expiresAt: number;
  hasPassword: boolean;
}

/* ------------------------------ Dispositivo -------------------------------- */

export type Dispositivo = 'iphone' | 'mac' | 'android' | 'outlook' | 'thunderbird' | 'otros';

/**
 * Método más probable según el navegador desde el que se abre la página.
 * Solo ordena las pestañas: todas siguen disponibles, porque es habitual
 * abrir el enlace en el ordenador para configurar el móvil.
 */
export function detectarDispositivo(): Dispositivo {
  if (typeof navigator === 'undefined') return 'otros';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iphone';
  // iPadOS se presenta como un Mac de escritorio; lo delata la pantalla táctil.
  if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return 'iphone';
  if (/Android/i.test(ua)) return 'android';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/Windows/i.test(ua)) return 'outlook';
  if (/Linux|X11|CrOS/i.test(ua)) return 'thunderbird';
  return 'otros';
}

/** El QR solo sirve si se ve en otra pantalla: en el propio móvil no se puede escanear. */
export function esDispositivoMovil(): boolean {
  const d = detectarDispositivo();
  return d === 'iphone' || d === 'android';
}

/* ------------------------------- Utilidades -------------------------------- */

export function mensajeError(err: unknown, porDefecto: string): string {
  return err instanceof ApiError ? err.message : porDefecto;
}

/**
 * Copia al portapapeles con alternativa: la API moderna solo funciona en
 * contexto seguro (HTTPS), y un panel recién instalado puede estar en HTTP.
 * Devuelve si se copió de verdad, para no afirmar «Copiado» en falso.
 */
export async function copiarTexto(texto: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(texto);
      return true;
    }
  } catch {
    // Sin permiso: se intenta el método clásico.
  }
  try {
    const area = document.createElement('textarea');
    area.value = texto;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Descarga un fichero de una ruta autenticada con fetch + blob: un enlace
 * <a download> directo guardaría el JSON del error si la sesión ha caducado.
 */
export async function descargarFichero(url: string, nombrePorDefecto: string): Promise<void> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    let mensaje = `Error ${res.status} del servidor.`;
    let code = 'error';
    try {
      const data = (await res.json()) as { error?: string; code?: string };
      if (data.error) mensaje = data.error;
      if (data.code) code = data.code;
    } catch {
      // respuesta sin JSON
    }
    throw new ApiError(res.status, mensaje, code);
  }
  const blob = await res.blob();
  const disposicion = res.headers.get('content-disposition') || '';
  const nombre = /filename="?([^";]+)"?/i.exec(disposicion)?.[1] || nombrePorDefecto;
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** Tamaño legible en español (coma decimal). */
export function formatoBytes(bytes: number): string {
  const unidades = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let valor = bytes;
  let i = 0;
  while (valor >= 1024 && i < unidades.length - 1) {
    valor /= 1024;
    i += 1;
  }
  const texto = i === 0 ? String(valor) : valor.toLocaleString('es-ES', { maximumFractionDigits: 1 });
  return `${texto} ${unidades[i]}`;
}

/** Fecha y hora larga para textos dirigidos al titular («30 de septiembre, 10:15»). */
export function fechaLarga(ts: number): string {
  return new Date(ts).toLocaleString('es-ES', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Mensaje preparado para enviar el enlace desde el programa de correo de
 * quien administra. El destinatario queda en blanco a propósito: el titular
 * aún no tiene el buzón configurado, así que suele enviarse a otra dirección.
 */
export function mailtoEnlace(opts: { email: string; url: string; expiresAt: number; hasPassword: boolean }): string {
  const asunto = `Configuración de su correo ${opts.email}`;
  const lineas = [
    'Buenos días:',
    '',
    `Ya tiene disponible su buzón de correo ${opts.email}.`,
    '',
    'Para configurarlo en el móvil o en el ordenador, abra el siguiente enlace y siga las instrucciones para su dispositivo:',
    '',
    opts.url,
    '',
    `El enlace es válido hasta el ${fechaLarga(opts.expiresAt)}.`,
  ];
  if (opts.hasPassword) {
    lineas.push(
      'El enlace incluye la contraseña del buzón: no lo reenvíe a otras personas.',
    );
  }
  lineas.push('', 'Un saludo.');
  return `mailto:?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(lineas.join('\n'))}`;
}
