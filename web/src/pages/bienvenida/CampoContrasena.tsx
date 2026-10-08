import { forwardRef, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { FieldWrap } from '../../ui/Field';
import { TACTIL } from '../portal/comun';

/*
  Campo de contraseña con el botón de mostrarla dentro del propio control.
  El `Input` del kit no admite nada dentro del campo, así que se monta sobre
  `FieldWrap` (misma etiqueta, ayuda y error) con las mismas clases del
  control. Mostrarla evita la mayoría de los «no coinciden» al escribir en el
  móvil, que es donde suele abrirse el enlace.
*/
const CONTROL =
  'h-10 w-full min-w-0 rounded-lg border border-regla-fuerte bg-hoja pl-3 pr-12 text-base text-tinta shadow-boton ' +
  'placeholder:text-tinta-3 transition duration-150 ' +
  'hover:border-[rgb(var(--tinta)/0.32)] focus:border-[rgb(var(--petroleo))] focus:outline-none focus:ring-[3px] focus:ring-petroleo/15 ' +
  'aria-[invalid=true]:border-[rgb(var(--fuera)/0.6)]';

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  help?: string;
  error?: string;
  visible: boolean;
  onAlternar: () => void;
}

export const CampoContrasena = forwardRef<HTMLInputElement, Props>(function CampoContrasena(
  { label, help, error, visible, onAlternar, ...rest },
  ref,
) {
  return (
    <FieldWrap label={label} help={help} error={error}>
      {(id, describedBy) => (
        <div className="relative">
          <input
            ref={ref}
            id={id}
            type={visible ? 'text' : 'password'}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={`${CONTROL} ${TACTIL}`}
            {...rest}
          />
          {/* Rótulo fijo y estado en aria-pressed: un botón que cambia de
              nombre y de estado a la vez se anuncia de forma confusa. */}
          <button
            type="button"
            onClick={onAlternar}
            aria-label="Mostrar la contraseña"
            aria-pressed={visible}
            aria-controls={id}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-tinta-3
              transition-colors duration-100 hover:text-tinta"
          >
            {visible ? (
              <EyeOff className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
            ) : (
              <Eye className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
            )}
          </button>
        </div>
      )}
    </FieldWrap>
  );
});
