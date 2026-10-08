import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { db } from '../src/core/db';
import { adminContext, type TestContext } from './helpers';

/*
 * Herramienta de terminal para restablecer la contraseña de un usuario del
 * panel. Corre en otro proceso sobre la misma base (la carpeta de datos de
 * este fichero), como `docker exec` junto al panel en marcha. Lo importante:
 * que la contraseña no tenga que escribirse como argumento.
 */

const ADMIN = 'admin@mailway.test';
const SERVIDOR = path.resolve(__dirname, '..');

let ctx: TestContext;

before(async () => {
  ctx = await adminContext();
});

function ejecutar(args: string[], entrada?: string, entorno: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/tools/reset-password.ts', ...args], {
    cwd: SERVIDOR,
    encoding: 'utf8',
    timeout: 60_000,
    input: entrada,
    env: { ...process.env, ...entorno },
  });
}

async function entra(email: string, password: string): Promise<boolean> {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  return res.statusCode === 200;
}

test('sin contraseña genera una aleatoria, la muestra una vez y cierra las sesiones', async () => {
  const sesion = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: ctx.adminCookie } });
  assert.equal((sesion.json() as { user: { email: string } | null }).user?.email, ADMIN);

  const r = ejecutar([ADMIN.toUpperCase()]);
  assert.equal(r.status, 0, r.stderr);
  const generada = /Contraseña nueva de admin@mailway\.test: ([A-Za-z0-9_-]{24})\n/.exec(r.stdout)?.[1];
  assert.ok(generada, r.stdout);
  assert.equal(r.stderr, '');
  assert.ok(await entra(ADMIN, generada!));

  const cerrada = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: ctx.adminCookie } });
  assert.equal((cerrada.json() as { user: unknown }).user, null, 'la sesión anterior se ha cerrado');

  // Queda en la actividad como el sistema, sin la contraseña.
  const filas = db.prepare(`SELECT user_id, detail FROM audit_log WHERE action = 'auth.password_reset'`).all() as {
    user_id: string | null;
    detail: string;
  }[];
  assert.equal(filas.length, 1);
  assert.equal(filas[0]!.user_id, null);
  assert.ok(!filas[0]!.detail.includes(generada!));
  assert.deepEqual(JSON.parse(filas[0]!.detail), { email: ADMIN, generated: true, origen: 'terminal' });
});

test('con «-» lee la contraseña de la entrada estándar y no la repite', async () => {
  const clave = 'Elegida por la entrada 2026';
  const r = ejecutar([ADMIN, '-'], `${clave}\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(clave) && !r.stderr.includes(clave));
  assert.match(r.stdout, /Contraseña actualizada para admin@mailway\.test/);
  assert.ok(await entra(ADMIN, clave));
});

test('como argumento se admite, pero avisa de que queda en el historial y en ps', async () => {
  const clave = 'Escrita como argumento 1';
  const r = ejecutar([ADMIN, clave]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /historial del shell y a la vista en «ps»/);
  assert.ok(!r.stderr.includes(clave) && !r.stdout.includes(clave));
  assert.ok(await entra(ADMIN, clave));
});

test('rechaza contraseñas cortas, con saltos de línea o de un usuario inexistente sin cambiar nada', async () => {
  const vigente = 'Escrita como argumento 1';
  const corta = ejecutar([ADMIN, '-'], 'corta\n');
  assert.equal(corta.status, 1);
  assert.match(corta.stderr, /al menos 10 caracteres/);

  const dosLineas = ejecutar([ADMIN, '-'], 'primera línea larga\nsegunda línea\n');
  assert.equal(dosLineas.status, 1);
  assert.match(dosLineas.stderr, /saltos de línea/);
  assert.ok(!dosLineas.stderr.includes('primera línea larga'));

  const nadie = ejecutar(['nadie@mailway.test']);
  assert.equal(nadie.status, 1);
  assert.match(nadie.stderr, /No existe ningún usuario con el correo nadie@mailway\.test/);
  // Dice con qué correos se puede: quien está en el servidor puede no recordarlo.
  assert.match(nadie.stderr, /Correos de administración: admin@mailway\.test\./);
  assert.equal(nadie.stdout, '', 'sin usuario no se muestra ninguna contraseña');

  const sinCorreo = ejecutar([]);
  assert.equal(sinCorreo.status, 1);
  assert.match(sinCorreo.stderr, /Uso:/);

  assert.ok(await entra(ADMIN, vigente), 'la contraseña vigente no ha cambiado');
});

test('quita el bloqueo por intentos fallidos de ese correo: se entra en el acto', async () => {
  // Diez intentos fallidos bloquean el correo durante diez minutos.
  for (let i = 0; i < 10; i++) {
    await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ADMIN, password: `mala-${i}-clave` } });
  }
  const bloqueado = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ADMIN, password: 'otra-mala-clave' } });
  assert.equal(bloqueado.statusCode, 429);

  const r = ejecutar([ADMIN]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /quitado el bloqueo por intentos fallidos/);
  const nueva = /Contraseña nueva de admin@mailway\.test: ([A-Za-z0-9_-]{24})\n/.exec(r.stdout)?.[1];
  assert.ok(nueva, r.stdout);
  assert.ok(await entra(ADMIN, nueva!), 'entra sin esperar a que caduque el bloqueo');
});

test('no toca la contraseña que fija MAILWAY_ADMIN_PASSWORD y dice dónde cambiarla', async () => {
  const r = ejecutar([ADMIN], undefined, { MAILWAY_ADMIN_EMAIL: ADMIN, MAILWAY_ADMIN_PASSWORD: 'clave-de-la-variable-1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /la fija la variable MAILWAY_ADMIN_PASSWORD del panel/);
  assert.doesNotMatch(r.stdout, /Contraseña nueva/);
});
