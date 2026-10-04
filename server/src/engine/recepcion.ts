/**
 * Reglas de Stalwart 0.15 para los dominios que tienen buzones aquí pero
 * reciben su correo en otro servidor (su MX público apunta a otro proveedor):
 * un traslado en preparación o un dominio que solo envía desde Mailway.
 *
 * Por qué hacen falta: para Stalwart, un dominio que existe es local para
 * todo el servidor. Sin estas reglas, lo que se envía desde aquí a una
 * dirección de ese dominio (otros clientes, la web, la API de envío, los
 * formularios) se entrega en el buzón local, que nadie lee todavía, o se
 * rechaza con «550 Mailbox does not exist» si la dirección solo existe en el
 * otro proveedor.
 *
 * Qué hacen (verificado contra una 0.15.5 real):
 * - `session.rcpt.directory`: en las sesiones AUTENTICADAS, los destinatarios
 *   de esos dominios no se validan contra el directorio. Pasan por
 *   `session.rcpt.relay`, que por defecto permite reenviar a quien se ha
 *   autenticado. Las sesiones sin autenticar (correo de Internet que llega
 *   por el puerto 25) se validan como siempre: si alguien entrega aquí es
 *   porque el MX ya apunta a este servidor.
 * - `queue.strategy.route` y `queue.strategy.schedule`: lo que se origina en
 *   este servidor (todo menos lo recibido de Internet, `source` distinto de
 *   «unauthenticated» y «dmarc_pass») se entrega por MX y en la cola remota.
 *   Lo recibido de Internet sigue en local: así, si el MX acaba de pasar a
 *   este servidor y la lista aún no se ha actualizado, el mensaje que sale
 *   por MX y vuelve aquí se entrega en local y no da vueltas.
 *
 * La ruta se evalúa en cada intento de entrega: al sacar un dominio de la
 * lista, lo que esperaba en la cola se entrega en local en el siguiente.
 *
 * Mailway es el dueño de estas tres claves. Si el administrador del motor las
 * ha personalizado (valores que no coinciden con lo que Mailway escribiría),
 * no se tocan (esReglaDeMailway).
 */

/** Claves que gestiona Mailway en el motor (cada una es un bloque «if/then/else»). */
export const CLAVES_RECEPCION = ['session.rcpt.directory', 'queue.strategy.route', 'queue.strategy.schedule'] as const;

/** Solo nombres DNS en ASCII: nada que pueda cerrar la comilla de la expresión. */
const DOMINIO_SEGURO = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

function indice(n: number): string {
  return String(n).padStart(4, '0');
}

/** `(rcpt_domain == 'a.es' || rcpt_domain == 'b.es')` */
function condicionDominios(dominios: string[]): string {
  return `(${dominios.map((d) => `rcpt_domain == '${d}'`).join(' || ')})`;
}

/** Dominios válidos, en minúsculas, sin repetir y ordenados (la salida es estable). */
export function normalizarDominiosRemotos(dominios: string[]): string[] {
  return [...new Set(dominios.map((d) => d.trim().toLowerCase().replace(/\.$/, '')))]
    .filter((d) => DOMINIO_SEGURO.test(d))
    .sort();
}

/**
 * Ajustes completos (clave → valor) para la lista de dominios. Lista vacía →
 * {}: el motor vuelve a sus valores por defecto. Los valores por defecto de
 * Stalwart 0.15.5 (crates/common/src/config/smtp/queue.rs y session.rs) se
 * repiten detrás de la regla de Mailway, porque escribir el bloque sustituye
 * el predeterminado entero.
 */
export function reglasRecepcionRemota(dominiosEntrada: string[]): Record<string, string> {
  const dominios = normalizarDominiosRemotos(dominiosEntrada);
  if (dominios.length === 0) return {};
  const lista = condicionDominios(dominios);
  const originadoAqui = `source != 'unauthenticated' && source != 'dmarc_pass' && ${lista}`;
  const filas: [string, string][] = [];
  const bloque = (clave: string, pares: [string, string][], porDefecto: string) => {
    pares.forEach(([si, entonces], i) => {
      filas.push([`${clave}.${indice(i)}.if`, si], [`${clave}.${indice(i)}.then`, entonces]);
    });
    filas.push([`${clave}.${indice(pares.length)}.else`, porDefecto]);
  };
  bloque('session.rcpt.directory', [[`!is_empty(authenticated_as) && ${lista}`, 'false']], "'*'");
  bloque(
    'queue.strategy.route',
    [
      [originadoAqui, "'mx'"],
      ["is_local_domain('*', rcpt_domain)", "'local'"],
    ],
    "'mx'",
  );
  bloque(
    'queue.strategy.schedule',
    [
      [originadoAqui, "if_then(source == 'dsn', 'dsn', if_then(source == 'report', 'report', 'remote'))"],
      ["is_local_domain('*', rcpt_domain)", "'local'"],
      ["source == 'dsn'", "'dsn'"],
      ["source == 'report'", "'report'"],
    ],
    "'remote'",
  );
  return Object.fromEntries(filas);
}

/** Dominios de una regla escrita por Mailway (leídos de session.rcpt.directory). */
function dominiosDe(actuales: Record<string, string>): string[] {
  const condicion = actuales['session.rcpt.directory.0000.if'] ?? '';
  return [...condicion.matchAll(/rcpt_domain == '([^']+)'/g)].map((m) => m[1]!);
}

function mismasEntradas(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/**
 * ¿Son estos valores (las claves gestionadas tal como están en el motor) los
 * que escribiría Mailway para alguna lista de dominios, o no hay ninguno? Un
 * valor directo (`queue.strategy.route = "..."`, sin bloque) o cualquier
 * diferencia es una personalización del administrador del motor.
 */
export function esReglaDeMailway(actuales: Record<string, string>): boolean {
  if (Object.keys(actuales).length === 0) return true;
  return mismasEntradas(actuales, reglasRecepcionRemota(dominiosDe(actuales)));
}

export function reglasIguales(actuales: Record<string, string>, deseadas: Record<string, string>): boolean {
  return mismasEntradas(actuales, deseadas);
}

/** Solo las claves gestionadas (y sus bloques) de un volcado de ajustes del motor. */
export function soloClavesDeRecepcion(ajustes: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [clave, valor] of Object.entries(ajustes)) {
    if (CLAVES_RECEPCION.some((c) => clave === c || clave.startsWith(`${c}.`))) out[clave] = valor;
  }
  return out;
}
