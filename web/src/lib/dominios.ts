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

/** GET /api/domains/:id/conflicto: correo en otro proveedor y MX internos del motor. */
export interface ConflictoDominio {
  hayOtroProveedor: boolean;
  mxActuales: string[];
  aviso: string | null;
  /** Destinos MX internos que propone el motor (vacío si no hay o si el motor no respondió). */
  mxInternos?: string[];
  /** Explicación de `mxInternos`; con ella no se puede exportar la zona ni aplicar en Cloudflare. */
  avisoServidor?: string | null;
  /** Qué hacer con la política MTA-STS del proveedor actual antes de cambiar el MX. */
  avisoMtaSts?: string | null;
}

/**
 * Dominio sin «www.» para sugerirlo en el alta: quien pega la URL de la web
 * casi siempre quiere el correo en empresa.com, no en www.empresa.com. Admite
 * lo mismo que el servidor (URL completa, mayúsculas, punto final). null si
 * no empieza por «www.» o si quitarlo no deja un dominio (www.es).
 */
export function sugerenciaSinWww(texto: string): string | null {
  const limpio = texto
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '');
  if (!limpio.startsWith('www.')) return null;
  const resto = limpio.slice(4);
  return /^[^.\s]+(\.[^.\s]+)+$/.test(resto) ? resto : null;
}
