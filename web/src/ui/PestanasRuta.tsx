import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

export interface PestanaRuta {
  /** Ruta relativa a la vista que contiene las pestañas ('' para la primera). */
  to: string;
  label: string;
  /** Recuento junto al nombre («Buzones 12»); sin él, solo el nombre. */
  cuenta?: number;
}

/**
 * Pestañas que son rutas: cada sección tiene su dirección, se puede enlazar
 * y el botón «Atrás» vuelve a la anterior. Por eso son enlaces dentro de un
 * <nav> (con `aria-current`) y no un `tablist`, que es para paneles que se
 * alternan sin cambiar de página (ver `Pestanas`).
 *
 * En el móvil la tira se desplaza en horizontal dentro de su propio marco,
 * nunca la página; desde `sm` las pestañas que no caben pasan a otra línea.
 */
export function PestanasRuta({ pestanas, etiqueta }: { pestanas: PestanaRuta[]; etiqueta: string }) {
  const tira = useRef<HTMLUListElement>(null);
  const { pathname } = useLocation();

  // La pestaña activa siempre a la vista: al llegar por un enlace a la última
  // sección, en el móvil quedaría fuera del borde de la tira.
  useEffect(() => {
    const ul = tira.current;
    const activa = ul?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!ul || !activa || ul.scrollWidth <= ul.clientWidth) return;
    const inicio = activa.offsetLeft;
    const fin = inicio + activa.offsetWidth;
    if (inicio < ul.scrollLeft) ul.scrollLeft = Math.max(0, inicio - 16);
    else if (fin > ul.scrollLeft + ul.clientWidth) ul.scrollLeft = fin - ul.clientWidth + 16;
  }, [pathname]);

  return (
    <nav aria-label={etiqueta} className="mb-5 border-b border-regla pb-2 sm:mb-6">
      {/* El relleno de 4 px deja sitio al anillo de foco, que el desplazamiento recortaría. */}
      <ul ref={tira} className="relative -mx-1 flex gap-0.5 overflow-x-auto p-1 sm:flex-wrap sm:overflow-visible">
        {pestanas.map((p) => (
          <li key={p.to} className="shrink-0">
            <NavLink
              to={p.to}
              end
              className={({ isActive }) =>
                `flex h-9 items-center gap-2 whitespace-nowrap rounded-lg px-2.5 text-base transition-colors duration-150 ${
                  isActive
                    ? 'bg-petroleo-claro font-semibold text-petroleo'
                    : 'text-tinta-2 hover:bg-hoja-3 hover:text-tinta'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {p.label}
                  {p.cuenta !== undefined && (
                    <span
                      className={`valor min-w-[1.5rem] rounded-full px-1.5 text-center text-sm font-medium leading-5 ${
                        isActive ? 'bg-hoja text-petroleo' : 'bg-hoja-3 text-tinta-2'
                      }`}
                    >
                      {p.cuenta}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
