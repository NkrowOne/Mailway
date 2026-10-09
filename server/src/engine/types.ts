/**
 * Contrato que debe cumplir cualquier motor de correo gestionado por Mailway.
 *
 * El panel nunca habla con el motor directamente desde las rutas: siempre a
 * través de esta interfaz. Así el motor es intercambiable (Stalwart 0.15 por
 * su API REST, Stalwart 0.16 por JMAP, otro mañana) y el modo demostración
 * puede funcionar sin servidor real.
 *
 * El contrato habla de OPERACIONES (aplicar los ajustes recomendados, crear
 * una contraseña de aplicación), no de claves de configuración: cada versión
 * del motor guarda lo mismo de forma distinta (claves en 0.15, objetos en
 * 0.16) y el panel no debe depender de ninguna de las dos.
 */
export interface MailEngine {
  readonly kind: 'stalwart' | 'demo';

  /**
   * API de gestión que habla el motor. En Stalwart se averigua preguntando
   * al propio motor (la primera vez y cuando su ruta base deja de existir,
   * porque el motor se ha migrado con el panel en marcha).
   */
  detectApi(): Promise<EngineApi>;

  /** Comprueba conectividad y credenciales contra el motor. */
  ping(): Promise<EngineHealth>;

  createDomain(domain: string): Promise<void>;
  deleteDomain(domain: string): Promise<void>;

  /** Genera (si no existen) las claves DKIM del dominio. */
  ensureDkim(domain: string, selector: string): Promise<void>;

  /** Registros DNS que el motor espera para el dominio (MX, SPF, DKIM...). */
  getDnsRecords(domain: string): Promise<EngineDnsRecord[]>;

  /**
   * Alta de un buzón con la contraseña YA cifrada en sha512-crypt ($6$…).
   * El hash lo calcula el panel, que lo guarda también para comprobar
   * contraseñas sin preguntar al motor (ver modules/credenciales.ts).
   * Si el buzón ya existe en el motor (huérfano), se adopta y se deja como
   * lo pide el panel, sin contraseñas de aplicación antiguas.
   */
  createMailbox(input: CreateMailboxInput): Promise<void>;

  /**
   * Sustituye la contraseña principal (hash $6$…) y CONSERVA las contraseñas
   * de aplicación (dispositivos, Skyway, claves de API, formularios).
   */
  setMailboxPassword(email: string, passwordHash: string): Promise<void>;
  updateMailbox(email: string, patch: UpdateMailboxPatch): Promise<void>;
  deleteMailbox(email: string): Promise<void>;

  /**
   * Crea o reemplaza un alias (lista de redirección). `destinations` son
   * buzones de esta instancia; `externalDestinations`, direcciones de fuera
   * (reenvío a Gmail, a otro proveedor…).
   */
  upsertAlias(alias: string, destinations: string[], externalDestinations?: string[]): Promise<void>;
  deleteAlias(alias: string): Promise<void>;

  /**
   * Lo que el motor guarda para que el buzón entre: el hash de la contraseña
   * principal, las contraseñas de aplicación y si está suspendido. Solo
   * Stalwart 0.15 lo expone (0.16 devuelve los secretos enmascarados): sirve
   * para capturar los hashes en la base de datos del panel antes de migrar.
   * null si el motor no puede darlo; engine_not_found si el buzón no existe.
   */
  readMailboxCredentials(email: string): Promise<MailboxCredentials | null>;

  /**
   * Bytes ocupados por cada buzón, en una sola consulta. Las claves van en
   * minúsculas; un buzón ausente del mapa es «desconocido», no «vacío».
   */
  getMailboxUsage(): Promise<Map<string, number>>;

  /**
   * Aplica lo que Mailway necesita del motor detrás de Traefik y junto a un
   * webmail: nombre del servidor, IP real por X-Forwarded-For, redes exentas
   * del baneo automático y, en 0.16, el límite de contraseñas de aplicación,
   * el puerto 587 con STARTTLS y el bloqueo del autoservicio del motor.
   * Recarga la configuración. Lo que no puede aplicarse sin reiniciar el
   * contenedor (un puerto nuevo) se devuelve en `restartRequired`.
   */
  applyRecommended(input: RecommendedInput): Promise<EngineReloadResult>;

  /** Estado de lo que gestiona Mailway en el motor (Ajustes y puesta en marcha). */
  getSettingsStatus(input: { trustedNetworks: string[] }): Promise<EngineSettingsStatus>;

  /**
   * Emisión del certificado con el ACME del propio motor (reto DNS-01 en
   * Cloudflare). Solo Stalwart 0.15: en 0.16 el certificado lo pone el
   * extractor de Traefik y esto responde engine_unsupported.
   */
  configureAcme(input: AcmeInput): Promise<EngineReloadResult>;

  /**
   * Nombre con el que el motor se anuncia DE VERDAD: el destino del MX de los
   * registros que genera para los dominios, en minúsculas y sin punto final.
   * Puede no coincidir con el nombre guardado: una recarga pendiente o la
   * configuración local del motor lo fijan a otro. null si no propone ningún
   * MX.
   */
  getRunningHostname(): Promise<string | null>;

  /** Recarga los certificados TLS (tras una renovación). */
  reloadCertificates(): Promise<void>;

  /**
   * Crea una contraseña de aplicación en el buzón. `proposedSecret` es la que
   * propone Mailway; el motor puede imponer la suya (Stalwart 0.16 la genera
   * él, con el formato app_…). Devuelve la que vale DE VERDAD, en claro y una
   * sola vez, y la referencia opaca con la que se retira.
   */
  addAppPassword(email: string, label: string, proposedSecret: string): Promise<CreatedAppPassword>;

  /** Retira una contraseña de aplicación por su referencia (la de addAppPassword). */
  removeAppPassword(email: string, ref: string): Promise<void>;

  /** Resumen de la cola de salida, para el panel de administración. */
  getQueueSummary(): Promise<QueueSummary>;
}

/**
 * API de gestión del motor:
 * - `rest015`: Stalwart 0.15, API REST en `/api/*`.
 * - `jmap016`: Stalwart 0.16, gestión por JMAP en `/jmap` (objetos `x:`).
 * - `demo`: motor de demostración en memoria.
 */
export type EngineApi = 'rest015' | 'jmap016' | 'demo';

export interface EngineHealth {
  ok: boolean;
  /** API detectada, si se llegó a saber. */
  api?: EngineApi;
  version?: string;
  detail?: string;
}

export interface EngineDnsRecord {
  type: string;
  name: string;
  content: string;
}

export interface CreateMailboxInput {
  email: string;
  /** Contraseña principal cifrada en sha512-crypt ($6$…). */
  passwordHash: string;
  displayName?: string;
  quotaBytes?: number;
}

export interface UpdateMailboxPatch {
  displayName?: string;
  quotaBytes?: number;
  /** true = cuenta suspendida (no puede iniciar sesión; el correo sigue entrando). */
  suspended?: boolean;
}

export interface MailboxCredentials {
  /** Hash $6$ de la contraseña principal, o null si el motor no tiene ninguno. */
  passwordHash: string | null;
  /** Contraseñas de aplicación tal como las guarda el motor. */
  appPasswords: { label: string; hash: string; ref: string }[];
  suspended: boolean;
}

export interface RecommendedInput {
  /** Nombre del servidor de correo (MAIL_HOSTNAME), ya normalizado. */
  hostname: string;
  /** Redes exentas del baneo automático (la del webmail). */
  trustedNetworks: string[];
  /** Máximo de contraseñas de aplicación por buzón que debe admitir el motor. */
  maxAppPasswords: number;
}

export interface EngineSettingsStatus {
  api: EngineApi;
  /** Nombre del servidor guardado en el motor (no el que usa en ejecución). */
  hostname: string | null;
  /** El motor toma la IP real de X-Forwarded-For. */
  forwardedHeaders: boolean;
  /** Redes de las pedidas que el motor ya exime del baneo. */
  trustedNetworks: string[];
  /** ACME propio del motor (solo 0.15), o null si no hay. */
  acme: EngineAcmeStatus | null;
  /** El motor sirve el certificado por fichero que deja el extractor de Traefik. */
  certificateFiles: boolean;
  /**
   * Comprobaciones propias de cada versión que forman parte de «ajustes
   * recomendados aplicados» (en 0.16: puerto 587, límite de contraseñas de
   * aplicación, autoservicio bloqueado…). Clave estable → aplicado o no.
   */
  extra: Record<string, boolean>;
  /** Cambios guardados que solo se aplican al reiniciar el contenedor. */
  restartRequired: string[];
}

export interface EngineAcmeStatus {
  directory: string | null;
  challenge: string | null;
  provider: string | null;
  contact: string | null;
  domain: string | null;
  zone: string | null;
}

export interface AcmeInput {
  directory: string;
  /** Token de Cloudflare (DNS-01). Nunca se registra ni se devuelve. */
  token: string;
  contact: string;
  /** Nombre del servidor de correo para el que se pide el certificado. */
  hostname: string;
  /** Zona DNS de Cloudflare que contiene el nombre. */
  zone: string;
}

export interface CreatedAppPassword {
  /** Contraseña en claro: la que se entrega al usuario o se guarda cifrada. */
  secret: string;
  /** Referencia opaca para retirarla después (no es un secreto utilizable). */
  ref: string;
}

export interface EngineReloadResult {
  errors: string[];
  warnings: string[];
  /** Cambios guardados que exigen reiniciar el contenedor del motor. */
  restartRequired?: string[];
}

export interface QueueSummary {
  pending: number;
  oldestSeconds: number | null;
}

/** Configuración persistida del motor (en settings, credenciales cifradas). */
export interface EngineSettings {
  kind: 'stalwart' | 'demo';
  url: string;
  adminUser: string;
  adminPassword: string;
  /** Host SMTP para envíos de la API transaccional (submission). */
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}
