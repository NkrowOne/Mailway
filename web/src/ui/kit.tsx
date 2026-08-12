import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/* ------------------------------- Panel ------------------------------------ */

export function Panel({
  title,
  actions,
  children,
  className = '',
  flush = false,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={`rounded-md border border-suave bg-chasis ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-suave px-4 py-2.5">
          {typeof title === 'string' ? (
            <h2 className="font-rotulo text-md font-semibold tracking-wide text-tinta">{title}</h2>
          ) : (
            title
          )}
          {actions}
        </header>
      )}
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

/* ------------------------------- Sello ------------------------------------ */

type SelloTone = 'entregado' | 'transito' | 'devuelto' | 'neutro';

const selloTones: Record<SelloTone, string> = {
  entregado: 'text-entregado border-[rgb(var(--entregado)/0.55)]',
  transito: 'text-transito border-[rgb(var(--transito)/0.55)]',
  devuelto: 'text-devuelto border-[rgb(var(--devuelto)/0.55)]',
  neutro: 'text-tinta-3 border-fuerte',
};

/** Estado sellado como un tampón de aduana: los estados no desaparecen. */
export function Sello({
  tone,
  children,
  stamped = false,
}: {
  tone: SelloTone;
  children: ReactNode;
  stamped?: boolean;
}) {
  return (
    <span
      className={`inline-block -rotate-[8deg] select-none whitespace-nowrap rounded-sm border-2 px-1.5
        font-rotulo text-micro font-semibold uppercase tracking-[0.12em]
        ${selloTones[tone]} ${stamped ? 'animate-sello' : ''}`}
    >
      {children}
    </span>
  );
}

/* ------------------------------ Estado pill ------------------------------- */

const estadoTones: Record<SelloTone, string> = {
  entregado: 'bg-[rgb(var(--entregado)/0.12)] text-entregado',
  transito: 'bg-[rgb(var(--transito)/0.12)] text-transito',
  devuelto: 'bg-[rgb(var(--devuelto)/0.12)] text-devuelto',
  neutro: 'bg-chasis-2 text-tinta-3',
};

export function Estado({ tone, children }: { tone: SelloTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5
        text-sm font-medium ${estadoTones[tone]}`}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

/* ---------------------------- Medidor de carga ---------------------------- */

/**
 * Medidor de bodega: uso frente a límite del plan con marcas de graduación,
 * como el indicador de carga de un contenedor.
 */
export function Medidor({
  label,
  used,
  max,
  unit = '',
}: {
  label: string;
  used: number;
  max: number;
  unit?: string;
}) {
  const ratio = max > 0 ? Math.min(1, used / max) : 0;
  const full = ratio >= 1;
  const near = ratio >= 0.8 && !full;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-tinta-2">{label}</span>
        <span className="num font-guia text-sm text-tinta">
          {used}
          <span className="text-tinta-3">/{max}{unit ? ` ${unit}` : ''}</span>
        </span>
      </div>
      <div
        role="meter"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
        className="relative h-2.5 overflow-hidden rounded-sm bg-cinta"
      >
        <div
          className={`h-full transition-[width] duration-300 ${
            full ? 'bg-devuelto' : near ? 'bg-transito' : 'bg-entregado'
          }`}
          style={{ width: `${Math.max(ratio * 100, used > 0 ? 4 : 0)}%` }}
        />
        {/* Graduación del medidor */}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            backgroundImage:
              'repeating-linear-gradient(90deg, transparent, transparent calc(25% - 1px), rgb(var(--cinta)) calc(25% - 1px), rgb(var(--cinta)) 25%)',
          }}
        />
      </div>
    </div>
  );
}

/* --------------------------- Código de barras ------------------------------ */

/**
 * Código de barras decorativo derivado del dato (prefijo de clave, dominio):
 * geometría determinista, no una imagen. Identifica la fila de un vistazo.
 */
export function Barcode({ seed, className = '' }: { seed: string; className?: string }) {
  const bars = useMemo(() => {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const widths: number[] = [];
    for (let i = 0; i < 18; i++) {
      h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
      widths.push(1 + (Math.abs(h) % 3));
    }
    return widths;
  }, [seed]);
  return (
    <div aria-hidden className={`flex h-5 items-stretch gap-px opacity-60 ${className}`}>
      {bars.map((w, i) => (
        <span key={i} className="bg-current" style={{ width: `${w}px` }} />
      ))}
    </div>
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
      className="w-[min(480px,calc(100vw-32px))] rounded-md border border-fuerte bg-chasis-3
        p-0 text-tinta shadow-flotante backdrop:bg-black/60 open:animate-aparecer"
    >
      <div className="flex items-center justify-between border-b border-suave px-5 py-3">
        <h2 className="font-rotulo text-lg font-semibold tracking-wide">{title}</h2>
        <button
          onClick={onClose}
          aria-label="Cerrar"
          className="flex h-8 w-8 items-center justify-center rounded text-tinta-3 hover:bg-chasis-2 hover:text-tinta"
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

/* ------------------------------ Copiable ---------------------------------- */

export function BotonCopiar({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // Sin permiso de portapapeles: selección manual.
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      className={`inline-flex h-7 shrink-0 items-center gap-1 rounded border px-2 text-sm font-medium
        transition-colors duration-100 active:translate-y-px
        ${copied
          ? 'border-[rgb(var(--entregado)/0.5)] text-entregado'
          : 'border-[rgb(var(--etiqueta-borde))] text-[rgb(var(--etiqueta-tinta)/0.75)] hover:bg-black/5'}`}
    >
      {copied ? (
        <svg viewBox="0 0 14 14" className="h-3 w-3">
          <path d="M2 7.5L5.5 11L12 3.5" stroke="currentColor" strokeWidth="1.8" fill="none" />
        </svg>
      ) : (
        <svg viewBox="0 0 14 14" className="h-3 w-3">
          <rect x="4.5" y="4.5" width="8" height="8" rx="1" stroke="currentColor" fill="none" />
          <path d="M9.5 4.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" stroke="currentColor" fill="none" />
        </svg>
      )}
      {copied ? 'Copiado' : label}
    </button>
  );
}

/* ------------------------------- Etiqueta --------------------------------- */

/**
 * La etiqueta de papel: TODO lo que el usuario debe llevarse fuera del
 * sistema (registros DNS, credenciales, datos de conexión) se imprime aquí.
 */
export function Etiqueta({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`relative rounded-sm bg-etiqueta text-etiqueta-tinta ${className}`}
      style={{
        clipPath:
          'polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 0 100%)',
      }}
    >
      {/* esquina doblada */}
      <span
        aria-hidden
        className="absolute right-0 top-0 h-[14px] w-[14px] bg-[rgb(var(--etiqueta-borde))]"
        style={{ clipPath: 'polygon(0 0, 100% 100%, 0 100%)' }}
      />
      {children}
    </div>
  );
}

/* ----------------------------- Estado vacío -------------------------------- */

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
      {/* silueta de paquete en tránsito */}
      <svg viewBox="0 0 48 32" className="mb-1 h-8 w-12 text-tinta-3" aria-hidden>
        <path d="M4 26h28M8 22h20M12 18h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="2 4" />
        <rect x="26" y="6" width="16" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path d="M26 10h16M34 6v4" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <p className="text-md font-semibold text-tinta">{title}</p>
      {children && <div className="max-w-sm text-sm text-tinta-2">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/* ------------------------------ Cargando ---------------------------------- */

/** Cinta transportadora en marcha: la carga es movimiento de nave, no spinner. */
export function Cargando({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12" role="status" aria-label={label}>
      <div
        className="h-2 w-40 animate-cinta rounded-sm opacity-50"
        style={{
          backgroundImage:
            'repeating-linear-gradient(-45deg, rgb(var(--tinta-3)) 0 6px, transparent 6px 14px)',
        }}
      />
      <span className="text-sm text-tinta-3">{label}</span>
    </div>
  );
}

/* ------------------------------ Encabezado --------------------------------- */

export function Encabezado({
  title,
  meta,
  actions,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-rotulo text-2xl font-semibold tracking-wide text-tinta">{title}</h1>
        {meta && <div className="mt-1 text-sm text-tinta-2">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
