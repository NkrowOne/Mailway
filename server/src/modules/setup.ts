import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { lookupA, lookupPtr } from '../core/dns';
import { db, now } from '../core/db';
import { badRequest, forbidden, tooMany } from '../core/errors';
import { buildEngine, engineConfigured } from '../engine';
import type { EngineSettings } from '../engine/types';
import { audit } from './audit';
import { countUsers, createUser, createSession, requireAdmin, requireAdminSession } from './auth';
import { ensureDefaultPlans } from './clients';
import { applyRecommendedEngineSettings } from './engineops';
import {
  getEngineSettings,
  getInstanceSettings,
  isSetupComplete,
  markSetupComplete,
  setEngineSettings,
  setInstanceSettings,
} from './settings';

const adminSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email('Introduzca un correo válido.'),
  name: z.string().trim().min(2, 'Escriba su nombre.').max(80, 'El nombre no puede superar los 80 caracteres.'),
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

/** Nombre de host DNS (se escribe tal cual en la configuración del motor). */
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;

const instanceSchema = z.object({
  brandName: z.string().trim().min(1).max(60).optional(),
  mailHostname: z
    .string()
    .trim()
    .max(253)
    .refine(
      (value) => value === '' || HOSTNAME_RE.test(value.replace(/\.$/, '')),
      'El nombre del servidor de correo no es válido (ej.: mail.miempresa.com).',
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
      'Para cambiar la URL, el usuario o el servidor SMTP del motor, indique también la contraseña del administrador del motor.',
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
function engineFromEnv(): EngineSettings | null {
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
function scrub(text: string, secret: string): string {
  return secret ? text.split(secret).join('•••') : text;
}

async function testEngine(settings: EngineSettings): Promise<{ ok: boolean; detail?: string }> {
  const engine = buildEngine(settings);
  const health = await engine.ping();
  return { ok: health.ok, detail: health.detail ? scrub(health.detail, settings.adminPassword) : undefined };
}

interface RecommendedOutcome {
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
async function applyRecommendedQuietly(settings: EngineSettings | null): Promise<RecommendedOutcome | null> {
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
      };
    }
    const fromEnv = engineFromEnv();
    return {
      setupComplete,
      hasAdmin: countUsers() > 0,
      engineConfigured: engineConfigured(),
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
      throw forbidden('Ya existe un administrador. Inicie sesión con esa cuenta.', 'admin_exists');
    }
    const body = adminSchema.parse(req.body);
    if (config.setupToken) {
      const ip = req.ip || '';
      if (setupFailures(ip) >= SETUP_MAX_FAILURES) {
        throw tooMany('Se han producido demasiados intentos con un token incorrecto. Espere 15 minutos antes de volver a intentarlo.');
      }
      if (!sameSecret(body.setupToken ?? '', config.setupToken)) {
        db.prepare('INSERT INTO login_attempts (ip, attempted_at) VALUES (?, ?)').run(`setup:${ip}`, now());
        throw forbidden(
          'El token de puesta en marcha no es correcto. Lo muestra el instalador al terminar y está en la variable MAILWAY_SETUP_TOKEN del panel.',
          'setup_token_invalid',
        );
      }
    }
    const user = createUser({ email: body.email, name: body.name, password: body.password, role: 'admin' });
    ensureDefaultPlans();
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
          'El servidor no tiene un motor definido en su entorno (STALWART_URL y STALWART_ADMIN_PASSWORD). Indique los datos a mano.',
          'engine_env_missing',
        );
      }
      settings = env;
      fromEnv = true;
    } else {
      settings = engineSchema.parse(req.body);
    }

    if (settings.kind === 'stalwart') {
      if (!settings.url) throw badRequest('Indique la URL de la API de gestión de Stalwart.');
      if (!settings.adminPassword) throw badRequest('Indique la contraseña del administrador del motor.');
      const result = await testEngine(settings);
      if (!result.ok) {
        throw badRequest(
          `No se pudo conectar con el motor: ${result.detail || 'sin detalle'}. Revise la URL y las credenciales.`,
          'engine_test_failed',
        );
      }
    }
    setEngineSettings(settings);
    const recommended = await applyRecommendedQuietly(settings);
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
    const instance = setInstanceSettings(body);
    // Con el nombre del servidor ya conocido, el motor lo recibe aquí mismo:
    // sin él, Stalwart anuncia el identificador del contenedor en su DNS.
    const recommended = await applyRecommendedQuietly(getEngineSettings());
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
    // Dos servicios independientes: si uno falla o está bloqueado, el otro.
    const sources = [
      async () => {
        const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(6000) });
        return ((await res.json()) as { ip?: string }).ip || '';
      },
      async () => {
        const res = await fetch('https://ipv4.icanhazip.com', { signal: AbortSignal.timeout(6000) });
        return (await res.text()).trim();
      },
    ];
    for (const source of sources) {
      try {
        const ip = await source();
        if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return { ip };
      } catch {
        // Se prueba el siguiente.
      }
    }
    return { ip: '' };
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
    const instance = setInstanceSettings(body);
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
      if (!body.url) throw badRequest('Indique la URL de la API de gestión de Stalwart.', 'engine_url_required');
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
      throw badRequest('Indique la URL de la API de gestión de Stalwart.', 'engine_url_required');
    }
    return await testEngine(body);
  });
}
