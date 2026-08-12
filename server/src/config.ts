import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = process.env.MAILWAY_DATA_DIR
  ? path.resolve(process.env.MAILWAY_DATA_DIR)
  : path.resolve(process.cwd(), 'data');

fs.mkdirSync(dataDir, { recursive: true });

/**
 * Clave maestra del panel: firma sesiones y cifra secretos (contraseñas de
 * aplicación SMTP, credenciales del motor). Se genera una vez y se persiste
 * en el volumen de datos; MAILWAY_SECRET la sobreescribe si se define.
 */
function loadSecret(): string {
  const fromEnv = process.env.MAILWAY_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const secretFile = path.join(dataDir, '.secret');
  if (fs.existsSync(secretFile)) {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing.length >= 16) return existing;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

export const config = {
  port: Number(process.env.PORT || 4100),
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  dbPath: path.join(dataDir, 'mailway.db'),
  secret: loadSecret(),
  /** Fuerza el motor de demostración (sin servidor de correo real). */
  demoMode: process.env.MAILWAY_DEMO === '1',
  /**
   * Valores iniciales para el asistente de configuración; útiles cuando el
   * stack se levanta con docker-compose y ya se sabe dónde está Stalwart.
   */
  engineDefaults: {
    url: process.env.STALWART_URL || '',
    adminUser: process.env.STALWART_ADMIN_USER || 'admin',
    adminPassword: process.env.STALWART_ADMIN_PASSWORD || '',
    smtpHost: process.env.STALWART_SMTP_HOST || '',
    smtpPort: Number(process.env.STALWART_SMTP_PORT || 587),
  },
  webmailUrlDefault: process.env.MAILWAY_WEBMAIL_URL || '',
  mailHostnameDefault: process.env.MAILWAY_MAIL_HOSTNAME || '',
  publicIpDefault: process.env.MAILWAY_PUBLIC_IP || '',
  sessionTtlHours: Number(process.env.MAILWAY_SESSION_TTL_HOURS || 24 * 7),
  isProduction: process.env.NODE_ENV === 'production',

  /**
   * Marca blanca: Traefik sondea `/api/traefik/config` de este panel y recibe
   * las rutas de los dominios propios de cada cliente. Aquí se define a qué
   * contenedor debe enviar Traefik el tráfico de cada tipo de dominio.
   */
  traefik: {
    /** Contenedor del webmail dentro de la red del proxy. */
    webmailBackend: process.env.MAILWAY_WEBMAIL_BACKEND_URL || 'http://mailway-webmail:80',
    /**
     * Contenedor de este mismo panel. Como lo despliega Skyway, su nombre lo
     * genera Skyway: sin este valor, los dominios de tipo "panel" se desactivan.
     */
    panelBackend: process.env.MAILWAY_PANEL_BACKEND_URL || '',
    /** Nombre del certresolver de Traefik. En Skyway es "le". */
    certResolver: process.env.MAILWAY_TRAEFIK_CERTRESOLVER || 'le',
  },

  /** Vigilante: cada cuántos segundos se comprueba la salud del sistema. */
  watchdogIntervalSeconds: Number(process.env.MAILWAY_WATCHDOG_INTERVAL || 60),
  /** Desactiva el vigilante (útil en desarrollo y en los tests). */
  watchdogDisabled: process.env.MAILWAY_WATCHDOG_DISABLED === '1',
};
