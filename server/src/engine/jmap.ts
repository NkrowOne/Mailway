import { HttpError, upstream } from '../core/errors';
import { RutaDeGestionAusente } from './errores';

/**
 * Cliente JMAP mínimo para la API de gestión de Stalwart 0.16 (objetos `x:`).
 *
 * Solo lo que necesita el driver: la sesión (`GET /jmap/session`) y las
 * peticiones (`POST /jmap`) con las capacidades de gestión. Comprobado contra
 * Stalwart v0.16.25 en ejecución:
 * - Desde 0.16.10 el `Content-Type: application/json` es obligatorio y los
 *   métodos `x:` solo existen si `urn:stalwart:jmap` va en `using`.
 * - Los errores de petición llegan como HTTP 4xx con `application/problem+json`
 *   (401 sin credenciales válidas, 400 `notRequest`…). Los de método, con HTTP
 *   200 y `["error", {type, description}, id]`. Los de cada objeto, dentro de
 *   `notCreated`/`notUpdated`/`notDestroyed`: un HTTP 200 NO significa que la
 *   operación haya salido bien, hay que mirar el cuerpo.
 * - Stalwart 0.15 también responde `GET /jmap/session`, pero sin la capacidad
 *   `urn:stalwart:jmap`, y rechaza las peticiones con ella. Eso (o un 404 en la
 *   ruta) significa «este motor no habla esta API»: `RutaDeGestionAusente`, para
 *   que el detector vuelva a averiguar la versión.
 */

export const CAPACIDAD_CORE = 'urn:ietf:params:jmap:core';
export const CAPACIDAD_STALWART = 'urn:stalwart:jmap';
const USING = [CAPACIDAD_CORE, CAPACIDAD_STALWART];

export type Argumentos = Record<string, unknown>;
export type LlamadaJmap = [metodo: string, argumentos: Argumentos, id: string];
type RespuestaCruda = [nombre: string, argumentos: Argumentos, id: string];

export interface SesionJmap {
  capabilities?: Record<string, unknown>;
  accounts?: Record<string, { accountCapabilities?: Record<string, unknown> } | undefined>;
  primaryAccounts?: Record<string, string>;
  [clave: string]: unknown;
}

/**
 * ¿La sesión ofrece la API de gestión? Stalwart 0.16.25 NO la pone en las
 * capacidades generales de la sesión (`capabilities`), sino en las de la
 * cuenta (`accounts[id].accountCapabilities`) y en `primaryAccounts`; se mira
 * en los tres sitios por si una versión posterior la sube a las generales.
 * Stalwart 0.15 no la ofrece en ninguno.
 */
export function ofreceGestion(sesion: SesionJmap): boolean {
  if (sesion.capabilities && CAPACIDAD_STALWART in sesion.capabilities) return true;
  if (sesion.primaryAccounts && CAPACIDAD_STALWART in sesion.primaryAccounts) return true;
  return Object.values(sesion.accounts ?? {}).some(
    (cuenta) => !!cuenta?.accountCapabilities && CAPACIDAD_STALWART in cuenta.accountCapabilities,
  );
}

export interface OpcionesClienteJmap {
  url: string;
  usuario: string;
  clave: string;
  /** Límite de cada petición HTTP. */
  timeoutMs?: number;
  /** Espera antes de repetir tras un 429 que no trae Retry-After. */
  esperaTrasLimiteMs?: number;
}

/** Referencia a un objeto del registro tal como la da Stalwart en los errores. */
export interface ObjetoJmap {
  object: string;
  id: string;
}

/** Error de un objeto concreto (`SetError` de RFC 8620 con las extensiones de Stalwart). */
export interface ErrorDeConjunto {
  type?: string;
  description?: string;
  properties?: string[];
  objectId?: ObjetoJmap | string | null;
  linkedObjects?: ObjetoJmap[];
  validationErrors?: { type?: string; property?: string; [clave: string]: unknown }[];
}

/**
 * Error de un objeto concreto ya traducido a los códigos estables del panel.
 * Conserva el detalle de Stalwart: en un alta duplicada, `objectId` dice CUÁL
 * es el objeto que ya existe (y de qué tipo: un alias que choca con un buzón
 * no se puede «adoptar»).
 */
export class ErrorDeObjetoJmap extends HttpError {
  readonly tipo: string;
  readonly detalle: ErrorDeConjunto;

  constructor(status: number, message: string, code: string, tipo: string, detalle: ErrorDeConjunto) {
    super(status, message, code);
    this.tipo = tipo;
    this.detalle = detalle;
  }

  /** Objeto al que se refiere el error (el existente en un duplicado), si lo dice. */
  get objeto(): ObjetoJmap | null {
    const ref = this.detalle.objectId;
    if (ref && typeof ref === 'object' && typeof ref.id === 'string') return ref;
    return null;
  }
}

/** Nombres legibles de los objetos que puede citar un `objectIsLinked`. */
const NOMBRES_ENLAZADOS: Record<string, [singular: string, plural: string]> = {
  Account: ['un buzón', 'buzones'],
  MailingList: ['un alias', 'alias'],
  DkimSignature: ['una firma DKIM', 'firmas DKIM'],
  Domain: ['un dominio', 'dominios'],
  Certificate: ['un certificado', 'certificados'],
  Tenant: ['un cliente del motor', 'clientes del motor'],
};

/** «2 buzones, 1 alias y los ajustes del sistema (…)». */
export function resumirEnlazados(enlazados: ObjetoJmap[] | undefined): string {
  const cuenta = new Map<string, number>();
  for (const e of enlazados ?? []) cuenta.set(e.object, (cuenta.get(e.object) ?? 0) + 1);
  const partes: string[] = [];
  for (const [objeto, n] of cuenta) {
    if (objeto === 'SystemSettings') {
      partes.push('los ajustes del sistema (es el dominio por defecto del motor; aplica los ajustes recomendados para que lo sea el dominio reservado del servidor)');
      continue;
    }
    const nombres = NOMBRES_ENLAZADOS[objeto];
    if (!nombres) partes.push(`${n} ${objeto}`);
    else partes.push(n === 1 ? nombres[0] : `${n} ${nombres[1]}`);
  }
  if (partes.length === 0) return 'otros elementos';
  if (partes.length === 1) return partes[0]!;
  return `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}`;
}

/**
 * Traduce el error de un objeto. `que` describe el objeto en español («el
 * dominio cliente.com», «el buzón ana@cliente.com») para que el mensaje se
 * pueda mostrar tal cual.
 */
export function errorDeObjeto(detalle: ErrorDeConjunto, que: string): ErrorDeObjetoJmap {
  const tipo = String(detalle.type ?? 'desconocido');
  if (tipo === 'notFound') {
    return new ErrorDeObjetoJmap(502, `El motor de correo no encuentra ${que}.`, 'engine_not_found', tipo, detalle);
  }
  if (tipo === 'primaryKeyViolation') {
    return new ErrorDeObjetoJmap(502, `El motor de correo ya tiene ${que}.`, 'engine_exists', tipo, detalle);
  }
  if (tipo === 'objectIsLinked') {
    return new ErrorDeObjetoJmap(
      502,
      `El motor de correo no puede borrar ${que} porque aún tiene elementos enlazados: ${resumirEnlazados(detalle.linkedObjects)}.`,
      'engine_error',
      tipo,
      detalle,
    );
  }
  const partes: string[] = [];
  if (detalle.description) partes.push(detalle.description);
  if (detalle.properties?.length) partes.push(`propiedades: ${detalle.properties.join(', ')}`);
  for (const v of detalle.validationErrors ?? []) {
    partes.push([v.type, v.property].filter(Boolean).join(' '));
  }
  const ref = detalle.objectId;
  if (tipo === 'invalidForeignKey' && ref && typeof ref === 'object') {
    partes.push(`no existe ${ref.object} ${ref.id}`);
  }
  return new ErrorDeObjetoJmap(
    502,
    `El motor de correo rechazó la operación sobre ${que} (${tipo})${partes.length ? `: ${partes.join('; ')}` : ''}.`,
    'engine_error',
    tipo,
    detalle,
  );
}

/** Respuestas de una petición, por identificador de llamada. */
export class RespuestasJmap {
  constructor(private readonly respuestas: RespuestaCruda[], private readonly llamadas: LlamadaJmap[]) {}

  /**
   * Argumentos de la respuesta a la llamada `id`. Si el método falló entero
   * («error»), lanza el error ya traducido.
   */
  de<T = Argumentos>(id: string): T {
    const respuesta = this.respuestas.find((r) => r[2] === id);
    const metodo = this.llamadas.find((l) => l[2] === id)?.[0] ?? id;
    if (!respuesta) {
      throw upstream(`El motor de correo no respondió a ${metodo}.`, 'engine_error');
    }
    if (respuesta[0] === 'error') throw errorDeMetodo(metodo, respuesta[1]);
    return respuesta[1] as T;
  }
}

/** Error de un método completo (`["error", {type, description}, id]`). */
export function errorDeMetodo(metodo: string, error: Argumentos): HttpError {
  const tipo = typeof error.type === 'string' ? error.type : 'desconocido';
  const descripcion = typeof error.description === 'string' ? error.description : '';
  if (tipo === 'unknownMethod' && metodo.startsWith('x:')) {
    // Un motor sin la API de gestión de 0.16 (0.15 tras volver atrás) no
    // conoce los métodos `x:`: no es un fallo de la operación sino de versión.
    return new RutaDeGestionAusente(
      `El motor de correo no reconoce el método de gestión ${metodo}: no parece Stalwart 0.16. Revisa la versión del motor y su URL en Ajustes.`,
    );
  }
  if (tipo === 'forbidden') {
    return upstream(
      `El motor de correo no permite ${metodo} con las credenciales de administración${descripcion ? `: ${descripcion}` : ''}. Revisa que el usuario del motor en Ajustes sea el administrador (STALWART_RECOVERY_ADMIN).`,
      'engine_error',
    );
  }
  return upstream(
    `El motor de correo rechazó ${metodo} (${tipo})${descripcion ? `: ${descripcion}` : ''}.`,
    'engine_error',
  );
}

interface Problema {
  type?: string;
  title?: string;
  detail?: string;
  status?: number;
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ClienteJmap {
  /**
   * Peticiones en serie: Stalwart limita las simultáneas por cuenta
   * (`maxConcurrentRequests`, 4 por defecto) y el panel puede lanzar varias a
   * la vez (vigilante, ficha del dominio, altas masivas). En fila nunca se
   * pisan ni se acercan al límite.
   */
  private cola: Promise<unknown> = Promise.resolve();

  constructor(private readonly opciones: OpcionesClienteJmap) {}

  get base(): string {
    return this.opciones.url.replace(/\/+$/, '');
  }

  private autorizacion(): string {
    const raw = `${this.opciones.usuario}:${this.opciones.clave}`;
    return `Basic ${Buffer.from(raw).toString('base64')}`;
  }

  private enFila<T>(tarea: () => Promise<T>): Promise<T> {
    const resultado = this.cola.then(tarea);
    // La fila sigue aunque una tarea falle; el error lo recibe quien la pidió.
    this.cola = resultado.catch(() => undefined);
    return resultado;
  }

  /** `GET /jmap/session`. */
  sesion(): Promise<SesionJmap> {
    return this.enFila(async () => {
      const { cuerpo } = await this.http('GET', '/jmap/session');
      return (cuerpo ?? {}) as SesionJmap;
    });
  }

  /**
   * `POST /jmap` con las capacidades de gestión. `timeoutMs` alarga el límite
   * para las operaciones que el motor hace de una vez y tardan (la recarga de
   * la configuración).
   */
  peticion(llamadas: LlamadaJmap[], opciones: { timeoutMs?: number } = {}): Promise<RespuestasJmap> {
    return this.enFila(async () => {
      const { cuerpo } = await this.http('POST', '/jmap', { using: USING, methodCalls: llamadas }, opciones.timeoutMs);
      const respuestas = (cuerpo as { methodResponses?: unknown } | null)?.methodResponses;
      if (!Array.isArray(respuestas)) {
        throw upstream('El motor de correo devolvió una respuesta JMAP sin methodResponses.', 'engine_error');
      }
      return new RespuestasJmap(respuestas as RespuestaCruda[], llamadas);
    });
  }

  private async http(
    metodo: 'GET' | 'POST',
    ruta: string,
    cuerpo?: unknown,
    timeoutMs?: number,
  ): Promise<{ cuerpo: unknown }> {
    let res = await this.enviar(metodo, ruta, cuerpo, timeoutMs);
    if (res.status === 429) {
      // Una sola repetición: si el motor sigue limitando, insistir solo
      // alargaría la espera de quien está delante del panel.
      await res.text().catch(() => '');
      await esperar(this.esperaTrasLimite(res));
      res = await this.enviar(metodo, ruta, cuerpo, timeoutMs);
    }
    let texto: string;
    try {
      texto = await res.text();
    } catch (err) {
      // El límite de tiempo también corta la lectura del cuerpo.
      throw this.sinConexion(err, timeoutMs);
    }
    let datos: unknown = null;
    try {
      datos = texto ? JSON.parse(texto) : null;
    } catch {
      // Cuerpo no JSON: se conserva el texto para el mensaje de error.
    }
    if (res.ok) return { cuerpo: datos };

    const problema = (datos && typeof datos === 'object' ? datos : {}) as Problema;
    const detalle = problema.detail || problema.title || texto.slice(0, 300) || res.statusText;
    if (res.status === 401) {
      throw new HttpError(
        502,
        'El motor de correo rechazó las credenciales de administración (HTTP 401). Revisa el usuario y la contraseña del motor en Ajustes: en Stalwart 0.16 son los de STALWART_RECOVERY_ADMIN.',
        'engine_auth_failed',
      );
    }
    if (res.status === 404) {
      throw new RutaDeGestionAusente(
        `El motor de correo no reconoce la ruta de gestión ${ruta} (HTTP 404). Revisa la URL del motor en Ajustes: debe ser la del puerto HTTP de Stalwart 0.16.`,
      );
    }
    if (res.status === 429) {
      throw upstream(
        'El motor de correo está limitando las peticiones del panel (HTTP 429). Vuelve a intentarlo en unos segundos.',
        'engine_error',
      );
    }
    const tipo = problema.type ?? '';
    if (
      tipo.endsWith(':unknownCapability') ||
      // Stalwart 0.15 rechaza la capacidad desconocida al analizar la petición
      // («Unknown capability: "urn:stalwart:jmap"») con un notRequest.
      (tipo.endsWith(':notRequest') && /unknown capability/i.test(detalle) && detalle.includes(CAPACIDAD_STALWART))
    ) {
      throw new RutaDeGestionAusente(
        `El motor de correo no admite la API de gestión de Stalwart 0.16 (${CAPACIDAD_STALWART}). Revisa la versión del motor y su URL en Ajustes.`,
      );
    }
    throw upstream(`El motor de correo respondió ${res.status}: ${detalle}`, 'engine_error');
  }

  private esperaTrasLimite(res: Response): number {
    const pedida = Number(res.headers.get('retry-after'));
    if (Number.isFinite(pedida) && pedida > 0) return Math.min(pedida * 1000, 5_000);
    return this.opciones.esperaTrasLimiteMs ?? 1_000;
  }

  private async enviar(
    metodo: 'GET' | 'POST',
    ruta: string,
    cuerpo: unknown,
    timeoutPedido: number | undefined,
  ): Promise<Response> {
    const timeoutMs = timeoutPedido ?? this.opciones.timeoutMs ?? 15_000;
    try {
      return await fetch(`${this.base}${ruta}`, {
        method: metodo,
        headers: {
          Authorization: this.autorizacion(),
          Accept: 'application/json',
          ...(cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw this.sinConexion(err, timeoutMs);
    }
  }

  private sinConexion(err: unknown, timeoutPedido: number | undefined): HttpError {
    const timeoutMs = timeoutPedido ?? this.opciones.timeoutMs ?? 15_000;
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const motivo =
      e.name === 'TimeoutError' || e.name === 'AbortError'
        ? `no respondió en ${Math.max(1, Math.round(timeoutMs / 1000))} s`
        : [e.message, e.cause?.code ?? e.cause?.message].filter(Boolean).join(': ');
    return upstream(`No se pudo conectar con el motor de correo (${this.base}): ${motivo}`, 'engine_unreachable');
  }
}
