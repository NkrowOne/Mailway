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
 *
 * Usuario del motor y dirección: durante un cambio de dominio la dirección
 * vigente de un buzón (la nueva) y el usuario con el que entran sus
 * dispositivos (el viejo) pueden ser distintos. Stalwart 0.15 solo autentica
 * por el nombre del principal (`name`); en 0.16 el nombre de una cuenta es su
 * dirección principal (`name@dominio`). Por eso los métodos de buzón reciben
 * el USUARIO DEL MOTOR (`mailboxes.usuario_motor ?? local@dominio`, ver
 * modules/direcciones.ts), no la dirección vigente.
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
   * lo pide el panel, sin contraseñas de aplicación antiguas, pero solo si es
   * un buzón sin otras direcciones (el huérfano de un alta o un borrado
   * interrumpidos); si no, engine_exists: un usuario viejo que sigue en el
   * motor tras un cambio de dominio nunca debe pasar a otro buzón con su
   * correo.
   */
  createMailbox(input: CreateMailboxInput): Promise<void>;

  /**
   * Sustituye la contraseña principal (hash $6$…) y CONSERVA las contraseñas
   * de aplicación (dispositivos, Skyway, claves de API, formularios).
   */
  /** `login`: usuario del motor del buzón (no su dirección). */
  setMailboxPassword(login: string, passwordHash: string): Promise<void>;
  /** `login`: usuario del motor del buzón (no su dirección). */
  updateMailbox(login: string, patch: UpdateMailboxPatch): Promise<void>;
  /** `login`: usuario del motor del buzón (no su dirección). */
  deleteMailbox(login: string): Promise<void>;

  /**
   * Crea o reemplaza un alias (lista de redirección). `alias` es el nombre de
   * la lista en el motor. `destinations` son USUARIOS DEL MOTOR de buzones de
   * esta instancia (las rutas traducen cada dirección con `nombreEnMotor`);
   * `externalDestinations`, direcciones de fuera (reenvío a Gmail, a otro
   * proveedor…). Si la lista ya existe, solo cambian sus miembros: sus
   * direcciones (p. ej. las de la pre-recepción de un cambio de dominio) se
   * conservan. Al crearla, su única dirección es `alias`.
   */
  upsertAlias(alias: string, destinations: string[], externalDestinations?: string[]): Promise<void>;
  deleteAlias(alias: string): Promise<void>;

  /**
   * Lo que el motor guarda para que el buzón entre: el hash de la contraseña
   * principal, las contraseñas de aplicación y si está suspendido. Solo
   * Stalwart 0.15 lo expone (0.16 devuelve los secretos enmascarados): sirve
   * para capturar los hashes en la base de datos del panel antes de migrar.
   * null si el motor no puede darlo; engine_not_found si el buzón no existe.
   * `login`: usuario del motor del buzón (no su dirección).
   */
  readMailboxCredentials(login: string): Promise<MailboxCredentials | null>;

  /**
   * Lo que existe en el motor, en minúsculas y sin duplicados: dominios,
   * buzones (direcciones completas) y alias (direcciones de las listas). Solo
   * lectura. La provisión tras migrar lo usa para comprobar que no falta nada
   * de lo que tiene la base de datos del panel.
   */
  listDirectory(): Promise<EngineDirectory>;

  /**
   * Bytes ocupados por cada buzón, en una sola consulta. Las claves son los
   * usuarios del motor en minúsculas; un buzón ausente del mapa es
   * «desconocido», no «vacío».
   */
  getMailboxUsage(): Promise<Map<string, number>>;

  /**
   * Aplica lo que Mailway necesita del motor detrás de Traefik y junto a un
   * webmail: nombre del servidor, IP real por X-Forwarded-For, redes exentas
   * del baneo automático y, en 0.16, el límite de contraseñas de aplicación,
   * el puerto 587 con STARTTLS, el bloqueo del autoservicio del motor, la
   * caducidad del bloqueo por fallos de acceso y el CORS que necesita el
   * correo web nuevo (solo mientras algún cliente lo usa). Recarga la
   * configuración. Lo que no puede aplicarse sin reiniciar el contenedor (un
   * puerto nuevo) se devuelve en `restartRequired`.
   */
  applyRecommended(input: RecommendedInput): Promise<EngineReloadResult>;

  /**
   * Estado de lo que gestiona Mailway en el motor (Ajustes y puesta en
   * marcha). `permissiveCors` es lo que debería tener el motor (sin él, lo
   * último que se le pidió con applyRecommended).
   */
  getSettingsStatus(input: SettingsStatusInput): Promise<EngineSettingsStatus>;

  /**
   * Emisión del certificado con el ACME del propio motor (reto DNS-01 en
   * Cloudflare). Solo Stalwart 0.15: en 0.16 el certificado lo pone el
   * extractor de Traefik y esto responde engine_unsupported.
   */
  configureAcme(input: AcmeInput): Promise<EngineReloadResult>;

  /**
   * Token de Cloudflare con el que el ACME del propio motor renueva su
   * certificado (solo Stalwart 0.15; null si no hay o es otro proveedor).
   * Solo para compararlo dentro del panel con el de las cuentas conectadas
   * (¿cuál usa el motor?): nunca se registra ni se devuelve en una respuesta.
   */
  getAcmeToken(): Promise<string | null>;

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
   * `login`: usuario del motor del buzón (no su dirección).
   */
  addAppPassword(login: string, label: string, proposedSecret: string): Promise<CreatedAppPassword>;

  /**
   * Retira una contraseña de aplicación por su referencia (la de
   * addAppPassword). `login`: usuario del motor del buzón.
   */
  removeAppPassword(login: string, ref: string): Promise<void>;

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

  /* ----------------------------- Cambio de dominio ---------------------------- */

  /**
   * Principal por nombre (el usuario del motor de un buzón o la dirección de
   * un alias), sin secretos. null si no existe.
   */
  getPrincipal(name: string): Promise<EnginePrincipal | null>;

  /**
   * Lee y fusiona las direcciones de un principal (buzón o alias) y las escribe con UN
   * cambio: quita `remove`, añade al final las de `add` que falten y, con
   * `primary`, la pone la primera (añadiéndola si falta). Conserva las que no se mencionan.
   * Sin cambios no envía nada. No recarga. Devuelve la lista final.
   *
   * En 0.15 es un PATCH `set emails`. En 0.16 la primera dirección de una
   * cuenta o lista es siempre su nombre (con el que entra): `primary` solo
   * asegura que la dirección esté, sin cambiar ese nombre (eso lo hace
   * renamePrincipal), y las demás van en `aliases`. Al quitar una dirección,
   * las listas que la tenían como destino pasan a la principal del mismo
   * principal: en 0.16 los destinos son direcciones, y en 0.15 los miembros
   * van por id y no hace falta.
   * Errores: engine_not_found (principal o dominio de una dirección), engine_exists (dirección de otro).
   */
  setAddresses(name: string, ops: { add?: string[]; remove?: string[]; primary?: string }): Promise<string[]>;

  /**
   * Renombra conservando el id: el correo, las contraseñas (principal y de aplicación), los
   * filtros y la pertenencia a listas. En 0.15, UN PATCH atómico (manage.rs:2034-2059) con
   * `set name` y, si se pasa, `set emails`; nunca envía `members` (C21) y no recarga: la
   * autenticación lee NameToId. En 0.16, UN `x:Account/set` (o `x:MailingList/set`) con
   * `name`, `domainId` y `aliases`; los destinos de listas que apuntaban a una dirección que
   * deja de ser suya pasan a la nueva.
   * Idempotente: si `from` no existe y `to` existe con `expectEmail` entre sus direcciones, no hace nada.
   * `to` ocupado por otro principal → engine_exists. Ninguno de los dos → engine_not_found.
   */
  renamePrincipal(from: string, to: string, opts: { expectEmail: string; emails?: string[] }): Promise<void>;

  /**
   * Vacía la caché del directorio (0.15: GET /api/reload). Con errores en la respuesta:
   * HttpError 502 engine_error. En 0.16 el directorio no guarda en caché las direcciones que
   * no existen y no hay nada que recargar.
   */
  reloadDirectory(): Promise<void>;

  /**
   * Borra SOLO las claves DKIM del dominio exacto (nunca las de otro dominio cuyo nombre lo
   * contiene) y devuelve los ids borrados.
   * 0.15: lee las claves con GET /api/settings/keys?prefixes=signature, toma como ids los X
   * con signature.X.domain === domain, asigna cada clave al id más largo que la prefija (así
   * signature.rsa-d.es.mx.* no es de rsa-d.es), borra con POST /api/settings
   * [{type:'delete', keys}] y recarga. Recarga siempre, también sin claves que borrar: el
   * reintento tras una recarga fallida la completa.
   * 0.16: borra los `x:DkimSignature` con el `domainId` del dominio (sin dominio, nada).
   */
  removeDkim(domain: string): Promise<string[]>;
}

/** Principal del motor tal y como lo devuelve `getPrincipal` (sin secretos). */
export interface EnginePrincipal {
  /** Id interno (número en 0.15, texto en 0.16): se conserva al renombrar (el correo cuelga de él). */
  id: number | string;
  /** 'individual' (buzón) | 'list' (alias) | 'domain' | … */
  type: string;
  name: string;
  /** La primera es la principal; Stalwart omite el campo vacío o lo da como cadena. */
  emails: string[];
}

export interface RemoteDomainsResult {
  /** Se han escrito reglas nuevas en el motor. */
  changed: boolean;
  /** El motor tiene esas claves personalizadas: no se ha tocado nada. */
  customized: boolean;
  /**
   * Esta versión del motor no admite todavía estas reglas (Stalwart 0.16):
   * no se ha tocado nada y el panel lo avisa si hay dominios afectados.
   */
  unsupported?: boolean;
  /** Errores y avisos de la recarga (con errores, el motor no aplica nada nuevo). */
  errors: string[];
  warnings: string[];
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
  /**
   * true = cuenta suspendida: no puede iniciar sesión por ningún protocolo
   * (tampoco con sus contraseñas de aplicación), pero el correo le sigue
   * llegando. false = activa.
   */
  suspended?: boolean;
}

export interface MailboxCredentials {
  /** Hash $6$ de la contraseña principal, o null si el motor no tiene ninguno. */
  passwordHash: string | null;
  /** Contraseñas de aplicación tal como las guarda el motor. */
  appPasswords: { label: string; hash: string; ref: string }[];
  suspended: boolean;
}

export interface EngineDirectory {
  domains: string[];
  accounts: string[];
  lists: string[];
}

export interface RecommendedInput {
  /** Nombre del servidor de correo (MAIL_HOSTNAME), ya normalizado. */
  hostname: string;
  /** Redes exentas del baneo automático (la del webmail). */
  trustedNetworks: string[];
  /** Máximo de contraseñas de aplicación por buzón que debe admitir el motor. */
  maxAppPasswords: number;
  /**
   * CORS permisivo en la web del motor: true si algún cliente usa el correo
   * web nuevo (Bulwark), que habla JMAP con el motor desde el navegador y
   * desde otro origen. Si no, se quita: no se deja abierto sin necesidad.
   * Solo lo aplica Stalwart 0.16 (con 0.15 no hay correo web nuevo).
   */
  permissiveCors: boolean;
}

export interface SettingsStatusInput {
  trustedNetworks: string[];
  /** El CORS que debería tener el motor (ver RecommendedInput). */
  permissiveCors?: boolean;
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
   * aplicación, autoservicio bloqueado, caducidad del bloqueo, CORS…). Clave
   * estable → aplicado o no; una clave ausente no aplica en ese momento.
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

/**
 * Semántica común de `setAddresses` (driver y demostración): quita `remove`,
 * añade al final las de `add` que falten y, con `primary`, la pone la primera
 * (añadiéndola si falta). Todo en minúsculas y sin repetidos, como las guarda
 * Stalwart. Las que no se mencionan se conservan en su orden.
 */
export function fusionarDirecciones(
  actuales: string[],
  ops: { add?: string[]; remove?: string[]; primary?: string },
): string[] {
  const normal = (d: string) => d.trim().toLowerCase();
  const quitar = new Set((ops.remove ?? []).map(normal));
  const final: string[] = [];
  for (const d of actuales.map(normal)) if (d && !quitar.has(d) && !final.includes(d)) final.push(d);
  for (const d of (ops.add ?? []).map(normal)) if (d && !final.includes(d)) final.push(d);
  if (ops.primary) {
    const principal = normal(ops.primary);
    const i = final.indexOf(principal);
    if (i >= 0) final.splice(i, 1);
    final.unshift(principal);
  }
  return final;
}
