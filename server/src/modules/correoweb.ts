import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { db, now } from '../core/db';
import { badRequest, conflict, HttpError, notFound, upstream } from '../core/errors';
import { dimensionesImagen, tipoDeImagen, type TipoImagen } from '../core/imagenes';
import { withLock } from '../core/locks';
import { apiDelMotor, engineConfigured, getEngine } from '../engine';
import type { EngineApi, MailEngine } from '../engine/types';
import { fireAlert, resolveAlert } from './alerts';
import { audit, auditSystem } from './audit';
import { requireAdmin, requireClientAccess } from './auth';
import {
  asegurarRecursosBulwark,
  ClienteAdminBulwark,
  ErrorBulwark,
  huellaBulwark,
  marcaPorHostBulwark,
  necesitaSincronizarBulwark,
  nombreRecursoBulwark,
  politicaBulwark,
  recursoMarcaBulwark,
  sincronizarBulwark,
  type EntradaMarcaBulwark,
  type HuecoRecursoBulwark,
  type PoliticaBulwark,
  type WebmailConMarca,
} from './bulwark';
import { applyRecommendedEngineSettings, trustedEngineNetworks } from './engineops';
import { exigirSinMantenimiento } from './mantenimiento';
import { getInstanceSettings, getJsonSetting, setJsonSetting } from './settings';
import {
  bulwarkDisponible,
  bulwarkEnServicio,
  clientesConBulwarkEnServicio,
  corsPermisivoNecesario,
  estadoBulwark,
  motorCorreoWebDe,
  motorCorreoWebEnServicio,
} from './webmailmotor';

/*
 * Correo web de cada cliente: la elección entre Roundcube y el correo web
 * nuevo (Bulwark, beta), la marca de cada cliente para él y su
 * sincronización con la API de administración de Bulwark.
 *
 * - Elegir el correo web es cosa de la administración. El nuevo exige Bulwark
 *   instalado y Stalwart 0.16, y el primer cliente que lo elige abre el CORS
 *   del motor (sin él, el navegador no puede hablar JMAP con el motor). Volver
 *   a Roundcube siempre se puede; el último que vuelve lo cierra.
 * - La marca la edita quien gestiona los dominios propios del cliente (la
 *   administración y los usuarios del propio cliente, como en whitelabel.ts).
 * - La sincronización no bloquea ninguna ruta: se programa en segundo plano
 *   y, si falla, la reintenta el vigilante con espera creciente (y la que pida
 *   Bulwark si limita los inicios de sesión). Usa un solo cliente de la API
 *   para todo el proceso: cada inicio de sesión, también los buenos, cuenta
 *   para el límite de Bulwark (5 cada 15 minutos).
 */

/* --------------------------------- Marca ---------------------------------- */

export const HUECOS_IMAGEN = ['logoClaro', 'logoOscuro', 'favicon', 'icono'] as const;
export type HuecoImagen = (typeof HUECOS_IMAGEN)[number];

/** Dónde va cada imagen en la marca de Bulwark (y con qué nombre se sube). */
const HUECO_BULWARK: Record<HuecoImagen, HuecoRecursoBulwark> = {
  logoClaro: 'appLogoLightUrl',
  logoOscuro: 'appLogoDarkUrl',
  favicon: 'faviconUrl',
  icono: 'pwaIconUrl',
};

/** Un logotipo o un icono caben de sobra; Bulwark admite hasta 2 MB. */
export const MAX_IMAGEN_MARCA_BYTES = 512 * 1024;
const LADO_MINIMO = 16;
/** Más grande no se ve mejor y su decodificación (el icono la hace Bulwark) cuesta memoria. */
const LADO_MAXIMO = 4096;

export interface ImagenMarca {
  tipo: TipoImagen;
  bytes: number;
  ancho: number;
  alto: number;
  actualizada: number;
  /** Para verla en el panel (con la sesión); cambia con cada versión. */
  url: string;
}

export interface MarcaCorreoWeb {
  nombre: string;
  nombreCorto: string;
  empresa: string;
  privacidadUrl: string;
  avisoLegalUrl: string;
  /** El nombre que se usa si `nombre` está vacío: el del cliente. */
  nombrePorDefecto: string;
  actualizada: number | null;
  imagenes: Record<HuecoImagen, ImagenMarca | null>;
}

interface FilaMarca {
  nombre: string;
  nombre_corto: string;
  empresa: string;
  privacidad_url: string;
  aviso_legal_url: string;
  updated_at: number;
}

interface FilaImagen {
  client_id: string;
  hueco: HuecoImagen;
  mime: TipoImagen;
  sha256: string;
  ancho: number;
  alto: number;
  bytes: number;
  updated_at: number;
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_NOMBRE = 60;

/**
 * El nombre del cliente, apto como nombre del correo web: sin caracteres de
 * control y con 60 unidades como mucho (las que cuenta Bulwark), sin partir
 * un carácter compuesto por la mitad.
 */
function nombreDeCliente(nombre: string): string {
  let salida = '';
  for (const caracter of nombre.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()) {
    if (salida.length + caracter.length > MAX_NOMBRE) break;
    salida += caracter;
  }
  return salida.trim();
}

function filaCliente(clientId: string): { id: string; name: string } {
  const row = db.prepare('SELECT id, name FROM clients WHERE id = ?').get(clientId) as
    | { id: string; name: string }
    | undefined;
  if (!row) throw notFound('Cliente no encontrado.');
  return row;
}

function urlImagen(clientId: string, hueco: HuecoImagen, actualizada: number): string {
  return `/api/clients/${encodeURIComponent(clientId)}/webmail/marca/imagenes/${hueco}?v=${actualizada}`;
}

export function leerMarca(clientId: string): MarcaCorreoWeb {
  const cliente = filaCliente(clientId);
  const fila = db
    .prepare(
      'SELECT nombre, nombre_corto, empresa, privacidad_url, aviso_legal_url, updated_at FROM webmail_marca WHERE client_id = ?',
    )
    .get(clientId) as FilaMarca | undefined;
  const imagenes = Object.fromEntries(HUECOS_IMAGEN.map((h) => [h, null])) as Record<HuecoImagen, ImagenMarca | null>;
  const filas = db
    .prepare(
      `SELECT client_id, hueco, mime, sha256, ancho, alto, length(data) AS bytes, updated_at
       FROM webmail_marca_imagenes WHERE client_id = ?`,
    )
    .all(clientId) as FilaImagen[];
  for (const f of filas) {
    imagenes[f.hueco] = {
      tipo: f.mime,
      bytes: f.bytes,
      ancho: f.ancho,
      alto: f.alto,
      actualizada: f.updated_at,
      url: urlImagen(clientId, f.hueco, f.updated_at),
    };
  }
  return {
    nombre: fila?.nombre ?? '',
    nombreCorto: fila?.nombre_corto ?? '',
    empresa: fila?.empresa ?? '',
    privacidadUrl: fila?.privacidad_url ?? '',
    avisoLegalUrl: fila?.aviso_legal_url ?? '',
    nombrePorDefecto: nombreDeCliente(cliente.name),
    actualizada: fila?.updated_at ?? null,
    imagenes,
  };
}

function esHttpsSinCredenciales(valor: string): boolean {
  try {
    const url = new URL(valor);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Las mismas reglas que marcaPorHostBulwark: lo que se guarda siempre se puede publicar. */
function textoMarca(max: number, que: string) {
  return z
    .string({ invalid_type_error: `${que} debe ser un texto.` })
    .trim()
    .max(max, `${que} no puede superar los ${max} caracteres.`)
    .refine((v) => !CONTROL_RE.test(v), `${que} no puede contener caracteres de control.`);
}

function enlaceMarca(que: string) {
  return z
    .string({ invalid_type_error: `${que} debe ser un texto.` })
    .trim()
    .max(2048, `${que} es demasiado larga.`)
    .refine((v) => v === '' || esHttpsSinCredenciales(v), `${que} debe ser una dirección que empiece por https://, sin usuario ni contraseña.`);
}

const marcaSchema = z.object({
  nombre: textoMarca(MAX_NOMBRE, 'El nombre del correo web').optional(),
  nombreCorto: textoMarca(30, 'El nombre corto').optional(),
  empresa: textoMarca(80, 'La empresa').optional(),
  privacidadUrl: enlaceMarca('La política de privacidad').optional(),
  avisoLegalUrl: enlaceMarca('El aviso legal').optional(),
});

const CAMPOS_MARCA: Record<keyof z.infer<typeof marcaSchema>, keyof FilaMarca> = {
  nombre: 'nombre',
  nombreCorto: 'nombre_corto',
  empresa: 'empresa',
  privacidadUrl: 'privacidad_url',
  avisoLegalUrl: 'aviso_legal_url',
};

/** Guarda los campos indicados (los demás no cambian) y devuelve los que han cambiado. */
export function guardarMarca(clientId: string, cambios: z.infer<typeof marcaSchema>): string[] {
  const actual = leerMarca(clientId);
  const nuevos = {
    nombre: cambios.nombre ?? actual.nombre,
    nombreCorto: cambios.nombreCorto ?? actual.nombreCorto,
    empresa: cambios.empresa ?? actual.empresa,
    privacidadUrl: cambios.privacidadUrl ?? actual.privacidadUrl,
    avisoLegalUrl: cambios.avisoLegalUrl ?? actual.avisoLegalUrl,
  };
  const cambiados = (Object.keys(CAMPOS_MARCA) as (keyof typeof CAMPOS_MARCA)[]).filter((k) => nuevos[k] !== actual[k]);
  if (cambiados.length === 0) return [];
  db.prepare(
    `INSERT INTO webmail_marca (client_id, nombre, nombre_corto, empresa, privacidad_url, aviso_legal_url, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET nombre = excluded.nombre, nombre_corto = excluded.nombre_corto,
       empresa = excluded.empresa, privacidad_url = excluded.privacidad_url,
       aviso_legal_url = excluded.aviso_legal_url, updated_at = excluded.updated_at`,
  ).run(clientId, nuevos.nombre, nuevos.nombreCorto, nuevos.empresa, nuevos.privacidadUrl, nuevos.avisoLegalUrl, now());
  return cambiados;
}

function imagenNoValida(): HttpError {
  return badRequest(
    'La imagen debe ser PNG, JPEG o WebP. Los SVG no se admiten: en el correo web serían código, no una imagen.',
    'invalid_image',
  );
}

/**
 * Decodifica y valida una imagen de marca (data URL en base64). El tipo y el
 * tamaño salen de los bytes, no de lo que se declara ni de la extensión.
 */
export function decodificarImagenMarca(dataUrl: string): { tipo: TipoImagen; datos: Buffer; ancho: number; alto: number } {
  const match = /^data:[a-z0-9.+/-]*;base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(dataUrl.trim());
  if (!match) throw imagenNoValida();
  const datos = Buffer.from(match[1]!, 'base64');
  if (datos.length === 0) throw imagenNoValida();
  if (datos.length > MAX_IMAGEN_MARCA_BYTES) {
    throw badRequest('La imagen ocupa demasiado: el máximo es de 512 KB.', 'image_too_large');
  }
  const tipo = tipoDeImagen(datos);
  if (!tipo) throw imagenNoValida();
  const dimensiones = dimensionesImagen(datos, tipo);
  if (!dimensiones) throw imagenNoValida();
  const { ancho, alto } = dimensiones;
  if (ancho < LADO_MINIMO || alto < LADO_MINIMO || ancho > LADO_MAXIMO || alto > LADO_MAXIMO) {
    throw badRequest(
      `La imagen mide ${ancho} × ${alto} píxeles: cada lado debe medir entre ${LADO_MINIMO} y ${LADO_MAXIMO} píxeles.`,
      'image_dimensions',
    );
  }
  return { tipo, datos, ancho, alto };
}

const imagenSchema = z.object({
  // Holgado a propósito: el tamaño real se comprueba al decodificar
  // (image_too_large); esto solo corta cuerpos absurdos antes de hacerlo.
  imagen: z
    .string({ required_error: 'Falta la imagen.', invalid_type_error: 'La imagen debe ir como data URL en base64.' })
    .max(2 * Math.ceil((MAX_IMAGEN_MARCA_BYTES * 4) / 3) + 100, 'La imagen ocupa demasiado: el máximo es de 512 KB.'),
});

function huecoDe(valor: string): HuecoImagen {
  if (!(HUECOS_IMAGEN as readonly string[]).includes(valor)) {
    throw notFound('Esa imagen de marca no existe. Las imágenes son logoClaro, logoOscuro, favicon e icono.', 'brand_slot_not_found');
  }
  return valor as HuecoImagen;
}

function guardarImagen(clientId: string, hueco: HuecoImagen, imagen: ReturnType<typeof decodificarImagenMarca>): ImagenMarca {
  const anterior = db
    .prepare('SELECT updated_at FROM webmail_marca_imagenes WHERE client_id = ? AND hueco = ?')
    .get(clientId, hueco) as { updated_at: number } | undefined;
  // Estrictamente creciente: va en la URL de la vista previa.
  const t = Math.max(now(), (anterior?.updated_at ?? 0) + 1);
  const sha256 = crypto.createHash('sha256').update(imagen.datos).digest('hex');
  db.prepare(
    `INSERT INTO webmail_marca_imagenes (client_id, hueco, mime, data, sha256, ancho, alto, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_id, hueco) DO UPDATE SET mime = excluded.mime, data = excluded.data,
       sha256 = excluded.sha256, ancho = excluded.ancho, alto = excluded.alto, updated_at = excluded.updated_at`,
  ).run(clientId, hueco, imagen.tipo, imagen.datos, sha256, imagen.ancho, imagen.alto, t);
  return {
    tipo: imagen.tipo,
    bytes: imagen.datos.length,
    ancho: imagen.ancho,
    alto: imagen.alto,
    actualizada: t,
    url: urlImagen(clientId, hueco, t),
  };
}

function enviarImagen(reply: FastifyReply, clientId: string, hueco: HuecoImagen): FastifyReply {
  const row = db
    .prepare('SELECT mime, data FROM webmail_marca_imagenes WHERE client_id = ? AND hueco = ?')
    .get(clientId, hueco) as { mime: string; data: Buffer } | undefined;
  if (!row) throw notFound('Este cliente no tiene esa imagen de marca.', 'brand_image_not_found');
  // Mismas cabeceras que la foto del buzón: nunca se interpreta como otra cosa.
  return reply
    .header('Content-Type', row.mime)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', "default-src 'none'")
    .header('Content-Disposition', 'inline')
    .header('Cache-Control', 'private, max-age=300')
    .send(row.data);
}

/* ------------------------- Estado deseado en Bulwark ------------------------ */

/** Enlace «Mi buzón» del cliente: su panel de marca blanca si lo tiene en servicio; si no, el de la instancia. */
function miBuzonDelCliente(clientId: string, panelInstancia: string): string | undefined {
  const row = db
    .prepare(
      `SELECT hostname FROM client_domains
       WHERE client_id = ? AND kind = 'panel' AND status = 'active'
       ORDER BY is_primary DESC, activated_at ASC, created_at ASC LIMIT 1`,
    )
    .get(clientId) as { hostname: string } | undefined;
  const base = row ? `https://${row.hostname}` : panelInstancia;
  // Bulwark solo enlaza https: con un panel en http (desarrollo), sin enlace.
  return base.startsWith('https://') ? `${base}/mi-buzon` : undefined;
}

interface ImagenDeseada {
  nombre: string;
  hueco: HuecoRecursoBulwark;
  tipo: TipoImagen;
  sha256: string;
  datos: Buffer | null;
}

export interface EstadoDeseadoCorreoWeb {
  marca: EntradaMarcaBulwark[];
  politica: PoliticaBulwark;
  imagenes: ImagenDeseada[];
  huella: string;
  /** Webmail en servicio que llevan la marca de su cliente. */
  webmails: number;
  /** Clientes cuya marca no se ha podido construir (se quedan con la de la instancia). */
  descartados: string[];
}

/**
 * Lo que debe tener Bulwark: la marca de cada webmail en servicio de los
 * clientes que usan el correo web nuevo y la política de Mailway. Se calcula
 * de una vez y sin esperas (SQLite es síncrono): nada puede cambiar a mitad.
 * Sin `conDatos` no lee los bytes de las imágenes (el nombre sale del sha256):
 * es lo que hace el vigilante cada minuto para comparar la huella.
 */
export function calcularEstadoDeseado(conDatos = false): EstadoDeseadoCorreoWeb {
  const panelInstancia = getInstanceSettings().panelUrl.replace(/\/+$/, '');
  const politica = politicaBulwark({
    miBuzonUrl: panelInstancia.startsWith('https://') ? `${panelInstancia}/mi-buzon` : undefined,
  });
  const clientes = clientesConBulwarkEnServicio();
  const marca: EntradaMarcaBulwark[] = [];
  const imagenes = new Map<string, ImagenDeseada>();
  const descartados: string[] = [];
  let webmails = 0;

  if (clientes.size > 0) {
    const hosts = db
      .prepare(
        `SELECT cd.client_id, cd.hostname FROM client_domains cd
         JOIN clients c ON c.id = cd.client_id
         WHERE cd.kind = 'webmail' AND cd.status = 'active' AND c.webmail_motor = 'bulwark'
         ORDER BY cd.hostname`,
      )
      .all() as { client_id: string; hostname: string }[];
    const porCliente = new Map<string, string[]>();
    for (const h of hosts) {
      if (!clientes.has(h.client_id)) continue;
      porCliente.set(h.client_id, [...(porCliente.get(h.client_id) ?? []), h.hostname]);
    }
    const columnasImagen = conDatos ? 'hueco, mime, sha256, data' : 'hueco, mime, sha256';
    for (const [clientId, nombres] of porCliente) {
      const datos = leerMarca(clientId);
      const filasImagen = db
        .prepare(`SELECT ${columnasImagen} FROM webmail_marca_imagenes WHERE client_id = ?`)
        .all(clientId) as { hueco: HuecoImagen; mime: TipoImagen; sha256: string; data?: Buffer }[];
      const delCliente: ImagenDeseada[] = [];
      const rutas: Partial<Record<HuecoImagen, string>> = {};
      try {
        for (const f of filasImagen) {
          const hueco = HUECO_BULWARK[f.hueco];
          const recurso = nombreRecursoBulwark(f.sha256, f.mime, hueco);
          rutas[f.hueco] = recurso.ruta;
          delCliente.push({ nombre: recurso.nombre, hueco, tipo: f.mime, sha256: f.sha256, datos: f.data ?? null });
        }
        const nombre = datos.nombre || datos.nombrePorDefecto || 'Correo web';
        const empresa = datos.empresa || undefined;
        const base: Omit<WebmailConMarca, 'host'> = {
          nombre,
          nombreCorto: datos.nombreCorto || undefined,
          descripcion: `Correo web de ${empresa ?? nombre}`,
          empresa,
          logoClaroUrl: rutas.logoClaro,
          logoOscuroUrl: rutas.logoOscuro,
          faviconUrl: rutas.favicon,
          iconoUrl: rutas.icono,
          miBuzonUrl: miBuzonDelCliente(clientId, panelInstancia),
          privacidadUrl: datos.privacidadUrl || undefined,
          avisoLegalUrl: datos.avisoLegalUrl || undefined,
        };
        // Se valida por cliente: un dato que Bulwark descartaría deja a ese
        // cliente con la marca de la instancia, no a todos sin la suya.
        marca.push(...marcaPorHostBulwark(nombres.map((host) => ({ ...base, host }))));
        for (const imagen of delCliente) imagenes.set(imagen.nombre, imagen);
        webmails += nombres.length;
      } catch {
        descartados.push(clientId);
      }
    }
  }
  marca.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  return {
    marca,
    politica,
    imagenes: [...imagenes.values()],
    huella: huellaBulwark({ marca, politica }),
    webmails,
    descartados,
  };
}

/* ----------------------------- Sincronización ------------------------------ */

const AJUSTE_SINCRONIZACION = 'bulwark_sincronizacion';
const CERROJO_SINCRONIZACION = 'bulwark';
/** Primera espera tras un fallo; se dobla en cada fallo seguido. */
const ESPERA_BASE_MS = 60_000;
const ESPERA_MAXIMA_MS = 30 * 60_000;
/** Fallos seguidos a partir de los que se avisa: uno o dos pueden ser un reinicio de Bulwark. */
export const FALLOS_PARA_AVISAR = 3;
const ALERTA_MARCA = 'bulwark:marca';
const ALERTA_SALUD = 'bulwark:salud';

export interface EstadoSincronizacion {
  huellaAplicada: string | null;
  aplicadaEn: number | null;
  ultimoIntento: number | null;
  error: { mensaje: string; codigo: string } | null;
  fallosSeguidos: number;
  /** No se vuelve a intentar antes (espera creciente o la que pida Bulwark). */
  reintentarDesde: number | null;
  /** Imágenes que el panel ha subido a Bulwark y aún no ha retirado. */
  recursos: string[];
  /** Claves fijadas a mano en config.json de Bulwark (tapan su entorno). */
  clavesFijadas: string[];
  webmails: number;
}

const ESTADO_INICIAL: EstadoSincronizacion = {
  huellaAplicada: null,
  aplicadaEn: null,
  ultimoIntento: null,
  error: null,
  fallosSeguidos: 0,
  reintentarDesde: null,
  recursos: [],
  clavesFijadas: [],
  webmails: 0,
};

export function leerEstadoSincronizacion(): EstadoSincronizacion {
  const guardado = getJsonSetting<Partial<EstadoSincronizacion>>(AJUSTE_SINCRONIZACION);
  if (!guardado || typeof guardado !== 'object') return { ...ESTADO_INICIAL };
  return {
    ...ESTADO_INICIAL,
    ...guardado,
    recursos: Array.isArray(guardado.recursos) ? guardado.recursos.filter((r) => typeof r === 'string') : [],
    clavesFijadas: Array.isArray(guardado.clavesFijadas) ? guardado.clavesFijadas : [],
  };
}

function guardarEstadoSincronizacion(estado: EstadoSincronizacion): void {
  setJsonSetting(AJUSTE_SINCRONIZACION, estado);
}

/**
 * Un solo cliente de la API de Bulwark para todo el proceso: reutiliza la
 * sesión de administración (cada inicio cuenta para el límite de Bulwark).
 * Se rehace solo si cambian la dirección o la contraseña.
 */
let compartido: { clave: string; cliente: ClienteAdminBulwark } | null = null;

function clienteBulwark(): ClienteAdminBulwark {
  const { url, adminPassword } = config.bulwark;
  const clave = crypto.createHash('sha256').update(`${url}\u0000${adminPassword}`).digest('hex');
  if (!compartido || compartido.clave !== clave) {
    compartido = { clave, cliente: new ClienteAdminBulwark({ url, contrasena: adminPassword }) };
  }
  return compartido.cliente;
}

export interface ResultadoSincronizacionCorreoWeb {
  estado: 'no_configurado' | 'al_dia' | 'aplicada' | 'pendiente' | 'error';
  webmails?: number;
  marcaCambiada?: boolean;
  politicaCambiada?: boolean;
  imagenesSubidas?: number;
  imagenesRetiradas?: number;
  error?: { mensaje: string; codigo: string } | null;
  reintentarDesde?: number | null;
}

function mensajeDe(err: unknown): string {
  return err instanceof Error && err.message ? err.message.slice(0, 500) : 'Error desconocido.';
}

/**
 * Deja en Bulwark la marca y la política de Mailway si hace falta (la huella
 * ha cambiado o toca la revisión periódica) y no hay que esperar por un fallo
 * anterior. `forzar` se salta las dos cosas. Nunca lanza: el resultado y el
 * estado guardado dicen qué ha pasado.
 */
export async function sincronizarCorreoWeb(opciones: { forzar?: boolean; ahora?: number } = {}): Promise<ResultadoSincronizacionCorreoWeb> {
  if (!bulwarkDisponible()) return { estado: 'no_configurado' };
  return withLock(CERROJO_SINCRONIZACION, async () => {
    const ahora = opciones.ahora ?? now();
    const estado = leerEstadoSincronizacion();
    let deseado: EstadoDeseadoCorreoWeb;
    try {
      deseado = calcularEstadoDeseado(true);
    } catch (err) {
      // La política no se puede construir (no debería pasar): se trata como un fallo más.
      return registrarFallo(estado, err, ahora, []);
    }
    if (
      !opciones.forzar &&
      !necesitaSincronizarBulwark({
        huellaActual: deseado.huella,
        huellaAplicada: estado.huellaAplicada,
        aplicadaEn: estado.aplicadaEn,
        ahora,
      })
    ) {
      return { estado: 'al_dia', webmails: deseado.webmails };
    }
    if (!opciones.forzar && estado.reintentarDesde !== null && ahora < estado.reintentarDesde) {
      return { estado: 'pendiente', error: estado.error, reintentarDesde: estado.reintentarDesde };
    }

    const subidos: string[] = [];
    try {
      const cliente = clienteBulwark();
      const recursos = deseado.imagenes.map((imagen) => {
        if (!imagen.datos) throw new Error('Falta una imagen de marca en la base de datos.');
        return recursoMarcaBulwark(imagen.datos, imagen.tipo, imagen.hueco);
      });
      await asegurarRecursosBulwark(cliente, recursos, (nombre) => subidos.push(nombre));
      const resultado = await sincronizarBulwark(cliente, { marca: deseado.marca, politica: deseado.politica });

      // Las imágenes que ya no se usan, después de la marca (que ya no las nombra).
      const enUso = new Set(recursos.map((r) => r.nombre));
      const sobrantes = [...new Set([...estado.recursos, ...subidos])].filter((n) => !enUso.has(n));
      const sinRetirar: string[] = [];
      let retiradas = 0;
      for (const nombre of sobrantes) {
        try {
          await cliente.retirarRecurso(nombre);
          retiradas++;
        } catch {
          // Se intenta otra vez en la siguiente sincronización.
          sinRetirar.push(nombre);
        }
      }

      guardarEstadoSincronizacion({
        huellaAplicada: resultado.huella,
        aplicadaEn: ahora,
        ultimoIntento: ahora,
        error: null,
        fallosSeguidos: 0,
        reintentarDesde: null,
        recursos: [...enUso, ...sinRetirar],
        clavesFijadas: resultado.clavesFijadas,
        webmails: deseado.webmails,
      });
      if (resultado.marcaCambiada || resultado.politicaCambiada || subidos.length > 0 || retiradas > 0) {
        // Solo recuentos: ni nombres de host ni direcciones.
        auditSystem('bulwark.synced', {
          webmails: deseado.webmails,
          marcaCambiada: resultado.marcaCambiada,
          politicaCambiada: resultado.politicaCambiada,
          imagenesSubidas: subidos.length,
          imagenesRetiradas: retiradas,
          descartados: deseado.descartados.length,
        });
      }
      resolveAlert(ALERTA_MARCA, { notify: true, what: 'marca del correo web nuevo' });
      return {
        estado: 'aplicada',
        webmails: deseado.webmails,
        marcaCambiada: resultado.marcaCambiada,
        politicaCambiada: resultado.politicaCambiada,
        imagenesSubidas: subidos.length,
        imagenesRetiradas: retiradas,
      };
    } catch (err) {
      return registrarFallo(estado, err, ahora, subidos);
    }
  });
}

function registrarFallo(
  estado: EstadoSincronizacion,
  err: unknown,
  ahora: number,
  subidos: string[],
): ResultadoSincronizacionCorreoWeb {
  const fallos = estado.fallosSeguidos + 1;
  const pedida = err instanceof ErrorBulwark && err.reintentarEnS ? err.reintentarEnS * 1000 : 0;
  const espera = Math.max(pedida, Math.min(ESPERA_BASE_MS * 2 ** (fallos - 1), ESPERA_MAXIMA_MS));
  const error = { mensaje: mensajeDe(err), codigo: err instanceof HttpError ? err.code : 'bulwark_error' };
  guardarEstadoSincronizacion({
    ...estado,
    ultimoIntento: ahora,
    error,
    fallosSeguidos: fallos,
    reintentarDesde: ahora + espera,
    // Lo subido antes del fallo también se retira cuando ya no haga falta.
    recursos: [...new Set([...estado.recursos, ...subidos])],
  });
  if (fallos >= FALLOS_PARA_AVISAR) {
    fireAlert({
      severity: 'warning',
      type: 'bulwark_marca',
      dedupeKey: ALERTA_MARCA,
      title: 'No se puede aplicar la marca del correo web nuevo',
      message: `Mailway lleva ${fallos} intentos sin poder aplicar en Bulwark la marca de los clientes y la política del correo web nuevo. Último error: ${error.mensaje}`,
      remedy:
        'Mientras tanto, los webmail de esos clientes muestran la marca de la instancia. Comprueba que el contenedor mailway-bulwark está en marcha y que MAILWAY_BULWARK_URL y MAILWAY_BULWARK_ADMIN_PASSWORD del panel coinciden con los de Bulwark (deploy/bulwark/README.md, «Secretos»). Se reintenta solo.',
    });
  }
  return { estado: 'error', error, reintentarDesde: ahora + espera };
}

/* ------------------------- Tareas en segundo plano -------------------------- */

const enCurso = new Set<Promise<unknown>>();
let sincronizacionProgramada = false;

function enSegundoPlano(tarea: () => Promise<unknown>): void {
  const promesa = tarea()
    .catch(() => {
      // Nunca afecta a la ruta que la lanzó: el estado y las alertas lo dicen.
    })
    .finally(() => enCurso.delete(promesa));
  enCurso.add(promesa);
}

/**
 * Programa una sincronización con Bulwark sin esperarla. Varias llamadas
 * seguidas (guardar la marca y subir dos imágenes) se juntan en una.
 */
export function programarSincronizacionBulwark(): void {
  if (sincronizacionProgramada || !bulwarkDisponible()) return;
  sincronizacionProgramada = true;
  enSegundoPlano(async () => {
    // Al siguiente turno: se juntan los cambios de la misma petición.
    await new Promise((resolve) => setImmediate(resolve));
    sincronizacionProgramada = false;
    await sincronizarCorreoWeb();
  });
}

/** Espera a que terminen las tareas en segundo plano (pruebas y herramientas). */
export async function esperarTareasCorreoWeb(): Promise<void> {
  while (enCurso.size > 0) await Promise.allSettled([...enCurso]);
}

/* ------------------------------- Vigilante --------------------------------- */

let fallosSaludSeguidos = 0;
/** Fallos seguidos de /api/health antes de avisar: uno solo puede ser un reinicio. */
const FALLOS_SALUD_PARA_AVISAR = 2;

/**
 * Salud de Bulwark (GET /api/health por la dirección interna, sin sesión).
 * Devuelve si responde. Sin Bulwark configurado, cierra lo que hubiera.
 */
export async function comprobarSaludBulwark(): Promise<boolean> {
  const estado = estadoBulwark();
  if (!estado.configurado) {
    fallosSaludSeguidos = 0;
    resolveAlert(ALERTA_SALUD);
    return false;
  }
  if (!estado.disponible) {
    fireAlert({
      severity: 'warning',
      type: 'bulwark_salud',
      dedupeKey: ALERTA_SALUD,
      title: 'El correo web nuevo está instalado a medias',
      message: `${estado.motivo ?? ''} Mientras tanto no se puede elegir para ningún cliente y sus webmail van a Roundcube.`.trim(),
      remedy: 'Revisa las variables MAILWAY_BULWARK_* del panel (deploy/.env) y vuelve a desplegarlo.',
    });
    return false;
  }
  try {
    await clienteBulwark().salud();
    fallosSaludSeguidos = 0;
    resolveAlert(ALERTA_SALUD, { notify: true, what: 'correo web nuevo (Bulwark)' });
    return true;
  } catch (err) {
    fallosSaludSeguidos++;
    if (fallosSaludSeguidos >= FALLOS_SALUD_PARA_AVISAR) {
      fireAlert({
        severity: 'critical',
        type: 'bulwark_salud',
        dedupeKey: ALERTA_SALUD,
        title: 'El correo web nuevo no responde',
        message: `Bulwark no responde a la comprobación de salud (${mensajeDe(err)}). Los clientes que lo usan no pueden leer su correo desde el navegador; los programas de correo y el móvil siguen funcionando.`,
        remedy: 'Ejecuta en el servidor: docker logs mailway-bulwark y docker compose -f deploy/docker-compose.mail.yml up -d',
      });
    }
    return false;
  }
}

/**
 * Paso del vigilante (nunca durante el mantenimiento del motor, que para
 * también los correos web): la salud de Bulwark y, si responde, la
 * sincronización pendiente. Si no responde no se intenta sincronizar: ya
 * avisa la salud y cada intento fallido alargaría la espera.
 */
export async function vigilarCorreoWebNuevo(): Promise<void> {
  const responde = await comprobarSaludBulwark();
  if (!responde) return;
  await sincronizarCorreoWeb();
}

/* ----------------------------- Resumen y estado ----------------------------- */

export interface ResumenCorreoWebNuevo {
  disponible: boolean;
  motivo: string | null;
  /** Stalwart 0.16 y disponible: los webmail de sus clientes van a Bulwark. */
  enServicio: boolean;
  salud: { ok: boolean; detalle: string | null };
  clientes: number;
  sincronizacion: {
    pendiente: boolean;
    aplicadaEn: number | null;
    error: { mensaje: string; codigo: string } | null;
    reintentarDesde: number | null;
    clavesFijadas: string[];
  };
}

function resumenSincronizacion(): ResumenCorreoWebNuevo['sincronizacion'] {
  const estado = leerEstadoSincronizacion();
  let pendiente = true;
  try {
    pendiente = calcularEstadoDeseado(false).huella !== estado.huellaAplicada;
  } catch {
    // Sin poder calcularla, se da por pendiente.
  }
  return {
    pendiente,
    aplicadaEn: estado.aplicadaEn,
    error: estado.error,
    reintentarDesde: estado.reintentarDesde,
    clavesFijadas: estado.clavesFijadas,
  };
}

/** Estado del correo web nuevo para el panel de administración; null si no está configurado. */
export async function resumenCorreoWebNuevo(): Promise<ResumenCorreoWebNuevo | null> {
  const estado = estadoBulwark();
  if (!estado.configurado) return null;
  let salud: ResumenCorreoWebNuevo['salud'] = { ok: false, detalle: estado.motivo };
  if (estado.disponible) {
    try {
      // Con su propio límite: el resumen no espera los 10 s del cliente compartido.
      await new ClienteAdminBulwark({
        url: config.bulwark.url,
        contrasena: config.bulwark.adminPassword,
        tiempoMaximoMs: 3000,
      }).salud();
      salud = { ok: true, detalle: null };
    } catch (err) {
      salud = { ok: false, detalle: mensajeDe(err) };
    }
  }
  const { c } = db.prepare(`SELECT COUNT(*) AS c FROM clients WHERE webmail_motor = 'bulwark'`).get() as { c: number };
  return {
    disponible: estado.disponible,
    motivo: estado.motivo,
    enServicio: bulwarkEnServicio(),
    salud,
    clientes: c,
    sincronizacion: resumenSincronizacion(),
  };
}

/** Lo que ve la ficha del cliente (con lo de la instancia solo para la administración). */
function estadoCorreoWebCliente(clientId: string, esAdmin: boolean, api: EngineApi | null) {
  const webmails = db
    .prepare(`SELECT hostname, status FROM client_domains WHERE client_id = ? AND kind = 'webmail' ORDER BY hostname`)
    .all(clientId) as { hostname: string; status: string }[];
  const motor = motorCorreoWebDe(clientId);
  return {
    motor,
    enServicio: motorCorreoWebEnServicio(clientId),
    webmails,
    marca: leerMarca(clientId),
    ...(esAdmin
      ? {
          bulwark: { ...estadoBulwark(), api, motor016: api === null ? null : api === 'jmap016' },
          sincronizacion: motor === 'bulwark' ? resumenSincronizacion() : null,
        }
      : {}),
  };
}

/* ---------------------------- Elección del motor ---------------------------- */

/** Cerrojo de los cambios de CORS del motor por el correo web (elegir, dejar de usar). */
const CERROJO_CORS = 'correoweb:cors';

/** ¿Tiene el motor el CORS abierto? Sin esa comprobación (0.15, demostración) no hay nada que abrir. */
async function corsAbierto(motor: MailEngine): Promise<boolean> {
  const estado = await motor.getSettingsStatus({ trustedNetworks: trustedEngineNetworks(), permissiveCors: true });
  return estado.extra.permissiveCors !== false;
}

/**
 * Elegir el correo web nuevo: Bulwark disponible, Stalwart 0.16 y el CORS del
 * motor abierto ANTES de guardar la elección (las rutas de Traefik la siguen
 * en cuanto se guarda: un cliente con Bulwark y el motor sin CORS no podría
 * leer su correo). Devuelve si ha hecho falta abrirlo.
 */
async function elegirBulwark(
  clientId: string,
): Promise<{ hostname: string; errors: number; restartRequired: number } | null> {
  const estado = estadoBulwark();
  if (!estado.disponible) throw conflict(estado.motivo ?? 'El correo web nuevo no está disponible.', 'bulwark_unavailable');
  exigirSinMantenimiento();
  const motor = getEngine();
  const api = await motor.detectApi();
  if (api !== 'jmap016') {
    throw conflict(
      api === 'demo'
        ? 'El correo web nuevo necesita Stalwart 0.16: no funciona con el motor de demostración.'
        : 'El correo web nuevo necesita Stalwart 0.16 y el servidor de correo es una versión anterior. Actualiza el motor antes de elegirlo.',
      'bulwark_requires_016',
    );
  }
  let aplicados: { hostname: string; errors: number; restartRequired: number } | null = null;
  if (!(await corsAbierto(motor))) {
    const resultado = await applyRecommendedEngineSettings(getInstanceSettings().mailHostname, motor, { permissiveCors: true });
    if (!(await corsAbierto(motor))) {
      throw upstream(
        `No se ha podido abrir el CORS del motor de correo, que necesita el correo web nuevo${resultado.errors.length ? `: ${resultado.errors.join('; ')}` : '.'} El cliente sigue con Roundcube.`,
        'bulwark_cors_failed',
      );
    }
    aplicados = {
      hostname: resultado.input.hostname,
      errors: resultado.errors.length,
      restartRequired: resultado.restartRequired.length,
    };
  }
  db.prepare(`UPDATE clients SET webmail_motor = 'bulwark' WHERE id = ?`).run(clientId);
  return aplicados;
}

/**
 * El último cliente ha vuelto a Roundcube: se cierra el CORS del motor en
 * segundo plano (aplicar los ajustes recomendados con 0.16 tarda 15 s o más).
 * Si falla, Ajustes → Servidor de correo lo enseña como pendiente.
 */
function cerrarCorsSiSobra(): void {
  enSegundoPlano(() =>
    withLock(CERROJO_CORS, async () => {
      if (corsPermisivoNecesario() || !engineConfigured()) return;
      const host = getInstanceSettings().mailHostname;
      if (!host) return;
      const motor = getEngine();
      if ((await motor.detectApi()) !== 'jmap016') return;
      const estado = await motor.getSettingsStatus({ trustedNetworks: trustedEngineNetworks(), permissiveCors: false });
      // Sin la clave, el CORS ya está cerrado: no hay nada que hacer.
      if (estado.extra.permissiveCors !== false) return;
      const resultado = await applyRecommendedEngineSettings(host, motor, { permissiveCors: false });
      auditSystem('engine.recommended_applied', {
        hostname: host,
        permissiveCors: false,
        errors: resultado.errors.length,
        restartRequired: resultado.restartRequired.length,
      });
    }),
  );
}

/* --------------------------------- Rutas ----------------------------------- */

const motorSchema = z.object({
  motor: z.enum(['roundcube', 'bulwark'], {
    errorMap: () => ({ message: 'El correo web debe ser «roundcube» o «bulwark».' }),
  }),
});

export function registerCorreoWebRoutes(app: FastifyInstance): void {
  /** Correo web del cliente y su marca. La administración ve además si se puede elegir el nuevo. */
  app.get('/api/clients/:id/webmail', async (req) => {
    const { id } = req.params as { id: string };
    const user = requireClientAccess(req, id);
    filaCliente(id);
    const esAdmin = user.role === 'admin';
    // La versión del motor solo hace falta para decir por qué no se puede elegir.
    const api = esAdmin ? await apiDelMotor() : null;
    return estadoCorreoWebCliente(id, esAdmin, api);
  });

  /**
   * Elegir el correo web del cliente. Solo la administración: un token de
   * gestión de administración también puede (lo puede todo), uno de cliente no.
   */
  app.put('/api/clients/:id/webmail', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    filaCliente(id);
    const { motor } = motorSchema.parse(req.body ?? {});
    const anterior = motorCorreoWebDe(id);
    let corsAbiertoAhora = false;
    if (motor === 'bulwark') {
      // En fila con los demás cambios de CORS: el que cierra no debe cruzarse con el que abre.
      const aplicados = await withLock(CERROJO_CORS, () => elegirBulwark(id));
      if (aplicados) {
        corsAbiertoAhora = true;
        // Los ajustes del motor han cambiado: queda anotado como los de Ajustes.
        audit(req, 'engine.recommended_applied', { ...aplicados, permissiveCors: true });
      }
    } else {
      db.prepare(`UPDATE clients SET webmail_motor = 'roundcube' WHERE id = ?`).run(id);
      if (anterior === 'bulwark' && !corsPermisivoNecesario()) cerrarCorsSiSobra();
    }
    if (anterior !== motor) {
      audit(
        req,
        'client.webmail_changed',
        { webmail: motor, previous: anterior, ...(motor === 'bulwark' ? { corsApplied: corsAbiertoAhora } : {}) },
        id,
      );
    }
    programarSincronizacionBulwark();
    return estadoCorreoWebCliente(id, true, await apiDelMotor());
  });

  /**
   * Marca del correo web nuevo: quien gestiona los dominios propios del
   * cliente (la administración y sus usuarios, como whitelabel.ts). Solo
   * cambian los campos que llegan; un texto vacío vuelve al valor por defecto.
   */
  app.patch('/api/clients/:id/webmail/marca', async (req) => {
    const { id } = req.params as { id: string };
    requireClientAccess(req, id);
    filaCliente(id);
    const cambios = marcaSchema.parse(req.body ?? {});
    const cambiados = guardarMarca(id, cambios);
    if (cambiados.length > 0) {
      audit(req, 'client.webmail_brand_updated', { fields: cambiados }, id);
      programarSincronizacionBulwark();
    }
    return { marca: leerMarca(id) };
  });

  app.get('/api/clients/:id/webmail/marca/imagenes/:hueco', async (req, reply) => {
    const { id, hueco } = req.params as { id: string; hueco: string };
    requireClientAccess(req, id);
    return enviarImagen(reply, id, huecoDe(hueco));
  });

  app.put('/api/clients/:id/webmail/marca/imagenes/:hueco', async (req) => {
    const { id, hueco: crudo } = req.params as { id: string; hueco: string };
    requireClientAccess(req, id);
    filaCliente(id);
    const hueco = huecoDe(crudo);
    const { imagen } = imagenSchema.parse(req.body ?? {});
    const guardada = guardarImagen(id, hueco, decodificarImagenMarca(imagen));
    audit(req, 'client.webmail_brand_image_updated', { image: hueco, type: guardada.tipo, size: guardada.bytes }, id);
    programarSincronizacionBulwark();
    return { imagen: guardada };
  });

  app.delete('/api/clients/:id/webmail/marca/imagenes/:hueco', async (req) => {
    const { id, hueco: crudo } = req.params as { id: string; hueco: string };
    requireClientAccess(req, id);
    filaCliente(id);
    const hueco = huecoDe(crudo);
    const borrada = db.prepare('DELETE FROM webmail_marca_imagenes WHERE client_id = ? AND hueco = ?').run(id, hueco).changes > 0;
    if (borrada) {
      audit(req, 'client.webmail_brand_image_removed', { image: hueco }, id);
      programarSincronizacionBulwark();
    }
    return { ok: true };
  });
}
