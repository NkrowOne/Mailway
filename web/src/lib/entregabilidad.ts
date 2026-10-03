import type { ServerHealth } from './api';

/*
  Lectura de la comprobación de entregabilidad del servidor, compartida por
  el parte del administrador y el informe de Entregabilidad.
*/

/**
 * true si se ha podido medir todo lo que decide la puntuación: el registro A,
 * el PTR y cada lista negra. Con un resolvedor lento o sin red, el servidor
 * devuelve «no comprobable» y una puntuación que no descuenta nada; esa cifra
 * no es un veredicto y no debe presentarse como «en rango».
 */
export function medicionCompleta(health: ServerHealth): boolean {
  return (
    health.hostnameResolves !== null &&
    health.ptrOk !== null &&
    health.dnsbl.every((lista) => lista.status !== 'inconclusive')
  );
}

export const TEXTO_MEDICION_INCOMPLETA =
  'Comprobación incompleta: no se ha podido consultar el PTR, el registro A o las listas negras. Vuelve a comprobarlo en unos minutos.';
