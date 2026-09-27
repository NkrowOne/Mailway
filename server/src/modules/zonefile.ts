import crypto from 'node:crypto';
import { config } from '../config';
import type { EngineDnsRecord } from '../engine/types';
import { normalizarTxt, trocearTxt as trocear } from '../core/cloudflare';

/**
 * Registros DNS de correo: selección común y fichero de zona.
 *
 * `seleccionarRegistros` es la ÚNICA fuente de verdad de qué registros del
 * motor se piden al usuario. La usan la comprobación DNS del dominio, el
 * fichero de zona y el plan de Cloudflare: si cada uno filtrara por su lado,
 * el panel pediría un registro que el fichero no trae o Cloudflare crearía
 * uno que la comprobación nunca mira.
 *
 * Copiar registros a mano es donde más se equivoca la gente: un DKIM cortado
 * o un SPF con un espacio de más no da error, simplemente hace que el correo
 * acabe en spam sin que nadie sepa por qué.
 */

/* ------------------------- Selección de registros ------------------------- */

/**
 * Puertos que el despliegue publica de verdad. Stalwart anuncia un SRV por
 * cada escucha, incluidas las que el compose no expone (IMAP 143, POP3 110 y
 * 995): anunciarlas haría que un programa de correo intentara conectar a un
 * puerto cerrado. 443 sí llega, a través de Traefik.
 */
export const PUERTOS_PUBLICADOS: ReadonlySet<number> = new Set([993, 465, 587, 443]);

/** Servicios SRV que nunca se anuncian aunque el motor los proponga. */
const SRV_EXCLUIDOS = ['_imap._tcp.', '_pop3._tcp.', '_pop3s._tcp.'];

/** Tipos que el panel no pide: TLSA exige DNSSEC y cambia con cada certificado. */
const TIPOS_EXCLUIDOS = new Set(['TLSA']);

function sinPunto(valor: string): string {
  return valor.trim().replace(/\.$/, '');
}

/** Quita el punto final de los destinos (MX, CNAME, SRV) para una forma canónica. */
function contenidoCanonico(record: EngineDnsRecord): string {
  const content = record.content.trim();
  if (record.type === 'MX' || record.type === 'SRV') {
    const partes = content.split(/\s+/);
    const destino = partes.pop() || '';
    return [...partes, sinPunto(destino).toLowerCase()].join(' ');
  }
  if (record.type === 'CNAME') return sinPunto(content).toLowerCase();
  if (record.type === 'TXT') return normalizarTxt(content);
  return content;
}

/** Puerto de un SRV ("prioridad peso puerto destino"), o null si no se entiende. */
export function puertoSrv(content: string): number | null {
  const partes = content.trim().split(/\s+/);
  if (partes.length < 4) return null;
  const puerto = Number(partes[2]);
  return Number.isInteger(puerto) ? puerto : null;
}

/** true si `name` es el dominio o un nombre dentro de él. */
export function dentroDelDominio(name: string, domain: string): boolean {
  const n = sinPunto(name).toLowerCase();
  const d = sinPunto(domain).toLowerCase();
  return n === d || n.endsWith(`.${d}`);
}

/**
 * Registros del motor que de verdad hay que publicar para `domain`, con
 * nombres y destinos sin punto final:
 * - fuera los SRV de puertos no publicados;
 * - fuera TLSA;
 * - fuera los nombres ajenos al dominio (un importador los rechazaría y
 *   Cloudflare los crearía en otra zona);
 * - sin duplicados.
 */
export function seleccionarRegistros(domain: string, records: EngineDnsRecord[]): EngineDnsRecord[] {
  const vistos = new Set<string>();
  const out: EngineDnsRecord[] = [];
  for (const record of records) {
    const type = record.type.toUpperCase();
    if (TIPOS_EXCLUIDOS.has(type)) continue;
    const name = sinPunto(record.name).toLowerCase();
    if (!dentroDelDominio(name, domain)) continue;
    if (type === 'SRV') {
      if (SRV_EXCLUIDOS.some((prefijo) => `${name}.`.startsWith(prefijo))) continue;
      const puerto = puertoSrv(record.content);
      if (puerto === null || !PUERTOS_PUBLICADOS.has(puerto)) continue;
    }
    const limpio: EngineDnsRecord = { type, name, content: contenidoCanonico({ ...record, type }) };
    const clave = `${type}|${name}|${limpio.content.toLowerCase()}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    out.push(limpio);
  }
  return out;
}

/* ------------------------- Verificación de propiedad ---------------------- */

/** Prefijo del nombre del TXT de verificación (`_mailway.<dominio>`). */
const PREFIJO_PROPIEDAD = '_mailway.';

/**
 * Token de verificación de propiedad de un dominio (ya en ASCII). Derivado
 * del secreto de la instancia: es estable, no hay que guardarlo y nadie
 * puede calcularlo desde fuera para «demostrar» un dominio ajeno.
 */
export function tokenPropiedad(domain: string): string {
  return crypto.createHmac('sha256', config.secret).update(`propiedad:${domain}`).digest('hex').slice(0, 32);
}

/**
 * TXT que demuestra que quien da de alta el dominio controla su DNS sin
 * tocar el MX: permite preparar los buzones antes de trasladar el correo
 * desde otro proveedor.
 */
export function registroPropiedad(domain: string): EngineDnsRecord {
  const limpio = sinPunto(domain).toLowerCase();
  return {
    type: 'TXT',
    name: `${PREFIJO_PROPIEDAD}${limpio}`,
    content: `mailway-verificacion=${tokenPropiedad(limpio)}`,
  };
}

export function esRegistroPropiedad(record: EngineDnsRecord): boolean {
  return record.type.toUpperCase() === 'TXT' && sinPunto(record.name).toLowerCase().startsWith(PREFIJO_PROPIEDAD);
}

/**
 * Registros que se publican para un dominio: los del motor (ya
 * seleccionados) más el TXT de verificación de propiedad. Lo usan la tabla
 * de registros, el fichero de zona y Cloudflare, para que los tres pidan
 * exactamente lo mismo. La comprobación DNS del dominio usa la selección del
 * motor y mide la propiedad aparte (domains.ts): el TXT deja de importar en
 * cuanto la propiedad queda probada y no debe contar como registro pendiente.
 */
export function registrosDelDominio(domain: string, records: EngineDnsRecord[]): EngineDnsRecord[] {
  const seleccion = seleccionarRegistros(domain, records).filter((r) => !esRegistroPropiedad(r));
  return [...seleccion, registroPropiedad(domain)];
}

export type CategoriaRegistro = 'obligatorio' | 'autoconfiguracion' | 'verificacion' | 'endurecimiento';

/** true si el registro es imprescindible para que el correo funcione. */
export function esObligatorio(record: EngineDnsRecord): boolean {
  const name = sinPunto(record.name).toLowerCase();
  const type = record.type.toUpperCase();
  if (type === 'MX') return true;
  if (type === 'TXT' && record.content.toLowerCase().includes('v=spf1')) return true;
  if (name.includes('._domainkey.') || name.startsWith('_domainkey.')) return true;
  if (type === 'TXT' && name.startsWith('_dmarc.')) return true;
  return false;
}

/**
 * MTA-STS y TLS-RPT endurecen la entrega, pero MTA-STS exige además publicar
 * un fichero de política: por eso van aparte y no entran en lo recomendado.
 */
function esEndurecimiento(record: EngineDnsRecord): boolean {
  const name = sinPunto(record.name).toLowerCase();
  return name.startsWith('_mta-sts.') || name.startsWith('mta-sts.') || name.startsWith('_smtp._tls.');
}

/**
 * El TXT de propiedad va con lo recomendado: quien apunta el MX aquí ya
 * demuestra la propiedad, así que «solo lo obligatorio» no lo necesita.
 */
export function categoriaDe(record: EngineDnsRecord): CategoriaRegistro {
  if (esObligatorio(record)) return 'obligatorio';
  if (esRegistroPropiedad(record)) return 'verificacion';
  if (esEndurecimiento(record)) return 'endurecimiento';
  const type = record.type.toUpperCase();
  if (type === 'SRV' || type === 'CNAME' || type === 'A' || type === 'AAAA') return 'autoconfiguracion';
  return 'endurecimiento';
}

/* --------------------------------- Niveles -------------------------------- */

export type NivelZona = 'obligatorios' | 'recomendados' | 'completo';

export const NIVELES: { id: NivelZona; titulo: string; descripcion: string }[] = [
  {
    id: 'obligatorios',
    titulo: 'Solo lo obligatorio',
    descripcion:
      'Lo mínimo para enviar y recibir: MX, SPF, DKIM y DMARC. Es la opción más segura si el dominio ya tiene otros servicios.',
  },
  {
    id: 'recomendados',
    titulo: 'Recomendado',
    descripcion:
      'Lo obligatorio más la autoconfiguración (los programas de correo y el móvil se configuran al introducir la dirección) y el registro de verificación de la propiedad del dominio.',
  },
  {
    id: 'completo',
    titulo: 'Todo',
    descripcion:
      'Incluye además MTA-STS y TLS-RPT, que exigen cifrado en el correo entrante. Requieren publicar un fichero de política en la web del dominio.',
  },
];

export function filtrarPorNivel(records: EngineDnsRecord[], nivel: NivelZona): EngineDnsRecord[] {
  if (nivel === 'completo') return records;
  if (nivel === 'obligatorios') return records.filter(esObligatorio);
  return records.filter((r) => categoriaDe(r) !== 'endurecimiento');
}

/* ----------------------------- Fichero de zona ---------------------------- */

/**
 * Trocea un valor TXT en cadenas de 255 bytes como máximo, entrecomilladas.
 * El motor puede devolverlo ya entrecomillado o ya troceado: se normaliza a
 * texto plano antes de volver a trocear.
 */
export function trocearTxt(valor: string): string {
  return trocear(valor);
}

function fqdn(name: string): string {
  return name.endsWith('.') ? name : `${name}.`;
}

/** En un fichero de zona, un destino sin punto final sería relativo al origen. */
function valorZona(record: EngineDnsRecord): string {
  const content = record.content.trim();
  if (record.type === 'TXT') return trocearTxt(content);
  if (record.type === 'CNAME') return fqdn(content);
  if (record.type === 'MX' || record.type === 'SRV') {
    const partes = content.split(/\s+/);
    const destino = partes.pop() || '';
    return [...partes, fqdn(destino)].join(' ');
  }
  return content;
}

function lineaRegistro(record: EngineDnsRecord, ttl: number): string {
  return `${fqdn(record.name)}\t${ttl}\tIN\t${record.type}\t${valorZona(record)}`;
}

export interface OpcionesZona {
  domain: string;
  records: EngineDnsRecord[];
  nivel: NivelZona;
  ttl?: number;
  /** Marca de tiempo del encabezado; se inyecta para poder fijarla en pruebas. */
  generadoEn?: string;
}

export function generarZona(opts: OpcionesZona): string {
  const ttl = opts.ttl ?? 3600;
  const seleccion = filtrarPorNivel(registrosDelDominio(opts.domain, opts.records), opts.nivel);
  const nivelInfo = NIVELES.find((n) => n.id === opts.nivel)!;
  const incluyeMtaSts = seleccion.some((r) => r.name.includes('_mta-sts'));

  const cabecera = [
    ';  Registros DNS de correo para ' + opts.domain,
    ';  Generados por Mailway · nivel: ' + nivelInfo.titulo.toLowerCase(),
    ';  ' + (opts.generadoEn ?? new Date().toISOString()),
    ';',
    ';  IMPORTACIÓN EN CLOUDFLARE',
    ';    DNS  →  Records  →  Import and Export  →  Import DNS records',
    ';    y seleccione este fichero.',
    ';',
    ';  ANTES DE IMPORTAR',
    ';    Al terminar, compruebe que los registros quedan en GRIS (DNS only).',
    ';    Con la nube naranja el correo NO funciona: Cloudflare no actúa como',
    ';    intermediario de SMTP ni de IMAP, de modo que los programas de correo',
    ';    y los demás servidores no podrían conectar con este servidor.',
    ';',
    ';    Importar NO borra los registros existentes. Si el dominio ya tiene',
    ';    un SPF, quedarán dos y ninguno será válido: conserve solo uno y',
    ';    combine en una única línea v=spf1 los mecanismos necesarios.',
  ];

  if (seleccion.some(esRegistroPropiedad)) {
    cabecera.push(
      ';',
      ';  El TXT ' + PREFIJO_PROPIEDAD + opts.domain + ' demuestra que el dominio es suyo.',
      ';    Permite crear buzones y alias antes de apuntar el MX a este servidor.',
    );
  }

  if (incluyeMtaSts) {
    cabecera.push(
      ';',
      ';  MTA-STS incluido: además del registro, es necesario publicar el fichero',
      ';    https://mta-sts.' + opts.domain + '/.well-known/mta-sts.txt',
      ';    Sin él, el registro no tiene efecto.',
    );
  }

  const cuerpo = seleccion.map((r) => lineaRegistro(r, ttl));

  return [...cabecera, '', `$TTL ${ttl}`, '', ...cuerpo, ''].join('\n');
}

/** Nombre de fichero sugerido en la descarga. */
export function nombreFichero(domain: string, nivel: NivelZona): string {
  return `${domain}-mailway-${nivel}.txt`;
}

/* ---------------------- Conflicto con otro proveedor ---------------------- */

export interface ConflictoCorreo {
  /** El dominio ya recibe correo en otro sitio. */
  hayOtroProveedor: boolean;
  /** Servidores que reciben hoy, si los hay. */
  mxActuales: string[];
  /** SPF existente; un dominio solo puede tener UNO válido. */
  spfActual: string | null;
  /** Política DMARC vigente: con p=reject, un SPF roto rebota el correo. */
  dmarcPolitica: string | null;
  aviso: string | null;
}

/**
 * Un dominio solo puede tener un proveedor de correo recibiendo. Importar
 * estos registros sobre un dominio que ya recibe en otro sitio no da error:
 * rompe el correo, y con DMARC en `p=reject` lo rebota. Por eso se comprueba
 * ANTES de que el usuario descargue nada.
 */
export function evaluarConflicto(input: {
  mx: { priority: number; exchange: string }[] | null;
  txt: string[] | null;
  dmarc: string[] | null;
  mailHostname: string;
}): ConflictoCorreo {
  const mxActuales = (input.mx ?? []).map((m) => m.exchange.replace(/\.$/, ''));
  const propio = input.mailHostname.replace(/\.$/, '').toLowerCase();
  const ajenos = mxActuales.filter((m) => m.toLowerCase() !== propio);

  const spfActual = (input.txt ?? []).find((t) => t.toLowerCase().startsWith('v=spf1')) ?? null;
  const dmarcRaw = (input.dmarc ?? []).find((t) => t.toLowerCase().startsWith('v=dmarc1')) ?? null;
  const dmarcPolitica = dmarcRaw?.match(/p=(none|quarantine|reject)/i)?.[1]?.toLowerCase() ?? null;

  const hayOtroProveedor = ajenos.length > 0;
  let aviso: string | null = null;

  if (hayOtroProveedor) {
    const partes = [
      `Este dominio ya recibe correo en ${ajenos.join(', ')}.`,
      'Un dominio solo puede tener un proveedor de correo entrante: si se importan estos registros, el correo se repartirá entre los dos servidores y parte de él se perderá.',
    ];
    if (spfActual) {
      partes.push(
        `Además, ya tiene un SPF (${spfActual}) y solo puede haber uno: con dos, ninguno es válido.`,
      );
    }
    if (dmarcPolitica === 'reject') {
      partes.push(
        'Su DMARC está en p=reject, de modo que un SPF incorrecto no envía el correo a spam: provoca que se rechace.',
      );
    }
    partes.push(
      'Trasladar este dominio a Mailway requiere una migración planificada, no una importación.',
    );
    aviso = partes.join(' ');
  }

  return { hayOtroProveedor, mxActuales, spfActual, dmarcPolitica, aviso };
}
