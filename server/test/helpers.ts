import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { db } from '../src/core/db';
import { getEngine } from '../src/engine';
import { DemoEngine } from '../src/engine/demo';
import type { CambioDominioVista } from '../src/modules/domainmigrations';

/**
 * Utilidades comunes para probar las rutas reales con `app.inject()`.
 *
 * Cada fichero de prueba corre en su propio proceso con su propia base de
 * datos (ver env.ts), en modo demostración (motor sin servidor real) y sin
 * red (el DNS devuelve «no se pudo consultar»).
 */

export interface TestContext {
  app: FastifyInstance;
  /** Cabecera Cookie de la sesión del administrador. */
  adminCookie: string;
}

let appPromise: Promise<FastifyInstance> | null = null;

/** Una sola app por proceso: construirla es caro y las rutas no guardan estado. */
export function getTestApp(): Promise<FastifyInstance> {
  if (!appPromise) appPromise = buildApp({ logger: false, serveWeb: false });
  return appPromise;
}

/** Extrae «nombre=valor» de las cabeceras set-cookie de una respuesta. */
export function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return list.map((c) => String(c).split(';')[0]).join('; ');
}

/**
 * Crea el administrador de la instancia (si no existe) y devuelve su cookie.
 * Si ya existe, inicia sesión con las mismas credenciales.
 */
export async function setupAdmin(
  app: FastifyInstance,
  creds = { email: 'admin@mailway.test', name: 'Administración', password: 'clave-admin-segura' },
): Promise<string> {
  const exists = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c > 0;
  const res = exists
    ? await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: creds.email, password: creds.password },
      })
    : await app.inject({ method: 'POST', url: '/api/setup/admin', payload: creds });
  if (res.statusCode !== 200) {
    throw new Error(`No se pudo preparar el administrador: ${res.statusCode} ${res.body}`);
  }
  return cookieFrom(res);
}

/** App lista con administrador y sesión. */
export async function adminContext(): Promise<TestContext> {
  const app = await getTestApp();
  const adminCookie = await setupAdmin(app);
  return { app, adminCookie };
}

let seq = 0;

/**
 * Crea un cliente (con el primer plan disponible) y, opcionalmente, un
 * usuario de panel para él. Devuelve ids y la cookie del usuario de cliente.
 */
export async function createClient(
  ctx: TestContext,
  opts: { name?: string; withUser?: boolean } = {},
): Promise<{ clientId: string; planId: string; userCookie: string | null; userEmail: string | null }> {
  seq += 1;
  const plans = await ctx.app.inject({
    method: 'GET',
    url: '/api/plans',
    headers: { cookie: ctx.adminCookie },
  });
  const planId = (plans.json() as { plans: { id: string }[] }).plans[0]!.id;
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/clients',
    headers: { cookie: ctx.adminCookie },
    payload: { name: opts.name || `Cliente ${seq}`, planId },
  });
  if (res.statusCode !== 200) throw new Error(`No se pudo crear el cliente: ${res.body}`);
  const clientId = (res.json() as { client: { id: string } }).client.id;

  if (!opts.withUser) return { clientId, planId, userCookie: null, userEmail: null };

  const email = `usuario${seq}-${Date.now()}@cliente.test`;
  const password = 'clave-cliente-segura';
  const userRes = await ctx.app.inject({
    method: 'POST',
    url: `/api/clients/${clientId}/users`,
    headers: { cookie: ctx.adminCookie },
    payload: { email, name: `Usuario ${seq}`, password },
  });
  if (userRes.statusCode !== 200) throw new Error(`No se pudo crear el usuario: ${userRes.body}`);
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  if (login.statusCode !== 200) throw new Error(`No se pudo iniciar sesión: ${login.body}`);
  return { clientId, planId, userCookie: cookieFrom(login), userEmail: email };
}

/**
 * Da de alta un dominio del cliente (en modo demostración no toca ningún
 * motor). Sin red no se puede demostrar la propiedad por DNS, así que, salvo
 * que se pida lo contrario, se marca como comprobada directamente en la base:
 * la mayoría de las pruebas necesitan crear buzones y alias en él.
 */
export async function createDomain(
  ctx: TestContext,
  clientId: string,
  domain = `dominio${++seq}.test`,
  opts: { ownershipVerified?: boolean } = {},
): Promise<{ domainId: string; domain: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/domains',
    headers: { cookie: ctx.adminCookie },
    payload: { domain, clientId },
  });
  if (res.statusCode !== 200) throw new Error(`No se pudo crear el dominio: ${res.body}`);
  const domainId = (res.json() as { domain: { id: string } }).domain.id;
  setDomainOwnership(domainId, opts.ownershipVerified ?? true);
  return { domainId, domain };
}

/** Fija (o retira) la propiedad comprobada de un dominio directamente en la base. */
export function setDomainOwnership(domainId: string, verified: boolean): void {
  db.prepare('UPDATE domains SET owner_verified_at = ? WHERE id = ?').run(verified ? Date.now() : null, domainId);
}

/** Crea un buzón y devuelve su id, dirección y contraseña generada. */
export async function createMailbox(
  ctx: TestContext,
  domainId: string,
  localPart = `buzon${++seq}`,
): Promise<{ mailboxId: string; email: string; password: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/mailboxes',
    headers: { cookie: ctx.adminCookie },
    payload: { domainId, localPart },
  });
  if (res.statusCode !== 200) throw new Error(`No se pudo crear el buzón: ${res.body}`);
  const body = res.json() as { mailbox: { id: string; email: string }; password: string };
  return { mailboxId: body.mailbox.id, email: body.mailbox.email, password: body.password };
}

/* ----------------------------- Cambio de dominio ---------------------------- */

/** El motor de demostración de las pruebas, con sus ganchos (entregar, fallarProxima…). */
export function motorDemo(): DemoEngine {
  const engine = getEngine();
  if (!(engine instanceof DemoEngine)) throw new Error('Las pruebas esperan el motor de demostración.');
  return engine;
}

/**
 * Da por bueno el DNS de un dominio (estado «active») y su propiedad, como si
 * la medición los hubiera comprobado. Sin red, las mediciones siguientes no
 * lo degradan: «no se pudo consultar» conserva el estado anterior.
 */
export function marcarDnsActivo(domainId: string): void {
  const t = Date.now();
  db.prepare(
    `UPDATE domains SET status = 'active', owner_verified_at = COALESCE(owner_verified_at, ?),
       verified_at = COALESCE(verified_at, ?)
     WHERE id = ?`,
  ).run(t, t, domainId);
}

/**
 * Crea un cambio de dominio por la ruta real. Por defecto con la sesión del
 * administrador y sin DNS automático; `headers` permite usar un token o la
 * sesión de un usuario del cliente.
 */
export async function crearCambioDeDominio(
  ctx: TestContext,
  fromDomainId: string,
  toDomain: string,
  opts: { headers?: Record<string, string>; query?: string; payload?: Record<string, unknown> } = {},
): Promise<{ statusCode: number; vista: CambioDominioVista; body: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/domain-migrations${opts.query ? `?${opts.query}` : ''}`,
    headers: opts.headers ?? { cookie: ctx.adminCookie },
    payload: { fromDomainId, toDomain, autoDns: false, ...opts.payload },
  });
  return { statusCode: res.statusCode, vista: res.json() as CambioDominioVista, body: res.body };
}
