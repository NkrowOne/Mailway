import { buildApp } from './app';
import { config } from './config';
import { applyAdminFromEnv } from './modules/adminenv';
import { capturarSiProcede } from './modules/credenciales';
import { iniciarReparacionSuspensiones } from './modules/suspensiones';
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

  // Sin esperarla: corrige una vez en el motor lo que dejó la forma anterior
  // de suspender (buzones que devolvían su correo y alias sin sus destinos).
  // Si el motor aún no responde (arrancan a la vez), la reintenta el vigilante.
  iniciarReparacionSuspensiones({ info: (msg) => app.log.info(msg), warn: (msg) => app.log.warn(msg) });
  startWatchdog({ warn: (msg) => app.log.warn(msg) });

  // Con Stalwart 0.15, copia en segundo plano el hash de los buzones que aún
  // no lo tienen en el panel: 0.16 ya no los da, y la copia tiene que estar
  // completa antes de migrar. No retrasa el arranque ni lo hace fallar.
  void capturarSiProcede()
    .then((resultado) => {
      if (resultado && resultado.capturados > 0) {
        app.log.info(`Copia local de contraseñas: ${resultado.capturados} buzón(es) copiados de Stalwart 0.15.`);
      }
      if (resultado && resultado.fallidos.length > 0) {
        app.log.warn(
          `Copia local de contraseñas: ${resultado.fallidos.length} buzón(es) sin copiar (${resultado.fallidos.slice(0, 5).join(', ')}${resultado.fallidos.length > 5 ? '…' : ''}).`,
        );
      }
    })
    .catch((err: unknown) => app.log.warn(`Copia local de contraseñas: ${(err as Error).message}`));
}

main().catch((err) => {
  console.error('Mailway no pudo arrancar:', err);
  process.exit(1);
});
