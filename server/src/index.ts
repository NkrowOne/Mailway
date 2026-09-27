import { buildApp } from './app';
import { config } from './config';
import { startWatchdog } from './modules/watchdog';

async function main(): Promise<void> {
  const app = await buildApp();

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
