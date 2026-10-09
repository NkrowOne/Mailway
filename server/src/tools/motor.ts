/**
 * Cambio de versión del motor de correo desde la terminal del servidor.
 *
 *   docker exec -u node <panel> node server/dist/tools/motor.js <orden> [opciones]
 *
 * La ejecuta el instalador dentro del contenedor del panel para migrar
 * Stalwart 0.15 a 0.16 (o volver atrás) con el panel en marcha:
 *
 *   estado                      API detectada, copia de los hashes de las
 *                               contraseñas, contraseñas de aplicación por API
 *                               y modo mantenimiento.
 *   capturar                    copia en el panel el hash de TODOS los buzones
 *                               (solo con Stalwart 0.15); falla si falta alguno.
 *   mantenimiento on [--minutos N] | mantenimiento off
 *                               bloquea (o libera) los cambios en el motor desde
 *                               el panel, las integraciones y el vigilante
 *                               (por defecto 120 minutos; caduca solo).
 *   provisionar                 ajustes recomendados, suspensiones de nuevo y
 *                               comprobación de dominios, buzones y alias.
 *   tras-migrar                 renueva las credenciales SMTP internas, marca
 *                               las contraseñas de aplicación que han muerto,
 *                               avisa a la administración y a los titulares.
 *
 * `capturar`, `provisionar` y `tras-migrar` trabajan con el motor sin el
 * guardián del mantenimiento: son la migración.
 *
 * Imprime por la salida estándar UNA línea JSON con `ok`; el texto para
 * personas va a la salida de errores. Código de salida: 0 si todo ha ido bien,
 * 1 si hay un problema (la línea JSON lleva `ok: false` y `error`), 2 si la
 * orden no es válida. Nunca imprime secretos.
 */
// Antes que cualquier otro módulo: deja de ser root antes de abrir la base.
import './usuario-del-panel';
import { HttpError } from '../core/errors';
import { auditSystem } from '../modules/audit';
import {
  capturarParaMigrar,
  estadoCambioMotor,
  provisionarMotor,
  trasMigrarMotor,
} from '../modules/cambiomotor';
import {
  MINUTOS_MAXIMOS,
  MINUTOS_POR_DEFECTO,
  activarMantenimiento,
  desactivarMantenimiento,
} from '../modules/mantenimiento';

const USO =
  'Uso: node server/dist/tools/motor.js estado | capturar | mantenimiento on [--minutos N] | mantenimiento off | provisionar | tras-migrar';

/** Así aparecen estas acciones en la Actividad (junto a «Sistema»). */
const ORIGEN = 'terminal';

/** Orden mal escrita: código 2. El mensaje nunca repite lo recibido. */
export class ErrorDeUso extends Error {}

export interface EntradaSalidaMotor {
  /** Una línea para stdout (el resultado, en JSON). */
  out: (linea: string) => void;
  /** Una línea para stderr (texto para personas). */
  err: (linea: string) => void;
}

/** `--minutos N` o `--minutos=N` (1 a 1440). */
export function leerMinutos(argv: readonly string[]): number {
  if (argv.length === 0) return MINUTOS_POR_DEFECTO;
  let valor: string | undefined;
  const [primero, segundo, ...resto] = argv;
  if (primero === '--minutos') {
    valor = segundo;
    if (resto.length > 0) throw new ErrorDeUso(`Sobran argumentos. ${USO}`);
  } else if (primero?.startsWith('--minutos=')) {
    valor = primero.slice('--minutos='.length);
    if (segundo !== undefined) throw new ErrorDeUso(`Sobran argumentos. ${USO}`);
  } else {
    throw new ErrorDeUso(`Opción no reconocida: solo se admite --minutos. ${USO}`);
  }
  if (valor === undefined || !/^\d{1,5}$/.test(valor)) {
    throw new ErrorDeUso(`Indica los minutos con un número entero entre 1 y ${MINUTOS_MAXIMOS}. ${USO}`);
  }
  const minutos = Number(valor);
  if (minutos < 1 || minutos > MINUTOS_MAXIMOS) {
    throw new ErrorDeUso(`Indica los minutos con un número entero entre 1 y ${MINUTOS_MAXIMOS}. ${USO}`);
  }
  return minutos;
}

function sinArgumentos(orden: string, resto: readonly string[]): void {
  if (resto.length > 0) throw new ErrorDeUso(`La orden ${orden} no admite opciones. ${USO}`);
}

/** Ejecuta la orden y devuelve el resultado que se imprime. */
async function ejecutarOrden(argv: readonly string[], io: EntradaSalidaMotor): Promise<Record<string, unknown> & { ok: boolean }> {
  const [orden, ...resto] = argv;
  switch (orden) {
    case 'estado': {
      sinArgumentos(orden, resto);
      return { ...(await estadoCambioMotor()) };
    }
    case 'capturar': {
      sinArgumentos(orden, resto);
      const resultado = await capturarParaMigrar();
      if (resultado.ok) io.err(`Copia de contraseñas: ${resultado.capturados} copiadas, ${resultado.yaEstaban} ya estaban.`);
      return { ...resultado };
    }
    case 'mantenimiento': {
      const [modo, ...opciones] = resto;
      if (modo === 'on') {
        const minutos = leerMinutos(opciones);
        const estado = activarMantenimiento(minutos);
        auditSystem('engine.maintenance_on', { hasta: estado.hasta, minutos, origen: ORIGEN });
        io.err(`Mantenimiento del motor activado durante ${minutos} minutos.`);
        return { ok: true, activo: estado.activo, hasta: estado.hasta };
      }
      if (modo === 'off') {
        sinArgumentos('mantenimiento off', opciones);
        const estado = desactivarMantenimiento();
        auditSystem('engine.maintenance_off', { origen: ORIGEN });
        io.err('Mantenimiento del motor desactivado.');
        return { ok: true, activo: estado.activo, hasta: estado.hasta };
      }
      throw new ErrorDeUso(`Indica «mantenimiento on» o «mantenimiento off». ${USO}`);
    }
    case 'provisionar': {
      sinArgumentos(orden, resto);
      const resultado = await provisionarMotor();
      if (resultado.restartRequired.length > 0) {
        io.err(`El motor necesita reiniciarse para aplicar: ${resultado.restartRequired.join('; ')}. Reinícialo y repite «provisionar».`);
      }
      return { ...resultado };
    }
    case 'tras-migrar': {
      sinArgumentos(orden, resto);
      const resultado = await trasMigrarMotor();
      for (const fallo of resultado.avisosFallidos) io.err(`Aviso: no se ha podido avisar por correo a ${fallo}`);
      return { ...resultado };
    }
    default:
      throw new ErrorDeUso(USO);
  }
}

/** Ejecuta la herramienta y devuelve el código de salida. */
export async function ejecutarMotor(argv: readonly string[], io: EntradaSalidaMotor): Promise<number> {
  try {
    const resultado = await ejecutarOrden(argv, io);
    io.out(JSON.stringify(resultado));
    if (!resultado.ok && typeof resultado.error === 'string') io.err(resultado.error);
    return resultado.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof ErrorDeUso) {
      io.out(JSON.stringify({ ok: false, error: err.message }));
      io.err(err.message);
      return 2;
    }
    // Un error del motor o de la base ya viene redactado para mostrarse; uno
    // inesperado se resume sin pila.
    const motivo = err instanceof HttpError ? err.message : `No se ha podido completar la orden: ${(err as Error)?.message || String(err)}`;
    io.out(JSON.stringify({ ok: false, error: motivo }));
    io.err(motivo);
    return 1;
  }
}

if (require.main === module) {
  const salida: string[] = [];
  const errores: string[] = [];
  void ejecutarMotor(process.argv.slice(2), {
    out: (linea) => salida.push(`${linea}\n`),
    err: (linea) => errores.push(`${linea}\n`),
  }).then((codigo) => {
    // Se escribe y se termina cuando la línea ha salido entera (la lee otro
    // programa): una conexión abierta con el motor no debe retrasar la salida.
    if (errores.length > 0) process.stderr.write(errores.join(''));
    if (salida.length > 0) process.stdout.write(salida.join(''), () => process.exit(codigo));
    else process.exit(codigo);
  });
}
