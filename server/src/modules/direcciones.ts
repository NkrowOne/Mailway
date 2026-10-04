import { db } from '../core/db';
import { HttpError, conflict, notFound } from '../core/errors';
import { buzonLockKey, cambioLockKey, withLock } from '../core/locks';
import { getEngine } from '../engine';
import { fireAlert, resolveAlert } from './alerts';
import { auditSystem } from './audit';

/**
 * Usuario del motor, direcciones y cambios de dominio abiertos.
 *
 * Stalwart 0.15 solo autentica por el nombre del principal. Durante un cambio
 * de dominio la dirección de un buzón ya es la nueva (mailbox.email) mientras
 * sus dispositivos siguen entrando con el nombre viejo: ese nombre se guarda
 * en `mailboxes.usuario_motor`, y TODA llamada al motor que identifica un
 * buzón usa `loginParaMotor()` en vez de la dirección. `usuario_motor` no nulo
 * significa «Pendiente de actualizar dispositivos».
 *
 * Este módulo solo depende de la base, el motor, las alertas y la auditoría:
 * lo importan los buzones, los clientes, el portal y los dominios, y así no
 * crea ciclos con ellos.
 */

/** Estados en los que un cambio de dominio ya no está abierto. */
const CERRADOS = `('dado_de_baja', 'cancelada')`;

export interface FilaUsuario {
  usuario_motor: string | null;
  local_part: string;
  domain: string;
}

/** Usuario del motor para mostrar: usuario_motor ?? local@dominio. */
export function loginDe(fila: FilaUsuario): string {
  return fila.usuario_motor ?? `${fila.local_part}@${fila.domain}`;
}

interface FilaBuzon extends FilaUsuario {
  id: string;
  domain_id: string;
  client_id: string;
  usuario_cambiando_a: string | null;
  login_anterior: string | null;
}

const SELECT_BUZON = `SELECT m.id, m.local_part, m.domain_id, m.usuario_motor, m.usuario_cambiando_a,
    m.login_anterior, d.domain, d.client_id
  FROM mailboxes m JOIN domains d ON d.id = m.domain_id`;

function leerBuzon(mailboxId: string): FilaBuzon | null {
  return (db.prepare(`${SELECT_BUZON} WHERE m.id = ?`).get(mailboxId) as FilaBuzon | undefined) ?? null;
}

function direccionDe(fila: FilaUsuario): string {
  return `${fila.local_part}@${fila.domain}`;
}

function partes(direccion: string): { local: string; dominio: string } | null {
  const valor = direccion.trim().toLowerCase();
  const at = valor.lastIndexOf('@');
  if (at <= 0 || at === valor.length - 1) return null;
  return { local: valor.slice(0, at), dominio: valor.slice(at + 1) };
}

function errorActualizando(direccion?: string): HttpError {
  return conflict(
    direccion
      ? `Se está actualizando el usuario de ${direccion}. Vuelve a intentarlo en unos minutos.`
      : 'Se está actualizando el usuario de este buzón. Vuelve a intentarlo en unos minutos.',
    'mailbox_login_updating',
  );
}

/**
 * Usuario para llamar al motor. 409 mailbox_login_updating si hay un cambio
 * de usuario a medias: hasta que se resuelva no se sabe con qué nombre está
 * el principal, y cualquier llamada podría ir al nombre equivocado.
 */
export function loginParaMotor(mailboxId: string): string {
  const fila = leerBuzon(mailboxId);
  if (!fila) throw notFound('Buzón no encontrado.');
  if (fila.usuario_cambiando_a) throw errorActualizando();
  return loginDe(fila);
}

/**
 * Dirección o usuario → buzón, en este orden: dirección vigente; usuario_motor;
 * y, si el dominio es origen o destino de un cambio abierto con direcciones_at,
 * la misma parte local en el dominio pareja (solo si ese buzón es un ítem del
 * cambio). null si no hay ninguno.
 */
export function resolverBuzon(direccionOLogin: string): { mailboxId: string; clientId: string } | null {
  const p = partes(direccionOLogin);
  if (!p) return null;
  type Fila = { id: string; client_id: string };
  const salida = (fila: Fila) => ({ mailboxId: fila.id, clientId: fila.client_id });

  const vigente = db
    .prepare(
      `SELECT m.id, d.client_id FROM mailboxes m JOIN domains d ON d.id = m.domain_id
       WHERE d.domain = ? AND m.local_part = ?`,
    )
    .get(p.dominio, p.local) as Fila | undefined;
  if (vigente) return salida(vigente);

  const porUsuario = db
    .prepare(
      `SELECT m.id, d.client_id FROM mailboxes m JOIN domains d ON d.id = m.domain_id
       WHERE m.usuario_motor = ?`,
    )
    .get(`${p.local}@${p.dominio}`) as Fila | undefined;
  if (porUsuario) return salida(porUsuario);

  // Solo con la pre-recepción hecha: antes, la dirección del dominio pareja
  // todavía no es del buzón en el motor.
  const cambios = db
    .prepare(
      `SELECT id, from_domain, to_domain FROM domain_migrations
       WHERE (from_domain = ? OR to_domain = ?) AND estado NOT IN ${CERRADOS}
         AND direcciones_at IS NOT NULL`,
    )
    .all(p.dominio, p.dominio) as { id: string; from_domain: string; to_domain: string }[];
  for (const cambio of cambios) {
    const pareja = cambio.from_domain === p.dominio ? cambio.to_domain : cambio.from_domain;
    const fila = db
      .prepare(
        `SELECT m.id, d.client_id FROM mailboxes m
         JOIN domains d ON d.id = m.domain_id
         JOIN domain_migration_items i ON i.migration_id = ? AND i.tipo = 'buzon' AND i.item_id = m.id
         WHERE d.domain = ? AND m.local_part = ?`,
      )
      .get(cambio.id, pareja, p.local) as Fila | undefined;
    if (fila) return salida(fila);
  }
  return null;
}

/**
 * Destino interno de un alias (dirección de un buzón) → nombre en el motor (su
 * login): Stalwart guarda los miembros de una lista por nombre, y el de un
 * buzón pendiente de actualizar no es su dirección. Si no es un buzón, la
 * misma dirección.
 */
export function nombreEnMotor(direccion: string): string {
  const p = partes(direccion);
  if (!p) return direccion;
  const fila = db
    .prepare(`${SELECT_BUZON} WHERE d.domain = ? AND m.local_part = ?`)
    .get(p.dominio, p.local) as FilaBuzon | undefined;
  if (!fila) return direccion;
  if (fila.usuario_cambiando_a) throw errorActualizando(direccionDe(fila));
  return loginDe(fila);
}

/* ------------------------------ Cambios abiertos ---------------------------- */

export interface CambioAbierto {
  id: string;
  rol: 'origen' | 'destino';
  estado: string;
  fromDomainId: string | null;
  toDomainId: string | null;
  fromDomain: string;
  toDomain: string;
  direccionesAt: number | null;
  origen: 'panel' | 'skyway';
}

interface FilaCambio {
  id: string;
  estado: string;
  from_domain_id: string | null;
  to_domain_id: string | null;
  from_domain: string;
  to_domain: string;
  direcciones_at: number | null;
  origen: 'panel' | 'skyway';
}

/** Cambio abierto (estado ≠ dado_de_baja y ≠ cancelada) en el que participa el dominio. */
export function cambioAbiertoDeDominio(domainId: string): CambioAbierto | null {
  const fila = db
    .prepare(
      `SELECT id, estado, from_domain_id, to_domain_id, from_domain, to_domain, direcciones_at, origen
       FROM domain_migrations
       WHERE (from_domain_id = ? OR to_domain_id = ?) AND estado NOT IN ${CERRADOS}
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(domainId, domainId) as FilaCambio | undefined;
  if (!fila) return null;
  return {
    id: fila.id,
    rol: fila.from_domain_id === domainId ? 'origen' : 'destino',
    estado: fila.estado,
    fromDomainId: fila.from_domain_id,
    toDomainId: fila.to_domain_id,
    fromDomain: fila.from_domain,
    toDomain: fila.to_domain,
    direccionesAt: fila.direcciones_at,
    origen: fila.origen,
  };
}

/**
 * Ids de los dominios del cliente que no cuentan en el plan: el origen de cada
 * cambio abierto. Sin esto, un cliente con el plan justo no podría dar de alta
 * el dominio nuevo, y el viejo solo sigue para recibir mientras dura el cambio.
 */
export function dominiosExentos(clientId: string): string[] {
  const filas = db
    .prepare(
      `SELECT DISTINCT dm.from_domain_id AS id FROM domain_migrations dm
       JOIN domains d ON d.id = dm.from_domain_id AND d.client_id = dm.client_id
       WHERE dm.client_id = ? AND dm.estado NOT IN ${CERRADOS}`,
    )
    .all(clientId) as { id: string }[];
  return filas.map((f) => f.id);
}

/** Estados del cambio en los que el destino todavía no admite altas. */
const DESTINO_SIN_ALTAS = new Set(['preparando', 'listo', 'pasando', 'volviendo']);

/**
 * 409 domain_migrating si el dominio no admite altas de buzones ni alias. El
 * conjunto que se muda es fijo desde que se crea el cambio: el origen no
 * admite altas mientras esté abierto, y el destino, hasta que se pasa a él.
 */
export function assertAltasPermitidas(domainId: string): void {
  const cambio = cambioAbiertoDeDominio(domainId);
  if (!cambio) return;
  if (cambio.rol === 'origen') {
    throw conflict(
      `${cambio.fromDomain} está en un cambio de dominio: crea los buzones y alias en ${cambio.toDomain} cuando pases a él, o cancela el cambio.`,
      'domain_migrating',
    );
  }
  if (DESTINO_SIN_ALTAS.has(cambio.estado)) {
    throw conflict(
      `${cambio.toDomain} se está preparando para sustituir a ${cambio.fromDomain}: podrás crear buzones y alias en cuanto pases a él.`,
      'domain_migrating',
    );
  }
}

/* ------------------------- Aplicaciones de Skyway ------------------------- */

const PREFIJO_SKYWAY = 'skyway:';

/** Nombres de las contraseñas de aplicación activas que creó Skyway («skyway:…»). */
export function appsSkywayDe(mailboxId: string): string[] {
  const filas = db
    .prepare(
      `SELECT name FROM app_passwords
       WHERE mailbox_id = ? AND revoked_at IS NULL AND substr(name, 1, ?) = ?
       ORDER BY created_at`,
    )
    .all(mailboxId, PREFIJO_SKYWAY.length, PREFIJO_SKYWAY) as { name: string }[];
  return filas.map((f) => f.name);
}

/**
 * 409 mailbox_used_by_app. Una aplicación de Skyway envía con el usuario del
 * motor (SMTP_USER): cambiarlo sin que Skyway actualice sus variables y la
 * vuelva a desplegar la dejaría sin poder enviar.
 */
export function errorBuzonUsadoPorApp(apps: string[]): HttpError {
  const nombres = [...new Set(apps.map((a) => a.slice(PREFIJO_SKYWAY.length)).filter(Boolean))];
  const cuales = nombres.length > 0 ? ` (${nombres.join(', ')})` : '';
  return conflict(
    `Este buzón lo usa una aplicación para enviar${cuales}. Actualízalo desde Skyway para que la aplicación no deje de enviar, o revoca antes sus contraseñas de aplicación «skyway:…».`,
    'mailbox_used_by_app',
  );
}

/* --------------------------- Actualizar el usuario -------------------------- */

/**
 * Cambia el usuario del motor a la dirección vigente. Idempotente: sin
 * usuario_motor devuelve null. Toma cambio:<id> si el dominio está en un
 * cambio abierto (para no cruzarse con pasar, volver, cancelar o la baja), y
 * después buzon:<id>. La auditoría la hace quien llama.
 */
export async function actualizarUsuario(mailboxId: string): Promise<{ de: string; a: string } | null> {
  const fila = leerBuzon(mailboxId);
  if (!fila) throw notFound('Buzón no encontrado.');
  if (fila.usuario_motor === null && !fila.usuario_cambiando_a) return null;
  const cambio = cambioAbiertoDeDominio(fila.domain_id);
  if (!cambio) return actualizarUsuarioEnCambio(mailboxId);
  return withLock(cambioLockKey(cambio.id), () => actualizarUsuarioEnCambio(mailboxId));
}

/** Igual, para quien YA tiene cambio:<id> (pasar, volver, cancelar, baja): solo toma buzon:<id>. */
export async function actualizarUsuarioEnCambio(mailboxId: string): Promise<{ de: string; a: string } | null> {
  return withLock(buzonLockKey(mailboxId), () => actualizarSinCerrojo(mailboxId));
}

/**
 * Un fallo sin respuesta del motor (o inesperado) no dice si el renombrado se
 * aplicó: Stalwart pudo hacerlo y la respuesta perderse.
 */
function falloAmbiguo(err: unknown): boolean {
  return !(err instanceof HttpError) || err.code === 'engine_unreachable';
}

/**
 * Buzones cuya marca dejó en este proceso un fallo sin respuesta, con la hora
 * del fallo. Tras el corte por tiempo, Stalwart puede seguir procesando el
 * PATCH y aplicar el renombrado después: si se mirara el motor enseguida, se
 * vería aún el usuario anterior, se limpiaría la marca y el renombrado
 * llegaría más tarde, con la base apuntando a un nombre que ya no existe. Por
 * eso el conciliador no mira esas marcas hasta que pasa este margen.
 */
const fallosSinRespuesta = new Map<string, number>();
const ESPERA_TRAS_FALLO_MS = 60_000;

/** Olvida las esperas tras un fallo sin respuesta (solo pruebas: simula que ya pasó el margen). */
export function resetConciliacionForTests(): void {
  fallosSinRespuesta.clear();
}

async function actualizarSinCerrojo(mailboxId: string): Promise<{ de: string; a: string } | null> {
  const fila = leerBuzon(mailboxId);
  if (!fila) throw notFound('Buzón no encontrado.');
  if (fila.usuario_motor === null) return null;
  if (fila.usuario_cambiando_a) throw errorActualizando();
  const de = fila.usuario_motor;
  const a = direccionDe(fila);
  if (de === a) {
    // Invariante rota (usuario_motor igual a la dirección): no hay nada que
    // renombrar, solo se deja de marcar como pendiente.
    db.prepare('UPDATE mailboxes SET usuario_motor = NULL WHERE id = ?').run(mailboxId);
    return null;
  }
  const otro = db
    .prepare('SELECT 1 FROM mailboxes WHERE usuario_motor = ? AND id <> ?')
    .get(a, mailboxId);
  if (otro) {
    throw conflict(
      `Otro buzón entra todavía con el usuario ${a}: no se puede cambiar el de este a esa dirección.`,
      'mailbox_exists',
    );
  }
  // El motor se pide ANTES de marcar: sin motor configurado no debe quedar
  // una marca que bloquee el buzón.
  const engine = getEngine();
  // La marca va antes de tocar el motor: si el panel se cae a mitad, el
  // conciliador sabe qué se estaba haciendo y lo termina o lo deshace.
  db.prepare('UPDATE mailboxes SET usuario_cambiando_a = ? WHERE id = ?').run(a, mailboxId);
  try {
    await engine.renamePrincipal(de, a, { expectEmail: a });
  } catch (err) {
    if (!falloAmbiguo(err)) {
      // Stalwart aplica el PATCH entero o nada: con una respuesta de error,
      // el principal sigue con su nombre.
      limpiarMarca(mailboxId);
      throw err;
    }
    // Sin respuesta, la marca se queda: limpiarla podría dejar al panel usando
    // un nombre que ya no existe. Mientras tanto el buzón responde 409, y el
    // conciliador del vigilante decide pasado el margen (véase arriba).
    fallosSinRespuesta.set(mailboxId, Date.now());
    throw err;
  }
  terminarCambioDeUsuario(mailboxId, de, null);
  return { de, a };
}

/** Paso final: el buzón ya entra con su dirección (o con `usuario`, si no coincide). */
function terminarCambioDeUsuario(mailboxId: string, anterior: string, usuario: string | null): void {
  db.prepare(
    `UPDATE mailboxes SET usuario_motor = ?, login_anterior = ?, usuario_cambiando_a = NULL
     WHERE id = ?`,
  ).run(usuario, anterior, mailboxId);
  fallosSinRespuesta.delete(mailboxId);
}

/** Deshace la marca: el principal sigue con su nombre anterior. */
function limpiarMarca(mailboxId: string): void {
  db.prepare('UPDATE mailboxes SET usuario_cambiando_a = NULL WHERE id = ?').run(mailboxId);
  fallosSinRespuesta.delete(mailboxId);
}

type Conciliacion = 'nada' | 'resuelto' | 'pendiente';

/**
 * Resuelve la marca de un buzón mirando el motor (con buzon:<id> ya tomado):
 *
 * | Usuario anterior | Usuario nuevo                       | Qué se hace                     |
 * |------------------|-------------------------------------|---------------------------------|
 * | existe           | no existe                           | se limpia la marca              |
 * | no existe        | existe, con la dirección vigente    | se termina el cambio            |
 * | cualquier otro caso                                    | marca + alerta buzon_usuario:id |
 * | el motor no responde                                   | marca                           |
 *
 * Una marca que dejó hace poco un fallo sin respuesta no se mira todavía.
 */
async function conciliarFila(mailboxId: string): Promise<Conciliacion> {
  const fila = leerBuzon(mailboxId);
  if (!fila || !fila.usuario_cambiando_a) {
    fallosSinRespuesta.delete(mailboxId);
    return 'nada';
  }
  const fallo = fallosSinRespuesta.get(mailboxId);
  if (fallo !== undefined && Date.now() - fallo < ESPERA_TRAS_FALLO_MS) return 'pendiente';
  const anterior = loginDe(fila);
  const nuevo = fila.usuario_cambiando_a;
  const direccion = direccionDe(fila);
  let principalAnterior;
  let principalNuevo;
  try {
    const engine = getEngine();
    [principalAnterior, principalNuevo] = await Promise.all([
      engine.getPrincipal(anterior),
      engine.getPrincipal(nuevo),
    ]);
  } catch {
    return 'pendiente';
  }
  const clave = `buzon_usuario:${mailboxId}`;
  if (principalAnterior && !principalNuevo) {
    limpiarMarca(mailboxId);
    resolveAlert(clave);
    return 'resuelto';
  }
  const conDireccion = Boolean(principalNuevo?.emails.some((e) => e.toLowerCase() === direccion));
  if (!principalAnterior && principalNuevo && conDireccion) {
    // Si el nombre nuevo no es la dirección (no debería pasar), se guarda
    // como usuario del motor para no romper el invariante.
    terminarCambioDeUsuario(mailboxId, anterior, nuevo === direccion ? null : nuevo);
    resolveAlert(clave);
    auditSystem('mailbox.login_updated', { id: mailboxId, de: anterior, a: nuevo, por: 'conciliador' }, fila.client_id);
    return 'resuelto';
  }
  const { motivo, remedio } = principalAnterior
    ? {
        motivo: 'existen los dos usuarios',
        remedio: 'Cuando solo quede uno de los dos, el panel termina o deshace el cambio por sí solo.',
      }
    : principalNuevo
      ? {
          motivo: `el usuario ${nuevo} existe, pero no tiene la dirección ${direccion}`,
          remedio: `Cuando ${nuevo} tenga la dirección ${direccion}, el panel termina el cambio por sí solo.`,
        }
      : {
          motivo: 'no existe ninguno de los dos usuarios',
          remedio: 'Cuando vuelva a existir uno de los dos, el panel termina o deshace el cambio por sí solo.',
        };
  fireAlert({
    severity: 'warning',
    type: 'buzon_usuario',
    clientId: fila.client_id,
    dedupeKey: clave,
    title: `No se ha podido terminar el cambio de usuario de ${direccion}`,
    message: `El cambio de usuario de ${anterior} a ${nuevo} se interrumpió y en el servidor de correo ${motivo}. Mientras no se resuelva, el panel no modifica este buzón.`,
    remedy: `Revisa en el servidor de correo los usuarios ${anterior} y ${nuevo}. ${remedio}`,
  });
  return 'pendiente';
}

/** Termina o deshace los cambios de usuario interrumpidos (usuario_cambiando_a). Nunca lanza. */
export async function conciliarUsuariosEnCambio(): Promise<{ resueltos: number; pendientes: number }> {
  let ids: string[];
  try {
    ids = (
      db.prepare('SELECT id FROM mailboxes WHERE usuario_cambiando_a IS NOT NULL').all() as { id: string }[]
    ).map((f) => f.id);
  } catch {
    return { resueltos: 0, pendientes: 0 };
  }
  let resueltos = 0;
  let pendientes = 0;
  for (const id of ids) {
    try {
      // Con el cerrojo del buzón: si un cambio de usuario está en curso, se
      // espera a que termine y se relee la fila (la marca ya no estará).
      const resultado = await withLock(buzonLockKey(id), () => conciliarFila(id));
      if (resultado === 'resuelto') resueltos += 1;
      else if (resultado === 'pendiente') pendientes += 1;
    } catch {
      pendientes += 1;
    }
  }
  return { resueltos, pendientes };
}

/* ---------------------------------- Webmail --------------------------------- */

/** Lo que necesita el complemento del webmail (§3.11). */
export function datosWebmail(mailboxId: string): {
  login: string;
  email: string;
  anteriores: string[];
  otrasDirecciones: string[];
} {
  const fila = leerBuzon(mailboxId);
  if (!fila) throw notFound('Buzón no encontrado.');
  const login = loginDe(fila);
  const email = direccionDe(fila);
  // Un usuario anterior que hoy lleva a otro buzón (una dirección que se
  // liberó y se volvió a dar de alta) no se ofrece: el complemento le
  // trasladaría a este buzón la fila de Roundcube de esa otra persona.
  const anterior = fila.login_anterior;
  const anteriores =
    anterior && anterior !== login && (resolverBuzon(anterior)?.mailboxId ?? mailboxId) === mailboxId
      ? [anterior]
      : [];
  const cambios = db
    .prepare(
      `SELECT dm.estado, dm.from_domain, dm.to_domain, i.local_part FROM domain_migrations dm
       JOIN domain_migration_items i ON i.migration_id = dm.id AND i.tipo = 'buzon' AND i.item_id = ?
       WHERE dm.estado <> 'cancelada'
       ORDER BY dm.created_at`,
    )
    .all(mailboxId) as { estado: string; from_domain: string; to_domain: string; local_part: string }[];
  const otras: string[] = [];
  for (const cambio of cambios) {
    if (fila.domain === cambio.to_domain) {
      // También tras la baja: el webmail aún puede tener identidades con la vieja.
      otras.push(`${cambio.local_part}@${cambio.from_domain}`);
    } else if (fila.domain === cambio.from_domain && cambio.estado !== 'dado_de_baja') {
      otras.push(`${cambio.local_part}@${cambio.to_domain}`);
    }
  }
  return {
    login,
    email,
    anteriores,
    otrasDirecciones: [...new Set(otras)].filter((d) => d !== email),
  };
}
