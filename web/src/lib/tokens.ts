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
  'auth.password_reset': 'Contraseña restablecida desde la terminal',
  // Puesta en marcha y ajustes
  'setup.admin_created': 'Administrador creado',
  'setup.engine_configured': 'Motor configurado',
  'setup.instance_configured': 'Identidad configurada',
  'setup.completed': 'Puesta en marcha completada',
  'settings.instance_updated': 'Ajustes de identidad actualizados',
  'settings.engine_updated': 'Ajustes del motor actualizados',
  // Motor de correo
  'engine.recommended_applied': 'Ajustes recomendados aplicados en el motor',
  'engine.acme_configured': 'Emisión del certificado configurada',
  'engine.certificate_reloaded': 'Certificado del motor recargado',
  'engine.maintenance_on': 'Mantenimiento del motor activado',
  'engine.maintenance_off': 'Mantenimiento del motor desactivado',
  'engine.credentials_captured': 'Contraseñas copiadas del motor antes de migrarlo',
  'engine.provisioned': 'Motor preparado tras su actualización',
  'engine.post_migration': 'Tareas posteriores a la actualización del motor',
  'engine.app_passwords_invalidated': 'Contraseñas de aplicación invalidadas por la actualización del motor',
  'engine.suspensions_repaired': 'Buzones suspendidos y alias corregidos en el motor',
  // Planes y clientes
  'plan.created': 'Plan creado',
  'plan.updated': 'Plan actualizado',
  'plan.deleted': 'Plan eliminado',
  'client.created': 'Cliente creado',
  'client.updated': 'Cliente actualizado',
  'client.suspended': 'Cliente suspendido',
  'client.resumed': 'Cliente reactivado',
  'client.deleted': 'Cliente eliminado',
  'client.external_linked': 'Cliente vinculado a una integración',
  'client.external_unlinked': 'Cliente desvinculado de la integración',
  'client.user_created': 'Usuario de panel creado',
  'client.user_updated': 'Usuario de panel actualizado',
  'client.user_deleted': 'Usuario de panel eliminado',
  // Dominios
  'domain.created': 'Dominio dado de alta',
  'domain.verified': 'Verificación de DNS',
  'domain.ownership_verified': 'Propiedad del dominio comprobada',
  'domain.dkim_regenerated': 'DKIM regenerado',
  'domain.zonefile_downloaded': 'Fichero de zona descargado',
  'domain.deleted': 'Dominio eliminado',
  'domain.delete_partial': 'Eliminación del dominio incompleta',
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
  // Portal del titular, webmail y autoconfiguración
  'portal.login': 'Acceso a «Mi buzón»',
  'portal.password_changed': 'Contraseña cambiada desde «Mi buzón»',
  'webmail.password_changed': 'Contraseña cambiada desde el webmail',
  'autoconfig.hosts_checked': 'Comprobación de los nombres de autoconfiguración',
  'autoconfig.profile_downloaded': 'Perfil de configuración descargado',
  // Automatización e integraciones
  'apikey.created': 'Clave de API creada',
  'apikey.revoked': 'Clave de API revocada',
  'token.created': 'Token de gestión creado',
  'token.revoked': 'Token de gestión revocado',
  'cloudflare.account_connected': 'Cuenta de Cloudflare conectada',
  'cloudflare.account_removed': 'Cuenta de Cloudflare retirada',
  'cloudflare.account_updated': 'Cuenta de Cloudflare actualizada',
  'cloudflare.account_token_replaced': 'Token de la cuenta de Cloudflare sustituido',
  'cloudflare.dns_applied': 'Registros DNS aplicados en Cloudflare',
  'cloudflare.instance_dns_applied': 'Registros DNS de la instancia aplicados en Cloudflare',
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
  delete: 'eliminación',
  partial: 'incompleta',
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
  suspended: 'suspendido',
  resumed: 'reactivado',
  reset: 'restablecido',
  sent: 'enviado',
  checked: 'comprobado',
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
  profile: 'perfil',
  host: 'nombre',
  hosts: 'nombres',
  domain: 'dominio',
  link: 'enlace',
  account: 'cuenta',
  settings: 'ajustes',
  certificate: 'certificado',
  ownership: 'propiedad',
  user: 'usuario',
  dns: 'DNS',
};

/**
 * Etiqueta de una acción. Las que el servidor añada en el futuro no deben
 * mostrarse como un código crudo: se nombran por su área y se traducen las
 * palabras conocidas («autoconfig.host_added» → «Autoconfiguración: nombre añadido»).
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

/**
 * Autor legible de una anotación. Las acciones del titular del buzón («Mi
 * buzón», webmail) no tienen usuario de panel: no las hizo el «Sistema», sino
 * la persona que usa el buzón.
 */
export function autorAnotacion(anotacion: {
  action: string;
  detail: Record<string, unknown>;
  actor?: { name: string; email: string | null; role: string } | null;
}): {
  texto: string;
  correo: string | null;
  titular: string | null;
} {
  const { actor, action, detail } = anotacion;
  if (actor) {
    if (actor.email) return { texto: actor.email, correo: actor.email, titular: actor.name };
    return {
      texto: actor.role === 'admin' ? 'Administración del servicio' : actor.name,
      correo: null,
      titular: null,
    };
  }
  const delTitular =
    action.startsWith('portal.') || action.startsWith('webmail.') || detail.via === 'portal';
  return { texto: delTitular ? 'Titular del buzón' : 'Sistema', correo: null, titular: null };
}

/** Claves internas del detalle que no aportan nada a quien lee el registro. */
const CLAVES_OCULTAS = new Set(['id', 'via', 'planFrom', 'planTo', 'replaceConflicts', 'trustedNetworks']);

/** Identificadores internos («mbx_73296258819c51d3», «cli_…»): nunca se enseñan. */
const ID_INTERNO = /^[a-z]{2,6}_[0-9a-f]{8,}$/i;

function esClaveOculta(clave: string): boolean {
  // clientId, mailboxId, linkId, appPasswordId, whitelabelDomainId…
  return CLAVES_OCULTAS.has(clave) || /Id$/.test(clave);
}

/** Rótulo antepuesto a algunos valores de texto para que se entiendan fuera de contexto. */
const ROTULOS_DETALLE: Record<string, string> = {
  sender: 'remite',
  externalRef: 'referencia',
  previous: 'antes',
  prefix: 'prefijo',
  owner: 'propietario',
  nivel: 'nivel',
  kind: 'tipo',
  expiresAt: 'caduca',
  status: 'estado',
  zone: 'zona',
  contact: 'contacto',
  url: 'dirección',
  hostname: 'nombre',
  displayName: 'nombre visible',
};

/** Recuentos: el número va con su unidad («2 destinos», «1 fallido»). */
const RECUENTOS: Record<string, [string, string]> = {
  destinations: ['destino', 'destinos'],
  external: ['externo', 'externos'],
  count: ['creado', 'creados'],
  failed: ['fallido', 'fallidos'],
  mailboxes: ['buzón', 'buzones'],
  applied: ['registro aplicado', 'registros aplicados'],
  errors: ['error', 'errores'],
  zones: ['zona', 'zonas'],
  checked: ['nombre comprobado', 'nombres comprobados'],
  ok: ['apunta aquí', 'apuntan aquí'],
  pending: ['sin DNS', 'sin DNS'],
  unknown: ['sin dato', 'sin dato'],
  aliasesUpdated: ['alias actualizado', 'alias actualizados'],
  aliasesDeleted: ['alias eliminado', 'alias eliminados'],
  removed: ['elemento eliminado', 'elementos eliminados'],
  apiKeys: ['clave de API afectada', 'claves de API afectadas'],
};

/** Recuentos que solo informan cuando no son cero (un «0 errores» sobra). */
const SOLO_SI_HAY = new Set([
  'external',
  'failed',
  'errors',
  'aliasesUpdated',
  'aliasesDeleted',
  'unknown',
  'pending',
  'apiKeys',
]);

/** Valores sí/no con significado propio: se nombran solo cuando aportan algo. */
const BOOLEANOS: Record<string, [string | null, string | null]> = {
  hasPassword: ['con contraseña', 'sin contraseña'],
  generated: ['contraseña generada', 'contraseña indicada'],
  passwordReset: ['contraseña restablecida', null],
  disabled: ['deshabilitado', 'habilitado'],
  recommendedApplied: ['ajustes recomendados aplicados', null],
  ownershipVerified: ['propiedad comprobada', null],
};

/** Listas de valores cuyo significado depende de la clave. */
const LISTAS: Record<string, string> = {
  failed: 'con error',
  removed: 'eliminados',
  zones: 'zonas',
  configured: 'canales',
  failures: 'sin entregar',
  fields: 'cambios',
  emails: '',
  destinations: '',
};

const CAMPOS_CLIENTE: Record<string, string> = {
  name: 'nombre',
  contactEmail: 'correo de contacto',
  planId: 'plan',
  notes: 'notas',
};

const ESTADOS: Record<string, string> = {
  active: 'activo',
  pending_dns: 'pendiente de DNS',
  issuing: 'emitiendo certificado',
  error: 'error',
  suspended: 'suspendido',
};

const TIPOS: Record<string, string> = {
  webmail: 'webmail',
  panel: 'panel',
  stalwart: 'Stalwart',
  demo: 'demostración',
};

const CANALES: Record<string, string> = { webhook: 'webhook', discord: 'Discord', telegram: 'Telegram' };

/** Horas de validez de un enlace, en días cuando son exactos («7 días»). */
function validez(horas: number): string {
  if (horas % 24 === 0) {
    const dias = horas / 24;
    return `validez ${dias} ${dias === 1 ? 'día' : 'días'}`;
  }
  return `validez ${horas} ${horas === 1 ? 'hora' : 'horas'}`;
}

function recuento(n: number, [uno, varios]: [string, string]): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/**
 * Detalle legible de una anotación: los valores útiles (dirección, dominio,
 * nombre…) en el orden en que se anotaron, sin ids internos ni estructuras, y
 * cada número con su unidad para que se entienda fuera de contexto.
 */
export function detalleAnotacion(detail: Record<string, unknown>): string[] {
  const partes: string[] = [];
  for (const [clave, valor] of Object.entries(detail)) {
    if (esClaveOculta(clave) || valor === null || valor === undefined || valor === '') continue;
    let texto: string | null = null;
    if (typeof valor === 'boolean') {
      const [si, no] = BOOLEANOS[clave] ?? [null, null];
      texto = valor ? si : no;
    } else if (typeof valor === 'number') {
      if (clave === 'expiresAt') texto = `caduca ${formatDay(valor)}`;
      else if (clave === 'ttlHours') texto = validez(valor);
      else if (clave === 'quotaMb') texto = `cuota ${valor >= 1024 ? `${Math.round((valor / 1024) * 10) / 10} GB` : `${valor} MB`}`;
      else if (RECUENTOS[clave]) texto = SOLO_SI_HAY.has(clave) && valor === 0 ? null : recuento(valor, RECUENTOS[clave]);
      // Un número sin unidad conocida no se entiende fuera de contexto.
      else texto = null;
    } else if (typeof valor === 'string') {
      if (ID_INTERNO.test(valor)) continue;
      if (clave === 'status') texto = ESTADOS[valor] ?? valor;
      else if (clave === 'kind') texto = TIPOS[valor] ?? valor;
      else if (clave === 'scope') texto = valor === 'instance' ? 'instancia' : null;
      else texto = valor;
      const rotulo = ROTULOS_DETALLE[clave];
      if (texto && rotulo && clave !== 'expiresAt') texto = `${rotulo} ${texto}`;
    } else if (Array.isArray(valor)) {
      const simples = valor
        .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
        .map((v) => String(v))
        .filter((v) => !ID_INTERNO.test(v))
        .map((v) => (clave === 'fields' ? (CAMPOS_CLIENTE[v] ?? v) : clave === 'configured' ? (CANALES[v] ?? v) : v));
      if (simples.length) {
        const rotulo = LISTAS[clave];
        texto = rotulo ? `${rotulo}: ${simples.join(', ')}` : simples.join(', ');
      } else if (clave === 'configured') {
        texto = 'sin canales';
      }
    }
    if (!texto || texto.length > 160) continue;
    partes.push(texto);
  }
  return partes;
}
