import { forwardRef, type ButtonHTMLAttributes } from 'react';

/*
  En un parte impreso la acción no se pinta de colores: se imprime en tinta.
  La jerarquía la dan el peso y la posición, no un acento decorativo.
*/
type Variant = 'tinta' | 'campo' | 'perfil' | 'plano' | 'peligro';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  busy?: boolean;
}

const styles: Record<Variant, string> = {
  // Acción principal: sólida en tinta, como un sello de conformidad.
  tinta:
    'bg-tinta text-hoja font-semibold hover:bg-[rgb(var(--laboratorio))] active:translate-y-px ' +
    'disabled:opacity-35 disabled:hover:bg-tinta',
  // Acción principal SOBRE el campo de laboratorio (membrete): invertida.
  campo:
    'bg-white text-laboratorio font-semibold hover:bg-laboratorio-claro active:translate-y-px ' +
    'disabled:opacity-40 disabled:hover:bg-white',
  // Acción secundaria: filete, sin relleno.
  perfil:
    'border border-regla-fuerte text-tinta hover:bg-hoja-3 active:translate-y-px disabled:opacity-35',
  // Terciaria: solo texto.
  plano: 'text-tinta-2 hover:bg-hoja-3 hover:text-tinta active:translate-y-px disabled:opacity-35',
  // Destructiva: el carmín de fuera de rango, coherente con el veredicto.
  peligro:
    'border border-[rgb(var(--fuera)/0.4)] text-fuera hover:bg-fuera-fondo active:translate-y-px ' +
    'disabled:opacity-35',
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = 'perfil', busy = false, className = '', children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || busy}
      className={`inline-flex h-8 items-center justify-center gap-2 px-3 text-base
        transition-colors duration-100 select-none ${styles[variant]} ${className}`}
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
