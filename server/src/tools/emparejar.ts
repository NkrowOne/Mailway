/**
 * Empareja este panel con Skyway desde la terminal del servidor.
 *
 *   node server/dist/tools/emparejar.js --email <correo del administrador> [--nombre <nombre>]
 *
 * La ejecuta el instalador (`deploy/instalar.sh`) dentro del contenedor del
 * panel con `docker exec`: quien llega aquí ya es root en el servidor. No abre
 * ningún puerto ni recibe nada por la red. Es idempotente:
 *
 *   1. completa la puesta en marcha con el entorno del panel, con los mismos
 *      pasos que el asistente (`modules/setup.ts`): identidad del servidor
 *      (lo que falte y lo que el instalador haya cambiado desde la última
 *      vez, salvo lo que la administración cambió en el panel:
 *      `modules/entorno.ts`), motor (`STALWART_*`) si aún no hay ninguno y
 *      ajustes recomendados del motor. Lo que no se pueda hacer queda en los
 *      avisos, nunca hace fallar el emparejado;
 *   2. en una sola transacción, y como último paso para que nunca quede una
 *      cuenta nueva cuya contraseña no se ha mostrado: si no hay
 *      administrador, lo crea con ese correo y una contraseña aleatoria (si
 *      ya existe, se usa el que tiene ese correo o, si no, el primero que se
 *      creó), y crea el token de gestión de administración «Skyway», sin
 *      caducidad, revocando antes el que hubiera activo con ese nombre.
 *
 * Imprime por la salida estándar UNA línea JSON
 * `{"adminEmail","adminPassword"?,"token"}`: la contraseña solo si acaba de
 * crear el administrador. Los avisos van a la salida de errores, sin secretos;
 * un fallo termina con código 1 y el motivo en la salida de errores. Ni la
 * contraseña ni el token pasan por el registro ni por la auditoría.
 */
// Antes que cualquier otro módulo: deja de ser root antes de abrir la base.
import './usuario-del-panel';
import crypto from 'node:crypto';
import { z, ZodError } from 'zod';
import { config } from '../config';
import { db } from '../core/db';
import { HttpError } from '../core/errors';
import { engineConfigured } from '../engine';
import { auditSystem } from '../modules/audit';
import { countUsers, type AuthedUser } from '../modules/auth';
import { detalleDeCambios, sincronizarIdentidadConEntorno } from '../modules/entorno';
import {
  applyRecommendedQuietly,
  connectEngine,
  createFirstAdmin,
  engineFromEnv,
  scrub,
  type RecommendedOutcome,
} from '../modules/setup';
import { getEngineSettings, getInstanceSettings, isSetupComplete, markSetupComplete } from '../modules/settings';
import { activeAdminTokensNamed, createManagementToken, revokeManagementToken } from '../modules/tokens';

/** Nombre del token de gestión que usa Skyway. */
export const NOMBRE_TOKEN_SKYWAY = 'Skyway';

/** Así aparecen estas acciones en la Actividad (junto a «Sistema»). */
const ORIGEN = 'emparejado con Skyway';

const USO =
  'Uso: node server/dist/tools/emparejar.js --email <correo del administrador> [--nombre <nombre>]';

const opcionesSchema = z.object({
  email: z
    .string({ required_error: 'Indica el correo del administrador con --email.' })
    .trim()
    .toLowerCase()
    .max(254, 'El correo del administrador no es válido.')
    .email('El correo del administrador no es válido.'),
  nombre: z
    .string()
    .trim()
    .min(2, 'El nombre del administrador debe tener al menos 2 caracteres.')
    .max(80, 'El nombre del administrador no puede superar los 80 caracteres.')
    .default('Administración'),
});

export type OpcionesEmparejado = z.input<typeof opcionesSchema>;

export interface ResultadoEmparejado {
  adminEmail: string;
  /** Solo si el administrador se acaba de crear: no se guarda en ningún sitio. */
  adminPassword?: string;
  token: string;
  /** Lo que ha quedado pendiente, para la salida de errores (sin secretos). */
  avisos: string[];
}

/** Error de uso o de estado: el mensaje se muestra tal cual. */
class ErrorEmparejado extends Error {}

/**
 * Lee `--email` y `--nombre` (también como `--opcion=valor`) y nada más. Los
 * mensajes no repiten lo escrito: si alguien pega un secreto donde no toca,
 * no acaba en el terminal ni en un registro.
 */
export function leerArgumentos(argv: string[]): OpcionesEmparejado {
  const valores: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const igual = arg.indexOf('=');
    const nombre = igual > 0 ? arg.slice(0, igual) : arg;
    if (nombre !== '--email' && nombre !== '--nombre') {
      const opcion = /^--[a-z-]{1,30}$/.test(nombre) ? nombre : 'no reconocida';
      throw new ErrorEmparejado(`Opción ${opcion}: solo se admiten --email y --nombre. ${USO}`);
    }
    const clave = nombre.slice(2);
    if (clave in valores) throw new ErrorEmparejado(`La opción ${nombre} está repetida. ${USO}`);
    let valor: string | undefined;
    if (igual > 0) {
      valor = arg.slice(igual + 1);
    } else {
      valor = argv[i + 1];
      i += 1;
    }
    if (valor === undefined || valor.startsWith('--')) throw new ErrorEmparejado(`Falta el valor de ${nombre}. ${USO}`);
    valores[clave] = valor;
  }
  if (valores.email === undefined) throw new ErrorEmparejado(`Indica el correo del administrador. ${USO}`);
  return { email: valores.email, nombre: valores.nombre };
}

/** 24 caracteres base64url (144 bits): se escribe y se copia sin problemas. */
function contrasenaAleatoria(): string {
  return crypto.randomBytes(18).toString('base64url');
}

interface FilaAdmin {
  id: string;
  email: string;
  name: string;
  client_id: string | null;
}

/** El administrador activo con ese correo o, si no hay, el primero que se creó. */
function administrador(email: string): AuthedUser | null {
  const row = db
    .prepare(
      `SELECT id, email, name, client_id FROM users
       WHERE role = 'admin' AND disabled = 0
       ORDER BY (email = ?) DESC, created_at ASC, id ASC
       LIMIT 1`,
    )
    .get(email) as FilaAdmin | undefined;
  return row ? { id: row.id, email: row.email, name: row.name, role: 'admin', clientId: row.client_id } : null;
}

/**
 * Antes de tocar nada: si el panel tiene usuarios pero ningún administrador
 * activo, no hay a quién darle el token y no se crea otro administrador.
 */
function comprobarAdministrador(email: string): void {
  if (!administrador(email) && countUsers() > 0) {
    throw new ErrorEmparejado(
      'El panel ya tiene usuarios, pero ningún administrador activo. Restablece el acceso de un administrador antes de emparejar.',
    );
  }
}

/** El administrador que se usará; lo crea si la instancia aún no tiene usuarios. */
function asegurarAdministrador(email: string, nombre: string): { admin: AuthedUser; password?: string } {
  const existente = administrador(email);
  if (existente) return { admin: existente };
  const password = contrasenaAleatoria();
  try {
    const admin = createFirstAdmin({ email, name: nombre, password });
    auditSystem('setup.admin_created', { email: admin.email, origen: ORIGEN });
    return { admin, password };
  } catch (err) {
    // Otro proceso (el asistente en el navegador) se ha adelantado: vale el suyo.
    if (!(err instanceof HttpError && err.code === 'admin_exists')) throw err;
    const otro = administrador(email);
    if (otro) return { admin: otro };
    throw new ErrorEmparejado(
      'El panel ya tiene usuarios, pero ningún administrador activo. Restablece el acceso de un administrador antes de emparejar.',
    );
  }
}

function avisoRecomendados(outcome: RecommendedOutcome): string | null {
  if (outcome.applied) {
    // Stalwart 0.16 guarda algunos cambios (un puerto nuevo) que solo aplica al reiniciar.
    return outcome.restartRequired.length > 0
      ? `El motor necesita reiniciarse para aplicar: ${outcome.restartRequired.join('; ')}.`
      : null;
  }
  const motivo = outcome.error || outcome.errors.join('; ');
  return `El motor no aceptó todos los ajustes recomendados${motivo ? ` (${motivo})` : ''}. Repítelo en Ajustes → Servidor de correo.`;
}

/**
 * Identidad y motor desde el entorno, ajustes recomendados y fin de la puesta
 * en marcha. Nada de esto hace fallar el emparejado: lo que no se pueda hacer
 * queda en los avisos y el asistente del panel lo retoma al entrar.
 */
async function completarPuestaEnMarcha(avisos: string[]): Promise<void> {
  // Lo que falte, y lo que el instalador haya cambiado (otro dominio, otra
  // IP) en los campos que nadie ha tocado en el panel. Sin esto, el panel se
  // quedaba con los nombres de la primera instalación y los ajustes
  // recomendados de abajo devolvían el motor al nombre anterior.
  const identidad = sincronizarIdentidadConEntorno({ rellenar: true });
  avisos.push(...identidad.avisos);
  if (identidad.rellenados.length > 0) auditSystem('setup.instance_configured', { origen: ORIGEN });
  if (identidad.cambios.length > 0) {
    auditSystem('settings.instance_env_adopted', { cambios: detalleDeCambios(identidad.cambios), origen: ORIGEN });
  }

  let recommended: RecommendedOutcome | null = null;
  if (!engineConfigured()) {
    const env = engineFromEnv();
    // Dónde se retoma lo que falte al entrar en el panel.
    const dondeSeguir = isSetupComplete()
      ? 'Conéctalo en Ajustes → Servidor de correo.'
      : 'Al entrar en el panel, el asistente de puesta en marcha continúa en el paso del motor.';
    if (!env) {
      avisos.push(
        `El entorno del panel no define el motor de correo (STALWART_URL y STALWART_ADMIN_PASSWORD). ${dondeSeguir}`,
      );
    } else {
      try {
        recommended = await connectEngine(env);
        auditSystem('setup.engine_configured', {
          kind: env.kind,
          url: env.url,
          fromEnv: true,
          recommendedApplied: recommended?.applied ?? false,
          origen: ORIGEN,
        });
      } catch (err) {
        const motivo = scrub((err as Error).message, env.adminPassword);
        avisos.push(`${motivo} ${dondeSeguir}`);
      }
    }
  } else {
    // Ya conectado (por el asistente o por un emparejado anterior): no se
    // cambia, solo se le vuelven a fijar los ajustes recomendados.
    recommended = await applyRecommendedQuietly(getEngineSettings());
    if (recommended) {
      auditSystem('engine.recommended_applied', {
        hostname: recommended.hostname,
        errors: recommended.errors.length + (recommended.error ? 1 : 0),
        origen: ORIGEN,
      });
    }
  }
  if (recommended) {
    const aviso = avisoRecomendados(recommended);
    if (aviso) avisos.push(aviso);
  } else if (engineConfigured() && getEngineSettings()?.kind === 'stalwart' && !getInstanceSettings().mailHostname) {
    avisos.push(
      'No se han aplicado los ajustes recomendados del motor: falta el nombre del servidor de correo (MAILWAY_MAIL_HOSTNAME).',
    );
  }

  if (!engineConfigured()) return;
  if (!isSetupComplete()) {
    markSetupComplete();
    auditSystem('setup.completed', { origen: ORIGEN });
  }
}

/**
 * Sustituye el token «Skyway»: revoca los activos con ese nombre (de
 * cualquier administrador, para que nunca queden dos vivos) y crea uno nuevo
 * sin caducidad para el administrador indicado, todo en una transacción.
 */
function renovarTokenSkyway(admin: AuthedUser): string {
  return db.transaction(() => {
    for (const anterior of activeAdminTokensNamed(NOMBRE_TOKEN_SKYWAY)) {
      revokeManagementToken(anterior.id);
      const detalle: Record<string, unknown> = {
        id: anterior.id,
        name: anterior.name,
        prefix: anterior.prefix,
        origen: ORIGEN,
      };
      if (anterior.userId !== admin.id) detalle.owner = anterior.ownerEmail;
      auditSystem('token.revoked', detalle);
    }
    const { token, info } = createManagementToken({
      userId: admin.id,
      name: NOMBRE_TOKEN_SKYWAY,
      expiresAt: null,
    });
    auditSystem('token.created', {
      id: info.id,
      name: info.name,
      prefix: info.prefix,
      expiresAt: null,
      origen: ORIGEN,
    });
    return token;
  })();
}

/**
 * El administrador (si hay que crearlo) y el token «Skyway», a la vez: si
 * algo falla, no queda ni la cuenta ni el token, y repetir el emparejado
 * vuelve a empezar. La contraseña sale solo en la línea JSON final.
 */
function administradorYToken(email: string, nombre: string): { admin: AuthedUser; password?: string; token: string } {
  return db.transaction(() => {
    const { admin, password } = asegurarAdministrador(email, nombre);
    return { admin, password, token: renovarTokenSkyway(admin) };
  })();
}

/** El emparejado completo; la herramienta de terminal solo le añade la entrada y la salida. */
export async function emparejar(opciones: OpcionesEmparejado): Promise<ResultadoEmparejado> {
  const { email, nombre } = opcionesSchema.parse(opciones);
  const avisos: string[] = [];
  comprobarAdministrador(email);
  await completarPuestaEnMarcha(avisos);
  const { admin, password, token } = administradorYToken(email, nombre);
  if (config.demoMode) {
    avisos.push('El panel está en modo demostración (MAILWAY_DEMO=1): no gestiona ningún motor de correo real.');
  }
  const resultado: ResultadoEmparejado = { adminEmail: admin.email, token, avisos };
  if (password) resultado.adminPassword = password;
  return resultado;
}

function mensajeDeError(err: unknown): string {
  if (err instanceof ZodError) return err.issues[0]?.message ?? 'Datos no válidos.';
  if (err instanceof ErrorEmparejado || err instanceof HttpError) return err.message;
  return `No se pudo completar el emparejado: ${(err as Error)?.message || String(err)}`;
}

/** Escribe y termina cuando la línea ha salido entera (la lee otro programa). */
function terminar(codigo: number, salida: string, errores: string): void {
  if (errores) process.stderr.write(errores);
  if (salida) process.stdout.write(salida, () => process.exit(codigo));
  else process.exit(codigo);
}

async function main(): Promise<void> {
  try {
    const resultado = await emparejar(leerArgumentos(process.argv.slice(2)));
    const linea: Record<string, string> = { adminEmail: resultado.adminEmail };
    if (resultado.adminPassword) linea.adminPassword = resultado.adminPassword;
    linea.token = resultado.token;
    const avisos = resultado.avisos.map((aviso) => `Aviso: ${aviso}\n`).join('');
    terminar(0, `${JSON.stringify(linea)}\n`, avisos);
  } catch (err) {
    terminar(1, '', `${mensajeDeError(err)}\n`);
  }
}

if (require.main === module) void main();
