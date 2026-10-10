import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../core/db';
import { notFound } from '../core/errors';
import { audit } from './audit';
import { requireAuth, requireClientAccess } from './auth';
import { getDomain, marcarPropiedadComprobada } from './domains';
import { getJsonSetting, setJsonSetting } from './settings';

/**
 * Modo demostración (MAILWAY_DEMO=1): sirve para recorrer el panel sin
 * servidor de correo, pero la propiedad de un dominio solo se comprueba con
 * un MX o un TXT reales, así que en la demostración nadie podía crear un
 * buzón. Aquí se puede simular, con tres límites:
 *
 * - Solo con la variable de entorno, nunca con el motor «demo» elegido en el
 *   asistente: esa instancia puede pasar después a Stalwart sin reiniciarse.
 * - Con acceso al cliente del dominio, como cualquier otra acción sobre él.
 * - Lo simulado se anota y se deshace al arrancar sin MAILWAY_DEMO: un motor
 *   real nunca hereda un dominio ajeno (gmail.com) dado por comprobado.
 */

const CLAVE = 'demo_propiedad_simulada';

const paramsSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * Deshace las propiedades simuladas si la instancia ya no está en
 * demostración. Lo llama el arranque del servidor; devuelve cuántos dominios
 * vuelven a quedar pendientes de comprobar.
 */
export function revertirPropiedadSimulada(): number {
  if (config.demoMode) return 0;
  const ids = getJsonSetting<string[]>(CLAVE) ?? [];
  if (ids.length === 0) return 0;
  return db.transaction(() => {
    const quitar = db.prepare('UPDATE domains SET owner_verified_at = NULL WHERE id = ?');
    let n = 0;
    for (const id of ids) n += quitar.run(id).changes;
    setJsonSetting(CLAVE, []);
    return n;
  })();
}

export function registerDemoRoutes(app: FastifyInstance): void {
  /** Da por comprobada la propiedad de un dominio (solo en demostración). */
  app.post('/api/demo/domains/:id/ownership', async (req) => {
    requireAuth(req);
    if (!config.demoMode) {
      throw notFound('Esta acción solo existe en el modo demostración.', 'demo_only');
    }
    const { id } = paramsSchema.parse(req.params);
    const domain = getDomain(id);
    requireClientAccess(req, domain.clientId);
    // Ya comprobada de verdad: no se anota, o el arranque sin demostración
    // la borraría.
    if (domain.ownershipVerifiedAt !== null) return { domain };
    db.transaction(() => {
      marcarPropiedadComprobada(id);
      const ids = new Set(getJsonSetting<string[]>(CLAVE) ?? []);
      ids.add(id);
      setJsonSetting(CLAVE, [...ids]);
    })();
    audit(req, 'domain.ownership_simulated', { domain: domain.domain }, domain.clientId);
    return { domain: getDomain(id) };
  });
}
