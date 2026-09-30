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

// Cada fichero de pruebas corre en su proceso: no comparte SQLite ni los IDs
// de sus fixtures con otra suite o con una ejecución anterior.
const root = process.env.MAILWAY_DATA_DIR || os.tmpdir();
fs.mkdirSync(root, { recursive: true });
const isolated = fs.mkdtempSync(path.join(root, 'mailway-test-'));
process.env.MAILWAY_DATA_DIR = isolated;
process.on('exit', () => fs.rmSync(isolated, { recursive: true, force: true }));
process.env.MAILWAY_DEMO = '1';
process.env.MAILWAY_WATCHDOG_DISABLED = '1';
