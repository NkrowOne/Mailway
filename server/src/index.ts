import { buildApp } from './app';
import { config } from './config';
import { applyAdminFromEnv } from './modules/adminenv';
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

  const admin = applyAdminFromEnv({
    email: process.env.MAILWAY_ADMIN_EMAIL,
    password: process.env.MAILWAY_ADMIN_PASSWORD,
    name: process.env.MAILWAY_ADMIN_NAME,
  });
  if (admin.action === 'none' && admin.warning) app.log.warn(admin.warning);
  else if (admin.action === 'created') app.log.info(`Administrador ${admin.email} creado desde el entorno.`);
  else if (admin.action === 'password_updated') {
    app.log.info(
      `Contraseña de ${admin.email} fijada desde el entorno: mientras exista MAILWAY_ADMIN_PASSWORD, es la de esa cuenta y no se cambia desde el panel.`,
    );
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
