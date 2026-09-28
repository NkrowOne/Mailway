import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashToken } from '../src/core/crypto';
import { db, now } from '../src/core/db';
import { createInitialAdmin, revokeOtherSessions } from '../src/modules/auth';

function seedSession(userId: string, token: string): void {
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, '', '')`,
  ).run(hashToken(token), userId, now(), now() + 60_000);
}

test('al cambiar la contraseña conserva la sesión actual y revoca las demás', () => {
  const id = `usr_sessions_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, role, created_at)
     VALUES (?, ?, 'Prueba', 'hash-prueba', 'admin', ?)`,
  ).run(id, `${id}@example.com`, now());

  const current = `current-${crypto.randomUUID()}`;
  const other = `other-${crypto.randomUUID()}`;
  seedSession(id, current);
  seedSession(id, other);

  revokeOtherSessions(id, current);

  const hashes = (
    db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').all(id) as {
      token_hash: string;
    }[]
  ).map((row) => row.token_hash);
  assert.deepEqual(hashes, [hashToken(current)]);
});

test('el alta inicial no permite crear un segundo administrador', () => {
  // La base compartida por la suite ya contiene usuarios; esta llamada debe
  // fallar con el error de dominio, no con una restricción SQLite ni un 500.
  assert.throws(
    () =>
      createInitialAdmin({
        email: `second-${crypto.randomUUID()}@example.com`,
        name: 'Segundo administrador',
        password: 'una-contraseña-segura',
      }),
    (error: unknown) =>
      typeof error === 'object' && error !== null && 'status' in error && error.status === 403,
  );
});
