import { badRequest } from './errors';

export function normalizeMailHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

/** No acepta URLs, direcciones IP ni nombres internos de Docker. */
export function validateMailHostname(value: string): string {
  const hostname = normalizeMailHostname(value);
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) {
    throw badRequest('El servidor de correo debe ser un dominio completo, por ejemplo mail.tuempresa.com.');
  }
  return hostname;
}
