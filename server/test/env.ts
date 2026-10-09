/**
 * Aísla las pruebas de la base de datos de desarrollo.
 *
 * No sirve poner esto al principio de cada test: los `import` se elevan por
 * encima de cualquier sentencia del módulo, así que `core/db` ya se habría
 * cargado (creando la BD en el directorio por defecto) antes de ejecutarse.
 * Node carga los módulos de `--import` ANTES que el módulo principal, que es
 * el único punto donde la variable llega a tiempo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Carpeta propia por proceso: node --test ejecuta cada fichero en un proceso
// aparte y en paralelo; compartir una sola base SQLite los hacía interferir.
process.env.MAILWAY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mailway-test-'));
// Las pruebas nunca consultan el DNS real ni hacen peticiones HTTPS reales.
process.env.MAILWAY_DNS_OFFLINE = '1';
process.env.MAILWAY_DEMO = '1';
process.env.MAILWAY_WATCHDOG_DISABLED = '1';
// El webmail automático de cada dominio crea registros y llama a Cloudflare
// por su cuenta: las pruebas que lo necesitan lo activan (config.webmailAutomatico).
process.env.MAILWAY_WEBMAIL_AUTOMATICO = '0';
