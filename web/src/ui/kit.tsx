import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button } from './Button';

/*
  Primitivas del informe de laboratorio.

  Reglas del mundo:
  - La estructura la llevan los FILETES, no las cajas ni las sombras.
  - El color solo aparece para calificar un valor (veredicto). Nunca decora.
  - Todo lo medido o copiable va en cifras tabulares (clase .valor).
*/

/* ------------------------------- Hoja ------------------------------------- */

/**
 * La hoja del informe. Fondo blanco sobre la mesa, filete perimetral fino y
 * cabecera separada por regla pesada — como una sección de un parte impreso.
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
    <section className={`min-w-0 border border-regla bg-hoja ${className}`}>
      {(title || actions) && (
        <header className="regla-cabecera flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            {typeof title === 'string' ? (
              <h2 className="font-estrecha text-md font-semibold uppercase tracking-[0.06em] text-tinta">
                {title}
              </h2>
            ) : (
              title
            )}
            {meta && <span className="text-sm text-tinta-3">{meta}</span>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

/* ------------------------------ Veredicto --------------------------------- */

export type Veredicto = 'normal' | 'vigilar' | 'fuera' | 'sin-dato';

const veredictoTexto: Record<Veredicto, string> = {
  normal: 'En rango',
  vigilar: 'Vigilar',
  fuera: 'Fuera de rango',
  'sin-dato': 'Sin dato',
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
 * Marca de veredicto en el margen, como la columna de banderas de un análisis.
 * El glifo es geometría dibujada, no un emoji ni un carácter suelto.
 */
export function Marca({ veredicto, children }: { veredicto: Veredicto; children?: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap font-estrecha text-micro
        font-semibold uppercase tracking-[0.08em] ${veredictoColor[veredicto]}`}
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
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm px-1.5 py-0.5
        font-estrecha text-micro font-semibold uppercase tracking-[0.08em]
        ${veredictoFondo[veredicto]}`}
    >
      <GlifoVeredicto veredicto={veredicto} />
      {children ?? veredictoTexto[veredicto]}
    </span>
  );
}

function GlifoVeredicto({ veredicto }: { veredicto: Veredicto }) {
  // Un solo trazo, un solo peso, en la gramática del instrumento.
  return (
    <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 shrink-0" aria-hidden>
      {veredicto === 'normal' && (
        <path d="M1 5.4L3.8 8 9 2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      )}
      {veredicto === 'fuera' && (
        <path d="M2 2l6 6M8 2l-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" />
      )}
      {veredicto === 'vigilar' && (
        <path d="M5 1.4v4.4M5 8.2v.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
      )}
      {veredicto === 'sin-dato' && (
        <path d="M1.6 5h6.8" fill="none" stroke="currentColor" strokeWidth="1.8" />
      )}
    </svg>
  );
}

/* -------------------------------- Medida ---------------------------------- */

/**
 * LA firma del mundo: un valor medido junto a su rango de referencia y su
 * veredicto. Es la fila del análisis, y sirve igual para el uso del plan, la
 * puntuación de entregabilidad, la cola de salida o un registro DNS.
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
  // El veredicto tiñe la fila entera: así «fuera de rango primero» se ve de un
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
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-3">
        <span className="min-w-0 flex-1 basis-40 text-base text-tinta">{concepto}</span>
        {/* El dato medido es el contenido del informe: va a plena escala. Con
            max-w-full y corte libre, un PTR o un nombre de host largo baja de
            línea en lugar de desbordar la hoja a 360 px. */}
        <span
          className={`valor min-w-0 max-w-full shrink-0 text-xl font-medium leading-none [overflow-wrap:anywhere] ${tinta}`}
        >
          {valor}
          {unidad && <span className="ml-1.5 text-sm font-normal text-tinta-3">{unidad}</span>}
        </span>
        {referencia && (
          <span className="valor shrink-0 text-sm text-tinta-3 [@container(min-width:36rem)]:basis-28">
            {/* Plegada, la cabecera de columnas se oculta: la celda lleva su rótulo. */}
            <span className="rotulo mr-1.5 [@container(min-width:36rem)]:hidden">Referencia</span>
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
      <div className="regla-cabecera hidden flex-wrap items-baseline gap-x-4 gap-y-1 px-3 pb-1.5 [@container(min-width:36rem)]:flex">
        <span className="rotulo min-w-0 flex-1 basis-40">Concepto</span>
        <span className="rotulo shrink-0">Valor</span>
        {referencia && <span className="rotulo shrink-0 basis-28">Referencia</span>}
        <span className="rotulo shrink-0 basis-32 text-right">Veredicto</span>
      </div>
    </div>
  );
}

/* --------------------------------- Barra ---------------------------------- */

/**
 * Medición con escala: uso frente al límite del plan. La marca de referencia
 * al 80 % avisa antes de agotarlo, como el límite superior de un rango.
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
        className="relative h-1.5 bg-hoja-3"
      >
        <div
          className={`h-full transition-[width] duration-500 ${relleno}`}
          style={{ width: `${Math.max(ratio * 100, usado > 0 ? 2 : 0)}%` }}
        />
        {/* Marca del rango: el 80 %, donde conviene empezar a mirar. */}
        <span
          aria-hidden
          className="absolute top-0 h-full w-px bg-[rgb(var(--tinta)/0.3)]"
          style={{ left: '80%' }}
        />
      </div>
    </div>
  );
}

/* -------------------------------- Muestra --------------------------------- */

/**
 * Bloque de valor exacto que el usuario debe llevarse fuera del sistema
 * (registro DNS, credencial, cadena de conexión). En un parte, es el apartado
 * que se recorta: filete de laboratorio arriba y el valor en cifras.
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
      className={`min-w-0 border border-regla border-t-2 border-t-[rgb(var(--laboratorio))] bg-hoja-2 ${className}`}
    >
      <div className="flex items-center justify-between gap-3 px-3 pt-2">
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
        : 'border-regla-fuerte text-tinta-2 hover:bg-hoja-3 hover:text-tinta';

  return (
    <>
      <button
        ref={botonRef}
        type="button"
        onClick={() => void copiar()}
        className={`inline-flex h-6 shrink-0 items-center gap-1 border px-1.5 font-estrecha text-micro
          font-semibold uppercase tracking-[0.08em] transition-colors duration-100 active:translate-y-px
          ${tono}`}
      >
        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden>
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
              ? 'No se ha podido copiar. El texto queda seleccionado: pulse Ctrl+C para copiarlo.'
              : 'No se ha podido copiar. Seleccione el texto y cópielo manualmente.'
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
  /** «¿Ha guardado la contraseña?» */
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
      className={`${ancho === 'amplio' ? 'w-[min(720px,calc(100vw-32px))]' : 'w-[min(520px,calc(100vw-32px))]'}
        border border-regla-fuerte bg-hoja p-0 text-tinta shadow-flotante
        backdrop:bg-[rgb(var(--tinta)/0.45)] open:animate-aparecer`}
    >
      <div className="regla-cabecera flex items-center justify-between gap-3 px-5 py-3">
        <h2
          id={tituloId}
          className="min-w-0 font-estrecha text-md font-semibold uppercase tracking-[0.06em] [overflow-wrap:anywhere]"
        >
          {title}
        </h2>
        <button
          type="button"
          onClick={pedirCierre}
          aria-label="Cerrar"
          className="flex h-7 w-7 shrink-0 items-center justify-center text-tinta-3 hover:bg-hoja-3 hover:text-tinta"
        >
          <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" aria-hidden>
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" fill="none" />
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
          <div className="border border-[rgb(var(--vigilar)/0.45)] bg-vigilar-fondo px-3 py-2.5">
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
              variant="tinta"
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
 * Banda carmín de error: nombra el problema y, si la operación se puede
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
      className={`revelar flex flex-wrap items-center gap-x-4 gap-y-2 border border-[rgb(var(--fuera)/0.4)]
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

/* ------------------------------ Sin resultados ----------------------------- */

export function Vacio({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {/* Geometría de instrumento: una escala sin lectura. */}
      <svg viewBox="0 0 56 20" className="mb-1 h-5 w-14 text-tinta-3" aria-hidden>
        <path d="M1 15h54" stroke="currentColor" strokeWidth="1.2" />
        <path d="M8 15v-5M20 15v-8M32 15v-5M44 15v-8" stroke="currentColor" strokeWidth="1.2" />
        <path d="M1 5h54" stroke="currentColor" strokeWidth="1" strokeDasharray="2 5" opacity=".5" />
      </svg>
      <p className="text-md font-semibold text-tinta">{title}</p>
      {children && <div className="max-w-md text-base text-tinta-2">{children}</div>}
      {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/* ------------------------------- Midiendo --------------------------------- */

/**
 * Carga: el instrumento barriendo la muestra, no un spinner genérico. Aparece
 * con un breve retraso (`.entrada-diferida` en styles.css): una lectura que
 * tarda 80 ms no debe hacer parpadear el instrumento.
 */
export function Midiendo({ label = 'Midiendo…' }: { label?: string }) {
  return (
    <div
      className="entrada-diferida flex flex-col items-center gap-3 px-6 py-12"
      role="status"
      aria-label={label}
    >
      <div className="medir relative h-px w-48 overflow-hidden bg-[rgb(var(--tinta)/0.15)]" />
      <span className="text-center font-estrecha text-micro font-semibold uppercase tracking-[0.1em] text-tinta-3">
        {label}
      </span>
    </div>
  );
}

/* ------------------------------- Membrete --------------------------------- */

/**
 * Cabecera de página: el membrete del parte. Título, línea de contexto
 * (cuándo se midió, sobre qué) y la acción que reclama la página.
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
    <div className="campo-lab mb-5 px-5 py-5 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          {/* Un dominio largo en el título parte en lugar de desbordar en móvil. */}
          <h1 className="titular text-3xl text-white [overflow-wrap:anywhere] sm:text-4xl">{title}</h1>
          {meta && (
            <div className="mt-2.5 max-w-2xl text-base text-white/70">{meta}</div>
          )}
        </div>
        {actions && (
          <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    </div>
  );
}
