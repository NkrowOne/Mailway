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
  /**
   * Nombre del servidor de correo (Ajustes): «a:<nombre>» autoriza a este
   * servidor esté donde esté el MX del dominio.
   */
  servidor?: string;
  /**
   * ¿Apunta el MX del dominio a este servidor? «mx» solo autoriza a este
   * servidor si es así. undefined o null = no se sabe (no se pudo consultar):
   * se da por bueno, para no marcar como incorrecto un SPF por un corte de red.
   */
  mxPropio?: boolean | null;
}

/** «a:<nombre>» con sus variantes de red («a:<nombre>/24», «a:<nombre>//64»). */
function esADelServidor(termino: string, ctx: ContextoSpf): boolean {
  const m = MX_O_A.exec(termino);
  if (!m || m[1] !== 'a' || m[2] === undefined || !ctx.servidor) return false;
  return normalizeHostname(m[2]) === normalizeHostname(ctx.servidor);
}

/** «mx» sobre el propio nombre («mx», «mx:dominio», «mx/24»…). */
function esMxPropio(termino: string, nombre: string): boolean {
  const m = MX_O_A.exec(termino);
  return Boolean(m) && m![1] === 'mx' && (m![2] === undefined || (nombre !== '' && normalizeHostname(m![2]) === nombre));
}

/**
 * ¿Cubren los mecanismos `terminos` al mecanismo `necesario` del SPF que se
 * propone? Vale el mismo mecanismo («mx», «+mx», «include:…», «ip4:…») y,
 * para los que autorizan a ESTE servidor, sus equivalentes:
 * - «a:<servidor>» (lo que propone Mailway) lo cubren «a:<servidor>» con
 *   prefijo de red, una «ip4:» que contenga la IP del servidor y «mx» sobre
 *   el propio nombre si el MX del dominio apunta aquí;
 * - «mx» (lo que propone el motor) lo cubren sus variantes sobre el propio
 *   nombre («mx:dominio», «mx/24»), «a:<servidor>» y la «ip4:» del servidor;
 * - «a» (el SPF del propio nombre del servidor), sus variantes sobre el
 *   propio nombre y la «ip4:».
 * «mx:otro-dominio» no cuenta: autoriza los servidores de correo de otro
 * dominio, que no tienen por qué ser este. Un «include:» tampoco se resuelve.
 */
function cubre(necesario: string, terminos: string[], ctx: ContextoSpf): boolean {
  if (terminos.includes(necesario)) return true;
  const nombre = ctx.nombre ? normalizeHostname(ctx.nombre) : '';
  const ip = (t: string) => Boolean(ctx.ipServidor) && ip4Incluye(t, ctx.ipServidor!);
  if (esADelServidor(necesario, ctx)) {
    return terminos.some((t) => esADelServidor(t, ctx) || ip(t) || (ctx.mxPropio !== false && esMxPropio(t, nombre)));
  }
  if (necesario === 'mx') {
    return terminos.some((t) => esMxPropio(t, nombre) || esADelServidor(t, ctx) || ip(t));
  }
  if (necesario === 'a') {
    return terminos.some((t) => {
      const m = MX_O_A.exec(t);
      if (m) return m[1] === 'a' && (m[2] === undefined || (nombre !== '' && normalizeHostname(m[2]) === nombre));
      return ip(t);
    });
  }
  return false;
}

/**
 * Qué mecanismos del SPF propuesto (`esperado`) no autoriza el SPF publicado
 * (`encontrado`). `detrasDeAll` son los que sí aparecen, pero detrás de
 * «all», donde no se evalúan.
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
 * mismo que el propuesto: así se respeta el SPF de un dominio que además
 * envía por otros servicios (Google, un CRM…).
 */
export function spfCubre(encontrado: string, esperado: string, ctx: ContextoSpf = {}): boolean {
  return autorizantes(esperado).evaluados.length > 0 && diagnosticoSpf(encontrado, esperado, ctx).faltan.length === 0;
}

/* ------------------------ Límite de consultas del SPF ---------------------- */

/** RFC 7208 §4.6.4: más de 10 consultas DNS y el SPF entero da «permerror». */
export const MAX_CONSULTAS_SPF = 10;

/**
 * Sin poder resolver los include (sin red), se cuentan solo los términos de
 * primer nivel y se deja margen para los anidados: cada include de un gran
 * proveedor gasta varias consultas más.
 */
export const MAX_CONSULTAS_SPF_SIN_RESOLVER = 8;

/** Términos que gastan una consulta DNS: include, a, mx, ptr, exists y redirect. */
function gastaConsulta(termino: string): boolean {
  const t = termino.toLowerCase().replace(/^[-~?+]/, '');
  return /^(include:|exists:|redirect=)/.test(t) || /^(a|mx|ptr)([:/]|$)/.test(t);
}

/** Consultas DNS de primer nivel de un SPF (sin seguir los include). */
export function consultasSpfPrimerNivel(spf: string): number {
  return spf.trim().split(/\s+/).slice(1).filter(gastaConsulta).length;
}

/**
 * Consultas DNS que gasta de verdad un SPF, siguiendo sus include y su
 * redirect. Se detiene al pasar del límite (no hace falta saber más) y no
 * repite un nombre ya visto (bucles). null si alguna consulta no se pudo
 * hacer: un corte de red no es un recuento.
 */
export async function contarConsultasSpf(
  spf: string,
  leerTxt: (nombre: string) => Promise<string[] | null>,
): Promise<number | null> {
  let total = 0;
  let sinDato = false;
  const vistos = new Set<string>();
  const recorrer = async (texto: string): Promise<void> => {
    for (const termino of texto.trim().split(/\s+/).slice(1)) {
      if (total > MAX_CONSULTAS_SPF || sinDato) return;
      if (!gastaConsulta(termino)) continue;
      total += 1;
      const destino = /^[-~?+]?(?:include:|redirect=)(.+)$/i.exec(termino)?.[1];
      if (!destino) continue;
      const nombre = normalizeHostname(destino);
      if (!nombre || vistos.has(nombre)) continue;
      vistos.add(nombre);
      const txt = await leerTxt(nombre);
      if (txt === null) {
        sinDato = true;
        return;
      }
      const anidado = txt.find(esSpf);
      if (anidado) await recorrer(anidado);
    }
  };
  await recorrer(spf);
  return sinDato ? null : total;
}

/**
 * Añade al SPF actual los mecanismos que faltan justo antes del primer
 * «all», sin tocar el resto: los include de otros servicios y el calificador
 * final (~all, -all) son decisiones del titular. Usa la misma lectura que la
 * comprobación DNS (diagnosticoSpf): un mecanismo escrito detrás de «all» no
 * cuenta, porque ningún receptor llega a leerlo. Devuelve null si no falta
 * nada. `consultas` es el recuento de primer nivel del resultado (para
 * compararlo con el límite cuando no se pueden resolver los include).
 */
export function fusionarSpf(
  actual: string,
  deseado: string,
  ctx: ContextoSpf = {},
): { valor: string; anadidos: string[]; consultasNuevas: number } | null {
  const { faltan } = diagnosticoSpf(actual, deseado, ctx);
  if (faltan.length === 0) return null;
  const tokens = actual.trim().split(/\s+/);
  const indice = tokens.findIndex((t, i) => i > 0 && /^[-~?+]?all$/i.test(t));
  if (indice === -1) tokens.push(...faltan);
  else tokens.splice(indice, 0, ...faltan);
  return { valor: tokens.join(' '), anadidos: faltan, consultasNuevas: faltan.filter(gastaConsulta).length };
}

/**
 * ¿Supera el SPF fusionado el límite de consultas? Con el recuento real del
 * SPF actual (`consultasActuales`, siguiendo los include), el límite es 10;
 * sin él, se cuentan los términos de primer nivel con margen (8).
 */
export function fusionExcedeConsultas(
  actual: string,
  consultasNuevas: number,
  consultasActuales: number | null,
): { excede: boolean; total: number; exacto: boolean } {
  if (consultasActuales !== null) {
    const total = consultasActuales + consultasNuevas;
    return { excede: total > MAX_CONSULTAS_SPF, total, exacto: true };
  }
  const total = consultasSpfPrimerNivel(actual) + consultasNuevas;
  return { excede: total > MAX_CONSULTAS_SPF_SIN_RESOLVER, total, exacto: false };
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
