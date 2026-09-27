import type { FastifyInstance } from 'fastify';

/**
 * Autoconfiguración de programas de correo (Thunderbird, Outlook, Apple) y
 * rutas de Traefik para los hosts autoconfig/autodiscover. Pendiente de implementar.
 */
export function registerAutoconfigRoutes(_app: FastifyInstance): void {}

/**
 * Comprueba el DNS de los hosts de autoconfiguración de la instancia y de los
 * dominios de los clientes. La llama el vigilante cada hora.
 */
export async function refreshAutoconfigHosts(): Promise<void> {}
