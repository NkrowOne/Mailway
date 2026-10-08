import { useCallback, useEffect, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { VALIDEZ_ENLACE_HORAS, type EnlaceDePersona } from '../../components/EnlacesEquipo';
import { api, type Mailbox } from '../../lib/api';
import { formatDay } from '../../lib/format';
import { errorNombreBuzon, REMITENTE_CONFIGURACION } from '../../lib/gestion';
import type { EnlaceCreado } from '../../lib/portal';
import type { Veredicto } from '../../ui/kit';

/*
  Piezas de la puesta en marcha del cliente que no son vista: los pasos, lo
  que se recuerda en este navegador y las direcciones propuestas a partir del
  nombre de cada persona.
*/

/* ---------------------------------- Pasos ---------------------------------- */

export type PasoId = 'dominio' | 'equipo' | 'obligatorias' | 'dispositivos' | 'listo';

export const PASOS: { id: PasoId; rotulo: string }[] = [
  { id: 'dominio', rotulo: 'Tu dominio' },
  { id: 'equipo', rotulo: 'Tu equipo' },
  { id: 'obligatorias', rotulo: 'Direcciones obligatorias' },
  { id: 'dispositivos', rotulo: 'Tus dispositivos' },
  { id: 'listo', rotulo: 'Listo' },
];

export function esPaso(valor: string | null): valor is PasoId {
  return PASOS.some((p) => p.id === valor);
}

/* --------------------------- Lo que se recuerda ---------------------------- */

/*
  El estado de la puesta en marcha lo da el servidor (dominio, buzones,
  postmaster). Aquí solo queda lo que el servidor no sabe o no debe guardar:
  - en esta pestaña (sessionStorage), los enlaces recién creados y el
    borrador del equipo: sobreviven a una recarga, pero no a cerrar la
    pestaña, porque los enlaces llevan la contraseña de cada buzón;
  - en este navegador (localStorage), qué buzón es el de quien hace la
    puesta en marcha, el formato de direcciones elegido y si ya pasó por el
    paso de los dispositivos.
  Cualquier acceso puede fallar (ventana privada, almacenamiento bloqueado):
  la vista funciona igual, solo sin recordarlo.
*/

type Almacen = 'sesion' | 'local';

function almacen(tipo: Almacen): Storage | null {
  try {
    return tipo === 'sesion' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

export function leer<T>(clave: string, tipo: Almacen): T | null {
  try {
    const texto = almacen(tipo)?.getItem(clave);
    return texto ? (JSON.parse(texto) as T) : null;
  } catch {
    return null;
  }
}

export function guardar(clave: string, valor: unknown, tipo: Almacen): boolean {
  try {
    const a = almacen(tipo);
    if (!a) return false;
    if (valor === null || valor === undefined) a.removeItem(clave);
    else a.setItem(clave, JSON.stringify(valor));
    return true;
  } catch {
    return false;
  }
}

export function clave(clientId: string, nombre: string): string {
  return `mailway:puesta:${clientId}:${nombre}`;
}

/** Estado de React que además se guarda en el almacén indicado. */
export function useRecordado<T>(claveAlmacen: string, inicial: () => T, tipo: Almacen): [T, (v: T | ((p: T) => T)) => void] {
  const [valor, setValor] = useState<T>(() => leer<T>(claveAlmacen, tipo) ?? inicial());
  useEffect(() => {
    guardar(claveAlmacen, valor, tipo);
  }, [claveAlmacen, valor, tipo]);
  const fijar = useCallback((v: T | ((p: T) => T)) => setValor(v), []);
  return [valor, fijar];
}

/** Enlace de una persona creado en esta pestaña, con el buzón al que pertenece. */
export interface EnlaceGuardado extends EnlaceDePersona {
  mailboxId: string;
  /** Es el buzón de quien hace la puesta en marcha. */
  mio: boolean;
}

/** Quita los enlaces caducados: ya no sirven y llevan una contraseña dentro. */
export function vigentes(enlaces: EnlaceGuardado[]): EnlaceGuardado[] {
  const ahora = Date.now();
  return enlaces.filter((e) => e.expiresAt > ahora);
}

/* ------------------------- Direcciones propuestas -------------------------- */

export type Formato = 'nombre' | 'nombre.apellido' | 'inicial';

export const FORMATOS: { id: Formato; rotulo: string }[] = [
  { id: 'nombre.apellido', rotulo: 'nombre.apellido' },
  { id: 'nombre', rotulo: 'nombre' },
  { id: 'inicial', rotulo: 'inicial y apellido' },
];

/** Partículas que no son el apellido («María de la Fuente» → «fuente»). */
const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'i', 'e', 'da', 'das', 'do', 'dos', 'di', 'van', 'von', 'le']);

/** Minúsculas sin tildes ni signos: «Núñez-Peña» → «nunezpena». */
function normalizar(palabra: string): string {
  return palabra
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function palabras(nombre: string): string[] {
  // El guion y el apóstrofo unen (Ana-Belén → anabelen, D'Angelo →
  // dangelo); el resto de separadores, separan.
  return nombre
    .replace(/[-‐‑'’]/g, '')
    .split(/[\s.,;·"()]+/)
    .map(normalizar)
    .filter(Boolean);
}

/**
 * Dirección propuesta para una persona según el formato elegido. Es solo una
 * propuesta: el apellido se adivina y la fila deja corregirla.
 */
export function proponerDireccion(nombre: string, formato: Formato): string {
  const p = palabras(nombre);
  const pila = p[0] ?? '';
  // Con cuatro palabras o más suele ser nombre compuesto y dos apellidos
  // («José Luis Martín García»): el primer apellido es la penúltima. Con
  // menos, la segunda («Ana García López», «María de la Fuente»).
  const resto = p.slice(1).filter((x) => !PARTICULAS.has(x));
  const apellido = (resto.length >= 3 ? resto[resto.length - 2] : resto[0]) ?? '';
  let local = pila;
  if (formato === 'nombre.apellido' && apellido) local = `${pila}.${apellido}`;
  if (formato === 'inicial' && apellido) local = `${pila.slice(0, 1)}${apellido}`;
  return local.slice(0, 64).replace(/^[._-]+|[._-]+$/g, '');
}

/** Dirección escrita a mano: lo mismo que acepta el servidor, sin tildes ni mayúsculas. */
export function limpiarDireccion(valor: string): string {
  return valor
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .split('@')[0]!;
}

/* ------------------------------ Filas del equipo --------------------------- */

export interface FilaPersona {
  id: string;
  nombre: string;
  /** Lo que va antes de la @. */
  local: string;
  /** La dirección la ha escrito la persona: ya no se propone sola. */
  localEditado: boolean;
  /**
   * Correo que ya usa la persona, para enviarle su configuración. Solo llega
   * al servidor al enviarla (queda como destinatario de ese envío).
   */
  personal: string;
  /** Es quien hace la puesta en marcha. */
  mio: boolean;
}

let contador = 0;

/** Identificador local de fila (crypto.randomUUID no existe en un panel servido por HTTP). */
export function idFila(): string {
  contador += 1;
  return `f${Date.now().toString(36)}${contador}${Math.random().toString(36).slice(2, 6)}`;
}

export function filaNueva(formato: Formato, datos: Partial<FilaPersona> = {}): FilaPersona {
  const nombre = datos.nombre ?? '';
  return {
    id: idFila(),
    nombre,
    local: datos.local ?? proponerDireccion(nombre, formato),
    localEditado: datos.localEditado ?? false,
    personal: datos.personal ?? '',
    mio: datos.mio ?? false,
  };
}

/** Fila sin nada escrito: no cuenta ni se envía. */
export function filaVacia(f: FilaPersona): boolean {
  return !f.nombre.trim() && !f.local.trim() && !f.personal.trim();
}

/** Problema local de una fila (antes de preguntar al servidor), o null. */
export function errorFila(f: FilaPersona, repetidas: Set<string>): { campo: 'nombre' | 'local' | 'personal'; texto: string } | null {
  if (!f.nombre.trim()) return { campo: 'nombre', texto: 'Escribe el nombre de la persona.' };
  if (f.nombre.trim().length > 80) return { campo: 'nombre', texto: 'El nombre no puede superar los 80 caracteres.' };
  const local = f.local.trim();
  const error = errorNombreBuzon(local);
  if (error) return { campo: 'local', texto: local ? error : 'Escribe la dirección.' };
  if (repetidas.has(local)) return { campo: 'local', texto: 'Esta dirección está repetida en la lista.' };
  if (f.personal.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.personal.trim())) {
    return { campo: 'personal', texto: 'El correo personal no parece válido.' };
  }
  return null;
}

/** Direcciones que aparecen más de una vez en la lista. */
export function direccionesRepetidas(filas: FilaPersona[]): Set<string> {
  const vistas = new Set<string>();
  const repetidas = new Set<string>();
  for (const f of filas) {
    const local = f.local.trim();
    if (!local) continue;
    if (vistas.has(local)) repetidas.add(local);
    vistas.add(local);
  }
  return repetidas;
}

const CORREO_EN_LINEA = /[^\s<>,;"'()]+@[^\s<>,;"'()]+\.[^\s<>,;"'()]+/;

/**
 * Lista pegada: una persona por línea, como sale de una hoja de cálculo o de
 * un programa de correo. «Ana García», «Ana García, ana@gmail.com»,
 * «Ana García <ana@gmail.com>» o solo el correo personal.
 */
export function interpretarLista(texto: string): { nombre: string; personal: string }[] {
  const out: { nombre: string; personal: string }[] = [];
  for (const bruta of texto.split(/\r?\n/)) {
    const linea = bruta.trim();
    if (!linea) continue;
    const correo = CORREO_EN_LINEA.exec(linea)?.[0] ?? '';
    let nombre = (correo ? linea.replace(correo, ' ') : linea)
      .replace(/[<>"()\t;,]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!nombre && correo) {
      // Solo un correo: el nombre se deduce de lo que va antes de la @.
      nombre = correo
        .split('@')[0]!
        .split(/[._-]+/)
        .filter(Boolean)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(' ');
    }
    if (nombre || correo) out.push({ nombre: nombre.slice(0, 80), personal: correo });
  }
  return out;
}

/* ------------------------------ Invalidaciones ----------------------------- */

/** Tras crear buzones o cambiar las direcciones obligatorias: listas, resumen y uso del plan. */
export function invalidarCorreo(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['mailboxes'] }),
    queryClient.invalidateQueries({ queryKey: ['aliases'] }),
    queryClient.invalidateQueries({ queryKey: ['client-dashboard'] }),
  ]);
}

/* --------------------------- Enlace de un buzón ---------------------------- */

export { VALIDEZ_ENLACE_HORAS };

/**
 * Enlace de configuración con contraseña para un buzón que ya existe. La
 * contraseña no se guarda en claro en ningún sitio, así que para incluirla
 * hay que generar una nueva: quien lo pide lo sabe antes de pulsar.
 */
export async function enlaceConContrasenaNueva(mailboxId: string): Promise<EnlaceCreado> {
  const { password } = await api.post<{ password?: string }>(`/api/mailboxes/${mailboxId}/password`, {});
  const { link } = await api.post<{ link: EnlaceCreado }>(`/api/mailboxes/${mailboxId}/setup-links`, {
    ttlHours: VALIDEZ_ENLACE_HORAS,
    includePassword: Boolean(password),
    password: password || undefined,
  });
  return link;
}

/* ---------------------- Configuración de cada buzón ------------------------ */

/**
 * Cómo va la configuración de un buzón, según el servidor:
 * - configurado: su titular ya entró (terminó el enlace, instaló el perfil,
 *   entró en «Mi buzón» o en el webmail) o se marcó a mano;
 * - enviado: tiene la configuración en camino (correo enviado o enlace
 *   abierto), pero aún no ha terminado;
 * - sin configurar: nadie le ha hecho llegar nada que haya abierto. Es lo
 *   que se pinta en rojo: depende de quien hace la puesta en marcha.
 */
export type EstadoCuenta = 'configurado' | 'enviado' | 'sin-configurar';

export interface LecturaCuenta {
  estado: EstadoCuenta;
  veredicto: Veredicto;
  rotulo: string;
  nota: string;
}

export function lecturaCuenta(b: Mailbox): LecturaCuenta {
  if (b.configuredAt) {
    return { estado: 'configurado', veredicto: 'normal', rotulo: 'Configurado', nota: `Configurado el ${formatDay(b.configuredAt)}.` };
  }
  const correo = b.setup?.lastEmail ?? null;
  const abierto = b.setup?.lastOpenedAt ?? null;
  if (correo?.status === 'sent' && (!abierto || correo.at >= abierto)) {
    return {
      estado: 'enviado',
      veredicto: 'vigilar',
      rotulo: 'Enviado',
      nota: `Configuración enviada a ${correo.to} el ${formatDay(correo.at)}. Aún no la ha terminado.`,
    };
  }
  if (abierto) {
    return {
      estado: 'enviado',
      veredicto: 'vigilar',
      rotulo: 'Enlace abierto',
      nota: `Abrió su enlace el ${formatDay(abierto)}, pero aún no ha terminado.`,
    };
  }
  if (correo?.status === 'failed') {
    return {
      estado: 'sin-configurar',
      veredicto: 'fuera',
      rotulo: 'Sin configurar',
      nota: `No se pudo enviar a ${correo.to}. Vuelve a intentarlo o copia su enlace.`,
    };
  }
  return {
    estado: 'sin-configurar',
    veredicto: 'fuera',
    rotulo: 'Sin configurar',
    nota: b.setup?.lastLinkAt
      ? 'Su enlace aún no se ha abierto. Envíale la configuración por correo o copia el enlace y pásaselo.'
      : 'Aún no ha recibido su configuración.',
  };
}

/** Dirección que envía los correos de configuración de un dominio. */
export function remitenteConfiguracion(dominio: string): string {
  return `${REMITENTE_CONFIGURACION}@${dominio}`;
}

export interface EnvioRealizado {
  sent: { to: string; at: number; status: 'sent' };
  link: { expiresAt: number; hasPassword: boolean };
  reused: boolean;
}

/**
 * Envía al titular su enlace de configuración desde configuration@ de su
 * dominio. Con contraseña (buzón sin configurar), el servidor reutiliza el
 * enlace vigente si lo hay y, si no, genera una contraseña nueva. Sin ella
 * (buzón ya configurado), no se toca la que usa.
 */
export function enviarConfiguracion(mailboxId: string, to: string, includePassword: boolean): Promise<EnvioRealizado> {
  return api.post<EnvioRealizado>(`/api/mailboxes/${mailboxId}/setup-email`, {
    to: to.trim(),
    includePassword,
    ttlHours: VALIDEZ_ENLACE_HORAS,
  });
}

/** Marca (o desmarca) a mano un buzón como configurado. */
export function marcarConfigurado(mailboxId: string, configured: boolean): Promise<{ configuredAt: number | null }> {
  return api.post<{ configuredAt: number | null }>(`/api/mailboxes/${mailboxId}/configured`, { configured });
}
