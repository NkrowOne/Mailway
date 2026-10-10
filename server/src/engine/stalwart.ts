import { HttpError, upstream } from '../core/errors';
import { normalizeHostname } from '../core/hostnames';
import { sha512Crypt } from '../core/sha512crypt';
import { RutaDeGestionAusente } from './errores';
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
  type EngineSettings,
  type EngineSettingsStatus,
  type MailboxCredentials,
  type MailEngine,
  type QueueSummary,
  type RecommendedInput,
  type RemoteDomainsResult,
  type SettingsStatusInput,
  type UpdateMailboxPatch,
} from './types';
import {
  CLAVES_RECEPCION,
  esReglaDeMailway,
  reglasIguales,
  reglasRecepcionRemota,
  soloClavesDeRecepcion,
} from './recepcion';

/** Dominio por el que se piden los registros para saber el nombre en ejecución. */
const DOMINIO_SONDA = 'mailway.invalid';

/** Identificador del proveedor ACME que crea Mailway en el motor (acme.mailway.*). */
const ACME_ID = 'mailway';

/** Claves ACME que se leen para el estado (las que escribe configureAcme, salvo el token). */
const ACME_KEYS = ['directory', 'challenge', 'provider', 'contact.0', 'domains.0', 'origin'].map(
  (k) => `acme.${ACME_ID}.${k}`,
);

/**
 * Certificado por fichero (volcado de Traefik): el instalador lo configura con
 * uno de estos dos identificadores (`certificate.mailway` es el actual y
 * `certificate.default` el de las guías anteriores).
 */
const CERT_FILE_KEYS = ['certificate.mailway.cert', 'certificate.default.cert'];

/**
 * Permisos que se quitan a un buzón suspendido: entrar con contraseña (IMAP,
 * SMTP, webmail, HTTP, también con sus contraseñas de aplicación) y con un
 * token OAuth que ya tuviera. El rol «user» se conserva, porque es el que da
 * `email-receive`: sin él (roles: [], como se suspendía antes) Stalwart 0.15.5
 * acepta el mensaje en el 25 y después lo devuelve al remitente (comprobado
 * con el motor real en test/panel-motor-real.test.ts). Así un buzón suspendido
 * no entra por ningún lado y el correo le sigue llegando, como en 0.16.
 */
const PERMISOS_SUSPENSION = ['authenticate', 'authenticate-oauth'];

/** Lo que el panel lee de un principal (GET /api/principal/<nombre>). */
/**
 * Principal tal como lo devuelve GET /api/principal/{nombre}. Stalwart omite
 * los campos vacíos y da un campo de lista con un solo valor como cadena.
 */
interface PrincipalLeido {
  id?: unknown;
  type?: string;
  name?: unknown;
  secrets?: string[] | string;
  roles?: string[];
  disabledPermissions?: string[];
  emails?: unknown;
}

/**
 * ¿Está suspendido el buzón? Sin permiso para autenticarse (como suspende
 * Mailway) o sin el rol «user» (como se suspendía antes). Ojo: Stalwart omite
 * los campos vacíos, así que un buzón con roles: [] llega SIN la clave
 * «roles»: su ausencia también es suspensión.
 */
function principalSuspendido(data: PrincipalLeido | null): boolean {
  const roles = data?.roles;
  const desactivados = data?.disabledPermissions;
  if (!Array.isArray(roles) || !roles.includes('user')) return true;
  return Array.isArray(desactivados) && desactivados.includes('authenticate');
}

/**
 * Driver para Stalwart Mail Server v0.12–v0.15 a través de su API REST de
 * gestión (`/api/...`). Verificado contra los docs 0.15 (stalw.art/docs/0.15)
 * y el código fuente del tag v0.15.5.
 *
 * Stalwart 0.16 eliminó esta API (pasó a JMAP, ver stalwart016.ts); la fachada
 * de engine/detector.ts averigua qué versión hay detrás de la URL y usa uno u
 * otro driver.
 *
 * Autenticación: HTTP Basic con el "fallback admin" (authentication.fallback-admin).
 * Contraseñas: la API NO hashea; recibe ya el $6$ (sha512-crypt) que calcula
 * el panel, que guarda una copia para comprobar contraseñas sin preguntar al
 * motor (modules/credenciales.ts).
 */
export class Stalwart015Engine implements MailEngine {
  readonly kind = 'stalwart' as const;

  constructor(private settings: EngineSettings) {}

  private get baseUrl(): string {
    return this.settings.url.replace(/\/+$/, '');
  }

  private authHeader(): string {
    const raw = `${this.settings.adminUser}:${this.settings.adminPassword}`;
    return `Basic ${Buffer.from(raw).toString('base64')}`;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader(),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw upstream(
        `No se pudo conectar con el motor de correo (${this.baseUrl}): ${(err as Error).message}`,
        'engine_unreachable',
      );
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // cuerpo no JSON: se conserva el texto para el mensaje de error
    }
    if (!res.ok) {
      if (res.status === 404) {
        // En 0.15 «no existe» llega con HTTP 200 y { error: "notFound" }. Un
        // 404 de verdad es una RUTA desconocida (URL del motor mal puesta, un
        // proxy con otro prefijo o un motor que ya no habla esta API, como un
        // Stalwart migrado a 0.16): si se tomara por «no existe», los borrados
        // «tendrían éxito» sin hacer nada y los principales seguirían
        // recibiendo correo y aceptando contraseñas. La fachada lo usa para
        // volver a averiguar la versión del motor.
        throw new RutaDeGestionAusente(
          `El motor de correo no reconoce la ruta de gestión ${path.split('?')[0]} (HTTP 404). Revisa la URL del motor en Ajustes: debe ser la de la API de gestión de Stalwart.`,
        );
      }
      if (res.status === 401) throw credencialesRechazadas();
      // Errores en formato RFC 7807 (application/problem+json)
      const problem = parsed as { detail?: string; title?: string } | null;
      const detail = problem?.detail || problem?.title || text.slice(0, 300) || res.statusText;
      throw new HttpError(502, `El motor de correo respondió ${res.status}: ${detail}`, 'engine_error');
    }
    // Stalwart 0.15 devuelve los errores de gestión con HTTP 200 y un cuerpo
    // { error: "notFound" | "fieldAlreadyExists" | "other" | … } sin "data".
    // Si no se miran aquí, un alta duplicada o un borrado de algo que no
    // existe pasarían por éxitos.
    if (parsed && typeof parsed === 'object' && !('data' in (parsed as object))) {
      const problem = parsed as {
        error?: unknown;
        details?: unknown;
        reason?: unknown;
        item?: unknown;
        field?: unknown;
        value?: unknown;
      };
      if (typeof problem.error === 'string') {
        throw engineProblem(problem);
      }
    }
    // Las respuestas de la API de gestión envuelven en { data: ... }
    if (parsed && typeof parsed === 'object' && 'data' in (parsed as object)) {
      return (parsed as { data: T }).data;
    }
    return parsed as T;
  }

  async detectApi(): Promise<EngineApi> {
    return 'rest015';
  }

  async ping(): Promise<EngineHealth> {
    try {
      await this.request('GET', '/api/principal?types=domain&page=1&limit=1');
      return { ok: true, api: 'rest015' };
    } catch (err) {
      return { ok: false, api: 'rest015', detail: (err as Error).message };
    }
  }

  async createDomain(domain: string): Promise<void> {
    try {
      await this.createDomainPrincipal(domain);
    } catch (err) {
      // Un dominio que ya existe en el motor (p. ej. huérfano de un borrado
      // interrumpido) se adopta: el panel es la fuente de verdad.
      if (err instanceof HttpError && err.code === 'engine_exists') return;
      throw err;
    }
  }

  private async createDomainPrincipal(domain: string): Promise<void> {
    await this.request('POST', '/api/principal', {
      type: 'domain',
      name: domain,
      description: 'Dominio gestionado por Mailway',
      quota: 0,
      secrets: [],
      emails: [],
      urls: [],
      memberOf: [],
      roles: [],
      lists: [],
      members: [],
      enabledPermissions: [],
      disabledPermissions: [],
      externalMembers: [],
    });
  }

  async deleteDomain(domain: string): Promise<void> {
    await this.deletePrincipal(domain);
  }

  async ensureDkim(domain: string, _selector: string): Promise<void> {
    // Stalwart autogenera id (rsa-<dominio> / ed25519-<dominio>, los que usa
    // su regla de firma por defecto) y selector (p. ej. 202609r / 202609e).
    // Se crean ambas firmas; "ya existe" no es un error.
    let created = false;
    for (const algorithm of ['Ed25519', 'Rsa'] as const) {
      try {
        await this.request('POST', '/api/dkim', {
          id: null,
          algorithm,
          domain,
          selector: null,
        });
        created = true;
      } catch (err) {
        if (err instanceof HttpError && err.code === 'engine_exists') continue;
        const message = (err as Error).message.toLowerCase();
        if (!message.includes('exist') && !message.includes('already')) throw err;
      }
    }
    // Los firmantes solo se cargan al reconstruir la configuración: sin la
    // recarga, el correo saldría sin firmar hasta el próximo reinicio.
    if (created) await this.reload().catch(() => undefined);
  }

  async getDnsRecords(domain: string): Promise<EngineDnsRecord[]> {
    const records = await this.request<{ type: string; name: string; content: string }[]>(
      'GET',
      `/api/dns/records/${encodeURIComponent(domain)}`,
    );
    return (records || []).map((r) => ({ type: r.type, name: r.name, content: r.content }));
  }

  /**
   * Stalwart 0.15.5 genera sus registros con el nombre en ejecución
   * (`core.network.server_name`, que solo cambia al recargar la
   * configuración), no con el `server.hostname` guardado: el destino de su MX
   * es el nombre que usa de verdad. La ruta genera los registros de cualquier
   * nombre sin exigir que el dominio exista; se pregunta por uno reservado
   * (.invalid, RFC 2606) para no mezclarlo con ningún dominio real.
   */
  async getRunningHostname(): Promise<string | null> {
    const records = await this.getDnsRecords(DOMINIO_SONDA);
    const mx = records.find((r) => r.type.toUpperCase() === 'MX');
    const destino = normalizeHostname(mx?.content.trim().split(/\s+/).pop() ?? '');
    return destino || null;
  }

  async createMailbox(input: CreateMailboxInput): Promise<void> {
    exigirHash(input.passwordHash);
    try {
      await this.createMailboxPrincipal(input);
    } catch (err) {
      if (!(err instanceof HttpError) || err.code !== 'engine_exists') throw err;
      // Buzón huérfano en el motor (existía allí pero no en el panel): se
      // adopta y se deja exactamente como lo pide el panel, con la contraseña
      // nueva, sin contraseñas de aplicación antiguas y activo (aunque
      // estuviera suspendido de cualquiera de las dos formas). «set roles»
      // también lo saca de las listas del motor en las que siguiera (ver
      // updateMailbox): ningún alias del panel apunta a un buzón que el panel
      // aún no tenía.
      // Pero solo si es un buzón limpio: tras un cambio de dominio, el usuario
      // viejo de un buzón que aún no ha actualizado sus dispositivos sigue en
      // el motor con las direcciones nuevas; adoptarlo al dar de alta otra vez
      // esa dirección entregaría a otra persona el buzón con todo su correo.
      const existente = await this.getPrincipal(input.email);
      // Sin principal con ese nombre, lo que existe es la DIRECCIÓN (de otro
      // principal): no hay nada que adoptar.
      if (!existente) throw err;
      const email = input.email.toLowerCase();
      if (existente.type !== 'individual' || existente.emails.some((e) => e !== email)) {
        throw new HttpError(
          502,
          'El servidor de correo ya tiene un usuario con ese nombre y otras direcciones: no se adopta.',
          'engine_exists',
        );
      }
      await this.updatePrincipal(input.email, [
        { action: 'set', field: 'description', value: input.displayName || '' },
        { action: 'set', field: 'quota', value: input.quotaBytes ?? 0 },
        { action: 'set', field: 'secrets', value: [input.passwordHash] },
        { action: 'set', field: 'emails', value: [input.email] },
        { action: 'set', field: 'roles', value: ['user'] },
        { action: 'set', field: 'disabledPermissions', value: [] },
      ]);
    }
  }

  private async createMailboxPrincipal(input: CreateMailboxInput): Promise<void> {
    await this.request('POST', '/api/principal', {
      type: 'individual',
      name: input.email,
      description: input.displayName || '',
      quota: input.quotaBytes ?? 0,
      secrets: [input.passwordHash],
      emails: [input.email],
      urls: [],
      memberOf: [],
      roles: ['user'],
      lists: [],
      members: [],
      enabledPermissions: [],
      disabledPermissions: [],
      externalMembers: [],
    });
  }

  async setMailboxPassword(email: string, passwordHash: string): Promise<void> {
    exigirHash(passwordHash);
    // En Stalwart 0.15, "addItem" de un secreto que no es $app$ sustituye solo
    // la contraseña principal: las contraseñas de aplicación (claves de API,
    // dispositivos, Skyway) siguen funcionando.
    await this.updatePrincipal(email, [{ action: 'addItem', field: 'secrets', value: passwordHash }]);
  }

  async updateMailbox(email: string, patch: UpdateMailboxPatch): Promise<void> {
    const updates: PrincipalUpdate[] = [];
    if (patch.displayName !== undefined) {
      updates.push({ action: 'set', field: 'description', value: patch.displayName });
    }
    if (patch.quotaBytes !== undefined) {
      updates.push({ action: 'set', field: 'quota', value: patch.quotaBytes });
    }
    if (patch.suspended !== undefined) {
      // Se quita el permiso de autenticarse, no el rol (ver
      // PERMISOS_SUSPENSION). El rol se añade en los dos sentidos, para que
      // un buzón suspendido como antes (roles: []) lo recupere, pero nunca
      // con «set»: en Stalwart 0.15.5 roles, listas y grupos son la misma
      // relación y «set roles» la reescribe entera, así que sacaba al buzón
      // de todos sus alias. addItem no toca nada más (y no duplica el rol).
      updates.push({ action: 'addItem', field: 'roles', value: 'user' });
      updates.push({
        action: 'set',
        field: 'disabledPermissions',
        value: patch.suspended ? PERMISOS_SUSPENSION : [],
      });
    }
    if (updates.length > 0) await this.updatePrincipal(email, updates);
  }

  async deleteMailbox(email: string): Promise<void> {
    await this.deletePrincipal(email);
  }

  async upsertAlias(
    alias: string,
    destinations: string[],
    externalDestinations: string[] = [],
  ): Promise<void> {
    // Un alias es un principal de tipo "list": los miembros (buzones de la
    // instancia) y los miembros externos (direcciones de fuera) reciben el
    // correo. Si ya existe, se sustituyen los miembros con UN solo PATCH:
    // Stalwart valida los miembros antes de escribir, así que si alguno no
    // existe la lista se queda como estaba. Borrar y recrear dejaba el alias
    // fuera del motor (y el correo rebotando) cuando la creación fallaba.
    const members: PrincipalUpdate[] = [
      { action: 'set', field: 'members', value: destinations },
      { action: 'set', field: 'externalMembers', value: externalDestinations },
    ];
    try {
      await this.updatePrincipal(alias, members);
      return;
    } catch (err) {
      // Solo «la lista no existe» lleva a crearla; un miembro inexistente es
      // un error de verdad y se propaga sin tocar nada.
      if (!isNotFoundOf(err, alias)) throw err;
    }
    try {
      await this.request('POST', '/api/principal', {
        type: 'list',
        name: alias,
        description: 'Alias gestionado por Mailway',
        quota: 0,
        secrets: [],
        emails: [alias],
        urls: [],
        memberOf: [],
        roles: [],
        lists: [],
        members: destinations,
        enabledPermissions: [],
        disabledPermissions: [],
        externalMembers: externalDestinations,
      });
    } catch (err) {
      // Otra petición la creó entre el PATCH y el POST: se actualiza la suya.
      if (!(err instanceof HttpError) || err.code !== 'engine_exists') throw err;
      await this.updatePrincipal(alias, members);
    }
  }

  /**
   * Lo que el motor guarda del buzón: es la única versión que lo expone (0.16
   * devuelve los secretos enmascarados), y sirve para llenar la copia local
   * del panel antes de migrar. Solo se lee: nunca se pide al motor que
   * autentique (cada fallo contaría para su bloqueo automático de IPs).
   */
  async readMailboxCredentials(email: string): Promise<MailboxCredentials | null> {
    const data = await this.request<PrincipalLeido | null>('GET', `/api/principal/${encodeURIComponent(email)}`);
    // Una lista o un dominio con ese nombre no es un buzón.
    if (data?.type !== undefined && data.type !== 'individual') {
      throw new HttpError(502, `El motor de correo no tiene un buzón ${email}.`, 'engine_not_found');
    }
    const raw = data?.secrets;
    const secrets = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? [raw] : [];
    let passwordHash: string | null = null;
    const appPasswords: MailboxCredentials['appPasswords'] = [];
    for (const secret of secrets) {
      if (secret.startsWith('$app$')) {
        // $app$<etiqueta>$<hash>: la etiqueta nunca lleva «$» (la pone Mailway).
        const fin = secret.indexOf('$', 5);
        if (fin < 0) continue;
        appPasswords.push({ label: secret.slice(5, fin), hash: secret.slice(fin + 1), ref: secret });
        continue;
      }
      // Solo un $6$ se puede comprobar en el panel; otro formato (otra vía de
      // alta, otro algoritmo) cuenta como «sin hash»: hay que restablecerla.
      if (passwordHash === null && secret.startsWith('$6$')) passwordHash = secret;
    }
    return {
      passwordHash,
      appPasswords,
      suspended: principalSuspendido(data),
    };
  }

  /** Dominios, cuentas (buzones y remitentes) y listas (alias) del motor. */
  async listDirectory(): Promise<EngineDirectory> {
    const nombres = async (tipo: 'domain' | 'individual' | 'list'): Promise<string[]> => {
      // limit=0 devuelve todos (como la ocupación de los buzones).
      const result = await this.request<{ items?: { name?: string }[] }>(
        'GET',
        `/api/principal?types=${tipo}&page=1&limit=0&fields=name`,
      );
      const vistos = new Set<string>();
      for (const item of result?.items || []) {
        const nombre = (item.name || '').trim().toLowerCase();
        if (nombre) vistos.add(nombre);
      }
      return [...vistos];
    };
    const [domains, accounts, lists] = await Promise.all([nombres('domain'), nombres('individual'), nombres('list')]);
    return { domains, accounts, lists };
  }

  async getMailboxUsage(): Promise<Map<string, number>> {
    const result = await this.request<{ items?: { name?: string; usedQuota?: number }[] }>(
      'GET',
      '/api/principal?types=individual&page=1&limit=0&fields=name,usedQuota',
    );
    const usage = new Map<string, number>();
    for (const item of result?.items || []) {
      if (!item.name) continue;
      // usedQuota se omite cuando vale 0.
      usage.set(item.name.toLowerCase(), typeof item.usedQuota === 'number' ? item.usedQuota : 0);
    }
    return usage;
  }

  /**
   * Ajustes que Mailway necesita detrás de Traefik: nombre del servidor, IP
   * real por X-Forwarded-For y redes exentas del baneo automático. 0.15 no
   * limita el número de contraseñas de aplicación por cuenta, así que
   * `maxAppPasswords` no tiene equivalente aquí. `permissiveCors` tampoco: el
   * correo web nuevo (Bulwark) necesita Stalwart 0.16 y con 0.15 sus nombres
   * van a Roundcube, que entra por IMAP y no necesita CORS.
   */
  async applyRecommended(input: RecommendedInput): Promise<EngineReloadResult> {
    const values: Record<string, string> = {
      'server.hostname': input.hostname,
      // Con esto Stalwart toma la IP real del visitante de X-Forwarded-For:
      // sin él, un escáner que pide /wp-login.php a través de Traefik banea la
      // IP de Traefik y deja fuera de servicio la web del motor para todos.
      'http.use-x-forwarded': 'true',
    };
    for (const network of input.trustedNetworks) values[`server.allowed-ip.${network}`] = '';
    const result = await this.applySettings(values);
    // En 0.15 todo se aplica con la recarga: nada exige reiniciar.
    return { ...result, restartRequired: [] };
  }

  async getSettingsStatus(input: SettingsStatusInput): Promise<EngineSettingsStatus> {
    const allowed = input.trustedNetworks.map((n) => `server.allowed-ip.${n}`);
    const values = await this.getSettings([
      'server.hostname',
      'http.use-x-forwarded',
      ...allowed,
      ...ACME_KEYS,
      ...CERT_FILE_KEYS,
    ]);
    const hostname = values['server.hostname'] ? normalizeHostname(values['server.hostname']) : '';
    const acmeKey = (k: string) => values[`acme.${ACME_ID}.${k}`] || null;
    const acme: EngineAcmeStatus | null = values[`acme.${ACME_ID}.directory`]
      ? {
          directory: acmeKey('directory'),
          challenge: acmeKey('challenge'),
          provider: acmeKey('provider'),
          contact: acmeKey('contact.0'),
          domain: acmeKey('domains.0'),
          zone: acmeKey('origin'),
        }
      : null;
    return {
      api: 'rest015',
      hostname: hostname || null,
      forwardedHeaders: values['http.use-x-forwarded'] === 'true',
      // Una red exenta se guarda con valor vacío: lo que cuenta es que la clave exista.
      trustedNetworks: input.trustedNetworks.filter((n) => values[`server.allowed-ip.${n}`] !== undefined),
      acme,
      certificateFiles: CERT_FILE_KEYS.some((k) => Boolean(values[k])),
      extra: {},
      restartRequired: [],
    };
  }

  /**
   * ACME del propio motor con reto DNS-01 en Cloudflare. El token viaja en
   * `acme.mailway.secret`: los errores de la recarga los depura la ruta antes
   * de devolverlos.
   */
  async configureAcme(input: AcmeInput): Promise<EngineReloadResult> {
    const prefix = `acme.${ACME_ID}`;
    const result = await this.applySettings({
      [`${prefix}.directory`]: input.directory,
      [`${prefix}.challenge`]: 'dns-01',
      [`${prefix}.provider`]: 'cloudflare',
      [`${prefix}.secret`]: input.token,
      [`${prefix}.contact.0`]: input.contact,
      [`${prefix}.domains.0`]: input.hostname,
      // La zona explícita evita que el motor la deduzca por la lista de
      // sufijos públicos, que falla con zonas delegadas en un subdominio.
      [`${prefix}.origin`]: input.zone,
      [`${prefix}.renew-before`]: '30d',
      // Por defecto también cuando el cliente no envía SNI (algunos móviles).
      [`${prefix}.default`]: 'true',
    });
    return { ...result, restartRequired: [] };
  }

  async getAcmeToken(): Promise<string | null> {
    const prefix = `acme.${ACME_ID}`;
    const values = await this.getSettings([`${prefix}.provider`, `${prefix}.secret`]);
    if (values[`${prefix}.provider`] !== 'cloudflare') return null;
    return values[`${prefix}.secret`] || null;
  }

  /** Escribe ajustes (clave → valor) y recarga la configuración. */
  private async applySettings(values: Record<string, string>): Promise<EngineReloadResult> {
    const entries = Object.entries(values);
    if (entries.length > 0) {
      await this.request('POST', '/api/settings', [
        { type: 'insert', prefix: null, values: entries, assert_empty: false },
      ]);
    }
    return this.reload();
  }

  private async getSettings(keys: string[]): Promise<Record<string, string>> {
    if (keys.length === 0) return {};
    const data = await this.request<Record<string, string | null> | null>(
      'GET',
      `/api/settings/keys?keys=${keys.map(encodeURIComponent).join(',')}`,
    );
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(data || {})) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  }

  async reloadCertificates(): Promise<void> {
    await this.request('GET', '/api/reload/certificate');
  }

  private async reload(): Promise<EngineReloadResult> {
    const result = await this.request<{ errors?: unknown; warnings?: unknown } | null>(
      'GET',
      '/api/reload',
    );
    return { errors: summarize(result?.errors), warnings: summarize(result?.warnings) };
  }

  async deleteAlias(alias: string): Promise<void> {
    await this.deletePrincipal(alias);
  }

  /**
   * En 0.15 la contraseña la propone Mailway y el motor guarda su hash junto a
   * una etiqueta ($app$<etiqueta>$<hash>): el secreto que vale es el
   * propuesto, y la referencia para retirarla, el texto guardado.
   */
  async addAppPassword(email: string, label: string, proposedSecret: string): Promise<CreatedAppPassword> {
    const ref = `$app$${label}$${sha512Crypt(proposedSecret)}`;
    await this.updatePrincipal(email, [{ action: 'addItem', field: 'secrets', value: ref }]);
    return { secret: proposedSecret, ref };
  }

  async removeAppPassword(email: string, ref: string): Promise<void> {
    await this.updatePrincipal(email, [{ action: 'removeItem', field: 'secrets', value: ref }]);
  }

  async getQueueSummary(): Promise<QueueSummary> {
    // Los elementos vienen en orden ascendente: el primero es el más antiguo.
    const result = await this.request<{ items?: { created?: string }[]; total?: number }>(
      'GET',
      '/api/queue/messages?page=1&limit=1&values=1',
    );
    const total = typeof result?.total === 'number' ? result.total : 0;
    const created = result?.items?.[0]?.created;
    const createdMs = created ? Date.parse(created) : NaN;
    const oldestSeconds = Number.isFinite(createdMs)
      ? Math.max(0, Math.round((Date.now() - createdMs) / 1000))
      : null;
    return { pending: total, oldestSeconds: total > 0 ? oldestSeconds : null };
  }

  /**
   * Reglas de entrega de los dominios con el correo en otro proveedor
   * (engine/recepcion.ts). Se leen las tres claves (también en su forma de
   * valor directo, que tendría prioridad sobre el bloque) y solo se escriben
   * si faltan o son de Mailway. Las tres se vacían y se vuelven a escribir en
   * la misma petición (`assert_empty`: tras vaciarlas, la primera clave no
   * puede existir). Con una lista vacía solo se vacían: el motor vuelve a sus
   * valores por defecto.
   */
  async syncRemoteDomains(domains: string[], opts: { reload?: boolean } = {}): Promise<RemoteDomainsResult> {
    const claves = CLAVES_RECEPCION.join(',');
    const leidos = await this.request<Record<string, string | null> | null>(
      'GET',
      `/api/settings/keys?keys=${claves}&prefixes=${claves}`,
    );
    const actuales = soloClavesDeRecepcion(
      Object.fromEntries(Object.entries(leidos || {}).filter((e): e is [string, string] => typeof e[1] === 'string')),
    );
    const deseadas = reglasRecepcionRemota(domains);
    if (reglasIguales(actuales, deseadas)) {
      if (!opts.reload) return { changed: false, customized: false, errors: [], warnings: [] };
      return { changed: false, customized: false, ...(await this.reload()) };
    }
    if (!esReglaDeMailway(actuales)) return { changed: false, customized: true, errors: [], warnings: [] };
    const valores = Object.entries(deseadas);
    await this.request('POST', '/api/settings', [
      ...CLAVES_RECEPCION.map((c) => ({ type: 'clear', prefix: `${c}.` })),
      ...(valores.length > 0 ? [{ type: 'insert', prefix: null, values: valores, assert_empty: true }] : []),
    ]);
    return { changed: true, customized: false, ...(await this.reload()) };
  }

  /* ----------------------------- Cambio de dominio ---------------------------- */

  async getPrincipal(name: string): Promise<EnginePrincipal | null> {
    let data: PrincipalLeido | null;
    try {
      data = await this.request<PrincipalLeido>('GET', `/api/principal/${encodeURIComponent(name)}`);
    } catch (err) {
      // En un GET por nombre, «notFound» solo puede referirse a ese nombre.
      if (err instanceof HttpError && err.code === 'engine_not_found') return null;
      throw err;
    }
    return principalLeido(data, name);
  }

  async setAddresses(
    name: string,
    ops: { add?: string[]; remove?: string[]; primary?: string },
  ): Promise<string[]> {
    const actual = await this.getPrincipal(name);
    if (!actual) throw noEncontrado(name);
    const final = fusionarDirecciones(actual.emails, ops);
    if (final.length === actual.emails.length && final.every((d, i) => d === actual.emails[i])) return final;
    // Un solo «set emails»: el motor valida todas las direcciones nuevas
    // (dominio dado de alta y que no sean de otro principal) antes de
    // escribir nada, así que un fallo deja el principal como estaba.
    await this.updatePrincipal(name, [{ action: 'set', field: 'emails', value: final }]);
    return final;
  }

  async renamePrincipal(
    from: string,
    to: string,
    opts: { expectEmail: string; emails?: string[] },
  ): Promise<void> {
    // Nombre y direcciones en el MISMO PATCH: Stalwart lo aplica entero o no
    // aplica nada. Nunca se envían los miembros: van por id y renombrar no
    // los cambia; reescribirlos podría perder a quien ya no se llama igual.
    const updates: PrincipalUpdate[] = [{ action: 'set', field: 'name', value: to.trim().toLowerCase() }];
    if (opts.emails) updates.push({ action: 'set', field: 'emails', value: fusionarDirecciones(opts.emails, {}) });
    try {
      await this.updatePrincipal(from, updates);
    } catch (err) {
      // Solo «el principal de origen no existe» puede ser un reintento de un
      // renombrado que ya se hizo; un dominio inexistente o una dirección de
      // otro se propagan tal cual.
      if (!isNotFoundOf(err, from)) throw err;
      const destino = await this.getPrincipal(to);
      if (!destino) throw err;
      if (destino.emails.includes(opts.expectEmail.trim().toLowerCase())) return;
      throw new HttpError(
        502,
        `El servidor de correo ya tiene otro buzón o alias con el nombre «${to}».`,
        'engine_exists',
      );
    }
  }

  async reloadDirectory(): Promise<void> {
    // Stalwart guarda en caché qué direcciones existen (24 h) y cuáles no
    // (1 h): sin esta recarga, una dirección recién añadida se rechaza y una
    // recién quitada se sigue aceptando. Una recarga con errores no aplica
    // nada nuevo, así que no puede darse por buena.
    const resultado = await this.reload();
    if (resultado.errors.length > 0) {
      throw new HttpError(
        502,
        `El motor de correo no pudo recargar su configuración: ${resultado.errors.slice(0, 3).join('; ')}`,
        'engine_error',
      );
    }
  }

  async removeDkim(domain: string): Promise<string[]> {
    const ajustes = await this.request<Record<string, string | null> | null>(
      'GET',
      '/api/settings/keys?prefixes=signature',
    );
    const { ids, claves } = clavesDkimDe(ajustes || {}, domain);
    // Claves exactas, nunca un prefijo: «clear signature.rsa-d.es.» se
    // llevaría también las de rsa-d.es.mx.
    if (claves.length > 0) await this.request('POST', '/api/settings', [{ type: 'delete', keys: claves }]);
    // Recarga también sin nada que borrar. Si un intento anterior borró las
    // claves y su recarga trajo errores, el motor no aplicó nada y sigue
    // firmando con ellas; el reintento ya no las encuentra, y sin recargar
    // daría por terminado el borrado y el error saldría en la recarga de
    // otra operación sin relación.
    await this.reloadDirectory();
    return ids;
  }

  private async updatePrincipal(name: string, updates: PrincipalUpdate[]): Promise<void> {
    await this.request('PATCH', `/api/principal/${encodeURIComponent(name)}`, updates);
  }

  /**
   * Borrado idempotente: si el principal ya no existe ({ error: "notFound" }),
   * es un éxito. Un HTTP 404 (ruta desconocida) NO lo es: llega como engine_error.
   */
  private async deletePrincipal(name: string): Promise<void> {
    try {
      await this.request('DELETE', `/api/principal/${encodeURIComponent(name)}`);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'engine_not_found') return;
      throw err;
    }
  }
}

interface PrincipalUpdate {
  action: 'set' | 'addItem' | 'removeItem';
  field: string;
  value: unknown;
}

/** El motor rechazó el usuario o la contraseña de administración (HTTP 401). */
export function credencialesRechazadas(): HttpError {
  return new HttpError(
    502,
    'El motor de correo ha rechazado el usuario o la contraseña de administración (HTTP 401). Revisa las credenciales en Ajustes → Motor de correo.',
    'engine_auth_failed',
  );
}

/**
 * Stalwart guarda TAL CUAL lo que recibe en `secrets`, también un texto en
 * claro. Una contraseña que llegara sin cifrar por un error del panel
 * quedaría legible en el motor: mejor fallar.
 */
function exigirHash(passwordHash: string): void {
  if (!passwordHash.startsWith('$6$')) {
    throw new Error('La contraseña del buzón debe llegar al motor cifrada en sha512-crypt ($6$).');
  }
}

/**
 * Error de gestión del motor. Conserva el elemento al que se refiere un
 * «notFound»: en un PATCH distingue «la lista no existe» de «uno de sus
 * miembros no existe», que exigen reacciones opuestas.
 */
class EngineProblem extends HttpError {
  readonly item: string | null;

  constructor(status: number, message: string, code: string, item: string | null) {
    super(status, message, code);
    this.item = item;
  }
}

/** Principal tal y como lo devuelve GET /api/principal/<nombre> (campos vacíos omitidos). */
/**
 * Normaliza la lectura de un principal. Stalwart omite los campos vacíos y
 * da un campo de lista con un solo valor como cadena (`append_str` de
 * principal.rs), así que `emails` puede faltar, ser una cadena o una lista.
 */
function principalLeido(data: PrincipalLeido | null, name: string): EnginePrincipal {
  const raw = data?.emails;
  const lista = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? [raw] : [];
  return {
    id: typeof data?.id === 'number' ? data.id : Number(data?.id ?? NaN),
    type: typeof data?.type === 'string' ? data.type : '',
    name: typeof data?.name === 'string' ? data.name : name.toLowerCase(),
    emails: lista.filter((e): e is string => typeof e === 'string' && e !== '').map((e) => e.toLowerCase()),
  };
}

/** «notFound» de un principal, con el mismo formato que los que devuelve el motor. */
function noEncontrado(item: string): HttpError {
  return new EngineProblem(502, `El motor de correo no encuentra el elemento (${item}).`, 'engine_not_found', item);
}

const PREFIJO_FIRMA = 'signature.';
const SUFIJO_DOMINIO = '.domain';

/**
 * Claves DKIM de un dominio exacto entre los ajustes `signature.*`. Los ids
 * son los X con `signature.X.domain` igual al dominio; cada clave se asigna al
 * id MÁS LARGO que la prefija, porque los ids llevan puntos: con los dominios
 * d.es y d.es.mx, `signature.rsa-d.es.mx.private-key` es de rsa-d.es.mx,
 * aunque también empiece por `signature.rsa-d.es.`.
 */
function clavesDkimDe(ajustes: Record<string, string | null>, domain: string): { ids: string[]; claves: string[] } {
  const dominio = domain.trim().toLowerCase();
  const todos: string[] = [];
  const delDominio = new Set<string>();
  for (const [clave, valor] of Object.entries(ajustes)) {
    if (!clave.startsWith(PREFIJO_FIRMA) || !clave.endsWith(SUFIJO_DOMINIO)) continue;
    const id = clave.slice(PREFIJO_FIRMA.length, -SUFIJO_DOMINIO.length);
    if (!id) continue;
    todos.push(id);
    if (typeof valor === 'string' && valor.trim().toLowerCase() === dominio) delDominio.add(id);
  }
  if (delDominio.size === 0) return { ids: [], claves: [] };
  todos.sort((a, b) => b.length - a.length);
  const claves: string[] = [];
  for (const clave of Object.keys(ajustes)) {
    if (!clave.startsWith(PREFIJO_FIRMA)) continue;
    const resto = clave.slice(PREFIJO_FIRMA.length);
    const id = todos.find((i) => resto === i || resto.startsWith(`${i}.`));
    if (id && delDominio.has(id)) claves.push(clave);
  }
  return { ids: [...delDominio].sort(), claves: claves.sort() };
}

/** ¿Es un «notFound» del propio principal `name` (y no de otro elemento)? */
function isNotFoundOf(err: unknown, name: string): boolean {
  if (!(err instanceof HttpError) || err.code !== 'engine_not_found') return false;
  const item = err instanceof EngineProblem ? err.item : null;
  // Sin elemento en la respuesta no se puede saber: se trata como error.
  return item !== null && item.toLowerCase() === name.toLowerCase();
}

/** Traduce un error de gestión de Stalwart (llega con HTTP 200) a HttpError. */
function engineProblem(problem: {
  error?: unknown;
  details?: unknown;
  reason?: unknown;
  item?: unknown;
  field?: unknown;
  value?: unknown;
}): HttpError {
  const kind = String(problem.error);
  if (kind === 'notFound') {
    const item = typeof problem.item === 'string' ? problem.item : null;
    return new EngineProblem(
      502,
      `El motor de correo no encuentra el elemento${item ? ` (${item})` : ''}.`,
      'engine_not_found',
      item,
    );
  }
  if (kind === 'fieldAlreadyExists') {
    const value = typeof problem.value === 'string' ? ` «${problem.value}»` : '';
    return new HttpError(502, `El motor de correo ya tiene ese elemento${value}.`, 'engine_exists');
  }
  const detail = [problem.details, problem.reason].filter((v) => typeof v === 'string' && v).join(': ');
  return new HttpError(
    502,
    `El motor de correo rechazó la operación (${kind})${detail ? `: ${detail}` : ''}.`,
    'engine_error',
  );
}

/** Convierte la lista de errores/avisos de una recarga en texto legible. */
function summarize(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(
      ([key, v]) => `${key}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
    );
  }
  return [String(value)];
}
