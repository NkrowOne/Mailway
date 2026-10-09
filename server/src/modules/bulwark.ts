import crypto from 'node:crypto';
import { HttpError, badRequest } from '../core/errors';

/*
 * Bulwark (correo web JMAP que se ofrece como opción «beta» por cliente):
 * la marca por dominio que Mailway le aplica, su política y el cliente de su
 * API de administración.
 *
 * Este módulo no toca la base de datos ni la configuración del panel: recibe
 * los datos ya leídos y devuelve exactamente lo que Bulwark 1.13 espera. Así
 * lo pueden usar el vigilante, las rutas y el ensayo con contenedores reales
 * (deploy/bulwark/prueba.sh) sin arrancar el panel.
 *
 * Contrato comprobado en el código de Bulwark 1.13.0 y contra su contenedor:
 * - POST /api/admin/auth {password} → cookie admin_session (Max-Age 3600).
 *   Cada intento cuenta para su límite (5 por IP y 50 en total cada 15
 *   minutos), también los correctos: la sesión se reutiliza mientras dure.
 * - GET /api/admin/config → { clave: { value, source } }.
 * - PATCH /api/admin/config {domainBranding: […]} sustituye la lista entera;
 *   si Bulwark descarta alguna entrada, responde 400 y no guarda nada.
 * - GET /api/admin/policy (con la sesión, la política completa) y
 *   PUT /api/admin/policy con la política entera.
 * - Sin cabeceras Origin ni Sec-Fetch-Site, una llamada de servidor a
 *   servidor pasa su comprobación de mismo origen.
 * La API de administración no está documentada para automatizarla: cada
 * versión nueva de Bulwark pasa por el ensayo antes de fijarse.
 */

/* ------------------------------ Marca por host ------------------------------ */

/** Campos de marca que Bulwark admite por nombre (lib/admin/domain-branding.ts). */
export const CAMPOS_MARCA_BULWARK = [
  'appName',
  'appShortName',
  'appDescription',
  'faviconUrl',
  'pwaIconUrl',
  'pwaScreenshotMobileUrl',
  'pwaScreenshotDesktopUrl',
  'pwaThemeColor',
  'pwaBackgroundColor',
  'appLogoLightUrl',
  'appLogoDarkUrl',
  'loginLogoLightUrl',
  'loginLogoDarkUrl',
  'loginCompanyName',
  'loginImprintUrl',
  'loginPrivacyPolicyUrl',
  'loginWebsiteUrl',
] as const;

export type CampoMarcaBulwark = (typeof CAMPOS_MARCA_BULWARK)[number];

/** Una entrada de domainBranding tal como la guarda Bulwark. */
export type EntradaMarcaBulwark = { host: string } & Partial<Record<CampoMarcaBulwark, string>>;

/** Webmail activo de un cliente que usa Bulwark, con la marca que debe mostrar. */
export interface WebmailConMarca {
  /** Nombre del webmail, p. ej. webmail.cliente.com (ya activo en Traefik). */
  host: string;
  /** Nombre con el que se presenta el correo web (título, pantalla de acceso). */
  nombre: string;
  /** Nombre corto de la aplicación instalada (PWA). */
  nombreCorto?: string;
  descripcion?: string;
  /** Empresa que firma la pantalla de acceso. */
  empresa?: string;
  /** Logotipo para fondo claro; también sirve para el oscuro si falta ese. */
  logoClaroUrl?: string;
  logoOscuroUrl?: string;
  faviconUrl?: string;
  /** Icono de la aplicación instalada; sin él, Bulwark usa el favicon. */
  iconoUrl?: string;
  colorTema?: string;
  colorFondo?: string;
  /** «Mi buzón» del cliente: el enlace del pie de la pantalla de acceso. */
  miBuzonUrl?: string;
  privacidadUrl?: string;
  avisoLegalUrl?: string;
}

/** El mismo criterio que whitelabel.ts para los dominios propios. */
const NOMBRE_HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
/** El de Bulwark (admite comodín a la izquierda): lo que guarda y lo que descarta. */
const HOST_BULWARK_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
/**
 * Rutas propias de Bulwark desde las que puede servir una imagen en el mismo
 * origen que cada webmail: la carpeta de marca montada y los recursos subidos
 * por su API de administración (la pasarela deja leer esos).
 */
const RUTA_RECURSO_RE = /^\/(?:branding|api\/admin\/branding)\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_URL = 2048;

function normalizarHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '');
}

function invalida(host: string, detalle: string): HttpError {
  return badRequest(`La marca de ${host || '(sin nombre)'} para Bulwark no es válida: ${detalle}`, 'bulwark_marca_invalida');
}

function texto(valor: string | undefined, max: number, host: string, que: string, obligatorio = false): string | undefined {
  const limpio = (valor ?? '').trim();
  if (!limpio) {
    if (obligatorio) throw invalida(host, `falta ${que}.`);
    return undefined;
  }
  if (CONTROL_RE.test(limpio)) throw invalida(host, `${que} contiene caracteres de control.`);
  if (limpio.length > max) throw invalida(host, `${que} supera ${max} caracteres.`);
  return limpio;
}

/** Dirección https absoluta, sin credenciales: lo único que se enlaza desde el acceso. */
function urlHttps(valor: string | undefined, host: string, que: string): string | undefined {
  const limpio = (valor ?? '').trim();
  if (!limpio) return undefined;
  if (limpio.length > MAX_URL) throw invalida(host, `${que} es demasiado larga.`);
  let url: URL;
  try {
    url = new URL(limpio);
  } catch {
    throw invalida(host, `${que} no es una dirección válida.`);
  }
  if (url.protocol !== 'https:' || !url.hostname) throw invalida(host, `${que} debe empezar por https://.`);
  if (url.username || url.password) throw invalida(host, `${que} no puede llevar usuario ni contraseña.`);
  return url.href;
}

/**
 * Imagen de marca: https absoluta o una ruta de Bulwark del mismo origen.
 * Bulwark guarda las cadenas tal cual, así que la validación es de Mailway:
 * nada de javascript:, data: ni rutas que salgan de las carpetas de marca.
 */
function urlRecurso(valor: string | undefined, host: string, que: string): string | undefined {
  const limpio = (valor ?? '').trim();
  if (!limpio) return undefined;
  if (limpio.startsWith('/') && !limpio.startsWith('//')) {
    if (limpio.length > MAX_URL || !RUTA_RECURSO_RE.test(limpio) || limpio.split('/').some((s) => s === '..' || s === '.')) {
      throw invalida(host, `${que} debe ser https:// o una ruta de /branding/ o /api/admin/branding/.`);
    }
    return limpio;
  }
  return urlHttps(limpio, host, que);
}

function color(valor: string | undefined, host: string, que: string): string | undefined {
  const limpio = (valor ?? '').trim();
  if (!limpio) return undefined;
  if (!COLOR_RE.test(limpio)) throw invalida(host, `${que} debe ser un color #rgb o #rrggbb.`);
  return limpio.toLowerCase();
}

function ordenarPorHost<T extends { host: string }>(lista: T[]): T[] {
  return lista.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}

/** Claves en el orden fijo de CAMPOS_MARCA_BULWARK: la misma entrada, el mismo JSON. */
function entradaCanonica(host: string, campos: Partial<Record<CampoMarcaBulwark, string | undefined>>): EntradaMarcaBulwark {
  const entrada: EntradaMarcaBulwark = { host };
  for (const campo of CAMPOS_MARCA_BULWARK) {
    const valor = campos[campo];
    if (typeof valor === 'string' && valor.length > 0) entrada[campo] = valor;
  }
  return entrada;
}

/**
 * La lista domainBranding de Bulwark a partir de los webmail de los clientes,
 * ordenada por nombre. Lanza `bulwark_marca_invalida` (400) ante cualquier
 * dato que Bulwark descartaría o que no debe llegar a una página pública:
 * mejor no sincronizar que publicar una marca a medias.
 */
export function marcaPorHostBulwark(webmails: readonly WebmailConMarca[]): EntradaMarcaBulwark[] {
  const vistos = new Set<string>();
  const salida: EntradaMarcaBulwark[] = [];
  for (const webmail of webmails) {
    const host = normalizarHost(webmail.host ?? '');
    // Solo nombres exactos: un comodín (*.dominio) alcanzaría nombres de
    // otros clientes servidos por el mismo Bulwark.
    if (!NOMBRE_HOST_RE.test(host)) throw invalida(host, 'el nombre del webmail no es un dominio válido.');
    if (vistos.has(host)) throw invalida(host, 'el nombre aparece dos veces.');
    vistos.add(host);

    const logoClaro = urlRecurso(webmail.logoClaroUrl, host, 'el logotipo claro');
    // Sin logotipo oscuro, el claro: en modo oscuro se vería el de la
    // instancia, que en un webmail de marca blanca es peor que un contraste flojo.
    const logoOscuro = urlRecurso(webmail.logoOscuroUrl, host, 'el logotipo oscuro') ?? logoClaro;
    salida.push(
      entradaCanonica(host, {
        appName: texto(webmail.nombre, 60, host, 'el nombre del correo web', true),
        appShortName: texto(webmail.nombreCorto, 30, host, 'el nombre corto'),
        appDescription: texto(webmail.descripcion, 200, host, 'la descripción'),
        faviconUrl: urlRecurso(webmail.faviconUrl, host, 'el favicon'),
        pwaIconUrl: urlRecurso(webmail.iconoUrl, host, 'el icono'),
        pwaThemeColor: color(webmail.colorTema, host, 'el color del tema'),
        pwaBackgroundColor: color(webmail.colorFondo, host, 'el color de fondo'),
        appLogoLightUrl: logoClaro,
        appLogoDarkUrl: logoOscuro,
        loginLogoLightUrl: logoClaro,
        loginLogoDarkUrl: logoOscuro,
        loginCompanyName: texto(webmail.empresa, 80, host, 'la empresa'),
        loginImprintUrl: urlHttps(webmail.avisoLegalUrl, host, 'el aviso legal'),
        loginPrivacyPolicyUrl: urlHttps(webmail.privacidadUrl, host, 'la política de privacidad'),
        loginWebsiteUrl: urlHttps(webmail.miBuzonUrl, host, 'el enlace a «Mi buzón»'),
      }),
    );
  }
  return ordenarPorHost(salida);
}

/**
 * Lo que Bulwark guarda a partir de un valor de domainBranding (la misma
 * lectura que su parseDomainBranding): entradas sin nombre válido o
 * repetidas fuera, solo los campos conocidos y no vacíos. Ordenada por
 * nombre para comparar: el orden no cambia qué marca recibe cada host.
 */
export function normalizarMarcaBulwark(valor: unknown): EntradaMarcaBulwark[] {
  let lista = valor;
  if (typeof lista === 'string') {
    try {
      lista = JSON.parse(lista);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(lista)) return [];
  const vistos = new Set<string>();
  const salida: EntradaMarcaBulwark[] = [];
  for (const item of lista) {
    if (!item || typeof item !== 'object') continue;
    const registro = item as Record<string, unknown>;
    const host = normalizarHost(typeof registro.host === 'string' ? registro.host : '');
    if (!host || !HOST_BULWARK_RE.test(host) || vistos.has(host)) continue;
    vistos.add(host);
    const campos: Partial<Record<CampoMarcaBulwark, string>> = {};
    for (const campo of CAMPOS_MARCA_BULWARK) {
      const v = registro[campo];
      if (typeof v === 'string') campos[campo] = v;
    }
    salida.push(entradaCanonica(host, campos));
  }
  return ordenarPorHost(salida);
}

/* --------------------------------- Política --------------------------------- */

/** App fija de la barra lateral (AdminSidebarApp de Bulwark). */
export interface AppLateralBulwark {
  id: string;
  name: string;
  url: string;
  icon: string;
  openMode: 'tab' | 'inline';
  showOnMobile: boolean;
}

/** La política de Bulwark (SettingsPolicy) que se envía entera con PUT. */
export interface PoliticaBulwark {
  restrictions: Record<string, unknown>;
  features: Record<string, boolean>;
  defaults: Record<string, unknown>;
  themePolicy: { disabledBuiltinThemes: string[]; disabledThemes: string[]; defaultThemeId: string | null };
  forceEnabledPlugins: string[];
  approvedPlugins: string[];
  forceEnabledThemes: string[];
  pushRelays: { label: string; url: string }[];
  pushRelayUrl: string;
  pushRelayUrlLocked: boolean;
  defaultSidebarApps: AppLateralBulwark[];
}

export interface OpcionesPoliticaBulwark {
  /**
   * «Mi buzón» del panel de la instancia: app fija en la barra lateral, que
   * se abre en otra pestaña. La política es de toda la instancia, no por
   * cliente: el enlace por cliente es el de la pantalla de acceso.
   */
  miBuzonUrl?: string;
  /** Calendario y tareas (CalDAV/JMAP del motor). Por defecto, sí. */
  calendario?: boolean;
  /** Contactos del servidor (CardDAV/JMAP). Por defecto, sí. */
  contactos?: boolean;
  /** Archivos del motor (FileNode/WebDAV): ocupan la cuota del buzón. Por defecto, no. */
  archivos?: boolean;
  /**
   * Relé de notificaciones push propio (https). Sin él, quien active las
   * notificaciones del navegador las recibe a través del relé alojado de
   * Bulwark (ver deploy/bulwark/README.md).
   */
  relePush?: string;
}

export const ID_APP_MI_BUZON = 'admin-app-mi-buzon';

/**
 * La política de Mailway para Bulwark. Todos los interruptores van
 * explícitos para que un valor por defecto que cambie en una versión nueva
 * de Bulwark no cambie lo que ven los usuarios sin que nadie lo decida.
 */
export function politicaBulwark(opciones: OpcionesPoliticaBulwark = {}): PoliticaBulwark {
  const calendario = opciones.calendario ?? true;
  const miBuzon = urlHttps(opciones.miBuzonUrl, 'la política', 'el enlace a «Mi buzón»');
  const rele = urlHttps(opciones.relePush, 'la política', 'el relé de notificaciones');
  return {
    restrictions: {},
    features: {
      // Complementos: código de terceros en el origen del correo web.
      pluginsEnabled: false,
      pluginsUploadEnabled: false,
      requirePluginApproval: true,
      themesEnabled: true,
      // Temas que sube cada usuario (CSS propio): superficie sin beneficio claro.
      userThemesEnabled: false,
      // Apps que añade cada usuario a la barra lateral: amplían frame-src de
      // la CSP con orígenes arbitrarios. Las fijas de la política siguen.
      sidebarAppsEnabled: false,
      settingsExportEnabled: true,
      customKeywordsEnabled: true,
      templatesEnabled: true,
      calendarEnabled: calendario,
      calendarTasksEnabled: calendario,
      smimeEnabled: true,
      externalContentEnabled: true,
      debugModeEnabled: false,
      folderIconsEnabled: true,
      hoverActionsConfigEnabled: true,
      tabTitleSubjectEnabled: true,
      filesEnabled: opciones.archivos ?? false,
      contactsEnabled: opciones.contactos ?? true,
      allMailViewEnabled: false,
      crossUnreadViewEnabled: false,
      crossStarredViewEnabled: false,
      crossAllViewEnabled: false,
      unifiedCrossAccountEnabled: false,
    },
    // Los favicons de los remitentes los pide el servidor de Bulwark a cada
    // dominio que escribe. Bulwark 1.13 guarda «defaults» pero aún no los
    // aplica (comprobado en el ensayo), así que hoy los corta la pasarela
    // (/api/favicon); el valor queda para cuando los aplique.
    defaults: { senderFavicons: false },
    themePolicy: { disabledBuiltinThemes: [], disabledThemes: [], defaultThemeId: null },
    forceEnabledPlugins: [],
    approvedPlugins: [],
    forceEnabledThemes: [],
    pushRelays: [],
    pushRelayUrl: rele ? rele.replace(/\/+$/, '') : '',
    pushRelayUrlLocked: Boolean(rele),
    defaultSidebarApps: miBuzon
      ? [
          {
            id: ID_APP_MI_BUZON,
            name: 'Mi buzón',
            url: miBuzon,
            icon: 'tabler:user-circle',
            // El panel no se deja enmarcar: en una pestaña propia.
            openMode: 'tab',
            showOnMobile: true,
          },
        ]
      : [],
  };
}

/** JSON con las claves de los objetos ordenadas: misma estructura, misma cadena. */
function jsonCanonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(',')}]`;
  if (valor && typeof valor === 'object') {
    const claves = Object.keys(valor as Record<string, unknown>)
      .filter((k) => (valor as Record<string, unknown>)[k] !== undefined)
      .sort();
    return `{${claves.map((k) => `${JSON.stringify(k)}:${jsonCanonico((valor as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(valor ?? null);
}

/**
 * ¿La política guardada en Bulwark es ya la deseada? Se compara todo lo que
 * Mailway fija; de los interruptores, solo los que Mailway conoce: los que
 * traiga una versión nueva de Bulwark se quedan con su valor por defecto.
 */
export function politicaCoincide(guardada: unknown, deseada: PoliticaBulwark): boolean {
  if (!guardada || typeof guardada !== 'object') return false;
  const g = guardada as Record<string, unknown>;
  const featuresGuardadas = (g.features && typeof g.features === 'object' ? g.features : {}) as Record<string, unknown>;
  for (const [clave, valor] of Object.entries(deseada.features)) {
    if (featuresGuardadas[clave] !== valor) return false;
  }
  const { features: _features, ...resto } = deseada;
  for (const [clave, valor] of Object.entries(resto)) {
    if (jsonCanonico(g[clave] ?? null) !== jsonCanonico(valor)) return false;
  }
  return true;
}

/* ---------------------------------- Huella ----------------------------------- */

export interface EstadoDeseadoBulwark {
  marca: EntradaMarcaBulwark[];
  politica: PoliticaBulwark;
}

/**
 * Huella estable de lo que se quiere tener en Bulwark (sha256 en hex). No
 * depende del orden de los webmail ni de las claves: si coincide con la de la
 * última sincronización correcta, no hace falta ni iniciar sesión.
 */
export function huellaBulwark(estado: EstadoDeseadoBulwark): string {
  const canonico = jsonCanonico({ marca: normalizarMarcaBulwark(estado.marca), politica: estado.politica });
  return crypto.createHash('sha256').update(canonico).digest('hex');
}

/**
 * Cada cuánto se compara con Bulwark aunque la huella no haya cambiado: si
 * su volumen se pierde o alguien toca la configuración a mano, la marca se
 * repone sola. Cada comparación cuesta un inicio de sesión como mucho.
 */
export const REVISION_BULWARK_MS = 6 * 60 * 60 * 1000;

export function necesitaSincronizarBulwark(opciones: {
  huellaActual: string;
  huellaAplicada: string | null;
  aplicadaEn: number | null;
  ahora?: number;
  revisionMs?: number;
}): boolean {
  if (!opciones.huellaAplicada || opciones.huellaAplicada !== opciones.huellaActual) return true;
  if (opciones.aplicadaEn === null) return true;
  const ahora = opciones.ahora ?? Date.now();
  return ahora - opciones.aplicadaEn >= (opciones.revisionMs ?? REVISION_BULWARK_MS);
}

/* ------------------------- Cliente de administración ------------------------- */

/** Error de Bulwark con el código estable del panel; `reintentarEnS` si limita. */
export class ErrorBulwark extends HttpError {
  reintentarEnS?: number;

  constructor(message: string, code: string, reintentarEnS?: number) {
    super(502, message, code);
    this.reintentarEnS = reintentarEnS;
  }
}

export interface OpcionesClienteBulwark {
  /** Dirección interna de Bulwark (http://mailway-bulwark:3000), nunca la pasarela. */
  url: string;
  /** ADMIN_PASSWORD de Bulwark. No aparece en errores ni registros. */
  contrasena: string;
  /** Tiempo máximo de cada petición. */
  tiempoMaximoMs?: number;
  /** Para las pruebas. */
  fetch?: typeof fetch;
}

const COOKIE_ADMIN = 'admin_session';
/** ADMIN_SESSION_TTL por defecto de Bulwark, si la cookie no dice otra cosa. */
const DURACION_SESION_S = 3600;
/** Se renueva antes de que caduque: una petición no debe empezar con la sesión agotándose. */
const MARGEN_SESION_MS = 60_000;

interface Respuesta {
  status: number;
  datos: unknown;
  cabeceras: Headers;
}

function textoError(datos: unknown): string {
  const error = datos && typeof datos === 'object' ? (datos as { error?: unknown }).error : undefined;
  return typeof error === 'string' && error ? error.slice(0, 200) : '';
}

function codigoRed(err: unknown): string {
  let actual: unknown = err;
  for (let i = 0; i < 4 && actual && typeof actual === 'object'; i++) {
    const code = (actual as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    actual = (actual as { cause?: unknown }).cause;
  }
  return 'error de red';
}

/**
 * Cliente de la API de administración de Bulwark. Inicia sesión con la
 * contraseña de administración, reutiliza la cookie mientras dura (cada
 * inicio cuenta para el límite de Bulwark) y aplica marca y política solo si
 * difieren de lo guardado: llamarlo dos veces seguidas no escribe nada.
 */
export class ClienteAdminBulwark {
  private readonly base: string;
  private readonly contrasena: string;
  private readonly tiempoMaximoMs: number;
  private readonly fetchImpl: typeof fetch;
  private cookie: string | null = null;
  private caducaEn = 0;
  private iniciando: Promise<string> | null = null;

  constructor(opciones: OpcionesClienteBulwark) {
    let url: URL;
    try {
      url = new URL(opciones.url);
    } catch {
      throw badRequest('La dirección interna de Bulwark no es válida.', 'bulwark_configuracion');
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      throw badRequest('La dirección interna de Bulwark debe ser http(s):// y sin credenciales.', 'bulwark_configuracion');
    }
    if (!opciones.contrasena) {
      throw badRequest('Falta la contraseña de administración de Bulwark.', 'bulwark_configuracion');
    }
    this.base = url.origin + url.pathname.replace(/\/+$/, '');
    this.contrasena = opciones.contrasena;
    this.tiempoMaximoMs = opciones.tiempoMaximoMs ?? 10_000;
    this.fetchImpl = opciones.fetch ?? fetch;
  }

  /** Estado de /api/health (no necesita sesión). */
  async salud(): Promise<string> {
    const r = await this.peticion('GET', '/api/health');
    const estado = r.datos && typeof r.datos === 'object' ? (r.datos as { status?: unknown }).status : undefined;
    if (r.status !== 200 || typeof estado !== 'string') {
      throw new ErrorBulwark(`Bulwark ha respondido ${r.status} a la comprobación de salud.`, 'bulwark_error');
    }
    return estado;
  }

  /** La marca por dominio guardada en Bulwark, normalizada. */
  async leerMarca(): Promise<EntradaMarcaBulwark[]> {
    const config = await this.leerConfiguracion();
    return normalizarMarcaBulwark(config.domainBranding?.value);
  }

  /**
   * Deja domainBranding como `entradas` si no lo está ya. Devuelve además las
   * claves que alguien fijó en config.json de Bulwark: tapan las variables
   * de entorno del compose y conviene saberlo.
   */
  async aplicarMarca(entradas: EntradaMarcaBulwark[]): Promise<{ cambiada: boolean; clavesFijadas: string[] }> {
    const deseada = normalizarMarcaBulwark(entradas);
    if (deseada.length !== entradas.length) {
      throw badRequest('La marca para Bulwark tiene entradas que Bulwark descartaría.', 'bulwark_marca_invalida');
    }
    const config = await this.leerConfiguracion();
    const clavesFijadas = Object.entries(config)
      .filter(([clave, v]) => v?.source === 'admin' && clave !== 'domainBranding')
      .map(([clave]) => clave)
      .sort();
    const guardada = normalizarMarcaBulwark(config.domainBranding?.value);
    if (jsonCanonico(guardada) === jsonCanonico(deseada)) return { cambiada: false, clavesFijadas };
    const r = await this.conSesion('PATCH', '/api/admin/config', { domainBranding: deseada });
    this.exigirOk(r, 'la marca por dominio');
    return { cambiada: true, clavesFijadas };
  }

  /** La política completa guardada en Bulwark (con la sesión de administración). */
  async leerPolitica(): Promise<unknown> {
    const r = await this.conSesion('GET', '/api/admin/policy');
    this.exigirOk(r, 'la lectura de la política');
    if (r.cabeceras.get('x-bulwark-policy-scope') === 'public') {
      // Sin la sesión, Bulwark responde la parte pública (sin las apps de la
      // barra lateral): compararla daría siempre «distinta».
      throw new ErrorBulwark('Bulwark ha devuelto la política pública en lugar de la completa.', 'bulwark_error');
    }
    return r.datos;
  }

  async aplicarPolitica(politica: PoliticaBulwark): Promise<{ cambiada: boolean }> {
    if (politicaCoincide(await this.leerPolitica(), politica)) return { cambiada: false };
    const r = await this.conSesion('PUT', '/api/admin/policy', politica);
    this.exigirOk(r, 'la política');
    return { cambiada: true };
  }

  private async leerConfiguracion(): Promise<Record<string, { value?: unknown; source?: string } | undefined>> {
    const r = await this.conSesion('GET', '/api/admin/config');
    this.exigirOk(r, 'la lectura de la configuración');
    if (!r.datos || typeof r.datos !== 'object' || Array.isArray(r.datos)) {
      throw new ErrorBulwark('Bulwark ha devuelto una configuración con un formato inesperado.', 'bulwark_error');
    }
    return r.datos as Record<string, { value?: unknown; source?: string } | undefined>;
  }

  private exigirOk(r: Respuesta, que: string): void {
    if (r.status >= 200 && r.status < 300) return;
    const detalle = textoError(r.datos);
    if (r.status === 400) {
      throw new ErrorBulwark(`Bulwark ha rechazado ${que}${detalle ? `: ${detalle}` : '.'}`, 'bulwark_rechazo');
    }
    if (r.status === 403) throw this.errorOrigen();
    throw new ErrorBulwark(`Bulwark ha respondido ${r.status} a ${que}${detalle ? `: ${detalle}` : '.'}`, 'bulwark_error');
  }

  private errorOrigen(): ErrorBulwark {
    return new ErrorBulwark(
      'Bulwark ha rechazado la petición en su comprobación de origen. El panel debe llamarlo directamente por la red interna, sin pasar por la pasarela.',
      'bulwark_origen',
    );
  }

  /** Hace la petición con la sesión; si Bulwark la da por caducada, inicia otra una sola vez. */
  private async conSesion(metodo: string, ruta: string, cuerpo?: unknown): Promise<Respuesta> {
    const cookie = await this.sesion();
    const r = await this.peticion(metodo, ruta, cuerpo, cookie);
    if (r.status !== 401) return r;
    // Caducada o firmada con otro SESSION_SECRET (contenedor recreado).
    this.olvidarSesion(cookie);
    const nueva = await this.sesion();
    const reintento = await this.peticion(metodo, ruta, cuerpo, nueva);
    if (reintento.status === 401) {
      this.olvidarSesion(nueva);
      throw new ErrorBulwark('Bulwark no acepta la sesión de administración recién iniciada.', 'bulwark_error');
    }
    return reintento;
  }

  private olvidarSesion(cookie: string): void {
    if (this.cookie === cookie) {
      this.cookie = null;
      this.caducaEn = 0;
    }
  }

  private async sesion(): Promise<string> {
    if (this.cookie && Date.now() < this.caducaEn) return this.cookie;
    // Una sola sesión aunque lleguen varias peticiones a la vez: cada intento
    // gasta uno de los cinco inicios que Bulwark admite cada 15 minutos.
    if (!this.iniciando) {
      this.iniciando = this.iniciarSesion().finally(() => {
        this.iniciando = null;
      });
    }
    return this.iniciando;
  }

  private async iniciarSesion(): Promise<string> {
    const r = await this.peticion('POST', '/api/admin/auth', { password: this.contrasena });
    if (r.status === 401) {
      throw new ErrorBulwark(
        'Bulwark ha rechazado la contraseña de administración. Solo lee ADMIN_PASSWORD en su primer arranque y después usa la que guardó en admin.json: revisa BULWARK_ADMIN_PASSWORD en deploy/.env o vuelve a generar admin.json (deploy/bulwark/README.md).',
        'bulwark_credenciales',
      );
    }
    if (r.status === 404) {
      throw new ErrorBulwark(
        'La administración de Bulwark está desactivada: falta ADMIN_PASSWORD en su contenedor.',
        'bulwark_admin_desactivado',
      );
    }
    if (r.status === 429) {
      const segundos = Number.parseInt(r.cabeceras.get('retry-after') ?? '', 10);
      const espera = Number.isFinite(segundos) && segundos > 0 ? segundos : undefined;
      throw new ErrorBulwark(
        `Bulwark limita los inicios de sesión de administración${espera ? `: vuelve a intentarlo dentro de ${espera} s` : ''}.`,
        'bulwark_limite',
        espera,
      );
    }
    if (r.status === 403) throw this.errorOrigen();
    if (r.status !== 200) {
      const detalle = textoError(r.datos);
      throw new ErrorBulwark(
        `Bulwark ha respondido ${r.status} al iniciar sesión${detalle ? `: ${detalle}` : '.'}`,
        'bulwark_error',
      );
    }
    const cookie = this.extraerCookie(r.cabeceras);
    if (!cookie) {
      throw new ErrorBulwark('Bulwark no ha devuelto la cookie de la sesión de administración.', 'bulwark_error');
    }
    this.cookie = cookie.valor;
    this.caducaEn = Date.now() + cookie.duracionS * 1000 - MARGEN_SESION_MS;
    return cookie.valor;
  }

  private extraerCookie(cabeceras: Headers): { valor: string; duracionS: number } | null {
    for (const linea of cabeceras.getSetCookie()) {
      const [par, ...atributos] = linea.split(';');
      const igual = par?.indexOf('=') ?? -1;
      if (!par || igual < 0 || par.slice(0, igual).trim() !== COOKIE_ADMIN) continue;
      const valor = par.slice(igual + 1).trim();
      if (!valor) continue;
      let duracionS = DURACION_SESION_S;
      for (const atributo of atributos) {
        const [nombre, v] = atributo.split('=');
        if (nombre?.trim().toLowerCase() === 'max-age') {
          const n = Number.parseInt(v ?? '', 10);
          if (Number.isFinite(n) && n > 0) duracionS = n;
        }
      }
      return { valor: `${COOKIE_ADMIN}=${valor}`, duracionS };
    }
    return null;
  }

  private async peticion(metodo: string, ruta: string, cuerpo?: unknown, cookie?: string): Promise<Respuesta> {
    // Sin Origin ni Sec-Fetch-Site: así Bulwark la trata como de servidor a
    // servidor (su CSRF solo rechaza navegadores de otro origen).
    const cabeceras: Record<string, string> = { accept: 'application/json' };
    if (cuerpo !== undefined) cabeceras['content-type'] = 'application/json';
    if (cookie) cabeceras.cookie = cookie;
    let respuesta: Response;
    try {
      respuesta = await this.fetchImpl(this.base + ruta, {
        method: metodo,
        headers: cabeceras,
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.tiempoMaximoMs),
      });
    } catch (err) {
      const nombre = (err as { name?: unknown } | null)?.name;
      if (nombre === 'TimeoutError' || nombre === 'AbortError') {
        throw new ErrorBulwark(
          `Bulwark no ha respondido en ${Math.ceil(this.tiempoMaximoMs / 1000)} s (${this.base}).`,
          'bulwark_inaccesible',
        );
      }
      throw new ErrorBulwark(`No se ha podido conectar con Bulwark en ${this.base} (${codigoRed(err)}).`, 'bulwark_inaccesible');
    }
    let datos: unknown = null;
    try {
      const textoRespuesta = await respuesta.text();
      datos = textoRespuesta ? JSON.parse(textoRespuesta) : null;
    } catch {
      // Respuesta que no es JSON (una página de error de un proxy): cuenta el estado.
      datos = null;
    }
    return { status: respuesta.status, datos, cabeceras: respuesta.headers };
  }
}

export interface ResultadoSincronizacionBulwark {
  huella: string;
  marcaCambiada: boolean;
  politicaCambiada: boolean;
  /** Claves fijadas en config.json de Bulwark que tapan su entorno. */
  clavesFijadas: string[];
}

/** Aplica marca y política (solo lo que difiera) y devuelve la huella aplicada. */
export async function sincronizarBulwark(
  cliente: ClienteAdminBulwark,
  deseado: EstadoDeseadoBulwark,
): Promise<ResultadoSincronizacionBulwark> {
  const marca = await cliente.aplicarMarca(deseado.marca);
  const politica = await cliente.aplicarPolitica(deseado.politica);
  return {
    huella: huellaBulwark(deseado),
    marcaCambiada: marca.cambiada,
    politicaCambiada: politica.cambiada,
    clavesFijadas: marca.clavesFijadas,
  };
}
