import path from 'node:path';
import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config';
import { HttpError } from './core/errors';
import { sessionHook } from './modules/auth';
import { registerAuthRoutes } from './modules/auth';
import { registerAuditRoutes } from './modules/audit';
import { registerClientRoutes } from './modules/clients';
import { registerDashboardRoutes } from './modules/dashboard';
import { registerDeliverabilityRoutes } from './modules/deliverability';
import { registerDomainRoutes } from './modules/domains';
import { registerMailboxRoutes } from './modules/mailboxes';
import { registerSetupRoutes } from './modules/setup';
import { registerApiKeyRoutes, registerSendRoutes } from './modules/transactional';
import { registerAlertRoutes } from './modules/alerts';
import { registerWhitelabelRoutes } from './modules/whitelabel';
import { registerTokenRoutes } from './modules/tokens';
import { registerIntegrationRoutes } from './modules/integrations';
import { registerCloudflareRoutes } from './modules/cloudflare';
import { registerAutoconfigRoutes } from './modules/autoconfig';
import { registerPortalRoutes } from './modules/portal';
import { registerAppPasswordRoutes } from './modules/apppasswords';
import { registerEngineOpsRoutes } from './modules/engineops';

export interface BuildAppOptions {
  /** Registro de Fastify; en las pruebas se desactiva para no ensuciar la salida. */
  logger?: boolean;
  /** Sirve la web compilada si existe. Las pruebas no la necesitan. */
  serveWeb?: boolean;
}

/**
 * Construye la aplicación sin ponerla a escuchar. Separado de `index.ts` para
 * que las pruebas puedan ejercitar las rutas reales con `app.inject()`, sin
 * abrir puertos ni arrancar el vigilante.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false ? false : { level: process.env.LOG_LEVEL || 'info' },
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(cookie, { secret: config.secret });
  app.addHook('onRequest', sessionHook);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      reply.status(err.status).send({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof ZodError) {
      const first = err.issues[0];
      reply.status(400).send({
        error: first ? `${first.message}` : 'Datos no válidos.',
        code: 'validation',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      reply.status(429).send({ error: 'Demasiadas peticiones.', code: 'rate_limited' });
      return;
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      // Errores del propio Fastify (cuerpo mal formado, tipo de contenido no
      // admitido…): son del cliente, no un fallo interno.
      reply.status(statusCode).send({ error: 'La petición no es válida.', code: 'bad_request' });
      return;
    }
    req.log.error({ err }, 'Error no controlado');
    reply.status(500).send({
      error: 'Error interno del servidor. Revise los registros de Mailway.',
      code: 'internal',
    });
  });

  app.get('/api/health', async () => ({ ok: true, name: 'mailway', version: config.version }));

  registerSetupRoutes(app);
  registerAuthRoutes(app);
  registerClientRoutes(app);
  registerDomainRoutes(app);
  registerMailboxRoutes(app);
  registerApiKeyRoutes(app);
  registerSendRoutes(app);
  registerDeliverabilityRoutes(app);
  registerDashboardRoutes(app);
  registerAuditRoutes(app);
  registerAlertRoutes(app);
  registerWhitelabelRoutes(app);
  registerTokenRoutes(app);
  registerIntegrationRoutes(app);
  registerCloudflareRoutes(app);
  registerAutoconfigRoutes(app);
  registerPortalRoutes(app);
  registerAppPasswordRoutes(app);
  registerEngineOpsRoutes(app);

  // Producción: sirve la web compilada (SPA) desde el mismo proceso.
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (options.serveWeb !== false && fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/v1/')) {
        reply.status(404).send({ error: 'Ruta no encontrada.', code: 'not_found' });
        return;
      }
      reply.type('text/html').send(fs.readFileSync(path.join(webDist, 'index.html')));
    });
  } else {
    app.setNotFoundHandler((_req, reply) => {
      reply.status(404).send({ error: 'Ruta no encontrada.', code: 'not_found' });
    });
  }

  return app;
}
