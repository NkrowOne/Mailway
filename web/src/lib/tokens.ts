import type { Veredicto } from '../ui/kit';
import { formatDay } from './format';

/*
  Tipos y utilidades de los tokens de gestión (Conexiones) y del registro de
  actividad. Viven aquí y no en lib/api.ts para no tocar un fichero común.
*/

/* --------------------------- Tokens de gestión ---------------------------- */

export type EstadoToken = 'active' | 'expired' | 'revoked';

export interface TokenGestion {
  id: string;
  name: string;
  /** Prefijo visible: el token es `mwt_<prefix>_<secreto>`. */
  prefix: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastUsedIp: string;
  revokedAt: number | null;
  status: EstadoToken;
  userId: string;
  ownerEmail: string;
  ownerName: string;
  ownerRole: 'admin' | 'client';
  ownerClientId: string | null;
  ownerClientName: string | null;
  /** El token con el que se hizo la petición (solo al usar la API con un token). */
  current: boolean;
}

export interface TokenCreado {
  /** El token completo: la API lo devuelve una sola vez. */
  token: string;
  info: TokenGestion;
}

/** Opciones de caducidad del formulario; null = sin caducidad. */
export const CADUCIDADES: { valor: string; dias: number | null; texto: string }[] = [
  { valor: '30', dias: 30, texto: '30 días' },
  { valor: '90', dias: 90, texto: '90 días' },
  { valor: '365', dias: 365, texto: '365 días' },
  { valor: 'nunca', dias: null, texto: 'Sin caducidad' },
];

/** Con menos margen que este, la caducidad se señala para renovar a tiempo. */
const AVISO_CADUCIDAD_MS = 14 * 24 * 3600_000;

/** Veredicto y texto del estado de un token, para la tabla reglada. */
export function veredictoToken(
  token: TokenGestion,
  ahora: number,
): { veredicto: Veredicto; texto: string } {
  if (token.status === 'revoked') return { veredicto: 'sin-dato', texto: 'Revocado' };
  // Un token caducado hace fallar a la integración que lo use: fuera de rango.
  if (token.status === 'expired') return { veredicto: 'fuera', texto: 'Caducado' };
  if (token.expiresAt !== null && token.expiresAt - ahora <= AVISO_CADUCIDAD_MS) {
    return { veredicto: 'vigilar', texto: 'Caduca pronto' };
  }
  return { veredicto: 'normal', texto: 'Activo' };
}

/** Forma visible de un token sin revelar su secreto. */
export function tokenEnmascarado(prefix: string): string {
  return `mwt_${prefix}_••••`;
}

/* ---------------------------- Registro de actividad ----------------------- */

export interface ActorAnotacion {
  name: string;
  /** Null cuando quien consulta es un cliente y actuó la administración. */
  email: string | null;
  role: 'admin' | 'client';
}

export interface AnotacionActividad {
  id: number;
  userId: string | null;
  clientId: string | null;
  action: string;
  detail: Record<string, unknown>;
  ip: string;
  createdAt: number;
  actor: ActorAnotacion | null;
  clientName: string | null;
}

export interface PaginaActividad {
  entries: AnotacionActividad[];
  /** Id desde el que pedir la página siguiente, o null si no hay más. */
  nextBefore: number | null;
}

/** Nombre legible de cada acción auditada por el servidor. */
const ETIQUETAS: Record<string, string> = {
  // Sesión y cuenta
  'auth.login': 'Inicio de sesión',
  'auth.logout': 'Cierre de sesión',
  'auth.password_changed': 'Cambio de contraseña',
  // Puesta en marcha y ajustes
  'setup.admin_created': 'Administrador creado',
  'setup.engine_configured': 'Motor configurado',
  'setup.instance_configured': 'Identidad configurada',
  'setup.completed': 'Puesta en marcha completada',
  'settings.instance_updated': 'Ajustes de identidad actualizados',
  'settings.engine_updated': 'Ajustes del motor actualizados',
  // Motor de correo
  'engine.recommended_applied': 'Ajustes recomendados del motor aplicados',
  'engine.acme_configured': 'Certificado automático del motor configurado',
  'engine.certificate_reloaded': 'Certificado del motor recargado',
  // Planes y clientes
  'plan.created': 'Plan creado',
  'plan.updated': 'Plan actualizado',
  'plan.deleted': 'Plan eliminado',
  'client.created': 'Cliente creado',
  'client.updated': 'Cliente actualizado',
  'client.deleted': 'Cliente eliminado',
  'client.external_linked': 'Cliente vinculado a una integración',
  'client.external_unlinked': 'Cliente desvinculado de la integración',
  'client.user_created': 'Usuario de panel creado',
  'client.user_updated': 'Usuario de panel actualizado',
  'client.user_deleted': 'Usuario de panel eliminado',
  // Dominios
  'domain.created': 'Dominio dado de alta',
  'domain.verified': 'Verificación de DNS',
  'domain.dkim_regenerated': 'DKIM regenerado',
  'domain.zonefile_downloaded': 'Fichero de zona descargado',
  'domain.deleted': 'Dominio eliminado',
  // Buzones y alias
  'mailbox.created': 'Buzón creado',
  'mailbox.bulk_created': 'Alta masiva de buzones',
  'mailbox.updated': 'Buzón actualizado',
  'mailbox.password_reset': 'Contraseña de buzón restablecida',
  'mailbox.deleted': 'Buzón eliminado',
  'mailbox.setup_link_created': 'Enlace de configuración creado',
  'mailbox.setup_link_revoked': 'Enlace de configuración revocado',
  'mailbox.app_password_created': 'Contraseña de aplicación creada',
  'mailbox.app_password_revoked': 'Contraseña de aplicación revocada',
  'alias.created': 'Alias creado',
  'alias.updated': 'Alias actualizado',
  'alias.deleted': 'Alias eliminado',
  // Portal del titular y webmail
  'portal.login': 'Acceso a «Mi buzón»',
  'portal.password_changed': 'Contraseña cambiada desde «Mi buzón»',
  'webmail.password_changed': 'Contraseña cambiada desde el webmail',
  // Automatización e integraciones
  'apikey.created': 'Clave de API creada',
  'apikey.revoked': 'Clave de API revocada',
  'token.created': 'Token de gestión creado',
  'token.revoked': 'Token de gestión revocado',
  'cloudflare.account_connected': 'Cuenta de Cloudflare conectada',
  'cloudflare.account_removed': 'Cuenta de Cloudflare retirada',
  'cloudflare.dns_applied': 'Registros DNS aplicados en Cloudflare',
  // Marca blanca
  'whitelabel.domain_created': 'Dominio de marca blanca dado de alta',
  'whitelabel.domain_verified': 'Dominio de marca blanca verificado',
  'whitelabel.domain_deleted': 'Dominio de marca blanca eliminado',
  // Vigilancia
  'alert.dismissed': 'Aviso descartado',
  'notify.channels_updated': 'Canales de aviso actualizados',
  'notify.test_sent': 'Aviso de prueba enviado',
};

/** Áreas conocidas, para nombrar acciones nuevas que aún no tienen etiqueta. */
const AREAS: Record<string, string> = {
  auth: 'Sesión',
  setup: 'Puesta en marcha',
  settings: 'Ajustes',
  engine: 'Motor de correo',
  plan: 'Plan',
  client: 'Cliente',
  domain: 'Dominio',
  mailbox: 'Buzón',
  alias: 'Alias',
  portal: '«Mi buzón»',
  webmail: 'Webmail',
  apikey: 'Clave de API',
  token: 'Token de gestión',
  cloudflare: 'Cloudflare',
  autoconfig: 'Autoconfiguración',
  whitelabel: 'Marca blanca',
  alert: 'Aviso',
  notify: 'Avisos',
  integration: 'Integración',
};

/** Vocabulario habitual de los nombres de acción, para la traducción aproximada. */
const PALABRAS: Record<string, string> = {
  created: 'creado',
  deleted: 'eliminado',
  updated: 'actualizado',
  revoked: 'revocado',
  verified: 'verificado',
  applied: 'aplicado',
  changed: 'cambiado',
  added: 'añadido',
  removed: 'retirado',
  connected: 'conectado',
  disconnected: 'desconectado',
  enabled: 'activado',
  disabled: 'desactivado',
  reset: 'restablecido',
  sent: 'enviado',
  downloaded: 'descargado',
  dismissed: 'descartado',
  configured: 'configurado',
  reloaded: 'recargado',
  refreshed: 'actualizado',
  linked: 'vinculado',
  unlinked: 'desvinculado',
  login: 'inicio de sesión',
  logout: 'cierre de sesión',
  password: 'contraseña',
  host: 'host',
  hosts: 'hosts',
  domain: 'dominio',
  link: 'enlace',
  account: 'cuenta',
  settings: 'ajustes',
  certificate: 'certificado',
  user: 'usuario',
  dns: 'DNS',
};

/**
 * Etiqueta de una acción. Las que el servidor añada en el futuro no deben
 * mostrarse como un código crudo: se nombran por su área y se traducen las
 * palabras conocidas («autoconfig.host_added» → «Autoconfiguración: host añadido»).
 */
export function etiquetaAccion(action: string): string {
  const conocida = ETIQUETAS[action];
  if (conocida) return conocida;
  const [area = '', ...resto] = action.split('.');
  const nombreArea = AREAS[area] ?? (area ? area.charAt(0).toUpperCase() + area.slice(1) : 'Acción');
  const accion = resto
    .join(' ')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((palabra) => PALABRAS[palabra.toLowerCase()] ?? palabra)
    .join(' ');
  return accion ? `${nombreArea}: ${accion}` : nombreArea;
}

/** Nombre del token con el que se hizo la acción (detalle `via: 'token:<nombre>'`). */
export function tokenDeAnotacion(detail: Record<string, unknown>): string | null {
  const via = detail.via;
  if (typeof via !== 'string' || !via.startsWith('token:')) return null;
  return via.slice('token:'.length) || null;
}

/** Claves internas del detalle que no aportan nada a quien lee el registro. */
const CLAVES_OCULTAS = new Set(['id', 'clientId', 'userId', 'tokenId', 'via']);

/** Rótulo antepuesto a algunos valores para que se entiendan fuera de contexto. */
const ROTULOS_DETALLE: Record<string, string> = {
  sender: 'remite',
  externalRef: 'referencia',
  previous: 'antes',
  prefix: 'prefijo',
  owner: 'titular',
  nivel: 'nivel',
  kind: 'tipo',
  mailboxes: 'buzones',
  expiresAt: 'caduca',
  count: 'total',
  status: 'estado',
};

const ESTADOS: Record<string, string> = {
  active: 'activo',
  pending_dns: 'pendiente de DNS',
  issuing: 'emitiendo certificado',
  error: 'error',
  suspended: 'suspendido',
};

/**
 * Detalle legible de una anotación: los valores útiles (dirección, dominio,
 * nombre…) en el orden en que se anotaron, sin ids internos ni estructuras.
 */
export function detalleAnotacion(detail: Record<string, unknown>): string[] {
  const partes: string[] = [];
  for (const [clave, valor] of Object.entries(detail)) {
    if (CLAVES_OCULTAS.has(clave) || valor === null || valor === undefined || valor === '') continue;
    let texto: string | null = null;
    if (clave === 'expiresAt' && typeof valor === 'number') texto = formatDay(valor);
    else if (clave === 'status' && typeof valor === 'string') texto = ESTADOS[valor] ?? valor;
    else if (typeof valor === 'string' || typeof valor === 'number') texto = String(valor);
    else if (Array.isArray(valor)) {
      const simples = valor.filter((v) => typeof v === 'string' || typeof v === 'number');
      if (simples.length) texto = simples.join(', ');
    }
    if (!texto || texto.length > 120) continue;
    const rotulo = ROTULOS_DETALLE[clave];
    partes.push(rotulo ? `${rotulo} ${texto}` : texto);
  }
  return partes;
}
