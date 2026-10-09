/** Cliente HTTP del panel: errores en español listos para mostrar. */

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // respuesta no JSON
  }
  if (!res.ok) {
    const err = data as { error?: string; code?: string } | null;
    throw new ApiError(
      res.status,
      err?.error || `Error ${res.status} del servidor.`,
      err?.code || 'error',
    );
  }
  return data as T;
}

/**
 * Credenciales rechazadas. El panel y «Mi buzón» muestran el mismo texto, sea
 * cual sea la redacción de cada ruta del servidor.
 */
export function esCredencialIncorrecta(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'bad_credentials';
}

export const TEXTO_CREDENCIALES_INCORRECTAS = 'El correo electrónico o la contraseña no son correctos.';

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  delete: <T>(url: string) => request<T>('DELETE', url),
};

/* ------------------------------- Tipos ----------------------------------- */

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'client';
  clientId: string | null;
  /** Su contraseña la fija MAILWAY_ADMIN_PASSWORD en el entorno del panel (solo en /api/auth/me). */
  passwordFromEnv?: boolean;
}

export interface Plan {
  id: string;
  name: string;
  maxDomains: number;
  maxMailboxes: number;
  maxAliases: number;
  mailboxQuotaMb: number;
  apiDailyLimit: number;
  apiPerMinuteLimit: number;
  notes: string;
  /** Clientes que usan el plan (solo en GET /api/plans). */
  clientCount?: number;
}

export interface ClientUsage {
  domains: number;
  mailboxes: number;
  aliases: number;
  apiKeys: number;
  messagesLast30d: number;
}

export interface Client {
  id: string;
  name: string;
  slug: string;
  contactEmail: string;
  planId: string;
  suspended: boolean;
  notes: string;
  createdAt: number;
  /** Referencia en un sistema externo; «skyway:…» si lo gestiona Skyway. */
  externalRef: string | null;
  /** Correo web de sus webmail propios: Roundcube o el nuevo (beta). Servidores anteriores no lo envían. */
  webmailMotor?: 'roundcube' | 'bulwark';
  plan?: Plan;
  usage?: ClientUsage;
  users?: { id: string; email: string; name: string; disabled: boolean; lastLoginAt: number | null }[];
}

export type CheckStatus = 'ok' | 'missing' | 'mismatch' | 'unknown';

export interface DnsCheck {
  id: string;
  label: string;
  type: string;
  name: string;
  expected: string;
  found: string | null;
  status: CheckStatus;
  required: boolean;
  help: string;
  /** El motor no ha generado este registro obligatorio: no hay valor que copiar. */
  engineMissing?: boolean;
}

export interface DomainRecord {
  id: string;
  clientId: string;
  domain: string;
  status: 'pending_dns' | 'active' | 'error';
  dkimSelector: string;
  dnsStatus: {
    checks?: DnsCheck[];
    requiredTotal?: number;
    requiredOk?: number;
    allRequiredOk?: boolean;
    checkedAt?: number;
  };
  lastCheckedAt: number | null;
  verifiedAt: number | null;
  /** Nombre legible si es un dominio internacional (se guarda en punycode). */
  domainUnicode?: string;
  /** Zona de Cloudflare donde Mailway gestiona su DNS, si la hay. */
  cloudflare?: { accountId: string; zoneId: string } | null;
  dnsAppliedAt?: number | null;
  /**
   * Cuándo se comprobó que el cliente controla el dominio (registro TXT).
   * null = pendiente: el servidor rechaza buzones y alias con 409
   * `domain_ownership_pending`. Sin el campo (servidor anterior), se da por
   * comprobada.
   */
  ownershipVerifiedAt?: number | null;
  /** Registro TXT que demuestra la propiedad del dominio. */
  ownershipRecord?: { type: 'TXT'; name: string; content: string };
  createdAt: number;
}

export interface Mailbox {
  id: string;
  domainId: string;
  domain: string;
  localPart: string;
  email: string;
  displayName: string;
  quotaMb: number;
  status: 'active' | 'suspended';
  createdAt: number;
  /** Bytes ocupados según el motor; null = sin dato. */
  usedBytes: number | null;
  usageCheckedAt?: number | null;
  /** Cuándo se subió la foto del titular; null = sin foto. Va en la URL (?v=) para invalidar la caché. */
  photoUpdatedAt: number | null;
  /**
   * Cuándo demostró su titular que tiene acceso (terminó el enlace de
   * configuración, instaló el perfil, entró en «Mi buzón» o en el webmail) o
   * se marcó a mano como configurado; null = sin configurar.
   */
  configuredAt: number | null;
  /** Entrega de la configuración: último enlace, última apertura y último correo enviado. */
  setup: EntregaConfiguracion;
  clientId?: string;
  clientName?: string;
}

export interface EntregaConfiguracion {
  lastLinkAt: number | null;
  lastOpenedAt: number | null;
  lastEmail: { to: string; at: number; status: 'sent' | 'failed' } | null;
}

export interface Alias {
  id: string;
  domainId: string;
  localPart: string;
  email: string;
  /** Todos los destinos, en minúsculas (internos y externos). */
  destinations: string[];
  /** Los destinos que no son buzones de esta instancia (reenvío externo). */
  externalDestinations?: string[];
  domain?: string;
  clientId?: string;
  clientName?: string;
  createdAt: number;
}

export interface ApiKeyInfo {
  id: string;
  clientId: string;
  name: string;
  prefix: string;
  senderMailboxId: string;
  senderEmail: string;
  dailyLimit: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  usedToday: number;
}

/**
 * Bloque listo para copiar que acompaña a una credencial recién creada
 * (POST /api/apikeys, POST …/app-passwords). Solo llega en esa respuesta.
 */
export interface BloqueVariables {
  id: 'env' | 'node' | 'laravel' | 'django';
  label: string;
  language: 'dotenv' | 'javascript' | 'php' | 'python';
  filename: string;
  content: string;
}

/** Formulario de contacto para webs estáticas (GET /api/forms). */
export interface FormInfo {
  id: string;
  clientId: string;
  name: string;
  /** Clave pública (mwf_…): va en el HTML de la web. */
  publicKey: string;
  recipientMailboxId: string;
  recipientEmail: string;
  allowedOrigins: string[];
  subject: string;
  /** Solo la clave de sitio; el secreto nunca llega al navegador. */
  turnstile: { siteKey: string } | null;
  enabled: boolean;
  submissionsCount: number;
  lastSubmissionAt: number | null;
  createdAt: number;
  updatedAt: number;
  endpoint: string;
  embedHtml: string;
}

export interface Message {
  id: string;
  clientId: string;
  apiKeyId: string | null;
  /** Formulario del que salió el mensaje, si no vino de la API. */
  formId?: string | null;
  /** Origen del envío; se conserva aunque el formulario se elimine después. */
  source?: 'api' | 'form';
  from: string;
  to: string[];
  subject: string;
  status: 'sent' | 'failed';
  error: string;
  messageId: string;
  sizeBytes: number;
  createdAt: number;
}

export interface EngineDnsRecord {
  type: string;
  name: string;
  content: string;
}

export interface Recommendation {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
}

export interface ServerHealth {
  mailHostname: string;
  publicIp: string;
  hostnameResolves: boolean | null;
  hostnameIps: string[];
  /** AAAA del nombre del servidor: null = no se pudo consultar; [] = solo IPv4. */
  hostnameIpv6?: string[] | null;
  /** Las IPv6 del nombre son de este servidor (su inverso apunta a él); null = sin dato. */
  ipv6Ok?: boolean | null;
  ptr: string[] | null;
  ptrOk: boolean | null;
  dnsbl: { zone: string; label: string; status: 'clean' | 'listed' | 'inconclusive'; detail: string }[];
  score: number;
  recommendations: Recommendation[];
  checkedAt: number;
}

/**
 * GET /api/setup/status. Con la instalación terminada y sin sesión, el
 * servidor solo devuelve `setupComplete`, `hasAdmin`, `requiresSetupToken` y
 * la marca: el resto de campos es opcional y cada vista debe tolerar que falte.
 */
export interface SetupStatus {
  setupComplete: boolean;
  hasAdmin: boolean;
  /** El instalador fijó un token que exige el alta del administrador. */
  requiresSetupToken?: boolean;
  /** Hay un motor definido en el entorno que se puede conectar con un clic. */
  engineFromEnv?: boolean;
  engineConfigured?: boolean;
  demoMode?: boolean;
  engineDefaults?: {
    url: string;
    adminUser: string;
    hasPassword: boolean;
    smtpHost: string;
    smtpPort: number;
  };
  instance: Partial<InstanceSettings> & { brandName: string };
}

export interface InstanceSettings {
  brandName: string;
  mailHostname: string;
  publicIp: string;
  webmailUrl: string;
  systemFrom: string;
  panelUrl: string;
}

export interface AdminDashboard {
  totals: {
    clients: number;
    domains: number;
    domainsActive: number;
    mailboxes: number;
    apiKeys: number;
  };
  messages: { last24h: number; failed24h: number; last30d: number };
  /** Salud del motor y API de gestión detectada (rest015, jmap016 o demo). */
  engine: { ok: boolean; api?: 'rest015' | 'jmap016' | 'demo'; detail?: string };
  queue: { pending: number; oldestSeconds: number | null };
  instance: InstanceSettings;
  /** El correo web nuevo (Bulwark), si está configurado; null o ausente si no. */
  bulwark?: ResumenCorreoWebNuevo | null;
}

/** Estado del correo web nuevo para el panel de control (GET /api/dashboard/admin). */
export interface ResumenCorreoWebNuevo {
  disponible: boolean;
  motivo: string | null;
  /** Disponible y con Stalwart 0.16: los webmail de sus clientes van a Bulwark. */
  enServicio: boolean;
  salud: { ok: boolean; detalle: string | null };
  clientes: number;
  sincronizacion: SincronizacionCorreoWeb;
}

export interface SincronizacionCorreoWeb {
  pendiente: boolean;
  aplicadaEn: number | null;
  error: { mensaje: string; codigo: string } | null;
  reintentarDesde: number | null;
  clavesFijadas: string[];
}

export interface ClientDashboard {
  client: { id: string; name: string; suspended: boolean };
  plan: Plan;
  usage: ClientUsage;
  domains: DomainRecord[];
  messages: { last7d: number; failed7d: number };
  onboarding: {
    hasDomain: boolean;
    hasActiveDomain: boolean;
    hasMailbox: boolean;
    hasApiKey: boolean;
    hasSentMessage: boolean;
    /** Algún dominio tiene la propiedad comprobada: ya admite buzones y alias. */
    ownershipVerified: boolean;
    /** Todos los dominios con la propiedad comprobada tienen postmaster@ y abuse@. */
    hasEssentialAddresses: boolean;
    /** Buzones del cliente (los mismos que `usage.mailboxes`). */
    mailboxes: number;
  };
  webmailUrl: string;
}

/**
 * Enlace de configuración creado junto con su buzón en un alta masiva
 * (POST /api/mailboxes/bulk con `setupLinks`). Lleva la contraseña dentro y
 * su URL solo existe en esa respuesta.
 */
export interface EnlaceAltaMasiva {
  id: string;
  url: string;
  expiresAt: number;
  hasPassword: boolean;
}

/** Línea de resultado del alta masiva con su enlace de configuración, si se pidió. */
export type ConEnlace<T> = T & { setupLink?: EnlaceAltaMasiva };

/**
 * postmaster@ o abuse@ de un dominio (GET/PUT /api/domains/:id/essential-addresses).
 * `kind: null` = todavía no existe; `mailbox` = hay un buzón con ese nombre y
 * ya entrega por sí mismo.
 */
export interface DireccionObligatoria {
  localPart: 'postmaster' | 'abuse';
  email: string;
  kind: 'alias' | 'mailbox' | null;
  destinations: string[];
}

export interface AuditEntry {
  id: number;
  userId: string | null;
  clientId: string | null;
  action: string;
  detail: Record<string, unknown>;
  ip: string;
  createdAt: number;
  /** Autor legible (el correo solo lo ve la administración). */
  actor?: { name: string; email: string | null; role: string };
  clientName?: string | null;
}

export type WhitelabelStatus = 'pending_dns' | 'issuing' | 'active' | 'error';

export interface ClientDomain {
  isPrimary: boolean;
  id: string;
  clientId: string;
  hostname: string;
  kind: 'webmail' | 'panel';
  status: WhitelabelStatus;
  detail: string;
  lastCheckedAt: number | null;
  activatedAt: number | null;
  createdAt: number;
  /** Lo dio de alta el webmail automático (no una persona). */
  automatico: boolean;
}

export interface DnsInstruction {
  type: 'A' | 'CNAME';
  name: string;
  value: string;
  recommended: boolean;
  help: string;
}

export interface WhitelabelSetup {
  lastPollAt: number | null;
  token: string;
  certResolver: string;
  webmailBackend: string;
  panelBackend: string;
  panelDomainsAvailable: boolean;
  publishedDomains: number;
}

export interface Alert {
  id: number;
  severity: 'critical' | 'warning' | 'info';
  type: string;
  clientId: string | null;
  title: string;
  message: string;
  remedy: string;
  createdAt: number;
  resolvedAt: number | null;
}

export interface NotifyChannelsView {
  webhookUrl: string;
  discordUrl: string;
  telegramChat: string;
  hasTelegramToken: boolean;
}

export interface ConnectionInfo {
  email: string;
  username: string;
  imap: { host: string; port: number; security: string };
  smtp: { host: string; port: number; security: string };
  smtpAlt: { host: string; port: number; security: string };
  webmailUrl: string;
  /** Direcciones de autoconfiguración y perfil de Apple (ruta autenticada). */
  autoconfig?: { thunderbird: string; outlook: string; appleProfileUrl: string };
  /** «Mi buzón» del titular. */
  portalUrl?: string;
}
