import { upstream } from '../core/errors';
import { RutaDeGestionAusente } from './errores';
import { credencialesRechazadas, Stalwart015Engine } from './stalwart';
import { Stalwart016Engine } from './stalwart016';
import type {
  AcmeInput,
  CreatedAppPassword,
  CreateMailboxInput,
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
 * Detección de la versión de Stalwart y fachada que elige el driver.
 *
 * La URL del motor es la misma antes y después de migrarlo de 0.15 a 0.16
 * (el contenedor conserva el nombre `mailway-mail`), así que el panel no
 * puede saber por la configuración qué API habla: se lo pregunta al motor la
 * primera vez que lo necesita y lo recuerda. Si después una ruta de gestión
 * desaparece (`RutaDeGestionAusente`: el motor se ha migrado, o ha vuelto
 * atrás, con el panel en marcha en Skyway), lo pregunta de nuevo y repite la
 * operación una vez con el driver que toque.
 */

/** Capacidad JMAP con la que Stalwart 0.16 anuncia su API de gestión (objetos `x:`). */
export const CAPACIDAD_GESTION_016 = 'urn:stalwart:jmap';

/** Espera máxima de cada petición de la detección. */
const ESPERA_DETECCION_MS = 10_000;

export type ApiStalwart = Exclude<EngineApi, 'demo'>;

export interface FabricaDrivers {
  rest015(settings: EngineSettings): MailEngine;
  jmap016(settings: EngineSettings): MailEngine;
}

const FABRICA_POR_DEFECTO: FabricaDrivers = {
  rest015: (settings) => new Stalwart015Engine(settings),
  jmap016: (settings) => new Stalwart016Engine(settings),
};

/**
 * ¿La sesión JMAP anuncia la API de gestión de 0.16? Stalwart 0.16.25 NO la
 * pone en las capacidades del servidor (`capabilities`): aparece en
 * `primaryAccounts` y en las `accountCapabilities` de la cuenta. Se acepta en
 * cualquiera de los tres sitios para no depender de en cuál la anuncie cada
 * versión; 0.15 no la anuncia en ninguno.
 */
export function anunciaGestion016(sesion: unknown): boolean {
  if (!sesion || typeof sesion !== 'object') return false;
  const { capabilities, primaryAccounts, accounts } = sesion as {
    capabilities?: unknown;
    primaryAccounts?: unknown;
    accounts?: unknown;
  };
  const tiene = (objeto: unknown): boolean =>
    Boolean(objeto) && typeof objeto === 'object' && CAPACIDAD_GESTION_016 in (objeto as object);
  if (tiene(capabilities) || tiene(primaryAccounts)) return true;
  if (!accounts || typeof accounts !== 'object') return false;
  return Object.values(accounts as Record<string, { accountCapabilities?: unknown } | null>).some((cuenta) =>
    tiene(cuenta?.accountCapabilities),
  );
}

/** ¿Es la respuesta de gestión de 0.15 ({ data } o el { error } de un fallo de gestión)? */
function pareceGestion015(cuerpo: unknown): boolean {
  return Boolean(cuerpo) && typeof cuerpo === 'object' && ('data' in (cuerpo as object) || 'error' in (cuerpo as object));
}

/**
 * Pregunta al motor qué API de gestión habla:
 * - `GET /jmap/session` con la capacidad `urn:stalwart:jmap` → 0.16;
 * - si no (un 404, o un 200 sin esa capacidad: Stalwart 0.15 también sirve
 *   la sesión JMAP del correo), se confirma 0.15 con una consulta barata de
 *   su API REST;
 * - un 401 es un error de credenciales (`engine_auth_failed`), y no se
 *   insiste: cada intento fallido cuenta para el bloqueo automático de IPs;
 * - sin conexión, `engine_unreachable`.
 */
export async function detectarApiStalwart(settings: EngineSettings): Promise<ApiStalwart> {
  const base = settings.url.replace(/\/+$/, '');
  const auth = `Basic ${Buffer.from(`${settings.adminUser}:${settings.adminPassword}`).toString('base64')}`;
  const pedir = async (ruta: string): Promise<Response> => {
    try {
      return await fetch(`${base}${ruta}`, {
        headers: { Authorization: auth, Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(ESPERA_DETECCION_MS),
      });
    } catch (err) {
      throw upstream(
        `No se pudo conectar con el motor de correo (${base}): ${(err as Error).message}`,
        'engine_unreachable',
      );
    }
  };
  const leerJson = async (res: Response): Promise<unknown> => {
    try {
      return JSON.parse(await res.text()) as unknown;
    } catch {
      return null;
    }
  };

  const sesion = await pedir('/jmap/session');
  if (sesion.status === 401) throw credencialesRechazadas();
  const cuerpoSesion = await leerJson(sesion);
  if (sesion.ok && anunciaGestion016(cuerpoSesion)) return 'jmap016';

  const rest = await pedir('/api/principal?types=domain&page=1&limit=1');
  if (rest.status === 401) throw credencialesRechazadas();
  const cuerpoRest = await leerJson(rest);
  if (rest.ok && pareceGestion015(cuerpoRest)) return 'rest015';

  throw upstream(
    `En ${base} no responde la API de gestión de Stalwart 0.15 ni la de 0.16 (HTTP ${sesion.status} en /jmap/session y ${rest.status} en /api/principal). Revisa la URL del motor en Ajustes: debe ser la de la API de gestión de Stalwart (p. ej. http://mailway-mail:8080).`,
    'engine_error',
  );
}

interface Activo {
  api: ApiStalwart;
  driver: MailEngine;
}

/**
 * Motor Stalwart de versión desconocida hasta la primera llamada. Implementa
 * el contrato completo delegando en el driver de la API detectada.
 */
export class MotorStalwart implements MailEngine {
  readonly kind = 'stalwart' as const;

  private activo: Activo | null = null;
  private enCurso: Promise<Activo> | null = null;

  constructor(
    private readonly settings: EngineSettings,
    private readonly fabrica: FabricaDrivers = FABRICA_POR_DEFECTO,
    private readonly detectar: (settings: EngineSettings) => Promise<ApiStalwart> = detectarApiStalwart,
  ) {}

  /** API detectada la última vez, sin preguntar al motor (null si aún no se sabe). */
  get apiConocida(): ApiStalwart | null {
    return this.activo?.api ?? null;
  }

  /**
   * El driver activo. `deNuevo` vuelve a preguntar aunque ya se sepa; las
   * llamadas simultáneas comparten una sola detección. Si la API no cambia se
   * conserva el driver; si la detección falla, se conserva lo que había.
   */
  private elegir(deNuevo = false): Promise<Activo> {
    if (this.activo && !deNuevo) return Promise.resolve(this.activo);
    if (!this.enCurso) {
      this.enCurso = (async () => {
        const api = await this.detectar(this.settings);
        if (this.activo?.api !== api) {
          this.activo = { api, driver: api === 'jmap016' ? this.fabrica.jmap016(this.settings) : this.fabrica.rest015(this.settings) };
        }
        return this.activo;
      })().finally(() => {
        this.enCurso = null;
      });
    }
    return this.enCurso;
  }

  /**
   * Ejecuta la operación en el driver activo. Ante `RutaDeGestionAusente`
   * vuelve a averiguar la API y, solo si ha cambiado, la repite UNA vez: un
   * 404 de la ruta de gestión garantiza que el motor no hizo nada, así que
   * repetir una modificación no la duplica.
   */
  private async llamar<T>(operacion: (driver: MailEngine) => Promise<T>): Promise<T> {
    const actual = await this.elegir();
    try {
      return await operacion(actual.driver);
    } catch (err) {
      if (!(err instanceof RutaDeGestionAusente)) throw err;
      let nuevo: Activo;
      try {
        nuevo = await this.elegir(true);
      } catch {
        throw err;
      }
      if (nuevo.api === actual.api) throw err;
      return operacion(nuevo.driver);
    }
  }

  async detectApi(): Promise<EngineApi> {
    return (await this.elegir()).api;
  }

  /**
   * Comprueba el motor preguntando de nuevo su versión: el vigilante llama a
   * ping cada minuto, así que un motor migrado con el panel en marcha se
   * detecta enseguida aunque nadie haga nada en el panel. Devuelve la API.
   */
  async ping(): Promise<EngineHealth> {
    let actual: Activo;
    try {
      actual = await this.elegir(true);
    } catch (err) {
      const api = this.apiConocida;
      return { ok: false, ...(api ? { api } : {}), detail: (err as Error).message };
    }
    try {
      return { ...(await actual.driver.ping()), api: actual.api };
    } catch (err) {
      return { ok: false, api: actual.api, detail: (err as Error).message };
    }
  }

  createDomain(domain: string): Promise<void> {
    return this.llamar((d) => d.createDomain(domain));
  }
  deleteDomain(domain: string): Promise<void> {
    return this.llamar((d) => d.deleteDomain(domain));
  }
  ensureDkim(domain: string, selector: string): Promise<void> {
    return this.llamar((d) => d.ensureDkim(domain, selector));
  }
  getDnsRecords(domain: string): Promise<EngineDnsRecord[]> {
    return this.llamar((d) => d.getDnsRecords(domain));
  }
  createMailbox(input: CreateMailboxInput): Promise<void> {
    return this.llamar((d) => d.createMailbox(input));
  }
  setMailboxPassword(email: string, passwordHash: string): Promise<void> {
    return this.llamar((d) => d.setMailboxPassword(email, passwordHash));
  }
  updateMailbox(email: string, patch: UpdateMailboxPatch): Promise<void> {
    return this.llamar((d) => d.updateMailbox(email, patch));
  }
  deleteMailbox(email: string): Promise<void> {
    return this.llamar((d) => d.deleteMailbox(email));
  }
  upsertAlias(alias: string, destinations: string[], externalDestinations?: string[]): Promise<void> {
    return this.llamar((d) => d.upsertAlias(alias, destinations, externalDestinations));
  }
  deleteAlias(alias: string): Promise<void> {
    return this.llamar((d) => d.deleteAlias(alias));
  }
  readMailboxCredentials(email: string): Promise<MailboxCredentials | null> {
    return this.llamar((d) => d.readMailboxCredentials(email));
  }
  listDirectory(): Promise<EngineDirectory> {
    return this.llamar((d) => d.listDirectory());
  }
  getMailboxUsage(): Promise<Map<string, number>> {
    return this.llamar((d) => d.getMailboxUsage());
  }
  applyRecommended(input: RecommendedInput): Promise<EngineReloadResult> {
    return this.llamar((d) => d.applyRecommended(input));
  }
  getSettingsStatus(input: { trustedNetworks: string[] }): Promise<EngineSettingsStatus> {
    return this.llamar((d) => d.getSettingsStatus(input));
  }
  configureAcme(input: AcmeInput): Promise<EngineReloadResult> {
    return this.llamar((d) => d.configureAcme(input));
  }
  getRunningHostname(): Promise<string | null> {
    return this.llamar((d) => d.getRunningHostname());
  }
  reloadCertificates(): Promise<void> {
    return this.llamar((d) => d.reloadCertificates());
  }
  addAppPassword(email: string, label: string, proposedSecret: string): Promise<CreatedAppPassword> {
    return this.llamar((d) => d.addAppPassword(email, label, proposedSecret));
  }
  removeAppPassword(email: string, ref: string): Promise<void> {
    return this.llamar((d) => d.removeAppPassword(email, ref));
  }
  getQueueSummary(): Promise<QueueSummary> {
    return this.llamar((d) => d.getQueueSummary());
  }
}
