import type { ReactNode } from 'react';
import type { AvisoCambio, CompuertaCambio, FaseCambio } from '../../lib/cambioDominio';
import { AvisoError, Marca, type Veredicto } from '../../ui/kit';

/*
  Piezas del asistente «Cambiar de dominio»: los pasos, las secciones de la
  tarjeta, la lista de comprobaciones para pasar y las bandas de bloqueos y
  avisos. Mismo sistema que el resto del panel (DESIGN.md): tarjeta blanca,
  filas regladas con flex y color solo para calificar un dato.
*/

/** Bloque de la tarjeta separado por una regla: la tarjeta va sin relleno (`flush`). */
export function Seccion({
  titulo,
  meta,
  children,
  className = '',
}: {
  titulo?: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`regla-fila px-4 py-4 last:border-b-0 ${className}`}>
      {titulo && (
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <h3 className="text-base font-semibold text-tinta">{titulo}</h3>
          {meta && <span className="text-sm text-tinta-3">{meta}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

const PASOS: { id: FaseCambio | 'elegir'; titulo: string }[] = [
  { id: 'elegir', titulo: 'Elegir' },
  { id: 'preparar', titulo: 'Preparar' },
  { id: 'transicion', titulo: 'En transición' },
  { id: 'terminado', titulo: 'Terminado' },
];

/**
 * Los cuatro pasos con el actual resaltado. Orienta sobre lo que falta: el
 * cambio dura días y quien vuelve a la ficha tiene que ver dónde se quedó.
 */
export function PasosCambio({ actual }: { actual: FaseCambio | 'elegir' }) {
  const indice = PASOS.findIndex((p) => p.id === actual);
  return (
    <ol aria-label="Pasos del cambio de dominio" className="flex flex-wrap gap-x-5 gap-y-2">
      {PASOS.map((paso, i) => {
        const esActual = i === indice;
        const hecho = i < indice;
        return (
          <li key={paso.id} aria-current={esActual ? 'step' : undefined} className="flex items-center gap-2">
            <span
              aria-hidden
              className={`valor flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                esActual
                  ? 'bg-petroleo-claro text-petroleo'
                  : hecho
                    ? 'bg-hoja-3 text-tinta-2'
                    : 'border border-regla-fuerte text-tinta-3'
              }`}
            >
              {i + 1}
            </span>
            <span className={`text-sm ${esActual ? 'font-semibold text-tinta' : hecho ? 'text-tinta-2' : 'text-tinta-3'}`}>
              {paso.titulo}
              {hecho && <span className="sr-only"> (hecho)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Estado de una comprobación para pasar. El motor o un cliente suspendido
 * son averías; el resto, pasos pendientes del DNS. La que no bloquea (el
 * webmail con tu marca) no se pinta como un problema.
 */
function lecturaCompuerta(c: CompuertaCambio): { veredicto: Veredicto; texto: string } {
  if (c.ok) return { veredicto: 'normal', texto: 'Correcto' };
  if (!c.bloquea) return { veredicto: 'sin-dato', texto: 'No bloquea' };
  if (c.id === 'motor' || c.id === 'cliente') return { veredicto: 'fuera', texto: 'Necesita atención' };
  return { veredicto: 'vigilar', texto: 'Pendiente' };
}

/** Comprobaciones para pasar, en el orden en que se van cumpliendo (el del servidor). */
export function ListaCompuertas({ compuertas }: { compuertas: CompuertaCambio[] }) {
  return (
    <ul className="rounded-lg border border-regla">
      {compuertas.map((c) => {
        const { veredicto, texto } = lecturaCompuerta(c);
        const tinte = veredicto === 'fuera' ? 'fila-fuera' : '';
        return (
          <li
            key={c.id}
            className={`regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-2.5 last:border-b-0 ${tinte}`}
          >
            <div className="min-w-0 flex-1 basis-56">
              <p className="text-base text-tinta [overflow-wrap:anywhere]">{c.titulo}</p>
              {c.detalle && <p className="text-sm text-tinta-2 [overflow-wrap:anywhere]">{c.detalle}</p>}
            </div>
            <span className="ml-auto shrink-0">
              <Marca veredicto={veredicto}>{texto}</Marca>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Lo que impide continuar (en rojo) y lo que conviene saber (en ámbar), con el mensaje del servidor. */
export function BloqueosYAvisos({ bloqueos = [], avisos = [] }: { bloqueos?: AvisoCambio[]; avisos?: AvisoCambio[] }) {
  if (bloqueos.length === 0 && avisos.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {bloqueos.length > 0 && (
        <AvisoError>
          {bloqueos.length === 1 ? (
            bloqueos[0]!.mensaje
          ) : (
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {bloqueos.map((b) => (
                <li key={b.code + b.mensaje}>{b.mensaje}</li>
              ))}
            </ul>
          )}
        </AvisoError>
      )}
      {avisos.length > 0 && (
        <div role="status" className="rounded-lg border border-[rgb(var(--vigilar)/0.45)] bg-vigilar-fondo px-3 py-2 text-sm text-tinta">
          {avisos.length === 1 ? (
            <p className="max-w-[75ch]">{avisos[0]!.mensaje}</p>
          ) : (
            <ul className="flex max-w-[75ch] list-disc flex-col gap-1 pl-5">
              {avisos.map((a) => (
                <li key={a.code + a.mensaje}>{a.mensaje}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** El cambio nació en Skyway: aquí solo quedan las acciones de las personas. */
export function BandaSkyway() {
  return (
    <div role="status" className="rounded-lg border border-regla bg-hoja-2 px-3 py-2.5 text-base text-tinta-2">
      Este cambio de dominio se gestiona desde Skyway.
    </div>
  );
}

/**
 * Acción en marcha (pasar, volver o dar de baja): el aro del sistema y el
 * paso por el que va. La vista se vuelve a pedir sola cada pocos segundos.
 */
export function EnMarcha({ texto, paso }: { texto: string; paso: string }) {
  return (
    <div role="status" className="flex items-center gap-3 rounded-lg border border-regla bg-hoja-2 px-3 py-3">
      <span
        aria-hidden
        className="girar h-5 w-5 shrink-0 rounded-full border-2 border-[rgb(var(--petroleo)/0.18)] border-t-[rgb(var(--petroleo))]"
      />
      <span className="min-w-0 text-base text-tinta [overflow-wrap:anywhere]">
        {texto}
        {paso && <span className="valor ml-2 text-sm text-tinta-3">{paso}</span>}
      </span>
    </div>
  );
}
