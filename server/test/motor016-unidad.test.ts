import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { HttpError } from '../src/core/errors';
import { RutaDeGestionAusente } from '../src/engine/errores';
import { ClienteJmap } from '../src/engine/jmap';
import { AJUSTE_REINICIOS, almacenReiniciosEnBase } from '../src/engine/reinicios';
import { almacenReiniciosEnMemoria, Stalwart016Engine } from '../src/engine/stalwart016';
import { getSetting, setJsonSetting } from '../src/modules/settings';
import type { EngineSettings } from '../src/engine/types';

/*
 * Driver de Stalwart 0.16 contra un servidor JMAP falso que reproduce lo que
 * se grabó de un Stalwart 0.16.25 real (fixtures/motor016, generadas por
 * motor016-real.test.ts con MAILWAY_TEST_STALWART016_GRABAR=1):
 * - el estado inicial (ajustes, escuchas, roles, trazadores) es el de un
 *   motor recién puesto en marcha;
 * - los errores (401, 404, notRequest, unknownMethod, primaryKeyViolation,
 *   objectIsLinked, forbidden…) son los grabados, con los ids de este estado;
 * - el fichero de zona es el grabado (DKIM RSA partido en dos trozos);
 * - las consultas paginan como Stalwart: con el orden por defecto
 *   (descendente) cortan la página sobre la lista ascendente.
 * Lo que este falso no puede comprobar (que el motor acepte de verdad lo que
 * se le manda, IMAP y SMTP) lo cubre motor016-real.test.ts.
 */

const DIR = path.join(__dirname, 'fixtures', 'motor016');
const fixture = (nombre: string): any => JSON.parse(fs.readFileSync(path.join(DIR, nombre), 'utf8'));
const ZONA = fs.readFileSync(path.join(DIR, 'zona-dominio.txt'), 'utf8');
const SESION = fixture('sesion.json');
const INICIALES = fixture('ajustes-iniciales.json');
const ERR_PETICION = fixture('errores-peticion.json');
const ERR_OBJETO = fixture('errores-objeto.json');
const DOMINIO_GRABADO = fixture('dominio.json');
const COLA = fixture('cola.json');
const APP_GRABADA = fixture('contrasena-aplicacion.json');

const NOMBRE_GRABADO: string = DOMINIO_GRABADO.dominio.name;
const HOST_GRABADO: string = /IN MX \d+ (\S+)\.$/m.exec(ZONA)![1]!;
const CLAVE = 'clave-del-motor';

const copia = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const inicial = (id: string): any => (INICIALES.methodResponses as any[]).find((r) => r[2] === id)[1];

/** Error grabado con los ids de este estado. */
function errorGrabado(plantilla: any, cambios: Record<string, unknown>): any {
  return { ...copia(plantilla), ...cambios };
}

/* ------------------------------ Servidor falso ------------------------------ */

interface Credencial {
  credentialId: string;
  '@type': string;
  secret: string;
  [clave: string]: unknown;
}
interface Cuenta {
  id: string;
  n: number;
  '@type': 'User' | 'Group';
  name: string;
  domainId: string;
  description: string | null;
  credentials: Credencial[];
  quotas: Record<string, number>;
  roles: unknown;
  permissions: unknown;
  aliases: unknown;
  usedDiskQuota: number;
}
interface Dominio {
  id: string;
  n: number;
  name: string;
  description: string | null;
  dkimManagement: any;
  dnsManagement: any;
  certificateManagement: any;
  /** Consultas de firmas que faltan para que la tarea DKIM las cree. */
  dkimPendiente: number | null;
}
interface Firma {
  id: string;
  n: number;
  domainId: string;
  '@type': string;
  selector: string;
  stage: string;
  publicKey: string;
}
interface Lista {
  id: string;
  n: number;
  name: string;
  domainId: string;
  description: string | null;
  recipients: Record<string, boolean>;
  /** Direcciones adicionales (el cambio de dominio). */
  aliases?: unknown;
}

const ALGORITMOS = ['Dkim1Ed25519Sha256', 'Dkim1RsaSha256'];
const letra = (i: number): string => {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

class MotorFalso {
  readonly servidor: http.Server;
  url = '';
  /** Llamadas JMAP recibidas, en orden: [método, argumentos]. */
  llamadas: [string, any][] = [];
  peticionesHttp: { metodo: string; ruta: string; contentType?: string; autorizacion?: string }[] = [];
  /** Responde 429 a las próximas N peticiones. */
  limitar = 0;
  modo: 'normal' | 'v015' | 'sin-ruta' = 'normal';
  retrasoMs = 0;
  enVuelo = 0;
  maxEnVuelo = 0;
  /** La búsqueda de texto de las listas no encuentra nada (para el repaso completo). */
  textoCiego = false;
  recargas = 0;
  /** `using` de la última petición JMAP. */
  using: string[] = [];

  private contador = 0;
  dominios = new Map<string, Dominio>();
  firmas = new Map<string, Firma>();
  cuentas = new Map<string, Cuenta>();
  listas = new Map<string, Lista>();
  sistema: any;
  http: any;
  autenticacion: any;
  seguridad: any;
  cargado: { sistema: any; autenticacion: any };
  escuchas: any[];
  trazadores: any[];
  roles: any[];
  redes: any[];
  certificados: any[];
  proveedores: any[];
  nodos: any[];
  cola: any[] = [];

  constructor() {
    this.sistema = copia(inicial('s').list[0]);
    this.http = copia(inicial('h').list[0]);
    this.autenticacion = copia(inicial('a').list[0]);
    this.seguridad = copia(inicial('g').list[0]);
    this.cargado = { sistema: copia(this.sistema), autenticacion: copia(this.autenticacion) };
    this.escuchas = copia(inicial('l').list);
    this.trazadores = copia(inicial('t').list);
    this.roles = copia(inicial('r').list);
    this.redes = copia(inicial('i').list);
    this.certificados = copia(inicial('c').list);
    this.proveedores = copia(inicial('p').list);
    this.nodos = copia(inicial('n').list);
    for (const d of inicial('d').list as { id: string; name: string }[]) {
      this.dominios.set(d.id, {
        id: d.id,
        n: this.contador++,
        name: d.name,
        description: null,
        dkimManagement: { '@type': 'Manual' },
        dnsManagement: { '@type': 'Manual' },
        certificateManagement: { '@type': 'Manual' },
        dkimPendiente: null,
      });
    }
    this.servidor = http.createServer((req, res) => this.atender(req, res));
  }

  async arrancar(): Promise<string> {
    await new Promise<void>((resolve) => this.servidor.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.servidor.address() as AddressInfo).port}`;
    return this.url;
  }

  cerrar(): void {
    this.servidor.closeAllConnections();
    this.servidor.close();
  }

  nuevoId(prefijo: string): { id: string; n: number } {
    const n = ++this.contador;
    return { id: `${prefijo}${n}`, n };
  }

  /** «docker restart»: el nodo vuelve a arrancar (otra marca de arranque). */
  reiniciar(): void {
    // Como el real: arranca ahora (después de cualquier aviso guardado) y con otra marca.
    this.nodos = this.nodos.map((n) => ({
      ...n,
      lastRenewal: new Date(Math.max(Date.parse(n.lastRenewal) + 60_000, Date.now() + 1000))
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z'),
    }));
  }

  metodos(): string[] {
    return this.llamadas.map(([m]) => m);
  }

  private atender(req: http.IncomingMessage, res: http.ServerResponse): void {
    let crudo = '';
    req.on('data', (d) => (crudo += d));
    req.on('end', async () => {
      this.enVuelo++;
      this.maxEnVuelo = Math.max(this.maxEnVuelo, this.enVuelo);
      try {
        if (this.retrasoMs) await new Promise((r) => setTimeout(r, this.retrasoMs));
        const { status, cuerpo, cabeceras } = this.responder(req, crudo);
        res.writeHead(status, { 'content-type': status === 200 ? 'application/json; charset=utf-8' : 'application/problem+json', ...cabeceras });
        res.end(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo));
      } finally {
        this.enVuelo--;
      }
    });
  }

  private responder(req: http.IncomingMessage, crudo: string): { status: number; cuerpo: unknown; cabeceras?: Record<string, string> } {
    const ruta = new URL(req.url ?? '/', 'http://motor').pathname;
    this.peticionesHttp.push({
      metodo: req.method ?? '',
      ruta,
      contentType: req.headers['content-type'],
      autorizacion: req.headers.authorization,
    });
    if (this.modo === 'sin-ruta') return { status: 404, cuerpo: ERR_PETICION.rutaDesconocida.body };
    if (this.limitar > 0) {
      this.limitar--;
      return { status: 429, cuerpo: { type: 'about:blank', status: 429, title: 'Too Many Requests' } };
    }
    if (req.headers.authorization !== `Basic ${Buffer.from(`admin:${CLAVE}`).toString('base64')}`) {
      return { status: 401, cuerpo: ERR_PETICION.sinCredenciales.body };
    }
    if (ruta === '/jmap/session' && req.method === 'GET') {
      if (this.modo === 'v015') {
        // 0.15 sirve la sesión, pero sin la API de gestión.
        const sesion = copia(SESION);
        delete sesion.primaryAccounts['urn:stalwart:jmap'];
        for (const cuenta of Object.values<any>(sesion.accounts)) delete cuenta.accountCapabilities['urn:stalwart:jmap'];
        return { status: 200, cuerpo: sesion };
      }
      return { status: 200, cuerpo: SESION };
    }
    if (ruta !== '/jmap' || req.method !== 'POST') return { status: 404, cuerpo: ERR_PETICION.rutaDesconocida.body };
    if (!String(req.headers['content-type']).startsWith('application/json')) {
      return { status: 400, cuerpo: { type: 'urn:ietf:params:jmap:error:notRequest', status: 400, detail: 'Invalid content type' } };
    }
    const peticion = JSON.parse(crudo) as { using: string[]; methodCalls: [string, any, string][] };
    this.using = peticion.using;
    if (this.modo === 'v015') {
      // Así rechaza 0.15.5 una capacidad que no conoce (Request::parse → NotRequest).
      return {
        status: 400,
        cuerpo: { type: 'urn:ietf:params:jmap:error:notRequest', status: 400, detail: 'Unknown capability: "urn:stalwart:jmap" at line 1 column 63' },
      };
    }
    if (!peticion.using.includes('urn:stalwart:jmap')) {
      return { status: 400, cuerpo: ERR_PETICION.capacidadDesconocida.body };
    }
    const respuestas: [string, any, string][] = [];
    for (const [metodo, argumentosCrudos, id] of peticion.methodCalls) {
      this.llamadas.push([metodo, argumentosCrudos]);
      const argumentos = this.resolverReferencias(argumentosCrudos, respuestas);
      respuestas.push(...this.ejecutar(metodo, argumentos, id));
    }
    return { status: 200, cuerpo: { methodResponses: respuestas, sessionState: 'falso' } };
  }

  private resolverReferencias(argumentos: any, respuestas: [string, any, string][]): any {
    const salida: any = {};
    for (const [clave, valor] of Object.entries<any>(argumentos)) {
      if (!clave.startsWith('#')) {
        salida[clave] = valor;
        continue;
      }
      const previa = respuestas.find((r) => r[2] === valor.resultOf && r[0] === valor.name);
      assert.equal(valor.path, '/ids', 'el falso solo resuelve /ids');
      salida[clave.slice(1)] = previa?.[1]?.ids ?? [];
    }
    return salida;
  }

  /* ------------------------------ Métodos -------------------------------- */

  private ejecutar(metodo: string, a: any, id: string): [string, any, string][] {
    const [objeto, accion] = metodo.replace(/^x:/, '').split('/') as [string, string];
    const ok = (cuerpo: any): [string, any, string][] => [[metodo, { accountId: a.accountId ?? 'd333333', ...cuerpo }, id]];
    const manejador = (this as any)[`${accion}${objeto}`] as ((a: any) => any) | undefined;
    if (!metodo.startsWith('x:') || !manejador) {
      return [['error', { ...ERR_PETICION.metodoDesconocido.body.methodResponses[0][1], description: metodo }, id]];
    }
    return ok(manejador.call(this, a));
  }

  /** Paginación de Stalwart 0.16 (registry/query.rs). */
  private paginar<T extends { id: string; n: number }>(todos: T[], a: any): any {
    const ascendente = [...todos].sort((x, y) => x.n - y.n).map((o) => o.id);
    const orden = a.sort?.[0];
    const asc = orden ? orden.isAscending !== false : false; // por defecto, descendente
    const posicion: number | undefined = a.position;
    const limite: number = a.limit ?? 5000;
    if (!a.calculateTotal && (posicion === undefined || posicion > 0)) {
      // Se corta sobre la lista ascendente y la página se ordena después.
      const pagina = ascendente.slice(posicion ?? 0, (posicion ?? 0) + limite);
      return { queryState: 'n', canCalculateChanges: true, position: 0, ids: asc ? pagina : pagina.reverse() };
    }
    const lista = asc ? ascendente : [...ascendente].reverse();
    return {
      queryState: 'n',
      canCalculateChanges: true,
      position: posicion ?? 0,
      ids: lista.slice(posicion ?? 0, (posicion ?? 0) + limite),
      ...(a.calculateTotal ? { total: lista.length } : {}),
    };
  }

  private proyectar(objeto: any, propiedades?: string[]): any {
    if (!propiedades) return objeto;
    return Object.fromEntries(Object.entries(objeto).filter(([k]) => k === 'id' || propiedades.includes(k)));
  }

  private leer<T>(mapa: Map<string, T> | T[], a: any, vista: (o: T) => any): any {
    const todos = Array.isArray(mapa) ? mapa : [...mapa.values()];
    const porId = new Map(todos.map((o: any) => [o.id, o]));
    const ids: string[] = a.ids ?? todos.map((o: any) => o.id);
    const list: any[] = [];
    const notFound: string[] = [];
    for (const id of ids) {
      const o = porId.get(id);
      if (o) list.push(this.proyectar(vista(o as T), a.properties));
      else notFound.push(id);
    }
    return { list, notFound };
  }

  private dominioDe(id: string): Dominio | undefined {
    return this.dominios.get(id);
  }

  private direccion(name: string, domainId: string): string {
    return `${name}@${this.dominioDe(domainId)?.name ?? ''}`;
  }

  /** ¿Quién ocupa ya esa dirección? (índice único global de cuentas y listas) */
  private ocupante(name: string, domainId: string): { object: string; id: string } | null {
    for (const c of this.cuentas.values()) if (c.name === name && c.domainId === domainId) return { object: 'Account', id: c.id };
    for (const l of this.listas.values()) if (l.name === name && l.domainId === domainId) return { object: 'MailingList', id: l.id };
    return null;
  }

  // Domain
  queryDomain(a: any): any {
    let todos = [...this.dominios.values()];
    if (a.filter?.name !== undefined) todos = todos.filter((d) => d.name === a.filter.name);
    return this.paginar(todos, a);
  }
  getDomain(a: any): any {
    return this.leer(this.dominios, a, (d) => ({
      name: d.name,
      description: d.description,
      dkimManagement: d.dkimManagement,
      dnsManagement: d.dnsManagement,
      certificateManagement: d.certificateManagement,
      dnsZoneFile: this.zona(d),
      id: d.id,
    }));
  }
  setDomain(a: any): any {
    const r: any = {};
    for (const [clave, datos] of Object.entries<any>(a.create ?? {})) {
      const existente = [...this.dominios.values()].find((d) => d.name === datos.name);
      if (existente) {
        (r.notCreated ??= {})[clave] = errorGrabado(DOMINIO_GRABADO.duplicado.notCreated.d, { objectId: { object: 'Domain', id: existente.id } });
        continue;
      }
      const { id, n } = this.nuevoId('d');
      const dkim = datos.dkimManagement ?? { '@type': 'Automatic' };
      this.dominios.set(id, {
        id,
        n,
        name: datos.name,
        description: datos.description ?? null,
        dkimManagement: dkim['@type'] === 'Automatic' ? { ...dkim, algorithms: { Dkim1Ed25519Sha256: true, Dkim1RsaSha256: true } } : dkim,
        dnsManagement: datos.dnsManagement ?? { '@type': 'Manual' },
        certificateManagement: datos.certificateManagement ?? { '@type': 'Manual' },
        dkimPendiente: dkim['@type'] === 'Automatic' ? this.pasosDkim : null,
      });
      (r.created ??= {})[clave] = { id };
    }
    for (const [id, cambio] of Object.entries<any>(a.update ?? {})) {
      const d = this.dominios.get(id);
      if (!d) {
        (r.notUpdated ??= {})[id] = { type: 'notFound' };
        continue;
      }
      if (cambio.dkimManagement) {
        const antes = d.dkimManagement['@type'];
        d.dkimManagement = cambio.dkimManagement['@type'] === 'Automatic' ? { ...cambio.dkimManagement, algorithms: { Dkim1Ed25519Sha256: true, Dkim1RsaSha256: true } } : cambio.dkimManagement;
        if (antes !== 'Automatic' && d.dkimManagement['@type'] === 'Automatic') d.dkimPendiente = this.pasosDkim;
      }
      (r.updated ??= {})[id] = null;
    }
    for (const id of a.destroy ?? []) {
      const d = this.dominios.get(id);
      if (!d) {
        (r.notDestroyed ??= {})[id] = { type: 'notFound' };
        continue;
      }
      const enlazados = [
        ...[...this.cuentas.values()].filter((c) => c.domainId === id).map((c) => ({ object: 'Account', id: c.id })),
        ...[...this.firmas.values()].filter((f) => f.domainId === id).map((f) => ({ object: 'DkimSignature', id: f.id })),
        ...[...this.listas.values()].filter((l) => l.domainId === id).map((l) => ({ object: 'MailingList', id: l.id })),
        ...(this.sistema.defaultDomainId === id ? [{ object: 'SystemSettings', id: 'singleton' }] : []),
      ];
      if (enlazados.length) {
        (r.notDestroyed ??= {})[id] = errorGrabado(Object.values<any>(ERR_OBJETO.dominioEnlazado.notDestroyed)[0], {
          objectId: { object: 'Domain', id },
          linkedObjects: enlazados,
        });
        continue;
      }
      this.dominios.delete(id);
      (r.destroyed ??= []).push(id);
    }
    return r;
  }

  /** Consultas de firmas que tarda la tarea DKIM en crear las claves. */
  pasosDkim = 1;

  private generarFirmas(d: Dominio): void {
    for (const firma of DOMINIO_GRABADO.firmas as any[]) {
      if ([...this.firmas.values()].some((f) => f.domainId === d.id && f['@type'] === firma['@type'])) continue;
      const { id, n } = this.nuevoId('k');
      this.firmas.set(id, { id, n, domainId: d.id, '@type': firma['@type'], selector: firma.selector, stage: 'active', publicKey: firma.publicKey });
    }
  }

  /** Zona grabada, con el nombre del dominio, el del servidor en ejecución y sus firmas. */
  zona(d: Dominio): string {
    const bloques: string[] = [];
    for (const linea of ZONA.split('\n')) {
      if (/^\s|^\)/.test(linea) && bloques.length) bloques[bloques.length - 1] += `\n${linea}`;
      else if (linea) bloques.push(linea);
    }
    const tipos = new Set([...this.firmas.values()].filter((f) => f.domainId === d.id).map((f) => f['@type']));
    const conservados = bloques.filter((b) => {
      if (!b.includes('._domainkey.')) return true;
      return b.includes('k=rsa') ? tipos.has('Dkim1RsaSha256') : tipos.has('Dkim1Ed25519Sha256');
    });
    return `${conservados.join('\n')}\n`
      .split(`${HOST_GRABADO}.`)
      .join('\u0000.')
      .split(NOMBRE_GRABADO)
      .join(d.name)
      .split('\u0000.')
      .join(`${this.cargado.sistema.defaultHostname}.`);
  }

  // DkimSignature
  queryDkimSignature(a: any): any {
    const dominioId = a.filter?.domainId;
    const d = dominioId ? this.dominios.get(dominioId) : undefined;
    if (d && d.dkimPendiente !== null) {
      if (d.dkimPendiente <= 0) {
        this.generarFirmas(d);
        d.dkimPendiente = null;
      } else d.dkimPendiente--;
    }
    return this.paginar([...this.firmas.values()].filter((f) => !dominioId || f.domainId === dominioId), a);
  }
  getDkimSignature(a: any): any {
    return this.leer(this.firmas, a, (f) => ({ ...f, n: undefined }));
  }
  setDkimSignature(a: any): any {
    const r: any = {};
    for (const id of a.destroy ?? []) {
      if (this.firmas.delete(id)) (r.destroyed ??= []).push(id);
      else (r.notDestroyed ??= {})[id] = { type: 'notFound' };
    }
    return r;
  }

  // Task
  setTask(a: any): any {
    const r: any = {};
    for (const [clave, tarea] of Object.entries<any>(a.create ?? {})) {
      const d = this.dominios.get(tarea.domainId);
      if (tarea['@type'] === 'DkimManagement' && d?.dkimManagement['@type'] === 'Automatic') d.dkimPendiente = this.pasosDkim;
      (r.created ??= {})[clave] = { id: this.nuevoId('t').id };
    }
    return r;
  }

  // Account
  private vistaCuenta(c: Cuenta): any {
    return {
      '@type': c['@type'],
      name: c.name,
      domainId: c.domainId,
      description: c.description,
      credentials: Object.fromEntries(c.credentials.map((cr, i) => [String(i), { ...cr, secret: '****' }])),
      quotas: c.quotas,
      roles: c.roles,
      permissions: c.permissions,
      aliases: c.aliases,
      usedDiskQuota: c.usedDiskQuota,
      emailAddress: this.direccion(c.name, c.domainId),
      id: c.id,
    };
  }
  queryAccount(a: any): any {
    let todos = [...this.cuentas.values()];
    if (a.filter?.name !== undefined) todos = todos.filter((c) => c.name === a.filter.name);
    if (a.filter?.domainId !== undefined) todos = todos.filter((c) => c.domainId === a.filter.domainId);
    return this.paginar(todos, a);
  }
  getAccount(a: any): any {
    return this.leer(this.cuentas, a, (c) => this.vistaCuenta(c));
  }
  private credenciales(mapa: Record<string, any>, anteriores: Credencial[] = []): Credencial[] {
    return Object.values(mapa).map((cr, i) => ({
      ...cr,
      credentialId: letra(i),
      secret: cr.secret === '****' ? (anteriores[i]?.secret ?? '') : cr.secret,
    }));
  }
  setAccount(a: any): any {
    const r: any = {};
    for (const [clave, datos] of Object.entries<any>(a.create ?? {})) {
      if (!this.dominios.has(datos.domainId)) {
        (r.notCreated ??= {})[clave] = { type: 'invalidForeignKey', objectId: { object: 'Domain', id: datos.domainId } };
        continue;
      }
      const ocupa = this.ocupante(datos.name, datos.domainId);
      if (ocupa) {
        (r.notCreated ??= {})[clave] = errorGrabado(ERR_OBJETO.cuentaDuplicada.notCreated.a, { objectId: ocupa });
        continue;
      }
      const { id, n } = this.nuevoId('c');
      this.cuentas.set(id, {
        id,
        n,
        '@type': datos['@type'] ?? 'User',
        name: datos.name,
        domainId: datos.domainId,
        description: datos.description ?? null,
        credentials: this.credenciales(datos.credentials ?? {}),
        quotas: datos.quotas ?? {},
        roles: datos.roles,
        permissions: datos.permissions,
        aliases: datos.aliases ?? {},
        usedDiskQuota: 0,
      });
      (r.created ??= {})[clave] = { id };
    }
    for (const [id, cambio] of Object.entries<any>(a.update ?? {})) {
      const c = this.cuentas.get(id);
      if (!c) {
        (r.notUpdated ??= {})[id] = { type: 'notFound' };
        continue;
      }
      // Cambio de dominio: nombre y dominio a la vez, con el mismo índice
      // único que el alta (la actualización entera falla o se aplica entera).
      if ('name' in cambio || 'domainId' in cambio) {
        const nombre = cambio.name ?? c.name;
        const dominioId = cambio.domainId ?? c.domainId;
        if (!this.dominios.has(dominioId)) {
          (r.notUpdated ??= {})[id] = { type: 'invalidForeignKey', objectId: { object: 'Domain', id: dominioId } };
          continue;
        }
        const ocupa = this.ocupante(nombre, dominioId);
        if (ocupa && ocupa.id !== id) {
          (r.notUpdated ??= {})[id] = errorGrabado(ERR_OBJETO.cuentaDuplicada.notCreated.a, { objectId: ocupa });
          continue;
        }
        c.name = nombre;
        c.domainId = dominioId;
      }
      for (const [clave, valor] of Object.entries<any>(cambio)) {
        if (clave === 'name' || clave === 'domainId') continue;
        const partes = clave.split('/');
        if (partes[0] === 'credentials' && partes.length === 3 && partes[2] === 'secret') {
          c.credentials[Number(partes[1])]!.secret = valor;
        } else if (partes[0] === 'credentials' && partes.length === 2) {
          const i = Number(partes[1]);
          c.credentials[i] = { ...valor, credentialId: letra(c.credentials.length) };
        } else if (partes[0] === 'quotas' && partes.length === 2) {
          if (valor === null) delete c.quotas[partes[1]!];
          else c.quotas[partes[1]!] = valor;
        } else if (clave === 'credentials') {
          c.credentials = this.credenciales(valor, c.credentials);
        } else if (['description', 'quotas', 'roles', 'permissions', 'aliases'].includes(clave)) {
          (c as any)[clave] = valor;
        } else {
          (r.notUpdated ??= {})[id] = { type: 'invalidPatch', description: 'Invalid property', properties: [clave] };
        }
      }
      if (!r.notUpdated?.[id]) (r.updated ??= {})[id] = null;
    }
    for (const id of a.destroy ?? []) {
      if (this.cuentas.delete(id)) (r.destroyed ??= []).push(id);
      else (r.notDestroyed ??= {})[id] = { type: 'notFound' };
    }
    return r;
  }

  // AppPassword (siempre con accountId de la cuenta del buzón)
  getAppPassword(a: any): any {
    const c = this.cuentas.get(a.accountId);
    const apps = (c?.credentials ?? []).filter((cr) => cr['@type'] === 'AppPassword');
    return this.leer(apps.map((cr) => ({ ...cr, id: cr.credentialId })), a, (cr: any) => ({ description: cr.description, secret: '****', id: cr.id }));
  }
  setAppPassword(a: any): any {
    const r: any = {};
    const c = this.cuentas.get(a.accountId);
    for (const [clave, datos] of Object.entries<any>(a.create ?? {})) {
      if (!c) {
        (r.notCreated ??= {})[clave] = { type: 'notFound' };
        continue;
      }
      const cupo = this.cargado.autenticacion.maxAppPasswords;
      if (c.credentials.filter((cr) => cr['@type'] === 'AppPassword').length >= cupo) {
        (r.notCreated ??= {})[clave] = { type: 'overQuota', description: `You have exceeded your quota of ${cupo} app passwords.` };
        continue;
      }
      const credentialId = letra(c.credentials.length);
      const secret = `app_${credentialId}${'0'.repeat(APP_GRABADA.created.k.secret.length - 5)}`;
      c.credentials.push({ credentialId, '@type': 'AppPassword', secret, description: datos.description, permissions: datos.permissions });
      (r.created ??= {})[clave] = { id: credentialId, secret };
    }
    for (const id of a.destroy ?? []) {
      const i = c?.credentials.findIndex((cr) => cr.credentialId === id) ?? -1;
      if (!c || i < 0) {
        (r.notDestroyed ??= {})[id] = { type: 'notFound' };
      } else if (c.credentials[i]!['@type'] !== 'AppPassword') {
        (r.notDestroyed ??= {})[id] = copia(ERR_OBJETO.borrarPrincipal.notDestroyed[Object.keys(ERR_OBJETO.borrarPrincipal.notDestroyed)[0]!]);
      } else {
        c.credentials.splice(i, 1);
        (r.destroyed ??= []).push(id);
      }
    }
    return r;
  }

  // MailingList
  queryMailingList(a: any): any {
    let todas = [...this.listas.values()];
    if (a.filter?.text !== undefined) {
      const fichas = String(a.filter.text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      todas = this.textoCiego
        ? []
        : todas.filter((l) => {
            const texto = new Set([l.name, l.description ?? '', ...Object.keys(l.recipients)].join(' ').toLowerCase().split(/[^a-z0-9]+/));
            return fichas.every((f) => texto.has(f));
          });
    }
    return this.paginar(todas, a);
  }
  getMailingList(a: any): any {
    return this.leer(this.listas, a, (l) => ({ ...l, n: undefined, emailAddress: this.direccion(l.name, l.domainId) }));
  }
  setMailingList(a: any): any {
    const r: any = {};
    for (const [clave, datos] of Object.entries<any>(a.create ?? {})) {
      const ocupa = this.ocupante(datos.name, datos.domainId);
      if (ocupa) {
        (r.notCreated ??= {})[clave] = errorGrabado(ERR_OBJETO.listaContraCuenta.notCreated.l, { objectId: ocupa });
        continue;
      }
      const { id, n } = this.nuevoId('l');
      this.listas.set(id, { id, n, name: datos.name, domainId: datos.domainId, description: datos.description ?? null, recipients: datos.recipients ?? {} });
      (r.created ??= {})[clave] = { id };
    }
    for (const [id, cambio] of Object.entries<any>(a.update ?? {})) {
      const l = this.listas.get(id);
      if (!l) {
        (r.notUpdated ??= {})[id] = { type: 'notFound' };
        continue;
      }
      // Renombrar: el mismo índice único de direcciones que el alta.
      const ocupa = this.ocupante(cambio.name ?? l.name, cambio.domainId ?? l.domainId);
      if (ocupa && ocupa.id !== id) {
        (r.notUpdated ??= {})[id] = errorGrabado(ERR_OBJETO.listaContraCuenta.notCreated.l, { objectId: ocupa });
        continue;
      }
      Object.assign(l, cambio);
      (r.updated ??= {})[id] = null;
    }
    for (const id of a.destroy ?? []) {
      if (this.listas.delete(id)) (r.destroyed ??= []).push(id);
      else (r.notDestroyed ??= {})[id] = { type: 'notFound' };
    }
    return r;
  }

  // Singletons
  private aplicar(objeto: any, cambio: Record<string, any>): void {
    for (const [clave, valor] of Object.entries(cambio)) {
      const partes = clave.split('/');
      let destino = objeto;
      for (const p of partes.slice(0, -1)) destino = destino[p] ??= {};
      const ultima = partes[partes.length - 1]!;
      if (valor === null && partes.length > 1) delete destino[ultima];
      else destino[ultima] = valor;
    }
  }
  private singleton(objeto: any, a: any): any {
    return { list: (a.ids ?? ['singleton']).includes('singleton') ? [this.proyectar({ ...objeto, id: 'singleton' }, a.properties)] : [], notFound: [] };
  }
  private setSingleton(objeto: any, a: any): any {
    if (a.update?.singleton) this.aplicar(objeto, a.update.singleton);
    return { updated: a.update?.singleton ? { singleton: null } : undefined };
  }
  getSystemSettings(a: any): any {
    return this.singleton(this.sistema, a);
  }
  setSystemSettings(a: any): any {
    return this.setSingleton(this.sistema, a);
  }
  getHttp(a: any): any {
    return this.singleton(this.http, a);
  }
  setHttp(a: any): any {
    return this.setSingleton(this.http, a);
  }
  getAuthentication(a: any): any {
    return this.singleton(this.autenticacion, a);
  }
  setAuthentication(a: any): any {
    return this.setSingleton(this.autenticacion, a);
  }
  getSecurity(a: any): any {
    return this.singleton(this.seguridad, a);
  }
  setSecurity(a: any): any {
    return this.setSingleton(this.seguridad, a);
  }

  // Listas de ajustes
  private crearEn(lista: any[], prefijo: string, a: any, unico?: (nuevo: any, existente: any) => boolean, objeto = ''): any {
    const r: any = {};
    for (const [clave, datos] of Object.entries<any>(a.create ?? {})) {
      const choca = unico ? lista.find((e) => unico(datos, e)) : undefined;
      if (choca) {
        (r.notCreated ??= {})[clave] = { type: 'primaryKeyViolation', properties: ['address'], objectId: { object: objeto, id: choca.id } };
        continue;
      }
      const { id } = this.nuevoId(prefijo);
      lista.push({ ...datos, id });
      (r.created ??= {})[clave] = { id };
    }
    for (const [id, cambio] of Object.entries<any>(a.update ?? {})) {
      const e = lista.find((x) => x.id === id);
      if (!e) (r.notUpdated ??= {})[id] = { type: 'notFound' };
      else {
        this.aplicar(e, cambio);
        (r.updated ??= {})[id] = null;
      }
    }
    return r;
  }
  getNetworkListener(a: any): any {
    return this.leer(this.escuchas, a, (e) => e);
  }
  setNetworkListener(a: any): any {
    return this.crearEn(this.escuchas, 'e', a, (n, e) => n.name === e.name, 'NetworkListener');
  }
  getTracer(a: any): any {
    return this.leer(this.trazadores, a, (t) => t);
  }
  setTracer(a: any): any {
    return this.crearEn(this.trazadores, 't', a);
  }
  getRole(a: any): any {
    return this.leer(this.roles, a, (r) => r);
  }
  setRole(a: any): any {
    return this.crearEn(this.roles, 'r', a);
  }
  queryAllowedIp(a: any): any {
    const todas = this.redes.map((red, i) => ({ id: red.id, n: i }));
    return this.paginar(todas, a);
  }
  getAllowedIp(a: any): any {
    return this.leer(this.redes, a, (red) => red);
  }
  setAllowedIp(a: any): any {
    return this.crearEn(this.redes, 'i', a, (n, e) => n.address === e.address, 'AllowedIp');
  }
  getCertificate(a: any): any {
    return this.leer(this.certificados, a, (c) => c);
  }
  getAcmeProvider(a: any): any {
    return this.leer(this.proveedores, a, (p) => p);
  }
  getClusterNode(a: any): any {
    return this.leer(this.nodos.map((n) => ({ ...n, id: String(n.id ?? 'a') })), a, (n) => n);
  }

  // Action
  setAction(a: any): any {
    const r: any = {};
    for (const [clave, accion] of Object.entries<any>(a.create ?? {})) {
      if (accion['@type'] === 'ReloadSettings') {
        this.recargas++;
        this.cargado = { sistema: copia(this.sistema), autenticacion: copia(this.autenticacion) };
      } else if (accion['@type'] !== 'ReloadTlsCertificates') {
        (r.notCreated ??= {})[clave] = { type: 'invalidProperties', properties: ['@type'] };
        continue;
      }
      (r.created ??= {})[clave] = { id: this.nuevoId('a').id };
    }
    return r;
  }

  // QueuedMessage
  queryQueuedMessage(a: any): any {
    const ordenados = [...this.cola].sort((x, y) => Date.parse(x.nextRetry) - Date.parse(y.nextRetry));
    return { queryState: 'n', canCalculateChanges: true, position: 0, ids: ordenados.slice(0, a.limit ?? 5000).map((m) => m.id), ...(a.calculateTotal ? { total: this.cola.length } : {}) };
  }
  getQueuedMessage(a: any): any {
    return this.leer(this.cola, a, (m) => m);
  }
}

/* --------------------------------- Pruebas --------------------------------- */

let motorFalso: MotorFalso;

function ajustes(extra: Partial<EngineSettings> = {}): EngineSettings {
  return {
    kind: 'stalwart',
    url: motorFalso.url,
    adminUser: 'admin',
    adminPassword: CLAVE,
    smtpHost: '127.0.0.1',
    smtpPort: 587,
    smtpSecure: false,
    ...extra,
  };
}

/** Esperas cortas: el falso crea las claves DKIM en unas pocas consultas. */
const RAPIDOS = { esperaDkim: 500, esperaTareaEnCurso: 150, intervaloDkim: 20, esperaTrasLimite: 10 };

function crearMotor(extra: Partial<EngineSettings> = {}): Stalwart016Engine {
  return new Stalwart016Engine(ajustes(extra), { tiempos: RAPIDOS });
}

async function nuevoMotor(): Promise<Stalwart016Engine> {
  motorFalso?.cerrar();
  motorFalso = new MotorFalso();
  await motorFalso.arrancar();
  return crearMotor();
}

function codigo(c: string) {
  return (err: unknown) => err instanceof HttpError && err.code === c;
}

after(() => motorFalso?.cerrar());

describe('transporte JMAP', () => {
  let motor: Stalwart016Engine;
  beforeEach(async () => {
    motor = await nuevoMotor();
  });

  test('autenticación Basic, Content-Type JSON y las dos capacidades en using', async () => {
    assert.deepEqual(await motor.ping(), { ok: true, api: 'jmap016' });
    assert.equal(await motor.detectApi(), 'jmap016');
    const post = motorFalso.peticionesHttp.find((p) => p.metodo === 'POST')!;
    assert.equal(post.ruta, '/jmap');
    assert.equal(post.contentType, 'application/json');
    assert.equal(post.autorizacion, `Basic ${Buffer.from(`admin:${CLAVE}`).toString('base64')}`);
    assert.deepEqual(motorFalso.using, ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap']);
  });

  test('credenciales rechazadas: engine_auth_failed con un mensaje claro', async () => {
    const malo = crearMotor({ adminPassword: 'otra' });
    await assert.rejects(malo.createDomain('a.test'), (err: HttpError) => {
      assert.equal(err.code, 'engine_auth_failed');
      assert.equal(err.status, 502);
      assert.match(err.message, /credenciales de administración/);
      assert.match(err.message, /STALWART_RECOVERY_ADMIN/);
      return true;
    });
    const salud = await malo.ping();
    assert.equal(salud.ok, false);
    assert.match(salud.detail!, /401/);
  });

  test('un 404 en la ruta de gestión es RutaDeGestionAusente (también en ping)', async () => {
    motorFalso.modo = 'sin-ruta';
    await assert.rejects(motor.createDomain('a.test'), (err: unknown) => err instanceof RutaDeGestionAusente);
    await assert.rejects(motor.ping(), (err: unknown) => err instanceof RutaDeGestionAusente);
  });

  test('un Stalwart 0.15 (sesión sin gestión, capacidad desconocida) es RutaDeGestionAusente', async () => {
    motorFalso.modo = 'v015';
    await assert.rejects(motor.ping(), (err: unknown) => err instanceof RutaDeGestionAusente);
    await assert.rejects(motor.getQueueSummary(), (err: unknown) => err instanceof RutaDeGestionAusente);
  });

  test('método x: desconocido (unknownMethod) es RutaDeGestionAusente; la capacidad que falta, también', async () => {
    const cliente = new ClienteJmap({ url: motorFalso.url, usuario: 'admin', clave: CLAVE });
    const res = await cliente.peticion([['x:NoExiste/get', {}, 'c']]);
    assert.throws(() => res.de('c'), (err: unknown) => err instanceof RutaDeGestionAusente);
    // Grabado de 0.16: capacidad desconocida en using → notRequest (sin la frase de 0.15).
    assert.equal(ERR_PETICION.capacidadDesconocida.body.type, 'urn:ietf:params:jmap:error:notRequest');
  });

  test('429: se repite una vez; si sigue, error claro', async () => {
    motorFalso.limitar = 1;
    assert.equal((await motor.ping()).ok, true);
    motorFalso.limitar = 2;
    await assert.rejects(motor.getQueueSummary(), (err: HttpError) => {
      assert.equal(err.code, 'engine_error');
      assert.match(err.message, /429/);
      return true;
    });
  });

  test('sin conexión o sin respuesta: engine_unreachable', async () => {
    // Un puerto que acaba de quedar libre: conexión rechazada.
    const libre = http.createServer();
    await new Promise<void>((resolve) => libre.listen(0, '127.0.0.1', resolve));
    const puerto = (libre.address() as AddressInfo).port;
    await new Promise((resolve) => libre.close(resolve));
    const cerrado = crearMotor({ url: `http://127.0.0.1:${puerto}` });
    await assert.rejects(cerrado.getQueueSummary(), (err: HttpError) => {
      assert.equal(err.code, 'engine_unreachable');
      assert.match(err.message, /ECONNREFUSED/);
      return true;
    });
    motorFalso.retrasoMs = 300;
    const cliente = new ClienteJmap({ url: motorFalso.url, usuario: 'admin', clave: CLAVE, timeoutMs: 50 });
    await assert.rejects(cliente.peticion([['x:Domain/query', {}, 'c']]), (err: HttpError) => {
      assert.equal(err.code, 'engine_unreachable');
      assert.match(err.message, /no respondió/);
      return true;
    });
  });

  test('las peticiones van en serie aunque el panel pida varias cosas a la vez', async () => {
    motorFalso.retrasoMs = 20;
    await Promise.all([
      motor.getQueueSummary(),
      motor.getMailboxUsage(),
      motor.listDirectory(),
      motor.getRunningHostname(),
      motor.ping(),
    ]);
    assert.equal(motorFalso.maxEnVuelo, 1);
  });
});

describe('dominios, DKIM y registros DNS', () => {
  let motor: Stalwart016Engine;
  beforeEach(async () => {
    motor = await nuevoMotor();
  });

  test('alta con DKIM automático; si ya existe, se adopta', async () => {
    await motor.createDomain('Cliente.Test.');
    const [, alta] = motorFalso.llamadas.find(([m]) => m === 'x:Domain/set')!;
    assert.deepEqual(alta.create.d, {
      name: 'cliente.test',
      description: 'Dominio gestionado por Mailway',
      dkimManagement: { '@type': 'Automatic' },
      dnsManagement: { '@type': 'Manual' },
      certificateManagement: { '@type': 'Manual' },
      subAddressing: { '@type': 'Enabled' },
    });
    await motor.createDomain('cliente.test');
    assert.equal([...motorFalso.dominios.values()].filter((d) => d.name === 'cliente.test').length, 1);
  });

  test('ensureDkim espera a la tarea del motor y no repite si ya hay claves', async () => {
    await motor.createDomain('cliente.test');
    motorFalso.pasosDkim = 1;
    await motor.ensureDkim('cliente.test', 'mail');
    const id = [...motorFalso.dominios.values()].find((d) => d.name === 'cliente.test')!.id;
    assert.deepEqual([...motorFalso.firmas.values()].filter((f) => f.domainId === id).map((f) => f['@type']).sort(), ALGORITMOS);
    const antes = motorFalso.llamadas.length;
    await motor.ensureDkim('cliente.test', 'mail');
    assert.ok(!motorFalso.metodos().slice(antes).some((m) => m.endsWith('/set')), 'con las claves ya creadas no toca nada');
  });

  test('ensureDkim en un dominio con DKIM manual sin claves lo pasa a automático', async () => {
    // El dominio por defecto del arranque está en manual y sin claves.
    const arranque = [...motorFalso.dominios.values()][0]!;
    await motor.ensureDkim(arranque.name, 'mail');
    assert.equal(arranque.dkimManagement['@type'], 'Automatic');
    assert.equal([...motorFalso.firmas.values()].filter((f) => f.domainId === arranque.id).length, 2);
  });

  test('ensureDkim en automático al que le falta una clave crea la tarea DkimManagement', async () => {
    await motor.createDomain('cliente.test');
    await motor.ensureDkim('cliente.test', 'mail');
    const rsa = [...motorFalso.firmas.values()].find((f) => f['@type'] === 'Dkim1RsaSha256')!;
    motorFalso.firmas.delete(rsa.id);
    await motor.ensureDkim('cliente.test', 'mail');
    const tarea = motorFalso.llamadas.find(([m]) => m === 'x:Task/set')![1].create.t;
    assert.equal(tarea['@type'], 'DkimManagement');
    assert.equal(tarea.status['@type'], 'Pending');
    assert.match(tarea.status.due, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.ok([...motorFalso.firmas.values()].some((f) => f['@type'] === 'Dkim1RsaSha256'));
  });

  test('ensureDkim no falla si la tarea tarda más de la espera', async () => {
    await motor.createDomain('lento.test');
    motorFalso.pasosDkim = 10_000;
    for (const d of motorFalso.dominios.values()) if (d.name === 'lento.test') d.dkimPendiente = 10_000;
    const inicio = Date.now();
    await motor.ensureDkim('lento.test', 'mail');
    // Margen de la tarea en curso + espera tras programar otra, y sigue.
    assert.ok(Date.now() - inicio < 2_000);
    assert.equal(motorFalso.firmas.size, 0);
  });

  test('getDnsRecords: la zona BIND en la forma de 0.15 (DKIM RSA en una sola cadena)', async () => {
    await motor.createDomain('cliente.test');
    await motor.ensureDkim('cliente.test', 'mail');
    const registros = await motor.getDnsRecords('cliente.test');
    assert.deepEqual(registros.find((r) => r.type === 'MX'), { type: 'MX', name: 'cliente.test.', content: `10 ${HOST_GRABADO}.` });
    const rsa = registros.find((r) => r.content.includes('k=rsa'))!;
    const grabada = (DOMINIO_GRABADO.firmas as any[]).find((f) => f['@type'] === 'Dkim1RsaSha256');
    assert.equal(rsa.name, `${grabada.selector}._domainkey.cliente.test.`);
    assert.equal(rsa.content, `v=DKIM1; k=rsa; h=sha256; p=${grabada.publicKey}`);
    await assert.rejects(motor.getDnsRecords('no-existe.test'), codigo('engine_not_found'));
  });

  test('getRunningHostname: destino del MX del dominio por defecto, el cargado y no el guardado', async () => {
    assert.equal(await motor.getRunningHostname(), HOST_GRABADO);
    // Guardado sin recargar: el motor aún usa el anterior.
    motorFalso.sistema.defaultHostname = 'otro.ejemplo.test';
    assert.equal(await motor.getRunningHostname(), HOST_GRABADO);
    motorFalso.cargado.sistema.defaultHostname = 'otro.ejemplo.test';
    assert.equal(await motor.getRunningHostname(), 'otro.ejemplo.test');
    motorFalso.dominios.clear();
    motorFalso.sistema.defaultDomainId = null;
    assert.equal(await motor.getRunningHostname(), null);
  });

  test('borrado: solo DKIM → se borran las firmas y el dominio; idempotente', async () => {
    await motor.createDomain('cliente.test');
    await motor.ensureDkim('cliente.test', 'mail');
    await motor.deleteDomain('cliente.test');
    assert.ok(![...motorFalso.dominios.values()].some((d) => d.name === 'cliente.test'));
    assert.equal(motorFalso.firmas.size, 0);
    await motor.deleteDomain('cliente.test');
  });

  test('borrado con buzones: error claro y las claves DKIM se conservan', async () => {
    await motor.createDomain('cliente.test');
    await motor.ensureDkim('cliente.test', 'mail');
    await motor.createMailbox({ email: 'ana@cliente.test', passwordHash: '$6$sal$hash' });
    await assert.rejects(motor.deleteDomain('cliente.test'), (err: HttpError) => {
      assert.equal(err.code, 'engine_error');
      assert.match(err.message, /cliente\.test/);
      assert.match(err.message, /un buzón y 2 firmas DKIM/);
      return true;
    });
    assert.equal(motorFalso.firmas.size, 2);
  });

  test('borrado del dominio por defecto: lo dicen los ajustes del sistema', async () => {
    const arranque = [...motorFalso.dominios.values()].find((d) => d.id === motorFalso.sistema.defaultDomainId)!;
    await assert.rejects(motor.deleteDomain(arranque.name), /ajustes del sistema/);
  });

  test('id de dominio obsoleto en la caché: se vuelve a buscar', async () => {
    await motor.createDomain('cliente.test');
    await motor.getDnsRecords('cliente.test');
    // Otro lo borra y lo crea de nuevo (otro id).
    const viejo = [...motorFalso.dominios.values()].find((d) => d.name === 'cliente.test')!;
    motorFalso.dominios.delete(viejo.id);
    const { id, n } = motorFalso.nuevoId('d');
    motorFalso.dominios.set(id, { ...viejo, id, n });
    assert.ok((await motor.getDnsRecords('cliente.test')).length > 0);
    await motor.createMailbox({ email: 'ana@cliente.test', passwordHash: '$6$s$h' });
    assert.equal([...motorFalso.cuentas.values()][0]!.domainId, id);
  });
});

describe('buzones y contraseñas de aplicación', () => {
  let motor: Stalwart016Engine;
  beforeEach(async () => {
    motor = await nuevoMotor();
    await motor.createDomain('cliente.test');
  });

  const cuenta = (email: string) =>
    [...motorFalso.cuentas.values()].find((c) => `${c.name}@${motorFalso.dominios.get(c.domainId)!.name}` === email);

  test('alta: el $6$ va tal cual, cuota solo si hay límite y nombre visible opcional', async () => {
    await motor.createMailbox({ email: 'Ana@Cliente.test', passwordHash: '$6$sal$hash', displayName: 'Ana', quotaBytes: 1000 });
    const alta = motorFalso.llamadas.find(([m]) => m === 'x:Account/set')![1].create.a;
    assert.deepEqual(alta, {
      '@type': 'User',
      name: 'ana',
      domainId: motorFalso.dominios.size && [...motorFalso.dominios.values()].find((d) => d.name === 'cliente.test')!.id,
      description: 'Ana',
      credentials: { '0': { '@type': 'Password', secret: '$6$sal$hash' } },
      quotas: { maxDiskQuota: 1000 },
      roles: { '@type': 'User' },
      permissions: { '@type': 'Inherit' },
      aliases: {},
      encryptionAtRest: { '@type': 'Disabled' },
      memberGroupIds: {},
    });
    await motor.createMailbox({ email: 'beto@cliente.test', passwordHash: '$6$s$h', displayName: '  ', quotaBytes: 0 });
    const beto = cuenta('beto@cliente.test')!;
    assert.equal(beto.description, null);
    assert.deepEqual(beto.quotas, {});
    await assert.rejects(motor.createMailbox({ email: 'x@no-existe.test', passwordHash: '$6$s$h' }), codigo('engine_not_found'));
  });

  test('buzón huérfano: se adopta con la contraseña nueva, sin contraseñas de aplicación y reactivado', async () => {
    await motor.createMailbox({ email: 'ana@cliente.test', passwordHash: '$6$vieja$h' });
    await motor.addAppPassword('ana@cliente.test', 'antigua', 'x');
    cuenta('ana@cliente.test')!.permissions = { '@type': 'Merge', disabledPermissions: { authenticate: true } };
    // Otro proceso del panel (sin caché) da de alta la misma dirección.
    const otro = crearMotor();
    await otro.createMailbox({ email: 'ana@cliente.test', passwordHash: '$6$nueva$h', displayName: 'Ana' });
    const ana = cuenta('ana@cliente.test')!;
    assert.deepEqual(ana.credentials.map((c) => [c['@type'], c.secret]), [['Password', '$6$nueva$h']]);
    assert.deepEqual(ana.permissions, { '@type': 'Inherit' });
    assert.equal(ana.description, 'Ana');
    assert.equal(motorFalso.cuentas.size, 1);
  });

  test('una dirección ocupada por un alias no es un buzón huérfano', async () => {
    await motor.upsertAlias('ventas@cliente.test', ['x@y.test']);
    await assert.rejects(motor.createMailbox({ email: 'ventas@cliente.test', passwordHash: '$6$s$h' }), (err: HttpError) => {
      assert.equal(err.code, 'engine_exists');
      assert.match(err.message, /alias/);
      return true;
    });
  });

  test('cambiar la contraseña toca solo la principal (aunque no sea la primera de la lista)', async () => {
    await motor.createMailbox({ email: 'ana@cliente.test', passwordHash: '$6$uno$h' });
    const app = await motor.addAppPassword('ana@cliente.test', 'movil', 'x');
    const ana = cuenta('ana@cliente.test')!;
    // Una cuenta migrada puede tener la contraseña de aplicación delante.
    ana.credentials.reverse();
    await motor.setMailboxPassword('ana@cliente.test', '$6$dos$h');
    const cambio = motorFalso.llamadas.filter(([m]) => m === 'x:Account/set').pop()![1].update;
    assert.deepEqual(Object.values(cambio)[0], { 'credentials/1/secret': '$6$dos$h' });
    assert.deepEqual(ana.credentials.map((c) => c.secret), [app.secret, '$6$dos$h']);
  });

  test('cambiar la contraseña de una cuenta sin principal la añade', async () => {
    await motor.createMailbox({ email: 'ana@cliente.test', passwordHash: '$6$uno$h' });
    await motor.addAppPassword('ana@cliente.test', 'movil', 'x');
    const ana = cuenta('ana@cliente.test')!;
    ana.credentials = ana.credentials.filter((c) => c['@type'] !== 'Password');
    await motor.setMailboxPassword('ana@cliente.test', '$6$dos$h');
    assert.deepEqual(ana.credentials.map((c) => c['@type']).sort(), ['AppPassword', 'Password']);
  });

  test('nombre, cuota y suspensión con el modelo de permisos de 0.16', async () => {
    await motor.createMailbox({ email: 'ana@cliente.test', passwordHash: '$6$uno$h', quotaBytes: 500 });
    await motor.updateMailbox('ana@cliente.test', { displayName: 'Ana B', quotaBytes: 0, suspended: true });
    const cambio = Object.values<any>(motorFalso.llamadas.filter(([m]) => m === 'x:Account/set').pop()![1].update)[0];
    assert.deepEqual(cambio, {
      description: 'Ana B',
      'quotas/maxDiskQuota': null,
      permissions: { '@type': 'Merge', enabledPermissions: {}, disabledPermissions: { authenticate: true } },
    });
    assert.deepEqual(cuenta('ana@cliente.test')!.quotas, {});
    await motor.updateMailbox('ana@cliente.test', { suspended: false, quotaBytes: 2000 });
    assert.deepEqual(cuenta('ana@cliente.test')!.permissions, { '@type': 'Inherit' });
    assert.deepEqual(cuenta('ana@cliente.test')!.quotas, { maxDiskQuota: 2000 });
    const antes = motorFalso.llamadas.length;
    await motor.updateMailbox('ana@cliente.test', {});
    assert.equal(motorFalso.llamadas.length, antes);
    await assert.rejects(motor.updateMailbox('nadie@cliente.test', { suspended: true }), codigo('engine_not_found'));
  });

  test('borrar un buzón es idempotente; un id obsoleto en la caché se vuelve a buscar', async () => {
    await motor.createMailbox({ email: 'ana@cliente.test', passwordHash: '$6$uno$h' });
    const vieja = cuenta('ana@cliente.test')!;
    // Recreada por fuera con otro id.
    motorFalso.cuentas.delete(vieja.id);
    const { id, n } = motorFalso.nuevoId('c');
    motorFalso.cuentas.set(id, { ...vieja, id, n });
    await motor.updateMailbox('ana@cliente.test', { displayName: 'Nueva' });
    assert.equal(motorFalso.cuentas.get(id)!.description, 'Nueva');
    await motor.deleteMailbox('ana@cliente.test');
    assert.equal(motorFalso.cuentas.size, 0);
    await motor.deleteMailbox('ana@cliente.test');
    await motor.deleteMailbox('ana@no-existe.test');
  });

  test('contraseñas de aplicación: el secreto lo pone el motor y la referencia sirve para retirarla', async () => {
    await motor.createMailbox({ email: 'ana@cliente.test', passwordHash: '$6$uno$h' });
    const creada = await motor.addAppPassword('ana@cliente.test', '  ', 'propuesta');
    assert.match(creada.secret, /^app_/);
    assert.notEqual(creada.secret, 'propuesta');
    const ana = cuenta('ana@cliente.test')!;
    assert.equal(creada.ref, `${ana.id}:${ana.credentials[1]!.credentialId}`);
    const [, alta] = motorFalso.llamadas.find(([m]) => m === 'x:AppPassword/set')!;
    assert.equal(alta.accountId, ana.id);
    assert.equal(alta.create.k.description, 'Mailway');

    await motor.removeAppPassword('ana@cliente.test', creada.ref);
    assert.equal(ana.credentials.length, 1);
    await motor.removeAppPassword('ana@cliente.test', creada.ref);
  });

  test('retirar: referencias de 0.15, de otra cuenta o que ya son la principal no tocan nada', async () => {
    await motor.createMailbox({ email: 'ana@cliente.test', passwordHash: '$6$uno$h' });
    const ana = cuenta('ana@cliente.test')!;
    const antes = motorFalso.llamadas.length;
    await motor.removeAppPassword('ana@cliente.test', '$app$movil$6$abc$def');
    await motor.removeAppPassword('ana@cliente.test', `otra:${ana.credentials[0]!.credentialId}`);
    assert.ok(!motorFalso.metodos().slice(antes).includes('x:AppPassword/set'));
    // El id es ahora el de la principal (el motor reutiliza ids): forbidden → ya no existe.
    await motor.removeAppPassword('ana@cliente.test', `${ana.id}:${ana.credentials[0]!.credentialId}`);
    assert.deepEqual(ana.credentials.map((c) => c['@type']), ['Password']);
    await motor.removeAppPassword('nadie@cliente.test', `${ana.id}:b`);
  });

  test('sin cupo de contraseñas de aplicación: error que dice cómo arreglarlo', async () => {
    await motor.createMailbox({ email: 'ana@cliente.test', passwordHash: '$6$uno$h' });
    motorFalso.cargado.autenticacion.maxAppPasswords = 1;
    await motor.addAppPassword('ana@cliente.test', 'uno', 'x');
    await assert.rejects(motor.addAppPassword('ana@cliente.test', 'dos', 'x'), (err: HttpError) => {
      assert.equal(err.code, 'engine_error');
      assert.match(err.message, /ajustes recomendados/);
      return true;
    });
  });

  test('readMailboxCredentials: 0.16 no da los hashes', async () => {
    await motor.createMailbox({ email: 'ana@cliente.test', passwordHash: '$6$uno$h' });
    assert.equal(await motor.readMailboxCredentials('ana@cliente.test'), null);
  });
});

describe('alias', () => {
  let motor: Stalwart016Engine;
  beforeEach(async () => {
    motor = await nuevoMotor();
    await motor.createDomain('cliente.test');
  });

  const lista = () => [...motorFalso.listas.values()][0];

  test('alta y sustitución de destinos sin borrar el alias', async () => {
    await motor.upsertAlias('Ventas@cliente.test', ['Ana@cliente.test'], ['Fuera@Gmail.com']);
    assert.deepEqual(lista()!.recipients, { 'ana@cliente.test': true, 'fuera@gmail.com': true });
    assert.equal(lista()!.description, 'Alias gestionado por Mailway');
    await motor.upsertAlias('ventas@cliente.test', ['ana@cliente.test', 'beto@cliente.test']);
    assert.deepEqual(lista()!.recipients, { 'ana@cliente.test': true, 'beto@cliente.test': true });
    assert.equal(motorFalso.listas.size, 1);
    assert.ok(!motorFalso.llamadas.some(([m, a]) => m === 'x:MailingList/set' && a.destroy));
  });

  test('si la búsqueda no la encuentra, el duplicado dice cuál es y se actualiza esa', async () => {
    await motor.upsertAlias('ventas@cliente.test', ['ana@cliente.test']);
    motorFalso.textoCiego = true;
    const otro = crearMotor();
    await otro.upsertAlias('ventas@cliente.test', ['beto@cliente.test']);
    assert.equal(motorFalso.listas.size, 1);
    assert.deepEqual(lista()!.recipients, { 'beto@cliente.test': true });
  });

  test('un alias no puede ocupar la dirección de un buzón', async () => {
    await motor.createMailbox({ email: 'ana@cliente.test', passwordHash: '$6$s$h' });
    await assert.rejects(motor.upsertAlias('ana@cliente.test', ['x@y.test']), codigo('engine_exists'));
  });

  test('borrar: idempotente, y repasa todas las listas antes de darlo por inexistente', async () => {
    await motor.upsertAlias('ventas@cliente.test', ['ana@cliente.test']);
    motorFalso.textoCiego = true;
    const otro = crearMotor();
    await otro.deleteAlias('ventas@cliente.test');
    assert.equal(motorFalso.listas.size, 0);
    await otro.deleteAlias('ventas@cliente.test');
    await motor.deleteAlias('ventas@cliente.test');
  });
});

describe('consultas paginadas, uso y cola', () => {
  let motor: Stalwart016Engine;
  beforeEach(async () => {
    motor = await nuevoMotor();
    await motor.createDomain('cliente.test');
  });

  test('uso de los buzones y directorio con más de una página: cada uno una sola vez', async () => {
    const dominioId = [...motorFalso.dominios.values()].find((d) => d.name === 'cliente.test')!.id;
    for (let i = 0; i < 1203; i++) {
      const { id, n } = motorFalso.nuevoId('c');
      motorFalso.cuentas.set(id, {
        id,
        n,
        '@type': 'User',
        name: `u${i}`,
        domainId: dominioId,
        description: null,
        credentials: [],
        quotas: {},
        roles: {},
        permissions: {},
        aliases: {},
        usedDiskQuota: i,
      });
    }
    const { id, n } = motorFalso.nuevoId('c');
    motorFalso.cuentas.set(id, { ...[...motorFalso.cuentas.values()][0]!, id, n, '@type': 'Group', name: 'grupo' });
    await motor.upsertAlias('Ventas@cliente.test', ['u1@cliente.test']);

    // Control: con el orden por defecto, las páginas de Stalwart se solapan
    // (y faltan cuentas); por eso el driver ordena por id ascendente.
    const cliente = new ClienteJmap({ url: motorFalso.url, usuario: 'admin', clave: CLAVE });
    const paginas = await cliente.peticion([
      ['x:Account/query', { position: 0, limit: 500 }, 'p0'],
      ['x:Account/query', { position: 500, limit: 500 }, 'p1'],
    ]);
    const p0 = new Set(paginas.de<{ ids: string[] }>('p0').ids);
    assert.ok(paginas.de<{ ids: string[] }>('p1').ids.some((id) => p0.has(id)), 'el falso reproduce el solape');

    const uso = await motor.getMailboxUsage();
    assert.equal(uso.size, 1203);
    assert.equal(uso.get('u1202@cliente.test'), 1202);
    assert.ok(!uso.has('grupo@cliente.test'));

    const directorio = await motor.listDirectory();
    assert.equal(directorio.accounts.length, 1203);
    assert.equal(new Set(directorio.accounts).size, 1203);
    assert.ok(directorio.domains.includes('cliente.test'));
    assert.deepEqual(directorio.lists, ['ventas@cliente.test']);
  });

  test('cola: total y antigüedad del más antiguo (de la muestra por próximo intento)', async () => {
    assert.deepEqual(await motor.getQueueSummary(), { pending: 0, oldestSeconds: null });
    const grabado = COLA.methodResponses[1][1].list[0];
    const hace = (s: number) => new Date(Date.now() - s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    motorFalso.cola = [
      { ...grabado, id: 'q1', createdAt: hace(60), nextRetry: hace(-3600) },
      { ...grabado, id: 'q2', createdAt: hace(7200), nextRetry: hace(-60) },
    ];
    const resumen = await motor.getQueueSummary();
    assert.equal(resumen.pending, 2);
    assert.ok(Math.abs(resumen.oldestSeconds! - 7200) <= 2);
    const consulta = motorFalso.llamadas.filter(([m]) => m === 'x:QueuedMessage/query').pop()![1];
    assert.deepEqual(consulta.sort, [{ property: 'due', isAscending: true }]);
    assert.equal(consulta.calculateTotal, true);
  });
});

describe('ajustes recomendados y estado', () => {
  let motor: Stalwart016Engine;
  const HOST = 'mail.ejemplo.test';
  const REDES = ['10.203.53.0/24', '2001:db8::/48'];
  beforeEach(async () => {
    motor = await nuevoMotor();
  });

  test('estado de un motor recién puesto en marcha: nada aplicado', async () => {
    const estado = await motor.getSettingsStatus({ trustedNetworks: REDES });
    assert.equal(estado.api, 'jmap016');
    assert.equal(estado.forwardedHeaders, false);
    assert.deepEqual(estado.trustedNetworks, []);
    assert.equal(estado.acme, null);
    assert.equal(estado.certificateFiles, false);
    // Sin clientes con el correo web nuevo, el CORS cerrado no es una comprobación.
    assert.deepEqual(estado.extra, {
      submission587: false,
      maxAppPasswords: false,
      selfServiceBlocked: false,
      defaultDomain: false,
      logToStdout: false,
      authBanExpiry: false,
    });
    assert.deepEqual(estado.restartRequired, []);
  });

  test('aplicar: dominio reservado, ajustes, redes, 587, registro y autoservicio; después, nada que cambiar', async () => {
    const resultado = await motor.applyRecommended({ hostname: 'Mail.Ejemplo.Test', trustedNetworks: REDES, maxAppPasswords: 100, permissiveCors: false });
    assert.deepEqual(resultado.errors, []);
    assert.equal(resultado.restartRequired?.length, 1);
    assert.match(resultado.restartRequired![0]!, /587/);
    assert.equal(motorFalso.recargas, 1);

    const reservado = [...motorFalso.dominios.values()].find((d) => d.name === HOST)!;
    assert.equal(reservado.dkimManagement['@type'], 'Manual');
    assert.equal(motorFalso.sistema.defaultDomainId, reservado.id);
    assert.equal(motorFalso.sistema.defaultHostname, HOST);
    assert.equal(motorFalso.sistema.services.smtp.cleartext, true);
    assert.equal(motorFalso.http.useXForwarded, true);
    assert.equal(motorFalso.http.redirectRoot, null);
    assert.equal(motorFalso.autenticacion.maxAppPasswords, 100);
    assert.deepEqual(motorFalso.redes.map((r) => r.address), REDES);
    const escucha = motorFalso.escuchas.find((e) => e.bind['[::]:587']);
    assert.deepEqual(
      { protocol: escucha.protocol, useTls: escucha.useTls, tlsImplicit: escucha.tlsImplicit, name: escucha.name },
      { protocol: 'smtp', useTls: true, tlsImplicit: false, name: 'submission' },
    );
    assert.ok(motorFalso.trazadores.some((t) => t['@type'] === 'Stdout' && t.buffered === false));
    const rolUsuario = motorFalso.roles.find((r) => motorFalso.autenticacion.defaultUserRoleIds[r.id]);
    for (const p of ['sysAccountPasswordUpdate', 'sysAppPasswordCreate', 'sysAppPasswordDestroy', 'sysApiKeyCreate']) {
      assert.equal(rolUsuario.disabledPermissions[p], true, p);
    }
    // El bloqueo por fallos de acceso caduca a la hora; sin correo web nuevo, sin CORS.
    assert.equal(motorFalso.seguridad.authBanPeriod, 3_600_000);
    assert.equal(motorFalso.http.usePermissiveCors, false);

    // Idempotente: la segunda vez solo recarga.
    const antes = motorFalso.llamadas.length;
    const segunda = await motor.applyRecommended({ hostname: HOST, trustedNetworks: REDES, maxAppPasswords: 100, permissiveCors: false });
    assert.deepEqual(segunda.errors, []);
    const sets = motorFalso.metodos().slice(antes).filter((m) => m.endsWith('/set'));
    assert.deepEqual(sets, ['x:Action/set']);

    const estado = await motor.getSettingsStatus({ trustedNetworks: [...REDES, '192.0.2.0/24'] });
    assert.equal(estado.hostname, HOST);
    assert.equal(estado.forwardedHeaders, true);
    assert.deepEqual(estado.trustedNetworks, REDES);
    assert.deepEqual(estado.extra, {
      submission587: true,
      maxAppPasswords: true,
      selfServiceBlocked: true,
      defaultDomain: true,
      logToStdout: true,
      authBanExpiry: true,
    });
    assert.equal(estado.restartRequired.length, 1);

    // Tras reiniciar el contenedor, el aviso desaparece.
    motorFalso.reiniciar();
    assert.deepEqual((await motor.getSettingsStatus({ trustedNetworks: REDES })).restartRequired, []);
    assert.deepEqual((await motor.applyRecommended({ hostname: HOST, trustedNetworks: REDES, maxAppPasswords: 100, permissiveCors: false })).restartRequired, []);
  });

  test('el aviso del 587 lo ve otro driver con el mismo almacén: el panel tras reiniciarse, o tras la herramienta de migración', async () => {
    const almacen = almacenReiniciosEnMemoria();
    const herramienta = new Stalwart016Engine(ajustes(), { tiempos: RAPIDOS, reinicios: almacen });
    const aplicado = await herramienta.applyRecommended({ hostname: HOST, trustedNetworks: REDES, maxAppPasswords: 100, permissiveCors: false });
    assert.equal(aplicado.restartRequired?.length, 1);

    const panel = new Stalwart016Engine(ajustes(), { tiempos: RAPIDOS, reinicios: almacen });
    const estado = await panel.getSettingsStatus({ trustedNetworks: REDES });
    assert.deepEqual(estado.restartRequired, aplicado.restartRequired, 'la escucha está guardada, pero aún no abierta');

    // Un aviso que esta versión del panel no conoce no se muestra.
    almacen.guardar({ ...almacen.leer(), 'aviso-de-otra-version': { marca: null, guardadoEn: Date.now() } });
    assert.deepEqual((await panel.getSettingsStatus({ trustedNetworks: REDES })).restartRequired, aplicado.restartRequired);

    motorFalso.reiniciar();
    assert.deepEqual((await panel.getSettingsStatus({ trustedNetworks: REDES })).restartRequired, []);
    assert.deepEqual(almacen.leer(), {}, 'tras reiniciar el motor no queda nada guardado');
  });

  test('sin la marca de arranque al guardarlo, el aviso se va cuando el motor arranca después', async () => {
    const almacen = almacenReiniciosEnMemoria();
    const panel = new Stalwart016Engine(ajustes(), { tiempos: RAPIDOS, reinicios: almacen });
    // El motor no deja leer sus nodos justo entonces.
    const nodos = motorFalso.nodos;
    motorFalso.nodos = [];
    const aplicado = await panel.applyRecommended({ hostname: HOST, trustedNetworks: REDES, maxAppPasswords: 100 });
    assert.equal(aplicado.restartRequired?.length, 1);
    assert.equal(almacen.leer().submission587?.marca, null);
    motorFalso.nodos = nodos;

    // Ya se leen, pero el motor arrancó antes de guardarlo: sigue pendiente.
    assert.equal((await panel.getSettingsStatus({ trustedNetworks: REDES })).restartRequired.length, 1);
    motorFalso.reiniciar();
    assert.deepEqual((await panel.getSettingsStatus({ trustedNetworks: REDES })).restartRequired, []);
    assert.deepEqual(almacen.leer(), {});
  });

  test('almacenReiniciosEnBase: los avisos van a la base de datos del panel', () => {
    const aviso = { marca: '1@2026-10-09T10:00:00Z', guardadoEn: 1_791_000_000_000 };
    almacenReiniciosEnBase.guardar({ submission587: aviso });
    assert.deepEqual(almacenReiniciosEnBase.leer(), { submission587: aviso });
    // Lo que no tiene la forma esperada no rompe nada.
    setJsonSetting(AJUSTE_REINICIOS, ['no', 'es', 'un', 'objeto']);
    assert.deepEqual(almacenReiniciosEnBase.leer(), {});
    setJsonSetting(AJUSTE_REINICIOS, { submission587: 7, otro: { marca: 3, guardadoEn: 'ayer' } });
    assert.deepEqual(almacenReiniciosEnBase.leer(), {
      submission587: { marca: null, guardadoEn: 0 },
      otro: { marca: null, guardadoEn: 0 },
    });
    almacenReiniciosEnBase.guardar({});
    assert.equal(getSetting(AJUSTE_REINICIOS), null);
  });

  test('redes: una más amplia ya dada de alta vale; una mal escrita es un error y el resto se aplica', async () => {
    motorFalso.redes.push({ address: '10.0.0.0/8', id: 'previa' }, { address: '2001:db8::/32', id: 'previa6' });
    const resultado = await motor.applyRecommended({
      hostname: HOST,
      trustedNetworks: ['10.203.53.0/24', '2001:db8:1::/48', 'no-es-una-red', '192.0.2.7'],
      maxAppPasswords: 100,
      permissiveCors: false,
    });
    assert.equal(resultado.errors.length, 1);
    assert.match(resultado.errors[0]!, /no-es-una-red/);
    assert.deepEqual(motorFalso.redes.map((r) => r.address), ['10.0.0.0/8', '2001:db8::/32', '192.0.2.7']);
    assert.equal(motorFalso.http.useXForwarded, true);
    const estado = await motor.getSettingsStatus({ trustedNetworks: ['10.203.53.0/24', '192.0.2.7/32', '172.16.0.0/12'] });
    assert.deepEqual(estado.trustedNetworks, ['10.203.53.0/24', '192.0.2.7/32']);
  });

  test('un nombre de servidor no válido no toca nada', async () => {
    await assert.rejects(
      motor.applyRecommended({ hostname: 'no es un nombre', trustedNetworks: [], maxAppPasswords: 100, permissiveCors: false }),
      (err: HttpError) => err.status === 400 && err.code === 'invalid_hostname',
    );
    assert.ok(!motorFalso.metodos().some((m) => m.endsWith('/set')));
  });

  test('CORS del correo web nuevo: se abre cuando hace falta, se cierra cuando sobra y el estado lo compara', async () => {
    await motor.applyRecommended({ hostname: HOST, trustedNetworks: [], maxAppPasswords: 100, permissiveCors: true });
    assert.equal(motorFalso.http.usePermissiveCors, true);
    // Sin indicar qué se quiere, el estado compara con lo último pedido.
    assert.equal((await motor.getSettingsStatus({ trustedNetworks: [] })).extra.permissiveCors, true);
    assert.equal((await motor.getSettingsStatus({ trustedNetworks: [], permissiveCors: true })).extra.permissiveCors, true);
    // Abierto sin que nadie lo necesite: pendiente de cerrar.
    assert.equal((await motor.getSettingsStatus({ trustedNetworks: [], permissiveCors: false })).extra.permissiveCors, false);

    // Otra vez lo mismo: solo la recarga, nada se escribe.
    const antes = motorFalso.llamadas.length;
    await motor.applyRecommended({ hostname: HOST, trustedNetworks: [], maxAppPasswords: 100, permissiveCors: true });
    assert.deepEqual(motorFalso.metodos().slice(antes).filter((m) => m.endsWith('/set')), ['x:Action/set']);

    await motor.applyRecommended({ hostname: HOST, trustedNetworks: [], maxAppPasswords: 100, permissiveCors: false });
    assert.equal(motorFalso.http.usePermissiveCors, false);
    const cerrado = await motor.getSettingsStatus({ trustedNetworks: [] });
    assert.equal('permissiveCors' in cerrado.extra, false, 'cerrado y sin necesitarlo, no hay nada que enseñar');
    // Hace falta y está cerrado: pendiente de abrir.
    assert.equal((await motor.getSettingsStatus({ trustedNetworks: [], permissiveCors: true })).extra.permissiveCors, false);
  });

  test('caducidad del bloqueo: para siempre o más de una hora se corrige; una más corta se respeta', async () => {
    for (const [inicial, esperado, aplicado] of [
      [null, 3_600_000, false],
      [0, 3_600_000, false],
      [86_400_000, 3_600_000, false],
      [600_000, 600_000, true],
      [3_600_000, 3_600_000, true],
    ] as [number | null, number, boolean][]) {
      motorFalso.seguridad.authBanPeriod = inicial;
      assert.equal((await motor.getSettingsStatus({ trustedNetworks: [] })).extra.authBanExpiry, aplicado, String(inicial));
      const antes = motorFalso.llamadas.length;
      await motor.applyRecommended({ hostname: HOST, trustedNetworks: [], maxAppPasswords: 100, permissiveCors: false });
      assert.equal(motorFalso.seguridad.authBanPeriod, esperado, String(inicial));
      const escribio = motorFalso.llamadas.slice(antes).some(([m]) => m === 'x:Security/set');
      assert.equal(escribio, !aplicado, `${inicial}: solo se escribe si hay que corregirlo`);
      assert.equal((await motor.getSettingsStatus({ trustedNetworks: [] })).extra.authBanExpiry, true);
    }
  });

  test('límite de contraseñas de aplicación: no lo baja si ya es mayor; el estado compara con lo pedido', async () => {
    motorFalso.autenticacion.maxAppPasswords = 500;
    await motor.applyRecommended({ hostname: HOST, trustedNetworks: [], maxAppPasswords: 100, permissiveCors: false });
    assert.equal(motorFalso.autenticacion.maxAppPasswords, 500);
    motorFalso.autenticacion.maxAppPasswords = 50;
    assert.equal((await motor.getSettingsStatus({ trustedNetworks: [] })).extra.maxAppPasswords, false);
  });

  test('si el dominio del servidor ya existe (de un cliente o de antes), se usa ese', async () => {
    await motor.createDomain(HOST);
    const existente = [...motorFalso.dominios.values()].find((d) => d.name === HOST)!;
    await motor.applyRecommended({ hostname: HOST, trustedNetworks: [], maxAppPasswords: 100, permissiveCors: false });
    assert.equal(motorFalso.sistema.defaultDomainId, existente.id);
    assert.equal([...motorFalso.dominios.values()].filter((d) => d.name === HOST).length, 1);
  });

  test('un fallo de la recarga vuelve en errors', async () => {
    const original = motorFalso.setAction.bind(motorFalso);
    motorFalso.setAction = () => ({
      notCreated: { r: { type: 'validationFailed', validationErrors: [{ type: 'Invalid', property: 'defaultHostname' }] } },
    });
    const resultado = await motor.applyRecommended({ hostname: HOST, trustedNetworks: [], maxAppPasswords: 100, permissiveCors: false });
    assert.equal(resultado.errors.length, 1);
    assert.match(resultado.errors[0]!, /recarga de la configuración.*validationFailed.*defaultHostname/);
    motorFalso.setAction = original;
  });

  test('certificados, ACME y certificado por fichero', async () => {
    await motor.reloadCertificates();
    assert.equal(motorFalso.llamadas.pop()![1].create.r['@type'], 'ReloadTlsCertificates');
    await assert.rejects(
      motor.configureAcme({ directory: 'https://acme.test/dir', token: 't', contact: 'a@b.test', hostname: HOST, zone: 'b.test' }),
      (err: HttpError) => err.status === 409 && err.code === 'engine_unsupported' && /Traefik/.test(err.message),
    );
    motorFalso.certificados.push({ id: 'cert1', certificate: { '@type': 'File', filePath: '/certs/cert.pem' } });
    motorFalso.sistema.defaultCertificateId = 'cert1';
    motorFalso.proveedores.push({ id: 'p1', directory: 'https://acme.test/dir', challengeType: 'Dns01', contact: { 'a@b.test': true } });
    const estado = await motor.getSettingsStatus({ trustedNetworks: [] });
    assert.equal(estado.certificateFiles, true);
    assert.deepEqual(estado.acme, {
      directory: 'https://acme.test/dir',
      challenge: 'dns-01',
      provider: null,
      contact: 'a@b.test',
      domain: null,
      zone: null,
    });
  });
});

/* ------------------------------ Cambio de dominio ------------------------------ */

describe('cambio de dominio (contrato de 0.15 sobre las cuentas y listas de 0.16)', () => {
  let motor: Stalwart016Engine;
  const id = (dominio: string) => [...motorFalso.dominios.values()].find((d) => d.name === dominio)!.id;
  const cuenta = (email: string) =>
    [...motorFalso.cuentas.values()].find((c) => `${c.name}@${motorFalso.dominios.get(c.domainId)!.name}` === email);
  const lista = (email: string) =>
    [...motorFalso.listas.values()].find((l) => `${l.name}@${motorFalso.dominios.get(l.domainId)!.name}` === email);
  const sets = (objeto: string) => motorFalso.llamadas.filter(([m]) => m === `x:${objeto}/set`).map(([, a]) => a);

  beforeEach(async () => {
    motor = await nuevoMotor();
    await motor.createDomain('viejo.test');
    await motor.createDomain('nuevo.test');
    await motor.createMailbox({ email: 'ana@viejo.test', passwordHash: '$6$sal$hash' });
    await motor.addAppPassword('ana@viejo.test', 'movil', 'x');
    await motor.upsertAlias('info@viejo.test', ['ana@viejo.test'], ['fuera@otro.test']);
    motorFalso.llamadas = [];
  });

  test('getPrincipal: la dirección de la cuenta es su nombre y los alias activos van después', async () => {
    assert.deepEqual(await motor.getPrincipal('ANA@viejo.test'), {
      id: cuenta('ana@viejo.test')!.id,
      type: 'individual',
      name: 'ana@viejo.test',
      emails: ['ana@viejo.test'],
    });
    assert.deepEqual((await motor.getPrincipal('info@viejo.test'))?.type, 'list');
    assert.equal(await motor.getPrincipal('nadie@viejo.test'), null);
    // Una dirección que solo es alias no es el nombre de nadie (como en 0.15).
    await motor.setAddresses('ana@viejo.test', { add: ['ana@nuevo.test'] });
    assert.equal(await motor.getPrincipal('ana@nuevo.test'), null);
  });

  test('setAddresses: añade alias por id de dominio, idempotente, y no escribe nada si falla', async () => {
    assert.deepEqual(await motor.setAddresses('ana@viejo.test', { add: ['Ana@Nuevo.test'] }), [
      'ana@viejo.test',
      'ana@nuevo.test',
    ]);
    assert.deepEqual(cuenta('ana@viejo.test')!.aliases, { '0': { enabled: true, name: 'ana', domainId: id('nuevo.test') } });
    // La principal no se mueve: es el nombre de la cuenta (y sus dispositivos entran con él).
    assert.deepEqual(await motor.setAddresses('ana@viejo.test', { primary: 'ana@nuevo.test' }), [
      'ana@viejo.test',
      'ana@nuevo.test',
    ]);
    motorFalso.llamadas = [];
    assert.deepEqual(await motor.setAddresses('ana@viejo.test', { add: ['ana@nuevo.test'] }), [
      'ana@viejo.test',
      'ana@nuevo.test',
    ]);
    assert.deepEqual(sets('Account'), [], 'sin cambios no escribe');

    await assert.rejects(
      motor.setAddresses('ana@viejo.test', { add: ['ana@otro.test'] }),
      (err: HttpError) => err.code === 'engine_not_found' && /otro\.test/.test(err.message),
    );
    await assert.rejects(motor.setAddresses('nadie@viejo.test', { add: ['x@nuevo.test'] }), codigo('engine_not_found'));
    await assert.rejects(motor.setAddresses('ana@viejo.test', { remove: ['ana@viejo.test'] }), codigo('engine_error'));
    assert.deepEqual(sets('Account'), [], 'los errores no escriben nada');
    // Las listas también tienen alias.
    assert.deepEqual(await motor.setAddresses('info@viejo.test', { add: ['info@nuevo.test'] }), [
      'info@viejo.test',
      'info@nuevo.test',
    ]);
    assert.deepEqual(lista('info@viejo.test')!.aliases, { '0': { enabled: true, name: 'info', domainId: id('nuevo.test') } });
  });

  test('setAddresses conserva los alias desactivados y redirige las listas que apuntaban a lo que se quita', async () => {
    cuenta('ana@viejo.test')!.aliases = {
      '0': { enabled: false, name: 'antigua', domainId: id('viejo.test') },
      '1': { enabled: true, name: 'ana', domainId: id('nuevo.test') },
    };
    await motor.upsertAlias('equipo@viejo.test', ['ana@nuevo.test', 'luis@viejo.test']);
    assert.deepEqual(await motor.getPrincipal('ana@viejo.test').then((p) => p?.emails), ['ana@viejo.test', 'ana@nuevo.test']);

    await motor.setAddresses('ana@viejo.test', { remove: ['ana@nuevo.test'] });
    assert.deepEqual(cuenta('ana@viejo.test')!.aliases, {
      '0': { enabled: false, name: 'antigua', domainId: id('viejo.test') },
    });
    // La dirección que se quita deja de existir: la lista entrega a la cuenta por su dirección.
    assert.deepEqual(lista('equipo@viejo.test')!.recipients, { 'ana@viejo.test': true, 'luis@viejo.test': true });
    assert.deepEqual(lista('info@viejo.test')!.recipients, { 'ana@viejo.test': true, 'fuera@otro.test': true }, 'otra lista no se toca');
  });

  test('renamePrincipal: nombre, dominio y alias en una sola escritura; conserva id, credenciales y destinos', async () => {
    const antes = cuenta('ana@viejo.test')!;
    await motor.setAddresses('ana@viejo.test', { add: ['ana@nuevo.test'] });
    motorFalso.llamadas = [];

    await motor.renamePrincipal('ana@viejo.test', 'ana@nuevo.test', { expectEmail: 'ana@nuevo.test' });
    assert.deepEqual(sets('Account'), [
      {
        update: {
          [antes.id]: {
            name: 'ana',
            domainId: id('nuevo.test'),
            aliases: { '0': { enabled: true, name: 'ana', domainId: id('viejo.test') } },
          },
        },
      },
    ]);
    const despues = cuenta('ana@nuevo.test')!;
    assert.equal(despues.id, antes.id, 'el id (y con él el correo) no cambia');
    assert.deepEqual(despues.credentials.map((c) => c['@type']), ['Password', 'AppPassword']);
    // La dirección anterior sigue siendo suya (alias): la lista sigue entregando.
    assert.deepEqual(await motor.getPrincipal('ana@nuevo.test').then((p) => p?.emails), ['ana@nuevo.test', 'ana@viejo.test']);
    assert.equal(await motor.getPrincipal('ana@viejo.test'), null);
    assert.deepEqual(lista('info@viejo.test')!.recipients, { 'ana@viejo.test': true, 'fuera@otro.test': true });
    // Las operaciones por usuario ya van con el nombre nuevo (la caché se actualizó).
    await motor.setMailboxPassword('ana@nuevo.test', '$6$otra$hash');
    assert.equal(cuenta('ana@nuevo.test')!.credentials[0]!.secret, '$6$otra$hash');

    // Reintento de un renombrado ya hecho: nada que hacer.
    motorFalso.llamadas = [];
    await motor.renamePrincipal('ana@viejo.test', 'ana@nuevo.test', { expectEmail: 'ana@nuevo.test' });
    assert.deepEqual(sets('Account'), []);
    // Otro principal con ese nombre, o ninguno de los dos.
    await assert.rejects(
      motor.renamePrincipal('ana@viejo.test', 'ana@nuevo.test', { expectEmail: 'otra@nuevo.test' }),
      (err: HttpError) => {
        assert.equal(err.code, 'engine_exists');
        assert.equal(err.message, 'El servidor de correo ya tiene otro buzón o alias con el nombre «ana@nuevo.test».');
        return true;
      },
    );
    await assert.rejects(
      motor.renamePrincipal('luis@viejo.test', 'luis@nuevo.test', { expectEmail: 'luis@nuevo.test' }),
      codigo('engine_not_found'),
    );
  });

  test('renamePrincipal de una lista con sus direcciones, y la baja redirige sus destinos', async () => {
    await motor.setAddresses('info@viejo.test', { add: ['info@nuevo.test'] });
    await motor.upsertAlias('todos@viejo.test', ['info@viejo.test']);
    await motor.renamePrincipal('info@viejo.test', 'info@nuevo.test', {
      expectEmail: 'info@viejo.test',
      emails: ['info@nuevo.test', 'info@viejo.test'],
    });
    const info = lista('info@nuevo.test')!;
    assert.deepEqual(info.recipients, { 'ana@viejo.test': true, 'fuera@otro.test': true });
    assert.deepEqual(await motor.getPrincipal('info@nuevo.test').then((p) => p?.emails), ['info@nuevo.test', 'info@viejo.test']);
    // Baja del dominio viejo: se quita la dirección y quien apuntaba a ella pasa a la nueva.
    await motor.setAddresses('info@nuevo.test', { remove: ['info@viejo.test'] });
    assert.deepEqual(info.aliases, {});
    assert.deepEqual(lista('todos@viejo.test')!.recipients, { 'info@nuevo.test': true });
    // Ocupado: el nombre de destino es de otro.
    await motor.createMailbox({ email: 'ventas@nuevo.test', passwordHash: '$6$s$h' });
    await motor.upsertAlias('ventas@viejo.test', ['ana@viejo.test']);
    await assert.rejects(
      motor.renamePrincipal('ventas@viejo.test', 'ventas@nuevo.test', { expectEmail: 'ventas@viejo.test' }),
      codigo('engine_exists'),
    );
  });

  test('una cuenta con el nombre ocupado en el destino: el motor se niega y nada cambia', async () => {
    await motor.createMailbox({ email: 'ana@nuevo.test', passwordHash: '$6$s$h' });
    // Otro proceso del panel sin la caché del destino.
    const otro = crearMotor();
    await assert.rejects(
      otro.renamePrincipal('ana@viejo.test', 'ana@nuevo.test', { expectEmail: 'ana@viejo.test' }),
      codigo('engine_exists'),
    );
    assert.ok(cuenta('ana@viejo.test'));
  });

  test('createMailbox no adopta una cuenta con alias (el usuario anterior de otro buzón)', async () => {
    await motor.setAddresses('ana@viejo.test', { add: ['ana@nuevo.test'] });
    const otro = crearMotor();
    await assert.rejects(otro.createMailbox({ email: 'ana@viejo.test', passwordHash: '$6$nueva$h' }), codigo('engine_exists'));
    assert.equal(cuenta('ana@viejo.test')!.credentials[0]!.secret, '$6$sal$hash', 'su contraseña no cambia');
  });

  test('removeDkim: pasa el dominio a manual y borra solo sus firmas; idempotente', async () => {
    await motor.createDomain('viejo.test.ejemplo');
    for (const d of ['viejo.test', 'viejo.test.ejemplo', 'nuevo.test']) await motor.ensureDkim(d, '');
    const firmasDe = (d: string) => [...motorFalso.firmas.values()].filter((f) => f.domainId === id(d)).map((f) => f.id);
    const borrar = firmasDe('viejo.test').sort();
    assert.equal(borrar.length, 2);

    assert.deepEqual(await motor.removeDkim('viejo.test'), borrar);
    assert.deepEqual(firmasDe('viejo.test'), []);
    assert.equal(firmasDe('viejo.test.ejemplo').length, 2, 'la trampa del prefijo');
    assert.equal(firmasDe('nuevo.test').length, 2);
    assert.equal(motorFalso.dominios.get(id('viejo.test'))!.dkimManagement['@type'], 'Manual', 'la tarea DKIM no las vuelve a crear');
    assert.deepEqual(await motor.removeDkim('viejo.test'), []);
    assert.deepEqual(await motor.removeDkim('no-existe.test'), []);
  });

  test('sin recarga del directorio, sin reglas de recepción externa y sin token de ACME propio', async () => {
    await motor.reloadDirectory();
    assert.deepEqual(motorFalso.llamadas, [], 'recargar no hace ninguna petición');
    const r = await motor.syncRemoteDomains(['fuera.test']);
    assert.equal(r.unsupported, true);
    assert.equal(r.changed, false);
    assert.equal(await motor.getAcmeToken(), null);
  });
});
