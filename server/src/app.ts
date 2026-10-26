import path from 'node:path';
import fs from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config';
import { HttpError, badRequest, isUniqueViolation } from './core/errors';
import { superaTopeElementos } from './core/elementos';
import { sessionHook } from './modules/auth';
import { registerAuthRoutes } from './modules/auth';
import { registerAuditRoutes } from './modules/audit';
import { registerClientRoutes } from './modules/clients';
import { registerDashboardRoutes } from './modules/dashboard';
import { registerDeliverabilityRoutes } from './modules/deliverability';
import { registerDomainRoutes } from './modules/domains';
import { registerDomainMigrationRoutes } from './modules/domainmigrations';
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
import { registerLlavesRoutes } from './modules/llaves';
import { registerAppPasswordRoutes } from './modules/apppasswords';
import { registerProfileRoutes } from './modules/perfil';
import { registerInviteRoutes } from './modules/invitaciones';
import { registerPasswordResetRoutes } from './modules/restablecimientos';
import { registerEngineOpsRoutes } from './modules/engineops';
import { registerFormRoutes } from './modules/forms';
import { registerSetupEmailRoutes } from './modules/envioconfiguracion';
import { registerCorreoWebRoutes } from './modules/correoweb';
import { registerDemoRoutes } from './modules/demo';
import { registerNombreServidorRoutes } from './modules/nombreservidor';
import { registerIpServidorRoutes } from './modules/ipservidor';

const MUTANTES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Protección CSRF para las peticiones que viajan con cookie. SameSite=Lax no
 * basta cuando otra web del MISMO sitio (un subdominio de una app desplegada
 * en el mismo servidor, p. ej.) envía un formulario: el navegador adjunta la
 * cookie. Se rechaza cualquier petición mutante que el navegador marque como
 * de otro origen. Las que llevan Authorization (tokens, claves) no usan
 * cookies; las rutas públicas y la del webmail tampoco.
 */
function csrfGuard(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (!MUTANTES.has(req.method) || !req.url.startsWith('/api/')) return done();
  if (req.headers.authorization) return done();
  if (req.url.startsWith('/api/public/') || req.url.startsWith('/api/webmail/')) return done();
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') {
    if (site === 'same-origin' || site === 'none') return done();
  } else {
    // Navegadores sin Sec-Fetch-Site: se compara el Origin con el host pedido.
    const origin = req.headers.origin;
    if (!origin) return done();
    try {
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0]!.trim();
      if (new URL(origin).host === host) return done();
    } catch {
      // Origin mal formado: se rechaza abajo.
    }
  }
  reply.status(403).send({
    error: 'Se ha rechazado la petición porque no procede de este panel.',
    code: 'cross_site_request',
  });
}

/**
 * Un DELETE u OPTIONS sin Content-Length ni Transfer-Encoding no lleva cuerpo
 * (HTTP/1.1), aunque traiga Content-Type. Fastify 4 no intentaba leerlo;
 * Fastify 5 sí, y con `Content-Type: application/json` responde 400 por
 * cuerpo vacío (o 415 si es un tipo que la API no lee). Hay clientes de la
 * API que mandan esa cabecera en todas sus peticiones (un curl copiado de un
 * POST, envoltorios de fetch), y detrás de Traefik un DELETE sin cuerpo llega
 * siempre sin Content-Length: se retira la cabecera para que sigan
 * funcionando como antes. Si hay cuerpo, se lee y se valida igual que siempre.
 */
function ignorarTipoSinCuerpo(req: FastifyRequest, _reply: FastifyReply, done: () => void): void {
  if (
    (req.method === 'DELETE' || req.method === 'OPTIONS') &&
    req.headers['content-type'] !== undefined &&
    req.headers['content-length'] === undefined &&
    req.headers['transfer-encoding'] === undefined
  ) {
    delete req.headers['content-type'];
  }
  done();
}

/**
 * Rechaza los cuerpos con demasiados elementos antes de que los vea zod (ver
 * `core/elementos.ts`): zod 3 recorre una lista entera aunque pase de su
 * `.max()`, y un cuerpo de pocos MB lleno de elementos cuesta cientos de MB
 * de memoria y segundos de CPU. En preValidation, con el cuerpo ya leído y
 * antes de cualquier manejador, también el de `/v1/send`, que comprueba la
 * clave dentro de la ruta.
 */
function limitarElementosCuerpo(req: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void): void {
  if (superaTopeElementos(req.body)) {
    done(badRequest('La petición incluye demasiados elementos.', 'demasiados_elementos'));
    return;
  }
  done();
}

export interface BuildAppOptions {
  /** Registro de Fastify; en las pruebas se desactiva para no ensuciar la salida. */
  logger?: boolean;
  /** Sirve la web compilada si existe. Las pruebas no la necesitan. */
  serveWeb?: boolean;
  /** Carpeta de la web compilada; las pruebas la cambian por una de prueba. */
  webDist?: string;
}

/**
 * Construye la aplicación sin ponerla a escuchar. Separado de `index.ts` para
 * que las pruebas puedan ejercitar las rutas reales con `app.inject()`, sin
 * abrir puertos ni arrancar el vigilante.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false ? false : { level: process.env.LOG_LEVEL || 'info' },
    trustProxy: config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(cookie, { secret: config.secret });
  app.addHook('onRequest', ignorarTipoSinCuerpo);
  app.addHook('onRequest', csrfGuard);
  app.addHook('onRequest', sessionHook);
  // En la raíz y antes de las rutas: así alcanza a todas, también a las de
  // los ámbitos encapsulados (formularios, autoconfiguración, webmail).
  app.addHook('preValidation', limitarElementosCuerpo);

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
    if (isUniqueViolation(err)) {
      // Red de seguridad para las altas simultáneas que ninguna ruta ha
      // traducido: es un conflicto del cliente (lo mismo creado dos veces),
      // no un fallo interno.
      reply.status(409).send({
        error: 'Ese elemento ya existe o se está creando en otra petición simultánea. Actualiza la página y comprueba el resultado.',
        code: 'conflict',
      });
      return;
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      reply.status(429).send({ error: 'Se han realizado demasiadas peticiones. Espera un minuto y vuelve a intentarlo.', code: 'rate_limited' });
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
      error: 'Se ha producido un error interno. Vuelve a intentarlo y, si se repite, revisa los registros de Mailway.',
      code: 'internal',
    });
  });

  app.get('/api/health', async () => ({ ok: true, name: 'mailway', version: config.version }));

  registerSetupRoutes(app);
  registerAuthRoutes(app);
  registerLlavesRoutes(app);
  registerClientRoutes(app);
  registerDomainRoutes(app);
  registerDomainMigrationRoutes(app);
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
  registerProfileRoutes(app);
  registerInviteRoutes(app);
  registerPasswordResetRoutes(app);
  registerEngineOpsRoutes(app);
  registerFormRoutes(app);
  registerSetupEmailRoutes(app);
  registerCorreoWebRoutes(app);
  registerDemoRoutes(app);
  registerNombreServidorRoutes(app);
  registerIpServidorRoutes(app);

  // Producción: sirve la web compilada (SPA) desde el mismo proceso.
  const webDist = options.webDist ?? path.resolve(__dirname, '../../web/dist');
  if (options.serveWeb !== false && fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/v1/') || req.url.startsWith('/forms/')) {
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
