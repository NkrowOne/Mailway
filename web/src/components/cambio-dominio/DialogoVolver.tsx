import { useEffect } from 'react';
import { cambioDominio, mensajeCambio, type CambioDominioVista } from '../../lib/cambioDominio';
import { AvisoError } from '../../ui/kit';
import { DialogoConfirmar, useAccionCambio } from './acciones';

/**
 * «Volver a dominio.es»: desde «En transición» o desde un «Pasar» que falló.
 * Nadie pierde el acceso: quien ya actualizó sus dispositivos sigue entrando
 * con el usuario nuevo.
 */
export function DialogoVolver({
  vista,
  open,
  onClose,
}: {
  vista: CambioDominioVista;
  open: boolean;
  onClose: () => void;
}) {
  const volver = useAccionCambio(vista.id, (id) => cambioDominio.volver(id), {
    aviso: (v) => `El correo vuelve a salir como @${v.desde.domain}.`,
    onHecho: onClose,
  });
  const { reset } = volver;

  // Cada apertura empieza sin el error de la anterior.
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  return (
    <DialogoConfirmar
      open={open}
      titulo={`Volver a ${vista.desde.domain}`}
      textoAccion={`Volver a ${vista.desde.domain}`}
      ocupado={volver.isPending}
      error={
        volver.isError && <AvisoError>{mensajeCambio(volver.error, `No se ha podido volver a ${vista.desde.domain}.`)}</AvisoError>
      }
      onConfirmar={() => volver.mutate()}
      onClose={onClose}
    >
      <p>
        El correo volverá a salir como @{vista.desde.domain}. Quien ya haya actualizado sus dispositivos seguirá
        entrando con su usuario de {vista.hacia.domain}.
      </p>
    </DialogoConfirmar>
  );
}
