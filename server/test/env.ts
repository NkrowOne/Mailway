/**
 * Aísla las pruebas de la base de datos de desarrollo.
 *
 * No sirve poner esto al principio de cada test: los `import` se elevan por
 * encima de cualquier sentencia del módulo, así que `core/db` ya se habría
 * cargado (creando la BD en el directorio por defecto) antes de ejecutarse.
 * Node carga los módulos de `--import` ANTES que el módulo principal, que es
 * el único punto donde la variable llega a tiempo.
 */
process.env.MAILWAY_DATA_DIR = process.env.MAILWAY_DATA_DIR || '/tmp/mailway-test-data';
process.env.MAILWAY_DEMO = '1';
process.env.MAILWAY_WATCHDOG_DISABLED = '1';
