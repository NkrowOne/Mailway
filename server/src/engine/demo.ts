import { HttpError } from '../core/errors';
import { normalizeHostname } from '../core/hostnames';
import { sha512Crypt } from '../core/sha512crypt';
import {
  fusionarDirecciones,
  type AcmeInput,
  type CreatedAppPassword,
  type CreateMailboxInput,
  type EngineAcmeStatus,
  type EngineApi,
  type EngineDirectory,
  type EngineDnsRecord,
  type EngineHealth,
  type EnginePrincipal,
  type EngineReloadResult,
  type EngineSettingsStatus,
  type MailboxCredentials,
  type MailEngine,
  type QueueSummary,
  type RecommendedInput,
  type RemoteDomainsResult,
  type SettingsStatusInput,
  type UpdateMailboxPatch,
} from './types';
import { normalizarDominiosRemotos } from './recepcion';

/**
 * Principal del motor de demostración, con el modelo de Stalwart: un número
 * interno del que cuelga todo (correo, contraseñas, pertenencia a listas), un
 * nombre (el usuario con el que se entra) y unas direcciones (la primera es la
 * principal). Renombrar solo cambia el nombre.
 */
interface PrincipalDemo {
  id: number;
  type: 'individual' | 'list';
  name: string;
  description: string;
  quota: number;
  emails: string[];
  /** Contraseña principal ($6$, como mucho una) y contraseñas de aplicación ($app$…). */
  secrets: string[];
  /**
   * Cuenta suspendida: no inicia sesión, pero sigue recibiendo y en sus
   * listas (como en el motor real: se le quita `authenticate`, nunca el rol).
   */
  suspendido: boolean;
  /** Miembros de una lista, por id (como en el motor: sobreviven al renombrado). */
  members: number[];
  externalMembers: string[];
}

interface FalloInyectado {
  metodo: string;
  nombre?: string;
}

const normal = (valor: string) => valor.trim().toLowerCase();

function dominioDe(direccion: string): string {
  return direccion.slice(direccion.lastIndexOf('@') + 1);
}

/** Mismo formato que los «notFound» del driver de Stalwart. */
function noEncontrado(item: string): HttpError {
  return new HttpError(502, `El motor de correo no encuentra el elemento (${item}).`, 'engine_not_found');
}

/** Mismo formato que los «fieldAlreadyExists» del driver de Stalwart. */
function yaExiste(valor: string): HttpError {
  return new HttpError(502, `El motor de correo ya tiene ese elemento «${valor}».`, 'engine_exists');
}

/**
 * Motor de demostración: no habla con ningún servidor real. Permite probar el
 * panel completo (clientes, dominios, buzones, claves de API) sin desplegar
 * Stalwart. Los envíos de la API se registran pero no salen a Internet.
 *
 * Guarda en memoria lo que recibe (como lo guardaría Stalwart 0.15) para que
 * las pruebas puedan comprobar qué le llega: los hashes de los buzones, las
 * contraseñas de aplicación, las suspensiones y los ajustes recomendados. Es
 * un modelo de principales con la semántica del driver (nombres y
 * direcciones únicos, renombrado que conserva el id y las contraseñas,
 * direcciones que exigen su dominio), para que el cambio de dominio se pueda
 * probar de punta a punta sin motor real. Como vive en memoria, tras
 * reiniciar el panel recrea al tocarlos los buzones que olvidó (ver `buzon`);
 * las contraseñas se siguen comprobando con la copia del panel
 * (modules/credenciales.ts).
 */
export class DemoEngine implements MailEngine {
  readonly kind = 'demo' as const;

  private readonly principales = new Map<number, PrincipalDemo>();
  private readonly porNombre = new Map<string, number>();
  private readonly porDireccion = new Map<string, number>();
  private siguienteId = 1;
  private recommended: RecommendedInput | null = null;
  private acme: EngineAcmeStatus | null = null;
  /** Token del ACME (solo para getAcmeToken: el estado nunca lo devuelve). */
  private acmeToken: string | null = null;
  /** Claves DKIM: id (rsa-<dominio>, ed25519-<dominio>) → dominio. */
  private readonly dkim = new Map<string, string>();
  private readonly fallos: FalloInyectado[] = [];

  /** Dominios dados de alta en el motor (createDomain / deleteDomain). */
  readonly dominios = new Set<string>();

  /* ------------------------- Ganchos para las pruebas ------------------------- */

  /** Hay cambios de direcciones o de nombres que el motor real no vería hasta recargar. */
  cambiosSinRecargar = false;
  /** Recargas del directorio (reloadDirectory). */
  recargas = 0;
  /** Dominios para los que se ha llamado a removeDkim, en orden (tenga o no claves). */
  dkimBorrados: string[] = [];
  /** Dominios que el motor de demostración «entrega por MX» (para las pruebas). */
  remoteDomains: string[] = [];

  /**
   * Nombre del principal (buzón o lista) que recibe el correo de esa
   * dirección, o null si el motor lo rechazaría: dirección desconocida o
   * dominio que no está dado de alta («Relay not allowed»).
   */
  entregar(direccion: string): string | null {
    const dir = normal(direccion);
    if (!this.dominios.has(dominioDe(dir))) return null;
    const id = this.porDireccion.get(dir);
    return id === undefined ? null : (this.principales.get(id)?.name ?? null);
  }

  /** ¿Puede quien entra como `login` enviar con remitente `from`? Su nombre o una de sus direcciones (must-match-sender). */
  puedeEnviarComo(login: string, from: string): boolean {
    const p = this.buscar(login);
    if (!p || p.type !== 'individual' || p.suspendido) return false;
    const remitente = normal(from);
    return remitente === p.name || p.emails.includes(remitente);
  }

  /**
   * La siguiente llamada a `metodo` (y, si se indica, con ese nombre como
   * primer argumento) falla con engine_error. Se consume al dispararse.
   */
  fallarProxima(metodo: string, nombre?: string): void {
    this.fallos.push({ metodo, nombre });
  }

  /**
   * Olvida todo lo que guarda en memoria, como un reinicio del panel (la base
   * SQLite, en cambio, se conserva). Los números internos siguen avanzando
   * para que uno de antes no coincida por casualidad con uno nuevo.
   */
  simularReinicio(): void {
    this.principales.clear();
    this.porNombre.clear();
    this.porDireccion.clear();
    this.recommended = null;
    this.acme = null;
    this.acmeToken = null;
    this.dkim.clear();
    this.fallos.length = 0;
    this.dominios.clear();
    this.cambiosSinRecargar = false;
    this.recargas = 0;
    this.dkimBorrados = [];
    this.remoteDomains = [];
  }

  private fallo(metodo: string, nombre?: string): void {
    const i = this.fallos.findIndex(
      (f) =>
        f.metodo === metodo &&
        (f.nombre === undefined || (nombre !== undefined && normal(f.nombre) === normal(nombre))),
    );
    if (i < 0) return;
    this.fallos.splice(i, 1);
    throw new HttpError(
      502,
      `El motor de correo rechazó la operación (fallo inyectado en ${metodo}${nombre ? ` de ${nombre}` : ''}).`,
      'engine_error',
    );
  }

  /* --------------------------------- Modelo --------------------------------- */

  private buscar(nombre: string): PrincipalDemo | undefined {
    const id = this.porNombre.get(normal(nombre));
    return id === undefined ? undefined : this.principales.get(id);
  }

  /**
   * Buzón por su usuario del motor. Este modelo vive en memoria y la base del
   * panel no: tras reiniciar el panel (`npm run dev` reinicia con cada cambio
   * de código) no conoce los buzones que ya existían. Como hacía antes de
   * modelar principales, el que falta se vuelve a crear al tocarlo (sin
   * contraseña: vale la que se fije después). No se crea si ese nombre es
   * una dirección de otro principal: eso es haber pasado la dirección en vez
   * del usuario del motor, y el driver real daría engine_not_found.
   *
   * Solo lo usan las operaciones de siempre. getPrincipal, setAddresses y
   * renamePrincipal mantienen el contrato del motor real («no existe» es una
   * respuesta con significado para el cambio de dominio y su conciliador).
   */
  private buzon(login: string): PrincipalDemo {
    const p = this.buscar(login);
    if (p) return p;
    const nombre = normal(login);
    if (this.porDireccion.has(nombre)) throw noEncontrado(login);
    return this.crear({
      type: 'individual',
      name: nombre,
      description: '',
      quota: 0,
      emails: [nombre],
      secrets: [],
      suspendido: false,
      members: [],
      externalMembers: [],
    });
  }

  /**
   * Comprueba, como Stalwart antes de escribir, las direcciones que el
   * principal aún no tiene: que no sean de otro y que su dominio exista.
   */
  private validarNuevas(p: PrincipalDemo | null, direcciones: string[]): void {
    for (const d of direcciones) {
      if (p?.emails.includes(d)) continue;
      const duena = this.porDireccion.get(d);
      if (duena !== undefined && duena !== p?.id) throw yaExiste(d);
      if (!this.dominios.has(dominioDe(d))) throw noEncontrado(dominioDe(d));
    }
  }

  private fijarDirecciones(p: PrincipalDemo, direcciones: string[]): void {
    for (const d of p.emails) if (this.porDireccion.get(d) === p.id) this.porDireccion.delete(d);
    p.emails = [...direcciones];
    for (const d of p.emails) this.porDireccion.set(d, p.id);
  }

  private crear(datos: Omit<PrincipalDemo, 'id'>): PrincipalDemo {
    const p: PrincipalDemo = { id: this.siguienteId++, ...datos };
    this.principales.set(p.id, p);
    this.porNombre.set(p.name, p.id);
    for (const d of p.emails) this.porDireccion.set(d, p.id);
    return p;
  }

  private borrar(nombre: string): void {
    const p = this.buscar(nombre);
    if (!p) return;
    this.principales.delete(p.id);
    this.porNombre.delete(p.name);
    for (const d of p.emails) if (this.porDireccion.get(d) === p.id) this.porDireccion.delete(d);
    // Como en el motor: quien desaparece deja de ser miembro de las listas.
    for (const otro of this.principales.values()) otro.members = otro.members.filter((m) => m !== p.id);
  }

  /* ------------------------------ MailEngine -------------------------------- */

  async detectApi(): Promise<EngineApi> {
    return 'demo';
  }

  async ping(): Promise<EngineHealth> {
    try {
      this.fallo('ping');
    } catch (err) {
      return { ok: false, api: 'demo', detail: (err as Error).message };
    }
    return { ok: true, api: 'demo', version: 'demo', detail: 'Modo demostración: sin motor de correo real.' };
  }

  async createDomain(domain: string): Promise<void> {
    this.fallo('createDomain', domain);
    this.dominios.add(normal(domain));
  }

  async deleteDomain(domain: string): Promise<void> {
    this.fallo('deleteDomain', domain);
    // Como Stalwart sin multiinquilino: no toca los principales ni las claves DKIM.
    this.dominios.delete(normal(domain));
  }

  async ensureDkim(domain: string, _selector?: string): Promise<void> {
    this.fallo('ensureDkim', domain);
    const d = normal(domain);
    // Los mismos ids que genera Stalwart para su regla de firma por defecto.
    this.dkim.set(`rsa-${d}`, d);
    this.dkim.set(`ed25519-${d}`, d);
  }

  async getDnsRecords(domain: string): Promise<EngineDnsRecord[]> {
    return [
      { type: 'MX', name: domain, content: `10 mail.${domain}.` },
      { type: 'TXT', name: domain, content: `v=spf1 mx -all` },
      {
        type: 'TXT',
        name: `mail._domainkey.${domain}`,
        content: 'v=DKIM1; k=rsa; p=DEMO...',
      },
      {
        type: 'TXT',
        name: `_dmarc.${domain}`,
        content: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`,
      },
    ];
  }

  async createMailbox(input: CreateMailboxInput): Promise<void> {
    this.fallo('createMailbox', input.email);
    const email = normal(input.email);
    const datos = {
      description: input.displayName || '',
      quota: input.quotaBytes ?? 0,
      // Como el motor: guarda el hash que le da el panel, sin contraseñas de
      // aplicación antiguas y activo.
      secrets: [input.passwordHash],
      suspendido: false,
    };
    const existente = this.buscar(email);
    if (existente) {
      // Igual que el driver: solo se adopta el huérfano limpio.
      if (existente.type !== 'individual' || existente.emails.some((e) => e !== email)) {
        throw new HttpError(
          502,
          'El servidor de correo ya tiene un usuario con ese nombre y otras direcciones: no se adopta.',
          'engine_exists',
        );
      }
      Object.assign(existente, datos);
      this.fijarDirecciones(existente, [email]);
      return;
    }
    // Las altas no exigen el dominio en la demostración (sí la dirección libre),
    // para no obligar a cada prueba a darlo de alta antes.
    if (this.porDireccion.has(email)) throw yaExiste(email);
    this.crear({ type: 'individual', name: email, emails: [email], members: [], externalMembers: [], ...datos });
  }

  async setMailboxPassword(login: string, passwordHash: string): Promise<void> {
    this.fallo('setMailboxPassword', login);
    const p = this.buzon(login);
    // Como «addItem» de un secreto $6$: sustituye la principal y conserva las de aplicación.
    p.secrets = [passwordHash, ...p.secrets.filter((s) => s.startsWith('$app$'))];
  }

  async updateMailbox(login: string, patch: UpdateMailboxPatch): Promise<void> {
    this.fallo('updateMailbox', login);
    const p = this.buzon(login);
    if (patch.displayName !== undefined) p.description = patch.displayName;
    if (patch.quotaBytes !== undefined) p.quota = patch.quotaBytes;
    // Suspender no toca sus listas ni lo que recibe: solo deja de entrar.
    if (patch.suspended !== undefined) p.suspendido = patch.suspended;
  }

  async deleteMailbox(login: string): Promise<void> {
    this.fallo('deleteMailbox', login);
    this.borrar(login);
  }

  async upsertAlias(alias: string, destinations: string[], externalDestinations: string[] = []): Promise<void> {
    this.fallo('upsertAlias', alias);
    const nombre = normal(alias);
    // Los miembros son NOMBRES del motor de buzones. Se validan todos antes de
    // escribir: una dirección de otro principal (en vez de su usuario) falla
    // sin tocar nada; un buzón que este modelo olvidó al reiniciar se recrea.
    const nombres = destinations.map(normal);
    for (const n of nombres) if (!this.buscar(n) && this.porDireccion.has(n)) throw noEncontrado(n);
    const miembros = nombres.map((n) => this.buzon(n).id);
    const existente = this.buscar(nombre);
    if (existente) {
      if (existente.type !== 'list') {
        throw new HttpError(502, `El motor de correo rechazó la operación: «${alias}» no es una lista.`, 'engine_error');
      }
      // Solo los miembros: las direcciones de la lista (p. ej. la pre-recepción) se conservan.
      existente.members = miembros;
      existente.externalMembers = [...externalDestinations];
      return;
    }
    if (this.porDireccion.has(nombre)) throw yaExiste(nombre);
    this.crear({
      type: 'list',
      name: nombre,
      description: 'Alias gestionado por Mailway',
      quota: 0,
      emails: [nombre],
      secrets: [],
      suspendido: false,
      members: miembros,
      externalMembers: [...externalDestinations],
    });
  }

  async deleteAlias(alias: string): Promise<void> {
    this.fallo('deleteAlias', alias);
    this.borrar(alias);
  }

  async addAppPassword(login: string, label: string, proposedSecret: string): Promise<CreatedAppPassword> {
    this.fallo('addAppPassword', login);
    const p = this.buzon(login);
    // Como Stalwart 0.15: vale la contraseña propuesta y se retira por su texto guardado.
    const ref = `$app$${label}$${sha512Crypt(proposedSecret)}`;
    p.secrets.push(ref);
    return { secret: proposedSecret, ref };
  }

  async removeAppPassword(login: string, ref: string): Promise<void> {
    this.fallo('removeAppPassword', login);
    const p = this.buzon(login);
    // Como «removeItem» de un secreto $app$ en Stalwart: el exacto o los que empiezan por él.
    p.secrets = p.secrets.filter((s) => !s.startsWith('$app$') || (s !== ref && !s.startsWith(ref)));
  }

  /** Lo que tiene en memoria; un buzón de antes de reiniciar no lo conoce (null). */
  async readMailboxCredentials(login: string): Promise<MailboxCredentials | null> {
    const p = this.buscar(login);
    if (!p || p.type !== 'individual') return null;
    const appPasswords: MailboxCredentials['appPasswords'] = [];
    let passwordHash: string | null = null;
    for (const secret of p.secrets) {
      if (secret.startsWith('$app$')) {
        const fin = secret.indexOf('$', 5);
        if (fin > 0) appPasswords.push({ label: secret.slice(5, fin), hash: secret.slice(fin + 1), ref: secret });
      } else if (passwordHash === null && secret.startsWith('$6$')) {
        passwordHash = secret;
      }
    }
    if (passwordHash === null) return null;
    return { passwordHash, appPasswords, suspended: p.suspendido };
  }

  async listDirectory(): Promise<EngineDirectory> {
    const nombres = (tipo: PrincipalDemo['type']) =>
      [...this.principales.values()].filter((p) => p.type === tipo).map((p) => p.name);
    return { domains: [...this.dominios], accounts: nombres('individual'), lists: nombres('list') };
  }

  async getMailboxUsage(): Promise<Map<string, number>> {
    // Sin motor no hay correo guardado: todos los buzones conocidos están vacíos.
    return new Map(
      [...this.principales.values()].filter((p) => p.type === 'individual').map((p) => [p.name, 0]),
    );
  }

  async applyRecommended(input: RecommendedInput): Promise<EngineReloadResult> {
    this.recommended = { ...input, trustedNetworks: [...input.trustedNetworks] };
    return { errors: [], warnings: [], restartRequired: [] };
  }

  async getSettingsStatus(input: SettingsStatusInput): Promise<EngineSettingsStatus> {
    const aplicadas = new Set(this.recommended?.trustedNetworks ?? []);
    return {
      api: 'demo',
      hostname: this.recommended ? normalizeHostname(this.recommended.hostname) || null : null,
      forwardedHeaders: this.recommended !== null,
      trustedNetworks: input.trustedNetworks.filter((n) => aplicadas.has(n)),
      acme: this.acme,
      certificateFiles: false,
      extra: {},
      restartRequired: [],
    };
  }

  async configureAcme(input: AcmeInput): Promise<EngineReloadResult> {
    // El estado nunca devuelve el token; getAcmeToken lo da para compararlo.
    this.acmeToken = input.token;
    this.acme = {
      directory: input.directory,
      challenge: 'dns-01',
      provider: 'cloudflare',
      contact: input.contact,
      domain: input.hostname,
      zone: input.zone,
    };
    return { errors: [], warnings: [], restartRequired: [] };
  }

  async getAcmeToken(): Promise<string | null> {
    return this.acme?.provider === 'cloudflare' ? this.acmeToken : null;
  }

  /** Sin motor real, «arranca» con el último nombre que se le aplicó (si alguno). */
  async getRunningHostname(): Promise<string | null> {
    const value = normalizeHostname(this.recommended?.hostname ?? '');
    return value || null;
  }

  async reloadCertificates(): Promise<void> {}

  async getQueueSummary(): Promise<QueueSummary> {
    return { pending: 0, oldestSeconds: null };
  }

  async syncRemoteDomains(domains: string[]): Promise<RemoteDomainsResult> {
    const nuevos = normalizarDominiosRemotos(domains);
    const changed = nuevos.join(',') !== this.remoteDomains.join(',');
    this.remoteDomains = nuevos;
    return { changed, customized: false, errors: [], warnings: [] };
  }

  /* ----------------------------- Cambio de dominio ---------------------------- */

  async getPrincipal(name: string): Promise<EnginePrincipal | null> {
    this.fallo('getPrincipal', name);
    const p = this.buscar(name);
    return p ? { id: p.id, type: p.type, name: p.name, emails: [...p.emails] } : null;
  }

  async setAddresses(
    name: string,
    ops: { add?: string[]; remove?: string[]; primary?: string },
  ): Promise<string[]> {
    this.fallo('setAddresses', name);
    const p = this.buscar(name);
    if (!p) throw noEncontrado(name);
    const final = fusionarDirecciones(p.emails, ops);
    if (final.length === p.emails.length && final.every((d, i) => d === p.emails[i])) return final;
    this.validarNuevas(p, final);
    this.fijarDirecciones(p, final);
    this.cambiosSinRecargar = true;
    return [...final];
  }

  async renamePrincipal(from: string, to: string, opts: { expectEmail: string; emails?: string[] }): Promise<void> {
    this.fallo('renamePrincipal', from);
    const nuevo = normal(to);
    const p = this.buscar(from);
    if (!p) {
      const destino = this.buscar(nuevo);
      if (!destino) throw noEncontrado(from);
      if (destino.emails.includes(normal(opts.expectEmail))) return;
      throw new HttpError(502, `El servidor de correo ya tiene otro buzón o alias con el nombre «${to}».`, 'engine_exists');
    }
    const ocupado = this.porNombre.get(nuevo);
    if (ocupado !== undefined && ocupado !== p.id) throw yaExiste(nuevo);
    const direcciones = opts.emails ? fusionarDirecciones(opts.emails, {}) : null;
    // Todo validado antes de escribir: el PATCH del motor es atómico.
    if (direcciones) this.validarNuevas(p, direcciones);
    this.porNombre.delete(p.name);
    p.name = nuevo;
    this.porNombre.set(nuevo, p.id);
    if (direcciones) this.fijarDirecciones(p, direcciones);
    this.cambiosSinRecargar = true;
  }

  async reloadDirectory(): Promise<void> {
    this.fallo('reloadDirectory');
    this.recargas++;
    this.cambiosSinRecargar = false;
  }

  async removeDkim(domain: string): Promise<string[]> {
    this.fallo('removeDkim', domain);
    const d = normal(domain);
    this.dkimBorrados.push(d);
    const ids = [...this.dkim].filter(([, dominio]) => dominio === d).map(([id]) => id).sort();
    for (const id of ids) this.dkim.delete(id);
    // Recarga siempre, como el driver: completa el reintento de una llamada
    // anterior que borró las claves pero no pudo recargar.
    await this.reloadDirectory();
    return ids;
  }
}
