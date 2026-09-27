import type { FastifyInstance } from 'fastify';

/**
 * Operaciones sobre el servidor de correo: ajustes recomendados del motor
 * (nombre del servidor, confianza en el proxy, rangos exentos de baneo),
 * estado y emisión del certificado TLS. Pendiente de implementar.
 */
export function registerEngineOpsRoutes(_app: FastifyInstance): void {}

/** Comprueba el certificado TLS del motor y avisa si caduca. La llama el vigilante a diario. */
export async function checkEngineTls(): Promise<void> {}
