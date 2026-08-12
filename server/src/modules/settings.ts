import { db, now } from '../core/db';
import { decryptSecret, encryptSecret } from '../core/crypto';
import { config } from '../config';
import type { EngineSettings } from '../engine/types';

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare(
  `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
);

export function getSetting(key: string): string | null {
  const row = getStmt.get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  setStmt.run(key, value, now());
}

export function getJsonSetting<T>(key: string): T | null {
  const raw = getSetting(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function setJsonSetting(key: string, value: unknown): void {
  setSetting(key, JSON.stringify(value));
}

/* ------------------------- Ajustes de la instancia ------------------------ */

export interface InstanceSettings {
  /** Nombre visible de la instancia (marca blanca). */
  brandName: string;
  /** FQDN del servidor de correo, p. ej. mail.miempresa.com */
  mailHostname: string;
  /** IP pública del servidor (para SPF, PTR y checks de listas negras). */
  publicIp: string;
  /** URL del webmail (Roundcube/SnappyMail), si está desplegado. */
  webmailUrl: string;
  /** Dirección desde la que el panel envía avisos (opcional). */
  systemFrom: string;
}

export function getInstanceSettings(): InstanceSettings {
  const stored = getJsonSetting<Partial<InstanceSettings>>('instance') || {};
  return {
    brandName: stored.brandName || 'Mailway',
    mailHostname: stored.mailHostname || config.mailHostnameDefault,
    publicIp: stored.publicIp || config.publicIpDefault,
    webmailUrl: stored.webmailUrl || config.webmailUrlDefault,
    systemFrom: stored.systemFrom || '',
  };
}

export function setInstanceSettings(patch: Partial<InstanceSettings>): InstanceSettings {
  const merged = { ...getInstanceSettings(), ...patch };
  setJsonSetting('instance', merged);
  return merged;
}

/* -------------------------- Ajustes del motor ----------------------------- */

interface StoredEngineSettings extends Omit<EngineSettings, 'adminPassword'> {
  adminPasswordEnc: string;
}

export function getEngineSettings(): EngineSettings | null {
  if (config.demoMode) {
    return {
      kind: 'demo',
      url: '',
      adminUser: '',
      adminPassword: '',
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: false,
    };
  }
  const stored = getJsonSetting<StoredEngineSettings>('engine');
  if (!stored) return null;
  return {
    kind: stored.kind,
    url: stored.url,
    adminUser: stored.adminUser,
    adminPassword: stored.adminPasswordEnc ? decryptSecret(stored.adminPasswordEnc) : '',
    smtpHost: stored.smtpHost,
    smtpPort: stored.smtpPort,
    smtpSecure: stored.smtpSecure,
  };
}

export function setEngineSettings(settings: EngineSettings): void {
  const stored: StoredEngineSettings = {
    kind: settings.kind,
    url: settings.url,
    adminUser: settings.adminUser,
    adminPasswordEnc: settings.adminPassword ? encryptSecret(settings.adminPassword) : '',
    smtpHost: settings.smtpHost,
    smtpPort: settings.smtpPort,
    smtpSecure: settings.smtpSecure,
  };
  setJsonSetting('engine', stored);
}

/** true cuando el asistente de primera puesta en marcha ya se completó. */
export function isSetupComplete(): boolean {
  return getSetting('setup_complete') === '1';
}

export function markSetupComplete(): void {
  setSetting('setup_complete', '1');
}
