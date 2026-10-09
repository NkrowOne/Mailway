/**
 * Avisa a la administración del panel desde la terminal del servidor.
 *
 *   node server/dist/tools/avisar.js --nivel <info|aviso|critico> --clave <clave> \
 *     --titulo <título> [--mensaje <texto>] [--remedio <texto>]
 *
 * La usa «mailway update --auto» (`deploy/mailway.sh`) dentro del contenedor
 * del panel, con `docker exec -u node`, para contar cómo ha ido cada
 * actualización automática. Llega al mismo sitio que los avisos del vigilante:
 *
 *   - «aviso» y «critico» abren una incidencia en Avisos y la envían por los
 *     canales configurados (Discord, Telegram, webhook). La clave identifica
 *     el problema (p. ej. `actualizacion:revertida:3f2c1a9b`): mientras siga
 *     abierta una con la misma clave no se repite, y las abiertas de la misma
 *     familia (lo que va antes del primer «:») se cierran, porque la nueva
 *     describe la situación actual;
 *   - «info» no abre ninguna incidencia: cierra las abiertas de su familia
 *     (lo que avisaban ya no ocurre) y envía el mensaje por los canales.
 *
 * Sin canales configurados no es un error: la incidencia queda en el panel
 * (con «info» no hay nada que hacer) y termina con código 0. Imprime UNA línea
 * con lo hecho, sin las URL ni los tokens de los canales. Un error de uso
 * termina con código 1 y el motivo en la salida de errores, sin repetir lo
 * recibido. Los textos llegan de la salida de otros programas: se limpian de
 * colores de terminal y caracteres de control y se acortan.
 */
// Antes que cualquier otro módulo: deja de ser root antes de abrir la base.
import './usuario-del-panel';
import { z, ZodError } from 'zod';
import { channelsConfigured, dispatch, type Severity } from '../core/notify';
import { fireAlert, resolveAlertsOfType } from '../modules/alerts';

const USO =
  'Uso: node server/dist/tools/avisar.js --nivel <info|aviso|critico> --clave <clave> --titulo <título> ' +
  '[--mensaje <texto>] [--remedio <texto>]';

/** Niveles de la herramienta y su gravedad en Avisos. */
const NIVELES: Record<'info' | 'aviso' | 'critico', Severity> = {
  info: 'info',
  aviso: 'warning',
  critico: 'critical',
};

const OPCIONES = ['nivel', 'clave', 'titulo', 'mensaje', 'remedio'] as const;
type Opcion = (typeof OPCIONES)[number];
export type EntradaAviso = Partial<Record<Opcion, string>>;

/** Nombre visible de cada canal (notify.ts los identifica en minúsculas). */
const NOMBRE_CANAL: Record<string, string> = { webhook: 'webhook', discord: 'Discord', telegram: 'Telegram' };

/**
 * Tramos de minúsculas, cifras, «.», «_» y «-» separados por «:». El primero
 * es la familia del aviso (su tipo en Avisos).
 */
const CLAVE_RE = /^[a-z0-9][a-z0-9._-]{0,59}(?::[a-z0-9][a-z0-9._-]{0,59}){0,4}$/;

/** Error de uso: el mensaje se muestra tal cual y nunca repite lo recibido. */
export class ErrorAviso extends Error {}

/** Secuencias de escape de la terminal (colores, movimientos del cursor). */
const ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/**
 * Texto legible para Avisos y los canales: sin secuencias de escape ni
 * caracteres de control, con los espacios normalizados y como mucho `max`
 * caracteres. Con `parrafos`, conserva los saltos de línea (como mucho una
 * línea en blanco seguida).
 */
export function limpiarTexto(texto: string, max: number, parrafos = false): string {
  const sinEscapes = texto.replace(ESCAPE_RE, '');
  const limpio = parrafos
    ? sinEscapes
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
        .split('\n')
        .map((linea) => linea.replace(/ {2,}/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : sinEscapes
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
  return limpio.length > max ? `${limpio.slice(0, max - 1).trimEnd()}…` : limpio;
}

const opcionesSchema = z.object({
  nivel: z.enum(['info', 'aviso', 'critico'], {
    errorMap: () => ({ message: `El nivel (--nivel) debe ser info, aviso o critico. ${USO}` }),
  }),
  clave: z
    .string({ required_error: `Indica la clave del aviso con --clave. ${USO}` })
    .regex(
      CLAVE_RE,
      'La clave solo admite minúsculas, cifras, «.», «_» y «-», en tramos separados por «:» (p. ej. actualizacion:revertida:3f2c1a9b).',
    ),
  titulo: z
    .string({ required_error: `Indica el título del aviso con --titulo. ${USO}` })
    .transform((texto) => limpiarTexto(texto, 160))
    .pipe(z.string().min(1, 'El título del aviso no puede quedar vacío.')),
  mensaje: z
    .string()
    .default('')
    .transform((texto) => limpiarTexto(texto, 1500, true)),
  remedio: z
    .string()
    .default('')
    .transform((texto) => limpiarTexto(texto, 600, true)),
});

/**
 * Lee las opciones (también como `--opcion=valor`) y nada más. Los mensajes
 * no repiten lo escrito: si alguien pega un secreto donde no toca, no acaba
 * en un registro.
 */
export function leerArgumentos(argv: readonly string[]): EntradaAviso {
  const valores: EntradaAviso = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const igual = arg.indexOf('=');
    const nombre = arg.startsWith('--') && igual > 0 ? arg.slice(0, igual) : arg;
    const opcion = OPCIONES.find((o) => `--${o}` === nombre);
    if (!opcion) {
      const mostrada = /^--[a-z-]{1,30}$/.test(nombre) ? nombre : 'no reconocida';
      throw new ErrorAviso(`Opción ${mostrada}: solo se admiten --nivel, --clave, --titulo, --mensaje y --remedio. ${USO}`);
    }
    if (valores[opcion] !== undefined) throw new ErrorAviso(`La opción ${nombre} está repetida. ${USO}`);
    let valor: string | undefined;
    if (igual > 0) {
      valor = arg.slice(igual + 1);
    } else {
      valor = argv[i + 1];
      i += 1;
    }
    if (valor === undefined || valor.startsWith('--')) throw new ErrorAviso(`Falta el valor de ${nombre}. ${USO}`);
    valores[opcion] = valor;
  }
  return valores;
}

export interface ResultadoAviso {
  /** Se ha abierto una incidencia nueva en Avisos (solo «aviso» y «critico»). */
  registrado: boolean;
  /** Ya había una abierta con la misma clave: no se repite ni se envía. */
  repetido: boolean;
  /** Canales a los que ha llegado. */
  enviados: string[];
  /** Canales que han fallado. */
  fallidos: string[];
}

/** El aviso completo; la herramienta de terminal solo le añade la entrada y la salida. */
export async function avisar(entrada: EntradaAviso): Promise<ResultadoAviso> {
  const opciones = opcionesSchema.parse(entrada);
  const severity = NIVELES[opciones.nivel];
  const familia = opciones.clave.split(':')[0]!;
  const resultado: ResultadoAviso = { registrado: false, repetido: false, enviados: [], fallidos: [] };

  if (severity === 'info') {
    resolveAlertsOfType(familia);
  } else {
    resolveAlertsOfType(familia, { except: opciones.clave });
    // quiet: el envío se espera aquí, para que el proceso no termine antes y
    // para saber qué canales han fallado.
    resultado.registrado = fireAlert({
      severity,
      type: familia,
      dedupeKey: opciones.clave,
      title: opciones.titulo,
      message: opciones.mensaje,
      remedy: opciones.remedio,
      quiet: true,
    });
    if (!resultado.registrado) {
      resultado.repetido = true;
      return resultado;
    }
  }

  const canales = channelsConfigured();
  if (canales.length === 0) return resultado;
  resultado.fallidos = await dispatch({
    severity,
    title: opciones.titulo,
    message: opciones.mensaje,
    remedy: opciones.remedio || undefined,
  });
  resultado.enviados = canales.filter((canal) => !resultado.fallidos.includes(canal));
  return resultado;
}

/** Una línea con lo hecho, sin las URL ni los tokens de los canales. */
export function describirResultado(resultado: ResultadoAviso, nivel: string | undefined): string {
  const nombres = (lista: string[]) => lista.map((canal) => NOMBRE_CANAL[canal] ?? canal).join(', ');
  const envio = [
    resultado.enviados.length > 0 ? `enviado por ${nombres(resultado.enviados)}` : '',
    resultado.fallidos.length > 0 ? `no se ha podido enviar por ${nombres(resultado.fallidos)}` : '',
  ].filter(Boolean);
  if (nivel === 'info') {
    if (envio.length === 0) return 'No hay canales de aviso configurados: no se envía nada.';
    return `Aviso ${envio.join('; ')}.`;
  }
  if (resultado.repetido) return 'Ya había una incidencia abierta en Avisos con esta clave: no se repite.';
  if (envio.length === 0) return 'Incidencia abierta en Avisos (no hay canales de aviso configurados).';
  return `Incidencia abierta en Avisos; ${envio.join('; ')}.`;
}

function mensajeDeError(err: unknown): string {
  if (err instanceof ZodError) return err.issues[0]?.message ?? 'Datos no válidos.';
  if (err instanceof ErrorAviso) return err.message;
  return `No se ha podido registrar el aviso: ${(err as Error)?.message || String(err)}`;
}

/** Escribe y termina cuando la línea ha salido entera (la lee otro programa). */
function terminar(codigo: number, salida: string, errores: string): void {
  if (errores) process.stderr.write(errores);
  if (salida) process.stdout.write(salida, () => process.exit(codigo));
  else process.exit(codigo);
}

async function main(): Promise<void> {
  try {
    const entrada = leerArgumentos(process.argv.slice(2));
    const resultado = await avisar(entrada);
    terminar(0, `${describirResultado(resultado, entrada.nivel)}\n`, '');
  } catch (err) {
    terminar(1, '', `${mensajeDeError(err)}\n`);
  }
}

if (require.main === module) void main();
