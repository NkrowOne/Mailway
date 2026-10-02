import { useRef, type KeyboardEvent } from 'react';

export interface OpcionPestana<T extends string> {
  id: T;
  label: string;
}

/**
 * Pestañas accesibles (patrón tablist de WAI-ARIA): una sola parada de
 * tabulación y las flechas, Inicio y Fin para moverse entre ellas. El panel
 * lo pinta quien las usa, con `id={panelId}` y
 * `aria-labelledby={`${panelId}-${activo}`}`.
 */
export function Pestanas<T extends string>({
  opciones,
  activo,
  onCambio,
  panelId,
  etiqueta,
  tactil = false,
}: {
  opciones: OpcionPestana<T>[];
  activo: T;
  onCambio: (id: T) => void;
  panelId: string;
  /** Nombre del grupo para los lectores de pantalla. */
  etiqueta: string;
  /** Altura táctil de 44 px en el móvil (portal del titular). */
  tactil?: boolean;
}) {
  const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = opciones.findIndex((o) => o.id === activo);
    let siguiente = -1;
    if (e.key === 'ArrowRight') siguiente = (i + 1) % opciones.length;
    if (e.key === 'ArrowLeft') siguiente = (i - 1 + opciones.length) % opciones.length;
    if (e.key === 'Home') siguiente = 0;
    if (e.key === 'End') siguiente = opciones.length - 1;
    if (siguiente < 0) return;
    e.preventDefault();
    const id = opciones[siguiente]!.id;
    onCambio(id);
    refs.current[id]?.focus();
  }

  return (
    <div role="tablist" aria-label={etiqueta} onKeyDown={onKeyDown} className="flex flex-wrap gap-1.5">
      {opciones.map((o) => {
        const seleccionado = o.id === activo;
        return (
          <button
            key={o.id}
            ref={(el) => {
              refs.current[o.id] = el;
            }}
            type="button"
            role="tab"
            id={`${panelId}-${o.id}`}
            aria-selected={seleccionado}
            aria-controls={panelId}
            tabIndex={seleccionado ? 0 : -1}
            onClick={() => onCambio(o.id)}
            // Como la navegación activa: fondo petróleo tenue, sin filete de
            // acento (DESIGN.md solo admite dos bordes de petróleo).
            className={`rounded-lg border px-3 py-1.5 text-base transition-colors duration-100 ${
              tactil ? 'min-h-11 sm:min-h-0' : ''
            } ${
              seleccionado
                ? 'border-[rgb(var(--laboratorio)/0.35)] bg-laboratorio-claro font-semibold text-laboratorio'
                : 'border-regla text-tinta-2 hover:bg-hoja-3 hover:text-tinta'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
