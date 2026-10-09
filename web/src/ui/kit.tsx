import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button } from './Button';

/*
  Primitivas del panel.

  Reglas del sistema (DESIGN.md):
  - Tarjetas blancas con borde fino y sombra mínima sobre el fondo claro.
  - El verde petróleo orienta (acción principal, navegación, foco); los
    colores de estado solo califican un dato. Nada de color decorativo.
  - Cifras con ancho fijo (.valor); lo que se copia tal cual, en
    monoespaciada (.codigo).
*/

/* ------------------------------- Hoja ------------------------------------- */

/**
 * Tarjeta de contenido: fondo blanco, borde fino, esquinas suaves y una
 * cabecera con título, contexto y acciones.
 */
export function Hoja({
  title,
  meta,
  actions,
  children,
  className = '',
  flush = false,
}: {
  title?: ReactNode;
  /** Línea de contexto a la derecha del título (fecha de medición, recuento). */
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section
      className={`hoja-panel min-w-0 overflow-hidden rounded-xl border border-regla bg-hoja ${className}`}
    >
      {(title || actions) && (
        <header className="regla-cabecera flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3.5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            {typeof title === 'string' ? (
              <h2 className="text-md font-semibold text-tinta">
                {title}
              </h2>
            ) : (
              title
            )}
            {meta && <span className="text-sm text-tinta-3">{meta}</span>}
          </div>
          {/* Sin shrink-0: en el móvil, si las acciones no caben en una línea,
              se reparten en varias en vez de salirse de la tarjeta. */}
          {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

/* ------------------------------ Veredicto --------------------------------- */

export type Veredicto = 'normal' | 'vigilar' | 'fuera' | 'sin-dato';

const veredictoTexto: Record<Veredicto, string> = {
  normal: 'Correcto',
  vigilar: 'Revisar',
  fuera: 'Necesita atención',
  'sin-dato': 'Sin datos',
};

const veredictoColor: Record<Veredicto, string> = {
  normal: 'text-normal',
  vigilar: 'text-vigilar',
  fuera: 'text-fuera',
  'sin-dato': 'text-tinta-3',
};

const veredictoFondo: Record<Veredicto, string> = {
  normal: 'bg-normal-fondo text-normal',
  vigilar: 'bg-vigilar-fondo text-vigilar',
  fuera: 'bg-fuera-fondo text-fuera',
  'sin-dato': 'bg-hoja-3 text-tinta-3',
};

/**
 * Estado de un dato en línea: glifo y texto en el color del estado, sin
 * fondo. El glifo es un trazo dibujado, no un emoji ni un carácter suelto.
 */
export function Marca({ veredicto, children }: { veredicto: Veredicto; children?: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-medium
        ${veredictoColor[veredicto]}`}
    >
      <GlifoVeredicto veredicto={veredicto} />
      {children ?? veredictoTexto[veredicto]}
    </span>
  );
}

/** Igual que la marca, pero sobre fondo teñido para listados densos. */
export function MarcaFondo({ veredicto, children }: { veredicto: Veredicto; children?: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1
        text-sm font-semibold
        ${veredictoFondo[veredicto]}`}
    >
      <GlifoVeredicto veredicto={veredicto} />
      {children ?? veredictoTexto[veredicto]}
    </span>
  );
}

function GlifoVeredicto({ veredicto }: { veredicto: Veredicto }) {
  // Un solo trazo y un solo peso, con las puntas redondeadas.
  return (
    <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 shrink-0" aria-hidden>
      {veredicto === 'normal' && (
        <path d="M1 5.4L3.8 8 9 2.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {veredicto === 'fuera' && (
        <path d="M2 2l6 6M8 2l-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {veredicto === 'vigilar' && (
        <path d="M5 1.4v4.4M5 8.2v.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {veredicto === 'sin-dato' && (
        <path d="M1.6 5h6.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

/* -------------------------------- Medida ---------------------------------- */

/**
 * Fila de indicador: un valor junto a su objetivo y su estado. Sirve igual
 * para el uso del plan, la puntuación de entregabilidad, la cola de salida o
 * un registro DNS.
 */
export function Medida({
  concepto,
  valor,
  unidad,
  referencia,
  veredicto,
  nota,
}: {
  concepto: string;
  valor: ReactNode;
  unidad?: string;
  /** Qué se considera normal. Es lo que convierte un número en un diagnóstico. */
  referencia?: string;
  veredicto: Veredicto;
  nota?: ReactNode;
}) {
  // El estado tiñe la fila entera: lo que necesita atención se ve de un
  // vistazo en lugar de tener que leer la columna de la derecha.
  const fondo =
    veredicto === 'fuera' ? 'fila-fuera' : veredicto === 'vigilar' ? 'fila-vigilar' : '';
  const tinta =
    veredicto === 'fuera'
      ? 'text-fuera'
      : veredicto === 'vigilar'
        ? 'text-vigilar'
        : 'text-tinta';
  // La fila decide su forma por el ancho de SU hoja (consulta de contenedor),
  // no por el de la ventana: en la columna estrecha de Entregabilidad, a
  // 1280 px, las cuatro columnas tampoco caben y deben plegarse como en móvil.
  return (
    <div className={`regla-fila last:border-b-0 [container-type:inline-size] ${fondo}`}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3.5">
        <span className="min-w-0 flex-1 basis-40 text-base text-tinta">{concepto}</span>
        {/* Con max-w-full y corte libre, un PTR o un nombre de host largo baja
            de línea en lugar de desbordar la tarjeta a 360 px. */}
        <span
          className={`valor min-w-0 max-w-full shrink-0 text-lg font-semibold leading-tight [overflow-wrap:anywhere] ${tinta}`}
        >
          {valor}
          {unidad && <span className="ml-1.5 text-sm font-normal text-tinta-3">{unidad}</span>}
        </span>
        {referencia && (
          <span className="valor shrink-0 text-sm text-tinta-3 [@container(min-width:36rem)]:basis-28">
            {/* Plegada, la cabecera de columnas se oculta: la celda lleva su rótulo. */}
            <span className="mr-1 [@container(min-width:36rem)]:hidden">Esperado:</span>
            {referencia}
          </span>
        )}
        {/* ml-auto: plegada en dos líneas, el veredicto sigue en el margen derecho. */}
        <span className="ml-auto shrink-0 text-right [@container(min-width:36rem)]:basis-32">
          <Marca veredicto={veredicto} />
        </span>
        {nota && <p className="w-full max-w-[75ch] text-sm text-tinta-2">{nota}</p>}
      </div>
    </div>
  );
}

/**
 * Cabecera de las columnas de una tabla de mediciones. Se pone una vez encima
 * de un grupo de <Medida>, para que los números tengan nombre.
 */
export function CabeceraMedidas({
  referencia = true,
}: {
  referencia?: boolean;
}) {
  // Con la hoja estrecha la fila de medición se pliega en dos líneas y los
  // rótulos de columna ya no caen sobre su dato: se ocultan y la referencia
  // lleva el suyo (mismo umbral de contenedor que Medida).
  return (
    <div className="[container-type:inline-size]">
      <div className="regla-cabecera hidden flex-wrap items-baseline gap-x-4 gap-y-1 bg-hoja-2 px-4 py-2 [@container(min-width:36rem)]:flex">
        <span className="rotulo min-w-0 flex-1 basis-40">Comprobación</span>
        <span className="rotulo shrink-0">Valor</span>
        {referencia && <span className="rotulo shrink-0 basis-28">Esperado</span>}
        <span className="rotulo shrink-0 basis-32 text-right">Estado</span>
      </div>
    </div>
  );
}

/* --------------------------------- Barra ---------------------------------- */

/**
 * Barra de uso frente al límite del plan. A partir del 80 % cambia a ámbar
 * para avisar antes de agotarlo.
 *
 * Alcanzar el cupo del plan no es un fallo (un plan de 1 dominio con 1
 * dominio está bien): se vigila, y fuera de rango queda para lo que lo
 * supera. Donde llegar al límite sí rechaza algo (los envíos diarios de una
 * clave), `limiteEsFuera` lo califica como fuera de rango.
 */
export function Escala({
  label,
  usado,
  maximo,
  unidad = '',
  limiteEsFuera = false,
}: {
  label: string;
  usado: number;
  maximo: number;
  unidad?: string;
  limiteEsFuera?: boolean;
}) {
  const ratio = maximo > 0 ? Math.min(1, usado / maximo) : 0;
  const bruto = maximo > 0 ? usado / maximo : 0;
  const veredicto: Veredicto =
    bruto > 1 || (limiteEsFuera && bruto >= 1) ? 'fuera' : bruto >= 0.8 ? 'vigilar' : 'normal';
  const relleno = { normal: 'bg-normal', vigilar: 'bg-vigilar', fuera: 'bg-fuera', 'sin-dato': 'bg-tinta-3' }[
    veredicto
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 text-base text-tinta">{label}</span>
        <span className="valor shrink-0 text-base text-tinta">
          {usado}
          <span className="text-tinta-3">
            /{maximo}
            {unidad ? ` ${unidad}` : ''}
          </span>
        </span>
      </div>
      <div
        role="meter"
        aria-valuenow={usado}
        aria-valuemin={0}
        aria-valuemax={maximo}
        aria-label={label}
        className="h-2 overflow-hidden rounded-full bg-hoja-3"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${relleno}`}
          style={{ width: `${Math.max(ratio * 100, usado > 0 ? 2 : 0)}%` }}
        />
      </div>
    </div>
  );
}

/* -------------------------------- Muestra --------------------------------- */

/**
 * Bloque de valor exacto que el usuario debe llevarse fuera del sistema
 * (registro DNS, credencial, cadena de conexión): fondo embutido, rótulo y
 * botón de copiar arriba, y el valor debajo.
 */
export function Muestra({
  rotulo,
  children,
  copiar,
  className = '',
}: {
  rotulo: string;
  children: ReactNode;
  /** Texto que se copia al portapapeles. */
  copiar?: string;
  className?: string;
}) {
  const valorRef = useRef<HTMLDivElement>(null);
  return (
    <div
      // Lo que se lleva fuera del panel se copia tal cual: en monoespaciada.
      className={`min-w-0 overflow-hidden rounded-lg border border-regla bg-hoja-2 [&_.valor]:font-codigo ${className}`}
    >
      <div className="flex items-center justify-between gap-3 px-3 pt-2.5">
        <span className="rotulo">{rotulo}</span>
        {copiar !== undefined && <BotonCopiar text={copiar} objetivo={valorRef} />}
      </div>
      <div ref={valorRef} className="min-w-0 px-3 pb-2.5 pt-1">
        {children}
      </div>
    </div>
  );
}

/* ------------------------------- Copiable --------------------------------- */

/**
 * Copia con un área de texto oculta y `execCommand`: es la única vía cuando el
 * panel se sirve por HTTP (sin contexto seguro no existe navigator.clipboard).
 */
function copiarConSeleccion(texto: string, ancla: HTMLElement | null): boolean {
  // Con un <dialog> modal abierto todo lo que queda fuera es inerte: el área
  // auxiliar tiene que vivir dentro del diálogo o no se puede seleccionar.
  const contenedor = ancla?.closest('dialog') ?? document.body;
  const area = document.createElement('textarea');
  area.value = texto;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.tabIndex = -1;
  Object.assign(area.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
  });
  const previo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  contenedor.appendChild(area);
  let ok = false;
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, texto.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    contenedor.removeChild(area);
    previo?.focus({ preventScroll: true });
  }
  return ok;
}

/**
 * Copia un texto al portapapeles y dice la verdad: devuelve false si no se
 * pudo, para no anunciar «Copiado» con el portapapeles vacío.
 */
export async function copiarAlPortapapeles(
  texto: string,
  ancla: HTMLElement | null = null,
): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(texto);
      return true;
    } catch {
      // Permiso denegado o documento sin foco: se intenta el método clásico.
    }
  }
  return copiarConSeleccion(texto, ancla);
}

/** Deja el texto seleccionado para que el usuario lo copie a mano (Ctrl+C). */
function seleccionarContenido(elemento: HTMLElement | null): boolean {
  const seleccion = typeof window !== 'undefined' ? window.getSelection() : null;
  if (!elemento || !seleccion) return false;
  const rango = document.createRange();
  rango.selectNodeContents(elemento);
  seleccion.removeAllRanges();
  seleccion.addRange(rango);
  return true;
}

type EstadoCopia = 'reposo' | 'copiado' | 'fallo';

export function BotonCopiar({
  text,
  label = 'Copiar',
  objetivo,
}: {
  text: string;
  label?: string;
  /** Elemento que queda seleccionado si el navegador no permite copiar. */
  objetivo?: RefObject<HTMLElement>;
}) {
  const [estado, setEstado] = useState<EstadoCopia>('reposo');
  const [seleccionado, setSeleccionado] = useState(false);
  const botonRef = useRef<HTMLButtonElement>(null);
  const temporizador = useRef<number>();

  useEffect(() => () => window.clearTimeout(temporizador.current), []);

  async function copiar() {
    const ok = await copiarAlPortapapeles(text, botonRef.current);
    setSeleccionado(ok ? false : seleccionarContenido(objetivo?.current ?? null));
    setEstado(ok ? 'copiado' : 'fallo');
    window.clearTimeout(temporizador.current);
    temporizador.current = window.setTimeout(() => setEstado('reposo'), ok ? 1600 : 5000);
  }

  const tono =
    estado === 'copiado'
      ? 'border-[rgb(var(--normal)/0.45)] text-normal'
      : estado === 'fallo'
        ? 'border-[rgb(var(--fuera)/0.45)] text-fuera'
        : 'border-regla-fuerte text-tinta-2 hover:bg-hoja-2 hover:text-tinta';

  return (
    <>
      <button
        ref={botonRef}
        type="button"
        onClick={() => void copiar()}
        className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-hoja px-2 text-sm
          font-medium transition-colors duration-100 active:translate-y-px
          ${tono}`}
      >
        <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden>
          {estado === 'copiado' ? (
            <path d="M1.5 6.5L4.5 9.5 10.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          ) : estado === 'fallo' ? (
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.6" />
          ) : (
            <>
              <rect x="4" y="4" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <path d="M8.5 4V1.8a.8.8 0 0 0-.8-.8H1.8a.8.8 0 0 0-.8.8v5.9a.8.8 0 0 0 .8.8H4" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </>
          )}
        </svg>
        {estado === 'copiado' ? 'Copiado' : estado === 'fallo' ? 'No se ha podido copiar' : label}
      </button>
      {/* El cambio de rótulo de un botón no siempre se anuncia: la región sí. */}
      <span className="sr-only" role="status">
        {estado === 'copiado'
          ? 'Copiado al portapapeles.'
          : estado === 'fallo'
            ? seleccionado
              ? 'No se ha podido copiar. El texto queda seleccionado: pulsa Ctrl+C para copiarlo.'
              : 'No se ha podido copiar. Selecciona el texto y cópialo manualmente.'
            : ''}
      </span>
    </>
  );
}

/* ------------------------ Bloqueo del desplazamiento ----------------------- */

let bloqueosActivos = 0;

/**
 * Bloquea el desplazamiento de la página mientras algo flota encima (diálogo,
 * cajón móvil). Es un contador: si se abre un diálogo desde el cajón, cerrar
 * uno no debe desbloquear el otro. `scrollbar-gutter: stable` (styles.css)
 * evita que el contenido salte al desaparecer la barra.
 */
export function useBloqueoDesplazamiento(activo: boolean): void {
  useEffect(() => {
    if (!activo) return;
    bloqueosActivos += 1;
    document.documentElement.classList.add('sin-desplazamiento');
    return () => {
      bloqueosActivos -= 1;
      if (bloqueosActivos === 0) document.documentElement.classList.remove('sin-desplazamiento');
    };
  }, [activo]);
}

/* ------------------------------- Diálogo ---------------------------------- */

const CAMPOS_ENFOCABLES =
  'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])';

/**
 * Pregunta que se hace antes de cerrar un diálogo que muestra un secreto de
 * una sola vez (contraseña, clave, token): cerrar sin haberlo guardado obliga
 * a generar otro.
 */
export interface ConfirmarCierre {
  /** «¿Has guardado la contraseña?» */
  pregunta: string;
  /** «No se podrá volver a ver.» */
  detalle: string;
}

/**
 * showModal enfoca el primer elemento enfocable, que es el aspa de cerrar: se
 * prefiere el campo marcado, el primer campo o el cuerpo para que se lea.
 */
function enfocarContenido(dialog: HTMLDialogElement, cuerpo: HTMLElement | null) {
  const destino =
    dialog.querySelector<HTMLElement>('[data-autofocus]') ??
    cuerpo?.querySelector<HTMLElement>(CAMPOS_ENFOCABLES) ??
    cuerpo;
  destino?.focus({ preventScroll: true });
}

export function Dialogo({
  open,
  onClose,
  title,
  children,
  pie,
  confirmarCierre,
  ancho = 'normal',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /**
   * Botonera fija al pie del diálogo: en el móvil, con un contenido largo, la
   * acción de cierre sigue a la vista sin desplazarse hasta el final.
   */
  pie?: ReactNode;
  /**
   * Si se indica, Escape y el aspa piden confirmación y el clic en el velo se
   * ignora: el diálogo contiene un secreto que no se podrá volver a ver.
   */
  confirmarCierre?: ConfirmarCierre | null;
  /** `amplio` (720 px) para instrucciones largas o listas con varias columnas. */
  ancho?: 'normal' | 'amplio';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cuerpoRef = useRef<HTMLDivElement>(null);
  const volverRef = useRef<HTMLButtonElement>(null);
  const tituloId = useId();
  const [confirmando, setConfirmando] = useState(false);
  // Estado vivo para los manejadores nativos: el evento `close` llega después
  // del render y no debe leer un `open` o un `onClose` antiguos.
  const abiertoRef = useRef(open);
  const onCloseRef = useRef(onClose);
  const protegidoRef = useRef(Boolean(confirmarCierre));
  const pulsadoEnVelo = useRef(false);
  // El `close` que provoca el propio efecto (el padre ya cerró, o React
  // desmonta/remonta en modo estricto) no es una petición de cierre del usuario.
  const cierreInterno = useRef(false);

  useEffect(() => {
    abiertoRef.current = open;
    onCloseRef.current = onClose;
    protegidoRef.current = Boolean(confirmarCierre);
  });

  // Sin secreto pendiente no hay nada que confirmar.
  const confirmacionVisible = confirmando && Boolean(confirmarCierre) && open;

  useBloqueoDesplazamiento(open);

  /** Escape o aspa: cierra, o pregunta antes si hay un secreto sin guardar. */
  function pedirCierre() {
    if (protegidoRef.current) setConfirmando(true);
    else onCloseRef.current();
  }

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const previo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    enfocarContenido(dialog, cuerpoRef.current);
    return () => {
      // Al reabrir se empieza siempre por el contenido, no por la pregunta.
      setConfirmando(false);
      if (dialog.open) {
        cierreInterno.current = true;
        dialog.close();
      }
      // El foco vuelve a quien abrió el diálogo, si sigue en la página (la
      // fila que se acaba de borrar, por ejemplo, ya no existe).
      if (previo?.isConnected) previo.focus({ preventScroll: true });
    };
  }, [open]);

  // Cambio de vista dentro del mismo diálogo (del formulario al resultado, de
  // la ficha a una acción): el foco se quedaba en el <body> y el lector de
  // pantalla no anunciaba nada. Se vuelve a colocar al principio del contenido.
  const tituloPrevio = useRef(title);
  useEffect(() => {
    if (tituloPrevio.current === title) return;
    tituloPrevio.current = title;
    const dialog = ref.current;
    if (dialog?.open) enfocarContenido(dialog, cuerpoRef.current);
  }, [title]);

  useEffect(() => {
    if (confirmacionVisible) volverRef.current?.focus({ preventScroll: true });
  }, [confirmacionVisible]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={tituloId}
      onCancel={(e) => {
        // Escape: decide el padre (cambia su estado) y el efecto cierra el
        // <dialog>. Si el navegador ignora el preventDefault, onClose lo cubre.
        e.preventDefault();
        if (confirmacionVisible) setConfirmando(false);
        else pedirCierre();
      }}
      onClose={() => {
        if (cierreInterno.current) {
          cierreInterno.current = false;
          return;
        }
        if (!abiertoRef.current) return;
        // Chrome cierra el diálogo aunque se cancele el Escape si se repite
        // sin interacción entre medias. Con un secreto pendiente se vuelve a
        // abrir y se pregunta, en lugar de perderlo.
        if (protegidoRef.current) {
          const dialog = ref.current;
          if (dialog && !dialog.open) dialog.showModal();
          setConfirmando(true);
          return;
        }
        onCloseRef.current();
      }}
      onMouseDown={(e) => {
        pulsadoEnVelo.current = e.target === ref.current;
      }}
      onClick={(e) => {
        // Solo cierra un clic que empieza y acaba en el velo: arrastrar una
        // selección desde un campo hasta fuera no debe perder el formulario.
        // Con un secreto pendiente el velo no cierra: un toque accidental en
        // el móvil lo perdería.
        if (e.target === ref.current && pulsadoEnVelo.current && !protegidoRef.current) {
          onCloseRef.current();
        }
        pulsadoEnVelo.current = false;
      }}
      // Esquinas redondeadas sin overflow-hidden: el <dialog> modal desplaza su
      // propio contenido (overflow: auto del navegador) y el pie fijo depende de
      // ello; con overflow-hidden un diálogo largo quedaría cortado en el móvil.
      className={`${ancho === 'amplio' ? 'w-[min(720px,calc(100vw-32px))]' : 'w-[min(520px,calc(100vw-32px))]'}
        rounded-xl border border-regla-fuerte bg-hoja p-0 text-tinta shadow-flotante
        backdrop:bg-[rgb(var(--tinta)/0.4)] open:animate-aparecer`}
    >
      <div className="regla-cabecera flex items-center justify-between gap-3 px-5 py-3.5">
        <h2
          id={tituloId}
          // Un punto por encima del título de una tarjeta: está en primer plano.
          className="min-w-0 text-lg font-semibold [overflow-wrap:anywhere]"
        >
          {title}
        </h2>
        <button
          type="button"
          onClick={pedirCierre}
          aria-label="Cerrar"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-tinta-3 hover:bg-hoja-3 hover:text-tinta"
        >
          <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" aria-hidden>
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      </div>
      {confirmacionVisible && confirmarCierre && (
        <div
          role="alertdialog"
          aria-labelledby={`${tituloId}-pregunta`}
          aria-describedby={`${tituloId}-detalle`}
          className="flex flex-col gap-4 p-5"
        >
          <div className="rounded-lg border border-[rgb(var(--vigilar)/0.45)] bg-vigilar-fondo px-3 py-2.5">
            <p id={`${tituloId}-pregunta`} className="text-base font-semibold text-tinta">
              {confirmarCierre.pregunta}
            </p>
            <p id={`${tituloId}-detalle`} className="mt-0.5 text-base text-tinta-2">
              {confirmarCierre.detalle}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="peligro"
              onClick={() => {
                setConfirmando(false);
                onCloseRef.current();
              }}
            >
              Cerrar sin guardar
            </Button>
            <Button
              ref={volverRef}
              variant="principal"
              onClick={() => {
                setConfirmando(false);
                if (ref.current) enfocarContenido(ref.current, cuerpoRef.current);
              }}
            >
              Volver
            </Button>
          </div>
        </div>
      )}
      {/* El contenido sigue montado mientras se pregunta: al volver, el
          secreto y el estado de la vista están donde estaban. */}
      <div
        ref={cuerpoRef}
        tabIndex={-1}
        hidden={confirmacionVisible}
        className="p-5 focus-visible:outline-none"
      >
        {children}
      </div>
      {pie && !confirmacionVisible && (
        <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-regla bg-hoja px-5 py-3">
          {pie}
        </div>
      )}
    </dialog>
  );
}

/* ----------------------------- Aviso de error ------------------------------ */

/**
 * Banda roja de error: nombra el problema y, si la operación se puede
 * repetir, ofrece reintentarla ahí mismo. `role="alert"` para anunciarse al
 * aparecer sin que el usuario tenga que buscarla.
 */
export function AvisoError({
  children,
  onRetry,
  retrying = false,
  className = '',
}: {
  children: ReactNode;
  /** Si se indica, la banda incluye el botón «Reintentar». */
  onRetry?: () => void;
  /** Botón ocupado mientras se repite la petición. */
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={`revelar flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-[rgb(var(--fuera)/0.4)]
        bg-fuera-fondo px-3 py-2 text-base text-fuera ${className}`}
    >
      <div className="min-w-0 flex-1 basis-56 [overflow-wrap:anywhere]">{children}</div>
      {onRetry && (
        <Button
          type="button"
          variant="perfil"
          busy={retrying}
          onClick={onRetry}
          className="!h-7 shrink-0 bg-hoja"
        >
          Reintentar
        </Button>
      )}
    </div>
  );
}

/* ------------------------------- Logotipo --------------------------------- */

/**
 * Marca de la instancia: un sobre blanco cuya silueta forma la M de Mailway,
 * con la solapa de abajo en degradado, sobre la tesela de los estados vacíos
 * en su versión llena (petróleo con degradado y luz arriba a la izquierda).
 * La geometría (caja de 64) es la de `deploy/roundcube/mailway_theme/logo.svg`
 * y de `docs/marca/`; el favicon agranda el sobre.
 */
export function Logotipo({ tamano = 'normal' }: { tamano?: 'normal' | 'grande' }) {
  // Los degradados se referencian por id y la marca aparece varias veces en
  // la misma página; useId da ids únicos (sin «:», que estorban en url(#…)).
  const p = useId().replace(/:/g, '');
  return (
    <span
      aria-hidden
      className={`flex shrink-0 overflow-hidden bg-petroleo ${
        tamano === 'grande' ? 'h-11 w-11 rounded-[13px]' : 'h-9 w-9 rounded-[11px]'
      }`}
    >
      <svg viewBox="0 0 64 64" className="h-full w-full">
        <defs>
          <linearGradient id={`${p}f`} x1="0" y1="0" x2=".85" y2="1">
            <stop offset="0" stopColor="#2fa59a" />
            <stop offset=".52" stopColor="#0f6567" />
            <stop offset="1" stopColor="#073c3f" />
          </linearGradient>
          <radialGradient id={`${p}l`} cx=".28" cy="-.05" r=".85">
            <stop offset="0" stopColor="#fff" stopOpacity=".2" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${p}s`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" />
            <stop offset="1" stopColor="#e2f3ef" />
          </linearGradient>
          <linearGradient id={`${p}b`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#cbe9e2" />
            <stop offset="1" stopColor="#9dd2c7" />
          </linearGradient>
          <filter id={`${p}h`} x="-20%" y="-20%" width="140%" height="150%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="1.6" />
            <feOffset dy="1.6" />
            <feComponentTransfer>
              <feFuncA type="linear" slope=".28" />
            </feComponentTransfer>
            <feFlood floodColor="#03292b" />
            <feComposite operator="in" in2="SourceAlpha" />
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <rect width="64" height="64" fill={`url(#${p}f)`} />
        <rect width="64" height="64" fill={`url(#${p}l)`} />
        <g filter={`url(#${p}h)`}>
          {/* El sobre (su borde de arriba es la M), el pliegue de la solapa y la solapa de abajo. */}
          <path
            d="M11 22a4.6 4.6 0 0 1 7.6-3.5L32 31l13.4-12.5A4.6 4.6 0 0 1 53 22v21a4.5 4.5 0 0 1-4.5 4.5h-33A4.5 4.5 0 0 1 11 43z"
            fill={`url(#${p}s)`}
          />
          <path
            d="M11.2 20.6 28.6 36.2a5.1 5.1 0 0 0 6.8 0L52.8 20.6l.2 1.4v1.8L36 39.4a6 6 0 0 1-8 0L11 23.8V22z"
            fill="#0b5355"
            opacity=".09"
          />
          <path
            d="M12.2 45.9 28.4 35.4a6.6 6.6 0 0 1 7.2 0l16.2 10.5A4.5 4.5 0 0 1 48.5 47.5h-33a4.5 4.5 0 0 1-3.3-1.6z"
            fill={`url(#${p}b)`}
          />
        </g>
      </svg>
    </span>
  );
}

/* ------------------------------ Sin resultados ----------------------------- */

/**
 * Icono de una vista dentro de una tesela redondeada en petróleo tenue. Es
 * el único motivo gráfico del sistema: lo usan los estados vacíos, con el
 * icono de lo que falta, y la marca de la instancia, con el sobre-M.
 */
export function Tesela({
  icono: Icono,
  tamano = 'normal',
}: {
  icono: LucideIcon;
  tamano?: 'normal' | 'pequena';
}) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center bg-petroleo-claro text-petroleo ${
        tamano === 'normal' ? 'h-12 w-12 rounded-2xl' : 'h-9 w-9 rounded-xl'
      }`}
    >
      <Icono className={tamano === 'normal' ? 'h-[22px] w-[22px]' : 'h-[18px] w-[18px]'} strokeWidth={1.75} />
    </span>
  );
}

/**
 * Estado vacío: el icono de lo que falta, qué es y el siguiente paso. Cada
 * vista pasa su propio icono (sobre, llave, globo…) para que se reconozca de
 * un vistazo dónde se está.
 */
export function Vacio({
  icono,
  title,
  children,
  action,
}: {
  icono: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center sm:py-12">
      <span className="mb-2">
        <Tesela icono={icono} />
      </span>
      <p className="text-md font-semibold text-tinta">{title}</p>
      {children && <div className="max-w-md text-base text-tinta-2">{children}</div>}
      {action && <div className="mt-3 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/* ------------------------------- Cargando --------------------------------- */

/**
 * Carga: un aro pequeño que gira y el texto de lo que se espera. Aparece con
 * un breve retraso (`.entrada-diferida` en styles.css): una petición que
 * tarda 80 ms no debe hacer parpadear la vista.
 */
export function Cargando({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div
      className="entrada-diferida flex flex-col items-center gap-3 px-6 py-12"
      role="status"
      aria-label={label}
    >
      <span
        aria-hidden
        className="girar h-6 w-6 rounded-full border-2 border-[rgb(var(--petroleo)/0.18)] border-t-[rgb(var(--petroleo))]"
      />
      <span className="text-center text-sm text-tinta-3">{label}</span>
    </div>
  );
}

/* ------------------------------- Membrete --------------------------------- */

/**
 * Cabecera de página: título, una línea de contexto y la acción que la vista
 * espera. Sin caja ni fondo: la página empieza por lo que es.
 */
export function Membrete({
  title,
  meta,
  actions,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4 sm:mb-7">
      <div className="min-w-0 max-w-3xl">
        {/* Un dominio largo en el título parte en lugar de desbordar en móvil. */}
        <h1 className="titular text-2xl text-tinta [overflow-wrap:anywhere] sm:text-3xl">{title}</h1>
        {meta && <div className="mt-1.5 text-base text-tinta-2">{meta}</div>}
      </div>
      {actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
