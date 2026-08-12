import { useEffect, useRef, useState, type ReactNode } from 'react';

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
    <section className={`border border-regla bg-hoja ${className}`}>
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
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
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
  return (
    <div
      className={`regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-3 last:border-b-0 ${fondo}`}
    >
      <span className="min-w-0 flex-1 basis-40 text-base text-tinta">{concepto}</span>
      {/* El dato medido es el contenido del informe: va a plena escala. */}
      <span className={`valor shrink-0 text-xl font-medium leading-none ${tinta}`}>
        {valor}
        {unidad && <span className="ml-1.5 text-sm font-normal text-tinta-3">{unidad}</span>}
      </span>
      {referencia && (
        <span className="valor shrink-0 basis-28 text-sm text-tinta-3">{referencia}</span>
      )}
      <span className="shrink-0 basis-32 text-right">
        <Marca veredicto={veredicto} />
      </span>
      {nota && <p className="w-full max-w-[75ch] text-sm text-tinta-2">{nota}</p>}
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
  return (
    <div className="regla-cabecera flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 pb-1.5">
      <span className="rotulo min-w-0 flex-1 basis-40">Concepto</span>
      <span className="rotulo shrink-0">Valor</span>
      {referencia && <span className="rotulo shrink-0 basis-28">Referencia</span>}
      <span className="rotulo shrink-0 basis-32 text-right">Veredicto</span>
    </div>
  );
}

/* --------------------------------- Barra ---------------------------------- */

/**
 * Medición con escala: uso frente al límite del plan. La marca de referencia
 * al 80 % avisa antes de agotarlo, como el límite superior de un rango.
 */
export function Escala({
  label,
  usado,
  maximo,
  unidad = '',
}: {
  label: string;
  usado: number;
  maximo: number;
  unidad?: string;
}) {
  const ratio = maximo > 0 ? Math.min(1, usado / maximo) : 0;
  const veredicto: Veredicto = ratio >= 1 ? 'fuera' : ratio >= 0.8 ? 'vigilar' : 'normal';
  const relleno = { normal: 'bg-normal', vigilar: 'bg-vigilar', fuera: 'bg-fuera', 'sin-dato': 'bg-tinta-3' }[
    veredicto
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-base text-tinta">{label}</span>
        <span className="valor text-base text-tinta">
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
  return (
    <div className={`border border-regla border-t-2 border-t-[rgb(var(--laboratorio))] bg-hoja-2 ${className}`}>
      <div className="flex items-center justify-between gap-3 px-3 pt-2">
        <span className="rotulo">{rotulo}</span>
        {copiar !== undefined && <BotonCopiar text={copiar} />}
      </div>
      <div className="px-3 pb-2.5 pt-1">{children}</div>
    </div>
  );
}

/* ------------------------------- Copiable --------------------------------- */

export function BotonCopiar({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // Sin permiso de portapapeles: queda la selección manual.
        }
        setCopiado(true);
        setTimeout(() => setCopiado(false), 1600);
      }}
      className={`inline-flex h-6 shrink-0 items-center gap-1 border px-1.5 font-estrecha text-micro
        font-semibold uppercase tracking-[0.08em] transition-colors duration-100 active:translate-y-px
        ${
          copiado
            ? 'border-[rgb(var(--normal)/0.45)] text-normal'
            : 'border-regla-fuerte text-tinta-2 hover:bg-hoja-3 hover:text-tinta'
        }`}
    >
      <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden>
        {copiado ? (
          <path d="M1.5 6.5L4.5 9.5 10.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        ) : (
          <>
            <rect x="4" y="4" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path d="M8.5 4V1.8a.8.8 0 0 0-.8-.8H1.8a.8.8 0 0 0-.8.8v5.9a.8.8 0 0 0 .8.8H4" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </>
        )}
      </svg>
      {copiado ? 'Copiado' : label}
    </button>
  );
}

/* ------------------------------- Diálogo ---------------------------------- */

export function Dialogo({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="w-[min(520px,calc(100vw-32px))] border border-regla-fuerte bg-hoja p-0 text-tinta
        shadow-flotante backdrop:bg-[rgb(var(--tinta)/0.45)] open:animate-aparecer"
    >
      <div className="regla-cabecera flex items-center justify-between gap-3 px-5 py-3">
        <h2 className="font-estrecha text-md font-semibold uppercase tracking-[0.06em]">{title}</h2>
        <button
          onClick={onClose}
          aria-label="Cerrar"
          className="flex h-7 w-7 items-center justify-center text-tinta-3 hover:bg-hoja-3 hover:text-tinta"
        >
          <svg viewBox="0 0 14 14" className="h-3.5 w-3.5">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </button>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
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
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/* ------------------------------- Midiendo --------------------------------- */

/** Carga: el instrumento barriendo la muestra, no un spinner genérico. */
export function Midiendo({ label = 'Midiendo…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12" role="status" aria-label={label}>
      <div className="medir relative h-px w-48 overflow-hidden bg-[rgb(var(--tinta)/0.15)]" />
      <span className="font-estrecha text-micro font-semibold uppercase tracking-[0.1em] text-tinta-3">
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
          <h1 className="titular text-3xl text-white sm:text-4xl">{title}</h1>
          {meta && (
            <div className="mt-2.5 max-w-2xl text-base text-white/70">{meta}</div>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
