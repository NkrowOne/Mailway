import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { randomId } from '../core/crypto';
import { badRequest, conflict, notFound } from '../core/errors';
import { withLock } from '../core/locks';
import { getEngine } from '../engine';
import { audit } from './audit';
import { assertClientActive } from './clients';
import { loginParaMotor } from './direcciones';
import { getMailbox, requireMailboxAccess } from './mailboxes';
import { bloquesContrasenaAplicacion, getConnectionSettings, type BloqueVariables } from './connection';

/**
 * Contraseñas de aplicación por buzón: una por dispositivo o aplicación
 * (el móvil, una app desplegada en Skyway…). Se revocan una a una sin tocar
 * la contraseña principal, así que perder un móvil no obliga a reconfigurar
 * todo lo demás.
 *
 * Las funciones de este bloque las comparten el panel (rutas de abajo), el
 * portal del titular y las integraciones.
 */

export interface AppPasswordInfo {
  id: string;
  mailboxId: string;
  email: string;
  name: string;
  createdAt: number;
  revokedAt: number | null;
}

interface AppPasswordRow {
  id: string;
  mailbox_id: string;
  name: string;
  stored_secret: string;
  created_by: string | null;
  created_at: number;
  revoked_at: number | null;
}

function toInfo(row: AppPasswordRow, email: string): AppPasswordInfo {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    email,
    name: row.name,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

/** Contraseñas de aplicación de un buzón (activas primero, luego revocadas). */
export function listAppPasswords(mailboxId: string): AppPasswordInfo[] {
  const email = getMailbox(mailboxId).email;
  const rows = db
    .prepare(
      `SELECT * FROM app_passwords WHERE mailbox_id = ?
       ORDER BY (revoked_at IS NOT NULL), created_at DESC`,
    )
    .all(mailboxId) as AppPasswordRow[];
  return rows.map((row) => toInfo(row, email));
}

/**
 * Etiqueta que el motor guarda junto al hash ($app$<etiqueta>$<hash>).
 * Stalwart retira las contraseñas de aplicación por coincidencia exacta O
 * POR PREFIJO: con un sufijo aleatorio fijo, revocar una nunca arrastra a
 * otra que empiece igual.
 */
function engineLabel(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `mw-${slug || 'app'}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Contraseña legible y larga: se escribe una vez en un dispositivo. */
function newAppPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let group = '';
    while (group.length < 4) {
      const byte = crypto.randomBytes(1)[0]!;
      if (byte < Math.floor(256 / alphabet.length) * alphabet.length) {
        group += alphabet[byte % alphabet.length];
      }
    }
    groups.push(group);
  }
  return groups.join('-');
}

/**
 * Máximo de contraseñas de aplicación activas por buzón. Una por dispositivo
 * o aplicación es lo normal; decenas suelen indicar que no se revocan las
 * antiguas, y cada una es una puerta más al buzón. Es el mismo para el panel,
 * «Mi buzón» y las integraciones: se comprueba al crear, sea cual sea la vía.
 */
export const MAX_ACTIVE_APP_PASSWORDS = 25;

function activeAppPasswords(mailboxId: string): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS c FROM app_passwords WHERE mailbox_id = ? AND revoked_at IS NULL')
      .get(mailboxId) as { c: number }
  ).c;
}

/**
 * Crea una contraseña de aplicación en el motor y la registra. Devuelve la
 * contraseña en claro UNA sola vez; en la base solo queda el hash del motor.
 *
 * Aquí (y no en cada ruta) se comprueban el cliente suspendido, el buzón
 * suspendido y el máximo de activas, para que ninguna vía se los salte. Las
 * altas del mismo buzón van en fila: si no, varias simultáneas pasarían a la
 * vez la cuenta del máximo.
 */
export function createAppPassword(
  mailboxId: string,
  name: string,
  createdBy: string | null,
): Promise<{ appPassword: AppPasswordInfo; password: string }> {
  return withLock(`contrasenas-app:${mailboxId}`, () => createAppPasswordNow(mailboxId, name, createdBy));
}

async function createAppPasswordNow(
  mailboxId: string,
  name: string,
  createdBy: string | null,
): Promise<{ appPassword: AppPasswordInfo; password: string }> {
  const mailbox = getMailbox(mailboxId);
  assertClientActive(mailbox.clientId);
  if (mailbox.status === 'suspended') {
    throw badRequest(
      `El buzón ${mailbox.email} está suspendido. Reactívalo antes de crear contraseñas de aplicación.`,
      'mailbox_suspended',
    );
  }
  if (activeAppPasswords(mailboxId) >= MAX_ACTIVE_APP_PASSWORDS) {
    throw conflict(
      `Este buzón ya tiene ${MAX_ACTIVE_APP_PASSWORDS} contraseñas de aplicación activas. Revoca las que ya no se utilicen antes de crear otra.`,
      'app_password_limit',
    );
  }
  const password = newAppPassword();
  // Con el usuario del motor, que durante un cambio de dominio no es la dirección.
  const login = loginParaMotor(mailboxId);
  const stored = await getEngine().addAppPassword(login, password, engineLabel(name));
  const id = randomId('app');
  try {
    db.prepare(
      `INSERT INTO app_passwords (id, mailbox_id, name, stored_secret, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, mailboxId, name, stored, createdBy, now());
  } catch (err) {
    // Sin registro en el panel no se podría revocar: se retira del motor.
    await getEngine().removeAppPassword(login, stored).catch(() => undefined);
    throw err;
  }
  const row = db.prepare('SELECT * FROM app_passwords WHERE id = ?').get(id) as AppPasswordRow;
  return { appPassword: toInfo(row, mailbox.email), password };
}

/**
 * Bloques listos para copiar (.env, Node, Laravel y Django) de una contraseña
 * recién creada. Solo existen en la respuesta del alta: la contraseña no se
 * guarda en claro.
 */
export function variablesContrasenaAplicacion(
  appPassword: AppPasswordInfo,
  password: string,
): BloqueVariables[] {
  const mailbox = getMailbox(appPassword.mailboxId);
  return bloquesContrasenaAplicacion({
    email: mailbox.email,
    // SMTP_USER es el usuario del motor; el remitente sigue siendo la dirección.
    usuario: mailbox.login,
    password,
    name: appPassword.name,
    settings: getConnectionSettings(mailbox.domain, mailbox.clientId),
  });
}

/** Revoca una contraseña de aplicación: deja de funcionar al instante. */
export async function revokeAppPassword(mailboxId: string, appId: string): Promise<void> {
  const row = db
    .prepare('SELECT * FROM app_passwords WHERE id = ? AND mailbox_id = ?')
    .get(appId, mailboxId) as AppPasswordRow | undefined;
  if (!row) throw notFound('Contraseña de aplicación no encontrada.');
  if (row.revoked_at) return;
  await getEngine().removeAppPassword(loginParaMotor(mailboxId), row.stored_secret);
  db.prepare('UPDATE app_passwords SET revoked_at = ? WHERE id = ?').run(now(), appId);
}

const createSchema = z.object({
  name: z
    .string({ required_error: 'Indica un nombre para identificar la contraseña (p. ej. «Móvil de Ana»).' })
    .trim()
    .min(1, 'Indica un nombre para identificar la contraseña (p. ej. «Móvil de Ana»).')
    .max(60, 'El nombre no puede superar los 60 caracteres.'),
});

/** Rutas del panel (administración y usuarios del cliente dueño del buzón). */
export function registerAppPasswordRoutes(app: FastifyInstance): void {
  app.get('/api/mailboxes/:id/app-passwords', async (req) => {
    const { id } = req.params as { id: string };
    requireMailboxAccess(req, id);
    return { appPasswords: listAppPasswords(id) };
  });

  app.post('/api/mailboxes/:id/app-passwords', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { user, mailbox, domain } = requireMailboxAccess(req, id);
    const body = createSchema.parse(req.body ?? {});
    const result = await createAppPassword(id, body.name, user.id);
    audit(req, 'mailbox.app_password_created', {
      mailboxId: id,
      email: mailbox.email,
      appPasswordId: result.appPassword.id,
      name: result.appPassword.name,
    }, domain.clientId);
    // La contraseña en claro (y los bloques que la contienen) viaja solo en
    // esta respuesta.
    reply.header('Cache-Control', 'no-store');
    return { ...result, snippets: variablesContrasenaAplicacion(result.appPassword, result.password) };
  });

  app.delete('/api/mailboxes/:id/app-passwords/:appId', async (req) => {
    const { id, appId } = req.params as { id: string; appId: string };
    const { mailbox, domain } = requireMailboxAccess(req, id);
    await revokeAppPassword(id, appId);
    audit(req, 'mailbox.app_password_revoked', { mailboxId: id, email: mailbox.email, appPasswordId: appId }, domain.clientId);
    return { ok: true };
  });
}
