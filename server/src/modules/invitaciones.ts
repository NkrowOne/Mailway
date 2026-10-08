import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, now } from '../core/db';
import { decryptSecret, encryptSecret, hashPassword, hashToken, randomId } from '../core/crypto';
import { HttpError, badRequest, conflict, forbidden, notFound, tooMany } from '../core/errors';
import { audit } from './audit';
import { createSession, createUser, requireAdmin } from './auth';
import { getClient } from './clients';
import { publicBaseUrl } from './connection';
import { getInstanceSettings } from './settings';

/**
 * Enlace de bienvenida de un cliente.
 *
 * La administración lo envía a la persona de contacto de la empresa (no a un
 * buzón). Con él crea su propio acceso al panel —sin que nadie le dicte una
 * contraseña— y entra directamente en la puesta en marcha: dominio, buzones
 * del equipo, postmaster y abuse, y sus dispositivos. Un enlace sirve una
 * sola vez; después se entra con el correo y la contraseña de siempre.
 *
 * Si esa persona ya tiene usuario en el mismo cliente (por ejemplo, tras
 * reiniciar la puesta en marcha), el enlace no crea otro: le deja elegir una
 * contraseña nueva. Nunca sirve para entrar en la cuenta de la administración
 * ni en la de otro cliente.
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const MIN_CONTRASENA = 10;

interface FilaInvitacion {
  id: string;
  client_id: string;
  email: string;
  name: string;
  token_hash: string;
  token_enc: string | null;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  opened_at: number | null;
  accepted_at: number | null;
  accepted_user_id: string | null;
  revoked_at: number | null;
}

type EstadoInvitacion = 'pending' | 'accepted' | 'expired' | 'revoked';

function estado(row: FilaInvitacion): EstadoInvitacion {
  if (row.accepted_at) return 'accepted';
  if (row.revoked_at) return 'revoked';
  if (row.expires_at <= now()) return 'expired';
  return 'pending';
}

function invitacionNoValida(): HttpError {
  return new HttpError(
    404,
    'Este enlace de bienvenida no es válido o ha caducado. Solicita uno nuevo a tu proveedor de correo.',
    'invite_invalid',
  );
}

function invitacionUsada(): HttpError {
  return new HttpError(
    409,
    'Este enlace de bienvenida ya se ha usado. Inicia sesión con tu correo y tu contraseña.',
    'invite_used',
  );
}

/**
 * El token cifrado solo sirve mientras el enlace está pendiente: usado,
 * revocado o caducado, no hay nada que volver a enviar.
 */
function purgarInvitaciones(): void {
  db.prepare(
    `UPDATE client_invites SET token_enc = NULL
     WHERE token_enc IS NOT NULL AND (accepted_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at <= ?)`,
  ).run(now());
}

/**
 * Dirección del panel que verá el cliente: su dominio de marca blanca del
 * panel si lo tiene activo (la sesión que abre el enlace queda en ese
 * dominio, el mismo en el que seguirá entrando); si no, la del panel.
 */
function baseDelCliente(req: FastifyRequest, clientId: string): string {
  const row = db
    .prepare(
      `SELECT hostname FROM client_domains
       WHERE client_id = ? AND kind = 'panel' AND status = 'active'
       ORDER BY is_primary DESC, activated_at ASC, created_at ASC LIMIT 1`,
    )
    .get(clientId) as { hostname: string } | undefined;
  return row ? `https://${row.hostname}` : publicBaseUrl(req);
}

function aRespuesta(row: FilaInvitacion) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    openedAt: row.opened_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    status: estado(row),
    recoverable: estado(row) === 'pending' && row.token_enc !== null,
  };
}

function invitacionDelCliente(clientId: string, inviteId: string): FilaInvitacion {
  const row = db
    .prepare('SELECT * FROM client_invites WHERE id = ? AND client_id = ?')
    .get(inviteId, clientId) as FilaInvitacion | undefined;
  if (!row) throw notFound('Enlace de bienvenida no encontrado.');
  return row;
}

/** Busca el enlace por su token y comprueba que se puede usar. */
function invitacionPorToken(token: string): FilaInvitacion {
  purgarInvitaciones();
  if (!TOKEN_RE.test(token)) throw invitacionNoValida();
  const row = db
    .prepare('SELECT * FROM client_invites WHERE token_hash = ?')
    .get(hashToken(token)) as FilaInvitacion | undefined;
  if (!row) throw invitacionNoValida();
  const e = estado(row);
  if (e === 'accepted') throw invitacionUsada();
  if (e !== 'pending') throw invitacionNoValida();
  if (getClient(row.client_id).suspended) {
    throw forbidden(
      'La cuenta de tu empresa está suspendida. Ponte en contacto con tu proveedor de correo.',
      'client_suspended',
    );
  }
  return row;
}

/** Quién tiene ya una cuenta del panel con el correo de un enlace. */
type CuentaDelCorreo =
  /** Nadie: aceptar crea el usuario. */
  | { estado: 'libre' }
  /** Un usuario de este mismo cliente: aceptar le pone la contraseña nueva. */
  | { estado: 'propia'; id: string }
  /** La administración u otro cliente: el enlace nunca sirve para entrar en ella. */
  | { estado: 'ajena' };

/**
 * Tras «Reiniciar puesta en marcha» (o simplemente con otra persona de
 * contacto que ya tenía acceso) se envía el enlace a alguien que ya tiene
 * usuario en el cliente: con él elige una contraseña nueva en lugar de crear
 * otro acceso. La comparación no distingue mayúsculas: una cuenta antigua
 * guardada con otras no debe colarse como «libre».
 */
function cuentaDelCorreo(email: string, clientId: string): CuentaDelCorreo {
  const filas = db
    .prepare('SELECT id, role, client_id FROM users WHERE lower(email) = lower(?)')
    .all(email) as { id: string; role: 'admin' | 'client'; client_id: string | null }[];
  if (filas.length === 0) return { estado: 'libre' };
  const [fila] = filas;
  if (filas.length === 1 && fila && fila.role === 'client' && fila.client_id === clientId) {
    return { estado: 'propia', id: fila.id };
  }
  return { estado: 'ajena' };
}

/** El mismo error que da el alta de un usuario con un correo ocupado. */
function correoOcupado(): HttpError {
  return conflict('Ya existe un usuario con ese correo.', 'user_exists');
}

/** Límite en memoria para las rutas públicas: protegen el servidor, no el token (256 bits). */
function crearLimitador(max: number, ventanaMs: number): (clave: string) => boolean {
  const cuentas = new Map<string, { desde: number; n: number }>();
  return (clave) => {
    const t = now();
    if (cuentas.size > 5000) {
      for (const [k, v] of cuentas) if (t - v.desde >= ventanaMs) cuentas.delete(k);
    }
    const actual = cuentas.get(clave);
    if (!actual || t - actual.desde >= ventanaMs) {
      cuentas.set(clave, { desde: t, n: 1 });
      return true;
    }
    actual.n += 1;
    return actual.n <= max;
  };
}

const crearSchema = z.object({
  email: z
    .string({ required_error: 'Indica el correo de la persona de contacto.' })
    .trim()
    .toLowerCase()
    .email('El correo de la persona de contacto no es válido.')
    .max(254),
  name: z.string().trim().max(80, 'El nombre no puede superar los 80 caracteres.').optional().default(''),
  ttlHours: z
    .number()
    .int('La validez debe indicarse en horas enteras.')
    .min(1, 'La validez mínima del enlace es de 1 hora.')
    .max(720, 'La validez máxima del enlace es de 720 horas (30 días).')
    .optional()
    .default(168),
});

const nombreSchema = z
  .string({ required_error: 'Indica tu nombre.' })
  .trim()
  .min(2, 'Tu nombre debe tener al menos 2 caracteres.')
  .max(80, 'Tu nombre no puede superar los 80 caracteres.');

const contrasenaSchema = z
  .string({ required_error: 'Elige una contraseña.' })
  .min(MIN_CONTRASENA, `La contraseña debe tener al menos ${MIN_CONTRASENA} caracteres.`)
  .max(200, 'La contraseña no puede superar los 200 caracteres.');

/** Crear el acceso: nombre y contraseña, ambos obligatorios. */
const aceptarSchema = z.object({ name: nombreSchema, password: contrasenaSchema });

/**
 * Usuario que ya existe: ya tiene nombre, así que solo se cambia si llega uno
 * (vacío cuenta como no enviado). La contraseña, con las mismas reglas.
 */
const aceptarExistenteSchema = z.object({
  name: z.preprocess(
    (valor) => (typeof valor === 'string' && valor.trim() === '' ? undefined : valor),
    nombreSchema.optional(),
  ),
  password: contrasenaSchema,
});

export function registerInviteRoutes(app: FastifyInstance): void {
  const limite = crearLimitador(60, 60_000);
  function limitar(req: FastifyRequest): void {
    if (!limite(req.ip || '')) {
      throw tooMany('Se han realizado demasiadas peticiones. Espera un minuto y vuelve a intentarlo.');
    }
  }

  /* ---------------------------- Administración ---------------------------- */

  app.post('/api/clients/:id/invites', async (req) => {
    const admin = requireAdmin(req);
    const { id } = req.params as { id: string };
    const client = getClient(id);
    const body = crearSchema.parse(req.body ?? {});
    if (client.suspended) {
      throw badRequest('El cliente está suspendido. Reactívalo antes de enviarle un enlace de bienvenida.', 'client_suspended');
    }
    // Un usuario de este cliente puede recibirlo (elegirá una contraseña
    // nueva); el correo de la administración o de otro cliente, nunca: el
    // enlace daría acceso a su cuenta.
    const cuenta = cuentaDelCorreo(body.email, id);
    if (cuenta.estado === 'ajena') throw correoOcupado();
    const existingUser = cuenta.estado === 'propia';

    const token = crypto.randomBytes(32).toString('base64url');
    const inviteId = randomId('inv');
    const t = now();
    const expiresAt = t + body.ttlHours * 3600_000;
    db.transaction(() => {
      // Un solo enlace válido por persona: el nuevo sustituye a los pendientes.
      db.prepare(
        `UPDATE client_invites SET revoked_at = ?, token_enc = NULL
         WHERE client_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
      ).run(t, id, body.email);
      db.prepare(
        `INSERT INTO client_invites (id, client_id, email, name, token_hash, token_enc, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(inviteId, id, body.email, body.name, hashToken(token), encryptSecret(token), admin.id, t, expiresAt);
    })();
    audit(req, 'client.invite_created', {
      clientId: id,
      inviteId,
      email: body.email,
      ttlHours: body.ttlHours,
      existingUser,
    }, id);
    return {
      invite: {
        id: inviteId,
        url: `${baseDelCliente(req, id)}/bienvenida/${token}`,
        email: body.email,
        name: body.name,
        expiresAt,
        existingUser,
      },
    };
  });

  app.get('/api/clients/:id/invites', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    getClient(id);
    purgarInvitaciones();
    const rows = db
      .prepare('SELECT * FROM client_invites WHERE client_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(id) as FilaInvitacion[];
    return { invites: rows.map(aRespuesta) };
  });

  // Volver a enviar un enlace pendiente: la administración es quien lo envía.
  app.get('/api/clients/:id/invites/:inviteId/url', async (req, reply) => {
    requireAdmin(req);
    const { id, inviteId } = req.params as { id: string; inviteId: string };
    purgarInvitaciones();
    const row = invitacionDelCliente(id, inviteId);
    if (estado(row) !== 'pending') throw invitacionNoValida();
    let token: string | null = null;
    try {
      token = row.token_enc ? decryptSecret(row.token_enc) : null;
    } catch {
      token = null;
    }
    if (!token) {
      throw new HttpError(409, 'Este enlace ya no se puede volver a enviar. Crea uno nuevo.', 'invite_not_recoverable');
    }
    audit(req, 'client.invite_viewed', { clientId: id, inviteId, email: row.email }, id);
    reply.header('Cache-Control', 'no-store');
    return {
      invite: {
        id: row.id,
        url: `${baseDelCliente(req, id)}/bienvenida/${token}`,
        email: row.email,
        name: row.name,
        expiresAt: row.expires_at,
      },
    };
  });

  app.delete('/api/clients/:id/invites/:inviteId', async (req) => {
    requireAdmin(req);
    const { id, inviteId } = req.params as { id: string; inviteId: string };
    const row = invitacionDelCliente(id, inviteId);
    db.prepare(
      'UPDATE client_invites SET revoked_at = COALESCE(revoked_at, ?), token_enc = NULL WHERE id = ? AND accepted_at IS NULL',
    ).run(now(), row.id);
    audit(req, 'client.invite_revoked', { clientId: id, inviteId, email: row.email }, id);
    return { ok: true };
  });

  /* ------------------------------- Público -------------------------------- */

  // Fuera de /api/public/ a propósito: aceptar abre una sesión del panel, así
  // que pasa por la protección CSRF de siempre (solo desde el propio panel).
  app.get('/api/invite/:token', async (req, reply) => {
    limitar(req);
    const { token } = req.params as { token: string };
    const row = invitacionPorToken(token);
    db.prepare('UPDATE client_invites SET opened_at = COALESCE(opened_at, ?) WHERE id = ?').run(now(), row.id);
    reply.header('Cache-Control', 'no-store');
    return {
      clientName: getClient(row.client_id).name,
      brandName: getInstanceSettings().brandName,
      email: row.email,
      name: row.name,
      expiresAt: row.expires_at,
      // La página dice «Elige una contraseña nueva» en vez de «Crea tu
      // acceso». Solo se revela al que tiene el enlace, que es esa persona.
      existingUser: cuentaDelCorreo(row.email, row.client_id).estado === 'propia',
    };
  });

  app.post('/api/invite/:token/accept', async (req, reply) => {
    limitar(req);
    const { token } = req.params as { token: string };
    // La contraseña (y el nombre, si llega) se validan antes de mirar el
    // enlace, como siempre; el nombre obligatorio solo al crear el usuario.
    const body = aceptarExistenteSchema.parse(req.body ?? {});
    // Comprobación y alta (o cambio de contraseña) en una transacción: dos
    // clics seguidos no crean dos usuarios ni dejan el enlace a medias.
    const user = db.transaction(() => {
      const row = invitacionPorToken(token);
      // Se vuelve a mirar: desde que se creó el enlace, el correo puede haber
      // pasado a ser de la administración o de otro cliente.
      const cuenta = cuentaDelCorreo(row.email, row.client_id);
      if (cuenta.estado === 'ajena') throw correoOcupado();
      let userId: string;
      if (cuenta.estado === 'propia') {
        userId = cuenta.id;
        // El mismo efecto que un restablecimiento desde la administración:
        // contraseña nueva, cuenta habilitada y fuera las sesiones abiertas
        // con la anterior (la de este navegador se abre después).
        db.prepare('UPDATE users SET password_hash = ?, disabled = 0 WHERE id = ?').run(
          hashPassword(body.password),
          userId,
        );
        if (body.name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(body.name, userId);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      } else {
        const nuevo = aceptarSchema.parse(req.body ?? {});
        userId = createUser({
          email: row.email,
          name: nuevo.name,
          password: nuevo.password,
          role: 'client',
          clientId: row.client_id,
        }).id;
      }
      db.prepare(
        'UPDATE client_invites SET accepted_at = ?, accepted_user_id = ?, token_enc = NULL WHERE id = ?',
      ).run(now(), userId, row.id);
      return {
        id: userId,
        clientId: row.client_id,
        email: row.email,
        inviteId: row.id,
        existing: cuenta.estado === 'propia',
      };
    })();
    createSession(req, reply, user.id);
    // audit() toma el actor de la sesión de la petición, que aún no existía.
    db.prepare(
      `INSERT INTO audit_log (user_id, client_id, action, detail, ip, created_at)
       VALUES (?, ?, 'client.invite_accepted', ?, ?, ?)`,
    ).run(
      user.id,
      user.clientId,
      JSON.stringify({ inviteId: user.inviteId, email: user.email, existing: user.existing }),
      req.ip || '',
      now(),
    );
    return { ok: true, redirect: '/puesta-en-marcha' };
  });
}
