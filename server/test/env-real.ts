/**
 * Preparación de la prueba del panel contra un motor de correo de verdad
 * (panel-motor-real.test.ts). Se carga DESPUÉS de env.ts, que fuerza el motor
 * de demostración, y solo cambia algo si hay un motor real indicado:
 *
 *   node --test --import tsx --import ./test/env.ts --import ./test/env-real.ts \
 *     test/panel-motor-real.test.ts
 *
 * Como env.ts, tiene que ir en un --import: `config` lee el entorno al
 * cargarse, antes que cualquier sentencia del fichero de prueba.
 */
if (process.env.MAILWAY_TEST_MOTOR_URL && process.env.MAILWAY_TEST_MOTOR_PASSWORD) {
  // El panel habla con el motor indicado (lo configura la propia prueba).
  delete process.env.MAILWAY_DEMO;
  // El motor de prueba presenta su certificado autofirmado: sin esto, /v1/send
  // no podría entregar por su puerto de envío.
  process.env.MAILWAY_SMTP_ALLOW_SELF_SIGNED = '1';
  // Las conexiones de la prueba llegan al motor desde la red de Docker (el
  // proxy de los puertos publicados) o desde el propio anfitrión. Los
  // ajustes recomendados las eximen del bloqueo automático: la prueba se
  // equivoca de contraseña a propósito y, si no, el motor acabaría
  // bloqueando su IP.
  process.env.MAILWAY_ENGINE_TRUSTED_NETWORK = '172.16.0.0/12,127.0.0.0/8';
}
