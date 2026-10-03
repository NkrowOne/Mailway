import type { ReactNode } from 'react';
import { estiloBoton } from '../../ui/Button';
import { AvisoError, MarcaFondo } from '../../ui/kit';
import {
  nombreCorto,
  ordenarCambios,
  textoAccion,
  veredictoAccion,
  type CambioPlan,
  type ResultadoAplicacion,
} from '../../lib/cloudflare';

/*
  Piezas comunes de la integración con Cloudflare: la tabla de cambios de un
  plan, el resultado de aplicarlo y la banda de error. Las usan la ficha del
  dominio y la hoja de Conexiones.
*/

/**
 * Enlace con el aspecto del botón secundario (un <a> nunca envuelve un
 * <button>). Sale de estiloBoton para no desincronizarse del kit.
 */
export const claseEnlacePerfil = estiloBoton('perfil');

/**
 * Banda de error en línea: nombra el problema y, si puede, el arreglo. Es la
 * del kit (AvisoError), para que todos los errores se vean igual; con
 * `onRetry` ofrece «Reintentar».
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

/** Banda de aviso (ámbar): algo que conviene leer antes de seguir. */
export function BandaAviso({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-[rgb(var(--vigilar)/0.4)] bg-vigilar-fondo px-3 py-2.5">
      <p className="rotulo text-vigilar">{titulo}</p>
      <div className="mt-1 max-w-[75ch] text-sm text-tinta">{children}</div>
    </div>
  );
}

/**
 * Tabla reglada de los cambios de un plan. Se lee en orden de atención:
 * conflictos, actualizaciones, altas y, al final, lo que ya está bien.
 */
export function TablaCambios({ cambios, apex }: { cambios: CambioPlan[]; apex?: string }) {
  return (
    <ul className="border-t border-regla">
      {ordenarCambios(cambios).map((c, i) => {
        const veredicto = veredictoAccion[c.action];
        const tinte = veredicto === 'fuera' ? 'fila-fuera' : veredicto === 'vigilar' ? 'fila-vigilar' : '';
        return (
          <li key={`${c.type}-${c.name}-${i}`} className={`regla-fila px-3 py-2.5 ${tinte}`}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="valor min-w-0 basis-full break-all text-sm text-tinta sm:basis-0 sm:grow">
                {apex ? nombreCorto(c.name, apex) : c.name}
                {c.zone && <span className="ml-2 text-tinta-3">({c.zone})</span>}
              </span>
              <span className="rotulo shrink-0">
                {c.type}
                {c.required ? '' : ' · recomendado'}
              </span>
              <span className="ml-auto shrink-0 sm:ml-0">
                <MarcaFondo veredicto={veredicto}>{textoAccion[c.action]}</MarcaFondo>
              </span>
            </div>
            {c.action !== 'keep' && (
              <p className="valor mt-1 break-all text-sm text-tinta-2">
                {c.priority !== undefined ? `${c.priority} ` : ''}
                {c.content}
              </p>
            )}
            {c.current && (
              <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
                <span className="rotulo shrink-0">{c.action === 'keep' ? 'Existente' : 'Ahora'}</span>
                <span className="valor min-w-0 break-all text-sm text-tinta-3">{c.current}</span>
              </p>
            )}
            <p className="mt-1 max-w-[75ch] text-sm text-tinta-2">{c.reason}</p>
          </li>
        );
      })}
    </ul>
  );
}

const textoAplicado: Record<string, string> = {
  create: 'Creado',
  update: 'Actualizado',
  replace: 'Reemplazado',
};

/** Resultado de aplicar un plan: lo aplicado, lo que falló y lo que no se tocó. */
export function ResultadoCloudflare({ resultado, apex }: { resultado: ResultadoAplicacion; apex?: string }) {
  const omitidos = resultado.skipped ?? [];
  const nombre = (n: string) => (apex ? nombreCorto(n, apex) : n);
  const nada = resultado.applied.length === 0 && resultado.errors.length === 0;
  return (
    <div className="revelar flex flex-col gap-3" role="status">
      {nada && omitidos.length === 0 && (
        <p className="text-base text-tinta-2">
          No había cambios pendientes: los registros ya estaban configurados en Cloudflare.
        </p>
      )}
      {resultado.applied.length > 0 && (
        <div>
          <p className="text-base text-tinta">
            Se {resultado.applied.length === 1 ? 'ha aplicado 1 cambio' : `han aplicado ${resultado.applied.length} cambios`}{' '}
            en Cloudflare.
          </p>
          <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {resultado.applied.map((a, i) => (
              <li key={`${a.type}-${a.name}-${i}`} className="text-sm text-tinta-2">
                <span className="rotulo mr-1.5">{textoAplicado[a.action] ?? a.action}</span>
                <span className="valor break-all">
                  {a.type} {nombre(a.name)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {resultado.errors.length > 0 && (
        <BandaError>
          <p>
            {resultado.errors.length === 1
              ? 'No se ha podido aplicar 1 registro:'
              : `No se han podido aplicar ${resultado.errors.length} registros:`}
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {resultado.errors.map((e, i) => (
              <li key={`${e.type}-${e.name}-${i}`}>
                <span className="valor break-all">
                  {e.type} {nombre(e.name)}
                </span>
                : {e.error}
              </li>
            ))}
          </ul>
        </BandaError>
      )}
      {omitidos.length > 0 && (
        <BandaAviso
          titulo={`Sin modificar: ${omitidos.length} ${omitidos.length === 1 ? 'registro existente' : 'registros existentes'}`}
        >
          <ul className="flex flex-col gap-1">
            {omitidos.map((s, i) => (
              <li key={`${s.type}-${s.name}-${i}`}>
                <span className="valor break-all">
                  {s.type} {nombre(s.name)}
                </span>
                : {s.reason}
              </li>
            ))}
          </ul>
        </BandaAviso>
      )}
    </div>
  );
}
