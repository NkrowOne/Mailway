import { useState, type ReactNode } from 'react';
import { copiarTexto } from '../../lib/portal';

/*
  Piezas comunes de las páginas del titular del buzón. Mismo mundo que el
  panel (parte de laboratorio), pero pensado para el móvil de alguien que no
  sabe de correo: controles de 44 px, frases cortas y un solo paso a la vez.
*/

/**
 * Altura táctil: 44 px en el móvil (mínimo recomendado), la normal desde sm.
 * Se hace con min-height y no con height porque los controles del kit ya
 * traen su altura (h-8, h-9) y, entre dos clases de altura, Tailwind no
 * garantiza cuál gana; min-height siempre se impone a height.
 */
export const TACTIL = 'min-h-11 sm:min-h-0';

/**
 * Enlace con aspecto de botón. Un <a> con un <Button> dentro sería HTML
 * no válido (y dos paradas de tabulación), así que se replica el estilo.
 */
export function claseEnlaceBoton(variante: 'tinta' | 'perfil', tamano: 'tactil' | 'panel' = 'tactil'): string {
  const alto = tamano === 'tactil' ? `h-9 px-4 ${TACTIL}` : 'h-8 px-3';
  const base =
    `inline-flex ${alto} items-center justify-center gap-2 text-base no-underline ` +
    'transition-colors duration-100 select-none active:translate-y-px';
  return variante === 'tinta'
    ? `${base} bg-tinta font-semibold text-hoja hover:bg-[rgb(var(--laboratorio))]`
    : `${base} border border-regla-fuerte text-tinta hover:bg-hoja-3`;
}

/** Logotipo de la escala medida, en petróleo vivo sobre el campo. */
export function LogoEscala() {
  return (
    <svg viewBox="0 0 22 16" className="h-4 w-[22px] shrink-0 text-laboratorio-vivo" aria-hidden>
      <path d="M1 13h20" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 13V7M9 13V3M14 13V9M19 13V5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/**
 * Marco de página del portal: la banda de identidad lleva a la vez la marca
 * y el título (una sola región oscura continua, como en el panel) y debajo
 * una columna estrecha, cómoda de leer en el móvil.
 */
export function MarcoPortal({
  marca,
  titulo,
  meta,
  acciones,
  children,
}: {
  marca: string;
  titulo: ReactNode;
  meta?: ReactNode;
  acciones?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-mesa">
      <header className="campo-lab">
        <div className="mx-auto max-w-3xl px-4 pb-6 pt-4 sm:px-6 sm:pb-8 sm:pt-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <LogoEscala />
              <span className="min-w-0 break-words font-estrecha text-md font-semibold uppercase tracking-[0.14em] text-white">
                {marca}
              </span>
            </div>
            {acciones}
          </div>
          <h1 className="titular mt-6 text-3xl text-white sm:text-4xl">{titulo}</h1>
          {meta && <div className="mt-2.5 max-w-2xl text-base text-white/75">{meta}</div>}
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-5 sm:px-6 sm:py-7">
        {children}
      </main>
    </div>
  );
}

/** Página completa para estados sin datos (carga, enlace no válido, error). */
export function PaginaEstado({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-mesa px-4 py-10">
      <section className="w-full max-w-[28rem] animate-aparecer border border-regla bg-hoja">
        {children}
      </section>
    </div>
  );
}

/** Banda de error de la vista: nombra el problema y, si lo hay, el arreglo. */
export function AvisoError({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="border border-[rgb(var(--fuera)/0.35)] bg-fuera-fondo px-3 py-2 text-sm text-fuera"
    >
      {children}
    </div>
  );
}

/** Confirmación de una acción completada, sobre el fondo de conformidad. */
export function AvisoHecho({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="revelar border border-[rgb(var(--normal)/0.35)] bg-normal-fondo px-3 py-2 text-sm text-normal"
    >
      {children}
    </div>
  );
}

/**
 * Botón de copiar de tamaño táctil. A diferencia del del kit, solo dice
 * «Copiado» si la copia ha funcionado; si no, pide copiarlo a mano.
 */
export function BotonCopiarTactil({ texto, rotulo = 'Copiar' }: { texto: string; rotulo?: string }) {
  const [estado, setEstado] = useState<'reposo' | 'ok' | 'fallo'>('reposo');
  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await copiarTexto(texto);
        setEstado(ok ? 'ok' : 'fallo');
        setTimeout(() => setEstado('reposo'), 2000);
      }}
      className={`inline-flex h-7 ${TACTIL} shrink-0 items-center gap-1.5 border px-3 font-estrecha text-micro
        font-semibold uppercase tracking-[0.08em] transition-colors duration-100 active:translate-y-px sm:px-2
        ${
          estado === 'ok'
            ? 'border-[rgb(var(--normal)/0.45)] text-normal'
            : estado === 'fallo'
              ? 'border-[rgb(var(--fuera)/0.4)] text-fuera'
              : 'border-regla-fuerte text-tinta-2 hover:bg-hoja-3 hover:text-tinta'
        }`}
    >
      <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden>
        {estado === 'ok' ? (
          <path d="M1.5 6.5L4.5 9.5 10.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        ) : (
          <>
            <rect x="4" y="4" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path
              d="M8.5 4V1.8a.8.8 0 0 0-.8-.8H1.8a.8.8 0 0 0-.8.8v5.9a.8.8 0 0 0 .8.8H4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </>
        )}
      </svg>
      <span aria-live="polite">
        {estado === 'ok' ? 'Copiado' : estado === 'fallo' ? 'Cópielo a mano' : rotulo}
      </span>
    </button>
  );
}

/** Lista numerada de pasos: el número en cifras del instrumento. */
export function Pasos({ children }: { children: ReactNode }) {
  return <ol className="flex flex-col gap-3">{children}</ol>;
}

export function Paso({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="valor flex h-6 w-6 shrink-0 items-center justify-center border border-regla-fuerte text-sm text-tinta"
      >
        {n}
      </span>
      <div className="min-w-0 max-w-[70ch] pt-0.5 text-base text-tinta">{children}</div>
    </li>
  );
}

/** Nota secundaria: contexto que ayuda pero que no es un paso. */
export function Nota({ children }: { children: ReactNode }) {
  return <p className="max-w-[70ch] text-sm text-tinta-2">{children}</p>;
}

/** Nombre de un elemento de otra aplicación («Permitir», «Ajustes»…). */
export function Ui({ children }: { children: ReactNode }) {
  return <span className="font-semibold">«{children}»</span>;
}
