import { HttpError } from './errors';

/**
 * Cliente mínimo de la API v4 de Cloudflare para el DNS de correo.
 *
 * Solo cubre lo que Mailway necesita (verificar un token, localizar la zona
 * de un dominio, leer registros y aplicarlos en un lote) y traduce los
 * errores de Cloudflare a mensajes en español listos para la interfaz. El
 * token nunca aparece en un mensaje de error ni en un registro: solo viaja en
 * la cabecera Authorization.
 */

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

/** Comentario con el que se marcan los registros que crea Mailway. */
export const COMENTARIO_MAILWAY = 'Mailway';

const TIMEOUT_MS = 15_000;

/** Cloudflare admite 200 cambios por lote en el plan gratuito. */
export const MAX_OPERACIONES_LOTE = 200;

/* --------------------------------- Tipos ---------------------------------- */

export interface CfMensaje {
  code: number;
  message: string;
  error_chain?: CfMensaje[];
}

interface CfSobre<T> {
  success: boolean;
  errors?: CfMensaje[];
  messages?: CfMensaje[];
  result: T;
  result_info?: { page?: number; per_page?: number; total_pages?: number; total_count?: number };
}

export interface CfZona {
  id: string;
  name: string;
  /** initializing | pending | active | moved */
  status: string;
  paused: boolean;
  /** Servidores de nombres asignados; útiles cuando la zona está pendiente. */
  nameServers: string[];
  accountId: string;
  accountName: string;
}

export interface CfDatosRegistro {
  priority?: number;
  weight?: number;
  port?: number;
  target?: string;
}

export interface CfRegistro {
  id: string;
  type: string;
  /** FQDN en minúsculas, sin punto final. */
  name: string;
  content: string;
  priority?: number;
  proxied: boolean;
  ttl: number;
  comment: string | null;
  data?: CfDatosRegistro;
  /**
   * Registro bloqueado por Cloudflare (p. ej. los que crea Email Routing):
   * no se puede modificar ni borrar por la API mientras siga activo.
   */
  bloqueado: boolean;
}

/** Cuerpo de alta o sustitución de un registro. */
export interface CfRegistroNuevo {
  type: string;
  name: string;
  content?: string;
  priority?: number;
  data?: CfDatosRegistro;
  ttl: number;
  proxied: boolean;
  comment: string;
}

export interface CfLote {
  deletes?: { id: string }[];
  patches?: ({ id: string } & Partial<CfRegistroNuevo>)[];
  puts?: ({ id: string } & CfRegistroNuevo)[];
  posts?: CfRegistroNuevo[];
}

export interface CfResultadoLote {
  deletes: CfRegistro[];
  patches: CfRegistro[];
  puts: CfRegistro[];
  posts: CfRegistro[];
}

export interface CfInfoToken {
  id: string;
  status: string;
  /** Tokens de usuario (perfil) o de cuenta (cfat_): se verifican en rutas distintas. */
  kind: 'user' | 'account';
  accountId: string | null;
  expiresOn: string | null;
}

/* -------------------------------- Errores --------------------------------- */

/** Error de Cloudflare ya traducido; conserva los códigos originales. */
export class CloudflareError extends HttpError {
  readonly cfCodes: number[];
  readonly httpStatus: number;

  constructor(status: number, message: string, code: string, cfCodes: number[] = [], httpStatus = 0) {
    super(status, message, code);
    this.cfCodes = cfCodes;
    this.httpStatus = httpStatus;
  }

  /** «Ya existe un registro idéntico»: a efectos prácticos, un éxito. */
  get idempotente(): boolean {
    return this.code === 'cloudflare_identical';
  }
}

function codigosDe(errores: CfMensaje[]): number[] {
  const out: number[] = [];
  const visitar = (lista: CfMensaje[] | undefined) => {
    for (const e of lista || []) {
      if (typeof e.code === 'number') out.push(e.code);
      visitar(e.error_chain);
    }
  };
  visitar(errores);
  return out;
}

/** Todos los mensajes, también los de `error_chain`, en una sola línea (solo para clasificar). */
function mensajesDe(errores: CfMensaje[]): string {
  const out: string[] = [];
  const visitar = (lista: CfMensaje[] | undefined) => {
    for (const e of lista || []) {
      if (typeof e.message === 'string') out.push(e.message);
      visitar(e.error_chain);
    }
  };
  visitar(errores);
  return out.join(' ');
}

function primerMensaje(errores: CfMensaje[]): string {
  const e = errores[0];
  if (!e) return '';
  const cadena = e.error_chain?.[0]?.message;
  return [e.message, cadena].filter(Boolean).join(': ').slice(0, 240);
}

/**
 * Traduce la respuesta de error de Cloudflare. Los códigos se miran también en
 * `error_chain`, que es donde Cloudflare deja el motivo concreto (p. ej. el
 * 6111 de una clave global usada como token, o el 9005 de un contenido no
 * válido dentro de un 1004).
 */
export function errorDeCloudflare(httpStatus: number, errores: CfMensaje[] = []): CloudflareError {
  const codigos = codigosDe(errores);
  const tiene = (...lista: number[]) => lista.some((c) => codigos.includes(c));
  const detalle = primerMensaje(errores);
  const nuevo = (status: number, mensaje: string, code: string) =>
    new CloudflareError(status, mensaje, code, codigos, httpStatus);

  if (httpStatus === 429 || tiene(971)) {
    return nuevo(
      429,
      'Cloudflare ha limitado temporalmente las peticiones de este token (1200 cada 5 minutos). Espera unos minutos y vuelve a intentarlo.',
      'cloudflare_rate_limited',
    );
  }
  if (tiene(890190, 1046)) {
    return nuevo(
      409,
      'La zona tiene activado Cloudflare Email Routing, que bloquea los registros MX y SPF. Desactiva Email Routing en el panel de Cloudflare (Email → Email Routing → Settings) y vuelve a intentarlo.',
      'cloudflare_email_routing',
    );
  }
  if (tiene(81057, 81058)) {
    return nuevo(409, 'Ya existe un registro idéntico en Cloudflare.', 'cloudflare_identical');
  }
  if (tiene(81053, 81054, 81055)) {
    return nuevo(
      409,
      'Ya existe en Cloudflare otro registro con ese nombre que no puede convivir con el nuevo (un CNAME no admite otros registros con el mismo nombre).',
      'cloudflare_exists',
    );
  }
  if (tiene(6003, 6111, 6103, 9106)) {
    return nuevo(
      400,
      'Cloudflare no acepta la credencial. Utiliza un token de API (no la clave global de la API) y cópialo completo.',
      'cloudflare_token_malformed',
    );
  }
  // El 9109 de Cloudflare sirve para tres cosas distintas, y solo el texto las
  // separa: un token que no existe o se ha revocado («Invalid access token»,
  // con HTTP 403 en /zones), un token con restricción por IP que no incluye
  // este servidor («Cannot use the access token from location…») y la falta de
  // permiso. Tomar un token revocado por un problema de permisos manda a
  // revisar lo que no es.
  const textos = mensajesDe(errores).toLowerCase();
  if (tiene(1000) || httpStatus === 401 || (tiene(9109) && textos.includes('invalid access token'))) {
    return nuevo(
      400,
      'El token de Cloudflare no es válido. Comprueba que lo has copiado completo o genera uno nuevo.',
      'cloudflare_token_invalid',
    );
  }
  if (tiene(9109) && textos.includes('location')) {
    return nuevo(
      400,
      'Cloudflare no acepta el token desde la dirección IP de este servidor: el token tiene una restricción por dirección IP que no la incluye. Añade la IP del servidor a las restricciones del token o quítalas.',
      'cloudflare_token_ip_restricted',
    );
  }
  if (tiene(9109)) {
    return nuevo(
      400,
      'El token de Cloudflare no tiene permiso para esta operación. Revisa que tenga los permisos «Zone · Zone · Read» y «Zone · DNS · Edit» sobre la zona.',
      'cloudflare_forbidden',
    );
  }
  if (tiene(10000) || httpStatus === 403) {
    return nuevo(
      400,
      'El token de Cloudflare es válido, pero no tiene permiso sobre esta zona. Asigna los permisos «Zone · Zone · Read» y «Zone · DNS · Edit» e incluye la zona en el token.',
      'cloudflare_forbidden',
    );
  }
  if (tiene(81044)) {
    return nuevo(409, 'El registro ya no existe en Cloudflare. Vuelve a revisar los cambios.', 'cloudflare_not_found');
  }
  if (tiene(7000, 7003)) {
    return nuevo(400, 'Cloudflare no reconoce el identificador de la zona o del registro.', 'cloudflare_invalid_id');
  }
  if (tiene(1004, 9101) || codigos.some((c) => c >= 9000 && c < 9200)) {
    return nuevo(
      400,
      `Cloudflare ha rechazado el registro DNS${detalle ? ` (${detalle})` : ''}.`,
      'cloudflare_invalid_record',
    );
  }
  const codigo = codigos[0];
  return nuevo(
    502,
    `Cloudflare ha respondido con un error${codigo ? ` (código ${codigo})` : ` (HTTP ${httpStatus})`}${detalle ? `: ${detalle}` : ''}.`,
    'cloudflare_error',
  );
}

/* --------------------------------- TXT ------------------------------------ */

/**
 * Valor TXT como texto plano. Cloudflare puede devolverlo entrecomillado y
 * troceado ("a" "b") o tal cual; el motor, igual. Se normaliza antes de
 * comparar para no tomar por distinto un registro idéntico.
 */
export function normalizarTxt(valor: string): string {
  const texto = valor.trim();
  if (!texto.startsWith('"')) return texto;
  const trozos: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) {
    trozos.push(m[1]!.replace(/\\(["\\])/g, '$1'));
  }
  return trozos.length > 0 ? trozos.join('') : texto;
}

/**
 * Trocea un TXT en cadenas entrecomilladas de 255 bytes como máximo. Una clave
 * DKIM de 2048 bits pasa de largo el límite de una cadena DNS: sin trocear,
 * se publica truncada y la firma no valida nunca.
 */
export function trocearTxt(valor: string): string {
  const plano = normalizarTxt(valor);
  const trozos: string[] = [];
  let resto = Buffer.from(plano, 'utf8');
  while (resto.length > 255) {
    // Se corta por byte, sin partir un carácter multibyte por la mitad.
    let corte = 255;
    while (corte > 0 && (resto[corte]! & 0xc0) === 0x80) corte--;
    trozos.push(resto.subarray(0, corte).toString('utf8'));
    resto = resto.subarray(corte);
  }
  trozos.push(resto.toString('utf8'));
  return trozos.map((t) => `"${t.replace(/(["\\])/g, '\\$1')}"`).join(' ');
}

/* -------------------------------- Cliente --------------------------------- */

interface ZonaCruda {
  id: string;
  name: string;
  status?: string;
  paused?: boolean;
  name_servers?: string[];
  account?: { id?: string; name?: string };
}

interface RegistroCrudo {
  id: string;
  type: string;
  name: string;
  content?: string;
  priority?: number;
  proxied?: boolean;
  ttl?: number;
  comment?: string | null;
  data?: CfDatosRegistro;
  meta?: Record<string, unknown>;
}

function aZona(z: ZonaCruda): CfZona {
  return {
    id: z.id,
    name: z.name.toLowerCase(),
    status: z.status || 'active',
    paused: Boolean(z.paused),
    nameServers: z.name_servers || [],
    accountId: z.account?.id || '',
    accountName: z.account?.name || '',
  };
}

function aRegistro(r: RegistroCrudo): CfRegistro {
  const meta = r.meta || {};
  return {
    id: r.id,
    type: r.type,
    name: r.name.toLowerCase().replace(/\.$/, ''),
    content: r.content ?? '',
    priority: r.priority,
    proxied: Boolean(r.proxied),
    ttl: r.ttl ?? 1,
    comment: r.comment ?? null,
    data: r.data,
    bloqueado: meta.read_only === true || meta.email_routing === true,
  };
}

/** Clave global de la API (no es un token): Cloudflare la rechaza como Bearer. */
function esClaveGlobal(token: string): boolean {
  return token.startsWith('cfk_') || /^[0-9a-f]{37}$/i.test(token);
}

export class CloudflareClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token: string, baseUrl = CLOUDFLARE_API) {
    this.token = token.trim();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async peticion<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<CfSobre<T>> {
    const url = new URL(this.baseUrl + path);
    for (const [clave, valor] of Object.entries(opts.query || {})) {
      if (valor !== undefined) url.searchParams.set(clave, valor);
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const nombre = (err as Error).name;
      if (nombre === 'TimeoutError' || nombre === 'AbortError') {
        throw new CloudflareError(
          504,
          'Cloudflare no ha respondido en 15 segundos. Vuelve a intentarlo en unos minutos.',
          'cloudflare_timeout',
        );
      }
      // El mensaje de fetch no incluye cabeceras: no hay riesgo de exponer el token.
      throw new CloudflareError(
        502,
        `No se ha podido conectar con Cloudflare (${(err as Error).message}).`,
        'cloudflare_unreachable',
      );
    }
    const texto = await res.text();
    let sobre: CfSobre<T> | null = null;
    try {
      sobre = texto ? (JSON.parse(texto) as CfSobre<T>) : null;
    } catch {
      sobre = null;
    }
    if (!sobre || typeof sobre !== 'object') {
      if (!res.ok) throw errorDeCloudflare(res.status, []);
      throw new CloudflareError(
        502,
        `Cloudflare ha devuelto una respuesta no válida (HTTP ${res.status}).`,
        'cloudflare_error',
      );
    }
    if (!res.ok || sobre.success === false) {
      throw errorDeCloudflare(res.status, sobre.errors || []);
    }
    return sobre;
  }

  /** Recorre todas las páginas de un listado. */
  private async paginar<T>(
    path: string,
    query: Record<string, string | undefined>,
    porPagina: number,
  ): Promise<T[]> {
    const out: T[] = [];
    // Tope de seguridad: una zona con más de 50 páginas no es un caso de correo.
    for (let pagina = 1; pagina <= 50; pagina++) {
      const sobre = await this.peticion<T[]>('GET', path, {
        query: { ...query, page: String(pagina), per_page: String(porPagina) },
      });
      const lote = Array.isArray(sobre.result) ? sobre.result : [];
      out.push(...lote);
      const total = sobre.result_info?.total_pages;
      if (lote.length < porPagina || (typeof total === 'number' && pagina >= total)) break;
    }
    return out;
  }

  /**
   * Verifica el token. Los tokens de cuenta (cfat_) fallan en la ruta de
   * usuario con el código 1000, así que en ese caso se obtiene la cuenta a
   * partir de las zonas visibles y se verifica en la ruta de la cuenta.
   */
  async verifyToken(): Promise<CfInfoToken> {
    if (esClaveGlobal(this.token)) {
      throw new CloudflareError(
        400,
        'Has introducido la clave global de la API de Cloudflare. Por seguridad, crea un token de API con permisos limitados a las zonas y al DNS.',
        'cloudflare_global_key',
      );
    }
    let deCuenta = this.token.startsWith('cfat_');
    if (!deCuenta) {
      try {
        const sobre = await this.peticion<{ id: string; status: string; expires_on?: string }>(
          'GET',
          '/user/tokens/verify',
        );
        return this.comprobarActivo({
          id: sobre.result.id,
          status: sobre.result.status,
          kind: 'user',
          accountId: null,
          expiresOn: sobre.result.expires_on ?? null,
        });
      } catch (err) {
        if (!(err instanceof CloudflareError) || !err.cfCodes.includes(1000)) throw err;
        deCuenta = true;
      }
    }
    const zonas = await this.peticion<ZonaCruda[]>('GET', '/zones', { query: { per_page: '5' } });
    const cuenta = zonas.result?.[0]?.account?.id;
    if (!cuenta) {
      throw new CloudflareError(
        400,
        'El token no da acceso a ninguna zona. Asigna el permiso «Zone · Zone · Read» e incluye las zonas de tus dominios.',
        'cloudflare_no_zones',
      );
    }
    const sobre = await this.peticion<{ id: string; status: string; expires_on?: string }>(
      'GET',
      `/accounts/${encodeURIComponent(cuenta)}/tokens/verify`,
    );
    return this.comprobarActivo({
      id: sobre.result.id,
      status: sobre.result.status,
      kind: 'account',
      accountId: cuenta,
      expiresOn: sobre.result.expires_on ?? null,
    });
  }

  private comprobarActivo(info: CfInfoToken): CfInfoToken {
    if (info.status !== 'active') {
      throw new CloudflareError(
        400,
        'El token de Cloudflare está desactivado o ha caducado. Actívalo o genera uno nuevo.',
        'cloudflare_token_inactive',
      );
    }
    return info;
  }

  /** Zonas visibles para el token (todas las páginas). */
  async listZones(filtro: { name?: string } = {}): Promise<CfZona[]> {
    const crudas = await this.paginar<ZonaCruda>('/zones', { name: filtro.name }, 50);
    return crudas.map(aZona);
  }

  /**
   * Zona que contiene un nombre: se prueba de la etiqueta más larga a la más
   * corta (a.b.ejemplo.es → b.ejemplo.es → ejemplo.es). Una zona que el token
   * no ve no es un error para Cloudflare: devuelve una lista vacía.
   */
  async findZoneFor(hostname: string): Promise<CfZona | null> {
    const etiquetas = hostname.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
    for (let i = 0; i < etiquetas.length - 1; i++) {
      const candidata = etiquetas.slice(i).join('.');
      const sobre = await this.peticion<ZonaCruda[]>('GET', '/zones', {
        query: { name: candidata, per_page: '5' },
      });
      const zona = (sobre.result || []).find((z) => z.name.toLowerCase() === candidata);
      if (zona) return aZona(zona);
    }
    return null;
  }

  /** Registros de la zona, filtrados por tipo y nombre exacto (FQDN). */
  async listRecords(zoneId: string, filtro: { type?: string; name?: string } = {}): Promise<CfRegistro[]> {
    const crudos = await this.paginar<RegistroCrudo>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      { type: filtro.type, name: filtro.name },
      100,
    );
    return crudos.map(aRegistro);
  }

  async createRecord(zoneId: string, registro: CfRegistroNuevo): Promise<CfRegistro> {
    const sobre = await this.peticion<RegistroCrudo>(
      'POST',
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      { body: registro },
    );
    return aRegistro(sobre.result);
  }

  /** Sustitución completa (PUT). */
  async updateRecord(zoneId: string, id: string, registro: CfRegistroNuevo): Promise<CfRegistro> {
    const sobre = await this.peticion<RegistroCrudo>(
      'PUT',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`,
      { body: registro },
    );
    return aRegistro(sobre.result);
  }

  /** Cambio parcial (PATCH), p. ej. desactivar el proxy. */
  async patchRecord(zoneId: string, id: string, cambios: Partial<CfRegistroNuevo>): Promise<CfRegistro> {
    const sobre = await this.peticion<RegistroCrudo>(
      'PATCH',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`,
      { body: cambios },
    );
    return aRegistro(sobre.result);
  }

  async deleteRecord(zoneId: string, id: string): Promise<void> {
    await this.peticion<{ id: string }>(
      'DELETE',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Lote transaccional: Cloudflare ejecuta borrados → cambios → sustituciones
   * → altas, y si una falla no aplica ninguna. Así el dominio nunca queda a
   * medias (p. ej. sin MX antiguo y sin el nuevo).
   */
  async batch(zoneId: string, lote: CfLote): Promise<CfResultadoLote> {
    const total =
      (lote.deletes?.length || 0) +
      (lote.patches?.length || 0) +
      (lote.puts?.length || 0) +
      (lote.posts?.length || 0);
    if (total > MAX_OPERACIONES_LOTE) {
      throw new CloudflareError(
        400,
        `El lote supera el máximo de ${MAX_OPERACIONES_LOTE} cambios que admite Cloudflare.`,
        'cloudflare_batch_too_large',
      );
    }
    const cuerpo: CfLote = {};
    if (lote.deletes?.length) cuerpo.deletes = lote.deletes;
    if (lote.patches?.length) cuerpo.patches = lote.patches;
    if (lote.puts?.length) cuerpo.puts = lote.puts;
    if (lote.posts?.length) cuerpo.posts = lote.posts;
    const sobre = await this.peticion<Partial<Record<keyof CfResultadoLote, RegistroCrudo[]>>>(
      'POST',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/batch`,
      { body: cuerpo },
    );
    const r = sobre.result || {};
    return {
      deletes: (r.deletes || []).map(aRegistro),
      patches: (r.patches || []).map(aRegistro),
      puts: (r.puts || []).map(aRegistro),
      posts: (r.posts || []).map(aRegistro),
    };
  }
}

/** Últimos 4 caracteres del token, para reconocerlo sin mostrarlo. */
export function pistaToken(token: string): string {
  const limpio = token.trim();
  return limpio.length > 8 ? limpio.slice(-4) : '';
}

/**
 * Enlace al asistente de tokens de Cloudflare con los dos permisos que
 * necesita Mailway ya marcados (Zone · Read y DNS · Edit).
 */
export const URL_CREAR_TOKEN =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=*&zoneId=all&name=Mailway%20DNS';
