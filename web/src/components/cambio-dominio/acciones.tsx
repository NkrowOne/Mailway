import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { claveCambio, invalidarTrasCambio, type CambioDominioVista } from '../../lib/cambioDominio';
import { Button } from '../../ui/Button';
import { Dialogo } from '../../ui/kit';
import { useToast } from '../../ui/toast';

/*
  Acciones del asistente. Todas devuelven la vista del cambio, que se guarda
  tal cual; si fallan, el servidor deja el error en el propio cambio (con
  «Reintentar»), así que se vuelve a pedir la vista para mostrarlo.
*/

export function useAccionCambio<V = void>(
  id: string,
  accion: (id: string, variables: V) => Promise<CambioDominioVista>,
  opciones: { aviso?: (vista: CambioDominioVista) => string; onHecho?: (vista: CambioDominioVista) => void } = {},
) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (variables: V) => accion(id, variables),
    // Una relectura en vuelo (la vista se sondea) no debe pisar la vista que
    // devuelve la acción con una anterior.
    onMutate: () => queryClient.cancelQueries({ queryKey: claveCambio(id) }),
    onSuccess: async (vista) => {
      queryClient.setQueryData(claveCambio(id), vista);
      if (opciones.aviso) toast('ok', opciones.aviso(vista));
      opciones.onHecho?.(vista);
      await invalidarTrasCambio(queryClient);
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: claveCambio(id) });
    },
  });
}

/**
 * Confirmación de una acción del asistente: el texto que explica lo que
 * pasará y dos botones. El error se muestra dentro, junto al botón que lo provocó.
 */
export function DialogoConfirmar({
  open,
  titulo,
  children,
  textoAccion,
  textoCancelar = 'Cancelar',
  variante = 'principal',
  ocupado,
  error,
  onConfirmar,
  onClose,
}: {
  open: boolean;
  titulo: string;
  children: ReactNode;
  textoAccion: string;
  textoCancelar?: string;
  variante?: 'principal' | 'peligro';
  ocupado: boolean;
  error?: ReactNode;
  onConfirmar: () => void;
  onClose: () => void;
}) {
  return (
    <Dialogo open={open} onClose={onClose} title={titulo}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 text-base text-tinta-2 [overflow-wrap:anywhere]">{children}</div>
        {error}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="plano" onClick={onClose}>
            {textoCancelar}
          </Button>
          <Button variant={variante} busy={ocupado} onClick={onConfirmar}>
            {textoAccion}
          </Button>
        </div>
      </div>
    </Dialogo>
  );
}
