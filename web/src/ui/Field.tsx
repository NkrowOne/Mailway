import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

interface FieldWrapProps {
  label: string;
  help?: string;
  error?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

/** Etiqueta + control + ayuda/error, con ids accesibles enlazados. */
export function FieldWrap({ label, help, error, children }: FieldWrapProps) {
  const id = useId();
  const helpId = help || error ? `${id}-help` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="rotulo">
        {label}
      </label>
      {children(id, helpId)}
      {error ? (
        <p id={helpId} className="text-sm text-fuera">
          {error}
        </p>
      ) : help ? (
        <p id={helpId} className="text-sm text-tinta-3">
          {help}
        </p>
      ) : null}
    </div>
  );
}

// Casilla de formulario impreso: filete perimetral fino, fondo de hoja.
const controlBase =
  'h-9 w-full border border-regla bg-hoja px-2.5 text-base text-tinta ' +
  'placeholder:text-tinta-3 transition-colors duration-100 ' +
  'hover:border-regla-fuerte focus:border-[rgb(var(--laboratorio))] disabled:opacity-35';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  help?: string;
  error?: string;
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, help, error, mono = false, className = '', ...rest },
  ref,
) {
  return (
    <FieldWrap label={label} help={help} error={error}>
      {(id, describedBy) => (
        <input
          ref={ref}
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={`${controlBase} ${mono ? 'valor text-sm' : ''} ${className}`}
          {...rest}
        />
      )}
    </FieldWrap>
  );
});

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  help?: string;
  error?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, help, error, className = '', children, ...rest },
  ref,
) {
  return (
    <FieldWrap label={label} help={help} error={error}>
      {(id, describedBy) => (
        <div className="relative">
          <select
            ref={ref}
            id={id}
            aria-describedby={describedBy}
            className={`${controlBase} appearance-none pr-9 ${className}`}
            {...rest}
          >
            {children}
          </select>
          <svg
            aria-hidden
            viewBox="0 0 12 12"
            className="pointer-events-none absolute right-3 top-1/2 h-3 w-3 -translate-y-1/2 text-tinta-3"
          >
            <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </div>
      )}
    </FieldWrap>
  );
});

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  help?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, help, error, className = '', ...rest },
  ref,
) {
  return (
    <FieldWrap label={label} help={help} error={error}>
      {(id, describedBy) => (
        <textarea
          ref={ref}
          id={id}
          aria-describedby={describedBy}
          className={`${controlBase} h-auto min-h-[84px] py-2 ${className}`}
          {...rest}
        />
      )}
    </FieldWrap>
  );
});
