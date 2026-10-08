import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { applyAdminFromEnv, correoConContrasenaDelEntorno } from '../src/modules/adminenv';
import { getTestApp } from './helpers';

/*
 * Administrador definido en el entorno (MAILWAY_ADMIN_EMAIL/PASSWORD): sirve
 * para recuperar el acceso sin terminal. Se prueba la función que llama el
 * arranque y, con la app real, que la cuenta entra por /api/auth/login.
 */

const EMAIL = 'recuperado@mailway.test';

async function entra(email: string, password: string): Promise<boolean> {
  const app = await getTestApp();
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  return res.statusCode === 200;
}

test('sin variables no cambia nada; con una sola y sin administradores, avisa', () => {
  assert.deepEqual(applyAdminFromEnv({}), { action: 'none' });
  // Solo la contraseña: sin ningún administrador no se sabe a quién crear.
  const sola = applyAdminFromEnv({ password: 'una-clave-larga-1' });
  assert.equal(sola.action, 'none');
  assert.match((sola as { warning?: string }).warning ?? '', /aún no hay ningún administrador/);
  // Solo el correo: falta la contraseña.
  const correo = applyAdminFromEnv({ email: EMAIL });
  assert.match((correo as { warning?: string }).warning ?? '', /necesita MAILWAY_ADMIN_PASSWORD/);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c, 0);
});

test('con la base vacía crea el primer administrador y los planes, y entra', async () => {
  const r = applyAdminFromEnv({ email: ` ${EMAIL.toUpperCase()} `, password: 'clave-del-entorno-1' });
  assert.deepEqual(r, { action: 'created', email: EMAIL });
  const user = db.prepare('SELECT role, name FROM users WHERE email = ?').get(EMAIL) as { role: string; name: string };
  assert.equal(user.role, 'admin');
  assert.equal(user.name, 'Administración');
  assert.ok((db.prepare('SELECT COUNT(*) AS c FROM plans').get() as { c: number }).c > 0);
  assert.ok(await entra(EMAIL, 'clave-del-entorno-1'));
});

test('con la misma contraseña no hace nada y no cierra sesiones', async () => {
  const antes = (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
  assert.ok(antes > 0);
  assert.deepEqual(applyAdminFromEnv({ email: EMAIL, password: 'clave-del-entorno-1' }), {
    action: 'unchanged',
    email: EMAIL,
  });
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c, antes);
});

test('con otra contraseña la fija, rehabilita la cuenta, cierra sesiones y no la anota', async () => {
  db.prepare('UPDATE users SET disabled = 1 WHERE email = ?').run(EMAIL);
  const r = applyAdminFromEnv({ email: EMAIL, password: 'otra-clave-nueva-2' });
  assert.deepEqual(r, { action: 'password_updated', email: EMAIL });
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c, 0);
  assert.ok(await entra(EMAIL, 'otra-clave-nueva-2'));
  assert.equal(await entra(EMAIL, 'clave-del-entorno-1'), false);
  const detalle = (db.prepare(`SELECT detail FROM audit_log WHERE action = 'auth.password_reset'`).get() as { detail: string }).detail;
  assert.ok(!detalle.includes('otra-clave-nueva-2'));
});

test('con un correo nuevo y usuarios ya existentes crea otro administrador', async () => {
  const r = applyAdminFromEnv({ email: 'segundo@mailway.test', password: 'clave-segundo-adm-3', name: 'Segundo' });
  assert.deepEqual(r, { action: 'created', email: 'segundo@mailway.test' });
  assert.ok(await entra('segundo@mailway.test', 'clave-segundo-adm-3'));
});

test('rechaza valores no válidos y a un usuario que no es administrador, sin cambiar nada', () => {
  assert.match((applyAdminFromEnv({ email: 'no-es-correo', password: 'clave-larga-valida-4' }) as { warning: string }).warning, /correo válido/);
  assert.match((applyAdminFromEnv({ email: EMAIL, password: 'corta' }) as { warning: string }).warning, /no es válido/);
  assert.match((applyAdminFromEnv({ email: EMAIL, password: 'dos\nlineas-largas-5' }) as { warning: string }).warning, /no es válido/);

  db.prepare(`UPDATE users SET role = 'client' WHERE email = ?`).run('segundo@mailway.test');
  const r = applyAdminFromEnv({ email: 'segundo@mailway.test', password: 'otra-clave-valida-6' });
  assert.match((r as { warning: string }).warning, /no es administrador/);
});

test('solo con MAILWAY_ADMIN_PASSWORD se aplica al único administrador', async () => {
  // En la prueba anterior «segundo» dejó de ser administrador: queda uno.
  const r = applyAdminFromEnv({ password: 'clave-solo-variable-7' });
  assert.deepEqual(r, { action: 'password_updated', email: EMAIL });
  assert.ok(await entra(EMAIL, 'clave-solo-variable-7'));
  assert.equal(correoConContrasenaDelEntorno({ password: 'clave-solo-variable-7' }), EMAIL);
});

test('con la contraseña en el entorno, el panel no deja cambiarla y lo dice en /me', async () => {
  const app = await getTestApp();
  const previo = { email: process.env.MAILWAY_ADMIN_EMAIL, password: process.env.MAILWAY_ADMIN_PASSWORD };
  process.env.MAILWAY_ADMIN_EMAIL = EMAIL;
  process.env.MAILWAY_ADMIN_PASSWORD = 'clave-solo-variable-7';
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: EMAIL, password: 'clave-solo-variable-7' },
    });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    assert.equal((me.json() as { user: { passwordFromEnv: boolean } }).user.passwordFromEnv, true);

    const cambio = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie },
      payload: { currentPassword: 'clave-solo-variable-7', newPassword: 'otra-desde-el-panel-8' },
    });
    assert.equal(cambio.statusCode, 409);
    assert.equal((cambio.json() as { code: string }).code, 'password_managed_by_env');
    assert.ok(await entra(EMAIL, 'clave-solo-variable-7'), 'sigue valiendo la de la variable');
  } finally {
    if (previo.email === undefined) delete process.env.MAILWAY_ADMIN_EMAIL;
    else process.env.MAILWAY_ADMIN_EMAIL = previo.email;
    if (previo.password === undefined) delete process.env.MAILWAY_ADMIN_PASSWORD;
    else process.env.MAILWAY_ADMIN_PASSWORD = previo.password;
  }
  // Sin la variable, la cuenta vuelve a gestionarse desde el panel.
  assert.equal(correoConContrasenaDelEntorno(), null);
});

test('solo con la contraseña y varios administradores, pide el correo', () => {
  db.prepare(`UPDATE users SET role = 'admin' WHERE email = ?`).run('segundo@mailway.test');
  const r = applyAdminFromEnv({ password: 'clave-solo-variable-9' });
  assert.match((r as { warning: string }).warning, /hay varios administradores/);
  assert.equal(correoConContrasenaDelEntorno({ password: 'clave-solo-variable-9' }), null);
});
