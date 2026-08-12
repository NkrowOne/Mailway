import { forwardRef, type ButtonHTMLAttributes } from 'react';

type Variant = 'accion' | 'chasis' | 'fantasma' | 'peligro';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  busy?: boolean;
}

const styles: Record<Variant, string> = {
  // La tecla naranja: una por vista, la acción que importa.
  accion:
    'bg-accion text-accion-tinta font-semibold hover:brightness-110 active:translate-y-px ' +
    'disabled:opacity-40 disabled:hover:brightness-100',
  chasis:
    'bg-chasis-2 text-tinta border border-fuerte hover:bg-chasis-3 active:translate-y-px ' +
    'disabled:opacity-40',
  fantasma:
    'text-tinta-2 hover:text-tinta hover:bg-chasis-2 active:translate-y-px disabled:opacity-40',
  peligro:
    'text-devuelto border border-[rgb(var(--devuelto)/0.35)] hover:bg-[rgb(var(--devuelto)/0.10)] ' +
    'active:translate-y-px disabled:opacity-40',
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = 'chasis', busy = false, className = '', children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || busy}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded px-4 text-base
        transition-[background-color,color,transform,filter] duration-100 select-none
        ${styles[variant]} ${className}`}
      {...rest}
    >
      {busy && (
        <span
          aria-hidden
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
});
