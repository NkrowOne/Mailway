/**
 * Tope de elementos en el cuerpo de las peticiones.
 *
 * zod está fijado en la serie 3 (la 4 es una versión mayor que no se adopta),
 * que tiene el aviso GHSA-mrhx-c7xc-m3w5: `z.array(...)` valida TODOS los
 * elementos aunque la lista supere su `.max()` y crea un error por cada uno
 * que no vale (`z.record`, uno por clave). Un `{"to":[0,0,…]}` de 5 MB
 * ocupaba unos 700 MB de memoria y 4,6 s de CPU antes de responder 400; con
 * los 20 MB de `/v1/send`, casi 3 GB y 24 s. Contar antes los elementos
 * corta eso sin tocar ningún esquema.
 *
 * Ninguna petición legítima se acerca: la mayor que admiten los esquemas es
 * el alta masiva de buzones (100 entradas de 2 campos, unos 300 elementos) y
 * `/v1/send` no pasa de unos 150 (50 + 20 + 20 destinatarios, 30 cabeceras y
 * 5 adjuntos). 20 000 deja un margen de dos órdenes de magnitud y sigue
 * siendo barato de recorrer y de rechazar.
 */
export const TOPE_ELEMENTOS_CUERPO = 20_000;

/**
 * Solo se recorren listas y objetos planos (los que crea `JSON.parse`). Las
 * rutas que leen el cuerpo como texto o como Buffer (formularios,
 * autoconfiguración, el webmail) no se ven afectadas, y un Buffer nunca se
 * itera: contaría cada byte.
 */
function esRecorrible(valor: unknown): valor is object {
  if (Array.isArray(valor)) return true;
  if (valor === null || typeof valor !== 'object') return false;
  const prototipo: unknown = Object.getPrototypeOf(valor);
  return prototipo === Object.prototype || prototipo === null;
}

/**
 * ¿Tiene el cuerpo más de `tope` elementos, sumando los de todas sus listas y
 * las claves de todos sus objetos? Recorre con una pila propia, no con
 * recursión, para que un anidamiento profundo no desborde la pila de
 * llamadas, y para en cuanto pasa del tope: el trabajo nunca supera `tope`
 * elementos, por grande que sea el cuerpo.
 */
export function superaTopeElementos(cuerpo: unknown, tope = TOPE_ELEMENTOS_CUERPO): boolean {
  if (!esRecorrible(cuerpo)) return false;
  const pendientes: object[] = [cuerpo];
  let total = 0;
  while (pendientes.length > 0) {
    const actual = pendientes.pop()!;
    // Se suma el tamaño antes de mirar los hijos: una lista enorme se rechaza
    // sin llegar a recorrerla.
    if (Array.isArray(actual)) {
      total += actual.length;
      if (total > tope) return true;
      for (let i = 0; i < actual.length; i++) {
        const hijo: unknown = actual[i];
        if (esRecorrible(hijo)) pendientes.push(hijo);
      }
    } else {
      const claves = Object.keys(actual);
      total += claves.length;
      if (total > tope) return true;
      for (const clave of claves) {
        const hijo: unknown = (actual as Record<string, unknown>)[clave];
        if (esRecorrible(hijo)) pendientes.push(hijo);
      }
    }
  }
  return false;
}
