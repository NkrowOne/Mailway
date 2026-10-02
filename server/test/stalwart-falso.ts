import http from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * Stalwart mínimo para las pruebas que conectan un motor «real»: lo que usan
 * ping, ajustes y recarga. Comprueba la autenticación Basic como el motor y
 * anota lo que recibe para que las pruebas vean qué le ha llegado.
 */

export interface PeticionRecibida {
  method: string;
  path: string;
  body: string;
  authorization: string | undefined;
}

export interface StalwartFalso {
  server: http.Server;
  received: PeticionRecibida[];
  /** Ajustes insertados con POST /api/settings, por clave completa. */
  settings: Map<string, string>;
  /** Arranca en un puerto libre de 127.0.0.1 y devuelve su URL. */
  listen(): Promise<string>;
  close(): void;
}

export function fakeStalwart(password: string, user = 'admin'): StalwartFalso {
  const received: PeticionRecibida[] = [];
  const settings = new Map<string, string>();
  const expectedAuth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://motor');
      received.push({ method: req.method || '', path: url.pathname, body: raw, authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401);
        res.end(JSON.stringify({ status: 401, title: 'Unauthorized', detail: 'You have to authenticate first.' }));
        return;
      }
      if (url.pathname === '/api/principal') {
        res.end(JSON.stringify({ data: { items: [], total: 0 } }));
      } else if (url.pathname === '/api/settings' && req.method === 'POST') {
        for (const op of JSON.parse(raw) as { type: string; prefix: string | null; values: [string, string][] }[]) {
          if (op.type !== 'insert') continue;
          for (const [key, value] of op.values) settings.set(op.prefix ? `${op.prefix}.${key}` : key, value);
        }
        res.end(JSON.stringify({ data: null }));
      } else if (url.pathname === '/api/reload') {
        res.end(JSON.stringify({ data: { errors: {}, warnings: {} } }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ status: 404, title: 'Not Found' }));
      }
    });
  });
  return {
    server,
    received,
    settings,
    async listen() {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
