import { forwardRef, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { ClientDashboard, Mailbox, User } from '../../lib/api';
import type { DominioCorreo } from '../../lib/cloudflare';
import { Marca, type Veredicto } from '../../ui/kit';
import { PASOS, type EnlaceGuardado, type PasoId } from './comun';

/*
  Marco de la puesta en marcha: lo que comparten los cinco pasos (cabecera
  con el porqué, pie con la acción principal) y el índice de pasos.
*/

/** Todo lo que un paso necesita saber del cliente y de lo hecho hasta ahora. */
export interface ContextoPuesta {
  usuario: User;
  panel: ClientDashboard;
  dominios: DominioCorreo[];
  /** Dominio que se está poniendo en marcha (null: aún no hay ninguno). */
  dominio: DominioCorreo | null;
  /** Buzones del dominio en marcha. */
  buzones: Mailbox[];
  /** Todos los buzones del cliente (destinos de postmaster@ y abuse@). */
  buzonesCliente: Mailbox[];
  /** Enlaces creados en esta pestaña, con la contraseña dentro. */
  enlaces: EnlaceGuardado[];
  setEnlaces: (fn: (previos: EnlaceGuardado[]) => EnlaceGuardado[]) => void;
  /** Buzón de quien hace la puesta en marcha, si se sabe. */
  mioId: string | null;
  setMioId: (id: string | null) => void;
  /**
   * Correo personal de cada titular (por id de buzón), escrito al crear el
   * equipo o al enviar la configuración. Solo en esta pestaña: sirve para
   * proponerlo al volver a enviar.
   */
  personales: Record<string, string>;
  setPersonal: (mailboxId: string, correo: string) => void;
  /** Se ha pedido abrir directamente el alta de buzones (?anadir=1). */
  anadir: boolean;
  irA: (paso: PasoId) => void;
  /** Lleva a «Tu equipo» con el alta de buzones abierta. */
  anadirBuzones: () => void;
  suspendido: boolean;
}

/** Distintivo del buzón de quien hace la puesta en marcha. */
export function MarcaTu() {
  return (
    <span className="rounded-full bg-petroleo-claro px-2 py-px text-sm font-semibold text-petroleo">Tú</span>
  );
}

/** Resumen de un paso para el índice. */
export interface EstadoPaso {
  hecho: boolean;
  detalle: string;
  veredicto: Veredicto;
}

/**
 * Cabecera de cada paso: la pregunta o la tarea y, debajo, por qué importa
 * en una frase. Recibe el foco al cambiar de paso para que el teclado y el
 * lector de pantalla empiecen por aquí.
 */
export const CabeceraPaso = forwardRef<HTMLHeadingElement, { titulo: ReactNode; children?: ReactNode }>(
  function CabeceraPaso({ titulo, children }, ref) {
    return (
      <div className="mb-1">
        <h2
          ref={ref}
          tabIndex={-1}
          className="text-xl font-semibold tracking-[-0.01em] text-tinta [overflow-wrap:anywhere] focus:outline-none"
        >
          {titulo}
        </h2>
        {children && <div className="mt-1.5 max-w-[68ch] text-base text-tinta-2">{children}</div>}
      </div>
    );
  },
);

/**
 * Pie de cada paso: volver a la izquierda; saltar y la acción principal a la
 * derecha. En el móvil los botones ocupan el ancho y la acción principal va
 * arriba, al alcance del pulgar.
 */
export function PieDePaso({
  atras,
  onAtras,
  saltar,
  principal,
  nota,
}: {
  atras?: string;
  onAtras?: () => void;
  saltar?: ReactNode;
  principal?: ReactNode;
  /** Frase junto a la acción principal (por qué está desactivada, qué falta). */
  nota?: ReactNode;
}) {
  return (
    <div className="mt-2 flex flex-col gap-3 border-t border-regla pt-4">
      {nota && <p className="max-w-[68ch] text-sm text-tinta-2 sm:ml-auto sm:text-right">{nota}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex">
          {atras && onAtras && (
            <button
              type="button"
              onClick={onAtras}
              className="inline-flex h-9 min-h-11 w-full items-center justify-center gap-1.5 rounded-lg px-3 text-base font-medium
                text-tinta-2 transition hover:bg-hoja-3 hover:text-tinta sm:min-h-0 sm:w-auto sm:justify-start"
            >
              <span aria-hidden>←</span> {atras}
            </button>
          )}
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center [&>*]:min-h-11 [&>*]:w-full sm:[&>*]:min-h-0 sm:[&>*]:w-auto">
          {saltar}
          {principal}
        </div>
      </div>
    </div>
  );
}

/** Fila de estado reglada: concepto, veredicto y, si hace falta, una nota. */
export function FilaEstado({
  concepto,
  veredicto,
  estado,
  nota,
  accion,
}: {
  concepto: ReactNode;
  veredicto: Veredicto;
  estado: ReactNode;
  nota?: ReactNode;
  accion?: ReactNode;
}) {
  const tinte = veredicto === 'fuera' ? 'fila-fuera' : veredicto === 'vigilar' ? 'fila-vigilar' : '';
  return (
    <div className={`regla-fila px-4 py-3 last:border-b-0 ${tinte}`}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="min-w-0 flex-1 basis-48 text-base text-tinta [overflow-wrap:anywhere]">{concepto}</span>
        <span className="ml-auto shrink-0">
          <Marca veredicto={veredicto}>{estado}</Marca>
        </span>
      </div>
      {(nota || accion) && (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {nota && <p className="min-w-0 max-w-[68ch] flex-1 basis-56 text-sm text-tinta-2">{nota}</p>}
          {accion && <div className="shrink-0">{accion}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * Círculo numerado de un paso: actual en petróleo, hecho con su marca,
 * pendiente en gris y, si necesita atención (un buzón sin configurar), en rojo.
 */
function Numero({ i, actual, hecho, atencion = false }: { i: number; actual: boolean; hecho: boolean; atencion?: boolean }) {
  return (
    <span
      aria-hidden
      className={`valor flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold transition-colors ${
        actual
          ? 'bg-petroleo text-white'
          : atencion
            ? 'bg-fuera-fondo text-fuera ring-1 ring-[rgb(var(--fuera)/0.45)]'
            : hecho
              ? 'bg-petroleo-claro text-petroleo'
              : 'bg-hoja-3 text-tinta-3'
      }`}
    >
      {hecho && !actual && !atencion ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : i + 1}
    </span>
  );
}

/**
 * Índice de pasos en escritorio ancho: columna fija a la izquierda con el
 * estado de cada uno. Se puede saltar a cualquier paso; los que dependen de
 * otro lo explican al abrirlos.
 */
export function IndicePasos({
  actual,
  estados,
  onIr,
}: {
  actual: PasoId;
  estados: Record<PasoId, EstadoPaso>;
  onIr: (paso: PasoId) => void;
}) {
  const posicion = PASOS.findIndex((p) => p.id === actual);
  return (
    <nav aria-label="Pasos de la puesta en marcha" className="hoja-panel overflow-hidden rounded-xl border border-regla bg-hoja">
      <div className="regla-cabecera flex items-baseline justify-between gap-3 px-4 py-3.5">
        <span className="text-md font-semibold text-tinta">Pasos</span>
        <span className="valor text-sm text-tinta-3">
          Paso {posicion + 1} de {PASOS.length}
        </span>
      </div>
      <ol>
        {PASOS.map((paso, i) => {
          const esActual = paso.id === actual;
          const estado = estados[paso.id];
          return (
            <li key={paso.id} className="regla-fila last:border-b-0">
              <button
                type="button"
                onClick={() => onIr(paso.id)}
                aria-current={esActual ? 'step' : undefined}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-100 hover:bg-hoja-2 ${
                  esActual ? 'bg-hoja-2' : ''
                }`}
              >
                <Numero i={i} actual={esActual} hecho={estado.hecho} atencion={estado.veredicto === 'fuera'} />
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-base ${esActual ? 'font-semibold text-petroleo' : estado.hecho ? 'text-tinta' : 'text-tinta-2'}`}
                  >
                    {paso.rotulo}
                  </span>
                  {estado.detalle && (
                    <span
                      className={`block text-sm ${
                        estado.veredicto === 'fuera'
                          ? 'font-medium text-fuera'
                          : estado.veredicto === 'vigilar'
                            ? 'text-vigilar'
                            : estado.veredicto === 'normal'
                              ? 'text-normal'
                              : 'text-tinta-3'
                      }`}
                    >
                      {estado.detalle}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="border-t border-regla px-4 py-3 text-sm text-tinta-3">
        Todo se guarda al momento: puedes dejarlo y seguir más tarde.
      </p>
    </nav>
  );
}

/**
 * Índice compacto para el móvil y las pantallas medianas: «Paso 2 de 5»,
 * el nombre del paso y los cinco círculos, que también llevan a cada paso.
 */
export function IndiceCompacto({
  actual,
  estados,
  onIr,
}: {
  actual: PasoId;
  estados: Record<PasoId, EstadoPaso>;
  onIr: (paso: PasoId) => void;
}) {
  const posicion = PASOS.findIndex((p) => p.id === actual);
  return (
    <nav
      aria-label="Pasos de la puesta en marcha"
      className="hoja-panel flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-xl border border-regla bg-hoja px-4 py-3"
    >
      <div className="min-w-0">
        <p className="valor text-sm text-tinta-3">
          Paso {posicion + 1} de {PASOS.length}
        </p>
        <p className="text-md font-semibold text-tinta">{PASOS[posicion]?.rotulo}</p>
      </div>
      <ol className="flex items-center">
        {PASOS.map((paso, i) => {
          const esActual = paso.id === actual;
          const estado = estados[paso.id];
          return (
            <li key={paso.id} className="flex items-center">
              {i > 0 && (
                <span aria-hidden className={`h-px w-3 sm:w-5 ${estados[PASOS[i - 1]!.id].hecho ? 'bg-[rgb(var(--petroleo)/0.4)]' : 'bg-[var(--regla-fuerte)]'}`} />
              )}
              <button
                type="button"
                onClick={() => onIr(paso.id)}
                aria-current={esActual ? 'step' : undefined}
                aria-label={`Paso ${i + 1}: ${paso.rotulo}${
                  estado.veredicto === 'fuera' ? ` (${estado.detalle.toLowerCase()})` : estado.hecho ? ' (hecho)' : ''
                }`}
                className="flex h-11 w-9 items-center justify-center rounded-lg"
              >
                <Numero i={i} actual={esActual} hecho={estado.hecho} atencion={estado.veredicto === 'fuera'} />
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
