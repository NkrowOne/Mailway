import type { ReactNode } from 'react';
import { IlustracionBuzon } from '../../components/Portadas';
import { Logotipo } from '../../ui/kit';

/**
 * Pantalla de acceso del titular: tarjeta centrada con un ordenador y un
 * móvil encima, sobre un fondo con un velo petróleo. Muy distinta de la del
 * panel (dos columnas), porque viven en la misma dirección. La comparten
 * «Mi buzón» y el paso al correo web con llave de acceso. Vive aparte de
 * comun.tsx para que el panel, que usa piezas de allí, no cargue la ilustración.
 */
export function MarcoAccesoPortal({
  marca,
  children,
  pie,
}: {
  marca: string;
  children: ReactNode;
  /** Notas bajo la tarjeta, centradas y en pequeño. */
  pie?: ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-mesa px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[26rem]"
        style={{
          background:
            'radial-gradient(55% 100% at 50% 0%, rgb(122 211 200 / 0.26), transparent 72%), radial-gradient(35% 60% at 12% 0%, rgb(13 92 94 / 0.07), transparent 70%)',
        }}
      />
      <div className="relative w-full max-w-[26rem] animate-aparecer">
        <div className="mb-5 flex items-center justify-center gap-3">
          <Logotipo />
          <span className="min-w-0 break-words text-lg font-semibold text-tinta">{marca}</span>
        </div>
        <section className="hoja-panel overflow-hidden rounded-3xl border border-regla bg-hoja">
          <div className="flex justify-center bg-gradient-to-b from-petroleo-claro to-hoja px-6 pb-2 pt-7">
            <IlustracionBuzon className="h-auto w-[15rem] max-w-full" />
          </div>
          {children}
        </section>
        {pie && <div className="mt-5 flex flex-col gap-2 text-center text-sm text-tinta-3">{pie}</div>}
      </div>
    </div>
  );
}
