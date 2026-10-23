import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Button } from './Button';

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

// Control de formulario: borde visible, esquinas suaves y anillo petróleo al
// enfocarlo.
const controlBase =
  'h-10 w-full min-w-0 rounded-lg border border-regla-fuerte bg-hoja px-3 text-base text-tinta shadow-boton ' +
  'placeholder:text-tinta-3 transition duration-150 ' +
  'hover:border-[rgb(var(--tinta)/0.32)] focus:border-[rgb(var(--petroleo))] focus:outline-none focus:ring-[3px] focus:ring-petroleo/15 ' +
  'disabled:bg-hoja-2 disabled:opacity-60 ' +
  // Un campo con error lleva el filete del veredicto, no solo el texto de debajo.
  'aria-[invalid=true]:border-[rgb(var(--fuera)/0.6)]';

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
          className={`${controlBase} ${mono ? 'codigo text-sm' : ''} ${className}`}
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
            aria-invalid={error ? true : undefined}
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
          aria-invalid={error ? true : undefined}
          className={`${controlBase} h-auto min-h-[84px] py-2 ${className}`}
          {...rest}
        />
      )}
    </FieldWrap>
  );
});

interface InputColorProps {
  label: string;
  help?: string;
  error?: string;
  /** '' (sin color propio), #rgb o #rrggbb; también lo que se esté escribiendo. */
  value: string;
  onChange: (valor: string) => void;
  /** Lo que significa dejarlo vacío («Predeterminado»). */
  placeholder?: string;
  disabled?: boolean;
}

/** #rrggbb para el selector nativo, que no admite #rgb; null si no es un color. */
function colorCompleto(valor: string): string | null {
  const v = valor.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return null;
}

/**
 * Color: la muestra abre el selector del sistema y el campo admite el valor
 * escrito o pegado. Vacío es un valor (sin color propio): la muestra sale
 * tachada en lugar de enseñar un color que no se aplicará, y «Quitar» vuelve
 * a él.
 */
export function InputColor({ label, help, error, value, onChange, placeholder, disabled }: InputColorProps) {
  const color = colorCompleto(value);
  return (
    <FieldWrap label={label} help={help} error={error}>
      {(id, describedBy) => (
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`relative h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-regla-fuerte shadow-boton
              focus-within:border-[rgb(var(--petroleo))] focus-within:ring-[3px] focus-within:ring-petroleo/15
              ${color ? '' : 'bg-hoja-2'} ${disabled ? 'opacity-60' : ''}`}
            style={color ? { backgroundColor: color } : undefined}
          >
            {!color && (
              <svg aria-hidden viewBox="0 0 40 40" className="absolute inset-0 h-full w-full text-tinta-3">
                <path d="M8 32L32 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            )}
            <input
              type="color"
              aria-label={`${label}: elegir en la paleta`}
              value={color ?? '#ffffff'}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value.toLowerCase())}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
            />
          </span>
          <input
            id={id}
            type="text"
            value={value}
            placeholder={placeholder}
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            disabled={disabled}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            onChange={(e) => onChange(e.target.value)}
            className={`${controlBase} codigo text-sm`}
          />
          {value && (
            <Button
              type="button"
              variant="plano"
              className="shrink-0"
              aria-label={`Quitar ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
              disabled={disabled}
              onClick={() => onChange('')}
            >
              Quitar
            </Button>
          )}
        </div>
      )}
    </FieldWrap>
  );
}
