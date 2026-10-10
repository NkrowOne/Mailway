/**
 * Identidad del servidor que fija el entorno del panel, es decir, el
 * instalador: MAILWAY_MAIL_HOSTNAME, MAILWAY_PUBLIC_IP, MAILWAY_WEBMAIL_URL y
 * MAILWAY_PANEL_URL.
 *
 * Lo que la administración cambia en Ajustes no se pisa. Pero el entorno
 * también cambia: el instalador vuelve a ejecutarse con otro dominio o con la
 * IP de un servidor nuevo. Antes, el panel se quedaba para siempre con los
 * valores de la primera vez, porque guardar la identidad guarda todos sus
 * campos. Así, el motor, el certificado y Traefik pasaban al nombre nuevo, el
 * panel seguía publicando el viejo y el emparejado devolvía el motor a él.
 *
 * Para distinguir los dos casos se guarda el último valor del entorno que se
 * ha aplicado a cada campo (ajuste `instance_env`). Si lo guardado sigue
 * siendo ese valor, nadie lo ha tocado y se adopta el nuevo. Si no, se
 * conserva y se avisa con los dos valores. Cuando quien ejecuta el instalador
 * confirma expresamente un cambio de nombres o de IP, el instalador pide
 * adoptarlo (tools/identidad.ts) aunque el campo se hubiera cambiado a mano o
 * el panel sea anterior a este registro.
 */
import { db } from '../core/db';
import { normalizeHostname } from '../core/hostnames';
import { fireAlert, resolveAlert } from './alerts';
import { refreshAutoconfigHosts } from './autoconfig';
import { auditSystem } from './audit';
import {
  type InstanceSettings,
  getEngineSettings,
  getJsonSetting,
  normalizePanelUrl,
  setInstanceSettings,
  setJsonSetting,
} from './settings';
import { applyRecommendedQuietly, guardable, INSTANCE_FROM_ENV, instanceSchema, type RecommendedOutcome } from './setup';

export type CampoEntorno = (typeof INSTANCE_FROM_ENV)[number][0];

/** Ajuste con el último valor del entorno aplicado a cada campo. */
const ULTIMO_ENTORNO = 'instance_env';

/** Tipo de los avisos: su clave lleva el campo y los dos valores. */
export const ALERTA_ENTORNO = 'instance_env_mismatch';

/** Nombres con los que el instalador pide adoptar cada campo (tools/identidad.ts). */
export const CAMPO_POR_NOMBRE: Readonly<Record<string, CampoEntorno>> = {
  servidor: 'mailHostname',
  ip: 'publicIp',
  webmail: 'webmailUrl',
  panel: 'panelUrl',
};

const ETIQUETA: Record<CampoEntorno, string> = {
  mailHostname: 'el nombre del servidor de correo',
  publicIp: 'la IP pública del servidor',
  webmailUrl: 'la dirección del webmail',
  panelUrl: 'la dirección del panel',
};

export interface CambioDeEntorno {
  campo: CampoEntorno;
  variable: string;
  antes: string;
  despues: string;
}

export interface Discrepancia {
  campo: CampoEntorno;
  variable: string;
  guardado: string;
  entorno: string;
  /**
   * No hay registro del valor que aplicó el instalador (panel anterior a
   * `instance_env`): no se sabe si lo guardado vino de él o de la
   * administración.
   */
  sinRegistro: boolean;
}

export interface ResultadoSincronizacion {
  /** Campos vacíos que se han rellenado con el entorno (solo con `rellenar`). */
  rellenados: CampoEntorno[];
  /** Campos que tenían el valor anterior del entorno y pasan al nuevo. */
  cambios: CambioDeEntorno[];
  /** Campos cambiados en el panel que no coinciden con el entorno: se conservan. */
  discrepancias: Discrepancia[];
  /** Lo que conviene decir a quien ejecuta la herramienta, sin secretos. */
  avisos: string[];
}

export interface OpcionesSincronizacion {
  /** Rellena los campos que aún no se han guardado (el emparejado). */
  rellenar?: boolean;
  /** Campos cuyo valor del entorno se adopta aunque se cambiaran en el panel. */
  adoptar?: readonly CampoEntorno[];
  /** No cambia nada: solo revisa los avisos (tras guardar Ajustes). */
  soloRevisar?: boolean;
}

/** Forma comparable de un valor: el DNS y las URL no distinguen mayúsculas en el nombre. */
function comparable(campo: CampoEntorno, valor: string): string {
  const v = valor.trim();
  if (campo === 'mailHostname') return normalizeHostname(v);
  if (campo === 'panelUrl' || campo === 'webmailUrl') {
    try {
      return normalizePanelUrl(v).toLowerCase();
    } catch {
      return v.toLowerCase();
    }
  }
  return v;
}

function mismoValor(campo: CampoEntorno, a: string, b: string): boolean {
  return comparable(campo, a) === comparable(campo, b);
}

/**
 * Compara la identidad guardada con la del entorno y adopta lo que proceda
 * (salvo con `soloRevisar`). Nunca lanza: lo que no se pueda guardar queda en
 * los avisos. Abre o cierra los avisos del panel de las discrepancias.
 */
export function sincronizarIdentidadConEntorno(opciones: OpcionesSincronizacion = {}): ResultadoSincronizacion {
  const { rellenar = false, adoptar = [], soloRevisar = false } = opciones;
  const guardada = getJsonSetting<Partial<InstanceSettings>>('instance') || {};
  const ultimo = getJsonSetting<Partial<Record<CampoEntorno, string>>>(ULTIMO_ENTORNO) || {};
  const nuevoUltimo: Partial<Record<CampoEntorno, string>> = { ...ultimo };
  const patch: Partial<Record<CampoEntorno, string>> = {};
  const resultado: ResultadoSincronizacion = { rellenados: [], cambios: [], discrepancias: [], avisos: [] };

  for (const [campo, variable, leer] of INSTANCE_FROM_ENV) {
    const crudo = leer().trim();
    if (!crudo) continue;
    const parsed = instanceSchema.shape[campo].safeParse(crudo);
    if (!parsed.success || !parsed.data || !guardable(campo, parsed.data)) {
      // Sin repetir el valor: podría llevar algo que no debe acabar en un registro.
      resultado.avisos.push(`El valor de ${variable} del entorno del panel no es válido y no se ha guardado.`);
      continue;
    }
    const entorno = parsed.data;
    const actual = (guardada[campo] ?? '').trim();
    if (!actual) {
      // Sin guardar, el panel ya usa el valor del entorno (getInstanceSettings)
      // y cualquier guardado de la identidad, aunque sea de otro campo, lo
      // fija tal cual: se anota ya como el último aplicado, para que un
      // cambio posterior del entorno se reconozca como tal.
      if (soloRevisar) continue;
      nuevoUltimo[campo] = entorno;
      if (rellenar) {
        patch[campo] = entorno;
        resultado.rellenados.push(campo);
      }
      continue;
    }
    if (mismoValor(campo, actual, entorno)) {
      nuevoUltimo[campo] = entorno;
      continue;
    }
    const anterior = ultimo[campo];
    const intacto = anterior !== undefined && mismoValor(campo, actual, anterior);
    if (intacto || adoptar.includes(campo)) {
      // Al revisar no se adopta nada: lo hará el siguiente arranque.
      if (soloRevisar) continue;
      patch[campo] = entorno;
      nuevoUltimo[campo] = entorno;
      resultado.cambios.push({ campo, variable, antes: actual, despues: entorno });
      continue;
    }
    resultado.discrepancias.push({ campo, variable, guardado: actual, entorno, sinRegistro: anterior === undefined });
  }

  if (!soloRevisar && Object.keys(patch).length > 0) {
    try {
      setInstanceSettings(patch);
    } catch (err) {
      // guardable() ya descarta lo que se rechazaría; si aun así falla, la
      // identidad se revisa en el panel y quien llama sigue.
      const motivo = err instanceof Error ? ` (${err.message})` : '';
      resultado.avisos.push(
        `No se ha podido guardar la identidad del servidor del entorno del panel${motivo}. Revísala en Ajustes → Identidad del servidor.`,
      );
      resultado.rellenados = [];
      resultado.cambios = [];
      return resultado;
    }
  }
  if (!soloRevisar && JSON.stringify(nuevoUltimo) !== JSON.stringify(ultimo)) {
    setJsonSetting(ULTIMO_ENTORNO, nuevoUltimo);
  }

  for (const d of resultado.discrepancias) {
    resultado.avisos.push(
      `En Ajustes figura ${d.guardado} como ${ETIQUETA[d.campo]}, pero ${d.variable} del entorno del panel (el instalador) trae ${d.entorno}. ` +
        `Se conserva ${d.guardado} porque ${motivoConservado(d)}; si el correcto es ${d.entorno}, cámbialo en Ajustes → Identidad del servidor.`,
    );
  }
  try {
    evaluarAvisosDeEntorno(resultado.discrepancias);
  } catch {
    // Los avisos del panel son un extra: la identidad ya está guardada y los
    // avisos de texto se devuelven igual.
  }
  return resultado;
}

/**
 * Tras guardar Ajustes: abre o cierra los avisos de las diferencias con el
 * entorno sin adoptar nada (el entorno no cambia mientras el servidor corre).
 */
export function revisarIdentidadConEntorno(): void {
  try {
    sincronizarIdentidadConEntorno({ soloRevisar: true });
  } catch {
    // Solo son avisos: guardar Ajustes no depende de esto.
  }
}

/**
 * Por qué se conserva lo guardado. Sin registro no se puede afirmar que se
 * cambiara en el panel: es lo que ocurre en el primer arranque de un panel
 * anterior a `instance_env`, también cuando el instalador acaba de cambiar el
 * dominio y va a pedir que se adopte (tools/identidad.ts).
 */
function motivoConservado(d: Discrepancia): string {
  return d.sinRegistro
    ? 'no consta si lo fijó el instalador o se cambió en el panel'
    : 'se cambió en el panel';
}

/** Lo que usa el valor del instalador cuando el panel conserva otro (nombre del servidor o IP). */
function consecuencia(d: Discrepancia): string {
  return d.campo === 'mailHostname'
    ? `lo que configura el instalador (las rutas de Traefik, el certificado de IMAP y SMTP y deploy/.env) usa ${d.entorno}`
    : `deploy/.env y los registros A que crea el instalador usan ${d.entorno}`;
}

/**
 * Campos cuya diferencia con el entorno abre un aviso en el panel: el nombre
 * del servidor y la IP deciden el certificado, el DNS, el PTR y lo que el
 * motor anuncia. Las URL del webmail y del panel no: una propia que funcione
 * es legítima (Skyway conserva además la del instalador) y, si el webmail no
 * responde, ya avisa el vigilante; su diferencia solo se dice a quien ejecuta
 * el instalador o en el registro del servidor.
 */
const CON_AVISO: readonly CampoEntorno[] = ['mailHostname', 'publicIp'];

/**
 * Un aviso por campo que no coincide con el entorno; se cierran los que ya no
 * describen la situación (se corrigió o cambió alguno de los dos valores).
 */
function evaluarAvisosDeEntorno(discrepancias: Discrepancia[]): void {
  const vigentes = new Set<string>();
  for (const d of discrepancias.filter((x) => CON_AVISO.includes(x.campo))) {
    const clave = `${ALERTA_ENTORNO}:${d.campo}:${comparable(d.campo, d.guardado)}>${comparable(d.campo, d.entorno)}`;
    vigentes.add(clave);
    fireAlert({
      severity: 'warning',
      type: ALERTA_ENTORNO,
      dedupeKey: clave,
      // Sin registro, solo la campana del panel: al cambiar el dominio de un
      // panel anterior a este registro, el aviso se abre en su primer arranque
      // y el instalador lo cierra segundos después al adoptar los valores
      // nuevos; enviarlo a los canales sería una falsa alarma. Si nadie lo
      // adopta, sigue a la vista en el panel.
      quiet: d.sinRegistro,
      title: `Ajustes y el instalador no coinciden en ${ETIQUETA[d.campo]}`,
      message:
        `En Ajustes → Identidad del servidor figura ${d.guardado}; el instalador configuró ${d.entorno} (${d.variable} del entorno del panel). ` +
        `Se conserva ${d.guardado} porque ${motivoConservado(d)}, pero ${consecuencia(d)}.`,
      remedy:
        `Si el correcto es ${d.entorno}, cámbialo en Ajustes → Identidad del servidor${
          d.campo === 'mailHostname' ? ' y pulsa «Aplicar ajustes recomendados» en Ajustes → Servidor de correo' : ''
        }. Si es ${d.guardado}, vuelve a ejecutar el instalador con ese valor (sección 8.3 de docs/DESPLIEGUE-SKYWAY.md) para que también lo use todo lo demás.`,
    });
  }
  const abiertas = db
    .prepare('SELECT DISTINCT dedupe_key FROM alerts WHERE type = ? AND resolved_at IS NULL AND dedupe_key IS NOT NULL')
    .all(ALERTA_ENTORNO) as { dedupe_key: string }[];
  for (const { dedupe_key: clave } of abiertas) {
    if (!vigentes.has(clave)) resolveAlert(clave);
  }
}

/** Para la Actividad: qué campos han cambiado, sin nada secreto (nombres, URL e IP). */
export function detalleDeCambios(cambios: CambioDeEntorno[]): { campo: CampoEntorno; antes: string; despues: string }[] {
  return cambios.map(({ campo, antes, despues }) => ({ campo, antes, despues }));
}

/**
 * Tras adoptar valores del entorno: los nombres de autoconfiguración que se
 * publican dependen del nombre y de la IP, y el motor debe anunciarse con el
 * nombre nuevo (si no, el vigilante avisaría de la diferencia y los MX que
 * propone el motor seguirían con el viejo).
 */
export async function aplicarTrasAdoptar(cambios: CambioDeEntorno[]): Promise<RecommendedOutcome | null> {
  if (cambios.some((c) => c.campo === 'mailHostname' || c.campo === 'publicIp')) {
    void refreshAutoconfigHosts().catch(() => undefined);
  }
  if (!cambios.some((c) => c.campo === 'mailHostname')) return null;
  return applyRecommendedQuietly(getEngineSettings());
}

interface Registro {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * Al arrancar el servidor: el entorno solo cambia con un arranque nuevo (el
 * instalador recrea el contenedor o Skyway lo vuelve a desplegar). Nunca
 * lanza ni impide el arranque.
 */
export async function adoptarEntornoAlArrancar(registro: Registro): Promise<void> {
  let resultado: ResultadoSincronizacion;
  try {
    resultado = sincronizarIdentidadConEntorno();
  } catch (err) {
    registro.warn(`No se ha podido comparar la identidad del servidor con el entorno: ${(err as Error).message}`);
    return;
  }
  for (const aviso of resultado.avisos) registro.warn(aviso);
  if (resultado.cambios.length === 0) return;
  auditSystem('settings.instance_env_adopted', { cambios: detalleDeCambios(resultado.cambios), origen: 'arranque' });
  registro.info(
    `Identidad del servidor actualizada con el entorno: ${resultado.cambios
      .map((c) => `${c.variable} ${c.antes} → ${c.despues}`)
      .join('; ')}.`,
  );
  try {
    const aplicado = await aplicarTrasAdoptar(resultado.cambios);
    if (aplicado && !aplicado.applied) {
      registro.warn(
        'El motor no aceptó los ajustes recomendados con el nombre nuevo; repítelo en Ajustes → Servidor de correo.',
      );
    }
  } catch {
    // applyRecommendedQuietly no lanza; aun así, el arranque no depende de esto.
  }
}
