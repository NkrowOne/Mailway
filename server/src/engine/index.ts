import { badRequest } from '../core/errors';
import { getEngineSettings } from '../modules/settings';
import { DemoEngine } from './demo';
import { MotorStalwart } from './detector';
import { MotorProtegido } from './protegido';
import type { EngineApi, EngineSettings, MailEngine } from './types';

interface EnCache {
  fingerprint: string;
  /** El motor tal cual: solo para la herramienta de migración (tools/motor.ts). */
  motor: MailEngine;
  /** El mismo motor tras el guardián del modo mantenimiento. */
  protegido: MailEngine;
}

let cached: EnCache | null = null;

function fingerprint(settings: EngineSettings): string {
  return [settings.kind, settings.url, settings.adminUser, settings.adminPassword].join('|');
}

/**
 * Motor para unos ajustes concretos, sin el guardián del mantenimiento. Con
 * Stalwart es la fachada que averigua la versión (0.15 o 0.16) en la primera
 * llamada (engine/detector.ts).
 */
export function buildEngine(settings: EngineSettings): MailEngine {
  if (settings.kind === 'demo') return new DemoEngine();
  return new MotorStalwart(settings);
}

/**
 * Motor para unos ajustes concretos cuyas modificaciones respetan el modo
 * mantenimiento: lo usa la puesta en marcha para aplicar los ajustes
 * recomendados. Si son los del motor activo, es el mismo objeto que
 * `getEngine()`: así lo que el driver recuerda en memoria tras una operación
 * (en Stalwart 0.16, los cambios que esperan a que se reinicie el motor) lo
 * ve después Ajustes; con un objeto nuevo se perdería al terminar la
 * petición.
 */
export function motorProtegidoPara(settings: EngineSettings): MailEngine {
  const activos = getEngineSettings();
  if (activos && fingerprint(activos) === fingerprint(settings)) return getEngine();
  return new MotorProtegido(buildEngine(settings));
}

export interface OpcionesMotor {
  /**
   * Saltarse el modo mantenimiento. SOLO para la herramienta de migración
   * del motor (tools/motor.ts), que es quien trabaja durante la ventana.
   */
  saltarMantenimiento?: boolean;
}

/**
 * Devuelve el motor configurado. Lanza 400 si el asistente de configuración
 * aún no ha conectado ningún motor. Es siempre el mismo objeto mientras no
 * cambien los ajustes: la versión detectada se recuerda entre llamadas.
 */
export function getEngine(opciones: OpcionesMotor = {}): MailEngine {
  const settings = getEngineSettings();
  if (!settings) {
    throw badRequest(
      'El motor de correo aún no está configurado. Completa la puesta en marcha o revisa Ajustes → Servidor de correo.',
      'engine_not_configured',
    );
  }
  const fp = fingerprint(settings);
  if (!cached || cached.fingerprint !== fp) {
    const motor = buildEngine(settings);
    cached = { fingerprint: fp, motor, protegido: new MotorProtegido(motor) };
  }
  return opciones.saltarMantenimiento ? cached.motor : cached.protegido;
}

export function engineConfigured(): boolean {
  return getEngineSettings() !== null;
}

/**
 * API del motor configurado, o null si no hay motor o no se puede averiguar
 * a tiempo. Para lo que solo informa (Ajustes, integraciones): nunca lanza y
 * no espera más de `esperaMs` a un motor que no responde.
 */
export async function apiDelMotor(esperaMs = 3000): Promise<EngineApi | null> {
  if (!engineConfigured()) return null;
  let timer: NodeJS.Timeout | undefined;
  const tarde = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), esperaMs);
  });
  try {
    return await Promise.race([getEngine().detectApi().catch(() => null), tarde]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
