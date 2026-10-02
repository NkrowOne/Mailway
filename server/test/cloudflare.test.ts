import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  CloudflareClient,
  CloudflareError,
  errorDeCloudflare,
  normalizarTxt,
  trocearTxt,
} from '../src/core/cloudflare';
import {
  construirLote,
  deseadosDeInstancia,
  ejecutarPlan,
  fusionarSpf,
  planificar,
  type Deseado,
} from '../src/modules/cloudflare';
import type { CfRegistro } from '../src/core/cloudflare';
import { db } from '../src/core/db';
import { getEngine } from '../src/engine';
import { setInstanceSettings } from '../src/modules/settings';
import { adminContext, createClient, createDomain, type TestContext } from './helpers';
import {
  ejecutarCloudflare,
  leerEntradaEstandar,
  MAX_ENTRADA as MAX_ENTRADA_CF,
  pareceToken,
} from '../src/tools/cloudflare';

/* ------------------------------------------------------------------------ */
/*  Cloudflare de mentira: zonas, registros y tokens en memoria, con la     */
/*  misma envoltura { success, errors, result } y los mismos códigos de     */
/*  error que la API real. Se instala sustituyendo fetch.                   */
/* ------------------------------------------------------------------------ */

interface ZonaFalsa {
  id: string;
  name: string;
  status: string;
  account: { id: string; name: string };
  name_servers: string[];
}

interface RegistroFalso {
  id: string;
  zoneId: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  proxied: boolean;
  ttl: number;
  comment: string | null;
  data?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

interface TokenFalso {
  kind: 'user' | 'account';
  accountId: string;
  zoneIds: string[];
  status: string;
}

interface Llamada {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  auth: string;
}

class CloudflareFalso {
  tokens = new Map<string, TokenFalso>();
  zonas: ZonaFalsa[] = [];
  registros: RegistroFalso[] = [];
  llamadas: Llamada[] = [];
  private seq = 0;

  reset(): void {
    this.tokens.clear();
    this.zonas = [];
    this.registros = [];
    this.llamadas = [];
  }

  zona(name: string, accountId = 'acc1', status = 'active'): ZonaFalsa {
    const z = {
      id: `zona_${name.replace(/\W/g, '_')}`,
      name,
      status,
      account: { id: accountId, name: `Cuenta ${accountId}` },
      name_servers: ['ana.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
    };
    this.zonas.push(z);
    return z;
  }

  token(token: string, t: Partial<TokenFalso> & { zoneIds: string[] }): void {
    this.tokens.set(token, { kind: 'user', accountId: 'acc1', status: 'active', ...t });
  }

  registro(zoneId: string, r: Omit<RegistroFalso, 'id' | 'zoneId' | 'ttl' | 'comment' | 'proxied'> &
    Partial<RegistroFalso>): RegistroFalso {
    const nuevo: RegistroFalso = {
      id: `rec_${++this.seq}`,
      zoneId,
      ttl: 1,
      comment: null,
      proxied: false,
      ...r,
    };
    this.registros.push(nuevo);
    return nuevo;
  }

  enZona(zoneId: string): RegistroFalso[] {
    return this.registros.filter((r) => r.zoneId === zoneId);
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  private error(status: number, code: number, message: string, chain?: { code: number; message: string }[]) {
    return this.json(status, {
      success: false,
      errors: [{ code, message, ...(chain ? { error_chain: chain } : {}) }],
      messages: [],
      result: null,
    });
  }

  private ok(result: unknown, info?: unknown): Response {
    return this.json(200, { success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) });
  }

  private paginar<T>(items: T[], q: URLSearchParams): Response {
    const per = Number(q.get('per_page') || 20);
    const page = Number(q.get('page') || 1);
    const total = Math.max(1, Math.ceil(items.length / per));
    return this.ok(items.slice((page - 1) * per, page * per), {
      page,
      per_page: per,
      total_pages: total,
      count: Math.min(per, items.length),
      total_count: items.length,
    });
  }

  private validar(lista: RegistroFalso[], r: RegistroFalso, ignorar?: string): Response | null {
    const mismos = lista.filter((x) => x.name === r.name && x.id !== ignorar);
    if (r.type === 'CNAME' && mismos.length > 0) return this.error(400, 81053, 'An A, AAAA, or CNAME record with that host already exists.');
    if (r.type !== 'CNAME' && mismos.some((x) => x.type === 'CNAME')) return this.error(400, 81054, 'A CNAME record with that host already exists.');
    const identico = mismos.some(
      (x) => x.type === r.type && x.content === r.content && JSON.stringify(x.data) === JSON.stringify(r.data),
    );
    if (identico) return this.error(400, 81058, 'An identical record already exists.');
    if (r.type === 'SRV' && (!r.data || r.data.weight === undefined)) return this.error(400, 9101, 'weight is required');
    return null;
  }

  private desdeCuerpo(zoneId: string, body: Record<string, unknown>, id?: string): RegistroFalso {
    const r: RegistroFalso = {
      id: id || `rec_${++this.seq}`,
      zoneId,
      type: String(body.type),
      name: String(body.name).toLowerCase(),
      content:
        body.type === 'SRV'
          ? `${(body.data as { weight: number }).weight} ${(body.data as { port: number }).port} ${(body.data as { target: string }).target}`
          : String(body.content ?? ''),
      priority: body.type === 'SRV' ? (body.data as { priority: number }).priority : (body.priority as number | undefined),
      proxied: Boolean(body.proxied),
      ttl: Number(body.ttl ?? 1),
      comment: (body.comment as string | undefined) ?? null,
      data: body.data as Record<string, unknown> | undefined,
    };
    return r;
  }

  /** Aplica un lote sobre una copia; si algo falla, no se toca nada (transaccional). */
  private lote(zoneId: string, body: Record<string, Record<string, unknown>[] | undefined>): Response {
    const copia = this.registros.map((r) => ({ ...r }));
    const res = { deletes: [] as RegistroFalso[], patches: [] as RegistroFalso[], puts: [] as RegistroFalso[], posts: [] as RegistroFalso[] };
    for (const d of body.deletes || []) {
      const i = copia.findIndex((r) => r.id === d.id && r.zoneId === zoneId);
      if (i < 0) return this.error(404, 81044, 'Record does not exist.');
      if (copia[i]!.meta?.email_routing) return this.error(400, 890190, 'Record is managed by Email Routing.');
      res.deletes.push(copia.splice(i, 1)[0]!);
    }
    for (const p of body.patches || []) {
      const r = copia.find((x) => x.id === p.id && x.zoneId === zoneId);
      if (!r) return this.error(404, 81044, 'Record does not exist.');
      if (r.meta?.email_routing) return this.error(400, 890190, 'Record is managed by Email Routing.');
      if (p.proxied !== undefined) r.proxied = Boolean(p.proxied);
      if (p.content !== undefined) r.content = String(p.content);
      res.patches.push(r);
    }
    for (const p of body.puts || []) {
      const i = copia.findIndex((x) => x.id === p.id && x.zoneId === zoneId);
      if (i < 0) return this.error(404, 81044, 'Record does not exist.');
      const nuevo = this.desdeCuerpo(zoneId, p, String(p.id));
      const fallo = this.validar(copia, nuevo, nuevo.id);
      if (fallo) return fallo;
      copia[i] = nuevo;
      res.puts.push(nuevo);
    }
    for (const p of body.posts || []) {
      const nuevo = this.desdeCuerpo(zoneId, p);
      const fallo = this.validar(copia, nuevo);
      if (fallo) return fallo;
      copia.push(nuevo);
      res.posts.push(nuevo);
    }
    this.registros = copia;
    return this.ok(res);
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method || 'GET').toUpperCase();
    const auth = new Headers(init.headers).get('authorization') || '';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname.replace(/^\/client\/v4/, '');
    this.llamadas.push({ method, path, query: url.searchParams, body, auth });

    const token = this.tokens.get(auth.replace(/^Bearer /, ''));
    if (path === '/user/tokens/verify') {
      if (!token || token.kind !== 'user') return this.error(401, 1000, 'Invalid API Token');
      return this.ok({ id: 'tok', status: token.status });
    }
    const verifyCuenta = path.match(/^\/accounts\/([^/]+)\/tokens\/verify$/);
    if (verifyCuenta) {
      if (!token || token.kind !== 'account' || token.accountId !== verifyCuenta[1]) {
        return this.error(401, 1000, 'Invalid API Token');
      }
      return this.ok({ id: 'tok', status: token.status });
    }
    if (!token) return this.error(401, 1000, 'Invalid API Token');

    if (path === '/zones' && method === 'GET') {
      const name = url.searchParams.get('name');
      const visibles = this.zonas.filter((z) => token.zoneIds.includes(z.id) && (!name || z.name === name));
      return this.paginar(visibles, url.searchParams);
    }
    const m = path.match(/^\/zones\/([^/]+)\/dns_records(?:\/(batch|[^/]+))?$/);
    if (m) {
      const zoneId = m[1]!;
      if (!token.zoneIds.includes(zoneId)) return this.error(403, 10000, 'Authentication error');
      const sub = m[2];
      if (!sub && method === 'GET') {
        const name = url.searchParams.get('name');
        const type = url.searchParams.get('type');
        const lista = this.enZona(zoneId).filter((r) => (!name || r.name === name) && (!type || r.type === type));
        return this.paginar(lista, url.searchParams);
      }
      if (sub === 'batch' && method === 'POST') return this.lote(zoneId, body);
      if (!sub && method === 'POST') return this.lote(zoneId, { posts: [body] });
      if (sub && method === 'DELETE') return this.lote(zoneId, { deletes: [{ id: sub }] });
      if (sub && method === 'PATCH') return this.lote(zoneId, { patches: [{ ...body, id: sub }] });
      if (sub && method === 'PUT') return this.lote(zoneId, { puts: [{ ...body, id: sub }] });
    }
    return this.error(404, 7000, 'No route for that URI');
  };
}

const cf = new CloudflareFalso();
const fetchOriginal = globalThis.fetch;

before(() => {
  globalThis.fetch = cf.fetch as typeof fetch;
});
after(() => {
  globalThis.fetch = fetchOriginal;
});
beforeEach(() => cf.reset());

const TOKEN_USUARIO = 'cfut_tokendeusuario0123456789abcdefghijklmnop';
const TOKEN_CUENTA = 'cfat_tokendecuenta0123456789abcdefghijklmnop';

/* --------------------------------- Cliente -------------------------------- */

test('verifica un token de usuario en la ruta de usuario', async () => {
  const z = cf.zona('ejemplo.es');
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });
  const info = await new CloudflareClient(TOKEN_USUARIO).verifyToken();
  assert.equal(info.kind, 'user');
  assert.deepEqual(cf.llamadas.map((l) => l.path), ['/user/tokens/verify']);
  assert.equal(cf.llamadas[0]!.auth, `Bearer ${TOKEN_USUARIO}`);
});

test('un token de cuenta (cfat_) se verifica en la ruta de su cuenta', async () => {
  const z = cf.zona('ejemplo.es', 'cuenta42');
  cf.token(TOKEN_CUENTA, { kind: 'account', accountId: 'cuenta42', zoneIds: [z.id] });
  const info = await new CloudflareClient(TOKEN_CUENTA).verifyToken();
  assert.equal(info.kind, 'account');
  assert.equal(info.accountId, 'cuenta42');
  const rutas = cf.llamadas.map((l) => l.path);
  assert.ok(!rutas.includes('/user/tokens/verify'), 'no debe probar la ruta de usuario');
  assert.deepEqual(rutas, ['/zones', '/accounts/cuenta42/tokens/verify']);
});

test('un token de cuenta sin prefijo se detecta por el código 1000', async () => {
  const z = cf.zona('ejemplo.es', 'cuenta7');
  const antiguo = 'a'.repeat(40);
  cf.token(antiguo, { kind: 'account', accountId: 'cuenta7', zoneIds: [z.id] });
  const info = await new CloudflareClient(antiguo).verifyToken();
  assert.equal(info.kind, 'account');
  assert.deepEqual(cf.llamadas.map((l) => l.path), ['/user/tokens/verify', '/zones', '/accounts/cuenta7/tokens/verify']);
});

test('un token no válido da un error en español que no incluye el token', async () => {
  await assert.rejects(new CloudflareClient(TOKEN_USUARIO).verifyToken(), (err: unknown) => {
    assert.ok(err instanceof CloudflareError);
    assert.equal(err.code, 'cloudflare_token_invalid');
    assert.match(err.message, /token de Cloudflare no es válido/);
    assert.ok(!err.message.includes(TOKEN_USUARIO));
    return true;
  });
});

test('la clave global se rechaza sin llegar a llamar a Cloudflare', async () => {
  await assert.rejects(new CloudflareClient('cfk_' + 'x'.repeat(40)).verifyToken(), /clave global/);
  await assert.rejects(new CloudflareClient('0123456789abcdef0123456789abcdef01234').verifyToken(), /clave global/);
  assert.equal(cf.llamadas.length, 0);
});

test('la zona de un subdominio se busca de la etiqueta más larga a la más corta', async () => {
  const z = cf.zona('ejemplo.es');
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });
  const zona = await new CloudflareClient(TOKEN_USUARIO).findZoneFor('a.b.ejemplo.es.');
  assert.equal(zona?.id, z.id);
  assert.deepEqual(
    cf.llamadas.map((l) => l.query.get('name')),
    ['a.b.ejemplo.es', 'b.ejemplo.es', 'ejemplo.es'],
  );
});

test('una zona que el token no ve no es un error: devuelve null', async () => {
  cf.zona('ejemplo.es');
  cf.token(TOKEN_USUARIO, { zoneIds: [] });
  assert.equal(await new CloudflareClient(TOKEN_USUARIO).findZoneFor('ejemplo.es'), null);
  assert.equal(cf.llamadas.length, 1, 'no debe probar el TLD suelto');
});

test('los listados recorren todas las páginas', async () => {
  const z = cf.zona('ejemplo.es');
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });
  for (let i = 0; i < 230; i++) cf.registro(z.id, { type: 'A', name: `h${i}.ejemplo.es`, content: '192.0.2.1' });
  const lista = await new CloudflareClient(TOKEN_USUARIO).listRecords(z.id);
  assert.equal(lista.length, 230);
  assert.deepEqual(cf.llamadas.map((l) => l.query.get('page')), ['1', '2', '3']);
});

test('el lote envía solo las listas con operaciones', async () => {
  const z = cf.zona('ejemplo.es');
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });
  await new CloudflareClient(TOKEN_USUARIO).batch(z.id, {
    deletes: [],
    posts: [{ type: 'A', name: 'mail.ejemplo.es', content: '192.0.2.1', ttl: 1, proxied: false, comment: 'Mailway' }],
  });
  const llamada = cf.llamadas[0]!;
  assert.equal(llamada.method, 'POST');
  assert.equal(llamada.path, `/zones/${z.id}/dns_records/batch`);
  assert.deepEqual(Object.keys(llamada.body as object), ['posts']);
});

/* ----------------------------------- TXT ---------------------------------- */

test('TXT: se trocea en cadenas de 255 bytes y se normaliza de vuelta', () => {
  const dkim = 'v=DKIM1; k=rsa; p=' + 'M'.repeat(400);
  const troceado = trocearTxt(dkim);
  const cadenas = troceado.match(/"(?:[^"\\]|\\.)*"/g)!;
  assert.equal(cadenas.length, 2);
  for (const c of cadenas) assert.ok(Buffer.byteLength(c.slice(1, -1)) <= 255);
  assert.equal(normalizarTxt(troceado), dkim);
});

test('TXT: las comillas y barras internas se escapan y se recuperan', () => {
  const valor = 'texto con "comillas" y \\ barra';
  assert.equal(normalizarTxt(trocearTxt(valor)), valor);
  assert.equal(normalizarTxt('v=spf1 mx -all'), 'v=spf1 mx -all', 'sin comillas se deja tal cual');
});

/* --------------------------------- Errores -------------------------------- */

test('los códigos de Cloudflare se traducen a mensajes en español', () => {
  const casos: [number, { code: number; message: string; error_chain?: { code: number; message: string }[] }[], string][] = [
    [401, [{ code: 1000, message: 'Invalid API Token' }], 'cloudflare_token_invalid'],
    [400, [{ code: 6003, message: 'Invalid request headers', error_chain: [{ code: 6111, message: 'Invalid format for Authorization header' }] }], 'cloudflare_token_malformed'],
    [403, [{ code: 9109, message: 'Unauthorized to access requested resource' }], 'cloudflare_forbidden'],
    [403, [{ code: 10000, message: 'Authentication error' }], 'cloudflare_forbidden'],
    [400, [{ code: 1004, message: 'DNS Validation Error', error_chain: [{ code: 9005, message: 'Content for A record must be a valid IPv4 address.' }] }], 'cloudflare_invalid_record'],
    [400, [{ code: 81057, message: 'Record already exists.' }], 'cloudflare_identical'],
    [400, [{ code: 81058, message: 'An identical record already exists.' }], 'cloudflare_identical'],
    [400, [{ code: 81053, message: 'An A, AAAA, or CNAME record with that host already exists.' }], 'cloudflare_exists'],
    [400, [{ code: 890190, message: 'locked' }], 'cloudflare_email_routing'],
    [400, [{ code: 1046, message: 'locked' }], 'cloudflare_email_routing'],
    [429, [{ code: 971, message: 'Please wait and consider throttling your request speed' }], 'cloudflare_rate_limited'],
    [500, [{ code: 1234, message: 'Something' }], 'cloudflare_error'],
  ];
  for (const [status, errores, codigo] of casos) {
    const err = errorDeCloudflare(status, errores);
    assert.equal(err.code, codigo, `código ${errores[0]!.code}`);
    assert.ok(err.message.length > 10);
  }
  assert.equal(errorDeCloudflare(400, [{ code: 81058, message: 'x' }]).idempotente, true);
  assert.match(errorDeCloudflare(400, [{ code: 890190, message: 'x' }]).message, /Desactiva Email Routing/);
  assert.match(errorDeCloudflare(400, [{ code: 1004, message: 'DNS Validation Error', error_chain: [{ code: 9005, message: 'Bad IP' }] }]).message, /Bad IP/);
});

/* ---------------------------------- Plan ---------------------------------- */

const APEX = 'ejemplo.es';

function existente(r: Partial<CfRegistro> & { type: string; name: string; content: string }): CfRegistro {
  return { id: `id_${Math.random().toString(16).slice(2)}`, proxied: false, ttl: 1, comment: null, bloqueado: false, ...r };
}

const spf: Deseado = { type: 'TXT', name: APEX, content: 'v=spf1 mx ra=postmaster -all', required: true };
const mx: Deseado = { type: 'MX', name: APEX, content: 'mail.servidor.es', priority: 10, required: true };
const dmarc: Deseado = { type: 'TXT', name: `_dmarc.${APEX}`, content: 'v=DMARC1; p=reject; rua=mailto:postmaster@ejemplo.es', required: true };
const autoconfig: Deseado = { type: 'CNAME', name: `autoconfig.${APEX}`, content: 'mail.servidor.es', required: false };

test('fusionarSpf añade «mx» antes del all final y conserva lo demás', () => {
  assert.deepEqual(fusionarSpf('v=spf1 include:_spf.google.com ~all', 'v=spf1 mx ra=postmaster -all'), {
    valor: 'v=spf1 include:_spf.google.com mx ~all',
    anadidos: ['mx'],
  });
  assert.equal(fusionarSpf('v=spf1 +mx include:x.com -all', 'v=spf1 mx -all'), null, '+mx equivale a mx');
  assert.equal(fusionarSpf('v=spf1 include:x.com', 'v=spf1 mx -all')!.valor, 'v=spf1 include:x.com mx');
});

test('fusionarSpf: un «mx» detrás de «all» no cuenta y se añade delante del primer «all»', () => {
  assert.deepEqual(fusionarSpf('v=spf1 include:_spf.google.com -all mx', 'v=spf1 mx ra=postmaster -all'), {
    valor: 'v=spf1 include:_spf.google.com mx -all mx',
    anadidos: ['mx'],
  });
  assert.equal(fusionarSpf('v=spf1 mx:ejemplo.es ~all', 'v=spf1 mx -all', { nombre: 'ejemplo.es' }), null);
  assert.equal(
    fusionarSpf('v=spf1 ip4:203.0.113.10 -all', 'v=spf1 mx -all', { nombre: APEX, ipServidor: '203.0.113.10' }),
    null,
    'la IP del servidor ya lo autoriza, igual que en la comprobación DNS',
  );
});

test('SPF con «mx» detrás de «all»: el plan lo corrige, no lo conserva', () => {
  const [c] = planificar([spf], [existente({ type: 'TXT', name: APEX, content: 'v=spf1 include:x.com -all mx' })], {
    apex: APEX,
  });
  assert.equal(c!.action, 'update');
  assert.equal(c!.content, 'v=spf1 include:x.com mx -all mx');
});

test('dos DMARC: conflicto que nunca se corrige solo, como con dos SPF', () => {
  const [c] = planificar(
    [dmarc],
    [
      existente({ type: 'TXT', name: `_dmarc.${APEX}`, content: 'v=DMARC1; p=reject' }),
      existente({ type: 'TXT', name: `_dmarc.${APEX}`, content: 'v=DMARC1; p=none' }),
    ],
    { apex: APEX },
  );
  assert.equal(c!.action, 'conflict');
  assert.equal(c!.reemplazo, null, 'ni con confirmación');
  assert.match(c!.reason, /Hay 2 registros DMARC/);
});

test('DMARC existente con espacios: se conserva y se lee su política (p, no sp)', () => {
  const [c] = planificar(
    [dmarc],
    [existente({ type: 'TXT', name: `_dmarc.${APEX}`, content: 'v = DMARC1; sp=none; p = quarantine' })],
    { apex: APEX },
  );
  assert.equal(c!.action, 'keep');
  assert.match(c!.reason, /p=quarantine/);
});

test('SPF existente: se fusiona con un cambio parcial del contenido', () => {
  const actual = existente({ type: 'TXT', name: APEX, content: '"v=spf1 include:_spf.google.com ~all"' });
  const [c] = planificar([spf], [actual], { apex: APEX });
  assert.equal(c!.action, 'update');
  assert.equal(c!.content, 'v=spf1 include:_spf.google.com mx ~all');
  assert.match(c!.reason, /Se añadirá «mx»/);
  assert.deepEqual(c!.operaciones!.patches, [{ id: actual.id, content: '"v=spf1 include:_spf.google.com mx ~all"' }]);
});

test('SPF que ya incluye mx: se conserva', () => {
  const [c] = planificar([spf], [existente({ type: 'TXT', name: APEX, content: 'v=spf1 mx include:x.com -all' })], { apex: APEX });
  assert.equal(c!.action, 'keep');
});

test('dos SPF: conflicto que nunca se corrige solo', () => {
  const [c] = planificar(
    [spf],
    [
      existente({ type: 'TXT', name: APEX, content: 'v=spf1 include:a.com ~all' }),
      existente({ type: 'TXT', name: APEX, content: 'v=spf1 include:b.com ~all' }),
    ],
    { apex: APEX },
  );
  assert.equal(c!.action, 'conflict');
  assert.equal(c!.reemplazo, null, 'ni con confirmación');
  assert.match(c!.reason, /Hay 2 registros SPF/);
});

test('DMARC existente: se conserva aunque sea distinto', () => {
  const [c] = planificar([dmarc], [existente({ type: 'TXT', name: `_dmarc.${APEX}`, content: 'v=DMARC1; p=none' })], {
    apex: APEX,
  });
  assert.equal(c!.action, 'keep');
  assert.match(c!.reason, /p=none/);
});

test('MX de otro proveedor: conflicto que solo se reemplaza con confirmación', async () => {
  const ajeno = existente({ type: 'MX', name: APEX, content: 'mx.otro.com', priority: 5 });
  const cambios = planificar([mx], [ajeno], { apex: APEX });
  assert.equal(cambios[0]!.action, 'conflict');
  assert.match(cambios[0]!.reason, /recibe hoy el correo en mx\.otro\.com/);
  assert.deepEqual(cambios[0]!.reemplazo!.deletes, [ajeno.id]);
  assert.equal(cambios[0]!.reemplazo!.posts[0]!.type, 'MX');

  const z = cf.zona(APEX);
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });
  const cliente = new CloudflareClient(TOKEN_USUARIO);
  const sin = await ejecutarPlan(cliente, z.id, cambios, { replaceConflicts: false });
  assert.equal(sin.applied.length, 0);
  assert.equal(sin.skipped.length, 1);
  assert.equal(cf.llamadas.length, 0, 'sin confirmación no se toca nada');
});

test('MX de Cloudflare Email Routing: el aviso indica cómo desactivarlo', () => {
  const [c] = planificar([mx], [existente({ type: 'MX', name: APEX, content: 'route1.mx.cloudflare.net', priority: 1 })], {
    apex: APEX,
  });
  assert.match(c!.reason, /Email Routing/);
});

test('un registro bloqueado por Email Routing no se puede reemplazar', () => {
  const [c] = planificar(
    [mx],
    [existente({ type: 'MX', name: APEX, content: 'route1.mx.cloudflare.net', priority: 1, bloqueado: true })],
    { apex: APEX },
  );
  assert.equal(c!.action, 'conflict');
  assert.equal(c!.reemplazo, null);
});

test('un CNAME propio con proxy se actualiza para quitar el proxy', () => {
  const actual = existente({ type: 'CNAME', name: `autoconfig.${APEX}`, content: 'mail.servidor.es', proxied: true });
  const [c] = planificar([autoconfig], [actual], { apex: APEX });
  assert.equal(c!.action, 'update');
  assert.match(c!.reason, /proxy/);
  assert.deepEqual(c!.operaciones!.patches, [{ id: actual.id, proxied: false }]);
});

test('un CNAME que choca con un A es un conflicto', () => {
  const [c] = planificar([autoconfig], [existente({ type: 'A', name: `autoconfig.${APEX}`, content: '198.51.100.9' })], {
    apex: APEX,
  });
  assert.equal(c!.action, 'conflict');
  assert.match(c!.reason, /CNAME no puede convivir/);
});

test('un A que ya apunta a la IP del servidor equivale al CNAME', () => {
  const [c] = planificar([autoconfig], [existente({ type: 'A', name: `autoconfig.${APEX}`, content: '203.0.113.10' })], {
    apex: APEX,
    publicIp: '203.0.113.10',
  });
  assert.equal(c!.action, 'keep');
});

test('lo que ya está bien se conserva y aplicar no hace ninguna llamada', async () => {
  const srv: Deseado = {
    type: 'SRV',
    name: `_imaps._tcp.${APEX}`,
    content: '0 1 993 mail.servidor.es',
    data: { priority: 0, weight: 1, port: 993, target: 'mail.servidor.es' },
    required: false,
  };
  const cambios = planificar(
    [mx, spf, autoconfig, srv],
    [
      existente({ type: 'MX', name: APEX, content: 'mail.servidor.es', priority: 10 }),
      existente({ type: 'TXT', name: APEX, content: '"v=spf1 mx ra=postmaster -all"' }),
      existente({ type: 'CNAME', name: `autoconfig.${APEX}`, content: 'mail.servidor.es' }),
      existente({
        type: 'SRV',
        name: `_imaps._tcp.${APEX}`,
        content: '1 993 mail.servidor.es',
        priority: 0,
        data: { priority: 0, weight: 1, port: 993, target: 'mail.servidor.es' },
      }),
    ],
    { apex: APEX },
  );
  assert.deepEqual(cambios.map((c) => c.action), ['keep', 'keep', 'keep', 'keep']);
  const r = await ejecutarPlan(new CloudflareClient(TOKEN_USUARIO), 'zona', cambios, { replaceConflicts: true });
  assert.deepEqual(r, { applied: [], errors: [], skipped: [] });
  assert.equal(cf.llamadas.length, 0);
});

test('construirLote no borra dos veces el mismo registro', () => {
  const lote = construirLote([
    { deletes: ['a'], patches: [], puts: [], posts: [] },
    { deletes: ['a', 'b'], patches: [], puts: [], posts: [] },
  ]);
  assert.deepEqual(lote.deletes, [{ id: 'a' }, { id: 'b' }]);
});

/* ------------------------------ Rutas (API) ------------------------------- */

let ctx: TestContext;

before(async () => {
  ctx = await adminContext();
});

async function conectar(
  cookie: string,
  token: string,
  extra: Record<string, unknown> = {},
): Promise<{ statusCode: number; body: string; json: () => unknown }> {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/cloudflare/accounts',
    headers: { cookie },
    payload: { token, ...extra },
  });
}

test('conectar una cuenta: se verifica el token y nunca se devuelve', async () => {
  const z = cf.zona('conectar.es');
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });
  const res = await conectar(ctx.adminCookie, TOKEN_USUARIO, { label: 'Principal' });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(!res.body.includes(TOKEN_USUARIO), 'el token no debe volver en la respuesta');
  const { account } = res.json() as { account: { id: string; clientId: string | null; tokenHint: string; zones: string[] } };
  assert.equal(account.clientId, null);
  assert.equal(account.tokenHint, TOKEN_USUARIO.slice(-4));
  assert.deepEqual(account.zones, ['conectar.es']);

  const lista = await ctx.app.inject({ method: 'GET', url: '/api/cloudflare/accounts', headers: { cookie: ctx.adminCookie } });
  assert.ok(!lista.body.includes(TOKEN_USUARIO));
  assert.ok((lista.json() as { accounts: { id: string }[] }).accounts.some((a) => a.id === account.id));

  const fila = db.prepare('SELECT token_enc FROM cloudflare_accounts WHERE id = ?').get(account.id) as { token_enc: string };
  assert.ok(!fila.token_enc.includes(TOKEN_USUARIO), 'en la base de datos va cifrado');
  const auditoria = db.prepare("SELECT detail FROM audit_log WHERE action = 'cloudflare.account_connected'").all() as { detail: string }[];
  assert.ok(auditoria.length > 0);
  assert.ok(auditoria.every((a) => !a.detail.includes(TOKEN_USUARIO)));

  const repetida = await conectar(ctx.adminCookie, TOKEN_USUARIO);
  assert.equal(repetida.statusCode, 409);

  await ctx.app.inject({ method: 'DELETE', url: `/api/cloudflare/accounts/${account.id}`, headers: { cookie: ctx.adminCookie } });
});

test('un token sin zonas o no válido no se guarda', async () => {
  cf.token(TOKEN_USUARIO, { zoneIds: [] });
  const sinZonas = await conectar(ctx.adminCookie, TOKEN_USUARIO);
  assert.equal(sinZonas.statusCode, 400);
  assert.match((sinZonas.json() as { error: string }).error, /ninguna zona/);

  const invalido = await conectar(ctx.adminCookie, 'cfut_noexiste0123456789abcdefghij');
  assert.equal(invalido.statusCode, 400);
  assert.equal((invalido.json() as { code: string }).code, 'cloudflare_token_invalid');
});

test('un cliente solo ve, conecta y borra sus propias cuentas', async () => {
  const a = await createClient(ctx, { withUser: true });
  const b = await createClient(ctx, { withUser: true });
  const z = cf.zona('cliente-a.es');
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });

  const ajena = await conectar(a.userCookie!, TOKEN_USUARIO, { clientId: b.clientId });
  assert.equal(ajena.statusCode, 403);

  const propia = await conectar(a.userCookie!, TOKEN_USUARIO);
  assert.equal(propia.statusCode, 200, propia.body);
  const id = (propia.json() as { account: { id: string; clientId: string } }).account.id;
  assert.equal((propia.json() as { account: { clientId: string } }).account.clientId, a.clientId);

  const listaB = await ctx.app.inject({ method: 'GET', url: '/api/cloudflare/accounts', headers: { cookie: b.userCookie! } });
  assert.deepEqual((listaB.json() as { accounts: unknown[] }).accounts, []);

  const borrarB = await ctx.app.inject({ method: 'DELETE', url: `/api/cloudflare/accounts/${id}`, headers: { cookie: b.userCookie! } });
  assert.equal(borrarB.statusCode, 404);

  const borrarA = await ctx.app.inject({ method: 'DELETE', url: `/api/cloudflare/accounts/${id}`, headers: { cookie: a.userCookie! } });
  assert.equal(borrarA.statusCode, 200);
});

test('un cliente no puede usar la cuenta de otro cliente ni la de la instancia', async () => {
  const a = await createClient(ctx, { withUser: true });
  const b = await createClient(ctx, { withUser: true });
  const z = cf.zona('ajeno.es');
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });
  const TOKEN_INSTANCIA = 'cfut_instancia0123456789abcdefghijklmn';
  cf.token(TOKEN_INSTANCIA, { zoneIds: [z.id] });

  // La cuenta de A ve la zona; el dominio es de B.
  const cuentaA = await conectar(a.userCookie!, TOKEN_USUARIO);
  assert.equal(cuentaA.statusCode, 200);
  const cuentaInstancia = await conectar(ctx.adminCookie, TOKEN_INSTANCIA);
  assert.equal(cuentaInstancia.statusCode, 200);
  const { domainId } = await createDomain(ctx, b.clientId, 'ajeno.es');

  const plan = await ctx.app.inject({ method: 'GET', url: `/api/domains/${domainId}/cloudflare`, headers: { cookie: b.userCookie! } });
  assert.equal(plan.statusCode, 200);
  const cuerpo = plan.json() as { available: boolean; reason: string };
  assert.equal(cuerpo.available, false);
  assert.match(cuerpo.reason, /administrador/);

  const aplicar = await ctx.app.inject({
    method: 'POST',
    url: `/api/domains/${domainId}/cloudflare/apply`,
    headers: { cookie: b.userCookie! },
    payload: {},
  });
  assert.equal(aplicar.statusCode, 400);
  assert.equal(cf.llamadas.filter((l) => l.path.endsWith('/batch')).length, 0, 'nunca se escribe en la zona');

  // A no puede ni ver el plan de un dominio de B.
  const deA = await ctx.app.inject({ method: 'GET', url: `/api/domains/${domainId}/cloudflare`, headers: { cookie: a.userCookie! } });
  assert.equal(deA.statusCode, 403);

  // El administrador sí puede usar la cuenta de la instancia; con solo
  // consultar el plan, la cuenta no queda a disposición del cliente…
  const admin = await ctx.app.inject({ method: 'GET', url: `/api/domains/${domainId}/cloudflare`, headers: { cookie: ctx.adminCookie } });
  assert.equal((admin.json() as { available: boolean }).available, true);
  const trasVer = await ctx.app.inject({ method: 'GET', url: `/api/domains/${domainId}/cloudflare`, headers: { cookie: b.userCookie! } });
  assert.equal((trasVer.json() as { available: boolean }).available, false);
  // …ni tampoco cuando el administrador aplica el DNS: la cuenta queda
  // asociada al dominio, pero el token del operador nunca se usa en una
  // acción del cliente (antes sí, y el cliente podía reescribir la zona).
  const aplicado = await ctx.app.inject({
    method: 'POST',
    url: `/api/domains/${domainId}/cloudflare/apply`,
    headers: { cookie: ctx.adminCookie },
    payload: {},
  });
  assert.equal(aplicado.statusCode, 200, aplicado.body);
  const cuentaInstanciaId = (cuentaInstancia.json() as { account: { id: string } }).account.id;
  const asociada = db.prepare('SELECT cloudflare_account_id AS id FROM domains WHERE id = ?').get(domainId) as { id: string };
  assert.equal(asociada.id, cuentaInstanciaId, 'la asociación queda para el administrador');

  cf.llamadas = [];
  const despues = await ctx.app.inject({ method: 'GET', url: `/api/domains/${domainId}/cloudflare`, headers: { cookie: b.userCookie! } });
  const cuerpoDespues = despues.json() as { available: boolean; reason: string };
  assert.equal(cuerpoDespues.available, false);
  assert.match(cuerpoDespues.reason, /lo configuró el administrador con la cuenta de Cloudflare de la instancia/);
  const reaplicar = await ctx.app.inject({
    method: 'POST',
    url: `/api/domains/${domainId}/cloudflare/apply`,
    headers: { cookie: b.userCookie! },
    payload: { replaceConflicts: true },
  });
  assert.equal(reaplicar.statusCode, 400);
  assert.equal((reaplicar.json() as { code: string }).code, 'cloudflare_unavailable');
  // Ni siquiera se consulta Cloudflare con el token del operador.
  assert.ok(
    cf.llamadas.every((l) => l.auth !== `Bearer ${TOKEN_INSTANCIA}`),
    'el token de la instancia no se usa en una acción del cliente',
  );
  // Lo mismo con un token de administración en nombre del cliente (Skyway).
  const enNombre = await ctx.app.inject({
    method: 'POST',
    url: `/api/domains/${domainId}/cloudflare/apply?soloCliente=1`,
    headers: { cookie: ctx.adminCookie },
    payload: { replaceConflicts: true },
  });
  assert.equal(enNombre.statusCode, 400);
  assert.ok(cf.llamadas.every((l) => l.auth !== `Bearer ${TOKEN_INSTANCIA}`));
  // El administrador sí puede seguir usándola sobre ese dominio.
  const admin2 = await ctx.app.inject({ method: 'GET', url: `/api/domains/${domainId}/cloudflare`, headers: { cookie: ctx.adminCookie } });
  assert.equal((admin2.json() as { available: boolean }).available, true);

  for (const c of [cuentaA, cuentaInstancia]) {
    const id = (c.json() as { account: { id: string } }).account.id;
    await ctx.app.inject({ method: 'DELETE', url: `/api/cloudflare/accounts/${id}`, headers: { cookie: ctx.adminCookie } });
  }
});

test('plan y aplicación de un dominio: registros sin proxy, marcados y en un solo lote', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const z = cf.zona('aplicar.es');
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });
  // Ya hay un SPF de Google y un DMARC propio: se fusiona y se conserva.
  cf.registro(z.id, { type: 'TXT', name: 'aplicar.es', content: '"v=spf1 include:_spf.google.com ~all"' });
  cf.registro(z.id, { type: 'TXT', name: '_dmarc.aplicar.es', content: 'v=DMARC1; p=none' });
  cf.registro(z.id, { type: 'A', name: 'www.aplicar.es', content: '198.51.100.1', proxied: true });

  const cuenta = await conectar(cliente.userCookie!, TOKEN_USUARIO);
  assert.equal(cuenta.statusCode, 200);
  const { domainId } = await createDomain(ctx, cliente.clientId, 'aplicar.es', { ownershipVerified: false });

  const planRes = await ctx.app.inject({ method: 'GET', url: `/api/domains/${domainId}/cloudflare`, headers: { cookie: cliente.userCookie! } });
  assert.equal(planRes.statusCode, 200, planRes.body);
  const plan = planRes.json() as {
    available: boolean;
    zone: { name: string };
    changes: { action: string; type: string; name: string; reason: string }[];
    summary: Record<string, number>;
  };
  assert.equal(plan.available, true);
  assert.equal(plan.zone.name, 'aplicar.es');
  const accion = (type: string, name: string) => plan.changes.find((c) => c.type === type && c.name === name)?.action;
  assert.equal(accion('MX', 'aplicar.es'), 'create');
  assert.equal(accion('TXT', 'aplicar.es'), 'update', 'el SPF se fusiona');
  assert.equal(accion('TXT', '_dmarc.aplicar.es'), 'keep', 'el DMARC existente se conserva');
  assert.equal(accion('TXT', 'mail._domainkey.aplicar.es'), 'create');
  assert.ok(!planRes.body.includes('operaciones'), 'las operaciones internas no salen por la API');

  cf.llamadas = [];
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/domains/${domainId}/cloudflare/apply`,
    headers: { cookie: cliente.userCookie! },
    payload: { replaceConflicts: false },
  });
  assert.equal(res.statusCode, 200, res.body);
  const cuerpo = res.json() as {
    applied: { action: string; type: string; name: string }[];
    errors: unknown[];
    domain: {
      cloudflare: { zoneId: string } | null;
      dnsAppliedAt: number | null;
      ownershipVerifiedAt: number | null;
      ownershipRecord: { name: string; content: string };
    };
  };
  assert.equal(cuerpo.errors.length, 0);
  // MX, SPF (fusión), DKIM y el TXT de verificación de la propiedad.
  assert.equal(cuerpo.applied.length, 4);
  assert.ok(cuerpo.applied.some((a) => a.type === 'TXT' && a.name === '_mailway.aplicar.es'));
  assert.equal(cuerpo.domain.cloudflare?.zoneId, z.id);
  assert.ok(cuerpo.domain.dnsAppliedAt);
  assert.ok(cuerpo.domain.ownershipVerifiedAt, 'escribir en una zona activa prueba la propiedad');
  const verificacion = cf.enZona(z.id).find((r) => r.name === '_mailway.aplicar.es')!;
  assert.equal(normalizarTxt(verificacion.content), cuerpo.domain.ownershipRecord.content);
  assert.equal(cf.llamadas.filter((l) => l.path.endsWith('/batch')).length, 1, 'un único lote');

  const registros = cf.enZona(z.id);
  const mxs = registros.filter((r) => r.type === 'MX');
  assert.equal(mxs.length, 1);
  assert.equal(mxs[0]!.content, 'mail.aplicar.es');
  assert.equal(mxs[0]!.priority, 10);
  assert.equal(mxs[0]!.proxied, false);
  assert.equal(mxs[0]!.comment, 'Mailway');
  const spfs = registros.filter((r) => r.type === 'TXT' && r.name === 'aplicar.es');
  assert.equal(spfs.length, 1, 'nunca dos SPF');
  assert.equal(normalizarTxt(spfs[0]!.content), 'v=spf1 include:_spf.google.com mx ~all');
  const dkim = registros.find((r) => r.name === 'mail._domainkey.aplicar.es')!;
  assert.ok(dkim.content.startsWith('"'), 'los TXT van entrecomillados');
  assert.equal(registros.find((r) => r.name === '_dmarc.aplicar.es')!.content, 'v=DMARC1; p=none');
  assert.equal(registros.find((r) => r.name === 'www.aplicar.es')!.proxied, true, 'lo ajeno no se toca');

  // Segunda vez: todo en «keep» y ninguna escritura.
  cf.llamadas = [];
  const otra = await ctx.app.inject({
    method: 'POST',
    url: `/api/domains/${domainId}/cloudflare/apply`,
    headers: { cookie: cliente.userCookie! },
    payload: {},
  });
  assert.equal(otra.statusCode, 200);
  assert.equal((otra.json() as { applied: unknown[] }).applied.length, 0);
  assert.equal(cf.llamadas.filter((l) => l.method !== 'GET').length, 0);

  const auditoria = db
    .prepare("SELECT detail FROM audit_log WHERE action = 'cloudflare.dns_applied'")
    .all() as { detail: string }[];
  assert.ok(auditoria.length >= 1);
  assert.ok(auditoria.every((a) => !a.detail.includes(TOKEN_USUARIO)));
});

test('con un MX interno del motor ni se planifica ni se aplica nada en Cloudflare', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const z = cf.zona('mx-interno-cf.es');
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });
  await conectar(cliente.userCookie!, TOKEN_USUARIO);
  const { domainId } = await createDomain(ctx, cliente.clientId, 'mx-interno-cf.es');
  const engine = getEngine();
  const original = engine.getDnsRecords.bind(engine);
  // Stalwart sin server.hostname: se presenta con el identificador del contenedor.
  engine.getDnsRecords = async (dominio: string) => [
    { type: 'MX', name: `${dominio}.`, content: '10 3f2a1b4c5d6e.' },
    { type: 'TXT', name: `${dominio}.`, content: 'v=spf1 mx ra=postmaster -all' },
  ];
  try {
    const plan = await ctx.app.inject({
      method: 'GET',
      url: `/api/domains/${domainId}/cloudflare`,
      headers: { cookie: cliente.userCookie! },
    });
    assert.equal(plan.statusCode, 409, plan.body);
    assert.equal((plan.json() as { code: string }).code, 'mx_hostname_internal');

    cf.llamadas = [];
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/domains/${domainId}/cloudflare/apply`,
      headers: { cookie: cliente.userCookie! },
      payload: { replaceConflicts: true },
    });
    assert.equal(res.statusCode, 409, res.body);
    const error = res.json() as { error: string; code: string };
    assert.equal(error.code, 'mx_hostname_internal');
    assert.match(error.error, /«3f2a1b4c5d6e»/);
    assert.equal(cf.llamadas.filter((l) => l.method !== 'GET').length, 0, 'nada se escribe en la zona');
    assert.equal(cf.enZona(z.id).length, 0);
  } finally {
    engine.getDnsRecords = original;
  }
});

test('reemplazar conflictos: borra los MX ajenos y crea el propio en el mismo lote', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const z = cf.zona('mover.es');
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });
  cf.registro(z.id, { type: 'MX', name: 'mover.es', content: 'mx1.otro.com', priority: 10 });
  cf.registro(z.id, { type: 'MX', name: 'mover.es', content: 'mx2.otro.com', priority: 20 });
  await conectar(cliente.userCookie!, TOKEN_USUARIO);
  const { domainId } = await createDomain(ctx, cliente.clientId, 'mover.es');

  const sin = await ctx.app.inject({
    method: 'POST',
    url: `/api/domains/${domainId}/cloudflare/apply`,
    headers: { cookie: cliente.userCookie! },
    payload: {},
  });
  const cuerpoSin = sin.json() as { skipped: { type: string }[] };
  assert.ok(cuerpoSin.skipped.some((s) => s.type === 'MX'));
  assert.equal(cf.enZona(z.id).filter((r) => r.type === 'MX').length, 2, 'sin confirmar, los MX ajenos siguen');

  cf.llamadas = [];
  const con = await ctx.app.inject({
    method: 'POST',
    url: `/api/domains/${domainId}/cloudflare/apply`,
    headers: { cookie: cliente.userCookie! },
    payload: { replaceConflicts: true },
  });
  assert.equal(con.statusCode, 200, con.body);
  const lote = cf.llamadas.find((l) => l.path.endsWith('/batch'))!.body as { deletes: unknown[]; posts: unknown[] };
  assert.equal(lote.deletes.length, 2);
  assert.ok(lote.posts.length >= 1);
  const mxs = cf.enZona(z.id).filter((r) => r.type === 'MX');
  assert.deepEqual(mxs.map((r) => r.content), ['mail.mover.es']);
});

test('Email Routing: el error de bloqueo se atribuye a su registro y el resto se aplica', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const z = cf.zona('routing.es');
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });
  cf.registro(z.id, { type: 'MX', name: 'routing.es', content: 'route1.mx.cloudflare.net', priority: 1, meta: { email_routing: true } });
  await conectar(cliente.userCookie!, TOKEN_USUARIO);
  const { domainId } = await createDomain(ctx, cliente.clientId, 'routing.es');

  const plan = await ctx.app.inject({ method: 'GET', url: `/api/domains/${domainId}/cloudflare`, headers: { cookie: cliente.userCookie! } });
  const mx = (plan.json() as { changes: { type: string; action: string; reason: string }[] }).changes.find((c) => c.type === 'MX')!;
  assert.equal(mx.action, 'conflict');
  assert.match(mx.reason, /Email Routing/);

  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/domains/${domainId}/cloudflare/apply`,
    headers: { cookie: cliente.userCookie! },
    payload: { replaceConflicts: true },
  });
  assert.equal(res.statusCode, 200, res.body);
  const cuerpo = res.json() as { applied: { type: string }[]; skipped: { type: string; reason: string }[] };
  assert.ok(cuerpo.applied.some((a) => a.type === 'TXT'), 'SPF, DKIM y DMARC sí se aplican');
  assert.ok(cuerpo.skipped.some((s) => s.type === 'MX' && /Email Routing/.test(s.reason)));
});

test('alta de dominio con DNS automático en Cloudflare', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const z = cf.zona('automatico.es');
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });
  await conectar(cliente.userCookie!, TOKEN_USUARIO);

  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/domains',
    headers: { cookie: cliente.userCookie! },
    payload: { domain: 'automatico.es', autoDns: true },
  });
  assert.equal(res.statusCode, 200, res.body);
  const cuerpo = res.json() as {
    domain: { id: string; cloudflare: { zoneId: string } | null };
    cloudflare: { applied: unknown[]; errors: unknown[] } | null;
  };
  assert.ok(cuerpo.cloudflare);
  assert.ok(cuerpo.cloudflare!.applied.length >= 4);
  assert.equal(cuerpo.cloudflare!.errors.length, 0);
  assert.equal(cuerpo.domain.cloudflare?.zoneId, z.id);
  assert.ok(cf.enZona(z.id).some((r) => r.type === 'MX'));

  // Sin cuenta que cubra la zona: el alta funciona y se explica por qué no se aplicó.
  const otro = await createClient(ctx, { withUser: true });
  await conectar(otro.userCookie!, TOKEN_USUARIO);
  const sin = await ctx.app.inject({
    method: 'POST',
    url: '/api/domains',
    headers: { cookie: otro.userCookie! },
    payload: { domain: 'otra-zona.es', autoDns: true },
  });
  assert.equal(sin.statusCode, 200, sin.body);
  const cuerpoSin = sin.json() as { cloudflare: unknown; cloudflareReason: string };
  assert.equal(cuerpoSin.cloudflare, null);
  assert.match(cuerpoSin.cloudflareReason, /otra-zona\.es/);

  // Sin autoDns la respuesta mantiene su forma y no se llama a Cloudflare.
  const tercero = await createClient(ctx);
  cf.llamadas = [];
  const normal = await createDomain(ctx, tercero.clientId, 'manual.es');
  assert.ok(normal.domainId);
  assert.equal(cf.llamadas.length, 0);
});

test('DNS de la plataforma: A del servidor, webmail y panel, y CNAME de autoconfiguración', async () => {
  setInstanceSettings({
    mailHostname: 'mail.plataforma.es',
    publicIp: '203.0.113.10',
    webmailUrl: 'https://webmail.plataforma.es',
    panelUrl: 'https://panel.plataforma.es',
  });
  const z = cf.zona('plataforma.es');
  const TOKEN_INSTANCIA = 'cfut_plataforma0123456789abcdefghijklm';
  cf.token(TOKEN_INSTANCIA, { zoneIds: [z.id] });
  cf.registro(z.id, { type: 'A', name: 'mail.plataforma.es', content: '203.0.113.10', proxied: true });
  const cuenta = await conectar(ctx.adminCookie, TOKEN_INSTANCIA);
  assert.equal(cuenta.statusCode, 200);

  const cliente = await createClient(ctx, { withUser: true });
  const noAdmin = await ctx.app.inject({ method: 'GET', url: '/api/cloudflare/instance-dns', headers: { cookie: cliente.userCookie! } });
  assert.equal(noAdmin.statusCode, 403);

  const plan = await ctx.app.inject({ method: 'GET', url: '/api/cloudflare/instance-dns', headers: { cookie: ctx.adminCookie } });
  assert.equal(plan.statusCode, 200, plan.body);
  const cuerpo = plan.json() as { available: boolean; changes: { type: string; name: string; action: string; content: string }[] };
  assert.equal(cuerpo.available, true);
  const por = (name: string) => cuerpo.changes.find((c) => c.name === name);
  assert.equal(por('mail.plataforma.es')?.action, 'update', 'el proxy se quita del servidor de correo');
  assert.equal(por('webmail.plataforma.es')?.action, 'create');
  assert.equal(por('panel.plataforma.es')?.action, 'create');
  assert.equal(por('autoconfig.plataforma.es')?.type, 'CNAME');
  assert.equal(por('autoconfig.plataforma.es')?.content, 'mail.plataforma.es');
  assert.equal(por('autodiscover.plataforma.es')?.type, 'CNAME');

  const res = await ctx.app.inject({ method: 'POST', url: '/api/cloudflare/instance-dns', headers: { cookie: ctx.adminCookie }, payload: {} });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as { applied: unknown[] }).applied.length, 5);
  assert.equal(cf.enZona(z.id).find((r) => r.name === 'mail.plataforma.es')!.proxied, false);

  const id = (cuenta.json() as { account: { id: string } }).account.id;
  await ctx.app.inject({ method: 'DELETE', url: `/api/cloudflare/accounts/${id}`, headers: { cookie: ctx.adminCookie } });
});

test('marca blanca: el dominio propio se apunta con un CNAME al servidor', async () => {
  setInstanceSettings({ mailHostname: 'mail.plataforma.es', publicIp: '203.0.113.10' });
  const cliente = await createClient(ctx, { withUser: true });
  const z = cf.zona('marca.es');
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });
  await conectar(cliente.userCookie!, TOKEN_USUARIO);

  // Alta directa en la tabla: las reglas de alta de marca blanca son de otro
  // módulo y aquí solo interesa la configuración del DNS.
  const id = 'wld_prueba_cf';
  db.prepare(
    `INSERT INTO client_domains (id, client_id, hostname, kind, created_at) VALUES (?, ?, ?, 'webmail', ?)`,
  ).run(id, cliente.clientId, 'webmail.marca.es', Date.now());

  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/whitelabel/domains/${id}/cloudflare`,
    headers: { cookie: cliente.userCookie! },
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body);
  const cuerpo = res.json() as { applied: unknown[]; domain: { hostname: string } };
  assert.equal(cuerpo.applied.length, 1);
  assert.equal(cuerpo.domain.hostname, 'webmail.marca.es');
  const cname = cf.enZona(z.id).find((r) => r.name === 'webmail.marca.es')!;
  assert.equal(cname.type, 'CNAME');
  assert.equal(cname.content, 'mail.plataforma.es');
  assert.equal(cname.proxied, false);

  const otro = await createClient(ctx, { withUser: true });
  const ajeno = await ctx.app.inject({
    method: 'POST',
    url: `/api/whitelabel/domains/${id}/cloudflare`,
    headers: { cookie: otro.userCookie! },
    payload: {},
  });
  assert.equal(ajeno.statusCode, 403);
});

/* -------------------- soloCliente (Skyway con token de admin) ------------- */

test('soloCliente=1: el administrador no usa las cuentas de la instancia', async () => {
  const cliente = await createClient(ctx);
  const z = cf.zona('solo-cliente.es');
  const TOKEN_INSTANCIA = 'cfut_solocliente0123456789abcdefghijklm';
  cf.token(TOKEN_INSTANCIA, { zoneIds: [z.id] });
  const cuenta = await conectar(ctx.adminCookie, TOKEN_INSTANCIA);
  assert.equal(cuenta.statusCode, 200);
  const { domainId } = await createDomain(ctx, cliente.clientId, 'solo-cliente.es');

  const limitado = await ctx.app.inject({
    method: 'GET',
    url: `/api/domains/${domainId}/cloudflare?soloCliente=1`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(limitado.statusCode, 200);
  assert.equal((limitado.json() as { available: boolean }).available, false);

  cf.llamadas = [];
  const aplicar = await ctx.app.inject({
    method: 'POST',
    url: `/api/domains/${domainId}/cloudflare/apply?soloCliente=1`,
    headers: { cookie: ctx.adminCookie },
    payload: {},
  });
  assert.equal(aplicar.statusCode, 400);
  assert.equal((aplicar.json() as { code: string }).code, 'cloudflare_unavailable');
  assert.equal(cf.llamadas.filter((l) => l.method !== 'GET').length, 0, 'nunca se escribe en la zona');

  // El alta con DNS automático respeta lo mismo.
  const otro = await createClient(ctx);
  const alta = await ctx.app.inject({
    method: 'POST',
    url: '/api/domains?soloCliente=1',
    headers: { cookie: ctx.adminCookie },
    payload: { domain: 'sub.solo-cliente.es', clientId: otro.clientId, autoDns: true },
  });
  assert.equal(alta.statusCode, 200, alta.body);
  assert.equal((alta.json() as { cloudflare: unknown }).cloudflare, null);

  // Sin el parámetro, el administrador sí puede usarla.
  const normal = await ctx.app.inject({
    method: 'GET',
    url: `/api/domains/${domainId}/cloudflare`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal((normal.json() as { available: boolean }).available, true);

  const id = (cuenta.json() as { account: { id: string } }).account.id;
  await ctx.app.inject({ method: 'DELETE', url: `/api/cloudflare/accounts/${id}`, headers: { cookie: ctx.adminCookie } });
});

test('soloCliente=1: ninguna otra ruta llega a la cuenta de la instancia', async () => {
  setInstanceSettings({ mailHostname: 'mail.plataforma.es', publicIp: '203.0.113.10' });
  const cliente = await createClient(ctx);
  const zInstancia = cf.zona('operador.es');
  const zCliente = cf.zona('del-cliente.es');
  const TOKEN_INSTANCIA = 'cfut_operador0123456789abcdefghijklmnop';
  cf.token(TOKEN_INSTANCIA, { zoneIds: [zInstancia.id] });
  cf.token(TOKEN_USUARIO, { zoneIds: [zCliente.id] });
  const instancia = await conectar(ctx.adminCookie, TOKEN_INSTANCIA);
  assert.equal(instancia.statusCode, 200, instancia.body);
  const idInstancia = (instancia.json() as { account: { id: string } }).account.id;
  const usaInstancia = () => cf.llamadas.some((l) => l.auth === `Bearer ${TOKEN_INSTANCIA}`);

  // Cuentas visibles: sin cliente indicado, ninguna; con él, solo las suyas,
  // y refrescar sus zonas no usa el token del operador.
  cf.llamadas = [];
  for (const url of [
    '/api/cloudflare/accounts?soloCliente=1&refresh=1',
    '/api/cloudflare/accounts?soloCliente=1&clientId=instancia&refresh=1',
  ]) {
    const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie: ctx.adminCookie } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.json() as { accounts: unknown[] }).accounts, [], url);
  }
  assert.equal(usaInstancia(), false);

  // Conectar en nombre del cliente: sin cliente sería una cuenta de la instancia.
  const sinCliente = await ctx.app.inject({
    method: 'POST',
    url: '/api/cloudflare/accounts?soloCliente=1',
    headers: { cookie: ctx.adminCookie },
    payload: { token: TOKEN_USUARIO },
  });
  assert.equal(sinCliente.statusCode, 403);
  assert.equal((sinCliente.json() as { code: string }).code, 'cloudflare_instance_admin_only');
  const conCliente = await ctx.app.inject({
    method: 'POST',
    url: '/api/cloudflare/accounts?soloCliente=1',
    headers: { cookie: ctx.adminCookie },
    payload: { token: TOKEN_USUARIO, clientId: cliente.clientId },
  });
  assert.equal(conCliente.statusCode, 200, conCliente.body);
  assert.equal((conCliente.json() as { account: { clientId: string } }).account.clientId, cliente.clientId);
  const suyas = await ctx.app.inject({
    method: 'GET',
    url: `/api/cloudflare/accounts?soloCliente=1&clientId=${cliente.clientId}`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.deepEqual(
    (suyas.json() as { accounts: { clientId: string }[] }).accounts.map((a) => a.clientId),
    [cliente.clientId],
  );

  // Borrar la cuenta del operador en nombre de un cliente: no existe.
  const borrar = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/cloudflare/accounts/${idInstancia}?soloCliente=1`,
    headers: { cookie: ctx.adminCookie },
  });
  assert.equal(borrar.statusCode, 404);
  assert.ok(db.prepare('SELECT 1 FROM cloudflare_accounts WHERE id = ?').get(idInstancia), 'sigue conectada');

  // DNS de la plataforma y certificado del motor: solo trabajan con la cuenta
  // de la instancia, así que en nombre de un cliente se rechazan.
  cf.llamadas = [];
  for (const [method, url, payload] of [
    ['GET', '/api/cloudflare/instance-dns?soloCliente=1', undefined],
    ['POST', '/api/cloudflare/instance-dns?soloCliente=1', {}],
    ['POST', '/api/engine/acme?soloCliente=1', { cloudflareAccountId: idInstancia, email: 'admin@operador.es' }],
  ] as const) {
    const res = await ctx.app.inject({ method, url, headers: { cookie: ctx.adminCookie }, payload });
    assert.equal(res.statusCode, 403, `${method} ${url}: ${res.body}`);
    assert.equal((res.json() as { code: string }).code, 'cloudflare_instance_admin_only');
  }
  assert.equal(usaInstancia(), false);

  // Marca blanca: el dominio propio del cliente en una zona del operador.
  const wl = 'wld_solo_cliente';
  db.prepare(
    `INSERT INTO client_domains (id, client_id, hostname, kind, created_at) VALUES (?, ?, ?, 'webmail', ?)`,
  ).run(wl, cliente.clientId, 'webmail.operador.es', Date.now());
  const marca = await ctx.app.inject({
    method: 'POST',
    url: `/api/whitelabel/domains/${wl}/cloudflare?soloCliente=1`,
    headers: { cookie: ctx.adminCookie },
    payload: { replaceConflicts: true },
  });
  assert.equal(marca.statusCode, 400);
  assert.equal((marca.json() as { code: string }).code, 'cloudflare_unavailable');
  assert.equal(cf.enZona(zInstancia.id).length, 0, 'nada escrito en la zona del operador');
  assert.equal(usaInstancia(), false);

  db.prepare('DELETE FROM client_domains WHERE id = ?').run(wl);
  for (const c of [instancia, conCliente]) {
    const id = (c.json() as { account: { id: string } }).account.id;
    await ctx.app.inject({ method: 'DELETE', url: `/api/cloudflare/accounts/${id}`, headers: { cookie: ctx.adminCookie } });
  }
});

test('un cliente no consigue escribir en la zona del operador ni con un subdominio suyo', async () => {
  // El cliente da de alta como propio un subdominio de una zona del operador
  // y pide el DNS automático: con la cuenta de la instancia conectada, no se
  // escribe nada en esa zona, ni al dar de alta ni al aplicar después.
  const cliente = await createClient(ctx, { withUser: true });
  const z = cf.zona('zona-del-operador.es');
  const TOKEN_INSTANCIA = 'cfut_zonaoperador0123456789abcdefghijk';
  cf.token(TOKEN_INSTANCIA, { zoneIds: [z.id] });
  const instancia = await conectar(ctx.adminCookie, TOKEN_INSTANCIA);
  assert.equal(instancia.statusCode, 200);

  cf.llamadas = [];
  const alta = await ctx.app.inject({
    method: 'POST',
    url: '/api/domains',
    headers: { cookie: cliente.userCookie! },
    payload: { domain: 'correo.zona-del-operador.es', autoDns: true },
  });
  assert.equal(alta.statusCode, 200, alta.body);
  const cuerpo = alta.json() as { domain: { id: string }; cloudflare: unknown; cloudflareReason: string };
  assert.equal(cuerpo.cloudflare, null);
  assert.match(cuerpo.cloudflareReason, /solo las utiliza el administrador/);

  const aplicar = await ctx.app.inject({
    method: 'POST',
    url: `/api/domains/${cuerpo.domain.id}/cloudflare/apply`,
    headers: { cookie: cliente.userCookie! },
    payload: { replaceConflicts: true },
  });
  assert.equal(aplicar.statusCode, 400);
  assert.equal(cf.enZona(z.id).length, 0);
  assert.ok(cf.llamadas.every((l) => l.auth !== `Bearer ${TOKEN_INSTANCIA}`));

  const id = (instancia.json() as { account: { id: string } }).account.id;
  await ctx.app.inject({ method: 'DELETE', url: `/api/cloudflare/accounts/${id}`, headers: { cookie: ctx.adminCookie } });
});

/* ------------------------ Propiedad y zona pendiente ---------------------- */

test('una zona pendiente de activación no prueba la propiedad del dominio', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const z = cf.zona('pendiente.es', 'acc1', 'pending');
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });
  await conectar(cliente.userCookie!, TOKEN_USUARIO);
  const { domainId } = await createDomain(ctx, cliente.clientId, 'pendiente.es', { ownershipVerified: false });

  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/domains/${domainId}/cloudflare/apply`,
    headers: { cookie: cliente.userCookie! },
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body);
  const cuerpo = res.json() as { applied: unknown[]; domain: { ownershipVerifiedAt: number | null } };
  assert.ok(cuerpo.applied.length > 0);
  assert.equal(cuerpo.domain.ownershipVerifiedAt, null, 'cualquiera puede añadir un dominio ajeno como zona pendiente');
});

/* ---------------------- Recuperación: un lote por cambio ------------------ */

test('si el lote falla, cada cambio va en su propio lote y la zona nunca se queda sin MX', async () => {
  const z = cf.zona(APEX);
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });
  cf.registro(z.id, { type: 'MX', name: APEX, content: 'smtp.google.com', priority: 1 });
  const existentes = cf.enZona(z.id).map((r) =>
    existente({ id: r.id, type: r.type, name: r.name, content: r.content, priority: r.priority }),
  );
  const cambios = planificar([mx, spf], existentes, { apex: APEX });
  assert.equal(cambios[0]!.action, 'conflict');

  // El lote completo falla por un registro; después, el alta del MX nuevo
  // también falla. Antes se borraba el MX de Google en una llamada suelta y
  // la zona se quedaba sin ninguno.
  const lotes: { deletes?: unknown[]; posts?: { type: string }[] }[] = [];
  const falso = cf.fetch;
  const rechazo = () =>
    new Response(
      JSON.stringify({
        success: false,
        errors: [{ code: 1004, message: 'DNS Validation Error', error_chain: [{ code: 9005, message: 'Bad content' }] }],
        messages: [],
        result: null,
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/batch') && init.body) {
      const cuerpo = JSON.parse(String(init.body)) as { deletes?: unknown[]; posts?: { type: string }[] };
      lotes.push(cuerpo);
      if (lotes.length === 1 || (cuerpo.posts ?? []).some((p) => p.type === 'MX')) return rechazo();
    }
    return falso(input, init);
  }) as typeof fetch;
  try {
    const r = await ejecutarPlan(new CloudflareClient(TOKEN_USUARIO), z.id, cambios, { replaceConflicts: true });
    assert.deepEqual(r.errors.map((e) => e.type), ['MX']);
    assert.deepEqual(r.applied.map((a) => a.type), ['TXT'], 'el SPF sí se aplica');
  } finally {
    globalThis.fetch = falso as typeof fetch;
  }
  const mxs = cf.enZona(z.id).filter((r) => r.type === 'MX');
  assert.deepEqual(mxs.map((r) => r.content), ['smtp.google.com'], 'el borrado del MX ajeno se deshace con su lote');
  assert.equal(lotes.length, 3, 'un lote completo y uno por cambio');
  assert.ok(lotes[1]!.deletes?.length, 'el reemplazo del MX va entero en un lote');
});

test('los borrados compartidos solo van en el primer lote que los consigue', async () => {
  const z = cf.zona(APEX);
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });
  // Un CNAME en el vértice de un subdominio impide el MX y el SPF a la vez.
  const sub = `envios.${APEX}`;
  cf.registro(z.id, { type: 'CNAME', name: sub, content: 'marketing.otro.com' });
  const existentes = cf.enZona(z.id).map((r) => existente({ id: r.id, type: r.type, name: r.name, content: r.content }));
  const cambios = planificar(
    [
      { ...mx, name: sub },
      { ...spf, name: sub },
    ],
    existentes,
    { apex: APEX },
  );
  assert.deepEqual(cambios.map((c) => c.action), ['conflict', 'conflict']);

  const falso = cf.fetch;
  let primero = true;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/batch') && primero) {
      primero = false;
      return new Response(
        JSON.stringify({ success: false, errors: [{ code: 1004, message: 'DNS Validation Error' }], messages: [], result: null }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return falso(input, init);
  }) as typeof fetch;
  try {
    const r = await ejecutarPlan(new CloudflareClient(TOKEN_USUARIO), z.id, cambios, { replaceConflicts: true });
    assert.deepEqual(r.errors, []);
    assert.equal(r.applied.length, 2);
  } finally {
    globalThis.fetch = falso as typeof fetch;
  }
  const aqui = cf.enZona(z.id).filter((r) => r.name === sub);
  assert.deepEqual(aqui.map((r) => r.type).sort(), ['MX', 'TXT']);
});

/* ------------------------ Coherencia plan / comprobación ------------------ */

test('el vértice es el de la zona: un CNAME en un dominio que es subdominio es un conflicto', async () => {
  const cliente = await createClient(ctx, { withUser: true });
  const z = cf.zona('matriz.es');
  cf.token(TOKEN_USUARIO, { zoneIds: [z.id] });
  cf.registro(z.id, { type: 'CNAME', name: 'envios.matriz.es', content: 'marketing.otro.com' });
  await conectar(cliente.userCookie!, TOKEN_USUARIO);
  const { domainId } = await createDomain(ctx, cliente.clientId, 'envios.matriz.es');

  const plan = await ctx.app.inject({ method: 'GET', url: `/api/domains/${domainId}/cloudflare`, headers: { cookie: cliente.userCookie! } });
  assert.equal(plan.statusCode, 200, plan.body);
  const cambios = (plan.json() as { changes: { type: string; name: string; action: string; reason: string }[] }).changes;
  const de = (type: string) => cambios.find((c) => c.type === type && c.name === 'envios.matriz.es');
  assert.equal(de('MX')?.action, 'conflict');
  assert.match(de('MX')!.reason, /CNAME/);
  assert.equal(de('TXT')?.action, 'conflict');
});

test('un MX de respaldo ajeno con menor preferencia se conserva, igual que en la comprobación', () => {
  const propio = existente({ type: 'MX', name: APEX, content: 'mail.servidor.es', priority: 10 });
  const respaldo = existente({ type: 'MX', name: APEX, content: 'respaldo.otro.es', priority: 50 });
  const [c] = planificar([mx], [propio, respaldo], { apex: APEX });
  assert.equal(c!.action, 'keep');
  assert.match(c!.reason, /menor preferencia/);

  const porDelante = existente({ type: 'MX', name: APEX, content: 'smtp.google.com', priority: 10 });
  const [d] = planificar([mx], [propio, porDelante], { apex: APEX });
  assert.equal(d!.action, 'conflict', 'con la misma prioridad se reparten el correo');
  assert.deepEqual(d!.reemplazo!.deletes, [porDelante.id]);
  assert.deepEqual(d!.reemplazo!.posts, [], 'el propio ya existe: no se vuelve a crear');

  const [e] = planificar([mx], [existente({ type: 'MX', name: APEX, content: 'mail.servidor.es', priority: 20 })], { apex: APEX });
  assert.equal(e!.action, 'keep');
  assert.match(e!.reason, /prioridad 20/);
});

test('el TXT de verificación se reconoce en la zona y no se vuelve a crear', () => {
  const deseado: Deseado = {
    type: 'TXT',
    name: `_mailway.${APEX}`,
    content: 'mailway-verificacion=0123456789abcdef0123456789abcdef',
    required: false,
  };
  const [igual] = planificar([deseado], [existente({ type: 'TXT', name: deseado.name, content: `"${deseado.content}"` })], { apex: APEX });
  assert.equal(igual!.action, 'keep');
  const [viejo] = planificar(
    [deseado],
    [existente({ type: 'TXT', name: deseado.name, content: '"mailway-verificacion=ffff"', comment: 'Mailway' })],
    { apex: APEX },
  );
  assert.equal(viejo!.action, 'update', 'el creado por Mailway con otro token se actualiza');
});

test('DNS de la plataforma: con un servidor de dos etiquetas se proponen autoconfig y autodiscover', () => {
  setInstanceSettings({ mailHostname: 'ejemplo.com', publicIp: '203.0.113.10', webmailUrl: '', panelUrl: '' });
  const { deseados } = deseadosDeInstancia();
  const nombres = deseados.map((d) => `${d.type} ${d.name}`);
  assert.ok(nombres.includes('CNAME autoconfig.ejemplo.com'), nombres.join(', '));
  assert.ok(nombres.includes('CNAME autodiscover.ejemplo.com'));
});

/* ------------- Herramienta de terminal: la cuenta del instalador ---------- */

interface SalidaHerramienta {
  codigo: number;
  out: string[];
  err: string[];
  leida: boolean;
}

/** Ejecuta la herramienta en este proceso (el doble de Cloudflare sustituye fetch). */
async function herramienta(argv: string[], entrada = ''): Promise<SalidaHerramienta> {
  const r: SalidaHerramienta = { codigo: -1, out: [], err: [], leida: false };
  r.codigo = await ejecutarCloudflare(argv, {
    out: (l) => r.out.push(l),
    err: (l) => r.err.push(l),
    leerEntrada: async () => {
      r.leida = true;
      return entrada;
    },
  });
  return r;
}

function cuentasDeInstanciaEnBase(): { id: string; client_id: string | null; created_by: string | null; token_enc: string }[] {
  return db.prepare('SELECT id, client_id, created_by, token_enc FROM cloudflare_accounts WHERE client_id IS NULL').all() as {
    id: string;
    client_id: string | null;
    created_by: string | null;
    token_enc: string;
  }[];
}

test('herramienta: conecta la cuenta de la instancia con el token de la entrada estándar, una sola vez', async () => {
  const z = cf.zona('instalador.es');
  const TOKEN = 'cfut_instalador0123456789abcdefghijklmnop';
  cf.token(TOKEN, { zoneIds: [z.id] });

  const r = await herramienta(['conectar', '--nombre', 'Instalador de Mailway'], `${TOKEN}\n`);
  assert.equal(r.codigo, 0, r.err.join('\n'));
  assert.equal(r.out.length, 1, 'una sola línea por la salida estándar');
  const salida = JSON.parse(r.out[0]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(salida), ['ok', 'id', 'label', 'zones', 'creada']);
  assert.equal(salida.ok, true);
  assert.equal(salida.label, 'Instalador de Mailway');
  assert.equal(salida.zones, 1);
  assert.equal(salida.creada, true);
  assert.deepEqual(r.err, []);

  const filas = cuentasDeInstanciaEnBase();
  assert.equal(filas.length, 1, 'cuenta de la instancia (sin cliente)');
  assert.equal(filas[0]!.id, salida.id);
  assert.equal(filas[0]!.created_by, null);
  assert.ok(!filas[0]!.token_enc.includes(TOKEN), 'cifrado en la base');
  const auditoria = db
    .prepare("SELECT user_id, detail FROM audit_log WHERE action = 'cloudflare.account_connected' AND detail LIKE ?")
    .all(`%${String(salida.id)}%`) as { user_id: string | null; detail: string }[];
  assert.equal(auditoria.length, 1);
  assert.equal(auditoria[0]!.user_id, null, 'como «Sistema»');
  assert.equal((JSON.parse(auditoria[0]!.detail) as { origen: string }).origen, 'terminal');
  assert.ok(!auditoria[0]!.detail.includes(TOKEN));

  // Repetirla (otra ejecución del instalador) no duplica ni falla.
  const otra = await herramienta(['conectar', '--nombre=Otro nombre'], TOKEN);
  assert.equal(otra.codigo, 0, otra.err.join('\n'));
  const repetida = JSON.parse(otra.out[0]!) as Record<string, unknown>;
  assert.equal(repetida.id, salida.id);
  assert.equal(repetida.creada, false);
  assert.equal(repetida.label, 'Instalador de Mailway', 'la existente no se cambia');
  assert.equal(cuentasDeInstanciaEnBase().length, 1);
  const anotadas = db
    .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'cloudflare.account_connected' AND detail LIKE ?")
    .get(`%${String(salida.id)}%`) as { c: number };
  assert.equal(anotadas.c, 1, 'sin una anotación nueva');

  // El token nunca sale por ningún lado.
  for (const linea of [...r.out, ...r.err, ...otra.out, ...otra.err]) assert.ok(!linea.includes(TOKEN));

  // El administrador la usa al dar de alta un dominio con DNS automático; un
  // cliente con un dominio en la misma zona, nunca.
  const delAdministrador = await createClient(ctx);
  const cliente = await createClient(ctx, { withUser: true });
  const admin = await ctx.app.inject({
    method: 'POST',
    url: '/api/domains',
    headers: { cookie: ctx.adminCookie },
    payload: { domain: 'instalador.es', clientId: delAdministrador.clientId, autoDns: true },
  });
  assert.equal(admin.statusCode, 200, admin.body);
  assert.ok((admin.json() as { cloudflare: { applied: unknown[] } | null }).cloudflare!.applied.length > 0);
  const delCliente = await ctx.app.inject({
    method: 'POST',
    url: '/api/domains',
    headers: { cookie: cliente.userCookie! },
    payload: { domain: 'sub.instalador.es', autoDns: true },
  });
  assert.equal(delCliente.statusCode, 200, delCliente.body);
  assert.equal((delCliente.json() as { cloudflare: unknown }).cloudflare, null);
  assert.ok(!cf.enZona(z.id).some((reg) => reg.name.endsWith('sub.instalador.es')));

  await ctx.app.inject({
    method: 'DELETE',
    url: `/api/cloudflare/accounts/${String(salida.id)}`,
    headers: { cookie: ctx.adminCookie },
  });
});

test('herramienta: un token en los argumentos se rechaza sin leer la entrada ni repetirlo', async () => {
  const TOKEN = 'cfut_argumento0123456789abcdefghijklmnopq';
  const ANTIGUO = 'Ab3'.repeat(14);
  const casos = [
    ['conectar', '--token', TOKEN],
    ['conectar', '--token=x'],
    ['conectar', TOKEN],
    ['conectar', '--nombre', TOKEN],
    ['conectar', `--nombre=${TOKEN}`],
    ['conectar', '--nombre', ANTIGUO],
    [TOKEN, 'conectar'],
  ];
  for (const argv of casos) {
    const r = await herramienta(argv, TOKEN);
    assert.equal(r.codigo, 1, argv.join(' '));
    assert.equal(r.leida, false, `no lee la entrada: ${argv.join(' ')}`);
    assert.deepEqual(r.out, []);
    assert.match(r.err.join('\n'), /solo se admite por la entrada estándar/);
    assert.ok(r.err.every((l) => !l.includes(TOKEN) && !l.includes(ANTIGUO)));
  }
  assert.equal(cuentasDeInstanciaEnBase().length, 0);
});

test('herramienta: los errores de uso y de Cloudflare no repiten lo recibido', async () => {
  const TOKEN = 'cfut_noconectado0123456789abcdefghijklmn';
  // Opciones y orden: antes de leer la entrada.
  for (const argv of [[], ['otra'], ['conectar', '--zona', 'x'], ['conectar', '--nombre'], ['conectar', '--nombre', 'a', '--nombre', 'b']]) {
    const r = await herramienta(argv, TOKEN);
    assert.equal(r.codigo, 1, argv.join(' '));
    assert.equal(r.leida, false, argv.join(' '));
  }
  const control = await herramienta(['conectar', '--nombre', 'a\nb'], TOKEN);
  assert.equal(control.codigo, 1);
  assert.equal(control.leida, false);

  const vacia = await herramienta(['conectar'], '  \n');
  assert.equal(vacia.codigo, 1);
  assert.match(vacia.err.join('\n'), /No ha llegado ningún token/);

  const larga = await herramienta(['conectar'], 'x'.repeat(5000));
  assert.equal(larga.codigo, 1);
  assert.match(larga.err.join('\n'), /demasiado larga/);
  assert.ok(larga.err.every((l) => !l.includes('xxxxxxxxxx')));

  const espacios = await herramienta(['conectar'], 'cfut_con espacios 0123456789abcdef');
  assert.equal(espacios.codigo, 1);
  assert.match(espacios.err.join('\n'), /espacios/);
  assert.ok(espacios.err.every((l) => !l.includes('cfut_con')));

  // Cloudflare no conoce el token: el motivo, sin el token.
  const invalido = await herramienta(['conectar'], TOKEN);
  assert.equal(invalido.codigo, 1);
  assert.deepEqual(invalido.out, []);
  assert.ok(invalido.err.length > 0);
  assert.ok(invalido.err.every((l) => !l.includes(TOKEN)));

  // Sin zonas: no se guarda.
  cf.token(TOKEN, { zoneIds: [] });
  const sinZonas = await herramienta(['conectar'], TOKEN);
  assert.equal(sinZonas.codigo, 1);
  assert.match(sinZonas.err.join('\n'), /ninguna zona/);
  assert.equal(cuentasDeInstanciaEnBase().length, 0);
});

test('herramienta: la entrada estándar no se lee desde un terminal y tiene tope', async () => {
  const terminal = Object.assign(Readable.from(['cfut_x']), { isTTY: true });
  await assert.rejects(leerEntradaEstandar(terminal), /solo se admite por la entrada estándar/);
  await assert.rejects(leerEntradaEstandar(Readable.from([Buffer.alloc(MAX_ENTRADA_CF + 1, 'a')])), /demasiado larga/);
  assert.equal(await leerEntradaEstandar(Readable.from(['cfut_', 'trozos\n'])), 'cfut_trozos\n');
  assert.equal(pareceToken('Instalador de Mailway'), false);
  assert.equal(pareceToken('cfat_abc'), true);
});

test('herramienta: como programa, rechaza el token en los argumentos y termina con código 1', () => {
  const TOKEN = 'cfut_programa0123456789abcdefghijklmnopq';
  const ejecutar = (args: string[], input: string) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/tools/cloudflare.ts', ...args], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      timeout: 60_000,
      input,
      env: process.env,
    });
  const enArgumentos = ejecutar(['conectar', '--token', TOKEN], '');
  assert.equal(enArgumentos.status, 1, enArgumentos.stderr);
  assert.equal(enArgumentos.stdout, '');
  assert.match(enArgumentos.stderr, /solo se admite por la entrada estándar/);
  assert.ok(!enArgumentos.stderr.includes(TOKEN));

  const sinEntrada = ejecutar(['conectar'], '');
  assert.equal(sinEntrada.status, 1, sinEntrada.stderr);
  assert.equal(sinEntrada.stdout, '');
  assert.match(sinEntrada.stderr, /No ha llegado ningún token/);
});
