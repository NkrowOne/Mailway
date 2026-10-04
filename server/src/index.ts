import { buildApp } from './app';
import { config } from './config';
import { retirarDelMotorDominiosSinPropiedad } from './modules/domains';
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

  // En segundo plano: si el motor aún no responde, lo reintenta el vigilante.
  void retirarDelMotorDominiosSinPropiedad()
    .then((r) => {
      if (r && r.retirados.length > 0) {
        app.log.warn(
          `Retirados del motor ${r.retirados.length} dominio(s) sin propiedad comprobada que versiones anteriores crearon al darlos de alta: ${r.retirados.join(', ')}`,
        );
      }
    })
    .catch((err) => app.log.warn(`No se han podido revisar los dominios sin propiedad del motor: ${(err as Error).message}`));

  startWatchdog({ warn: (msg) => app.log.warn(msg) });
}

main().catch((err) => {
  console.error('Mailway no pudo arrancar:', err);
  process.exit(1);
});
