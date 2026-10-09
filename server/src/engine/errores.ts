import { HttpError } from '../core/errors';

/**
 * Errores compartidos por los drivers de Stalwart.
 *
 * `RutaDeGestionAusente`: el motor respondió 404 en la ruta base de su API de
 * gestión (`/api/…` en 0.15, `/jmap` en 0.16). No significa «no existe el
 * elemento» sino «este motor no habla esa API»: el motor se ha migrado de
 * versión con el panel en marcha, o la URL apunta a otra cosa. El detector
 * (engine/index.ts) la usa para volver a averiguar la API y repetir la
 * operación una vez. Hacia fuera sigue siendo un `engine_error` 502.
 */
export class RutaDeGestionAusente extends HttpError {
  constructor(message: string) {
    super(502, message, 'engine_error');
  }
}

/** La versión del motor no admite la operación (p. ej. el ACME propio en 0.16). */
export function motorNoAdmite(message: string): HttpError {
  return new HttpError(409, message, 'engine_unsupported');
}
