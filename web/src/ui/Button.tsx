import { forwardRef, type ButtonHTMLAttributes } from 'react';

/*
  Jerarquía de acciones: una principal en petróleo por zona, secundarias con
  borde y terciarias solo con texto. El color de identidad marca la acción
  que la vista espera; el resto no compite con ella.
*/
export type VarianteBoton = 'principal' | 'perfil' | 'plano' | 'peligro';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: VarianteBoton;
  busy?: boolean;
}

// Altura fija (h-9) y no mínima: las alturas táctiles del portal (TACTIL,
// `min-h-11 sm:min-h-0`) y los botones compactos (`!h-7`) la sustituyen; con
// un min-height de base, `sm:min-h-0` dejaría el botón a la altura del texto.
const base =
  'inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-base font-medium ' +
  'transition duration-150 select-none';

const styles: Record<VarianteBoton, string> = {
  // Acción principal: relleno petróleo, la única con color de la zona.
  principal:
    'bg-petroleo text-white shadow-boton hover:bg-petroleo-hondo active:translate-y-px ' +
    'disabled:opacity-40 disabled:hover:bg-petroleo',
  // Acción secundaria: fondo blanco con borde, como un control.
  perfil:
    'border border-regla-fuerte bg-hoja text-tinta shadow-boton hover:bg-hoja-2 hover:border-[rgb(var(--tinta)/0.32)] ' +
    'active:translate-y-px disabled:opacity-40',
  // Terciaria: solo texto.
  plano: 'text-tinta-2 hover:bg-hoja-3 hover:text-tinta active:translate-y-px disabled:opacity-40',
  // Destructiva: el rojo de los avisos, sin relleno hasta que se señala.
  peligro:
    'border border-[rgb(var(--fuera)/0.35)] bg-hoja text-fuera hover:bg-fuera-fondo active:translate-y-px ' +
    'disabled:opacity-40',
};

/**
 * Clases de un botón para aplicarlas a otro elemento (un `Link` o un `<a>` que
 * navega). Así la navegación no se envuelve en un <button>: un botón dentro de
 * un enlace es HTML inválido y crea dos paradas de tabulación para una acción.
 */
export function estiloBoton(variant: VarianteBoton = 'perfil', className = ''): string {
  return `${base} ${styles[variant]} ${className}`;
}

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = 'perfil', busy = false, className = '', children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={estiloBoton(variant, className)}
      {...rest}
    >
      {busy && (
        <span
          aria-hidden
          className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
});
