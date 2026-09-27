import { ApiError } from './api';
import type { Veredicto } from '../ui/kit';

/*
  Complementos de las lecturas de dominio de lib/cloudflare.ts
  (`lecturaDominio`, `propiedadPendiente`) para las vistas de buzones, alias y
  clientes.
*/

/** Fuera de rango primero; después, vigilar y sin dato y, al final, lo que está activo. */
export const pesoVeredicto: Record<Veredicto, number> = { fuera: 0, vigilar: 1, 'sin-dato': 2, normal: 3 };

export const TEXTO_PROPIEDAD_PENDIENTE = 'Pendiente de comprobar la propiedad';

/** Error del servidor al crear un buzón o un alias en un dominio sin propiedad comprobada. */
export function esPropiedadPendiente(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'domain_ownership_pending';
}
