import { getSetting, setSetting } from '../modules/settings';
import type { EngineApi } from './types';

/**
 * Última API del motor que se ha llegado a saber (rest015, jmap016 o demo),
 * para lo que necesita la versión sin poder esperar al motor: las rutas que
 * Traefik consulta cada pocos segundos (/api/traefik/config) y el cálculo de
 * lo que hay que aplicar en Bulwark. Se anota cada vez que alguien la
 * pregunta a través del motor de las rutas (engine/protegido.ts), así que el
 * vigilante, que hace ping al motor cada minuto, la mantiene al día: si el
 * motor vuelve a 0.15, los webmail del correo web nuevo vuelven a Roundcube
 * en cuanto se nota. Se guarda en la base para que un reinicio del panel no
 * los mande a Roundcube hasta la primera consulta.
 */

const AJUSTE = 'engine_api_last';
const VALIDAS: readonly EngineApi[] = ['rest015', 'jmap016', 'demo'];

/** undefined = aún no se ha leído de la base en este proceso. */
let enMemoria: EngineApi | null | undefined;

export function anotarApiDelMotor(api: EngineApi): void {
  if (!VALIDAS.includes(api) || enMemoria === api) return;
  enMemoria = api;
  // Solo cuando cambia: se pregunta a menudo y no hace falta escribir cada vez.
  if (getSetting(AJUSTE) !== api) setSetting(AJUSTE, api);
}

export function ultimaApiDelMotor(): EngineApi | null {
  if (enMemoria === undefined) {
    const guardada = getSetting(AJUSTE);
    enMemoria = VALIDAS.includes(guardada as EngineApi) ? (guardada as EngineApi) : null;
  }
  return enMemoria;
}

/** Solo para las pruebas: olvida lo anotado (en memoria y en la base). */
export function olvidarApiDelMotorParaPruebas(): void {
  enMemoria = undefined;
  setSetting(AJUSTE, '');
}
