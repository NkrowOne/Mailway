import { now } from '../core/db';
import { HttpError } from '../core/errors';
import { deleteSetting, getJsonSetting, setJsonSetting } from './settings';

/**
 * Modo mantenimiento del motor: la ventana en la que se cambia de versión el
 * servidor de correo (de Stalwart 0.15 a 0.16, o la vuelta atrás).
 *
 * Mientras dura, ninguna MODIFICACIÓN llega al motor desde el panel, las
 * integraciones ni el vigilante (el guardián de engine/protegido.ts responde
 * 503 `engine_maintenance`), y el vigilante no avisa de «motor caído»: el
 * motor se para a propósito. Las lecturas siguen funcionando donde se puede.
 * Así nada de lo que se haga en el panel durante la migración se pierde a
 * medias entre el motor viejo y el nuevo.
 *
 * Se guarda en la base de datos (lo activa la herramienta de terminal, en
 * otro proceso) y CADUCA solo: una migración que se interrumpe no puede dejar
 * el panel bloqueado para siempre. La propia herramienta de migración
 * (tools/motor.ts) trabaja con el motor sin el guardián.
 */

const CLAVE = 'motor_mantenimiento';

/** Duración por defecto: de sobra para una migración con copia de un volumen de varios GB. */
export const MINUTOS_POR_DEFECTO = 120;
/** Nunca más de un día: si nadie lo desactiva, el panel vuelve a funcionar solo. */
export const MINUTOS_MAXIMOS = 24 * 60;

export interface EstadoMantenimiento {
  activo: boolean;
  /** Inicio, en ms; null si no está activo. */
  desde: number | null;
  /** Caducidad, en ms; null si no está activo. */
  hasta: number | null;
  motivo: string;
}

interface Guardado {
  desde: number;
  hasta: number;
  motivo?: string;
}

const INACTIVO: EstadoMantenimiento = { activo: false, desde: null, hasta: null, motivo: '' };

export function estadoMantenimiento(t = now()): EstadoMantenimiento {
  const guardado = getJsonSetting<Guardado>(CLAVE);
  if (!guardado || typeof guardado.hasta !== 'number' || guardado.hasta <= t) return { ...INACTIVO };
  return {
    activo: true,
    desde: typeof guardado.desde === 'number' ? guardado.desde : null,
    hasta: guardado.hasta,
    motivo: typeof guardado.motivo === 'string' ? guardado.motivo : '',
  };
}

export function mantenimientoActivo(): boolean {
  return estadoMantenimiento().activo;
}

/**
 * Activa (o prolonga) el mantenimiento durante `minutos`. Si ya estaba
 * activo conserva su inicio: así la duración total se ve en el estado.
 */
export function activarMantenimiento(
  minutos = MINUTOS_POR_DEFECTO,
  motivo = 'Actualización del servidor de correo',
): EstadoMantenimiento {
  const duracion = Math.min(Math.max(1, Math.round(minutos)), MINUTOS_MAXIMOS);
  const t = now();
  const anterior = estadoMantenimiento(t);
  setJsonSetting(CLAVE, {
    desde: anterior.activo && anterior.desde !== null ? anterior.desde : t,
    hasta: t + duracion * 60_000,
    motivo,
  } satisfies Guardado);
  return estadoMantenimiento(t);
}

export function desactivarMantenimiento(): EstadoMantenimiento {
  deleteSetting(CLAVE);
  return { ...INACTIVO };
}

export function errorMantenimiento(): HttpError {
  return new HttpError(
    503,
    'El servidor de correo se está actualizando y, hasta que termine, no admite cambios en dominios, buzones, alias ni contraseñas. Vuelve a intentarlo en unos minutos.',
    'engine_maintenance',
  );
}

/** Lanza 503 `engine_maintenance` si el motor está en mantenimiento. */
export function exigirSinMantenimiento(): void {
  if (mantenimientoActivo()) throw errorMantenimiento();
}
