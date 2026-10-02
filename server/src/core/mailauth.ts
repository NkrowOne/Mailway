import { normalizeHostname } from './hostnames';

/**
 * Lectura de SPF y DMARC: qué registro es de cada tipo, qué política declara
 * y si un SPF autoriza de verdad al servidor. Una sola definición para la
 * comprobación DNS de los dominios, el plan de Cloudflare y el aviso de otro
 * proveedor: si cada uno los leyera a su manera, Cloudflare «conservaría» un
 * SPF que la comprobación da por incorrecto y el dominio nunca quedaría activo.
 */

/* ----------------------------------- SPF ---------------------------------- */

/** ¿Es un registro SPF? «v=spf1» seguido de un espacio o del final (RFC 7208 §4.5). */
export function esSpf(txt: string): boolean {
  return /^v=spf1(\s|$)/i.test(txt.trim());
}

const ES_ALL = /^[-~?+]?all$/;
/** Modificadores («redirect=», «exp=», «ra=»…): no autorizan a nadie por sí mismos. */
const ES_MODIFICADOR = /^[a-z][a-z0-9_.-]*=/;

/**
 * Mecanismos que autorizan (calificador «+» explícito o implícito), sin el
 * «+», separados en los que se evalúan y los que van detrás del primer «all».
 * Un receptor recorre el SPF de izquierda a derecha y se detiene en «all»:
 * lo que va detrás nunca se consulta (RFC 7208 §5.1), así que un «mx» escrito
 * después de «-all» no autoriza a este servidor.
 */
function autorizantes(spf: string): { evaluados: string[]; detras: string[] } {
  const evaluados: string[] = [];
  const detras: string[] = [];
  let trasAll = false;
  for (const termino of spf.trim().toLowerCase().split(/\s+/).slice(1)) {
    if (!termino) continue;
    if (ES_ALL.test(termino)) {
      trasAll = true;
      continue;
    }
    if (ES_MODIFICADOR.test(termino) || /^[-~?]/.test(termino)) continue;
    (trasAll ? detras : evaluados).push(termino.replace(/^\+/, ''));
  }
  return { evaluados, detras };
}

/** «mx» y «a» con sus variantes: «mx:dominio», «mx/24», «a//64», «mx:dominio/24». */
const MX_O_A = /^(mx|a)(?::([^/]+))?(?:\/\d{1,2})?(?:\/\/\d{1,3})?$/;

function ipv4ANumero(ip: string): number | null {
  const partes = ip.trim().split('.');
  if (partes.length !== 4) return null;
  let n = 0;
  for (const parte of partes) {
    if (!/^\d{1,3}$/.test(parte) || Number(parte) > 255) return null;
    n = n * 256 + Number(parte);
  }
  return n;
}

/** ¿Autoriza «ip4:red[/bits]» a la IPv4 indicada? */
function ip4Incluye(termino: string, ip: string): boolean {
  const m = /^ip4:([\d.]+)(?:\/(\d{1,2}))?$/.exec(termino);
  if (!m) return false;
  const red = ipv4ANumero(m[1]!);
  const objetivo = ipv4ANumero(ip);
  const bits = m[2] === undefined ? 32 : Number(m[2]);
  if (red === null || objetivo === null || bits > 32) return false;
  // Con división y no con operadores de bits: en JavaScript trabajan con
  // enteros de 32 bits con signo y las IP por encima de 128.0.0.0 saldrían negativas.
  const bloque = 2 ** (32 - bits);
  return Math.floor(red / bloque) === Math.floor(objetivo / bloque);
}

export interface ContextoSpf {
  /** Nombre donde se publica el SPF: «mx:<nombre>» equivale a «mx». */
  nombre?: string;
  /** IPv4 pública del servidor: «ip4:<IP o una red que la contenga>» también lo autoriza. */
  ipServidor?: string;
}

/**
 * ¿Cubren los mecanismos `terminos` al mecanismo `necesario` del SPF que
 * propone el motor? Valen el mismo mecanismo («mx», «+mx», «include:…»,
 * «ip4:…» como hasta ahora) y, para «mx» y «a», sus variantes sobre el propio
 * nombre («mx:dominio», «mx/24») y una «ip4:» que contenga la IP del
 * servidor. «mx:otro-dominio» no cuenta: autoriza los servidores de correo
 * de otro dominio, que no tienen por qué ser este.
 */
function cubre(necesario: string, terminos: string[], ctx: ContextoSpf): boolean {
  if (terminos.includes(necesario)) return true;
  if (necesario !== 'mx' && necesario !== 'a') return false;
  const nombre = ctx.nombre ? normalizeHostname(ctx.nombre) : '';
  return terminos.some((termino) => {
    const m = MX_O_A.exec(termino);
    if (m) return m[1] === necesario && (m[2] === undefined || (nombre !== '' && normalizeHostname(m[2]) === nombre));
    return Boolean(ctx.ipServidor) && ip4Incluye(termino, ctx.ipServidor!);
  });
}

/**
 * Qué mecanismos del SPF propuesto (`esperado`, normalmente «mx») no autoriza
 * el SPF publicado (`encontrado`). `detrasDeAll` son los que sí aparecen,
 * pero detrás de «all», donde no se evalúan.
 */
export function diagnosticoSpf(
  encontrado: string,
  esperado: string,
  ctx: ContextoSpf = {},
): { faltan: string[]; detrasDeAll: string[] } {
  const { evaluados, detras } = autorizantes(encontrado);
  const faltan = autorizantes(esperado).evaluados.filter((m) => !cubre(m, evaluados, ctx));
  return { faltan, detrasDeAll: faltan.filter((m) => cubre(m, detras, ctx)) };
}

/**
 * Un SPF distinto del propuesto también vale si autoriza, antes de «all», lo
 * mismo que el del motor: así se respeta el SPF de un dominio que además
 * envía por otros servicios (Google, un CRM…).
 */
export function spfCubre(encontrado: string, esperado: string, ctx: ContextoSpf = {}): boolean {
  return autorizantes(esperado).evaluados.length > 0 && diagnosticoSpf(encontrado, esperado, ctx).faltan.length === 0;
}

/* ---------------------------------- DMARC --------------------------------- */

export type PoliticaDmarc = 'none' | 'quarantine' | 'reject';

/**
 * ¿Es un registro DMARC? La primera etiqueta tiene que ser «v=DMARC1»; se
 * admiten espacios alrededor de «=» y de «;» (RFC 7489 §6.4).
 */
export function esDmarc(txt: string): boolean {
  return /^v\s*=\s*dmarc1\s*(;|$)/i.test(txt.trim());
}

/** Etiquetas de un DMARC (clave en minúsculas → valor sin espacios alrededor). */
export function etiquetasDmarc(txt: string): Map<string, string> {
  const etiquetas = new Map<string, string>();
  for (const parte of txt.split(';')) {
    const igual = parte.indexOf('=');
    if (igual === -1) continue;
    const clave = parte.slice(0, igual).trim().toLowerCase();
    // La primera aparición manda; una etiqueta repetida no la sustituye.
    if (clave && !etiquetas.has(clave)) etiquetas.set(clave, parte.slice(igual + 1).trim());
  }
  return etiquetas;
}

/**
 * Política de un DMARC (la etiqueta «p», no «sp», que es la de los
 * subdominios). null si no es un DMARC o la política falta o no es válida.
 */
export function politicaDmarc(txt: string): PoliticaDmarc | null {
  if (!esDmarc(txt)) return null;
  const p = etiquetasDmarc(txt).get('p')?.toLowerCase();
  return p === 'none' || p === 'quarantine' || p === 'reject' ? p : null;
}
