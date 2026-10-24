import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { api, ApiError } from './api';

/*
  Llaves de acceso (passkeys) del panel y de «Mi buzón». Las dos áreas
  comparten la forma de las rutas y solo cambia la base: `/api/auth` para los
  usuarios del panel y `/api/portal` para el titular del buzón.

  Cada operación son dos pasos con el servidor: pedir las opciones (llevan un
  desafío de un solo uso) y devolver lo que firma el gestor de contraseñas o
  el dispositivo con ese desafío.
*/

export type BaseLlaves = '/api/auth' | '/api/portal';

/** Máximo de llaves por cuenta: el servidor rechaza la undécima (409 `passkey_limit`). */
export const MAX_LLAVES = 10;

export interface Llave {
  id: string;
  /** «Proton Pass», «iPhone de Ana»…; editable (1–60 caracteres). */
  nombre: string;
  /** Gestor deducido por el servidor; null si no se reconoce. */
  proveedor: string | null;
  /** Nombre (host) en el que funciona: una llave solo sirve donde se registró. */
  host: string;
  creadaEn: number;
  ultimoUso: number | null;
  /** El gestor la sincroniza entre dispositivos (copia de seguridad). */
  sincronizada: boolean;
}

/** GET {base}/llaves */
export interface ListaLlaves {
  llaves: Llave[];
  hostActual: string;
  /**
   * Solo en «Mi buzón»: origen (`https://panel.cliente.es`) desde el que el
   * webmail ofrece entrar con llave; null si el titular no tiene un webmail
   * que lo admita.
   */
  portalCorreoWeb?: string | null;
}

interface OpcionesRegistro {
  desafio: string;
  opciones: PublicKeyCredentialCreationOptionsJSON;
}

interface OpcionesAcceso {
  desafio: string;
  opciones: PublicKeyCredentialRequestOptionsJSON;
}

/**
 * El navegador sabe usar llaves de acceso. Fuera de un contexto seguro
 * (un panel recién instalado servido por HTTP) la API no existe o falla.
 */
export function llavesDisponibles(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext === true &&
    typeof window.PublicKeyCredential === 'function'
  );
}

/** Por qué no se ofrecen las llaves en este navegador, en una frase. */
export function motivoSinLlaves(): string {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return 'Las llaves de acceso solo funcionan con una conexión segura (HTTPS).';
  }
  return 'Este navegador no admite llaves de acceso. Usa uno actualizado para añadirlas o usarlas.';
}

export const TEXTO_LLAVE_CANCELADA = 'Se ha cancelado la solicitud de la llave de acceso o ha caducado. Vuelve a intentarlo.';

/**
 * Texto para cualquier fallo de una operación con llave. Los errores del
 * servidor llegan ya en español y se muestran tal cual; los del navegador
 * (que vienen en inglés y con nombres técnicos) se traducen por su tipo.
 */
export function mensajeErrorLlave(err: unknown, operacion: 'registrar' | 'entrar'): string {
  if (err instanceof ApiError) return err.message;
  const nombre = err instanceof Error ? err.name : '';
  // NotAllowedError: la persona cerró el diálogo, no eligió ninguna llave o
  // se agotó el tiempo; el navegador no distingue entre los tres casos.
  if (nombre === 'NotAllowedError' || nombre === 'AbortError') return TEXTO_LLAVE_CANCELADA;
  if (nombre === 'InvalidStateError' && operacion === 'registrar') return 'Ya has añadido esta llave de acceso.';
  if (nombre === 'SecurityError') return 'Esta dirección no admite llaves de acceso.';
  if (nombre === 'NotSupportedError' || nombre === 'ConstraintError') {
    return 'Este dispositivo o gestor de contraseñas no admite este tipo de llave de acceso.';
  }
  return operacion === 'registrar'
    ? 'No se ha podido añadir la llave de acceso. Comprueba la conexión y vuelve a intentarlo.'
    : 'No se ha podido acceder con la llave de acceso. Comprueba la conexión y vuelve a intentarlo.';
}

/**
 * Registra una llave nueva para la sesión abierta. Sin nombre, el servidor la
 * llama como el gestor en el que se guarde.
 */
export async function registrarLlave(base: BaseLlaves, nombre?: string): Promise<Llave> {
  const { desafio, opciones } = await api.post<OpcionesRegistro>(`${base}/llaves/opciones`, {});
  const respuesta = await startRegistration({ optionsJSON: opciones });
  const limpio = nombre?.trim();
  const { llave } = await api.post<{ llave: Llave }>(`${base}/llaves`, {
    desafio,
    respuesta,
    ...(limpio ? { nombre: limpio } : {}),
  });
  return llave;
}

/**
 * Entra con una llave «descubrible»: no hace falta indicar la cuenta, la
 * elige la persona en su gestor. Devuelve la respuesta de `{base}/llave/entrar`.
 */
export async function entrarConLlave<T>(base: BaseLlaves, extra: Record<string, unknown> = {}): Promise<T> {
  const { desafio, opciones } = await api.post<OpcionesAcceso>(`${base}/llave/opciones`, {});
  const respuesta = await startAuthentication({ optionsJSON: opciones });
  return api.post<T>(`${base}/llave/entrar`, { desafio, respuesta, ...extra });
}

export function renombrarLlave(base: BaseLlaves, id: string, nombre: string): Promise<{ llave: Llave }> {
  return api.patch<{ llave: Llave }>(`${base}/llaves/${encodeURIComponent(id)}`, { nombre: nombre.trim() });
}

export function eliminarLlave(base: BaseLlaves, id: string): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(`${base}/llaves/${encodeURIComponent(id)}`);
}

/** Clave de react-query de la lista de llaves de cada área. */
export function claveLlaves(base: BaseLlaves): readonly [string, BaseLlaves] {
  return ['llaves', base] as const;
}

/**
 * Nombre de host razonable para usarlo en un enlace (`https://<host>/`):
 * etiquetas de letras, cifras y guiones separadas por puntos, con al menos un
 * punto. Lo que llega por la URL no debe poder convertirse en otra cosa
 * (`evil.com/@`, `javascript:`…). Devuelve el nombre en minúsculas o null.
 */
export function hostValido(valor: string | null | undefined): string | null {
  if (!valor) return null;
  const host = valor.trim().toLowerCase().replace(/\.$/, '');
  if (host.length < 3 || host.length > 253) return null;
  const etiquetas = host.split('.');
  if (etiquetas.length < 2) return null;
  const etiquetaValida = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!etiquetas.every((e) => etiquetaValida.test(e))) return null;
  // El dominio de primer nivel nunca es solo numérico (descarta IP sueltas).
  if (/^\d+$/.test(etiquetas[etiquetas.length - 1] ?? '')) return null;
  return host;
}

/**
 * `estado` del viaje al webmail: lo genera el webmail antes de enviar aquí al
 * titular y lo comprueba al volver, para que nadie pueda preparar un enlace
 * que haga entrar a otra persona en un buzón ajeno. base64url de 16 a 64
 * caracteres; cualquier otra cosa se descarta.
 */
export function estadoValido(valor: string | null | undefined): string | null {
  return valor && /^[A-Za-z0-9_-]{16,64}$/.test(valor) ? valor : null;
}

/**
 * Lee un origen que llega del servidor (`https://panel.cliente.es`) para
 * enlazarlo: solo http(s), y devuelve el origen normalizado y su host. null si
 * no se puede leer.
 */
export function leerOrigen(origen: string | null | undefined): { origen: string; host: string } | null {
  if (!origen) return null;
  try {
    const url = new URL(origen);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return { origen: url.origin, host: url.host.toLowerCase() };
  } catch {
    return null;
  }
}
