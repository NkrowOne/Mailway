import http from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * Stalwart mínimo para las pruebas que conectan un motor «real» por HTTP:
 * ping, ajustes, recarga, principales (buzones y listas) y la sesión JMAP con
 * la que se averigua la versión. Comprueba la autenticación Basic como el
 * motor y anota lo que recibe para que las pruebas vean qué le ha llegado.
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
  body: string;
  authorization: string | undefined;
}

export interface PrincipalFalso {
  type: 'individual' | 'list' | 'domain';
  secrets?: string[];
  roles?: string[];
  members?: string[];
}

export interface StalwartFalso {
  server: http.Server;
  received: PeticionRecibida[];
  /** Ajustes insertados con POST /api/settings, por clave completa. */
  settings: Map<string, string>;
  /** Principales de la API REST (0.15), por nombre. */
  principals: Map<string, PrincipalFalso>;
  version: '0.15' | '0.16';
  /** Arranca en un puerto libre de 127.0.0.1 y devuelve su URL. */
  listen(): Promise<string>;
  close(): void;
}

/** Igual que Stalwart: un GET omite los campos vacíos (un buzón suspendido llega sin «roles»). */
function sinVacios(p: PrincipalFalso): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(p).filter(([, v]) => !(Array.isArray(v) && v.length === 0) && v !== undefined),
  );
}

export function fakeStalwart(password: string, user = 'admin'): StalwartFalso {
  const received: PeticionRecibida[] = [];
  const settings = new Map<string, string>();
  const principals = new Map<string, PrincipalFalso>();
  const expectedAuth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const falso: StalwartFalso = {
    server: undefined as unknown as http.Server,
    received,
    settings,
    principals,
    version: '0.15',
    async listen() {
      await new Promise<void>((resolve) => falso.server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(falso.server.address() as AddressInfo).port}`;
    },
    close() {
      falso.server.closeAllConnections();
      falso.server.close();
    },
  };

  const responder = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status);
    res.end(JSON.stringify(body));
  };

  falso.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://motor');
      received.push({ method: req.method || '', path: url.pathname, body: raw, authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== expectedAuth) {
        responder(res, 401, { status: 401, title: 'Unauthorized', detail: 'You have to authenticate first.' });
        return;
      }
      if (url.pathname === '/jmap/session' && req.method === 'GET') {
        // Forma real (comprobada en 0.15.5 y 0.16.25): la capacidad de gestión
        // de 0.16 NO va en las del servidor, sino en primaryAccounts y en las
        // accountCapabilities de la cuenta del administrador.
        const capabilities = { 'urn:ietf:params:jmap:core': { maxSizeUpload: 50000000 }, 'urn:ietf:params:jmap:mail': {} };
        const deCuenta: Record<string, unknown> = { 'urn:ietf:params:jmap:mail': {} };
        const primaryAccounts: Record<string, string> = { 'urn:ietf:params:jmap:mail': 'a' };
        if (falso.version === '0.16') {
          deCuenta['urn:stalwart:jmap'] = {};
          primaryAccounts['urn:stalwart:jmap'] = 'a';
        }
        responder(res, 200, {
          capabilities,
          accounts: { a: { name: user, isPersonal: true, isReadOnly: false, accountCapabilities: deCuenta } },
          primaryAccounts,
          username: user,
          apiUrl: '/jmap/',
          state: '0',
        });
        return;
      }
      if (falso.version === '0.16' || !url.pathname.startsWith('/api/')) {
        responder(res, 404, { status: 404, title: 'Not Found' });
        return;
      }
      if (url.pathname === '/api/principal' && req.method === 'GET') {
        const tipos = (url.searchParams.get('types') ?? '').split(',');
        const items = [...principals.entries()]
          .filter(([, p]) => tipos.includes(p.type))
          .map(([name]) => ({ name }));
        responder(res, 200, { data: { items, total: items.length } });
        return;
      }
      if (url.pathname.startsWith('/api/principal/')) {
        const name = decodeURIComponent(url.pathname.slice('/api/principal/'.length));
        const principal = principals.get(name);
        if (!principal) {
          responder(res, 200, { error: 'notFound', item: name });
          return;
        }
        if (req.method === 'GET') {
          responder(res, 200, { data: { name, ...sinVacios(principal) } });
          return;
        }
        if (req.method === 'PATCH') {
          for (const c of JSON.parse(raw) as { action: string; field: keyof PrincipalFalso; value: unknown }[]) {
            if (c.action === 'set') (principal as unknown as Record<string, unknown>)[c.field] = c.value;
          }
          responder(res, 200, { data: null });
          return;
        }
      }
      if (url.pathname === '/api/settings' && req.method === 'POST') {
        for (const op of JSON.parse(raw) as { type: string; prefix: string | null; values: [string, string][] }[]) {
          if (op.type !== 'insert') continue;
          for (const [key, value] of op.values) settings.set(op.prefix ? `${op.prefix}.${key}` : key, value);
        }
        responder(res, 200, { data: null });
        return;
      }
      if (url.pathname === '/api/reload') {
        responder(res, 200, { data: { errors: {}, warnings: {} } });
        return;
      }
      responder(res, 404, { status: 404, title: 'Not Found' });
    });
  });
  return falso;
}
