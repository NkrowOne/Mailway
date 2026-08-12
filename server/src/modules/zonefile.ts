import type { EngineDnsRecord } from '../engine/types';

/**
 * Genera un fichero de zona BIND listo para importar en Cloudflare (y en
 * cualquier proveedor que acepte el formato estándar).
 *
 * Copiar registros a mano es donde más se equivoca la gente: un DKIM cortado
 * o un SPF con un espacio de más no da error, simplemente hace que el correo
 * acabe en spam sin que nadie sepa por qué.
 */

export type NivelZona = 'obligatorios' | 'recomendados' | 'completo';

export const NIVELES: { id: NivelZona; titulo: string; descripcion: string }[] = [
  {
    id: 'obligatorios',
    titulo: 'Solo lo obligatorio',
    descripcion:
      'Lo mínimo para enviar y recibir: MX, SPF, DKIM y DMARC. Si tu dominio ya tiene otros servicios, este es el más seguro.',
  },
  {
    id: 'recomendados',
    titulo: 'Recomendado',
    descripcion:
      'Lo obligatorio más la autoconfiguración: los programas de correo y el móvil se configuran solos escribiendo la dirección.',
  },
  {
    id: 'completo',
    titulo: 'Todo',
    descripcion:
      'Incluye además MTA-STS y TLS-RPT, que exigen cifrado en el correo entrante. Requieren publicar un fichero de política en tu web.',
  },
];

/** true si el registro es imprescindible para que el correo funcione. */
export function esObligatorio(record: EngineDnsRecord): boolean {
  const name = record.name.replace(/\.$/, '');
  if (record.type === 'MX') return true;
  if (record.type === 'TXT' && record.content.includes('v=spf1')) return true;
  if (name.includes('_domainkey')) return true;
  if (record.type === 'TXT' && name.startsWith('_dmarc')) return true;
  return false;
}

/** true si además ayuda a que los clientes de correo se autoconfiguren. */
function esAutoconfiguracion(record: EngineDnsRecord): boolean {
  return record.type === 'SRV' || record.type === 'CNAME' || record.type === 'A';
}

export function filtrarPorNivel(
  records: EngineDnsRecord[],
  nivel: NivelZona,
): EngineDnsRecord[] {
  if (nivel === 'completo') return records;
  if (nivel === 'obligatorios') return records.filter(esObligatorio);
  return records.filter((r) => esObligatorio(r) || esAutoconfiguracion(r));
}

/**
 * Trocea un valor TXT en cadenas de 255 bytes como máximo.
 *
 * El DNS no admite cadenas de más de 255 bytes, y una clave DKIM de 2048 bits
 * las pasa de largo. La forma correcta es varias cadenas entrecomilladas
 * seguidas, que el resolutor concatena. Sin esto, el registro DKIM se importa
 * truncado y la firma no valida nunca.
 */
export function trocearTxt(valor: string): string {
  // El motor puede devolverlo ya entrecomillado o ya troceado: se normaliza
  // a texto plano antes de volver a trocear.
  const plano = valor
    .replace(/"\s+"/g, '')
    .replace(/^"|"$/g, '')
    .replace(/\\"/g, '"');

  const trozos: string[] = [];
  let resto = Buffer.from(plano, 'utf8');
  while (resto.length > 255) {
    // Corta por byte, no por carácter: un acento ocupa dos bytes.
    let corte = 255;
    while (corte > 0 && (resto[corte]! & 0xc0) === 0x80) corte--;
    trozos.push(resto.subarray(0, corte).toString('utf8'));
    resto = resto.subarray(corte);
  }
  trozos.push(resto.toString('utf8'));

  return trozos.map((t) => `"${t.replace(/"/g, '\\"')}"`).join(' ');
}

function fqdn(name: string): string {
  return name.endsWith('.') ? name : `${name}.`;
}

function lineaRegistro(record: EngineDnsRecord, ttl: number): string {
  const nombre = fqdn(record.name);
  const valor = record.type === 'TXT' ? trocearTxt(record.content) : record.content.trim();
  return `${nombre}\t${ttl}\tIN\t${record.type}\t${valor}`;
}

export interface OpcionesZona {
  domain: string;
  records: EngineDnsRecord[];
  nivel: NivelZona;
  ttl?: number;
  /** Marca de tiempo del encabezado; se inyecta para poder fijarla en tests. */
  generadoEn?: string;
}

export function generarZona(opts: OpcionesZona): string {
  const ttl = opts.ttl ?? 3600;
  const seleccion = filtrarPorNivel(opts.records, opts.nivel);
  const nivelInfo = NIVELES.find((n) => n.id === opts.nivel)!;
  const incluyeMtaSts = seleccion.some((r) => r.name.includes('_mta-sts'));

  const cabecera = [
    ';  Registros DNS de correo para ' + opts.domain,
    ';  Generados por Mailway · nivel: ' + nivelInfo.titulo.toLowerCase(),
    ';  ' + (opts.generadoEn ?? new Date().toISOString()),
    ';',
    ';  CÓMO IMPORTARLO EN CLOUDFLARE',
    ';    DNS  →  Records  →  Import and Export  →  Import DNS records',
    ';    y sube este fichero.',
    ';',
    ';  IMPORTANTE, LÉELO ANTES DE IMPORTAR',
    ';    Al terminar, comprueba que los registros quedan en GRIS (DNS only).',
    ';    Con la nube naranja el correo NO funciona: Cloudflare no hace de',
    ';    intermediario en SMTP ni en IMAP, así que el MX apuntaría a sus',
    ';    servidores en vez de al tuyo y no recibirías nada.',
    ';',
    ';    Importar NO borra lo que ya tengas. Si ya existe un SPF en este',
    ';    dominio, acabarás con dos y ninguno valdrá: deja solo uno,',
    ';    combinando lo que necesites en una única línea v=spf1.',
  ];

  if (incluyeMtaSts) {
    cabecera.push(
      ';',
      ';  MTA-STS incluido: además del registro, tienes que publicar el fichero',
      ';    https://mta-sts.' + opts.domain + '/.well-known/mta-sts.txt',
      ';    Sin él, el registro no hace nada.',
    );
  }

  const cuerpo = seleccion.map((r) => lineaRegistro(r, ttl));

  return [
    ...cabecera,
    '',
    `$TTL ${ttl}`,
    '',
    ...cuerpo,
    '',
  ].join('\n');
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
 * simplemente rompe el correo, y con DMARC en `p=reject` lo rebota.
 * Por eso se comprueba ANTES de que el usuario descargue nada.
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
      'Un dominio solo puede tener un proveedor recibiendo: si importas estos registros, el correo que llegue se repartirá entre los dos servidores y la mitad se perderá.',
    ];
    if (spfActual) {
      partes.push(
        `Además ya tiene un SPF (${spfActual}) y solo puede haber uno: con dos, ninguno vale.`,
      );
    }
    if (dmarcPolitica === 'reject') {
      partes.push(
        'Y su DMARC está en p=reject, así que un SPF roto no manda a spam: hace que rebote el correo.',
      );
    }
    partes.push('Si de verdad quieres mover este dominio a Mailway, es una migración planificada, no una importación.');
    aviso = partes.join(' ');
  }

  return { hayOtroProveedor, mxActuales, spfActual, dmarcPolitica, aviso };
}
