/**
 * Adopta en Ajustes la identidad del servidor que trae el entorno del panel,
 * desde la terminal del servidor:
 *
 *   node server/dist/tools/identidad.js --adoptar servidor,webmail,panel,ip
 *
 * La ejecuta el instalador (`deploy/instalar.sh`) dentro del contenedor del
 * panel con `docker exec`, después de que quien instala haya confirmado
 * expresamente otro dominio para la plataforma (servidor, webmail, panel) o
 * otra IP (ip). El panel adopta solo lo que el instalador cambió desde la
 * última vez y nunca lo que la administración cambió a mano
 * (`modules/entorno.ts`); esta herramienta adopta los campos indicados
 * también en ese caso y en los paneles anteriores a ese registro, porque la
 * confirmación del instalador es lo último que se ha decidido. Con un nombre
 * del servidor nuevo, aplica además los ajustes recomendados del motor. Es
 * idempotente: lo que ya coincide con el entorno no cambia.
 *
 * Imprime por la salida estándar UNA línea JSON
 * `{"cambios":[{"campo","antes","despues"}]}` (nombres, URL e IP: nada
 * secreto). Los avisos van a la salida de errores con el prefijo «Aviso: »;
 * un fallo termina con código 1 y el motivo en la salida de errores.
 */
// Antes que cualquier otro módulo: deja de ser root antes de abrir la base.
import './usuario-del-panel';
import { auditSystem } from '../modules/audit';
import {
  aplicarTrasAdoptar,
  CAMPO_POR_NOMBRE,
  type CampoEntorno,
  detalleDeCambios,
  sincronizarIdentidadConEntorno,
} from '../modules/entorno';

const NOMBRES = Object.keys(CAMPO_POR_NOMBRE);

const USO = `Uso: node server/dist/tools/identidad.js --adoptar <${NOMBRES.join(',')}>`;

/** Error de uso: el mensaje se muestra tal cual y nunca repite lo recibido. */
export class ErrorIdentidad extends Error {}

/** Lee `--adoptar` (también como `--adoptar=…`) y nada más. */
export function leerArgumentos(argv: string[]): CampoEntorno[] {
  let lista: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const igual = arg.indexOf('=');
    const nombre = igual > 0 ? arg.slice(0, igual) : arg;
    if (nombre !== '--adoptar') {
      const opcion = /^--[a-z-]{1,30}$/.test(nombre) ? nombre : 'no reconocida';
      throw new ErrorIdentidad(`Opción ${opcion}: solo se admite --adoptar. ${USO}`);
    }
    if (lista !== undefined) throw new ErrorIdentidad(`La opción --adoptar está repetida. ${USO}`);
    lista = igual > 0 ? arg.slice(igual + 1) : argv[(i += 1)];
    if (lista === undefined || lista.startsWith('--')) throw new ErrorIdentidad(`Falta el valor de --adoptar. ${USO}`);
  }
  if (lista === undefined) throw new ErrorIdentidad(`Indica qué adoptar. ${USO}`);
  const campos = new Set<CampoEntorno>();
  for (const parte of lista.split(',')) {
    // hasOwn: «toString» o «__proto__» no son nombres de campo.
    const clave = parte.trim();
    if (!Object.hasOwn(CAMPO_POR_NOMBRE, clave)) {
      throw new ErrorIdentidad(`--adoptar solo admite ${NOMBRES.join(', ')}, separados por comas. ${USO}`);
    }
    campos.add(CAMPO_POR_NOMBRE[clave]!);
  }
  return [...campos];
}

const NOMBRE_DE_CAMPO = Object.fromEntries(Object.entries(CAMPO_POR_NOMBRE).map(([n, c]) => [c, n])) as Record<
  CampoEntorno,
  string
>;

export interface ResultadoIdentidad {
  cambios: { campo: string; antes: string; despues: string }[];
  avisos: string[];
}

/** La adopción completa; la herramienta de terminal solo le añade la entrada y la salida. */
export async function adoptarIdentidad(campos: readonly CampoEntorno[]): Promise<ResultadoIdentidad> {
  const resultado = sincronizarIdentidadConEntorno({ adoptar: campos });
  const avisos = [...resultado.avisos];
  if (resultado.cambios.length > 0) {
    auditSystem('settings.instance_env_adopted', {
      cambios: detalleDeCambios(resultado.cambios),
      origen: 'instalador',
    });
    const aplicado = await aplicarTrasAdoptar(resultado.cambios);
    if (aplicado && !aplicado.applied) {
      const motivo = aplicado.error || aplicado.errors.join('; ');
      avisos.push(
        `El motor no aceptó los ajustes recomendados con el nombre nuevo${motivo ? ` (${motivo})` : ''}. Repítelo en Ajustes → Servidor de correo.`,
      );
    }
  }
  return {
    cambios: resultado.cambios.map((c) => ({ campo: NOMBRE_DE_CAMPO[c.campo], antes: c.antes, despues: c.despues })),
    avisos,
  };
}

/** Escribe y termina cuando la línea ha salido entera (la lee otro programa). */
function terminar(codigo: number, salida: string, errores: string): void {
  if (errores) process.stderr.write(errores);
  if (salida) process.stdout.write(salida, () => process.exit(codigo));
  else process.exit(codigo);
}

async function main(): Promise<void> {
  try {
    const { cambios, avisos } = await adoptarIdentidad(leerArgumentos(process.argv.slice(2)));
    terminar(0, `${JSON.stringify({ cambios })}\n`, avisos.map((aviso) => `Aviso: ${aviso}\n`).join(''));
  } catch (err) {
    const mensaje =
      err instanceof ErrorIdentidad
        ? err.message
        : `No se pudo adoptar la identidad del servidor: ${(err as Error)?.message || String(err)}`;
    terminar(1, '', `${mensaje}\n`);
  }
}

if (require.main === module) void main();
