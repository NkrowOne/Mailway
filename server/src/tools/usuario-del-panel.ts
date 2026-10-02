/**
 * Las herramientas de terminal se ejecutan con `docker exec` dentro del
 * contenedor del panel, que por defecto entra como root. El panel, en cambio,
 * corre como el dueño de la carpeta de datos («node» en la imagen): si una
 * herramienta abriera la base de datos como root, los ficheros que SQLite
 * crea a su lado (el diario WAL) podrían quedar a nombre de root y el panel
 * dejaría de poder escribir en su propia base.
 *
 * Importado ANTES que cualquier módulo que abra la base o lea la clave: en
 * CommonJS los `require` se ejecutan en el orden de los `import`, así que al
 * cargar `config` y `core/db` el proceso ya es el dueño de los datos.
 */
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.MAILWAY_DATA_DIR
  ? path.resolve(process.env.MAILWAY_DATA_DIR)
  : path.resolve(process.cwd(), 'data');

if (typeof process.getuid === 'function' && process.getuid() === 0 && process.setuid && process.setgid) {
  let owner: fs.Stats | null = null;
  try {
    owner = fs.statSync(dataDir);
  } catch {
    // Sin carpeta de datos no hay nada que proteger: config.ts la crea.
  }
  if (owner && owner.uid !== 0) {
    // Primero los grupos (requiere seguir siendo root) y después el usuario.
    process.setgroups?.([owner.gid]);
    process.setgid(owner.gid);
    process.setuid(owner.uid);
  }
}

export {};
