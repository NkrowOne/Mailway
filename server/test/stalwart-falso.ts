import http from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * Stalwart mínimo para las pruebas que conectan un motor «real»: ping,
 * ajustes, recarga y un almacén de principales con la semántica de la API de
 * gestión de la v0.15.5 (comprobada en su código fuente, manage.rs y
 * settings.rs):
 * - los errores de gestión vuelven con HTTP 200 y { error, … } sin «data»:
 *   «fieldAlreadyExists» con field y value, «notFound» con item;
 * - cada principal tiene un número interno; el nombre y las direcciones son
 *   índices hacia él (renombrar conserva el número, los secretos y la
 *   pertenencia a listas, que va por número);
 * - una dirección nueva no puede ser de otro principal y su dominio tiene que
 *   existir como principal de tipo «domain»;
 * - un PATCH se valida entero antes de escribir nada;
 * - un GET omite los campos vacíos.
 * Comprueba la autenticación Basic como el motor y anota lo que recibe para
 * que las pruebas vean qué le ha llegado. También sirve la sesión JMAP con la
 * que se averigua la versión.
 *
 * `version` simula el motor que hay detrás de la URL:
 * - '0.15': API REST en /api; /jmap/session existe (la del correo) pero sin
 *   la capacidad de gestión `urn:stalwart:jmap`, como el 0.15.5 real.
 * - '0.16': gestión por JMAP; /api/principal ya no existe (404).
 * Se puede cambiar con el servidor en marcha: así se simula una migración
 * con el panel funcionando.
 */

export interface PeticionRecibida {
  method: string;
  path: string;
  /** Consulta de la URL, con el «?» (vacía si no hay). */
  query: string;
  body: string;
  authorization: string | undefined;
}

export interface PrincipalFalso {
  id: number;
  type: string;
  name: string;
  description: string;
  quota: number;
  secrets: string[];
  /** La primera es la principal. */
  emails: string[];
  roles: string[];
  /** Permisos quitados (la suspensión quita «authenticate»). */
  disabledPermissions: string[];
  /** Miembros de una lista, por número interno. */
  members: number[];
  externalMembers: string[];
}

export interface StalwartFalso {
  server: http.Server;
  received: PeticionRecibida[];
  /** Ajustes del motor por clave completa (POST /api/settings y /api/dkim). */
  settings: Map<string, string>;
  /** Principales por número interno. */
  principals: Map<number, PrincipalFalso>;
  version: '0.15' | '0.16';
  /** Errores que devolverá GET /api/reload (vacío = recarga correcta). */
  reloadErrors: Record<string, unknown>;
  /** true = un campo de lista con un solo valor se devuelve como cadena (forma que el driver también admite). */
  listasComoCadena: boolean;
  /** Crea un principal directamente en el almacén (sin validar) y devuelve su número. */
  crearPrincipal(datos: Partial<PrincipalFalso> & { type: string; name: string }): number;
  /** Principal por nombre (sin distinguir mayúsculas). */
  principal(nombre: string): PrincipalFalso | undefined;
  /** Arranca en un puerto libre de 127.0.0.1 y devuelve su URL. */
  listen(): Promise<string>;
  close(): void;
}

interface Cambio {
  action: 'set' | 'addItem' | 'removeItem';
  field: string;
  value: unknown;
}

class ErrorDeGestion extends Error {
  constructor(readonly cuerpo: Record<string, unknown>) {
    super(String(cuerpo.error));
  }
}

const yaExiste = (field: string, value: string) => new ErrorDeGestion({ error: 'fieldAlreadyExists', field, value });
const noExiste = (item: string) => new ErrorDeGestion({ error: 'notFound', item });

function comoLista(valor: unknown): string[] {
  if (Array.isArray(valor)) return valor.map(String);
  return typeof valor === 'string' && valor ? [valor] : [];
}

export function fakeStalwart(password: string, user = 'admin'): StalwartFalso {
  const expectedAuth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const received: PeticionRecibida[] = [];
  const settings = new Map<string, string>();
  const principals = new Map<number, PrincipalFalso>();
  let siguienteId = 1;

  const porNombre = (nombre: string) => [...principals.values()].find((p) => p.name === nombre.toLowerCase());
  const duenoDe = (direccion: string) => [...principals.values()].find((p) => p.emails.includes(direccion));

  /** validate_email de manage.rs: libre y con su dominio dado de alta. */
  function validarDireccion(direccion: string, propio: PrincipalFalso | null): void {
    const dueno = duenoDe(direccion);
    if (dueno && dueno !== propio) throw yaExiste('emails', direccion);
    const dominio = direccion.slice(direccion.lastIndexOf('@') + 1);
    if (porNombre(dominio)?.type !== 'domain') throw noExiste(dominio);
  }

  function idsDeMiembros(nombres: string[]): number[] {
    return nombres.map((n) => {
      const p = porNombre(n);
      if (!p) throw noExiste(n);
      return p.id;
    });
  }

  function crearPrincipal(datos: Partial<PrincipalFalso> & { type: string; name: string }): number {
    const p: PrincipalFalso = {
      description: '',
      quota: 0,
      secrets: [],
      emails: [],
      roles: [],
      disabledPermissions: [],
      members: [],
      externalMembers: [],
      ...datos,
      id: siguienteId++,
      name: datos.name.toLowerCase(),
    };
    principals.set(p.id, p);
    return p.id;
  }

  const fake: StalwartFalso = {
    server: undefined as unknown as http.Server,
    received,
    settings,
    principals,
    reloadErrors: {},
    listasComoCadena: false,
    version: '0.15',
    crearPrincipal,
    principal: porNombre,
    async listen() {
      await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    },
    close() {
      fake.server.closeAllConnections();
      fake.server.close();
    },
  };

  /** GET de un principal como Stalwart: sin campos vacíos y los miembros por nombre. */
  function vista(p: PrincipalFalso): Record<string, unknown> {
    const lista = (valores: string[]) => (fake.listasComoCadena && valores.length === 1 ? valores[0] : valores);
    const out: Record<string, unknown> = { id: p.id, type: p.type, name: p.name };
    if (p.description) out.description = p.description;
    if (p.quota) out.quota = p.quota;
    const miembros = p.members.map((id) => principals.get(id)?.name).filter((n): n is string => !!n);
    for (const [campo, valores] of [
      ['secrets', p.secrets],
      ['emails', p.emails],
      ['roles', p.roles],
      ['disabledPermissions', p.disabledPermissions],
      ['members', miembros],
      ['externalMembers', p.externalMembers],
    ] as const) {
      if (valores.length > 0) out[campo] = lista([...valores]);
    }
    return out;
  }

  function crear(cuerpo: Record<string, unknown>): number {
    const nombre = String(cuerpo.name ?? '').toLowerCase();
    if (porNombre(nombre)) throw yaExiste('name', nombre);
    const members = idsDeMiembros(comoLista(cuerpo.members));
    const emails = comoLista(cuerpo.emails).map((e) => e.toLowerCase());
    for (const e of emails) validarDireccion(e, null);
    return crearPrincipal({
      type: String(cuerpo.type),
      name: nombre,
      description: typeof cuerpo.description === 'string' ? cuerpo.description : '',
      quota: typeof cuerpo.quota === 'number' ? cuerpo.quota : 0,
      secrets: comoLista(cuerpo.secrets),
      emails,
      roles: comoLista(cuerpo.roles),
      disabledPermissions: comoLista(cuerpo.disabledPermissions),
      members,
      externalMembers: comoLista(cuerpo.externalMembers),
    });
  }

  /** Aplica los cambios sobre una copia y solo la guarda si todos son válidos (PATCH atómico). */
  function modificar(actual: PrincipalFalso, cambios: Cambio[]): void {
    const p: PrincipalFalso = structuredClone(actual);
    for (const c of cambios) {
      const clave = `${c.action} ${c.field}`;
      if (clave === 'set name') {
        const nuevo = String(c.value).toLowerCase();
        if (nuevo !== p.name && porNombre(nuevo)) throw yaExiste('name', nuevo);
        p.name = nuevo;
      } else if (clave === 'set emails') {
        const emails = comoLista(c.value).map((e) => e.toLowerCase());
        for (const e of emails) if (!p.emails.includes(e)) validarDireccion(e, actual);
        p.emails = emails;
      } else if (clave === 'addItem emails') {
        const e = String(c.value).toLowerCase();
        if (!p.emails.includes(e)) {
          validarDireccion(e, actual);
          p.emails.push(e);
        }
      } else if (clave === 'removeItem emails') {
        p.emails = p.emails.filter((e) => e !== String(c.value).toLowerCase());
      } else if (clave === 'set members') {
        p.members = idsDeMiembros(comoLista(c.value));
      } else if (clave === 'set externalMembers') {
        p.externalMembers = comoLista(c.value);
      } else if (clave === 'set secrets') {
        p.secrets = comoLista(c.value);
      } else if (clave === 'addItem secrets') {
        const s = String(c.value);
        // Un secreto que no es $app$ sustituye a la contraseña principal.
        if (!p.secrets.includes(s)) {
          p.secrets = s.startsWith('$app$') ? [...p.secrets, s] : [...p.secrets.filter((x) => x.startsWith('$app$')), s];
        }
      } else if (clave === 'removeItem secrets') {
        const s = String(c.value);
        p.secrets = p.secrets.filter((x) => x !== s && !(s.startsWith('$app$') && x.startsWith(s)));
      } else if (clave === 'set roles') {
        // Como 0.15.5: roles, listas y grupos son la misma relación y «set
        // roles» la reescribe entera, así que saca al principal de sus listas.
        p.roles = comoLista(c.value);
        for (const otro of principals.values()) {
          if (otro.id !== p.id) otro.members = otro.members.filter((m) => m !== p.id);
        }
      } else if (clave === 'addItem roles') {
        const rol = String(c.value);
        if (!p.roles.includes(rol)) p.roles = [...p.roles, rol];
      } else if (clave === 'removeItem roles') {
        p.roles = p.roles.filter((r) => r !== String(c.value));
      } else if (clave === 'set disabledPermissions') {
        p.disabledPermissions = comoLista(c.value);
      } else if (clave === 'set description') {
        p.description = String(c.value ?? '');
      } else if (clave === 'set quota') {
        p.quota = Number(c.value) || 0;
      } else {
        throw new ErrorDeGestion({ error: 'other', details: `Cambio no admitido por el doble: ${clave}` });
      }
    }
    principals.set(p.id, p);
  }

  function borrar(p: PrincipalFalso): void {
    principals.delete(p.id);
    for (const otro of principals.values()) otro.members = otro.members.filter((m) => m !== p.id);
  }

  /** POST /api/dkim: las mismas claves que crea dkim.rs (sin generar una clave de verdad). */
  function crearDkim(cuerpo: { id?: string | null; algorithm: string; domain: string; selector?: string | null }): void {
    const algoritmo = cuerpo.algorithm === 'Rsa' ? 'rsa' : 'ed25519';
    const id = cuerpo.id || `${algoritmo}-${cuerpo.domain}`;
    if (settings.has(`signature.${id}.private-key`)) throw yaExiste(`signature.${id}.private-key`, 'clave');
    const valores: Record<string, string> = {
      'private-key': `-----BEGIN PRIVATE KEY-----\nfalsa-${id}\n-----END PRIVATE KEY-----\n`,
      domain: cuerpo.domain,
      selector: cuerpo.selector || `202610${algoritmo === 'rsa' ? 'r' : 'e'}`,
      algorithm: `${algoritmo}-sha256`,
      canonicalization: 'relaxed/relaxed',
      'headers.0': 'From',
      'headers.1': 'To',
      report: 'false',
    };
    for (const [k, v] of Object.entries(valores)) settings.set(`signature.${id}.${k}`, v);
  }

  function atender(method: string, url: URL, raw: string): unknown {
    const cuerpo = raw ? (JSON.parse(raw) as unknown) : undefined;
    if (url.pathname === '/api/principal' && method === 'GET') {
      const tipos = (url.searchParams.get('types') || '').split(',').filter(Boolean);
      const items = [...principals.values()].filter((p) => tipos.length === 0 || tipos.includes(p.type)).map(vista);
      return { data: { items, total: items.length } };
    }
    if (url.pathname === '/api/principal' && method === 'POST') {
      return { data: crear(cuerpo as Record<string, unknown>) };
    }
    if (url.pathname.startsWith('/api/principal/')) {
      const nombre = decodeURIComponent(url.pathname.slice('/api/principal/'.length));
      const p = porNombre(nombre);
      if (!p) throw noExiste(nombre);
      if (method === 'GET') return { data: vista(p) };
      if (method === 'DELETE') {
        borrar(p);
        return { data: null };
      }
      if (method === 'PATCH') {
        modificar(p, cuerpo as Cambio[]);
        return { data: null };
      }
    }
    if (url.pathname === '/api/dkim' && method === 'POST') {
      crearDkim(cuerpo as { algorithm: string; domain: string });
      return { data: null };
    }
    if (url.pathname === '/api/settings/keys' && method === 'GET') {
      // Como settings.rs: «keys» exactas y todo lo que cuelga de cada «prefixes» (con la clave completa).
      const out: Record<string, string> = {};
      for (const k of (url.searchParams.get('keys') || '').split(',').filter(Boolean)) {
        if (settings.has(k)) out[k] = settings.get(k)!;
      }
      for (const prefijo of (url.searchParams.get('prefixes') || '').split(',').filter(Boolean)) {
        const p = prefijo.endsWith('.') ? prefijo : `${prefijo}.`;
        for (const [k, v] of settings) if (k.startsWith(p)) out[k] = v;
      }
      return { data: out };
    }
    if (url.pathname === '/api/settings' && method === 'POST') {
      const ops = cuerpo as { type: string; prefix?: string | null; values?: [string, string][]; keys?: string[] }[];
      for (const op of ops) {
        if (op.type === 'delete') for (const k of op.keys ?? []) settings.delete(k);
        if (op.type === 'clear') for (const k of [...settings.keys()]) if (k.startsWith(op.prefix ?? '')) settings.delete(k);
        if (op.type === 'insert') {
          for (const [key, value] of op.values ?? []) settings.set(op.prefix ? `${op.prefix}.${key}` : key, value);
        }
      }
      return { data: null };
    }
    if (url.pathname === '/api/reload' && method === 'GET') {
      return { data: { errors: fake.reloadErrors, warnings: {} } };
    }
    return undefined;
  }

  fake.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://motor');
      const method = req.method || '';
      received.push({ method, path: url.pathname, query: url.search, body: raw, authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401);
        res.end(JSON.stringify({ status: 401, title: 'Unauthorized', detail: 'You have to authenticate first.' }));
        return;
      }
      if (url.pathname === '/jmap/session' && method === 'GET') {
        // Forma real (comprobada en 0.15.5 y 0.16.25): la capacidad de gestión
        // de 0.16 NO va en las del servidor, sino en primaryAccounts y en las
        // accountCapabilities de la cuenta del administrador.
        const capabilities = { 'urn:ietf:params:jmap:core': { maxSizeUpload: 50000000 }, 'urn:ietf:params:jmap:mail': {} };
        const deCuenta: Record<string, unknown> = { 'urn:ietf:params:jmap:mail': {} };
        const primaryAccounts: Record<string, string> = { 'urn:ietf:params:jmap:mail': 'a' };
        if (fake.version === '0.16') {
          deCuenta['urn:stalwart:jmap'] = {};
          primaryAccounts['urn:stalwart:jmap'] = 'a';
        }
        res.end(
          JSON.stringify({
            capabilities,
            accounts: { a: { name: user, isPersonal: true, isReadOnly: false, accountCapabilities: deCuenta } },
            primaryAccounts,
            username: user,
            apiUrl: '/jmap/',
            state: '0',
          }),
        );
        return;
      }
      let respuesta: unknown;
      try {
        // Un motor 0.16 ya no tiene la API REST de gestión de 0.15.
        respuesta = fake.version === '0.16' ? undefined : atender(method, url, raw);
      } catch (err) {
        // Errores de gestión: HTTP 200 con { error } (así responde Stalwart 0.15).
        if (!(err instanceof ErrorDeGestion)) throw err;
        respuesta = err.cuerpo;
      }
      if (respuesta === undefined) {
        res.writeHead(404);
        res.end(JSON.stringify({ status: 404, title: 'Not Found' }));
        return;
      }
      res.end(JSON.stringify(respuesta));
    });
  });
  return fake;
}
