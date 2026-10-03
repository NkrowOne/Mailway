/**
 * Conecta la cuenta de Cloudflare de la instancia desde la terminal del servidor.
 *
 *   printf '%s' "$TOKEN" | node server/dist/tools/cloudflare.js conectar [--nombre <nombre>]
 *
 * La ejecuta el instalador (`deploy/instalar.sh`) dentro del contenedor del
 * panel con `docker exec -i`, con el token de Cloudflare que se le ha dado al
 * instalar: así el administrador no tiene que volver a pegarlo en Conexiones
 * → Cloudflare, y sus altas de dominios configuran el DNS solas.
 *
 * El token llega SOLO por la entrada estándar: como argumento quedaría a la
 * vista en `ps` (los procesos del contenedor se ven desde el host) y en el
 * historial del shell. Por eso, antes de leer nada, se rechaza `--token` y
 * cualquier argumento que parezca un token, y desde un terminal no se espera
 * entrada. Ningún mensaje repite lo recibido.
 *
 * La cuenta es de la INSTANCIA (sin cliente): solo la usa el administrador,
 * nunca una acción de un cliente ni una integración con `soloCliente=1`
 * (`modules/cloudflare.ts`, resolverZona y permiteInstancia). Se guarda
 * cifrada, igual que desde el panel, y se anota en la Actividad como
 * «Sistema», sin el token.
 *
 * Es idempotente: si el mismo token ya está conectado como cuenta de la
 * instancia, devuelve esa cuenta sin cambiarla (`creada: false`). Con otro
 * token, si ya hay una cuenta de la instancia conectada desde la terminal (la
 * del instalador), le sustituye el token tras verificarlo (`sustituida:
 * true`): así se rota repitiendo el instalador, sin dejar la antigua en uso.
 *
 * Imprime por la salida estándar UNA línea JSON
 * `{"ok":true,"id","label","zones","creada","sustituida"}` (zones: número de
 * zonas que ve el token). Los avisos van a la salida de errores con el prefijo «Aviso: »;
 * un fallo termina con código 1 y el motivo en la salida de errores.
 */
// Antes que cualquier otro módulo: deja de ser root antes de abrir la base.
import './usuario-del-panel';
import { ZodError } from 'zod';
import { HttpError } from '../core/errors';
import { auditSystem } from '../modules/audit';
import { conectarCuentaCloudflare, etiquetaSchema, tokenSchema } from '../modules/cloudflare';

const USO =
  "Uso: printf '%s' \"$TOKEN\" | node server/dist/tools/cloudflare.js conectar [--nombre <nombre>]";

const SOLO_ENTRADA =
  'El token de Cloudflare solo se admite por la entrada estándar, nunca como argumento: quedaría a la vista en «ps» y en el historial. ' +
  USO;

/** Tamaño máximo de la entrada estándar: de sobra para un token (el panel admite hasta 400 caracteres). */
export const MAX_ENTRADA = 4096;

/** Así aparece en la Actividad (junto a «Sistema»). */
const ORIGEN = 'terminal';

/** Error de uso o de validación: el mensaje se muestra tal cual y nunca repite lo recibido. */
export class ErrorCloudflareTerminal extends Error {}

export interface EntradaSalidaCloudflare {
  /** Una línea para stdout (el resultado, en JSON). */
  out: (linea: string) => void;
  /** Una línea para stderr (errores y avisos). */
  err: (linea: string) => void;
  /** Todo lo que llega por la entrada estándar. */
  leerEntrada: () => Promise<string>;
}

/**
 * ¿Parece un token? Los prefijos de Cloudflare (cfut_, cfat_, cfk_…) o una
 * cadena larga sin espacios con letras y cifras, como los tokens antiguos de
 * 40 caracteres. Un nombre largo con cifras también lo parece: se pide otro.
 */
export function pareceToken(valor: string): boolean {
  const v = valor.trim();
  if (/^cf[a-z]{1,3}_/i.test(v)) return true;
  return /^[A-Za-z0-9_-]{32,}$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v);
}

/** Antes que nada: un token en los argumentos se rechaza sin usarlo ni repetirlo. */
function rechazarTokenEnArgumentos(argv: readonly string[]): void {
  for (const arg of argv) {
    const igual = arg.indexOf('=');
    const nombre = arg.startsWith('--') && igual > 0 ? arg.slice(0, igual) : arg;
    const valor = igual > 0 ? arg.slice(igual + 1) : arg;
    if (nombre === '--token' || pareceToken(arg) || pareceToken(valor)) {
      throw new ErrorCloudflareTerminal(SOLO_ENTRADA);
    }
  }
}

/**
 * Opciones de «conectar»: solo `--nombre` (también como `--nombre=valor`).
 * Los mensajes no repiten lo escrito.
 */
export function leerArgumentos(argv: readonly string[]): { nombre?: string } {
  let nombre: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const igual = arg.indexOf('=');
    const opcion = igual > 0 ? arg.slice(0, igual) : arg;
    if (opcion !== '--nombre') {
      const mostrada = /^--[a-z-]{1,30}$/.test(opcion) ? opcion : 'no reconocida';
      throw new ErrorCloudflareTerminal(`Opción ${mostrada}: solo se admite --nombre. ${USO}`);
    }
    if (nombre !== undefined) throw new ErrorCloudflareTerminal(`La opción --nombre está repetida. ${USO}`);
    let valor: string | undefined;
    if (igual > 0) {
      valor = arg.slice(igual + 1);
    } else {
      valor = argv[i + 1];
      i += 1;
    }
    if (valor === undefined || valor.startsWith('--')) throw new ErrorCloudflareTerminal(`Falta el valor de --nombre. ${USO}`);
    // El nombre se muestra en el panel y en la salida del instalador.
    if (/[\u0000-\u001f\u007f]/.test(valor)) {
      throw new ErrorCloudflareTerminal('El nombre de la cuenta no puede contener saltos de línea ni caracteres de control.');
    }
    nombre = etiquetaSchema.parse(valor);
  }
  return nombre ? { nombre } : {};
}

/** El token de la entrada estándar, sin espacios ni saltos de línea alrededor. */
export function tokenDeEntrada(texto: string): string {
  if (texto.length > MAX_ENTRADA) {
    throw new ErrorCloudflareTerminal('La entrada estándar es demasiado larga para ser un token de Cloudflare.');
  }
  if (!texto.trim()) {
    throw new ErrorCloudflareTerminal(`No ha llegado ningún token por la entrada estándar. ${USO}`);
  }
  // Los mensajes de tokenSchema son fijos: no repiten el valor.
  return tokenSchema.parse(texto);
}

function mensajeDeError(err: unknown): string {
  if (err instanceof ZodError) return err.issues[0]?.message ?? 'Datos no válidos.';
  if (err instanceof ErrorCloudflareTerminal || err instanceof HttpError) return err.message;
  return `No se ha podido conectar la cuenta de Cloudflare: ${(err as Error)?.message || String(err)}`;
}

async function conectar(argv: readonly string[], io: EntradaSalidaCloudflare): Promise<void> {
  // Todo lo que no depende del token se valida antes de leerlo.
  const { nombre } = leerArgumentos(argv);
  const token = tokenDeEntrada(await io.leerEntrada());
  try {
    const { cuenta, creada, sustituida } = await conectarCuentaCloudflare({
      token,
      label: nombre,
      clientId: null,
      createdBy: null,
      siYaExiste: 'devolver',
      auditar: (accion, detalle) => auditSystem(accion, { ...detalle, origen: ORIGEN }, null),
    });
    if (!creada && cuenta.lastError) {
      io.err(`Aviso: La cuenta «${cuenta.label}» ya estaba conectada, pero Cloudflare no la ha aceptado ahora: ${cuenta.lastError}`);
    }
    io.out(
      JSON.stringify({ ok: true, id: cuenta.id, label: cuenta.label, zones: cuenta.zonesTotal ?? 0, creada, sustituida }),
    );
  } catch (err) {
    // Los mensajes de Cloudflare ya están traducidos y no llevan el token,
    // pero se asegura igual: esta salida acaba en la del instalador.
    throw new ErrorCloudflareTerminal(mensajeDeError(err).split(token).join('•••'));
  }
}

/** Ejecuta la herramienta y devuelve el código de salida. */
export async function ejecutarCloudflare(argv: readonly string[], io: EntradaSalidaCloudflare): Promise<number> {
  try {
    rechazarTokenEnArgumentos(argv);
    const [orden, ...resto] = argv;
    if (orden !== 'conectar') throw new ErrorCloudflareTerminal(USO);
    await conectar(resto, io);
    return 0;
  } catch (err) {
    io.err(mensajeDeError(err));
    return 1;
  }
}

/**
 * Entrada estándar del proceso. Desde un terminal no se espera: el token
 * tiene que llegar por una tubería. Se corta al pasar del tope.
 */
export async function leerEntradaEstandar(
  flujo: AsyncIterable<unknown> & { isTTY?: boolean } = process.stdin,
): Promise<string> {
  if (flujo.isTTY) throw new ErrorCloudflareTerminal(SOLO_ENTRADA);
  const trozos: Buffer[] = [];
  let total = 0;
  for await (const trozo of flujo) {
    const buf = Buffer.isBuffer(trozo) ? trozo : Buffer.from(String(trozo));
    total += buf.length;
    if (total > MAX_ENTRADA) {
      throw new ErrorCloudflareTerminal('La entrada estándar es demasiado larga para ser un token de Cloudflare.');
    }
    trozos.push(buf);
  }
  return Buffer.concat(trozos).toString('utf8');
}

if (require.main === module) {
  const salida: string[] = [];
  const errores: string[] = [];
  void ejecutarCloudflare(process.argv.slice(2), {
    out: (linea) => salida.push(`${linea}\n`),
    err: (linea) => errores.push(`${linea}\n`),
    leerEntrada: () => leerEntradaEstandar(),
  }).then((codigo) => {
    // Se escribe y se termina cuando la línea ha salido entera (la lee otro
    // programa): una conexión HTTP abierta no debe retrasar la salida.
    if (errores.length > 0) process.stderr.write(errores.join(''));
    if (salida.length > 0) process.stdout.write(salida.join(''), () => process.exit(codigo));
    else process.exit(codigo);
  });
}
