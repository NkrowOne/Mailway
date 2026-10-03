import { useEffect, useRef, useState, type ReactNode } from 'react';
import { copiarTexto } from '../../lib/portal';
import { AvisoError as AvisoErrorKit, Logotipo } from '../../ui/kit';

/*
  Piezas comunes de las páginas del titular del buzón. Mismo sistema que el
  panel, pero pensado para el móvil de alguien que no sabe de correo:
  controles de 44 px, frases cortas y un solo paso a la vez.
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
export function claseEnlaceBoton(variante: 'principal' | 'perfil', tamano: 'tactil' | 'panel' = 'tactil'): string {
  const alto = tamano === 'tactil' ? `h-9 px-4 ${TACTIL}` : 'h-9 px-3.5';
  const base =
    `inline-flex ${alto} items-center justify-center gap-2 rounded-lg text-base font-medium no-underline ` +
    'transition-colors duration-100 select-none active:translate-y-px';
  return variante === 'principal'
    ? `${base} bg-petroleo text-white shadow-boton hover:bg-petroleo-hondo`
    : `${base} border border-regla-fuerte bg-hoja text-tinta shadow-boton hover:bg-hoja-2`;
}

/**
 * Marco de página del portal: barra blanca con la marca y la acción de la
 * sesión, y debajo el título y una columna estrecha, cómoda de leer en el
 * móvil.
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
      <header className="border-b border-regla bg-hoja">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Logotipo />
            <span className="min-w-0 break-words text-md font-semibold text-tinta">{marca}</span>
          </div>
          {acciones}
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-2">
          <h1 className="titular text-2xl text-tinta sm:text-3xl">{titulo}</h1>
          {meta && <div className="mt-1.5 max-w-2xl text-base text-tinta-2">{meta}</div>}
        </div>
        {children}
      </main>
    </div>
  );
}

/** Página completa para estados sin datos (carga, enlace no válido, error). */
export function PaginaEstado({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-mesa px-4 py-10">
      <section className="hoja-panel w-full max-w-[28rem] animate-aparecer overflow-hidden rounded-2xl border border-regla bg-hoja">
        {children}
      </section>
    </div>
  );
}

/**
 * Banda de error de la vista: nombra el problema y, si lo hay, el arreglo. Es
 * la misma banda que el panel (una sola en toda la aplicación).
 */
export function AvisoError({ children }: { children: ReactNode }) {
  return <AvisoErrorKit>{children}</AvisoErrorKit>;
}

/** Confirmación de una acción completada, sobre el fondo de conformidad. */
export function AvisoHecho({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="revelar rounded-lg border border-[rgb(var(--normal)/0.35)] bg-normal-fondo px-3 py-2 text-sm text-normal"
    >
      {children}
    </div>
  );
}

/**
 * Botón de copiar de tamaño táctil. Solo dice «Copiado» si la copia ha
 * funcionado; si no, pide copiarlo manualmente.
 */
export function BotonCopiarTactil({ texto, rotulo = 'Copiar' }: { texto: string; rotulo?: string }) {
  const [estado, setEstado] = useState<'reposo' | 'ok' | 'fallo'>('reposo');
  // Si se sale de la vista antes de que venza, el temporizador no debe
  // actualizar un componente ya desmontado.
  const temporizador = useRef<number>();
  useEffect(() => () => window.clearTimeout(temporizador.current), []);
  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await copiarTexto(texto);
        setEstado(ok ? 'ok' : 'fallo');
        window.clearTimeout(temporizador.current);
        temporizador.current = window.setTimeout(() => setEstado('reposo'), 2000);
      }}
      className={`inline-flex h-7 ${TACTIL} shrink-0 items-center gap-1.5 rounded-md border bg-hoja px-3 text-sm
        font-medium transition-colors duration-100 active:translate-y-px sm:px-2
        ${
          estado === 'ok'
            ? 'border-[rgb(var(--normal)/0.45)] text-normal'
            : estado === 'fallo'
              ? 'border-[rgb(var(--fuera)/0.4)] text-fuera'
              : 'border-regla-fuerte text-tinta-2 hover:bg-hoja-2 hover:text-tinta'
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
        {estado === 'ok' ? 'Copiado' : estado === 'fallo' ? 'Cópialo manualmente' : rotulo}
      </span>
    </button>
  );
}

/** Lista numerada de pasos: el orden importa, así que el número se ve. */
export function Pasos({ children }: { children: ReactNode }) {
  return <ol className="flex flex-col gap-3">{children}</ol>;
}

export function Paso({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="valor flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-petroleo-claro text-sm font-semibold text-petroleo"
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
