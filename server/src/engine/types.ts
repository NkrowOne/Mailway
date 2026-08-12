/**
 * Contrato que debe cumplir cualquier motor de correo gestionado por Mailway.
 *
 * El panel nunca habla con el motor directamente desde las rutas: siempre a
 * través de esta interfaz. Así el motor es intercambiable (Stalwart hoy,
 * otro mañana) y el modo demostración puede funcionar sin servidor real.
 */
export interface MailEngine {
  readonly kind: 'stalwart' | 'demo';

  /** Comprueba conectividad y credenciales contra el motor. */
  ping(): Promise<EngineHealth>;

  createDomain(domain: string): Promise<void>;
  deleteDomain(domain: string): Promise<void>;

  /** Genera (si no existen) las claves DKIM del dominio. */
  ensureDkim(domain: string, selector: string): Promise<void>;

  /** Registros DNS que el motor espera para el dominio (MX, SPF, DKIM...). */
  getDnsRecords(domain: string): Promise<EngineDnsRecord[]>;

  createMailbox(input: CreateMailboxInput): Promise<void>;
  setMailboxPassword(email: string, password: string): Promise<void>;
  updateMailbox(email: string, patch: UpdateMailboxPatch): Promise<void>;
  deleteMailbox(email: string): Promise<void>;

  /** Crea o reemplaza un alias (lista de redirección). */
  upsertAlias(alias: string, destinations: string[]): Promise<void>;
  deleteAlias(alias: string): Promise<void>;

  /**
   * Añade una contraseña de aplicación al buzón (para el envío por API sin
   * tocar la contraseña principal del usuario). Devuelve el secreto tal y
   * como quedó almacenado en el motor, necesario para retirarlo al revocar.
   */
  addAppPassword(email: string, password: string, label: string): Promise<string>;
  removeAppPassword(email: string, storedSecret: string): Promise<void>;

  /** Resumen de la cola de salida, para el panel de administración. */
  getQueueSummary(): Promise<QueueSummary>;
}

export interface EngineHealth {
  ok: boolean;
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
  password: string;
  displayName?: string;
  quotaBytes?: number;
}

export interface UpdateMailboxPatch {
  displayName?: string;
  quotaBytes?: number;
  /** true = cuenta suspendida (no puede iniciar sesión). */
  suspended?: boolean;
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
