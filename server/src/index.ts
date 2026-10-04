import { buildApp } from './app';
import { config } from './config';
import { adoptarEntornoAlArrancar } from './modules/entorno';
import { liberarIdempotenciaInterrumpida } from './modules/transactional';
import { startWatchdog } from './modules/watchdog';

async function main(): Promise<void> {
  const app = await buildApp();
  // Solo aquí, en el proceso del servidor: las herramientas de terminal abren
  // la misma base mientras el servidor envía y no deben tocar sus reservas.
  const interrumpidas = liberarIdempotenciaInterrumpida();
  if (interrumpidas > 0) {
    app.log.warn(
      `${interrumpidas} envío(s) con Idempotency-Key quedaron a medias en el arranque anterior: el reintento con la misma clave volverá a enviarlos.`,
    );
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `Mailway escuchando en http://${config.host}:${config.port} (datos en ${config.dataDir})`,
  );

  // El instalador cambia el entorno (otro dominio, otra IP) y recrea el
  // contenedor: lo que nadie ha tocado en Ajustes pasa a los valores nuevos.
  // Después de escuchar: aplicar los ajustes recomendados habla con el motor.
  void adoptarEntornoAlArrancar({ info: (msg) => app.log.info(msg), warn: (msg) => app.log.warn(msg) });

  startWatchdog({ warn: (msg) => app.log.warn(msg) });
}

main().catch((err) => {
  console.error('Mailway no pudo arrancar:', err);
  process.exit(1);
});
