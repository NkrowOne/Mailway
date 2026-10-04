import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { lookupA, lookupPtr } from '../core/dns';
import { db, now } from '../core/db';
import { detectarIpPublica } from '../core/ippublica';
import { badRequest, forbidden, tooMany } from '../core/errors';
import { isValidHostname } from '../core/hostnames';
import { buildEngine, engineConfigured } from '../engine';
import type { EngineSettings } from '../engine/types';
import { audit } from './audit';
import {
  type AuthedUser,
  countUsers,
  createInitialAdmin,
  createSession,
  requireAdmin,
  requireAdminSession,
} from './auth';
import { ensureDefaultPlans } from './clients';
import { refreshAutoconfigHosts } from './autoconfig';
import { applyRecommendedEngineSettings } from './engineops';
import {
  type InstanceSettings,
  getEngineSettings,
  getInstanceSettings,
  getJsonSetting,
  isSetupComplete,
  markSetupComplete,
  normalizePanelUrl,
  setEngineSettings,
  setInstanceSettings,
} from './settings';

const adminSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email('Introduce un correo válido.'),
  name: z.string().trim().min(2, 'Escribe tu nombre.').max(80, 'El nombre no puede superar los 80 caracteres.'),
  password: z
    .string()
    .min(10, 'La contraseña debe tener al menos 10 caracteres.')
    .max(200, 'La contraseña no puede superar los 200 caracteres.'),
  setupToken: z.string().trim().max(200).optional(),
});

const ENGINE_URL_HELP = 'La URL del motor no es válida (ej.: http://mailway-mail:8080).';

/**
 * URL de la API de gestión del motor: solo http(s) y sin credenciales
 * incrustadas (la contraseña viaja aparte, por Basic, y nunca en la URL, que
 * acaba en registros y mensajes de error).
 */
const engineUrlSchema = z
  .string()
  .trim()
  .max(500, ENGINE_URL_HELP)
  .url(ENGINE_URL_HELP)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'La URL del motor debe empezar por http:// o https:// y no puede incluir usuario ni contraseña (ej.: http://mailway-mail:8080).');

const engineSchema = z.object({
  kind: z.enum(['stalwart', 'demo']),
  url: engineUrlSchema.or(z.literal('')),
  adminUser: z.string().trim().max(60),
  adminPassword: z.string().max(200),
  smtpHost: z.string().trim().max(200),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
});

/** Conectar el motor que definió el instalador sin que su contraseña pase por el navegador. */
const engineFromEnvSchema = z.object({ useEnvDefaults: z.literal(true) });

/**
 * URL http(s). z.string().url() acepta cualquier esquema, y estas direcciones
 * acaban como enlaces en el panel y en «Mi buzón»: un «javascript:» sería un
 * enlace que ejecuta código en la sesión de quien lo pulsa.
 */
function httpUrl(message: string) {
  return z
    .string()
    .trim()
    .max(500, message)
    .url(message)
    .refine((value) => /^https?:\/\//i.test(value), message);
}

const instanceSchema = z.object({
  brandName: z.string().trim().min(1).max(60).optional(),
  // Se escribe tal cual en la configuración del motor y en los registros MX:
  // el mismo validador que usan la comprobación DNS y el fichero de zona.
  mailHostname: z
    .string()
    .trim()
    .max(253)
    .refine(
      (value) => value === '' || isValidHostname(value),
      'El nombre del servidor de correo no es válido: escribe un nombre completo, no una dirección IP (ej.: mail.miempresa.com).',
    )
    .optional(),
  publicIp: z
    .string()
    .trim()
    .regex(/^$|^(\d{1,3}\.){3}\d{1,3}$/, 'La IP debe tener formato IPv4, ej.: 203.0.113.10')
    .optional(),
  webmailUrl: httpUrl('La URL del webmail no es válida (ej.: https://webmail.miempresa.com).').or(z.literal('')).optional(),
  panelUrl: httpUrl('La URL del panel no es válida (ej.: https://panel.miempresa.com).').or(z.literal('')).optional(),
  systemFrom: z.string().email().or(z.literal('')).optional(),
});

export type InstanceInput = z.infer<typeof instanceSchema>;

/**
 * Intentos fallidos del token de puesta en marcha por IP. El token del
 * instalador tiene 128 bits, pero un operador puede fijar uno corto a mano:
 * sin tope se podría probar sin fin mientras nadie ha reclamado la instancia.
 */
const SETUP_WINDOW_MS = 15 * 60_000;
const SETUP_MAX_FAILURES = 10;

function setupFailures(ip: string): number {
  db.prepare("DELETE FROM login_attempts WHERE attempted_at < ? AND ip LIKE 'setup%'").run(now() - SETUP_WINDOW_MS);
  return (
    db
      .prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND attempted_at >= ?')
      .get(`setup:${ip}`, now() - SETUP_WINDOW_MS) as { c: number }
  ).c;
}

/** URL sin barras finales, para comparar la guardada con la recibida. */
function sameEngineUrl(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Completa la contraseña del motor con la guardada SOLO si el destino no
 * cambia. Si cambian la URL, el usuario o el servidor SMTP, reutilizarla
 * mandaría la contraseña guardada (o las credenciales SMTP de las claves de
 * API) a un servidor que quien pide el cambio podría controlar: en ese caso
 * hay que volver a escribirla.
 */
function withStoredPassword(body: EngineSettings): EngineSettings {
  if (body.kind !== 'stalwart' || body.adminPassword) return body;
  const current = getEngineSettings();
  const sameTarget =
    current !== null &&
    current.kind === 'stalwart' &&
    Boolean(current.adminPassword) &&
    sameEngineUrl(current.url, body.url) &&
    current.adminUser === body.adminUser &&
    current.smtpHost.trim().toLowerCase() === body.smtpHost.trim().toLowerCase();
  if (!sameTarget) {
    throw badRequest(
      'Para cambiar la URL, el usuario o el servidor SMTP del motor, indica también la contraseña del administrador del motor.',
      'engine_password_required',
    );
  }
  return { ...body, adminPassword: current!.adminPassword };
}

/** Comparación en tiempo constante: el hash iguala longitudes antes de comparar. */
function sameSecret(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** El motor definido por el entorno (STALWART_*), si trae lo imprescindible. */
export function engineFromEnv(): EngineSettings | null {
  const d = config.engineDefaults;
  if (!d.url || !d.adminPassword) return null;
  let smtpHost = d.smtpHost;
  if (!smtpHost) {
    try {
      smtpHost = new URL(d.url).hostname;
    } catch {
      smtpHost = '';
    }
  }
  return {
    kind: 'stalwart',
    url: d.url,
    adminUser: d.adminUser || 'admin',
    adminPassword: d.adminPassword,
    smtpHost,
    smtpPort: d.smtpPort || 587,
    smtpSecure: d.smtpPort === 465,
  };
}

/** Quita la contraseña de cualquier texto que vaya a salir hacia el navegador. */
export function scrub(text: string, secret: string): string {
  return secret ? text.split(secret).join('•••') : text;
}

async function testEngine(settings: EngineSettings): Promise<{ ok: boolean; detail?: string }> {
  const engine = buildEngine(settings);
  const health = await engine.ping();
  return { ok: health.ok, detail: health.detail ? scrub(health.detail, settings.adminPassword) : undefined };
}

export interface RecommendedOutcome {
  applied: boolean;
  hostname: string;
  errors: string[];
  warnings: string[];
  error?: string;
}

/**
 * Tras conectar un motor real con el nombre del servidor ya conocido, fija
 * en el motor los ajustes recomendados. Nunca hace fallar el paso: si el
 * motor no los acepta, el resultado lo explica y Ajustes permite repetirlo.
 */
export async function applyRecommendedQuietly(settings: EngineSettings | null): Promise<RecommendedOutcome | null> {
  if (!settings || settings.kind !== 'stalwart') return null;
  const hostname = getInstanceSettings().mailHostname.trim().toLowerCase();
  if (!hostname) return null;
  try {
    const result = await applyRecommendedEngineSettings(hostname, buildEngine(settings));
    return { applied: result.errors.length === 0, hostname, errors: result.errors, warnings: result.warnings };
  } catch (err) {
    return {
      applied: false,
      hostname,
      errors: [],
      warnings: [],
      error: scrub((err as Error).message, settings.adminPassword),
    };
  }
}

/* ---------------- Pasos de la puesta en marcha, reutilizables -------------- */
/*
 * Las rutas del asistente y la herramienta de emparejado con Skyway
 * (`tools/emparejar.ts`) hacen lo mismo con estas funciones: así el panel
 * queda igual se ponga en marcha desde el navegador o desde el instalador.
 */

/**
 * Paso 1: el primer administrador y los planes iniciales. La comprobación de
 * que no existe ninguno y el alta van en una sola transacción
 * (`createInitialAdmin`): si ya hay usuarios, lanza 403 `admin_exists`.
 */
export function createFirstAdmin(input: { email: string; name: string; password: string }): AuthedUser {
  const user = createInitialAdmin(input);
  ensureDefaultPlans();
  return user;
}

/**
 * Paso 2: prueba el motor, lo guarda como el activo y le aplica los ajustes
 * recomendados (sin hacer fallar el paso si no los acepta). Un motor que no
 * responde no se guarda: lanza 400 `engine_test_failed`, sin la contraseña.
 */
export async function connectEngine(settings: EngineSettings): Promise<RecommendedOutcome | null> {
  if (settings.kind === 'stalwart') {
    if (!settings.url) throw badRequest('Indica la URL de la API de gestión de Stalwart.');
    if (!settings.adminPassword) throw badRequest('Indica la contraseña del administrador del motor.');
    const result = await testEngine(settings);
    if (!result.ok) {
      throw badRequest(
        `No se pudo conectar con el motor: ${result.detail || 'sin detalle'}. Revisa la URL y las credenciales.`,
        'engine_test_failed',
      );
    }
  }
  setEngineSettings(settings);
  return applyRecommendedQuietly(settings);
}

/**
 * Con Stalwart, el nombre del servidor de correo es obligatorio: sin él, los
 * datos de conexión de los buzones, el portal y los perfiles salen sin
 * servidor y el motor no recibe sus ajustes recomendados. Un campo vacío vale
 * si el entorno lo define (MAILWAY_MAIL_HOSTNAME), porque entonces es el que
 * se usa. Solo se mira si la petición trae el campo.
 */
function exigirNombreDelServidor(body: InstanceInput): void {
  if (body.mailHostname === undefined || body.mailHostname.trim()) return;
  if (config.mailHostnameDefault.trim()) return;
  if (getEngineSettings()?.kind !== 'stalwart') return;
  throw badRequest(
    'Indica el nombre del servidor de correo (FQDN), por ejemplo mail.miempresa.com: sin él, los datos de conexión de los buzones no incluyen el servidor.',
    'mail_hostname_required',
  );
}

/**
 * Paso 3: guarda la identidad del servidor y, con el nombre ya conocido, se
 * lo fija al motor: sin él, Stalwart anuncia el identificador del contenedor
 * en su DNS.
 */
export async function saveInstanceIdentity(
  body: InstanceInput,
): Promise<{ instance: InstanceSettings; recommended: RecommendedOutcome | null }> {
  exigirNombreDelServidor(body);
  const instance = setInstanceSettings(body);
  const recommended = await applyRecommendedQuietly(getEngineSettings());
  return { instance, recommended };
}

/** Campos de la identidad que el instalador define en el entorno del panel. */
const INSTANCE_FROM_ENV = [
  ['mailHostname', 'MAILWAY_MAIL_HOSTNAME', () => config.mailHostnameDefault],
  ['publicIp', 'MAILWAY_PUBLIC_IP', () => config.publicIpDefault],
  ['webmailUrl', 'MAILWAY_WEBMAIL_URL', () => config.webmailUrlDefault],
  ['panelUrl', 'MAILWAY_PANEL_URL', () => config.panelUrlDefault],
] as const;

/**
 * Lo que setInstanceSettings rechazaría aunque pase el esquema: la URL del
 * panel no admite credenciales, parámetros ni fragmentos. Se comprueba aquí
 * para descartar solo ese valor, en lugar de hacer fallar el guardado entero.
 */
function guardable(field: (typeof INSTANCE_FROM_ENV)[number][0], value: string): boolean {
  if (field !== 'panelUrl') return true;
  try {
    normalizePanelUrl(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Identidad del servidor que trae el entorno (`MAILWAY_MAIL_HOSTNAME`,
 * `MAILWAY_PUBLIC_IP`, `MAILWAY_WEBMAIL_URL`, `MAILWAY_PANEL_URL`), solo para
 * los campos que aún no se han guardado: lo que la administración cambió en
 * el panel no se pisa. Cada valor pasa por la misma validación que el
 * asistente; uno no válido se descarta con un aviso, sin repetir el valor.
 */
export function instanceFromEnv(): { patch: InstanceInput; warnings: string[] } {
  const stored = getJsonSetting<Partial<InstanceSettings>>('instance') || {};
  const patch: InstanceInput = {};
  const warnings: string[] = [];
  for (const [field, variable, read] of INSTANCE_FROM_ENV) {
    const value = read().trim();
    if (!value || (stored[field] ?? '').trim()) continue;
    const parsed = instanceSchema.shape[field].safeParse(value);
    if (parsed.success && parsed.data && guardable(field, parsed.data)) {
      patch[field] = parsed.data;
    } else {
      warnings.push(`El valor de ${variable} del entorno del panel no es válido y no se ha guardado.`);
    }
  }
  return { patch, warnings };
}

type DnsVerdict = 'ok' | 'missing' | 'mismatch' | 'unknown';

function hostOfUrl(url: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function registerSetupRoutes(app: FastifyInstance): void {
  /**
   * Estado del asistente: la web decide qué paso mostrar. Con la puesta en
   * marcha terminada, quien no es administrador (la pantalla de inicio de
   * sesión, el portal del titular, cualquiera en Internet) solo recibe lo
   * que esas pantallas usan: ni la IP pública ni los nombres internos.
   */
  app.get('/api/setup/status', async (req) => {
    const setupComplete = isSetupComplete();
    if (setupComplete && req.user?.role !== 'admin') {
      return {
        setupComplete,
        hasAdmin: countUsers() > 0,
        requiresSetupToken: Boolean(config.setupToken),
        instance: { brandName: getInstanceSettings().brandName },
        // Con sesión, el cliente sabe si la instancia es de demostración: la
        // ficha del dominio le ofrece entonces simular la propiedad.
        ...(req.user ? { demoMode: config.demoMode } : {}),
      };
    }
    const fromEnv = engineFromEnv();
    return {
      setupComplete,
      hasAdmin: countUsers() > 0,
      engineConfigured: engineConfigured(),
      // Qué motor quedó conectado (el asistente exige el nombre del servidor
      // solo con Stalwart) y si la identidad ya se guardó: al recargar en la
      // comprobación final no se vuelve al paso de la identidad.
      engineKind: getEngineSettings()?.kind ?? null,
      instanceSaved: getJsonSetting('instance') !== null,
      demoMode: config.demoMode,
      // El instalador fija un token para que el primer visitante de un panel
      // recién publicado no pueda quedarse con la instancia.
      requiresSetupToken: Boolean(config.setupToken),
      // Hay motor en el entorno: la web ofrece conectarlo con un clic. La
      // contraseña se queda en el servidor; aquí solo viaja si existe.
      engineFromEnv: Boolean(fromEnv),
      engineDefaults: {
        url: config.engineDefaults.url,
        adminUser: config.engineDefaults.adminUser,
        hasPassword: Boolean(config.engineDefaults.adminPassword),
        smtpHost: config.engineDefaults.smtpHost,
        smtpPort: config.engineDefaults.smtpPort,
      },
      instance: getInstanceSettings(),
    };
  });

  /** Paso 1: crear la cuenta de administrador (solo si no existe ninguna). */
  app.post('/api/setup/admin', async (req, reply) => {
    if (countUsers() > 0) {
      throw forbidden('Ya existe un administrador. Inicia sesión con esa cuenta.', 'admin_exists');
    }
    const body = adminSchema.parse(req.body);
    if (config.setupToken) {
      const ip = req.ip || '';
      if (setupFailures(ip) >= SETUP_MAX_FAILURES) {
        throw tooMany('Se han producido demasiados intentos con un token incorrecto. Espera 15 minutos antes de volver a intentarlo.');
      }
      if (!sameSecret(body.setupToken ?? '', config.setupToken)) {
        db.prepare('INSERT INTO login_attempts (ip, attempted_at) VALUES (?, ?)').run(`setup:${ip}`, now());
        throw forbidden(
          'El token de puesta en marcha no es correcto. Lo muestra el instalador al terminar y está en la variable MAILWAY_SETUP_TOKEN del panel.',
          'setup_token_invalid',
        );
      }
    }
    // Comprobación y alta en una sola transacción: dos peticiones simultáneas
    // no pueden crear dos administradores (la de arriba solo ahorra trabajo).
    const user = createFirstAdmin({ email: body.email, name: body.name, password: body.password });
    createSession(req, reply, user.id);
    req.user = user;
    audit(req, 'setup.admin_created', { email: user.email });
    return { user };
  });

  /**
   * Paso 2: conectar el motor de correo (o elegir modo demostración). Con
   * `{ useEnvDefaults: true }` se usa el motor del entorno sin que su
   * contraseña salga nunca del servidor.
   */
  app.post('/api/setup/engine', async (req) => {
    // Con sesión del panel: conectar un motor manda credenciales a una URL.
    requireAdminSession(req);
    let settings: EngineSettings;
    let fromEnv = false;
    if (engineFromEnvSchema.safeParse(req.body).success) {
      const env = engineFromEnv();
      if (!env) {
        throw badRequest(
          'El servidor no tiene un motor definido en su entorno (STALWART_URL y STALWART_ADMIN_PASSWORD). Indica los datos a mano.',
          'engine_env_missing',
        );
      }
      settings = env;
      fromEnv = true;
    } else {
      settings = engineSchema.parse(req.body);
    }

    const recommended = await connectEngine(settings);
    audit(req, 'setup.engine_configured', {
      kind: settings.kind,
      url: settings.url,
      fromEnv,
      recommendedApplied: recommended?.applied ?? false,
    });
    return { ok: true, fromEnv, recommended };
  });

  /** Paso 3: identidad del servidor (hostname, IP, webmail, marca). */
  app.post('/api/setup/instance', async (req) => {
    requireAdmin(req);
    const body = instanceSchema.parse(req.body);
    const { instance, recommended } = await saveInstanceIdentity(body);
    // Los hosts de autoconfiguración dependen del nombre y la IP del servidor.
    void refreshAutoconfigHosts().catch(() => undefined);
    audit(req, 'setup.instance_configured', { recommendedApplied: recommended?.applied ?? false });
    return { instance, recommended };
  });

  app.post('/api/setup/complete', async (req) => {
    requireAdmin(req);
    markSetupComplete();
    audit(req, 'setup.completed', {});
    return { ok: true };
  });

  /** Autodetección de la IP pública del servidor. */
  app.get('/api/setup/detect-ip', async (req) => {
    requireAdmin(req);
    return { ip: await detectarIpPublica() };
  });

  /**
   * DNS de la plataforma: los nombres del servidor de correo, del panel y del
   * webmail deben apuntar a la IP del servidor, y el PTR de la IP al servidor
   * de correo. Lo usa el resumen final de la puesta en marcha.
   */
  app.get('/api/setup/platform-dns', async (req) => {
    requireAdmin(req);
    const instance = getInstanceSettings();
    const ip = instance.publicIp.trim();
    const mail = instance.mailHostname.trim().toLowerCase();
    const names: { role: 'mail' | 'panel' | 'webmail'; host: string | null }[] = [
      { role: 'mail', host: mail || null },
      { role: 'panel', host: hostOfUrl(instance.panelUrl) },
      { role: 'webmail', host: hostOfUrl(instance.webmailUrl) },
    ];
    const records = await Promise.all(
      names
        .filter((n): n is { role: 'mail' | 'panel' | 'webmail'; host: string } => Boolean(n.host))
        .map(async ({ role, host }) => {
          const found = await lookupA(host);
          let status: DnsVerdict;
          if (found === null) status = 'unknown';
          else if (found.length === 0) status = 'missing';
          else if (ip && !found.includes(ip)) status = 'mismatch';
          else status = ip ? 'ok' : 'unknown';
          return { role, host, expected: ip || null, found, status };
        }),
    );

    let ptr: { ip: string; expected: string; found: string[] | null; status: DnsVerdict } | null = null;
    if (ip && mail) {
      const found = await lookupPtr(ip);
      const normalized = found?.map((h) => h.toLowerCase().replace(/\.$/, '')) ?? null;
      ptr = {
        ip,
        expected: mail,
        found,
        status:
          normalized === null ? 'unknown' : normalized.length === 0 ? 'missing' : normalized.includes(mail) ? 'ok' : 'mismatch',
      };
    }
    return { publicIp: ip || null, records, ptr };
  });

  /* ------------------------ Ajustes tras el asistente ---------------------- */

  app.get('/api/settings', async (req) => {
    requireAdmin(req);
    const engine = getEngineSettings();
    return {
      instance: getInstanceSettings(),
      engine: engine
        ? {
            kind: engine.kind,
            url: engine.url,
            adminUser: engine.adminUser,
            hasPassword: Boolean(engine.adminPassword),
            smtpHost: engine.smtpHost,
            smtpPort: engine.smtpPort,
            smtpSecure: engine.smtpSecure,
          }
        : null,
      demoMode: config.demoMode,
    };
  });

  app.put('/api/settings/instance', async (req) => {
    requireAdmin(req);
    const body = instanceSchema.parse(req.body);
    exigirNombreDelServidor(body);
    const instance = setInstanceSettings(body);
    // Un cambio de nombre o de IP cambia qué hosts de autoconfiguración se
    // pueden publicar: se recalcula ya, sin esperar a la vuelta del vigilante.
    void refreshAutoconfigHosts().catch(() => undefined);
    audit(req, 'settings.instance_updated', {});
    return { instance };
  });

  /*
   * Cambiar o probar el motor exige la sesión del panel (no un token de
   * gestión) y, si cambia el destino, la contraseña: si no, un token filtrado
   * bastaba para que el panel enviara la contraseña guardada del motor, por
   * Basic, a una URL cualquiera.
   */
  app.put('/api/settings/engine', async (req) => {
    requireAdminSession(req);
    const body = withStoredPassword(engineSchema.parse(req.body));
    if (body.kind === 'stalwart') {
      if (!body.url) throw badRequest('Indica la URL de la API de gestión de Stalwart.', 'engine_url_required');
      const result = await testEngine(body);
      if (!result.ok) {
        throw badRequest(
          `No se pudo conectar con el motor: ${result.detail || 'sin detalle'}.`,
          'engine_test_failed',
        );
      }
    }
    setEngineSettings(body);
    audit(req, 'settings.engine_updated', { kind: body.kind, url: body.url, smtpHost: body.smtpHost });
    return { ok: true };
  });

  app.post('/api/settings/engine/test', async (req) => {
    requireAdminSession(req);
    const body = withStoredPassword(engineSchema.parse(req.body));
    if (body.kind === 'stalwart' && !body.url) {
      throw badRequest('Indica la URL de la API de gestión de Stalwart.', 'engine_url_required');
    }
    return await testEngine(body);
  });
}
