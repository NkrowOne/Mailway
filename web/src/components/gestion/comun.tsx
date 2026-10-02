import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { DomainRecord } from '../../lib/api';
import { propiedadPendiente } from '../../lib/cloudflare';
import { TEXTO_PROPIEDAD_PENDIENTE } from '../../lib/dominios';
import { Select } from '../../ui/Field';
import { AvisoError } from '../../ui/kit';

/*
  Piezas pequeñas que comparten las vistas de gestión (clientes, planes,
  buzones y alias). Siguen las bandas de mensaje de DESIGN.md: filete y fondo
  tenue del color del veredicto, texto a 12-14 px.
*/

/**
 * Banda de error de página o de formulario. Es la del kit (una sola banda de
 * error en toda la aplicación); se conserva el nombre por las vistas que la usan.
 */
export function BandaError({
  children,
  onRetry,
  retrying,
}: {
  children: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <AvisoError onRetry={onRetry} retrying={retrying}>
      {children}
    </AvisoError>
  );
}

/** Banda de advertencia: algo que conviene leer antes de continuar. */
export function BandaAviso({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-[rgb(var(--vigilar)/0.45)] bg-vigilar-fondo px-3 py-2 text-sm text-tinta"
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

/** Motivo por el que no se puede elegir un dominio en un alta, o null si se puede. */
export type MotivoBloqueoDominio = (domain: DomainRecord) => string | null;

/** Motivo de bloqueo de un dominio: primero la propiedad, después el que indique la vista. */
export function motivoDominio(domain: DomainRecord, extra?: MotivoBloqueoDominio): string | null {
  if (propiedadPendiente(domain)) return TEXTO_PROPIEDAD_PENDIENTE;
  return extra?.(domain) ?? null;
}

/** Dominio que se propone al abrir un alta: el indicado si se puede usar, o el primero que se pueda. */
export function dominioInicialDisponible(
  domains: DomainRecord[],
  preferido: string | undefined,
  extra?: MotivoBloqueoDominio,
): string {
  const usable = (d: DomainRecord) => motivoDominio(d, extra) === null;
  const elegido = domains.find((d) => d.id === preferido && usable(d)) ?? domains.find(usable);
  return elegido?.id ?? '';
}

/**
 * Selector de dominio de las altas de buzones y alias. Los dominios que no se
 * pueden usar siguen en la lista, desactivados y con el motivo, para que el
 * usuario no crea que han desaparecido; los que esperan la comprobación de
 * propiedad enlazan a su ficha, que es donde se resuelve.
 */
export function SelectorDominio({
  domains,
  value,
  onChange,
  etiquetaDominio,
  motivoBloqueo,
  uso,
}: {
  domains: DomainRecord[];
  value: string;
  onChange: (domainId: string) => void;
  etiquetaDominio: (d: DomainRecord) => string;
  motivoBloqueo?: MotivoBloqueoDominio;
  /** «buzones» o «alias», para el texto de ayuda. */
  uso: string;
}) {
  const pendientes = domains.filter(propiedadPendiente);
  const ninguno = domains.every((d) => motivoDominio(d, motivoBloqueo) !== null);
  return (
    <div className="flex flex-col gap-2">
      <Select
        label="Dominio"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        error={ninguno ? `Ningún dominio admite ${uso} en este momento.` : undefined}
      >
        {ninguno && <option value="">Sin dominios disponibles</option>}
        {domains.map((domain) => {
          const motivo = motivoDominio(domain, motivoBloqueo);
          return (
            <option key={domain.id} value={domain.id} disabled={motivo !== null}>
              {etiquetaDominio(domain)}
              {motivo ? ` — ${motivo}` : ''}
            </option>
          );
        })}
      </Select>
      {pendientes.length > 0 && (
        <p className="text-sm text-tinta-2">
          {pendientes.length === 1 ? 'El dominio ' : 'Los dominios '}
          {pendientes.map((d, i) => (
            <span key={d.id}>
              {i > 0 && (i === pendientes.length - 1 ? ' y ' : ', ')}
              <Link
                to={`/dominios/${d.id}`}
                className="valor break-all text-laboratorio underline underline-offset-2 hover:text-tinta"
              >
                {d.domainUnicode || d.domain}
              </Link>
            </span>
          ))}{' '}
          {pendientes.length === 1 ? 'está pendiente' : 'están pendientes'} de comprobar la propiedad y no
          admite{pendientes.length === 1 ? '' : 'n'} {uso} hasta completar la comprobación en su ficha.
        </p>
      )}
    </div>
  );
}
