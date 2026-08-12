import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { badRequest, forbidden } from '../core/errors';
import { buildEngine, engineConfigured } from '../engine';
import type { EngineSettings } from '../engine/types';
import { audit } from './audit';
import { countUsers, createUser, createSession, requireAdmin } from './auth';
import { ensureDefaultPlans } from './clients';
import {
  getEngineSettings,
  getInstanceSettings,
  isSetupComplete,
  markSetupComplete,
  setEngineSettings,
  setInstanceSettings,
} from './settings';

const adminSchema = z.object({
  email: z.string().email('Introduce un correo válido.'),
  name: z.string().trim().min(2, 'Escribe tu nombre.').max(80),
  password: z.string().min(10, 'La contraseña debe tener al menos 10 caracteres.'),
});

const engineSchema = z.object({
  kind: z.enum(['stalwart', 'demo']),
  url: z.string().url('La URL del motor no es válida (ej.: http://mailway-mail:8080).').or(z.literal('')),
  adminUser: z.string().trim().max(60),
  adminPassword: z.string().max(200),
  smtpHost: z.string().trim().max(200),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
});

const instanceSchema = z.object({
  brandName: z.string().trim().min(1).max(60).optional(),
  mailHostname: z.string().trim().max(200).optional(),
  publicIp: z
    .string()
    .trim()
    .regex(/^$|^(\d{1,3}\.){3}\d{1,3}$/, 'La IP debe tener formato IPv4, ej.: 203.0.113.10')
    .optional(),
  webmailUrl: z.string().url().or(z.literal('')).optional(),
  systemFrom: z.string().email().or(z.literal('')).optional(),
});

async function testEngine(settings: EngineSettings): Promise<{ ok: boolean; detail?: string }> {
  const engine = buildEngine(settings);
  const health = await engine.ping();
  return { ok: health.ok, detail: health.detail };
}

export function registerSetupRoutes(app: FastifyInstance): void {
  /** Estado del asistente: la web decide qué paso mostrar. */
  app.get('/api/setup/status', async () => {
    return {
      setupComplete: isSetupComplete(),
      hasAdmin: countUsers() > 0,
      engineConfigured: engineConfigured(),
      demoMode: config.demoMode,
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
      throw forbidden('Ya existe un administrador. Inicia sesión con esa cuenta.');
    }
    const body = adminSchema.parse(req.body);
    const user = createUser({ ...body, role: 'admin' });
    ensureDefaultPlans();
    createSession(req, reply, user.id);
    req.user = user;
    audit(req, 'setup.admin_created', { email: user.email });
    return { user };
  });

  /** Paso 2: conectar el motor de correo (o elegir modo demostración). */
  app.post('/api/setup/engine', async (req) => {
    requireAdmin(req);
    const body = engineSchema.parse(req.body);
    if (body.kind === 'stalwart') {
      if (!body.url) throw badRequest('Indica la URL de la API de gestión de Stalwart.');
      if (!body.adminPassword) throw badRequest('Indica la contraseña del administrador del motor.');
      const result = await testEngine(body);
      if (!result.ok) {
        throw badRequest(
          `No se pudo conectar con el motor: ${result.detail || 'sin detalle'}. Revisa URL y credenciales.`,
          'engine_test_failed',
        );
      }
    }
    setEngineSettings(body);
    audit(req, 'setup.engine_configured', { kind: body.kind, url: body.url });
    return { ok: true };
  });

  /** Paso 3: identidad del servidor (hostname, IP, webmail, marca). */
  app.post('/api/setup/instance', async (req) => {
    requireAdmin(req);
    const body = instanceSchema.parse(req.body);
    const instance = setInstanceSettings(body);
    audit(req, 'setup.instance_configured', {});
    return { instance };
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
    try {
      const res = await fetch('https://api.ipify.org?format=json', {
        signal: AbortSignal.timeout(6000),
      });
      const data = (await res.json()) as { ip?: string };
      return { ip: data.ip || '' };
    } catch {
      return { ip: '' };
    }
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

  app.put('/api/settings/engine', async (req) => {
    requireAdmin(req);
    const body = engineSchema.parse(req.body);
    if (body.kind === 'stalwart') {
      // Si no se envía contraseña nueva, se conserva la actual.
      if (!body.adminPassword) {
        const current = getEngineSettings();
        if (current?.adminPassword) body.adminPassword = current.adminPassword;
      }
      const result = await testEngine(body);
      if (!result.ok) {
        throw badRequest(
          `No se pudo conectar con el motor: ${result.detail || 'sin detalle'}.`,
          'engine_test_failed',
        );
      }
    }
    setEngineSettings(body);
    audit(req, 'settings.engine_updated', { kind: body.kind });
    return { ok: true };
  });

  app.post('/api/settings/engine/test', async (req) => {
    requireAdmin(req);
    const body = engineSchema.parse(req.body);
    if (body.kind === 'stalwart' && !body.adminPassword) {
      const current = getEngineSettings();
      if (current?.adminPassword) body.adminPassword = current.adminPassword;
    }
    return await testEngine(body);
  });
}
