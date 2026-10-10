import { db, now } from '../core/db';
import { HttpError } from '../core/errors';
import { buzonLockKey, mailboxStateLockKey, withLock } from '../core/locks';
import { getEngine } from '../engine';
import type { MailEngine } from '../engine/types';
import { auditSystem } from './audit';
import { runLimited } from './clients';
import { loginParaMotor, nombreEnMotor } from './direcciones';
import { destinosDe, esBuzonDeLaInstancia } from './domains';
import { mantenimientoActivo } from './mantenimiento';
import { getEngineSettings, getSetting, setJsonSetting } from './settings';

/*
 * Corrección única de lo que dejó en el motor la forma anterior de suspender.
 *
 * Hasta ahora el driver de Stalwart 0.15 suspendía un buzón fijándole
 * roles: [] y lo reactivaba fijándole roles: ['user']. En el 0.15.5 real eso
 * tenía dos efectos que el panel no veía:
 * - sin el rol, el buzón pierde también email-receive: el motor acepta el
 *   mensaje en el 25 y después lo devuelve al remitente;
 * - roles, listas y grupos son la misma relación y «set roles» la reescribe
 *   entera: el buzón salía de todos sus alias al suspenderlo y no volvía al
 *   reactivarlo. Un alias cuyos destinos han salido todos acepta el RCPT y
 *   rechaza el mensaje («503 RCPT is required first»).
 * Ahora se suspende quitando solo los permisos de autenticarse, y el rol se
 * añade sin reescribir nada (engine/stalwart.ts), pero lo ya hecho sigue igual
 * hasta que alguien lo toque.
 *
 * Esta tarea, una sola vez (lo recuerda el ajuste AJUSTE_HECHA):
 * 1. vuelve a aplicar la suspensión, con el método actual, a cada buzón
 *    suspendido por sí mismo o por su cliente;
 * 2. vuelve a fijar en el motor los destinos de todos los alias tal y como
 *    están en el panel: no queda rastro de qué buzones se suspendieron o se
 *    reactivaron alguna vez, así que se repasan todos.
 * Se lanza al arrancar el servidor, sin esperarla, y, si el motor no
 * respondía, la repite el vigilante hasta que sale bien. Las dos cosas dejan
 * lo mismo si se repiten, así que un intento a medias se repite entero.
 *
 * Vale para cualquier versión del motor: la migración oficial a Stalwart 0.16
 * copia las listas tal y como están, así que un alias que perdió destinos en
 * 0.15 sigue sin ellos en 0.16 si la corrección no llegó a hacerse antes de
 * migrar. Nunca durante el mantenimiento del motor (su cambio de versión): se
 * deja pendiente, sin avisar, y la hace el vigilante al terminar.
 */

/** Ajuste que recuerda que la corrección ya se hizo: no se repite en cada arranque. */
export const AJUSTE_HECHA = 'engine_suspension_repair';

/**
 * Espera antes de repetir un intento en el que el motor respondió pero algo
 * falló: es un error con ese buzón o alias, no una caída, y repetirlo en cada
 * vuelta del vigilante solo llenaría el registro. Si el motor no respondía,
 * se prueba en la vuelta siguiente: saber si ya responde cuesta una petición.
 */
const ESPERA_TRAS_FALLOS_MS = 10 * 60_000;

/** Peticiones simultáneas al motor, como al suspender un cliente. */
const SIMULTANEAS = 5;

export interface ResultadoReparacion {
  /**
   * `hecha`: no queda nada por corregir (en este intento o en uno anterior).
   * `pendiente`: el motor no respondió o algo falló; se reintentará.
   * `omitida`: sin motor real (modo demostración o sin configurar); no se
   * anota nada, para hacerla cuando lo haya.
   */
  estado: 'hecha' | 'pendiente' | 'omitida';
  /** Buzones a los que se ha vuelto a aplicar la suspensión en este intento. */
  buzones: number;
  /** Alias cuyos destinos se han vuelto a fijar en el motor en este intento. */
  alias: number;
  /**
   * Buzones o alias que no hacía falta tocar (reactivados o borrados
   * entretanto) o que no se pueden corregir desde aquí (el motor no tiene el
   * buzón o alguno de los destinos del alias).
   */
  omitidos: number;
  /** Buzones o alias que el motor no ha podido actualizar en este intento. */
  fallidos: number;
}

/** Registro del servidor: solo recibe recuentos, nunca direcciones. */
export interface RegistroReparacion {
  info(msg: string): void;
  warn(msg: string): void;
}

/** Buzones suspendidos por sí mismos o por su cliente. */
const suspendidosStmt = db.prepare(
  `SELECT m.id, m.local_part, d.domain
   FROM mailboxes m
   JOIN domains d ON d.id = m.domain_id
   JOIN clients c ON c.id = d.client_id
   WHERE m.status = 'suspended' OR c.suspended = 1
   ORDER BY d.domain, m.local_part`,
);

const sigueSuspendidoStmt = db.prepare(
  `SELECT 1 FROM mailboxes m
   JOIN domains d ON d.id = m.domain_id
   JOIN clients c ON c.id = d.client_id
   WHERE m.id = ? AND (m.status = 'suspended' OR c.suspended = 1)`,
);

const aliasStmt = db.prepare(
  `SELECT a.domain_id, a.local_part, d.domain
   FROM aliases a JOIN domains d ON d.id = a.domain_id
   ORDER BY d.domain, a.local_part`,
);

/** Por dirección y no por id: un alias borrado y vuelto a crear es el mismo para el motor. */
const destinosStmt = db.prepare('SELECT destinations_json FROM aliases WHERE domain_id = ? AND local_part = ?');

interface Alias {
  domain_id: string;
  local_part: string;
  domain: string;
}

let registro: RegistroReparacion | null = null;
let enCurso: Promise<ResultadoReparacion> | null = null;
/** Hasta cuándo no se repite tras un intento con fallos (ver ESPERA_TRAS_FALLOS_MS). */
let noAntesDe = 0;
/** El aviso de «el motor no responde» se da una vez por arranque: después ya avisa el vigilante. */
let motorCaidoAvisado = false;

export function reparacionSuspensionesHecha(): boolean {
  return getSetting(AJUSTE_HECHA) !== null;
}

/**
 * Arranque del servidor: primer intento, sin esperarlo (el panel atiende
 * mientras tanto), con el registro del servidor para este intento y los
 * reintentos del vigilante. Nunca lanza: nada de esto puede impedir que el
 * panel arranque.
 */
export function iniciarReparacionSuspensiones(log: RegistroReparacion): void {
  registro = log;
  repararSuspensiones().catch(() => undefined);
}

/**
 * Hace la corrección si sigue pendiente; si ya se hizo, no hace nada. Una sola
 * a la vez: la del arranque puede seguir en marcha cuando llega la primera
 * vuelta del vigilante, que recibe el mismo resultado.
 */
export function repararSuspensiones(): Promise<ResultadoReparacion> {
  if (!enCurso) {
    enCurso = intentar().finally(() => {
      enCurso = null;
    });
  }
  return enCurso;
}

function buzones(n: number): string {
  return `${n} ${n === 1 ? 'buzón suspendido' : 'buzones suspendidos'}`;
}

/** Destinos del alias en el panel ahora mismo (null si ya no existe). */
function destinosActuales(alias: Alias): string | null {
  const row = destinosStmt.get(alias.domain_id, alias.local_part) as { destinations_json: string } | undefined;
  return row ? row.destinations_json : null;
}

/**
 * Fija en el motor los destinos guardados, separados como en el resto del
 * panel. Sin destinos legibles no se toca nada: vaciar la lista dejaría el
 * alias sin entregar a nadie.
 */
async function fijarDestinos(engine: MailEngine, email: string, json: string): Promise<boolean> {
  const destinos = destinosDe(json);
  if (destinos.length === 0) return false;
  const internos = destinos.filter(esBuzonDeLaInstancia);
  // Los miembros van por el usuario del motor de cada buzón, que durante un
  // cambio de dominio puede no ser su dirección (como en mailboxes.ts).
  await engine.upsertAlias(
    email,
    internos.map(nombreEnMotor),
    destinos.filter((d) => !internos.includes(d)),
  );
  return true;
}

/**
 * Vuelve a fijar los destinos de un alias. Las rutas que cambian o borran
 * alias no hacen fila con esta tarea, así que se lee justo antes y se vuelve
 * a mirar después: si una ruta lo cambió o lo borró mientras el motor
 * aplicaba estos destinos, se deja como diga el panel ahora (y no resucita un
 * alias borrado).
 */
async function sincronizarAlias(engine: MailEngine, alias: Alias): Promise<boolean> {
  const email = `${alias.local_part}@${alias.domain}`;
  const antes = destinosActuales(alias);
  if (antes === null || !(await fijarDestinos(engine, email, antes))) return false;
  const despues = destinosActuales(alias);
  if (despues === null) await engine.deleteAlias(email);
  else if (despues !== antes) await fijarDestinos(engine, email, despues);
  return true;
}

async function intentar(): Promise<ResultadoReparacion> {
  const resultado: ResultadoReparacion = { estado: 'pendiente', buzones: 0, alias: 0, omitidos: 0, fallidos: 0 };
  try {
    if (reparacionSuspensionesHecha()) return { ...resultado, estado: 'hecha' };
    // Sin un Stalwart conectado no hay nada que corregir todavía. No se da
    // por hecha: se hará cuando se conecte.
    if (getEngineSettings()?.kind !== 'stalwart') return { ...resultado, estado: 'omitida' };
    // El motor se está cambiando de versión: ningún cambio debe llegarle
    // (el guardián respondería engine_maintenance a cada buzón).
    if (mantenimientoActivo()) return resultado;
    if (Date.now() < noAntesDe) return resultado;

    const suspendidos = (suspendidosStmt.all() as { id: string; local_part: string; domain: string }[]).map(
      (row) => ({ id: row.id, email: `${row.local_part}@${row.domain}` }),
    );
    const alias = aliasStmt.all() as Alias[];
    const total = suspendidos.length + alias.length;
    if (total === 0) {
      setJsonSetting(AJUSTE_HECHA, { completedAt: now(), mailboxes: 0, aliases: 0 });
      return { ...resultado, estado: 'hecha' };
    }

    const engine = getEngine();
    const salud = await engine.ping();
    if (!salud.ok) {
      if (!motorCaidoAvisado) {
        motorCaidoAvisado = true;
        registro?.warn(
          `La corrección de ${buzones(suspendidos.length)} y ${alias.length} alias en el motor queda pendiente: el motor de correo no responde. Se reintentará automáticamente.`,
        );
      }
      return resultado;
    }

    let motorCaido = false;
    let ultimoError = '';
    /** Aplica `tarea` y cuenta el resultado; con el motor caído a mitad, lo que queda se deja para el reintento. */
    const contar = async (tarea: () => Promise<boolean>, corregido: 'buzones' | 'alias'): Promise<void> => {
      if (motorCaido) {
        resultado.fallidos += 1;
        return;
      }
      try {
        if (await tarea()) resultado[corregido] += 1;
        else resultado.omitidos += 1;
      } catch (err) {
        const code = err instanceof HttpError ? err.code : 'error';
        // El motor no tiene ese buzón (o un destino del alias): reintentarlo
        // no lo arregla, y no hay correo que rebote por la suspensión.
        if (code === 'engine_not_found') {
          resultado.omitidos += 1;
          return;
        }
        if (code === 'engine_unreachable') motorCaido = true;
        resultado.fallidos += 1;
        ultimoError = code;
      }
    };

    await runLimited(suspendidos, SIMULTANEAS, (buzon) =>
      contar(
        () =>
          // Mismo orden de filas que el resto del panel: la del usuario del
          // buzón (un cambio de dominio lo puede renombrar) y dentro la de su
          // estado.
          withLock(buzonLockKey(buzon.id), () =>
            withLock(mailboxStateLockKey(buzon.id), async () => {
              // Ya dentro de la fila: un buzón reactivado o borrado entretanto no se toca.
              if (!sigueSuspendidoStmt.get(buzon.id)) return false;
              await engine.updateMailbox(loginParaMotor(buzon.id), { suspended: true });
              return true;
            }),
          ),
        'buzones',
      ),
    );
    await runLimited(alias, SIMULTANEAS, (fila) => contar(() => sincronizarAlias(engine, fila), 'alias'));

    if (resultado.fallidos > 0) {
      if (!motorCaido) noAntesDe = Date.now() + ESPERA_TRAS_FALLOS_MS;
      registro?.warn(
        `La corrección de los buzones suspendidos y los alias en el motor queda pendiente para ${resultado.fallidos} de ${total} (${ultimoError}). Se reintentará ${motorCaido ? 'cuando el motor responda' : 'en 10 minutos'}.`,
      );
      return resultado;
    }

    setJsonSetting(AJUSTE_HECHA, { completedAt: now(), mailboxes: resultado.buzones, aliases: resultado.alias });
    noAntesDe = 0;
    if (resultado.buzones > 0 || resultado.alias > 0) {
      auditSystem('engine.suspensions_repaired', {
        mailboxes: resultado.buzones,
        aliasesUpdated: resultado.alias,
        skipped: resultado.omitidos,
      });
      registro?.info(
        `Corrección aplicada en el motor: ${buzones(resultado.buzones)} y ${resultado.alias} alias. Los buzones suspendidos siguen sin poder iniciar sesión y su correo ya no se devuelve al remitente.`,
      );
    }
    return { ...resultado, estado: 'hecha' };
  } catch (err) {
    // Un fallo inesperado (la base de datos, la clave maestra) no puede tumbar
    // el servidor ni el vigilante: se deja pendiente y se reintenta más tarde.
    noAntesDe = Date.now() + ESPERA_TRAS_FALLOS_MS;
    registro?.warn(`La corrección de los buzones suspendidos y los alias en el motor queda pendiente: ${(err as Error).message}`);
    return resultado;
  }
}
