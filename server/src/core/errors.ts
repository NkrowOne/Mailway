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

export function unauthorized(message = 'No has iniciado sesión.', code = 'unauthorized'): HttpError {
  return new HttpError(401, message, code);
}

export function forbidden(message = 'No tienes permiso para hacer esto.', code = 'forbidden'): HttpError {
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
