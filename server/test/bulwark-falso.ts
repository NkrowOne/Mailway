import { after } from 'node:test';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * API de administración de Bulwark falsa, para probar el cliente del panel
 * (bulwark.test.ts) y la sincronización (correoweb.test.ts) sin contenedores.
 *
 * Copia independiente de lo que hace Bulwark 1.13.0 (no de nuestro módulo):
 * - lib/admin/domain-branding.ts: parseDomainBranding (nombre, comodín,
 *   repetidos, campos conocidos y no vacíos);
 * - app/api/admin/config: PATCH sustituye la clave y responde 400 si el
 *   análisis descarta alguna entrada;
 * - lib/security/same-origin.ts: rechaza escrituras con Sec-Fetch-Site
 *   distinto de same-origin u Origin de otro host;
 * - lib/admin/rate-limit.ts: cada intento de inicio de sesión cuenta, también
 *   los correctos;
 * - app/api/admin/policy: la lectura sin sesión es la parte pública;
 * - app/api/admin/branding: la subida (multipart con file, slot y host)
 *   guarda domain__<host>__<slot><ext> según el tipo declarado, borra las
 *   demás versiones de ese host y hueco y añade {host, slot: url} a
 *   domainBranding; la lectura de /api/admin/branding/<fichero> no pide
 *   sesión; la retirada {slot, host} borra el fichero y quita el hueco.
 */

export const CONTRASENA = 'clave-de-administracion-de-prueba-0123456789';

const CLAVES_MARCA = [
  'appName', 'appShortName', 'appDescription', 'faviconUrl', 'pwaIconUrl', 'pwaScreenshotMobileUrl',
  'pwaScreenshotDesktopUrl', 'pwaThemeColor', 'pwaBackgroundColor', 'appLogoLightUrl', 'appLogoDarkUrl',
  'loginLogoLightUrl', 'loginLogoDarkUrl', 'loginCompanyName', 'loginImprintUrl', 'loginPrivacyPolicyUrl',
  'loginWebsiteUrl',
];
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
/** El de la subida: sin comodín. */
const HOST_SUBIDA_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const HUECOS_SUBIDA = new Set([
  'faviconUrl', 'pwaIconUrl', 'appLogoLightUrl', 'appLogoDarkUrl', 'loginLogoLightUrl', 'loginLogoDarkUrl',
  'pwaScreenshotMobileUrl', 'pwaScreenshotDesktopUrl',
]);
const EXTENSIONES: Record<string, string> = {
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/x-icon': '.ico',
};

export function analizarComoBulwark(raw: unknown): Record<string, string>[] {
  if (!Array.isArray(raw)) return [];
  const vistos = new Set<string>();
  const salida: Record<string, string>[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const host = (typeof rec.host === 'string' ? rec.host : '').trim().toLowerCase().replace(/\.+$/, '');
    if (!host || !HOST_RE.test(host) || vistos.has(host)) continue;
    vistos.add(host);
    const entrada: Record<string, string> = { host };
    for (const clave of CLAVES_MARCA) {
      const v = rec[clave];
      if (typeof v === 'string' && v.length > 0) entrada[clave] = v;
    }
    salida.push(entrada);
  }
  return salida;
}

export interface Llamada {
  metodo: string;
  ruta: string;
  cookie: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  cuerpo: string;
}

export interface BulwarkFalso {
  url: string;
  llamadas: Llamada[];
  inicios: number;
  marca: unknown;
  politica: Record<string, unknown>;
  /** Claves con source «admin» además de domainBranding. */
  fijadas: Record<string, unknown>;
  /** Ficheros subidos: nombre → bytes y tipo. */
  ficheros: Map<string, { datos: Buffer; tipo: string }>;
  /** Inicios de sesión admitidos antes de responder 429. */
  limite: number;
  adminDesactivado: boolean;
  retrasoMs: number;
  /** Simula un proxy que añade Origin de otro sitio. */
  exigirOrigen: boolean;
  /** Responde 503 a /api/health. */
  enfermo: boolean;
  /** Escrituras (PATCH, PUT, POST y DELETE de administración salvo el inicio de sesión). */
  escrituras(): Llamada[];
  caducarSesiones(): void;
  close(): void;
}

const falsos: BulwarkFalso[] = [];
after(() => {
  for (const f of falsos) f.close();
});

export async function bulwarkFalso(): Promise<BulwarkFalso> {
  const sesiones = new Set<string>();
  const falso: BulwarkFalso = {
    url: '',
    llamadas: [],
    inicios: 0,
    marca: [],
    politica: {
      restrictions: {},
      features: { pluginsEnabled: false, filesEnabled: true, calendarEnabled: true, nuevaFuncion2027: true },
      defaults: {},
      themePolicy: { disabledBuiltinThemes: [], disabledThemes: [], defaultThemeId: null },
      forceEnabledPlugins: [],
      approvedPlugins: [],
      forceEnabledThemes: [],
      pushRelays: [],
      pushRelayUrl: '',
      pushRelayUrlLocked: false,
      defaultSidebarApps: [],
    },
    fijadas: {},
    ficheros: new Map(),
    limite: 5,
    adminDesactivado: false,
    retrasoMs: 0,
    exigirOrigen: false,
    enfermo: false,
    escrituras: () =>
      falso.llamadas.filter(
        (l) => l.metodo !== 'GET' && l.ruta.startsWith('/api/admin/') && l.ruta !== '/api/admin/auth',
      ),
    caducarSesiones: () => sesiones.clear(),
    close: () => {
      servidor.closeAllConnections();
      servidor.close();
    },
  };

  const mismoOrigen = (req: http.IncomingMessage): boolean => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '')) return true;
    const sitio = req.headers['sec-fetch-site'];
    if (sitio !== undefined) return sitio === 'same-origin';
    const origen = req.headers.origin;
    if (falso.exigirOrigen) return false;
    if (!origen) return true;
    return new URL(origen).host === (req.headers['x-forwarded-host'] ?? req.headers.host);
  };
  const sesionValida = (req: http.IncomingMessage): boolean => {
    const m = /(?:^|;\s*)admin_session=([^;]+)/.exec(req.headers.cookie ?? '');
    return Boolean(m && sesiones.has(m[1]!));
  };
  /** Añade (o sustituye) el hueco de un host en domainBranding, como hace la subida. */
  const marcarHueco = (host: string, hueco: string, url: string | null) => {
    const lista = analizarComoBulwark(falso.marca);
    const i = lista.findIndex((e) => e.host === host);
    if (url === null) {
      if (i < 0) return;
      const entrada = { ...lista[i]! };
      delete entrada[hueco];
      if (Object.keys(entrada).filter((k) => k !== 'host').length === 0) lista.splice(i, 1);
      else lista[i] = entrada;
    } else if (i < 0) {
      lista.push({ host, [hueco]: url });
    } else {
      lista[i] = { ...lista[i]!, [hueco]: url };
    }
    falso.marca = lista;
  };

  const servidor = http.createServer((req, res) => {
    const trozos: Buffer[] = [];
    req.on('data', (c: Buffer) => trozos.push(c));
    req.on('end', () => {
      const bruto = Buffer.concat(trozos);
      const cuerpo = bruto.toString('utf8');
      const ruta = new URL(req.url ?? '/', 'http://bulwark').pathname;
      falso.llamadas.push({
        metodo: req.method ?? '',
        ruta,
        cookie: req.headers.cookie,
        origin: req.headers.origin,
        secFetchSite: req.headers['sec-fetch-site'] as string | undefined,
        cuerpo: req.headers['content-type']?.startsWith('multipart/') ? '(multipart)' : cuerpo,
      });
      const json = (status: number, datos: unknown, cabeceras: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...cabeceras });
        res.end(JSON.stringify(datos));
      };
      const responder = async () => {
        if (ruta === '/api/health') {
          if (falso.enfermo) return json(503, { status: 'unhealthy', reason: 'prueba' });
          return json(200, { status: 'healthy' });
        }
        if (ruta === '/api/admin/auth' && req.method === 'POST') {
          if (!mismoOrigen(req)) return json(403, { error: 'Cross-origin request rejected' });
          if (falso.adminDesactivado) return json(404, { error: 'Admin dashboard is not configured' });
          falso.inicios++;
          if (falso.inicios > falso.limite) {
            return json(429, { error: 'Too many login attempts. Try again later.' }, { 'retry-after': '612' });
          }
          let password: unknown;
          try {
            password = (JSON.parse(cuerpo) as { password?: unknown }).password;
          } catch {
            return json(400, { error: 'Password is required' });
          }
          if (password !== CONTRASENA) return json(401, { error: 'Invalid password' });
          const token = crypto.randomBytes(24).toString('base64');
          sesiones.add(encodeURIComponent(token));
          return json(200, { ok: true }, {
            'set-cookie': `admin_session=${encodeURIComponent(token)}; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=lax`,
          });
        }
        if (ruta === '/api/admin/policy' && req.method === 'GET') {
          if (sesionValida(req)) return json(200, falso.politica);
          return json(200, { ...falso.politica, defaultSidebarApps: [] }, { 'x-bulwark-policy-scope': 'public' });
        }
        // Lectura pública de las imágenes subidas.
        const lectura = /^\/api\/admin\/branding\/([^/]+)$/.exec(ruta);
        if (lectura && req.method === 'GET') {
          const fichero = falso.ficheros.get(decodeURIComponent(lectura[1]!));
          if (!fichero) return json(404, { error: 'Not found' });
          res.writeHead(200, {
            'content-type': fichero.tipo,
            'cache-control': 'public, max-age=3600, must-revalidate',
            'x-content-type-options': 'nosniff',
          });
          res.end(fichero.datos);
          return;
        }
        if (ruta.startsWith('/api/admin/')) {
          if (!mismoOrigen(req)) return json(403, { error: 'Cross-origin request rejected' });
          if (!req.headers.cookie) return json(401, { error: 'Not authenticated' });
          if (!sesionValida(req)) return json(401, { error: 'Session expired' });
        }
        if (ruta === '/api/admin/config' && req.method === 'GET') {
          const config: Record<string, unknown> = {
            appName: { value: 'Correo Mailway', source: 'env' },
            sessionSecret: { source: 'env', hasValue: true },
            domainBranding: { value: falso.marca, source: Array.isArray(falso.marca) && falso.marca.length ? 'admin' : 'default' },
          };
          for (const [clave, valor] of Object.entries(falso.fijadas)) config[clave] = { value: valor, source: 'admin' };
          return json(200, config);
        }
        if (ruta === '/api/admin/config' && req.method === 'PATCH') {
          const cambios = JSON.parse(cuerpo) as Record<string, unknown>;
          const desconocidas = Object.keys(cambios).filter((k) => !['domainBranding', 'appName'].includes(k));
          if (desconocidas.length) return json(400, { error: `Unknown config keys: ${desconocidas.join(', ')}` });
          if ('domainBranding' in cambios) {
            const entrada = cambios.domainBranding;
            if (entrada != null && !Array.isArray(entrada)) return json(400, { error: 'domainBranding must be an array' });
            const analizada = analizarComoBulwark(entrada);
            if (analizada.length !== (Array.isArray(entrada) ? entrada.length : 0)) {
              return json(400, { error: 'One or more domainBranding entries are invalid (each needs a unique, valid host).' });
            }
            falso.marca = analizada;
          }
          return json(200, { ok: true });
        }
        if (ruta === '/api/admin/policy' && req.method === 'PUT') {
          const nueva = JSON.parse(cuerpo) as Record<string, unknown>;
          falso.politica = {
            ...falso.politica,
            ...nueva,
            features: {
              ...(falso.politica.features as Record<string, unknown>),
              ...((nueva.features as Record<string, unknown>) ?? {}),
            },
          };
          return json(200, { ok: true });
        }
        if (ruta === '/api/admin/branding' && req.method === 'POST') {
          // El multipart lo lee el mismo analizador de formularios que usa Next.js (undici).
          const formulario = await new Request('http://bulwark/subida', {
            method: 'POST',
            headers: { 'content-type': String(req.headers['content-type'] ?? '') },
            body: bruto,
          }).formData();
          const fichero = formulario.get('file');
          const hueco = formulario.get('slot');
          const host = String(formulario.get('host') ?? '').trim().toLowerCase().replace(/\.+$/, '');
          if (!fichero || typeof fichero === 'string' || typeof hueco !== 'string') {
            return json(400, { error: 'Missing file or slot' });
          }
          if (!HUECOS_SUBIDA.has(hueco)) return json(400, { error: `Invalid slot: ${hueco}` });
          if (host && !HOST_SUBIDA_RE.test(host)) return json(400, { error: `Invalid host: ${host}` });
          if (fichero.size > 2_097_152) return json(400, { error: 'File too large (max 2 MB)' });
          const extension = EXTENSIONES[fichero.type];
          if (!extension) return json(400, { error: `Unsupported file type: ${fichero.type}` });
          const nombre = host ? `domain__${host}__${hueco}${extension}` : `${hueco}${extension}`;
          for (const otro of [...falso.ficheros.keys()]) {
            if (otro !== nombre && host && otro.startsWith(`domain__${host}__${hueco}.`)) falso.ficheros.delete(otro);
          }
          falso.ficheros.set(nombre, { datos: Buffer.from(await fichero.arrayBuffer()), tipo: fichero.type });
          const url = `/api/admin/branding/${nombre}`;
          if (host) marcarHueco(host, hueco, url);
          return json(200, { url, filename: nombre });
        }
        if (ruta === '/api/admin/branding' && req.method === 'DELETE') {
          const { slot, host } = JSON.parse(cuerpo || '{}') as { slot?: string; host?: string };
          if (!slot || !HUECOS_SUBIDA.has(slot)) return json(400, { error: 'Invalid or missing slot' });
          if (!host) return json(400, { error: 'El falso no admite retirar la marca de la instancia' });
          for (const otro of [...falso.ficheros.keys()]) {
            if (otro.startsWith(`domain__${host}__${slot}.`)) falso.ficheros.delete(otro);
          }
          marcarHueco(host, slot, null);
          return json(200, { success: true });
        }
        return json(404, { error: 'Not found' });
      };
      const atender = () => {
        responder().catch((err: unknown) => json(500, { error: String(err) }));
      };
      if (falso.retrasoMs > 0) setTimeout(atender, falso.retrasoMs);
      else atender();
    });
  });
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  falso.url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  falsos.push(falso);
  return falso;
}
