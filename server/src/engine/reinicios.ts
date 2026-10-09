import { deleteSetting, getJsonSetting, setJsonSetting } from '../modules/settings';
import type { AlmacenReinicios, AvisoReinicio } from './stalwart016';

/** Ajuste con los cambios del motor que esperan a que se reinicie su contenedor. */
export const AJUSTE_REINICIOS = 'engine_restart_pending';

/**
 * Los avisos de reinicio de Stalwart 0.16, en la base de datos del panel: el
 * de un cambio que dejó la herramienta de migración (otro proceso) o que se
 * guardó antes de reiniciar el panel no se pierde, y el motor sigue sin abrir
 * ese puerto hasta que alguien reinicie su contenedor.
 */
export const almacenReiniciosEnBase: AlmacenReinicios = {
  leer() {
    const guardado = getJsonSetting<unknown>(AJUSTE_REINICIOS);
    if (!guardado || typeof guardado !== 'object' || Array.isArray(guardado)) return {};
    const pendientes: Record<string, AvisoReinicio> = {};
    for (const [clave, valor] of Object.entries(guardado as Record<string, unknown>)) {
      const aviso = (valor && typeof valor === 'object' ? valor : {}) as { marca?: unknown; guardadoEn?: unknown };
      // Lo que no tiene la forma esperada cuenta como guardado hace mucho y sin
      // marca: desaparece en cuanto se puede leer cuándo arrancó el motor.
      pendientes[clave] = {
        marca: typeof aviso.marca === 'string' ? aviso.marca : null,
        guardadoEn: typeof aviso.guardadoEn === 'number' && Number.isFinite(aviso.guardadoEn) ? aviso.guardadoEn : 0,
      };
    }
    return pendientes;
  },
  guardar(pendientes) {
    if (Object.keys(pendientes).length === 0) deleteSetting(AJUSTE_REINICIOS);
    else setJsonSetting(AJUSTE_REINICIOS, pendientes);
  },
};
