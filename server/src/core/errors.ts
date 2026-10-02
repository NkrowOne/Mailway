/** Error con código HTTP y mensaje pensado para mostrarse tal cual al usuario. */
export class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message: string, code = 'bad_request'): HttpError {
  return new HttpError(400, message, code);
}

export function unauthorized(message = 'Es necesario iniciar sesión.', code = 'unauthorized'): HttpError {
  return new HttpError(401, message, code);
}

export function forbidden(message = 'No tienes permiso para realizar esta acción.', code = 'forbidden'): HttpError {
  return new HttpError(403, message, code);
}

export function notFound(message = 'No encontrado.', code = 'not_found'): HttpError {
  return new HttpError(404, message, code);
}

export function conflict(message: string, code = 'conflict'): HttpError {
  return new HttpError(409, message, code);
}

export function tooMany(message: string, code = 'rate_limited'): HttpError {
  return new HttpError(429, message, code);
}

export function upstream(message: string, code = 'engine_error'): HttpError {
  return new HttpError(502, message, code);
}

/**
 * ¿Es un choque con un índice único de SQLite? Pasa cuando dos peticiones
 * crean a la vez el mismo recurso (doble clic, reintento de una integración):
 * la segunda debe recibir un 409, no un 500, y nunca deshacer en el motor lo
 * que ha creado la primera.
 */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}
