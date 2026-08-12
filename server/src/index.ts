import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
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
import { startWatchdog } from './modules/watchdog';

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
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
    req.log.error({ err }, 'Error no controlado');
    reply.status(500).send({
      error: 'Error interno del servidor. Revisa los logs de Mailway.',
      code: 'internal',
    });
  });

  app.get('/api/health', async () => ({ ok: true, name: 'mailway', version: '0.1.0' }));

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

  // Producción: sirve la web compilada (SPA) desde el mismo proceso.
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/v1/')) {
        reply.status(404).send({ error: 'Ruta no encontrada.', code: 'not_found' });
        return;
      }
      reply.type('text/html').send(fs.readFileSync(path.join(webDist, 'index.html')));
    });
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `Mailway escuchando en http://${config.host}:${config.port} (datos en ${config.dataDir})`,
  );

  startWatchdog({ warn: (msg) => app.log.warn(msg) });
}

main().catch((err) => {
  console.error('Mailway no pudo arrancar:', err);
  process.exit(1);
});
