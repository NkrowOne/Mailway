import net from 'node:net';
import { HttpError, upstream } from '../core/errors';
import { isValidHostname, normalizeHostname } from '../core/hostnames';
import { motorNoAdmite, RutaDeGestionAusente } from './errores';
import {
  CAPACIDAD_STALWART,
  ClienteJmap,
  errorDeObjeto,
  ErrorDeObjetoJmap,
  ofreceGestion,
  type Argumentos,
  type ErrorDeConjunto,
  type LlamadaJmap,
  type RespuestasJmap,
} from './jmap';
import { analizarZonaBind } from './zonabind';
import type {
  AcmeInput,
  CreatedAppPassword,
  CreateMailboxInput,
  EngineAcmeStatus,
  EngineApi,
  EngineDirectory,
  EngineDnsRecord,
  EngineHealth,
  EngineReloadResult,
  EngineSettings,
  EngineSettingsStatus,
  MailboxCredentials,
  MailEngine,
  QueueSummary,
  RecommendedInput,
  UpdateMailboxPatch,
} from './types';

/**
 * Driver para Stalwart 0.16 (gestión por JMAP en `/jmap`, objetos `x:`).
 *
 * Todo lo que asume está comprobado contra Stalwart v0.16.25 en ejecución
 * (server/test/motor016-real.test.ts) y en su código fuente:
 * - Autenticación Basic con el administrador de recuperación
 *   (`STALWART_RECOVERY_ADMIN=admin:<clave>`), que vale también fuera del modo
 *   de recuperación y tiene todos los permisos, incluido `impersonate`.
 * - Los nombres de cuenta y de lista son la parte local; el dominio va aparte
 *   (`domainId`). Las direcciones completas solo existen al leer
 *   (`emailAddress`).
 * - Un hash `$6$` se guarda tal cual como contraseña principal: el motor no lo
 *   vuelve a cifrar ni le pasa el control de fortaleza.
 * - Las contraseñas de aplicación las genera el motor (`app_…`) y solo se ven
 *   en el alta. El administrador puede crearlas para otra cuenta con
 *   `accountId` (la documentación dice que no; el código y el servidor, que sí).
 * - Las consultas paginadas solo son coherentes ordenando por id ascendente:
 *   con el orden por defecto (descendente) Stalwart corta las páginas sobre
 *   la lista ascendente y las ordena después, así que se solapan.
 * - Los ajustes (`SystemSettings`, `Http`, `AllowedIp`…) se aplican con la
 *   acción `ReloadSettings`; los puertos nuevos, solo al reiniciar.
 */

/** Página de consultas y lecturas: `getMaxResults` por defecto de Stalwart. */
const TAM_PAGINA = 500;
/** Mensajes de la cola cuya fecha de alta se mira para la antigüedad. */
const MUESTRA_COLA = 500;
/**
 * Esperas del driver (milisegundos). Las pruebas las acortan; el panel usa
 * siempre estas.
 */
export interface TiemposDriver {
  /** Espera máxima a que la tarea DKIM del motor cree las claves. */
  esperaDkim: number;
  /** Margen para la tarea DKIM que programó el alta del dominio antes de pedir otra. */
  esperaTareaEnCurso: number;
  intervaloDkim: number;
  /** Límite de la recarga de la configuración (ver recargar()). */
  esperaRecarga: number;
  /** Límite de cada petición al motor. */
  limitePeticion: number;
  /** Espera antes de repetir tras un 429 sin Retry-After. */
  esperaTrasLimite: number;
}

const TIEMPOS: TiemposDriver = {
  esperaDkim: 6_000,
  esperaTareaEnCurso: 3_000,
  intervaloDkim: 300,
  esperaRecarga: 90_000,
  limitePeticion: 15_000,
  esperaTrasLimite: 1_000,
};

/** Límite de contraseñas de aplicación si el panel aún no ha pedido otro. */
const MAX_APP_PASSWORDS_POR_DEFECTO = 100;

const DESCRIPCION_DOMINIO = 'Dominio gestionado por Mailway';
const DESCRIPCION_RESERVADO = 'Dominio reservado del servidor de correo (Mailway)';
const DESCRIPCION_ALIAS = 'Alias gestionado por Mailway';
const MOTIVO_RED_DE_CONFIANZA = 'Red de confianza de Mailway (webmail): exenta del bloqueo automático';

/** Algoritmos DKIM que el motor genera por defecto (y que firmaba 0.15). */
const ALGORITMOS_DKIM = ['Dkim1Ed25519Sha256', 'Dkim1RsaSha256'];

/**
 * Permisos de autoservicio que se quitan al rol de usuario por defecto. El
 * gestor de cuentas de Stalwart (`/account`) y su API dejarían a cada titular
 * cambiar su contraseña o crearse contraseñas de aplicación y claves de API
 * sin pasar por Mailway: el hash local dejaría de coincidir y las
 * contraseñas creadas fuera ocuparían el cupo del buzón. El administrador las
 * sigue creando en nombre del buzón: el permiso se mira en quien llama.
 */
const PERMISOS_AUTOSERVICIO = [
  'sysAccountPasswordUpdate',
  'sysAppPasswordCreate',
  'sysAppPasswordUpdate',
  'sysAppPasswordDestroy',
  'sysApiKeyCreate',
  'sysApiKeyUpdate',
  'sysApiKeyDestroy',
];

/** Escucha de envío en el 587 con STARTTLS (no TLS implícito), como en 0.15. */
const ESCUCHA_587 = {
  name: 'submission',
  protocol: 'smtp',
  bind: { '[::]:587': true },
  useTls: true,
  tlsImplicit: false,
};
const AVISO_REINICIO_587 = 'Puerto 587 (envío con STARTTLS): se abre al reiniciar el contenedor del motor.';

/* ------------------------------ Tipos de JMAP ------------------------------ */

interface ConIds {
  ids?: string[];
}
interface ConLista<T> {
  list?: T[];
  notFound?: string[];
}
interface ResultadoSet {
  created?: Record<string, { id?: string; [clave: string]: unknown } | null>;
  notCreated?: Record<string, ErrorDeConjunto>;
  updated?: Record<string, unknown>;
  notUpdated?: Record<string, ErrorDeConjunto>;
  destroyed?: string[];
  notDestroyed?: Record<string, ErrorDeConjunto>;
}
interface Credencial {
  '@type'?: string;
  credentialId?: string;
}
interface CuentaJmap {
  id: string;
  '@type'?: string;
  emailAddress?: string;
  usedDiskQuota?: number;
  credentials?: Record<string, Credencial>;
}
interface DominioJmap {
  id: string;
  name?: string;
  dnsZoneFile?: string;
  dkimManagement?: { '@type'?: string; algorithms?: Record<string, boolean> };
  certificateManagement?: { '@type'?: string; acmeProviderId?: string };
  dnsManagement?: { '@type'?: string; dnsServerId?: string; origin?: string | null };
}
interface ListaJmap {
  id: string;
  name?: string;
  domainId?: string;
  emailAddress?: string;
}
interface FirmaDkim {
  id: string;
  '@type'?: string;
  stage?: string;
}
interface AjustesSistema {
  defaultHostname?: string | null;
  defaultDomainId?: string | null;
  defaultCertificateId?: string | null;
  services?: Record<string, { hostname?: string | null; cleartext?: boolean }>;
}
interface AjustesHttp {
  useXForwarded?: boolean;
  redirectRoot?: string | null;
}
interface AjustesAutenticacion {
  defaultUserRoleIds?: Record<string, boolean>;
  maxAppPasswords?: number;
}
interface Escucha {
  id: string;
  name?: string;
  protocol?: string;
  bind?: Record<string, boolean>;
  useTls?: boolean;
  tlsImplicit?: boolean;
}
interface Trazador {
  id: string;
  '@type'?: string;
  enable?: boolean;
}
interface Rol {
  id: string;
  disabledPermissions?: Record<string, boolean>;
}
interface ProveedorAcme {
  id: string;
  directory?: string;
  challengeType?: string;
  contact?: Record<string, boolean>;
}

/* ------------------------------- Utilidades -------------------------------- */

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizarDominio(dominio: string): string {
  return dominio.trim().toLowerCase().replace(/\.$/, '');
}

function partirDireccion(email: string): { email: string; local: string; dominio: string } {
  const limpio = email.trim().toLowerCase();
  const arroba = limpio.lastIndexOf('@');
  if (arroba <= 0 || arroba === limpio.length - 1) {
    throw new HttpError(400, `La dirección «${email}» no es válida.`, 'invalid_email');
  }
  return { email: limpio, local: limpio.slice(0, arroba), dominio: normalizarDominio(limpio.slice(arroba + 1)) };
}

function esNoEncontrado(err: unknown): boolean {
  return err instanceof HttpError && err.code === 'engine_not_found';
}

function esDuplicado(err: unknown): err is ErrorDeObjetoJmap {
  return err instanceof ErrorDeObjetoJmap && err.tipo === 'primaryKeyViolation';
}

/** Id del objeto creado con la clave `clave`, o el error traducido. */
function idCreado(res: ResultadoSet, clave: string, que: string): string {
  const creado = res.created?.[clave];
  if (creado && typeof creado.id === 'string') return creado.id;
  throw errorDeObjeto(res.notCreated?.[clave] ?? { type: 'desconocido' }, que);
}

function comprobarActualizado(res: ResultadoSet, id: string, que: string): void {
  const error = res.notUpdated?.[id];
  if (error) throw errorDeObjeto(error, que);
}

/** Borrado idempotente: «no existe» es éxito; cualquier otro error, no. */
function comprobarBorrado(res: ResultadoSet, id: string, que: string): void {
  const error = res.notDestroyed?.[id];
  if (!error || error.type === 'notFound') return;
  throw errorDeObjeto(error, que);
}

/* ------------------------------ Redes (CIDR) ------------------------------- */

interface Red {
  familia: 4 | 6;
  base: bigint;
  prefijo: number;
}

function ipv4ABig(ip: string): bigint {
  return ip.split('.').reduce((acc, octeto) => (acc << 8n) | BigInt(Number(octeto) & 0xff), 0n);
}

function ipv6ABig(ip: string): bigint {
  let texto = ip;
  const cuadrupla = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(texto);
  if (cuadrupla) {
    const v4 = ipv4ABig(cuadrupla[2]!);
    texto = `${cuadrupla[1]}${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [cabeza = '', cola] = texto.split('::');
  const delante = cabeza ? cabeza.split(':') : [];
  const detras = cola !== undefined ? (cola ? cola.split(':') : []) : null;
  const grupos =
    detras === null
      ? delante
      : [...delante, ...Array<string>(Math.max(0, 8 - delante.length - detras.length)).fill('0'), ...detras];
  return grupos.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || '0', 16)), 0n);
}

function mascara(bits: number, prefijo: number): bigint {
  const todo = (1n << BigInt(bits)) - 1n;
  return prefijo === 0 ? 0n : todo ^ ((1n << BigInt(bits - prefijo)) - 1n);
}

/** «10.203.53.0/24», «fd00::/64» o una IP suelta; null si no es una red. */
export function analizarRed(valor: string): Red | null {
  const [direccionCruda = '', prefijoTexto, sobra] = valor.trim().split('/');
  if (sobra !== undefined) return null;
  const direccion = direccionCruda.replace(/^\[(.*)\]$/, '$1');
  const familia = net.isIP(direccion);
  if (familia !== 4 && familia !== 6) return null;
  const bits = familia === 4 ? 32 : 128;
  if (prefijoTexto !== undefined && !/^\d{1,3}$/.test(prefijoTexto)) return null;
  const prefijo = prefijoTexto === undefined ? bits : Number(prefijoTexto);
  if (prefijo > bits) return null;
  const numero = familia === 4 ? ipv4ABig(direccion) : ipv6ABig(direccion);
  return { familia, base: numero & mascara(bits, prefijo), prefijo };
}

/** ¿La red `a` contiene entera a la red `b`? */
function cubre(a: Red, b: Red): boolean {
  if (a.familia !== b.familia || a.prefijo > b.prefijo) return false;
  return (b.base & mascara(a.familia === 4 ? 32 : 128, a.prefijo)) === a.base;
}

/* --------------------------------- Driver ---------------------------------- */

export class Stalwart016Engine implements MailEngine {
  readonly kind = 'stalwart' as const;

  private readonly jmap: ClienteJmap;
  /** Nombre del dominio → id en el motor. */
  private readonly dominios = new Map<string, string>();
  /** Dirección del buzón → id de su cuenta. */
  private readonly cuentas = new Map<string, string>();
  /** Dirección del alias → id de su lista. */
  private readonly listas = new Map<string, string>();
  /**
   * Cambios guardados que esperan a un reinicio del contenedor, con la marca
   * de arranque del motor cuando se guardaron: cuando la marca cambia, el
   * motor ya ha arrancado de nuevo y el aviso sobra.
   */
  private readonly pendientesDeReinicio = new Map<string, string | null>();
  /** Lo último que pidió el panel para el límite de contraseñas de aplicación. */
  private maxAppPasswordsPedido: number | null = null;

  private readonly tiempos: TiemposDriver;

  constructor(
    private settings: EngineSettings,
    opciones: { tiempos?: Partial<TiemposDriver> } = {},
  ) {
    this.tiempos = { ...TIEMPOS, ...opciones.tiempos };
    this.jmap = new ClienteJmap({
      url: settings.url,
      usuario: settings.adminUser,
      clave: settings.adminPassword,
      timeoutMs: this.tiempos.limitePeticion,
      esperaTrasLimiteMs: this.tiempos.esperaTrasLimite,
    });
  }

  /* ------------------------------ Transporte ------------------------------- */

  private peticion(llamadas: LlamadaJmap[]): Promise<RespuestasJmap> {
    return this.jmap.peticion(llamadas);
  }

  /** Una sola llamada; devuelve sus argumentos de respuesta. */
  private async uno<T = Argumentos>(metodo: string, argumentos: Argumentos): Promise<T> {
    const respuestas = await this.peticion([[metodo, argumentos, 'c']]);
    return respuestas.de<T>('c');
  }

  private async lista<T>(objeto: string, argumentos: Argumentos): Promise<T[]> {
    const res = await this.uno<ConLista<T>>(`x:${objeto}/get`, argumentos);
    return res.list ?? [];
  }

  /**
   * Todos los objetos de un tipo (con un filtro opcional), por páginas de
   * 500 ordenadas por id ascendente: el único orden en que las páginas de
   * Stalwart 0.16 no se solapan.
   */
  private async listarTodos<T>(objeto: string, propiedades: string[], filtro?: Argumentos): Promise<T[]> {
    const todos: T[] = [];
    for (let posicion = 0; ; posicion += TAM_PAGINA) {
      const res = await this.peticion([
        [
          `x:${objeto}/query`,
          {
            ...(filtro ? { filter: filtro } : {}),
            sort: [{ property: 'id', isAscending: true }],
            position: posicion,
            limit: TAM_PAGINA,
          },
          'q',
        ],
        [
          `x:${objeto}/get`,
          { '#ids': { resultOf: 'q', name: `x:${objeto}/query`, path: '/ids' }, properties: propiedades },
          'g',
        ],
      ]);
      const ids = res.de<ConIds>('q').ids ?? [];
      todos.push(...(res.de<ConLista<T>>('g').list ?? []));
      if (ids.length < TAM_PAGINA) return todos;
    }
  }

  /* ------------------------------ Búsquedas -------------------------------- */

  private async buscarDominio(nombre: string, usarCache = true): Promise<string | null> {
    if (usarCache) {
      const enCache = this.dominios.get(nombre);
      if (enCache) return enCache;
    }
    const res = await this.uno<ConIds>('x:Domain/query', { filter: { name: nombre } });
    const id = res.ids?.[0] ?? null;
    if (id) this.dominios.set(nombre, id);
    else this.dominios.delete(nombre);
    return id;
  }

  private olvidarDominio(nombre: string): void {
    this.dominios.delete(nombre);
    for (const cache of [this.cuentas, this.listas]) {
      for (const email of cache.keys()) if (email.endsWith(`@${nombre}`)) cache.delete(email);
    }
  }

  private async dominioObligatorio(nombre: string): Promise<string> {
    const id = await this.buscarDominio(nombre);
    if (!id) {
      throw new ErrorDeObjetoJmap(
        502,
        `El dominio ${nombre} no existe en el motor de correo.`,
        'engine_not_found',
        'notFound',
        { type: 'notFound' },
      );
    }
    return id;
  }

  /**
   * Id de la cuenta de un buzón. El nombre de la cuenta es la parte local y
   * se busca junto con el dominio (los dos campos están indexados y la
   * comparación es exacta). Si el id del dominio venía de la caché y no
   * aparece nada, se vuelve a preguntar por el dominio: puede haberse borrado
   * y creado de nuevo con otro id.
   */
  private async buscarCuenta(email: string, usarCache = true): Promise<string | null> {
    const { email: direccion, local, dominio } = partirDireccion(email);
    if (usarCache) {
      const enCache = this.cuentas.get(direccion);
      if (enCache) return enCache;
    }
    const dominioEnCache = this.dominios.has(dominio);
    let dominioId = await this.buscarDominio(dominio);
    for (let intento = 0; intento < 2 && dominioId; intento++) {
      const res = await this.uno<ConIds>('x:Account/query', { filter: { name: local, domainId: dominioId } });
      const id = res.ids?.[0];
      if (id) {
        this.cuentas.set(direccion, id);
        return id;
      }
      if (!dominioEnCache || intento > 0) break;
      const antes: string = dominioId;
      dominioId = await this.buscarDominio(dominio, false);
      if (dominioId === antes) break;
    }
    this.cuentas.delete(direccion);
    return null;
  }

  private async cuentaObligatoria(email: string): Promise<string> {
    const id = await this.buscarCuenta(email);
    if (!id) {
      throw new ErrorDeObjetoJmap(
        502,
        `El buzón ${email.trim().toLowerCase()} no existe en el motor de correo.`,
        'engine_not_found',
        'notFound',
        { type: 'notFound' },
      );
    }
    return id;
  }

  /**
   * Ejecuta una operación sobre la cuenta de un buzón. Si el id venía de la
   * caché y el motor ya no lo conoce, se busca de nuevo y se repite una vez.
   */
  private async sobreCuenta<T>(email: string, operacion: (id: string) => Promise<T>): Promise<T> {
    const direccion = email.trim().toLowerCase();
    const enCache = this.cuentas.has(direccion);
    const id = await this.cuentaObligatoria(direccion);
    try {
      return await operacion(id);
    } catch (err) {
      if (!enCache || !esNoEncontrado(err)) throw err;
      this.cuentas.delete(direccion);
      const nuevo = await this.cuentaObligatoria(direccion);
      if (nuevo === id) throw err;
      return operacion(nuevo);
    }
  }

  /**
   * Id de la lista de un alias. `MailingList/query` solo filtra por texto: se
   * busca por la parte local y se confirma la dirección completa. Con
   * `exhaustiva`, si el texto no la encuentra se repasan todas las listas: un
   * borrado no puede dar por desaparecido un alias que sigue recibiendo correo.
   */
  private async buscarLista(email: string, exhaustiva: boolean): Promise<string | null> {
    const { email: direccion, local } = partirDireccion(email);
    const enCache = this.listas.get(direccion);
    if (enCache) return enCache;
    const res = await this.peticion([
      ['x:MailingList/query', { filter: { text: local } }, 'q'],
      [
        'x:MailingList/get',
        { '#ids': { resultOf: 'q', name: 'x:MailingList/query', path: '/ids' }, properties: ['emailAddress'] },
        'g',
      ],
    ]);
    let encontrada = (res.de<ConLista<ListaJmap>>('g').list ?? []).find(
      (l) => l.emailAddress?.toLowerCase() === direccion,
    );
    if (!encontrada && exhaustiva) {
      encontrada = (await this.listarTodos<ListaJmap>('MailingList', ['emailAddress'])).find(
        (l) => l.emailAddress?.toLowerCase() === direccion,
      );
    }
    if (!encontrada) return null;
    this.listas.set(direccion, encontrada.id);
    return encontrada.id;
  }

  /* ------------------------------- Contrato -------------------------------- */

  async detectApi(): Promise<EngineApi> {
    return 'jmap016';
  }

  async ping(): Promise<EngineHealth> {
    try {
      const sesion = await this.jmap.sesion();
      if (!ofreceGestion(sesion)) {
        // Stalwart 0.15 también sirve /jmap/session, pero sin la gestión.
        throw new RutaDeGestionAusente(
          `El motor de correo responde en ${this.jmap.base}, pero sin la API de gestión de Stalwart 0.16 (${CAPACIDAD_STALWART}).`,
        );
      }
      // La sesión la da cualquier cuenta; los ajustes, solo la administración.
      await this.uno('x:SystemSettings/get', { ids: ['singleton'], properties: ['defaultHostname'] });
      return { ok: true, api: 'jmap016' };
    } catch (err) {
      // Otra versión del motor no es «caído»: el detector debe enterarse.
      if (err instanceof RutaDeGestionAusente) throw err;
      return { ok: false, api: 'jmap016', detail: (err as Error).message };
    }
  }

  async createDomain(domain: string): Promise<void> {
    const nombre = normalizarDominio(domain);
    const res = await this.uno<ResultadoSet>('x:Domain/set', {
      create: {
        d: {
          name: nombre,
          description: DESCRIPCION_DOMINIO,
          // DKIM automático: el motor crea las claves (Ed25519 y RSA) en una
          // tarea, sin rotación mientras el DNS sea manual.
          dkimManagement: { '@type': 'Automatic' },
          dnsManagement: { '@type': 'Manual' },
          certificateManagement: { '@type': 'Manual' },
          subAddressing: { '@type': 'Enabled' },
        },
      },
    });
    try {
      this.dominios.set(nombre, idCreado(res, 'd', `el dominio ${nombre}`));
    } catch (err) {
      if (!esDuplicado(err)) throw err;
      // Un dominio que ya existe en el motor (huérfano de un borrado
      // interrumpido, o migrado desde 0.15) se adopta: el panel es la fuente
      // de verdad. Solo si existe CON ESE NOMBRE: un alias de otro dominio
      // también choca y ese no es suyo.
      if (!(await this.buscarDominio(nombre, false))) {
        throw upstream(
          `El motor de correo no puede dar de alta ${nombre}: ese nombre ya lo usa otro dominio del motor como alias.`,
          'engine_exists',
        );
      }
    }
  }

  async deleteDomain(domain: string): Promise<void> {
    const nombre = normalizarDominio(domain);
    const que = `el dominio ${nombre}`;
    for (let intento = 0; intento < 3; intento++) {
      const id = await this.buscarDominio(nombre, intento === 0);
      if (!id) {
        this.olvidarDominio(nombre);
        return;
      }
      const res = await this.uno<ResultadoSet>('x:Domain/set', { destroy: [id] });
      const error = res.notDestroyed?.[id];
      if (!error) {
        this.olvidarDominio(nombre);
        return;
      }
      if (error.type === 'notFound') {
        // Id de la caché ya obsoleto: se vuelve a buscar por el nombre.
        this.olvidarDominio(nombre);
        continue;
      }
      const enlazados = error.linkedObjects ?? [];
      if (
        error.type === 'objectIsLinked' &&
        enlazados.length > 0 &&
        enlazados.every((e) => e.object === 'DkimSignature')
      ) {
        // Las firmas DKIM son del dominio y se van con él. Solo se borran
        // cuando son lo ÚNICO que lo retiene: si quedan buzones o alias, el
        // dominio sigue en uso y conserva sus claves (y su DNS sigue valiendo).
        const borrado = await this.uno<ResultadoSet>('x:DkimSignature/set', {
          destroy: enlazados.map((e) => e.id),
        });
        for (const e of enlazados) comprobarBorrado(borrado, e.id, `la firma DKIM ${e.id} de ${nombre}`);
        continue;
      }
      throw errorDeObjeto(error, que);
    }
    throw upstream(`El motor de correo no ha terminado de borrar ${que}. Vuelve a intentarlo.`, 'engine_error');
  }

  async ensureDkim(domain: string, _selector: string): Promise<void> {
    // El selector lo pone el motor (`v1-rsa-AAAAMMDD`…), como en 0.15: los
    // registros salen de getDnsRecords, que ya lleva el que usa de verdad.
    const nombre = normalizarDominio(domain);
    const id = await this.dominioObligatorio(nombre);
    const estado = await this.estadoDkim(id, nombre);
    if (estado.faltan.length === 0) return;

    if (estado.manual) {
      // Pasar a automático programa la tarea DKIM, que crea solo los
      // algoritmos que faltan (las claves que ya hay se conservan).
      const res = await this.uno<ResultadoSet>('x:Domain/set', {
        update: { [id]: { dkimManagement: { '@type': 'Automatic' } } },
      });
      comprobarActualizado(res, id, `el dominio ${nombre}`);
      await this.esperarDkim(id, nombre, this.tiempos.esperaDkim);
      return;
    }

    // En automático, el alta del dominio ya programó la tarea: justo después
    // de createDomain las claves aún no están. Se le da un margen antes de
    // programar otra, para no tener dos tareas creando las mismas claves.
    if (await this.esperarDkim(id, nombre, this.tiempos.esperaTareaEnCurso)) return;
    const res = await this.uno<ResultadoSet>('x:Task/set', {
      create: {
        t: {
          '@type': 'DkimManagement',
          domainId: id,
          status: { '@type': 'Pending', due: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') },
        },
      },
    });
    idCreado(res, 't', `la tarea DKIM de ${nombre}`);
    await this.esperarDkim(id, nombre, this.tiempos.esperaDkim);
  }

  /**
   * La generación es asíncrona (una tarea del motor). Se espera un poco para
   * que la ficha del dominio ya muestre los registros DKIM, pero sin fallar si
   * tarda más: la tarea sigue y los registros aparecerán al volver a mirar.
   * true si ya están todas las claves.
   */
  private async esperarDkim(id: string, nombre: string, ms: number): Promise<boolean> {
    const limite = Date.now() + ms;
    while (Date.now() < limite) {
      await esperar(this.tiempos.intervaloDkim);
      if ((await this.estadoDkim(id, nombre)).faltan.length === 0) return true;
    }
    return false;
  }

  private async estadoDkim(dominioId: string, nombre: string): Promise<{ manual: boolean; faltan: string[] }> {
    const res = await this.peticion([
      ['x:Domain/get', { ids: [dominioId], properties: ['dkimManagement'] }, 'd'],
      ['x:DkimSignature/query', { filter: { domainId: dominioId } }, 'q'],
      [
        'x:DkimSignature/get',
        { '#ids': { resultOf: 'q', name: 'x:DkimSignature/query', path: '/ids' }, properties: ['@type', 'stage'] },
        'g',
      ],
    ]);
    const dominio = res.de<ConLista<DominioJmap>>('d').list?.[0];
    if (!dominio) {
      this.olvidarDominio(nombre);
      throw errorDeObjeto({ type: 'notFound' }, `el dominio ${nombre}`);
    }
    const gestion = dominio.dkimManagement;
    const manual = gestion?.['@type'] !== 'Automatic';
    const esperados =
      !manual && gestion?.algorithms
        ? Object.entries(gestion.algorithms)
            .filter(([, si]) => si)
            .map(([algoritmo]) => algoritmo)
        : ALGORITMOS_DKIM;
    const presentes = new Set(
      (res.de<ConLista<FirmaDkim>>('g').list ?? []).filter((f) => f.stage !== 'retired').map((f) => f['@type']),
    );
    return { manual, faltan: esperados.filter((a) => !presentes.has(a)) };
  }

  async getDnsRecords(domain: string): Promise<EngineDnsRecord[]> {
    const nombre = normalizarDominio(domain);
    return analizarZonaBind(await this.zonaDeDominio(nombre));
  }

  private async zonaDeDominio(nombre: string): Promise<string> {
    for (let intento = 0; intento < 2; intento++) {
      const id = await this.dominioObligatorio(nombre);
      const res = await this.uno<ConLista<DominioJmap>>('x:Domain/get', { ids: [id], properties: ['dnsZoneFile'] });
      const zona = res.list?.[0]?.dnsZoneFile;
      if (typeof zona === 'string') return zona;
      // Id obsoleto en la caché: el dominio se ha vuelto a crear.
      this.olvidarDominio(nombre);
    }
    throw errorDeObjeto({ type: 'notFound' }, `el dominio ${nombre}`);
  }

  /**
   * El fichero de zona se calcula con la configuración CARGADA del motor
   * (`core.network.server_name`), no con la guardada: el destino de su MX es
   * el nombre que usa de verdad. Se mira en el dominio por defecto, que con
   * los ajustes recomendados es el reservado del servidor.
   */
  async getRunningHostname(): Promise<string | null> {
    const [ajustes] = await this.lista<AjustesSistema>('SystemSettings', {
      ids: ['singleton'],
      properties: ['defaultDomainId'],
    });
    let id = ajustes?.defaultDomainId ?? null;
    if (!id) {
      const res = await this.uno<ConIds>('x:Domain/query', {
        sort: [{ property: 'id', isAscending: true }],
        limit: 1,
      });
      id = res.ids?.[0] ?? null;
    }
    if (!id) return null;
    const [dominio] = await this.lista<DominioJmap>('Domain', { ids: [id], properties: ['dnsZoneFile'] });
    if (typeof dominio?.dnsZoneFile !== 'string') return null;
    const mx = analizarZonaBind(dominio.dnsZoneFile)
      .filter((r) => r.type === 'MX')
      .map((r) => {
        const partes = r.content.trim().split(/\s+/);
        return { prioridad: Number(partes[0]), destino: partes[partes.length - 1] ?? '' };
      })
      .sort((a, b) => a.prioridad - b.prioridad)[0];
    return normalizeHostname(mx?.destino ?? '') || null;
  }

  async createMailbox(input: CreateMailboxInput): Promise<void> {
    const { email, local, dominio } = partirDireccion(input.email);
    const dominioId = await this.dominioObligatorio(dominio);
    const estado = {
      description: input.displayName?.trim() || null,
      credentials: { '0': { '@type': 'Password', secret: input.passwordHash } },
      // Sin cuota = sin límite (el motor trata la ausencia como 0, ilimitado).
      quotas: input.quotaBytes && input.quotaBytes > 0 ? { maxDiskQuota: input.quotaBytes } : {},
      roles: { '@type': 'User' },
      permissions: { '@type': 'Inherit' },
      aliases: {},
    };
    const res = await this.uno<ResultadoSet>('x:Account/set', {
      create: {
        a: {
          '@type': 'User',
          name: local,
          domainId: dominioId,
          ...estado,
          encryptionAtRest: { '@type': 'Disabled' },
          memberGroupIds: {},
        },
      },
    });
    try {
      this.cuentas.set(email, idCreado(res, 'a', `el buzón ${email}`));
      return;
    } catch (err) {
      if (!esDuplicado(err)) throw err;
      const existente = err.objeto;
      if (existente?.object !== 'Account') {
        // La dirección es de un alias (o de otra cosa): no es un buzón huérfano.
        throw upstream(
          `El motor de correo no puede crear el buzón ${email}: la dirección ya la usa un alias del motor.`,
          'engine_exists',
        );
      }
      // Buzón huérfano en el motor (existía allí pero no en el panel): se
      // adopta y se deja exactamente como lo pide el panel. Sustituir la lista
      // de credenciales entera deja solo la contraseña nueva: las contraseñas
      // de aplicación antiguas desaparecen. También se reactiva.
      const actualizado = await this.uno<ResultadoSet>('x:Account/set', { update: { [existente.id]: estado } });
      comprobarActualizado(actualizado, existente.id, `el buzón ${email}`);
      this.cuentas.set(email, existente.id);
    }
  }

  async setMailboxPassword(email: string, passwordHash: string): Promise<void> {
    await this.sobreCuenta(email, async (id) => {
      const [cuenta] = await this.lista<CuentaJmap>('Account', { ids: [id], properties: ['credentials'] });
      if (!cuenta) throw errorDeObjeto({ type: 'notFound' }, `el buzón ${email}`);
      const credenciales = Object.entries(cuenta.credentials ?? {});
      const principal = credenciales.find(([, c]) => c['@type'] === 'Password');
      // Solo se toca el secreto de la credencial principal: conserva su id y
      // las contraseñas de aplicación siguen valiendo. Si no tuviera (cuenta
      // creada fuera del panel), se añade al final de la lista.
      const cambio = principal
        ? { [`credentials/${principal[0]}/secret`]: passwordHash }
        : { [`credentials/${credenciales.length}`]: { '@type': 'Password', secret: passwordHash } };
      const res = await this.uno<ResultadoSet>('x:Account/set', { update: { [id]: cambio } });
      comprobarActualizado(res, id, `el buzón ${email}`);
    });
  }

  async updateMailbox(email: string, patch: UpdateMailboxPatch): Promise<void> {
    const cambio: Argumentos = {};
    if (patch.displayName !== undefined) cambio.description = patch.displayName.trim() || null;
    if (patch.quotaBytes !== undefined) {
      cambio['quotas/maxDiskQuota'] = patch.quotaBytes > 0 ? patch.quotaBytes : null;
    }
    if (patch.suspended !== undefined) {
      // Suspender = quitar el permiso de autenticarse, como hace el SCIM del
      // propio Stalwart con active=false: no entra por IMAP, SMTP ni webmail
      // y el correo le sigue llegando.
      cambio.permissions = patch.suspended
        ? { '@type': 'Merge', enabledPermissions: {}, disabledPermissions: { authenticate: true } }
        : { '@type': 'Inherit' };
    }
    if (Object.keys(cambio).length === 0) return;
    await this.sobreCuenta(email, async (id) => {
      const res = await this.uno<ResultadoSet>('x:Account/set', { update: { [id]: cambio } });
      comprobarActualizado(res, id, `el buzón ${email}`);
    });
  }

  async deleteMailbox(email: string): Promise<void> {
    const direccion = email.trim().toLowerCase();
    for (let intento = 0; intento < 2; intento++) {
      const id = await this.buscarCuenta(direccion, intento === 0);
      if (!id) return;
      const res = await this.uno<ResultadoSet>('x:Account/set', { destroy: [id] });
      this.cuentas.delete(direccion);
      if (res.notDestroyed?.[id]?.type === 'notFound') continue;
      comprobarBorrado(res, id, `el buzón ${direccion}`);
      return;
    }
  }

  async upsertAlias(alias: string, destinations: string[], externalDestinations: string[] = []): Promise<void> {
    const { email, local, dominio } = partirDireccion(alias);
    // En 0.16 una lista no distingue destinos internos y externos (ni comprueba
    // que existan): el panel ya valida los internos antes de llegar aquí.
    const recipients: Record<string, boolean> = {};
    for (const destino of [...destinations, ...externalDestinations]) {
      const limpio = destino.trim().toLowerCase();
      if (limpio) recipients[limpio] = true;
    }
    const que = `el alias ${email}`;

    // Si ya existe, se sustituyen los destinos con UNA sola actualización: el
    // alias nunca desaparece del motor (borrar y recrear lo dejaba fuera si el
    // alta fallaba, y el correo rebotaba).
    for (let intento = 0; intento < 2; intento++) {
      const id = await this.buscarLista(email, false);
      if (!id) break;
      const res = await this.uno<ResultadoSet>('x:MailingList/set', { update: { [id]: { recipients } } });
      if (res.notUpdated?.[id]?.type === 'notFound') {
        this.listas.delete(email);
        continue;
      }
      comprobarActualizado(res, id, que);
      return;
    }

    const dominioId = await this.dominioObligatorio(dominio);
    const res = await this.uno<ResultadoSet>('x:MailingList/set', {
      create: { l: { name: local, domainId: dominioId, description: DESCRIPCION_ALIAS, recipients } },
    });
    try {
      this.listas.set(email, idCreado(res, 'l', que));
    } catch (err) {
      if (!esDuplicado(err)) throw err;
      const existente = err.objeto;
      if (existente?.object !== 'MailingList') {
        throw upstream(`El motor de correo no puede crear ${que}: la dirección ya es un buzón del motor.`, 'engine_exists');
      }
      // La búsqueda por texto no la encontró (u otra petición la creó a la
      // vez): el propio duplicado dice cuál es, y se actualiza esa.
      const actualizado = await this.uno<ResultadoSet>('x:MailingList/set', {
        update: { [existente.id]: { recipients } },
      });
      comprobarActualizado(actualizado, existente.id, que);
      this.listas.set(email, existente.id);
    }
  }

  async deleteAlias(alias: string): Promise<void> {
    const { email } = partirDireccion(alias);
    for (let intento = 0; intento < 2; intento++) {
      const id = await this.buscarLista(email, true);
      if (!id) return;
      const res = await this.uno<ResultadoSet>('x:MailingList/set', { destroy: [id] });
      this.listas.delete(email);
      if (res.notDestroyed?.[id]?.type === 'notFound') continue;
      comprobarBorrado(res, id, `el alias ${email}`);
      return;
    }
  }

  /** 0.16 devuelve los secretos enmascarados («****»): no hay nada que capturar. */
  async readMailboxCredentials(_email: string): Promise<MailboxCredentials | null> {
    return null;
  }

  async listDirectory(): Promise<EngineDirectory> {
    const dominios = await this.listarTodos<DominioJmap>('Domain', ['name']);
    const cuentas = await this.listarTodos<CuentaJmap>('Account', ['@type', 'emailAddress']);
    const listas = await this.listarTodos<ListaJmap>('MailingList', ['emailAddress']);
    const unicos = (valores: (string | undefined)[]) =>
      [...new Set(valores.filter((v): v is string => !!v).map((v) => v.toLowerCase()))].sort();
    return {
      domains: unicos(dominios.map((d) => d.name)),
      // Los grupos también son cuentas, pero no son buzones.
      accounts: unicos(cuentas.filter((c) => c['@type'] !== 'Group').map((c) => c.emailAddress)),
      lists: unicos(listas.map((l) => l.emailAddress)),
    };
  }

  async getMailboxUsage(): Promise<Map<string, number>> {
    const uso = new Map<string, number>();
    const cuentas = await this.listarTodos<CuentaJmap>('Account', ['@type', 'emailAddress', 'usedDiskQuota']);
    for (const cuenta of cuentas) {
      if (cuenta['@type'] === 'Group' || !cuenta.emailAddress) continue;
      uso.set(cuenta.emailAddress.toLowerCase(), typeof cuenta.usedDiskQuota === 'number' ? cuenta.usedDiskQuota : 0);
    }
    return uso;
  }

  /* ------------------------------- Ajustes --------------------------------- */

  /** Lo que mira Mailway del motor, en una sola petición (más las redes). */
  private async leerAjustes(): Promise<{
    sistema: AjustesSistema;
    http: AjustesHttp;
    autenticacion: AjustesAutenticacion;
    escuchas: Escucha[];
    trazadores: Trazador[];
    roles: Rol[];
    redes: string[];
  }> {
    const res = await this.peticion([
      ['x:SystemSettings/get', { ids: ['singleton'] }, 's'],
      ['x:Http/get', { ids: ['singleton'], properties: ['useXForwarded', 'redirectRoot'] }, 'h'],
      ['x:Authentication/get', { ids: ['singleton'], properties: ['defaultUserRoleIds', 'maxAppPasswords'] }, 'a'],
      ['x:NetworkListener/get', { ids: null, properties: ['name', 'protocol', 'bind', 'useTls', 'tlsImplicit'] }, 'l'],
      ['x:Tracer/get', { ids: null, properties: ['@type', 'enable'] }, 't'],
      ['x:Role/get', { ids: null, properties: ['disabledPermissions'] }, 'r'],
    ]);
    const redes = await this.listarTodos<{ address?: string }>('AllowedIp', ['address']);
    return {
      sistema: res.de<ConLista<AjustesSistema>>('s').list?.[0] ?? {},
      http: res.de<ConLista<AjustesHttp>>('h').list?.[0] ?? {},
      autenticacion: res.de<ConLista<AjustesAutenticacion>>('a').list?.[0] ?? {},
      escuchas: res.de<ConLista<Escucha>>('l').list ?? [],
      trazadores: res.de<ConLista<Trazador>>('t').list ?? [],
      roles: res.de<ConLista<Rol>>('r').list ?? [],
      redes: redes.map((r) => r.address ?? '').filter(Boolean),
    };
  }

  /** ¿Hay una escucha SMTP en el 587 con STARTTLS? */
  private static tiene587(escuchas: Escucha[]): boolean {
    return escuchas.some(
      (e) =>
        e.protocol === 'smtp' &&
        e.tlsImplicit !== true &&
        Object.entries(e.bind ?? {}).some(([direccion, si]) => si && /:587$/.test(direccion)),
    );
  }

  /** Roles que reciben por defecto las cuentas de usuario. */
  private static rolesDeUsuario(autenticacion: AjustesAutenticacion, roles: Rol[]): Rol[] {
    const ids = Object.entries(autenticacion.defaultUserRoleIds ?? {})
      .filter(([, si]) => si)
      .map(([id]) => id);
    return roles.filter((r) => ids.includes(r.id));
  }

  private static autoservicioBloqueado(http: AjustesHttp, roles: Rol[]): boolean {
    return (
      http.redirectRoot === null &&
      roles.length > 0 &&
      roles.every((r) => PERMISOS_AUTOSERVICIO.every((p) => r.disabledPermissions?.[p] === true))
    );
  }

  /**
   * Marca del arranque en curso del motor. En un nodo único, `lastRenewal` del
   * nodo se fija al arrancar (comprobado: cambia con cada `docker restart` y no
   * se renueva después), así que sirve para saber si el motor ha reiniciado
   * desde que se guardó un cambio que lo exige. null si no se puede leer.
   */
  private async marcaDeArranque(): Promise<string | null> {
    try {
      const nodos = await this.lista<{ nodeId?: number; lastRenewal?: string }>('ClusterNode', { ids: null });
      if (nodos.length === 0) return null;
      return nodos
        .map((n) => `${n.nodeId ?? '?'}@${n.lastRenewal ?? '?'}`)
        .sort()
        .join(',');
    } catch {
      return null;
    }
  }

  private async pendientesActuales(): Promise<string[]> {
    if (this.pendientesDeReinicio.size === 0) return [];
    const marca = await this.marcaDeArranque();
    for (const [aviso, marcaAlGuardar] of this.pendientesDeReinicio) {
      if (marca !== null && marcaAlGuardar !== null && marca !== marcaAlGuardar) {
        this.pendientesDeReinicio.delete(aviso);
      }
    }
    return [...this.pendientesDeReinicio.keys()];
  }

  async applyRecommended(input: RecommendedInput): Promise<EngineReloadResult> {
    const hostname = normalizeHostname(input.hostname);
    if (!isValidHostname(hostname)) {
      // Sería el dominio por defecto del motor y el destino de todos los MX.
      throw new HttpError(400, `El nombre del servidor de correo «${input.hostname}» no es válido.`, 'invalid_hostname');
    }
    const errors: string[] = [];
    const warnings: string[] = [];
    this.maxAppPasswordsPedido = input.maxAppPasswords;

    // Cada ajuste por separado: si uno falla (una red mal escrita), el resto
    // se aplica igual y el fallo vuelve en `errors`. Un fallo de conexión o
    // de credenciales sí corta: no se puede aplicar nada.
    const intentar = async (tarea: () => Promise<void>): Promise<void> => {
      try {
        await tarea();
      } catch (err) {
        if (!(err instanceof ErrorDeObjetoJmap)) throw err;
        errors.push(err.message);
      }
    };

    const ajustes = await this.leerAjustes();

    // 1. Dominio reservado del servidor como dominio por defecto. El motor
    //    exige uno; si fuera el de un cliente, ese dominio ya no se podría
    //    borrar (los ajustes lo enlazan). Además da un fichero de zona estable
    //    del que leer el nombre en ejecución.
    let reservadoId = await this.buscarDominio(hostname, false);
    if (!reservadoId) {
      await intentar(async () => {
        const res = await this.uno<ResultadoSet>('x:Domain/set', {
          create: {
            r: {
              name: hostname,
              description: DESCRIPCION_RESERVADO,
              // Nadie envía correo con este dominio: sin claves DKIM que rotar.
              dkimManagement: { '@type': 'Manual' },
              dnsManagement: { '@type': 'Manual' },
              certificateManagement: { '@type': 'Manual' },
            },
          },
        });
        try {
          reservadoId = idCreado(res, 'r', `el dominio reservado ${hostname}`);
        } catch (err) {
          if (!esDuplicado(err)) throw err;
          reservadoId = await this.buscarDominio(hostname, false);
          if (!reservadoId) throw err;
        }
        this.dominios.set(hostname, reservadoId);
      });
    }

    // 2. Nombre del servidor, dominio por defecto y anuncio del 587 (los SRV
    //    `_submission._tcp` y la autoconfiguración del propio motor).
    const sistema: Argumentos = {};
    if (ajustes.sistema.defaultHostname !== hostname) sistema.defaultHostname = hostname;
    if (reservadoId && ajustes.sistema.defaultDomainId !== reservadoId) sistema.defaultDomainId = reservadoId;
    if (ajustes.sistema.services?.smtp?.cleartext !== true) sistema['services/smtp/cleartext'] = true;

    // 3. IP real detrás de Traefik y sin la redirección de la raíz al
    //    autoservicio del motor.
    const http: Argumentos = {};
    if (ajustes.http.useXForwarded !== true) http.useXForwarded = true;
    if (ajustes.http.redirectRoot !== null) http.redirectRoot = null;

    // 4. Contraseñas de aplicación: el motor admite 5 por buzón por defecto y
    //    Mailway usa una por dispositivo, por clave de API y por formulario.
    const autenticacion: Argumentos = {};
    if ((ajustes.autenticacion.maxAppPasswords ?? 0) < input.maxAppPasswords) {
      autenticacion.maxAppPasswords = input.maxAppPasswords;
    }

    const llamadas: [LlamadaJmap, string][] = [];
    if (Object.keys(sistema).length) {
      llamadas.push([['x:SystemSettings/set', { update: { singleton: sistema } }, 's'], 'los ajustes del sistema']);
    }
    if (Object.keys(http).length) {
      llamadas.push([['x:Http/set', { update: { singleton: http } }, 'h'], 'los ajustes HTTP']);
    }
    if (Object.keys(autenticacion).length) {
      llamadas.push([
        ['x:Authentication/set', { update: { singleton: autenticacion } }, 'a'],
        'los ajustes de autenticación',
      ]);
    }

    // 5. Redes exentas del bloqueo automático (solo las que falten: una red
    //    más amplia ya dada de alta también vale).
    const existentes = ajustes.redes.map(analizarRed).filter((r): r is Red => r !== null);
    const nuevas: Record<string, Argumentos> = {};
    for (const [i, red] of input.trustedNetworks.entries()) {
      const analizada = analizarRed(red);
      if (!analizada) {
        errors.push(`La red «${red}» no es válida: debe ser una IP o una red en notación CIDR.`);
        continue;
      }
      if (existentes.some((e) => cubre(e, analizada))) continue;
      existentes.push(analizada);
      nuevas[`ip${i}`] = { address: red.trim(), reason: MOTIVO_RED_DE_CONFIANZA };
    }
    if (Object.keys(nuevas).length) {
      llamadas.push([['x:AllowedIp/set', { create: nuevas }, 'i'], 'las redes de confianza']);
    }

    // 6. Envío por el 587 con STARTTLS: el motor 0.16 ya no lo crea por
    //    defecto y lo usan los programas de correo, Skyway y la API de envío.
    const crear587 = !Stalwart016Engine.tiene587(ajustes.escuchas);
    if (crear587) {
      const nombreLibre = ajustes.escuchas.some((e) => e.name === ESCUCHA_587.name)
        ? 'mailway-submission'
        : ESCUCHA_587.name;
      llamadas.push([
        ['x:NetworkListener/set', { create: { e: { ...ESCUCHA_587, name: nombreLibre } } }, 'e'],
        'la escucha del puerto 587',
      ]);
    }

    // 7. Registro de eventos por la salida estándar (`docker logs`). El de
    //    ficheros por defecto escribe en /var/log/stalwart, que la imagen no
    //    crea: sin esto el motor no deja rastro de nada. Sin búfer, para que
    //    cada evento salga en el momento y no se pierda si el motor se cae.
    if (!ajustes.trazadores.some((t) => t['@type'] === 'Stdout' && t.enable !== false)) {
      llamadas.push([
        [
          'x:Tracer/set',
          { create: { t: { '@type': 'Stdout', level: 'info', ansi: false, buffered: false, enable: true } } },
          't',
        ],
        'el registro de eventos',
      ]);
    }

    // 8. Autoservicio del motor bloqueado en los roles de usuario por defecto.
    for (const rol of Stalwart016Engine.rolesDeUsuario(ajustes.autenticacion, ajustes.roles)) {
      const cambio: Argumentos = {};
      for (const permiso of PERMISOS_AUTOSERVICIO) {
        if (rol.disabledPermissions?.[permiso] !== true) cambio[`disabledPermissions/${permiso}`] = true;
      }
      if (Object.keys(cambio).length) {
        llamadas.push([['x:Role/set', { update: { [rol.id]: cambio } }, `r${rol.id}`], 'el rol de usuario']);
      }
    }

    const marca = crear587 ? await this.marcaDeArranque() : null;
    let creado587 = false;
    if (llamadas.length > 0) {
      const res = await this.peticion(llamadas.map(([llamada]) => llamada));
      for (const [[, argumentos, id], que] of llamadas) {
        await intentar(async () => {
          const r = res.de<ResultadoSet>(id);
          for (const clave of Object.keys((argumentos.update as Argumentos | undefined) ?? {})) {
            comprobarActualizado(r, clave, que);
          }
          for (const clave of Object.keys((argumentos.create as Argumentos | undefined) ?? {})) {
            try {
              idCreado(r, clave, que);
            } catch (err) {
              // Ya existía (otra petición lo creó a la vez): es lo que se quería.
              if (!esDuplicado(err)) throw err;
            }
          }
          if (id === 'e') creado587 = true;
        });
      }
    }
    if (creado587) {
      // Los sockets solo se abren al arrancar: la recarga analiza la escucha
      // nueva pero no la pone a escuchar (comprobado en 0.16.25).
      this.pendientesDeReinicio.set(AVISO_REINICIO_587, marca);
    }

    errors.push(...(await this.recargar()));
    return { errors, warnings, restartRequired: await this.pendientesActuales() };
  }

  /**
   * `ReloadSettings`: aplica lo guardado. Devuelve los errores de la recarga.
   * Rehace toda la configuración, incluida la comprobación de DNSSEC del
   * resolutor (una consulta DNSKEY a la raíz por TCP): con un DNS lento o sin
   * salida a Internet tarda lo que tarde en agotarse esa consulta (unos 15 s
   * medidos), así que tiene un límite propio más largo.
   */
  private async recargar(): Promise<string[]> {
    const respuestas = await this.jmap.peticion(
      [['x:Action/set', { create: { r: { '@type': 'ReloadSettings' } } }, 'c']],
      { timeoutMs: this.tiempos.esperaRecarga },
    );
    const res = respuestas.de<ResultadoSet>('c');
    if (res.created?.r) return [];
    return [errorDeObjeto(res.notCreated?.r ?? { type: 'desconocido' }, 'la recarga de la configuración').message];
  }

  async getSettingsStatus(input: { trustedNetworks: string[] }): Promise<EngineSettingsStatus> {
    const ajustes = await this.leerAjustes();
    const sistema = ajustes.sistema;
    const hostname = sistema.defaultHostname ? normalizeHostname(sistema.defaultHostname) : null;
    const res = await this.peticion([
      ['x:Domain/get', { ids: sistema.defaultDomainId ? [sistema.defaultDomainId] : [], properties: ['name'] }, 'd'],
      [
        'x:Certificate/get',
        { ids: sistema.defaultCertificateId ? [sistema.defaultCertificateId] : [], properties: ['certificate'] },
        'c',
      ],
      ['x:AcmeProvider/get', { ids: null, properties: ['directory', 'challengeType', 'contact'] }, 'p'],
    ]);
    const dominioPorDefecto = res.de<ConLista<DominioJmap>>('d').list?.[0]?.name ?? null;
    const certificado = res.de<ConLista<{ certificate?: { '@type'?: string } }>>('c').list?.[0];
    const proveedores = res.de<ConLista<ProveedorAcme>>('p').list ?? [];

    const tiene587 = Stalwart016Engine.tiene587(ajustes.escuchas);
    const extra: Record<string, boolean> = {
      submission587: tiene587 && sistema.services?.smtp?.cleartext === true,
      maxAppPasswords:
        (ajustes.autenticacion.maxAppPasswords ?? 0) >= (this.maxAppPasswordsPedido ?? MAX_APP_PASSWORDS_POR_DEFECTO),
      selfServiceBlocked: Stalwart016Engine.autoservicioBloqueado(
        ajustes.http,
        Stalwart016Engine.rolesDeUsuario(ajustes.autenticacion, ajustes.roles),
      ),
      defaultDomain: !!hostname && !!dominioPorDefecto && normalizarDominio(dominioPorDefecto) === hostname,
      logToStdout: ajustes.trazadores.some((t) => t['@type'] === 'Stdout' && t.enable !== false),
    };

    const permitidas = ajustes.redes.map(analizarRed).filter((r): r is Red => r !== null);
    const trustedNetworks = input.trustedNetworks.filter((red) => {
      const analizada = analizarRed(red);
      return !!analizada && permitidas.some((p) => cubre(p, analizada));
    });

    // Si alguien ha quitado la escucha, ya no hay reinicio que esperar por ella.
    if (!tiene587) this.pendientesDeReinicio.delete(AVISO_REINICIO_587);

    return {
      api: 'jmap016',
      hostname,
      forwardedHeaders: ajustes.http.useXForwarded === true,
      trustedNetworks,
      acme: proveedores[0] ? await this.describirAcme(proveedores[0]) : null,
      certificateFiles: certificado?.certificate?.['@type'] === 'File',
      extra,
      restartRequired: await this.pendientesActuales(),
    };
  }

  /**
   * ACME del propio motor, si alguien lo ha configurado (Mailway no lo hace
   * en 0.16). Se describe para que Ajustes no lo oculte.
   */
  private async describirAcme(proveedor: ProveedorAcme): Promise<EngineAcmeStatus> {
    const retos: Record<string, string> = {
      Dns01: 'dns-01',
      DnsPersist01: 'dns-persist-01',
      Http01: 'http-01',
      TlsAlpn01: 'tls-alpn-01',
    };
    const dominios = await this.listarTodos<DominioJmap>('Domain', ['name', 'certificateManagement', 'dnsManagement']);
    const dominio = dominios.find((d) => d.certificateManagement?.acmeProviderId === proveedor.id);
    let dnsProveedor: string | null = null;
    const dnsServerId = dominio?.dnsManagement?.dnsServerId;
    if (dnsServerId) {
      const [servidor] = await this.lista<{ '@type'?: string }>('DnsServer', {
        ids: [dnsServerId],
        properties: ['@type'],
      });
      dnsProveedor = servidor?.['@type']?.toLowerCase() ?? null;
    }
    return {
      directory: proveedor.directory ?? null,
      challenge: proveedor.challengeType ? (retos[proveedor.challengeType] ?? proveedor.challengeType) : null,
      provider: dnsProveedor,
      contact: Object.keys(proveedor.contact ?? {})[0] ?? null,
      domain: dominio?.name ?? null,
      zone: dominio?.dnsManagement?.origin ?? dominio?.name ?? null,
    };
  }

  async configureAcme(_input: AcmeInput): Promise<EngineReloadResult> {
    throw motorNoAdmite(
      'Con Stalwart 0.16 el certificado del servidor de correo lo obtiene Traefik y lo entrega al motor el extractor de certificados: Mailway ya no configura el ACME propio del motor. Revisa que el nombre del servidor apunte a esta máquina y que Traefik tenga el certificado.',
    );
  }

  async reloadCertificates(): Promise<void> {
    const res = await this.uno<ResultadoSet>('x:Action/set', {
      create: { r: { '@type': 'ReloadTlsCertificates' } },
    });
    if (res.created?.r) return;
    throw errorDeObjeto(res.notCreated?.r ?? { type: 'desconocido' }, 'la recarga de los certificados');
  }

  async addAppPassword(email: string, label: string, _proposedSecret: string): Promise<CreatedAppPassword> {
    // En 0.16 el secreto lo genera el motor (app_…) y solo lo devuelve aquí.
    // La propuesta de Mailway no se puede imponer: se devuelve la del motor.
    return this.sobreCuenta(email, async (cuentaId) => {
      const res = await this.uno<ResultadoSet>('x:AppPassword/set', {
        accountId: cuentaId,
        create: {
          k: {
            description: label.trim() || 'Mailway',
            permissions: { '@type': 'Inherit' },
            allowedIps: {},
          },
        },
      });
      const creada = res.created?.k;
      if (creada && typeof creada.id === 'string' && typeof creada.secret === 'string') {
        return { secret: creada.secret, ref: `${cuentaId}:${creada.id}` };
      }
      const error = res.notCreated?.k ?? { type: 'desconocido' };
      if (error.type === 'overQuota') {
        throw upstream(
          `El motor de correo no admite más contraseñas de aplicación en el buzón ${email}${error.description ? ` (${error.description})` : ''}. Aplica los ajustes recomendados del motor para subir el límite o retira alguna que ya no se use.`,
          'engine_error',
        );
      }
      throw errorDeObjeto(error, `el buzón ${email}`);
    });
  }

  async removeAppPassword(email: string, ref: string): Promise<void> {
    // La referencia es «cuenta:credencial». Una que no tiene esa forma viene
    // de 0.15 (el secreto guardado): esas contraseñas no pasaron la migración
    // y no queda nada que retirar en el motor.
    const partes = /^([a-z0-9]+):([a-z0-9]+)$/i.exec(ref.trim());
    if (!partes) return;
    const cuentaRef = partes[1]!;
    const credencialId = partes[2]!;
    const cuentaId = await this.buscarCuenta(email);
    // Buzón borrado, o referencia de una cuenta anterior con la misma
    // dirección: nunca se retira una credencial de otra cuenta.
    if (!cuentaId || cuentaId !== cuentaRef) return;
    const res = await this.uno<ResultadoSet>('x:AppPassword/set', { accountId: cuentaId, destroy: [credencialId] });
    const error = res.notDestroyed?.[credencialId];
    if (!error || error.type === 'notFound') return;
    if (error.type === 'forbidden') {
      // El id ya no es de una contraseña de aplicación (el motor reutiliza
      // los ids libres: tras adoptar un buzón, puede ser la principal). Si no
      // hay ninguna con ese id, la que se quería retirar ya no existe.
      const comprobacion = await this.uno<ConLista<{ id: string }>>('x:AppPassword/get', {
        accountId: cuentaId,
        ids: [credencialId],
        properties: ['id'],
      });
      if ((comprobacion.list ?? []).length === 0) return;
    }
    throw errorDeObjeto(error, `la contraseña de aplicación del buzón ${email}`);
  }

  async getQueueSummary(): Promise<QueueSummary> {
    // La cola solo se puede ordenar por el próximo intento (`due`), no por la
    // fecha de alta. Se cuenta entera (calculateTotal) y se mira la fecha de
    // alta de los primeros 500 por próximo intento: con colas mayores la
    // antigüedad es aproximada, y el aviso de la cola ya salta por el número.
    const res = await this.peticion([
      [
        'x:QueuedMessage/query',
        { calculateTotal: true, sort: [{ property: 'due', isAscending: true }], limit: MUESTRA_COLA },
        'q',
      ],
      [
        'x:QueuedMessage/get',
        { '#ids': { resultOf: 'q', name: 'x:QueuedMessage/query', path: '/ids' }, properties: ['createdAt'] },
        'g',
      ],
    ]);
    const consulta = res.de<ConIds & { total?: number }>('q');
    const mensajes = res.de<ConLista<{ createdAt?: string }>>('g').list ?? [];
    const pending = typeof consulta.total === 'number' ? consulta.total : (consulta.ids ?? []).length;
    if (pending === 0) return { pending: 0, oldestSeconds: null };
    const altas = mensajes.map((m) => Date.parse(m.createdAt ?? '')).filter((t) => Number.isFinite(t));
    if (altas.length === 0) return { pending, oldestSeconds: null };
    return { pending, oldestSeconds: Math.max(0, Math.round((Date.now() - Math.min(...altas)) / 1000)) };
  }
}
