import { db, now } from '../core/db';
import { generateMailboxPassword } from '../core/crypto';
import { HttpError } from '../core/errors';
import { normalizeHostname } from '../core/hostnames';
import { getEngine } from '../engine';
import type { EngineApi, MailEngine } from '../engine/types';
import { fireAlert } from './alerts';
import { auditSystem } from './audit';
import { runLimited } from './clients';
import { publicBaseUrl } from './connection';
import {
  apiDeCredencial,
  buzonesSinCopia,
  capturarCredenciales,
  esDeOtroMotor,
  recuentoCopias,
  type RecuentoCopias,
} from './credenciales';
import {
  ajustesRecomendadosAplicados,
  applyRecommendedEngineSettings,
  etiquetaComprobacion,
  trustedEngineNetworks,
} from './engineops';
import { estadoMantenimiento } from './mantenimiento';
import { NOMBRE_REMITENTE_CONFIGURACION, asegurarRemitenteConfiguracion } from './remitente';
import { getEngineSettings, getInstanceSettings } from './settings';
import {
  cifrarCredencialSmtp,
  describeSmtpError,
  forgetTransport,
  getTransport,
} from './transactional';
import { corsPermisivoNecesario } from './webmailmotor';

/**
 * Cambio de versión del motor de correo (Stalwart 0.15 → 0.16, o la vuelta
 * atrás): lo que hace el panel antes, durante y después. Lo usa la
 * herramienta de terminal tools/motor.ts, que el instalador ejecuta dentro
 * del contenedor del panel.
 *
 * Todo trabaja con el motor SIN el guardián del mantenimiento (la migración
 * ocurre precisamente durante él) y es idempotente: repetir una orden no
 * rehace lo que ya está hecho, así que el instalador puede reintentar.
 */

/** El motor configurado, sin el guardián del modo mantenimiento. */
export function motorDeMigracion(): MailEngine {
  return getEngine({ saltarMantenimiento: true });
}

const NOMBRES_API: Record<EngineApi, string> = {
  rest015: 'Stalwart 0.15 (API REST)',
  jmap016: 'Stalwart 0.16 (JMAP)',
  demo: 'el motor de demostración',
};

function mensaje(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Lista de direcciones para un texto: las primeras y cuántas faltan. */
function enumerar(direcciones: string[], maximo = 20): string {
  const vistas = direcciones.slice(0, maximo).join(', ');
  return direcciones.length > maximo ? `${vistas} y ${direcciones.length - maximo} más` : vistas;
}

/* --------------------------------- Estado --------------------------------- */

export interface EstadoCambioMotor {
  ok: boolean;
  error?: string;
  api: EngineApi | null;
  mantenimiento: { activo: boolean; hasta: number | null };
  buzones: RecuentoCopias;
  /** Contraseñas de aplicación de dispositivos y Skyway sin revocar. */
  contrasenasAplicacion: {
    /** Las que funcionan, por API del motor en que se crearon (las anteriores a la copia local cuentan como rest015). */
    porApi: Record<string, number>;
    /** Las que dejaron de funcionar al cambiar de motor. */
    invalidadas: number;
  };
  /** Credenciales SMTP internas de las claves de API activas y de los formularios. */
  credencialesInternas: {
    porApi: Record<string, number>;
    invalidadas: number;
  };
}

function contarPorApi(filas: { api: string | null; invalidada: number | null }[]): {
  porApi: Record<string, number>;
  invalidadas: number;
} {
  const porApi: Record<string, number> = {};
  let invalidadas = 0;
  for (const fila of filas) {
    if (fila.invalidada !== null) {
      invalidadas += 1;
      continue;
    }
    const api = apiDeCredencial(fila.api);
    porApi[api] = (porApi[api] ?? 0) + 1;
  }
  return { porApi, invalidadas };
}

/** Qué API habla el motor y cuánto de lo que depende de ella hay en el panel. */
export async function estadoCambioMotor(engine?: MailEngine): Promise<EstadoCambioMotor> {
  const mantenimiento = estadoMantenimiento();
  const aplicacion = db
    .prepare(
      'SELECT engine_api AS api, invalidated_at AS invalidada FROM app_passwords WHERE revoked_at IS NULL',
    )
    .all() as { api: string | null; invalidada: number | null }[];
  const internas = db
    .prepare(
      `SELECT smtp_engine_api AS api, smtp_invalidated_at AS invalidada FROM api_keys WHERE revoked_at IS NULL
       UNION ALL SELECT smtp_engine_api AS api, smtp_invalidated_at AS invalidada FROM forms`,
    )
    .all() as { api: string | null; invalidada: number | null }[];
  const estado: EstadoCambioMotor = {
    ok: true,
    api: null,
    mantenimiento: { activo: mantenimiento.activo, hasta: mantenimiento.hasta },
    buzones: recuentoCopias(),
    contrasenasAplicacion: contarPorApi(aplicacion),
    credencialesInternas: contarPorApi(internas),
  };
  try {
    estado.api = await (engine ?? motorDeMigracion()).detectApi();
  } catch (err) {
    estado.ok = false;
    estado.error = mensaje(err);
  }
  return estado;
}

/* -------------------------------- Captura --------------------------------- */

export interface ResultadoCapturaMigracion {
  ok: boolean;
  error?: string;
  capturados: number;
  yaEstaban: number;
  fallidos: string[];
}

/**
 * Copia final de los hashes antes de migrar: TODOS los buzones, también los
 * que ya tenían copia (si el hash cambió en el motor, se actualiza). Solo con
 * Stalwart 0.15: 0.16 no los da.
 */
export async function capturarParaMigrar(engine?: MailEngine): Promise<ResultadoCapturaMigracion> {
  const vacio = { capturados: 0, yaEstaban: 0, fallidos: [] as string[] };
  let api: EngineApi;
  try {
    const motor = engine ?? motorDeMigracion();
    api = await motor.detectApi();
    if (api !== 'rest015') {
      return {
        ok: false,
        error: `El motor es ${NOMBRES_API[api]}: los hashes de las contraseñas solo se pueden copiar de Stalwart 0.15.`,
        ...vacio,
      };
    }
    const resultado = await capturarCredenciales({ engine: motor, soloFaltantes: false });
    auditSystem('engine.credentials_captured', {
      capturados: resultado.capturados,
      yaEstaban: resultado.yaEstaban,
      fallidos: resultado.fallidos.length,
    });
    const ok = resultado.fallidos.length === 0;
    return {
      ok,
      ...(ok
        ? {}
        : {
            error: `No se ha podido copiar la contraseña de ${resultado.fallidos.length} buzón(es): ${enumerar(resultado.fallidos)}. Sin copia, sus titulares no podrán entrar en «Mi buzón» tras migrar hasta que se restablezca su contraseña.`,
          }),
      capturados: resultado.capturados,
      yaEstaban: resultado.yaEstaban,
      fallidos: resultado.fallidos,
    };
  } catch (err) {
    return { ok: false, error: mensaje(err), ...vacio };
  }
}

/* ------------------------------- Provisión -------------------------------- */

export interface ResultadoProvision {
  ok: boolean;
  error?: string;
  api: EngineApi | null;
  /** Lo que se ha fijado en el motor (descripción legible). */
  aplicados: string[];
  /** Avisos de la recarga del motor: no son errores. */
  avisos: string[];
  /** Cambios guardados que exigen reiniciar el contenedor del motor (no es un error: se reinicia y se repite). */
  restartRequired: string[];
  errores: string[];
  suspensiones: { reaplicadas: number; fallidas: string[] };
  faltan: { dominios: string[]; buzones: string[]; alias: string[] };
}

/**
 * Deja el motor (recién migrado, quizá en modo recuperación) como lo necesita
 * Mailway y comprueba que no falta nada:
 * 1. ajustes recomendados con el nombre del servidor de la instancia;
 * 2. las suspensiones de nuevo (el script oficial de migración no conserva
 *    roles ni permisos: los buzones suspendidos vuelven activos), ANTES de
 *    abrir los puertos;
 * 3. que cada dominio, buzón y alias de la base del panel existe en el motor.
 */
export async function provisionarMotor(engine?: MailEngine): Promise<ResultadoProvision> {
  const resultado: ResultadoProvision = {
    ok: false,
    api: null,
    aplicados: [],
    avisos: [],
    restartRequired: [],
    errores: [],
    suspensiones: { reaplicadas: 0, fallidas: [] },
    faltan: { dominios: [], buzones: [], alias: [] },
  };
  let motor: MailEngine;
  try {
    motor = engine ?? motorDeMigracion();
    resultado.api = await motor.detectApi();
  } catch (err) {
    resultado.errores.push(mensaje(err));
    return cerrarProvision(resultado);
  }
  if (resultado.api === 'demo') {
    resultado.errores.push('El panel está en modo demostración: no hay ningún motor real que provisionar.');
    return cerrarProvision(resultado);
  }

  // 1. Ajustes recomendados, y lo que el motor dice que tiene después.
  const host = normalizeHostname(getInstanceSettings().mailHostname);
  if (!host) {
    resultado.errores.push(
      'Falta el nombre del servidor de correo (MAILWAY_MAIL_HOSTNAME o Ajustes → Identidad del servidor): sin él no se pueden aplicar los ajustes recomendados.',
    );
  } else {
    try {
      const aplicado = await applyRecommendedEngineSettings(host, motor);
      resultado.aplicados.push(...aplicado.applied);
      resultado.avisos.push(...aplicado.warnings);
      resultado.restartRequired.push(...aplicado.restartRequired);
      resultado.errores.push(...aplicado.errors);
    } catch (err) {
      resultado.errores.push(`No se han podido aplicar los ajustes recomendados: ${mensaje(err)}`);
    }
    try {
      const estado = await motor.getSettingsStatus({
        trustedNetworks: trustedEngineNetworks(),
        permissiveCors: corsPermisivoNecesario(),
      });
      for (const cambio of estado.restartRequired) {
        if (!resultado.restartRequired.includes(cambio)) resultado.restartRequired.push(cambio);
      }
      if (!ajustesRecomendadosAplicados(estado, host)) {
        resultado.errores.push(...ajustesPendientes(estado, host, resultado.restartRequired.length > 0));
      }
    } catch (err) {
      resultado.errores.push(`No se ha podido leer el estado del motor tras aplicar los ajustes: ${mensaje(err)}`);
    }
  }

  // 2. Suspensiones: el efectivo es «suspendido si lo está el buzón o su cliente».
  const suspendidos = (
    db
      .prepare(
        `SELECT m.local_part || '@' || d.domain AS email
         FROM mailboxes m JOIN domains d ON d.id = m.domain_id JOIN clients c ON c.id = d.client_id
         WHERE m.status = 'suspended' OR c.suspended = 1
         ORDER BY email`,
      )
      .all() as { email: string }[]
  ).map((f) => f.email);
  await runLimited(suspendidos, 4, async (email) => {
    try {
      await motor.updateMailbox(email, { suspended: true });
      resultado.suspensiones.reaplicadas += 1;
    } catch (err) {
      resultado.suspensiones.fallidas.push(email);
      resultado.errores.push(`No se ha podido suspender ${email}: ${mensaje(err)}`);
    }
  });
  resultado.suspensiones.fallidas.sort();

  // 3. Lo que tiene el panel frente a lo que tiene el motor.
  try {
    const directorio = await motor.listDirectory();
    const dominios = new Set(directorio.domains.map((d) => d.toLowerCase()));
    const cuentas = new Set(directorio.accounts.map((c) => c.toLowerCase()));
    const listas = new Set(directorio.lists.map((l) => l.toLowerCase()));
    const deLaBase = (sql: string) => (db.prepare(sql).all() as { nombre: string }[]).map((f) => f.nombre.toLowerCase());
    resultado.faltan.dominios = deLaBase('SELECT domain AS nombre FROM domains ORDER BY domain').filter((d) => !dominios.has(d));
    resultado.faltan.buzones = deLaBase(
      `SELECT m.local_part || '@' || d.domain AS nombre FROM mailboxes m JOIN domains d ON d.id = m.domain_id ORDER BY nombre`,
    ).filter((b) => !cuentas.has(b));
    resultado.faltan.alias = deLaBase(
      `SELECT a.local_part || '@' || d.domain AS nombre FROM aliases a JOIN domains d ON d.id = a.domain_id ORDER BY nombre`,
    ).filter((a) => !listas.has(a));

    // Una cuenta remitente (configuration@) que no llegó al motor no es un
    // fallo de la migración: se olvida y el próximo correo de configuración
    // la vuelve a crear con una contraseña nueva.
    const remitentes = db
      .prepare(
        `SELECT r.domain_id, d.domain FROM remitentes_configuracion r JOIN domains d ON d.id = r.domain_id`,
      )
      .all() as { domain_id: string; domain: string }[];
    for (const remitente of remitentes) {
      const email = `configuration@${remitente.domain}`.toLowerCase();
      if (cuentas.has(email)) continue;
      db.prepare('DELETE FROM remitentes_configuracion WHERE domain_id = ?').run(remitente.domain_id);
      resultado.aplicados.push(`Cuenta remitente ${email}: no está en el motor; se creará de nuevo con el próximo correo de configuración`);
    }
  } catch (err) {
    resultado.errores.push(`No se ha podido leer lo que tiene el motor dado de alta: ${mensaje(err)}`);
  }

  return cerrarProvision(resultado);
}

/** Qué ajustes recomendados no están aplicados, en frases. */
function ajustesPendientes(
  estado: Awaited<ReturnType<MailEngine['getSettingsStatus']>>,
  host: string,
  hayReinicioPendiente: boolean,
): string[] {
  const pendientes: string[] = [];
  const guardado = normalizeHostname(estado.hostname ?? '');
  if (guardado !== host) {
    pendientes.push(`El motor tiene guardado el nombre ${guardado || '(ninguno)'} en lugar de ${host}.`);
  }
  if (!estado.forwardedHeaders) pendientes.push('El motor no toma la IP real de X-Forwarded-For.');
  for (const red of trustedEngineNetworks()) {
    if (!estado.trustedNetworks.includes(red)) pendientes.push(`La red ${red} no está exenta del bloqueo automático.`);
  }
  // Lo que espera a un reinicio (un puerto nuevo) no es un error: el
  // instalador reinicia el motor y vuelve a provisionar.
  if (!hayReinicioPendiente) {
    for (const [clave, ok] of Object.entries(estado.extra)) {
      if (!ok) pendientes.push(`${etiquetaComprobacion(clave)}: sin aplicar en el motor.`);
    }
  }
  return pendientes;
}

function cerrarProvision(resultado: ResultadoProvision): ResultadoProvision {
  const faltan = resultado.faltan;
  const nFaltan = faltan.dominios.length + faltan.buzones.length + faltan.alias.length;
  resultado.ok = resultado.errores.length === 0 && resultado.suspensiones.fallidas.length === 0 && nFaltan === 0;
  if (!resultado.ok) {
    const partes: string[] = [];
    if (resultado.errores.length > 0) partes.push(resultado.errores[0]!);
    if (nFaltan > 0) {
      partes.push(
        `Faltan en el motor ${faltan.dominios.length} dominio(s), ${faltan.buzones.length} buzón(es) y ${faltan.alias.length} alias del panel.`,
      );
    }
    resultado.error = partes.join(' ');
  }
  auditSystem('engine.provisioned', {
    api: resultado.api,
    ok: resultado.ok,
    errores: resultado.errores.length,
    suspensiones: resultado.suspensiones.reaplicadas,
    faltan: nFaltan,
    restartRequired: resultado.restartRequired.length,
  });
  return resultado;
}

/* ---------------------------- Tras la migración ---------------------------- */

export interface ResultadoTrasMigrar {
  ok: boolean;
  error?: string;
  api: EngineApi | null;
  /** Credenciales SMTP internas (claves de API y formularios) renovadas en el motor nuevo. */
  credencialesInternas: { renovadas: number; fallidas: string[] };
  /** Contraseñas de aplicación de dispositivos y Skyway marcadas como invalidadas en esta ejecución. */
  contrasenasInvalidadas: number;
  /** Buzones cuyo titular ha recibido en esta ejecución el aviso por correo. */
  avisados: number;
  /** Buzones a los que no se ha podido enviar el aviso (se reintenta al repetir la orden). */
  avisosFallidos: string[];
  /** Buzones sin copia local del hash: no pueden entrar en «Mi buzón» hasta restablecer su contraseña. */
  sinCopia: number;
}

interface FilaInterna {
  id: string;
  nombre: string;
  etiqueta: string;
  email: string;
  smtp_engine_api: string | null;
}

/**
 * Tareas posteriores a cambiar de versión el motor. Idempotente:
 * 1. renueva en el motor nuevo la credencial SMTP interna de cada clave de
 *    API y de cada formulario creada en otro (la anterior ya no existe: 0.16
 *    descarta al migrar todas las contraseñas de aplicación de 0.15);
 * 2. marca como invalidadas las contraseñas de aplicación de dispositivos y
 *    servicios de Skyway creadas en otro motor: las ve el panel, «Mi buzón»
 *    y Skyway (`invalidatedAt`), que vuelve a conectar sus servicios;
 * 3. abre UN aviso para la administración con los buzones afectados;
 * 4. avisa por correo a cada titular afectado (desde configuration@ de su
 *    dominio), salvo de las de Skyway, que no creó él.
 */
export async function trasMigrarMotor(
  engine?: MailEngine,
  opciones: { avisarPorCorreo?: boolean } = {},
): Promise<ResultadoTrasMigrar> {
  const resultado: ResultadoTrasMigrar = {
    ok: false,
    api: null,
    credencialesInternas: { renovadas: 0, fallidas: [] },
    contrasenasInvalidadas: 0,
    avisados: 0,
    avisosFallidos: [],
    sinCopia: 0,
  };
  let motor: MailEngine;
  let api: EngineApi;
  try {
    motor = engine ?? motorDeMigracion();
    api = await motor.detectApi();
    resultado.api = api;
  } catch (err) {
    resultado.error = mensaje(err);
    return resultado;
  }
  if (api === 'demo') {
    resultado.error = 'El panel está en modo demostración: no hay ningún motor real que haya cambiado de versión.';
    return resultado;
  }

  // 1. Credenciales SMTP internas.
  const claves = (
    db
      .prepare(
        `SELECT k.id, k.name AS nombre, 'mailway-' || k.prefix AS etiqueta, k.smtp_engine_api,
                m.local_part || '@' || d.domain AS email
         FROM api_keys k JOIN mailboxes m ON m.id = k.sender_mailbox_id JOIN domains d ON d.id = m.domain_id
         WHERE k.revoked_at IS NULL`,
      )
      .all() as FilaInterna[]
  ).filter((f) => esDeOtroMotor(f.smtp_engine_api, api));
  const formularios = (
    db
      .prepare(
        `SELECT f.id, f.name AS nombre, 'mailway-form-' || substr(f.id, 5, 8) AS etiqueta, f.smtp_engine_api,
                m.local_part || '@' || d.domain AS email
         FROM forms f JOIN mailboxes m ON m.id = f.recipient_mailbox_id JOIN domains d ON d.id = m.domain_id`,
      )
      .all() as FilaInterna[]
  ).filter((f) => esDeOtroMotor(f.smtp_engine_api, api));
  const renovar = async (tabla: 'api_keys' | 'forms', fila: FilaInterna, descripcion: string) => {
    try {
      const { secret, ref } = await motor.addAppPassword(fila.email, fila.etiqueta, generateMailboxPassword(24));
      db.prepare(
        `UPDATE ${tabla} SET smtp_password_enc = ?, smtp_engine_api = ?, smtp_invalidated_at = NULL WHERE id = ?`,
      ).run(cifrarCredencialSmtp(secret, ref), api, fila.id);
      resultado.credencialesInternas.renovadas += 1;
    } catch (err) {
      // Sin credencial que funcione, la clave o el formulario no pueden
      // enviar: queda marcado y repetir la orden lo vuelve a intentar.
      db.prepare(`UPDATE ${tabla} SET smtp_invalidated_at = COALESCE(smtp_invalidated_at, ?) WHERE id = ?`).run(
        now(),
        fila.id,
      );
      resultado.credencialesInternas.fallidas.push(`${descripcion} «${fila.nombre}» (${fila.email}): ${mensaje(err)}`);
    }
  };
  for (const fila of claves) await renovar('api_keys', fila, 'Clave de API');
  for (const fila of formularios) await renovar('forms', fila, 'Formulario');

  // 2. Contraseñas de aplicación de dispositivos y Skyway.
  const muertas = (
    db
      .prepare(
        `SELECT ap.id, ap.engine_api, ap.mailbox_id, m.local_part || '@' || d.domain AS email, d.client_id
         FROM app_passwords ap JOIN mailboxes m ON m.id = ap.mailbox_id JOIN domains d ON d.id = m.domain_id
         WHERE ap.revoked_at IS NULL AND ap.invalidated_at IS NULL`,
      )
      .all() as { id: string; engine_api: string | null; mailbox_id: string; email: string; client_id: string }[]
  ).filter((f) => esDeOtroMotor(f.engine_api, api));
  if (muertas.length > 0) {
    const t = now();
    const marcar = db.prepare('UPDATE app_passwords SET invalidated_at = ? WHERE id = ? AND invalidated_at IS NULL');
    db.transaction(() => {
      for (const fila of muertas) resultado.contrasenasInvalidadas += marcar.run(t, fila.id).changes;
    })();
    // En la actividad de cada cliente, sin secretos: qué buzones se vieron afectados.
    const porCliente = new Map<string, Set<string>>();
    for (const fila of muertas) {
      if (!porCliente.has(fila.client_id)) porCliente.set(fila.client_id, new Set());
      porCliente.get(fila.client_id)!.add(fila.email);
    }
    for (const [clientId, buzones] of porCliente) {
      auditSystem(
        'engine.app_passwords_invalidated',
        { api, contrasenas: muertas.filter((f) => f.client_id === clientId).length, buzones: [...buzones].sort() },
        clientId,
      );
    }
    // 3. Un solo aviso para la administración.
    const afectados = [...new Set(muertas.map((f) => f.email))].sort();
    fireAlert({
      severity: 'warning',
      type: 'engine_app_passwords_invalidated',
      dedupeKey: `engine_app_passwords_invalidated:${api}`,
      title: `${afectados.length === 1 ? 'Un buzón ha perdido' : `${afectados.length} buzones han perdido`} sus contraseñas de aplicación con la actualización del servidor de correo`,
      message: `Con el cambio a ${NOMBRES_API[api]} dejaron de funcionar ${muertas.length} contraseña(s) de aplicación creadas antes. Buzones afectados: ${enumerar(afectados, 30)}.`,
      remedy:
        'Cada titular puede crear una nueva en «Mi buzón», donde se le avisa; desde el panel, en la ficha de cada buzón. Las de los servicios de Skyway se vuelven a conectar desde el proyecto de Skyway («Conectar a un servicio»). Las claves de API y los formularios ya se han renovado solos.',
    });
  }

  // Buzones sin copia del hash: con 0.16 no pueden entrar en «Mi buzón».
  const sinCopia = api === 'jmap016' ? buzonesSinCopia() : [];
  resultado.sinCopia = sinCopia.length;
  if (sinCopia.length > 0) {
    fireAlert({
      severity: 'warning',
      type: 'engine_password_copy_missing',
      dedupeKey: 'engine_password_copy_missing',
      title: `${sinCopia.length === 1 ? 'Un buzón no tiene' : `${sinCopia.length} buzones no tienen`} copia de su contraseña en el panel`,
      message: `El panel no pudo copiar su contraseña antes de migrar y Stalwart 0.16 ya no la da: sus titulares no pueden entrar en «Mi buzón» ni cambiar la contraseña desde el webmail (el correo sigue funcionando). Buzones: ${enumerar(sinCopia, 30)}.`,
      remedy: 'Restablece la contraseña de esos buzones desde el panel (ficha del buzón → Restablecer contraseña) o con un reinicio de su configuración.',
    });
  }

  // 4. Aviso por correo a los titulares.
  if (opciones.avisarPorCorreo !== false) await avisarTitulares(motor, resultado);

  resultado.ok = resultado.credencialesInternas.fallidas.length === 0;
  if (!resultado.ok) {
    resultado.error = `No se han podido renovar ${resultado.credencialesInternas.fallidas.length} credencial(es) SMTP internas: ${resultado.credencialesInternas.fallidas[0]}`;
  }
  auditSystem('engine.post_migration', {
    api,
    renovadas: resultado.credencialesInternas.renovadas,
    fallidas: resultado.credencialesInternas.fallidas.length,
    contrasenasInvalidadas: resultado.contrasenasInvalidadas,
    avisados: resultado.avisados,
    sinCopia: resultado.sinCopia,
  });
  return resultado;
}

/* ------------------------- Aviso a los titulares --------------------------- */

const FORMATO_FECHA = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Madrid',
});

function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface DatosAvisoInvalidadas {
  email: string;
  domain: string;
  contrasenas: { nombre: string; creadaEn: number }[];
  /** URL de «Mi buzón», o vacía si el panel no tiene URL pública configurada. */
  urlMiBuzon: string;
}

/**
 * Correo al titular cuyas contraseñas de aplicación dejaron de funcionar. Sale
 * del propio dominio (configuration@, «Configura tu correo»), como el correo de
 * configuración: el titular lo reconoce y no menciona la plataforma.
 */
export function componerAvisoInvalidadas(datos: DatosAvisoInvalidadas): { subject: string; text: string; html: string } {
  const lista = datos.contrasenas.map((c) => `«${c.nombre.replace(/\s+/g, ' ').trim()}», creada el ${FORMATO_FECHA.format(c.creadaEn)}`);
  const explicacion = `El servidor de correo de ${datos.domain} se ha actualizado y las contraseñas de aplicación de tu buzón ${datos.email} han dejado de funcionar:`;
  const consecuencia =
    'Los dispositivos y programas que las usaban no pueden recibir ni enviar correo hasta que les pongas una contraseña nueva. Tu contraseña principal no ha cambiado.';
  const accion = datos.urlMiBuzon
    ? 'Crea una contraseña de aplicación nueva para cada uno en «Mi buzón» y escríbela en el dispositivo en lugar de la anterior:'
    : 'Crea una contraseña de aplicación nueva para cada uno en «Mi buzón» (o pídela a la persona que administra tu correo) y escríbela en el dispositivo en lugar de la anterior.';
  const text = [
    'Hola:',
    '',
    explicacion,
    '',
    ...lista.map((l) => `- ${l}`),
    '',
    consecuencia,
    '',
    accion,
    ...(datos.urlMiBuzon ? ['', datos.urlMiBuzon] : []),
    '',
  ].join('\n');
  const e = escaparHtml;
  const fuente = 'font-family:Arial,Helvetica,sans-serif;';
  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(NOMBRE_REMITENTE_CONFIGURACION)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f5f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f5f5;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#ffffff;border:1px solid #dde4e4;border-radius:8px;">
<tr><td style="padding:32px 32px 8px 32px;${fuente}font-size:16px;line-height:24px;color:#1c2727;">
<p style="margin:0 0 16px 0;">Hola:</p>
<p style="margin:0 0 12px 0;">${e(explicacion)}</p>
<ul style="margin:0 0 16px 0;padding-left:20px;">${lista.map((l) => `<li>${e(l)}</li>`).join('')}</ul>
<p style="margin:0 0 16px 0;">${e(consecuencia)}</p>
<p style="margin:0 0 24px 0;">${e(accion)}</p>
</td></tr>
${
  datos.urlMiBuzon
    ? `<tr><td align="center" style="padding:0 32px 32px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" bgcolor="#0d5c5e" style="border-radius:6px;background-color:#0d5c5e;">
<a href="${e(datos.urlMiBuzon)}" style="display:inline-block;padding:12px 28px;${fuente}font-size:16px;line-height:24px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;">Abrir «Mi buzón»</a>
</td>
</tr></table>
</td></tr>`
    : ''
}
</table>
</td></tr>
</table>
</body>
</html>
`;
  return { subject: `Tus contraseñas de aplicación han dejado de funcionar (${datos.email})`, text, html };
}

/**
 * Envía el aviso a cada titular con contraseñas de dispositivo invalidadas y
 * sin avisar (las `skyway:<servicio>` las crea y las renueva Skyway, no el
 * titular). Solo buzones activos, de clientes activos y de dominios con la
 * propiedad comprobada (el remitente sale del dominio). Un fallo no detiene
 * el resto y no marca nada: repetir la orden lo reintenta. «Mi buzón» avisa
 * igualmente al entrar.
 */
async function avisarTitulares(motor: MailEngine, resultado: ResultadoTrasMigrar): Promise<void> {
  const ajustes = getEngineSettings();
  if (!ajustes || ajustes.kind !== 'stalwart') return;
  const pendientes = db
    .prepare(
      `SELECT ap.id, ap.name, ap.created_at, ap.mailbox_id, m.local_part || '@' || d.domain AS email,
              d.id AS domain_id, d.domain
       FROM app_passwords ap
       JOIN mailboxes m ON m.id = ap.mailbox_id
       JOIN domains d ON d.id = m.domain_id
       JOIN clients c ON c.id = d.client_id
       WHERE ap.invalidated_at IS NOT NULL AND ap.revoked_at IS NULL AND ap.invalidation_notified_at IS NULL
         AND ap.name NOT LIKE 'skyway:%'
         AND m.status = 'active' AND c.suspended = 0 AND d.owner_verified_at IS NOT NULL
       ORDER BY email, ap.created_at`,
    )
    .all() as {
    id: string;
    name: string;
    created_at: number;
    mailbox_id: string;
    email: string;
    domain_id: string;
    domain: string;
  }[];
  const porBuzon = new Map<string, typeof pendientes>();
  for (const fila of pendientes) {
    if (!porBuzon.has(fila.mailbox_id)) porBuzon.set(fila.mailbox_id, []);
    porBuzon.get(fila.mailbox_id)!.push(fila);
  }
  const base = publicBaseUrl();
  const { mailHostname } = getInstanceSettings();
  const transportes = new Set<string>();
  try {
    for (const filas of porBuzon.values()) {
      const { email, domain, domain_id: domainId } = filas[0]!;
      try {
        const remitente = await asegurarRemitenteConfiguracion({ id: domainId, domain }, motor);
        const clave = `aviso-motor:${domainId}`;
        transportes.add(clave);
        const transporte = getTransport(clave, remitente.email, remitente.password, ajustes, mailHostname);
        const correo = componerAvisoInvalidadas({
          email,
          domain,
          contrasenas: filas.map((f) => ({ nombre: f.name, creadaEn: f.created_at })),
          urlMiBuzon: base ? `${base}/mi-buzon` : '',
        });
        await transporte.sendMail({
          from: { name: NOMBRE_REMITENTE_CONFIGURACION, address: remitente.email },
          to: email,
          subject: correo.subject,
          text: correo.text,
          html: correo.html,
        });
        const marcar = db.prepare('UPDATE app_passwords SET invalidation_notified_at = ? WHERE id = ?');
        const t = now();
        db.transaction(() => {
          for (const fila of filas) marcar.run(t, fila.id);
        })();
        resultado.avisados += 1;
      } catch (err) {
        const detalle = err instanceof HttpError ? err.message : describeSmtpError(err, mailHostname || ajustes.smtpHost);
        resultado.avisosFallidos.push(`${email}: ${detalle}`);
      }
    }
  } finally {
    // La herramienta termina enseguida: no deja conexiones SMTP abiertas.
    for (const clave of transportes) forgetTransport(clave);
  }
}
