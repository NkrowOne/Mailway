import { badRequest } from '../core/errors';
import { getEngineSettings } from '../modules/settings';
import { DemoEngine } from './demo';
import { StalwartEngine } from './stalwart';
import type { EngineSettings, MailEngine } from './types';

let cached: { engine: MailEngine; fingerprint: string } | null = null;

function fingerprint(settings: EngineSettings): string {
  return [settings.kind, settings.url, settings.adminUser, settings.adminPassword].join('|');
}

export function buildEngine(settings: EngineSettings): MailEngine {
  if (settings.kind === 'demo') return new DemoEngine();
  return new StalwartEngine(settings);
}

/**
 * Devuelve el motor configurado. Lanza 400 si el asistente de configuración
 * aún no ha conectado ningún motor.
 */
export function getEngine(): MailEngine {
  const settings = getEngineSettings();
  if (!settings) {
    throw badRequest(
      'El motor de correo aún no está configurado. Completa el asistente en Ajustes → Motor.',
      'engine_not_configured',
    );
  }
  const fp = fingerprint(settings);
  if (!cached || cached.fingerprint !== fp) {
    cached = { engine: buildEngine(settings), fingerprint: fp };
  }
  return cached.engine;
}

export function engineConfigured(): boolean {
  return getEngineSettings() !== null;
}
