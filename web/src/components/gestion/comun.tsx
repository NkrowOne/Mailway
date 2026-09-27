import type { ReactNode } from 'react';
import { Button } from '../../ui/Button';

/*
  Piezas pequeñas que comparten las vistas de gestión (clientes, planes,
  buzones y alias). Siguen las bandas de mensaje de DESIGN.md: filete y fondo
  tenue del color del veredicto, texto a 12-14 px.
*/

/** Banda de error de página o de formulario: nombra el problema y, si se puede, ofrece reintentar. */
export function BandaError({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border border-[rgb(var(--fuera)/0.4)]
        bg-fuera-fondo px-3 py-2 text-sm text-fuera"
    >
      <div className="min-w-0 max-w-[75ch]">{children}</div>
      {onRetry && (
        <Button variant="peligro" className="h-7 bg-hoja px-2 text-sm" onClick={onRetry}>
          Reintentar
        </Button>
      )}
    </div>
  );
}

/** Banda de advertencia: algo que conviene leer antes de continuar. */
export function BandaAviso({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="border border-[rgb(var(--vigilar)/0.45)] bg-vigilar-fondo px-3 py-2 text-sm text-tinta"
    >
      <div className="max-w-[75ch]">{children}</div>
    </div>
  );
}

/** Casilla de verificación con su etiqueta y una ayuda opcional debajo. */
export function Casilla({
  checked,
  onChange,
  label,
  help,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  help?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-2.5 ${disabled ? 'opacity-35' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        className="mt-[3px] h-4 w-4 shrink-0"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-base text-tinta">{label}</span>
        {help && <span className="block text-sm text-tinta-3">{help}</span>}
      </span>
    </label>
  );
}

/** Opción de un grupo de radio con su etiqueta. */
export function Opcion({
  name,
  checked,
  onChange,
  label,
  help,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
  help?: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="radio" name={name} className="mt-[3px] h-4 w-4 shrink-0" checked={checked} onChange={onChange} />
      <span className="min-w-0">
        <span className="block text-base text-tinta">{label}</span>
        {help && <span className="block text-sm text-tinta-3">{help}</span>}
      </span>
    </label>
  );
}

/** Fila de dato de una ficha: rótulo a la izquierda y valor a la derecha, reglada. */
export function FilaDato({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div className="regla-fila flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-2.5 last:border-b-0">
      <span className="rotulo shrink-0">{rotulo}</span>
      <span className="min-w-0 break-words text-right text-base text-tinta">{children}</span>
    </div>
  );
}

/** Botonera de un diálogo: secundaria a la izquierda de la principal. */
export function Botonera({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-2">{children}</div>;
}
