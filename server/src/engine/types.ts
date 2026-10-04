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

  /**
   * Crea o reemplaza un alias (lista de redirección). `destinations` son
   * buzones de esta instancia; `externalDestinations`, direcciones de fuera
   * (reenvío a Gmail, a otro proveedor…).
   */
  upsertAlias(alias: string, destinations: string[], externalDestinations?: string[]): Promise<void>;
  deleteAlias(alias: string): Promise<void>;

  /**
   * Comprueba la contraseña de un buzón SIN pedirle al motor que autentique
   * (los fallos contarían para su baneo automático de IPs). true = correcta,
   * false = incorrecta o buzón suspendido, null = no se pudo comprobar.
   */
  verifyCredentials(email: string, password: string): Promise<boolean | null>;

  /**
   * Bytes ocupados por cada buzón, en una sola consulta. Las claves van en
   * minúsculas; un buzón ausente del mapa es «desconocido», no «vacío».
   */
  getMailboxUsage(): Promise<Map<string, number>>;

  /**
   * Escribe ajustes del servidor del motor (clave → valor) y los recarga.
   * Lo usa la puesta en marcha para fijar el nombre del servidor, la
   * confianza en el proxy y los rangos exentos de baneo.
   */
  applyServerSettings(values: Record<string, string>): Promise<EngineReloadResult>;

  /** Lee ajustes del servidor del motor por prefijo (p. ej. "server.hostname"). */
  getServerSettings(keys: string[]): Promise<Record<string, string>>;

  /**
   * Nombre con el que el motor se anuncia DE VERDAD: el destino del MX de los
   * registros que genera para los dominios, en minúsculas y sin punto final.
   * Puede no coincidir con el `server.hostname` guardado: una recarga
   * pendiente o la configuración local del motor lo fijan a otro. null si no
   * propone ningún MX.
   */
  getRunningHostname(): Promise<string | null>;

  /** Recarga los certificados TLS (tras una renovación). */
  reloadCertificates(): Promise<void>;

  /**
   * Añade una contraseña de aplicación al buzón (para el envío por API sin
   * tocar la contraseña principal del usuario). Devuelve el secreto tal y
   * como quedó almacenado en el motor, necesario para retirarlo al revocar.
   */
  addAppPassword(email: string, password: string, label: string): Promise<string>;
  removeAppPassword(email: string, storedSecret: string): Promise<void>;

  /** Resumen de la cola de salida, para el panel de administración. */
  getQueueSummary(): Promise<QueueSummary>;

  /**
   * Dominios con buzones aquí que reciben su correo en otro servidor (su MX
   * público apunta a otro proveedor): lo que se envía desde este servidor a
   * sus direcciones debe salir por ese MX y no entregarse en local. Recibe
   * la lista completa y deja el motor exactamente así (lista vacía = sin
   * reglas). `reload` fuerza la recarga aunque no haya cambios (la anterior
   * falló). Nunca sobrescribe una configuración personalizada del motor.
   */
  syncRemoteDomains(domains: string[], opts?: { reload?: boolean }): Promise<RemoteDomainsResult>;

  /** Principal por nombre, sin secretos. null si no existe (engine_not_found). */
  getPrincipal(name: string): Promise<EnginePrincipal | null>;

  /**
   * Lee y fusiona las direcciones de un principal (buzón o alias) y las escribe con UN
   * PATCH `set emails`: quita `remove`, añade al final las de `add` que falten y, con
   * `primary`, la pone la primera (añadiéndola si falta). Conserva las que no se mencionan.
   * Sin cambios no envía nada. No recarga. Devuelve la lista final.
   * Errores: engine_not_found (principal o dominio de una dirección), engine_exists (dirección de otro).
   */
  setAddresses(name: string, ops: { add?: string[]; remove?: string[]; primary?: string }): Promise<string[]>;

  /**
   * Renombra conservando el id: el correo, las contraseñas ($6$ y $app$), los filtros y la
   * pertenencia a listas. UN PATCH atómico (manage.rs:2034-2059) con `set name` y, si se pasa,
   * `set emails`. Nunca envía `members` (C21). No recarga: la autenticación lee NameToId.
   * Idempotente: si `from` no existe y `to` existe con `expectEmail` entre sus direcciones, no hace nada.
   * `to` ocupado por otro principal → engine_exists. Ninguno de los dos → engine_not_found.
   */
  renamePrincipal(from: string, to: string, opts: { expectEmail: string; emails?: string[] }): Promise<void>;

  /** GET /api/reload (vacía la caché del directorio). Con errores en la respuesta: HttpError 502 engine_error. */
  reloadDirectory(): Promise<void>;

  /**
   * Borra SOLO las claves DKIM del dominio exacto. Lee las claves con
   * GET /api/settings/keys?prefixes=signature, toma como ids los X con signature.X.domain === domain,
   * asigna cada clave al id más largo que la prefija (así signature.rsa-d.es.mx.* no es de rsa-d.es),
   * borra con POST /api/settings [{type:'delete', keys}] y recarga. Devuelve los ids borrados.
   */
  removeDkim(domain: string): Promise<string[]>;
}

export interface EnginePrincipal {
  id: number;
  type: string;        // 'individual' | 'list' | 'domain' | …
  name: string;
  emails: string[];    // la primera es la principal; Stalwart omite el campo vacío o lo da como cadena
}

export interface RemoteDomainsResult {
  /** Se han escrito reglas nuevas en el motor. */
  changed: boolean;
  /** El motor tiene esas claves personalizadas: no se ha tocado nada. */
  customized: boolean;
  /** Errores y avisos de la recarga (con errores, el motor no aplica nada nuevo). */
  errors: string[];
  warnings: string[];
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

export interface EngineReloadResult {
  errors: string[];
  warnings: string[];
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
