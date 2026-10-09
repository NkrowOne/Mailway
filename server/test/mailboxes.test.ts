import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/core/db';
import { getEngine } from '../src/engine';
import { resetUsageRefreshState } from '../src/modules/mailboxes';
import {
  adminContext,
  createClient,
  createDomain,
  createMailbox,
  setDomainOwnership,
  type TestContext,
  motorAcepta,
} from './helpers';

let ctx: TestContext;

before(async () => {
  ctx = await adminContext();
});

function asAdmin(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return ctx.app.inject({ method, url, headers: { cookie: ctx.adminCookie }, payload: payload as object });
}

function asCookie(cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return ctx.app.inject({ method, url, headers: { cookie }, payload: payload as object });
}

interface MailboxView {
  id: string;
  email: string;
  quotaMb: number;
  usedBytes: number | null;
  usageCheckedAt: number | null;
  clientId: string;
  clientName: string;
}

/* ------------------------------ Ocupación -------------------------------- */

test('el listado incluye la ocupación, la refresca si está caducada y no falla si el motor falla', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId);
  const { mailboxId } = await createMailbox(ctx, domainId, 'ocupado');

  const first = (await asAdmin('GET', `/api/mailboxes?clientId=${clientId}`)).json().mailboxes as MailboxView[];
  assert.equal(first.length, 1);
  assert.equal(first[0]!.usedBytes, 0, 'un buzón recién creado está vacío');
  assert.equal(first[0]!.clientId, clientId);
  assert.ok(first[0]!.clientName);

  // Caché caducada: el listado vuelve a preguntar al motor (demo = 0 bytes).
  db.prepare('UPDATE mailboxes SET used_bytes = 12345, usage_checked_at = 1 WHERE id = ?').run(mailboxId);
  resetUsageRefreshState();
  const refreshed = (await asAdmin('GET', `/api/mailboxes?clientId=${clientId}`)).json().mailboxes as MailboxView[];
  assert.equal(refreshed[0]!.usedBytes, 0);
  assert.ok((refreshed[0]!.usageCheckedAt ?? 0) > 1);

  // Motor caído: se sirven los valores guardados, sin error.
  db.prepare('UPDATE mailboxes SET used_bytes = 777, usage_checked_at = 1 WHERE id = ?').run(mailboxId);
  resetUsageRefreshState();
  const engine = getEngine();
  const original = engine.getMailboxUsage.bind(engine);
  engine.getMailboxUsage = () => Promise.reject(new Error('motor caído'));
  try {
    const res = await asAdmin('GET', `/api/mailboxes?clientId=${clientId}`);
    assert.equal(res.statusCode, 200);
    assert.equal((res.json().mailboxes as MailboxView[])[0]!.usedBytes, 777);
  } finally {
    engine.getMailboxUsage = original;
  }

  // Motor lento: el listado no espera más de unos segundos.
  resetUsageRefreshState();
  let release: (() => void) | undefined;
  engine.getMailboxUsage = () =>
    new Promise((resolve) => {
      release = () => resolve(new Map());
    });
  try {
    const started = Date.now();
    const res = await asAdmin('GET', `/api/mailboxes?clientId=${clientId}`);
    assert.equal(res.statusCode, 200);
    assert.ok(Date.now() - started < 5000, 'el listado no queda bloqueado por el motor');
    assert.equal((res.json().mailboxes as MailboxView[])[0]!.usedBytes, 777);
  } finally {
    release?.();
    engine.getMailboxUsage = original;
  }
});

/* --------------------------- Edición y cuota ----------------------------- */

test('PATCH limita la cuota a la del plan (también para el usuario del cliente)', async () => {
  const { clientId, planId, userCookie } = await createClient(ctx, { withUser: true });
  const plan = (await asAdmin('GET', '/api/plans')).json().plans.find((p: { id: string }) => p.id === planId) as {
    mailboxQuotaMb: number;
  };
  const { domainId } = await createDomain(ctx, clientId);
  const { mailboxId } = await createMailbox(ctx, domainId, 'cuota');

  const res = await asCookie(userCookie!, 'PATCH', `/api/mailboxes/${mailboxId}`, {
    quotaMb: 1048576,
    displayName: 'Equipo de ventas',
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().mailbox.quotaMb, plan.mailboxQuotaMb);
  assert.equal(res.json().mailbox.displayName, 'Equipo de ventas');

  const lower = await asCookie(userCookie!, 'PATCH', `/api/mailboxes/${mailboxId}`, { quotaMb: 512 });
  assert.equal(lower.json().mailbox.quotaMb, 512);

  const invalid = await asCookie(userCookie!, 'PATCH', `/api/mailboxes/${mailboxId}`, { quotaMb: 10 });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, 'La cuota mínima es de 64 MB.');
});

test('restablecer la contraseña: generada o propia, con validación', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId);
  const { mailboxId, email, password } = await createMailbox(ctx, domainId, 'clave');
  const engine = getEngine();

  const generated = await asAdmin('POST', `/api/mailboxes/${mailboxId}/password`, {});
  assert.equal(generated.statusCode, 200);
  const newPassword = generated.json().password as string;
  assert.equal(await motorAcepta(email, newPassword), true);
  assert.equal(await motorAcepta(email, password), false);

  const short = await asAdmin('POST', `/api/mailboxes/${mailboxId}/password`, { password: 'corta' });
  assert.equal(short.statusCode, 400);
  assert.equal(short.json().error, 'La contraseña debe tener al menos 10 caracteres.');

  const own = await asAdmin('POST', `/api/mailboxes/${mailboxId}/password`, { password: 'una-clave-propia' });
  assert.equal(own.statusCode, 200);
  assert.equal(own.json().password, undefined, 'la elegida por el usuario no se devuelve');
  assert.equal(await motorAcepta(email, 'una-clave-propia'), true);
});

/* ------------------------------ Alta masiva ------------------------------ */

test('alta masiva: comprueba el plan para todo el lote antes de crear nada', async () => {
  const { clientId, planId } = await createClient(ctx);
  const plan = (await asAdmin('GET', '/api/plans')).json().plans.find((p: { id: string }) => p.id === planId) as {
    maxMailboxes: number;
  };
  const { domainId } = await createDomain(ctx, clientId);
  const entries = Array.from({ length: plan.maxMailboxes + 1 }, (_, i) => ({ localPart: `lote${i}` }));

  const res = await asAdmin('POST', '/api/mailboxes/bulk', { domainId, entries });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'plan_limit_reached');
  assert.match(res.json().error, /No se ha creado ninguno/);
  const count = (await asAdmin('GET', `/api/mailboxes?domainId=${domainId}`)).json().mailboxes.length;
  assert.equal(count, 0);

  const preview = await asAdmin('POST', '/api/mailboxes/bulk', { domainId, entries, dryRun: true });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().exceedsPlan, true);
  assert.deepEqual(preview.json().capacity, { used: 0, max: plan.maxMailboxes, remaining: plan.maxMailboxes });
});

test('alta masiva: valida cada línea, crea las válidas y devuelve sus contraseñas', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId, domain } = await createDomain(ctx, clientId);
  await createMailbox(ctx, domainId, 'existente');

  const entries = [
    { localPart: 'Ana', displayName: 'Ana García' },
    { localPart: 'mal nombre' },
    { localPart: 'ana' },
    { localPart: 'existente' },
    { localPart: 'luis' },
  ];
  const preview = await asAdmin('POST', '/api/mailboxes/bulk', { domainId, entries, dryRun: true });
  assert.equal(preview.json().valid, 2);
  assert.equal((await asAdmin('GET', `/api/mailboxes?domainId=${domainId}`)).json().mailboxes.length, 1);

  const res = await asAdmin('POST', '/api/mailboxes/bulk', { domainId, entries });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    created: number;
    failed: number;
    results: { email: string; ok: boolean; error?: string; password?: string }[];
  };
  assert.equal(body.created, 2);
  assert.equal(body.failed, 3);
  assert.deepEqual(
    body.results.map((r) => r.ok),
    [true, false, false, false, true],
  );
  assert.match(body.results[2]!.error!, /repetida/);
  assert.match(body.results[3]!.error!, /ya existe/);

  const engine = getEngine();
  const ana = body.results[0]!;
  assert.equal(ana.email, `ana@${domain}`);
  assert.equal(await motorAcepta(ana.email, ana.password!), true);

  const audit = db
    .prepare(`SELECT detail FROM audit_log WHERE action = 'mailbox.bulk_created' ORDER BY id DESC LIMIT 1`)
    .get() as { detail: string };
  assert.equal(JSON.parse(audit.detail).count, 2);
  assert.ok(!audit.detail.includes(ana.password!), 'la auditoría nunca guarda contraseñas');
});

test('alta masiva: un usuario de otro cliente no puede usar el dominio', async () => {
  const owner = await createClient(ctx);
  const intruder = await createClient(ctx, { withUser: true });
  const { domainId } = await createDomain(ctx, owner.clientId);
  const res = await asCookie(intruder.userCookie!, 'POST', '/api/mailboxes/bulk', {
    domainId,
    entries: [{ localPart: 'intruso' }],
  });
  assert.equal(res.statusCode, 403);
});

/* ---------------------------- Borrado y alias ---------------------------- */

test('eliminar un buzón lo retira de los alias (y elimina los que se quedan sin destinos)', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId);
  const a = await createMailbox(ctx, domainId, 'a');
  const b = await createMailbox(ctx, domainId, 'b');

  const shared = await asAdmin('POST', '/api/aliases', {
    domainId,
    localPart: 'equipo',
    destinations: [a.email.toUpperCase(), b.email],
  });
  assert.equal(shared.statusCode, 200, shared.body);
  const solo = await asAdmin('POST', '/api/aliases', { domainId, localPart: 'solo', destinations: [a.email] });
  assert.equal(solo.statusCode, 200);

  const del = await asAdmin('DELETE', `/api/mailboxes/${a.mailboxId}`);
  assert.equal(del.statusCode, 200, del.body);
  assert.equal(del.json().aliasesUpdated.length, 1);
  assert.equal(del.json().aliasesDeleted.length, 1);

  const aliases = (await asAdmin('GET', `/api/aliases?clientId=${clientId}`)).json().aliases as {
    localPart: string;
    destinations: string[];
  }[];
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0]!.localPart, 'equipo');
  assert.deepEqual(aliases[0]!.destinations, [b.email]);
});

test('eliminar un buzón remitente de una clave de API activa se rechaza', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId);
  const sender = await createMailbox(ctx, domainId, 'envios');
  const key = await asAdmin('POST', '/api/apikeys', { clientId, name: 'Web', senderMailboxId: sender.mailboxId });
  assert.equal(key.statusCode, 200, key.body);
  const del = await asAdmin('DELETE', `/api/mailboxes/${sender.mailboxId}`);
  assert.equal(del.statusCode, 409);
  assert.equal(del.json().code, 'mailbox_in_use');
});

test('alias: destinos externos, internos del mismo cliente, minúsculas y edición', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId, domain } = await createDomain(ctx, clientId);
  const box = await createMailbox(ctx, domainId, 'caja');

  const res = await asAdmin('POST', '/api/aliases', {
    domainId,
    localPart: 'Ventas',
    destinations: [box.email.toUpperCase(), 'Socio@Gmail.COM'],
  });
  assert.equal(res.statusCode, 200, res.body);
  const alias = res.json().alias as { id: string; email: string; destinations: string[]; externalDestinations: string[] };
  assert.equal(alias.email, `ventas@${domain}`);
  assert.deepEqual(alias.destinations, [box.email, 'socio@gmail.com']);
  assert.deepEqual(alias.externalDestinations, ['socio@gmail.com']);

  const stored = db.prepare('SELECT destinations_json FROM aliases WHERE id = ?').get(alias.id) as {
    destinations_json: string;
  };
  assert.equal(stored.destinations_json, JSON.stringify([box.email, 'socio@gmail.com']));

  const edit = await asAdmin('PATCH', `/api/aliases/${alias.id}`, { destinations: ['otra@externa.test'] });
  assert.equal(edit.statusCode, 200, edit.body);
  assert.deepEqual(edit.json().alias.destinations, ['otra@externa.test']);
  assert.deepEqual(edit.json().alias.externalDestinations, ['otra@externa.test']);

  const loop = await asAdmin('PATCH', `/api/aliases/${alias.id}`, { destinations: [alias.email] });
  assert.equal(loop.statusCode, 400);

  const missing = await asAdmin('PATCH', `/api/aliases/${alias.id}`, { destinations: [`noexiste@${domain}`] });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().code, 'destination_not_found');
});

test('alias: un buzón de otro cliente no puede ser destino', async () => {
  const mine = await createClient(ctx, { withUser: true });
  const other = await createClient(ctx);
  const myDomain = await createDomain(ctx, mine.clientId);
  const otherDomain = await createDomain(ctx, other.clientId);
  const foreign = await createMailbox(ctx, otherDomain.domainId, 'ajeno');

  const res = await asCookie(mine.userCookie!, 'POST', '/api/aliases', {
    domainId: myDomain.domainId,
    localPart: 'desvio',
    destinations: [foreign.email],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'destination_other_client');

  // Tampoco puede editar un alias de otro cliente.
  const own = await createMailbox(ctx, otherDomain.domainId, 'propio');
  const theirs = await asAdmin('POST', '/api/aliases', {
    domainId: otherDomain.domainId,
    localPart: 'suyo',
    destinations: [own.email],
  });
  const edit = await asCookie(mine.userCookie!, 'PATCH', `/api/aliases/${theirs.json().id}`, {
    destinations: ['fuera@externa.test'],
  });
  assert.equal(edit.statusCode, 403);
});

test('alias: el filtro ?clientId funciona para el administrador y el plan limita las altas', async () => {
  const one = await createClient(ctx);
  const two = await createClient(ctx);
  const d1 = await createDomain(ctx, one.clientId);
  const d2 = await createDomain(ctx, two.clientId);
  await asAdmin('POST', '/api/aliases', { domainId: d1.domainId, localPart: 'uno', destinations: ['x@fuera.test'] });
  await asAdmin('POST', '/api/aliases', { domainId: d2.domainId, localPart: 'dos', destinations: ['y@fuera.test'] });

  const filtered = (await asAdmin('GET', `/api/aliases?clientId=${one.clientId}`)).json().aliases as {
    clientId: string;
  }[];
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.clientId, one.clientId);

  // Plan con un único alias (ya usado): la siguiente alta se rechaza.
  const plan = await asAdmin('POST', '/api/plans', {
    name: `Sin alias ${Date.now()}`,
    maxDomains: 5,
    maxMailboxes: 5,
    maxAliases: 1,
    mailboxQuotaMb: 1024,
    apiDailyLimit: 10,
    apiPerMinuteLimit: 5,
  });
  await asAdmin('PATCH', `/api/clients/${one.clientId}`, { planId: plan.json().plan.id });
  const over = await asAdmin('POST', '/api/aliases', {
    domainId: d1.domainId,
    localPart: 'otro',
    destinations: ['z@fuera.test'],
  });
  assert.equal(over.statusCode, 400);
  assert.equal(over.json().code, 'plan_limit_reached');
});

test('un usuario de cliente solo lista sus buzones', async () => {
  const mine = await createClient(ctx, { withUser: true });
  const other = await createClient(ctx);
  const d1 = await createDomain(ctx, mine.clientId);
  const d2 = await createDomain(ctx, other.clientId);
  await createMailbox(ctx, d1.domainId, 'mio');
  await createMailbox(ctx, d2.domainId, 'suyo');
  const list = (await asCookie(mine.userCookie!, 'GET', `/api/mailboxes?clientId=${other.clientId}`)).json()
    .mailboxes as MailboxView[];
  assert.ok(list.length >= 1);
  assert.ok(list.every((m) => m.clientId === mine.clientId));
});

/* ------------------------- Propiedad del dominio -------------------------- */

test('sin propiedad comprobada del dominio no se crean buzones (uno o en lote) ni alias', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId, undefined, { ownershipVerified: false });

  const uno = await asAdmin('POST', '/api/mailboxes', { domainId, localPart: 'ana' });
  assert.equal(uno.statusCode, 409, uno.body);
  assert.equal(uno.json().code, 'domain_ownership_pending');
  assert.match(uno.json().error, /registro TXT de verificación/);

  // La revisión del alta masiva lo avisa antes de que nadie prepare el lote.
  const entries = [{ localPart: 'ana' }, { localPart: 'bea' }, { localPart: '-mal' }];
  const revision = await asAdmin('POST', '/api/mailboxes/bulk', { domainId, entries, dryRun: true });
  assert.equal(revision.statusCode, 200, revision.body);
  const cuerpo = revision.json() as {
    ownershipPending: boolean;
    ownershipError: string | null;
    valid: number;
    results: { ok: boolean; error?: string }[];
  };
  assert.equal(cuerpo.ownershipPending, true);
  assert.match(cuerpo.ownershipError ?? '', /comprobar que el dominio es tuyo/);
  assert.equal(cuerpo.valid, 0);
  assert.ok(cuerpo.results.every((r) => !r.ok && r.error));

  const lote = await asAdmin('POST', '/api/mailboxes/bulk', { domainId, entries });
  assert.equal(lote.statusCode, 409, lote.body);
  assert.equal(lote.json().code, 'domain_ownership_pending');

  const alias = await asAdmin('POST', '/api/aliases', { domainId, localPart: 'ventas', destinations: ['x@fuera.test'] });
  assert.equal(alias.statusCode, 409, alias.body);
  assert.equal(alias.json().code, 'domain_ownership_pending');

  const filas = db.prepare('SELECT COUNT(*) AS c FROM mailboxes WHERE domain_id = ?').get(domainId) as { c: number };
  assert.equal(filas.c, 0);

  // Con la propiedad comprobada, las mismas altas funcionan.
  setDomainOwnership(domainId, true);
  assert.equal((await asAdmin('POST', '/api/mailboxes', { domainId, localPart: 'ana' })).statusCode, 200);
  const revisionOk = await asAdmin('POST', '/api/mailboxes/bulk', { domainId, entries, dryRun: true });
  assert.equal(revisionOk.json().ownershipPending, false);
  assert.equal(revisionOk.json().ownershipError, null);
  assert.equal(revisionOk.json().valid, 1, 'solo «bea»: «ana» ya existe y «-mal» no es válido');
  const aliasOk = await asAdmin('POST', '/api/aliases', { domainId, localPart: 'ventas', destinations: ['x@fuera.test'] });
  assert.equal(aliasOk.statusCode, 200, aliasOk.body);
});

/* ------------------------- Altas simultáneas (A1) -------------------------- */

test('si otra petición registra el mismo buzón durante el alta, se responde 409 sin borrarlo del motor', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId);
  const engine = getEngine();
  const crear = engine.createMailbox.bind(engine);
  const borrar = engine.deleteMailbox.bind(engine);
  const borrados: string[] = [];
  engine.createMailbox = async (input) => {
    await crear(input);
    // La «otra» petición registra la misma dirección mientras esta espera al motor.
    db.prepare(
      `INSERT INTO mailboxes (id, domain_id, local_part, display_name, quota_mb, created_at)
       VALUES (?, ?, 'carrera', '', 1024, ?)`,
    ).run(`mbx_carrera_${Date.now()}`, domainId, Date.now());
  };
  engine.deleteMailbox = async (email: string) => {
    borrados.push(email);
    return borrar(email);
  };
  try {
    const res = await asAdmin('POST', '/api/mailboxes', { domainId, localPart: 'carrera' });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().code, 'mailbox_exists');
    assert.deepEqual(borrados, [], 'el principal del motor es de la otra petición y no se toca');
  } finally {
    engine.createMailbox = crear;
    engine.deleteMailbox = borrar;
  }
});

test('si otra petición registra el mismo alias durante el alta, se responde 409 sin borrar la lista', async () => {
  const { clientId } = await createClient(ctx);
  const { domainId } = await createDomain(ctx, clientId);
  const engine = getEngine();
  const upsert = engine.upsertAlias.bind(engine);
  const borrarAlias = engine.deleteAlias.bind(engine);
  const borrados: string[] = [];
  engine.upsertAlias = async (alias: string, internos: string[], externos?: string[]) => {
    await upsert(alias, internos, externos);
    db.prepare(
      `INSERT INTO aliases (id, domain_id, local_part, destinations_json, created_at)
       VALUES (?, ?, 'carrera', '[]', ?)`,
    ).run(`als_carrera_${Date.now()}`, domainId, Date.now());
  };
  engine.deleteAlias = async (alias: string) => {
    borrados.push(alias);
    return borrarAlias(alias);
  };
  try {
    const res = await asAdmin('POST', '/api/aliases', {
      domainId,
      localPart: 'carrera',
      destinations: ['x@fuera.test'],
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().code, 'alias_exists');
    assert.deepEqual(borrados, []);
  } finally {
    engine.upsertAlias = upsert;
    engine.deleteAlias = borrarAlias;
  }
});

test('al llegar al máximo del plan, el administrador lo amplía y el cliente lo solicita', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const plan = await asAdmin('POST', '/api/plans', {
    name: `Un buzón ${Date.now()}`,
    maxDomains: 1,
    maxMailboxes: 1,
    maxAliases: 1,
    mailboxQuotaMb: 1024,
    apiDailyLimit: 10,
    apiPerMinuteLimit: 5,
  });
  assert.equal(plan.statusCode, 200, plan.body);
  await asAdmin('PATCH', `/api/clients/${cliente.clientId}`, { planId: plan.json().plan.id });
  const { domainId } = await createDomain(ctx, cliente.clientId);
  await createMailbox(ctx, domainId, 'primero');

  const admin = await asAdmin('POST', '/api/mailboxes', { domainId, localPart: 'segundo' });
  assert.equal(admin.statusCode, 400);
  assert.equal(admin.json().code, 'plan_limit_reached');
  assert.match(admin.json().error, /Amplía el plan del cliente en su ficha\./);
  assert.doesNotMatch(admin.json().error, /Solicita/);

  const propio = await asCookie(cliente.userCookie!, 'POST', '/api/mailboxes', { domainId, localPart: 'segundo' });
  assert.equal(propio.statusCode, 400);
  assert.match(propio.json().error, /Solicita una ampliación del plan\./);
});
