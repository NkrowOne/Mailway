import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type Mailbox } from '../../lib/api';
import { cambioDominio, mensajeCambio, textoMensajeEquipo, type CambioDominioVista } from '../../lib/cambioDominio';
import { AvisoError, BotonCopiar, Cargando, Dialogo } from '../../ui/kit';

/*
  «Mensaje para tu equipo»: crea un enlace de configuración (7 días, sin
  contraseña) para cada persona pendiente y prepara el texto para enviarlo.
  Los enlaces se crean al abrir el diálogo, una vez: cada apertura los crea
  de nuevo, así que no se piden en segundo plano.
*/

/** Nombre visible de cada buzón, para que el mensaje diga «Ana (ana@…)». */
export function useNombresBuzones(): Map<string, string> {
  const buzones = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => api.get<{ mailboxes: Mailbox[] }>('/api/mailboxes'),
  });
  return useMemo(
    () => new Map((buzones.data?.mailboxes ?? []).map((m) => [m.id, m.displayName])),
    [buzones.data],
  );
}

export function MensajeEquipo({
  vista,
  open,
  onClose,
}: {
  vista: CambioDominioVista;
  open: boolean;
  onClose: () => void;
}) {
  const nombres = useNombresBuzones();
  const enlaces = useMutation({ mutationFn: () => cambioDominio.enlaces(vista.id) });
  const mensajeRef = useRef<HTMLDivElement>(null);

  // Se piden al abrir (no al montar la tarjeta): cada petición crea enlaces nuevos.
  const { mutate, reset } = enlaces;
  useEffect(() => {
    if (open) mutate();
    else reset();
  }, [open, mutate, reset]);

  const texto = enlaces.data
    ? textoMensajeEquipo(
        vista.hacia.domain,
        enlaces.data.enlaces.map((e) => ({ email: e.email, url: e.url, nombre: nombres.get(e.mailboxId) })),
      )
    : '';

  return (
    <Dialogo open={open} onClose={onClose} title="Mensaje para tu equipo" ancho="amplio">
      {enlaces.isPending || (!enlaces.data && !enlaces.isError) ? (
        <Cargando label="Creando los enlaces…" />
      ) : enlaces.isError ? (
        <AvisoError onRetry={() => mutate()} retrying={enlaces.isPending}>
          {mensajeCambio(enlaces.error, 'No se han podido crear los enlaces de configuración.')}
        </AvisoError>
      ) : enlaces.data && enlaces.data.enlaces.length === 0 ? (
        <p className="text-base text-tinta-2">Todas las personas han actualizado ya sus dispositivos.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-base text-tinta-2">
            Copia el mensaje y envíalo a tu equipo. Cada persona tiene su propio enlace.
          </p>
          <div className="min-w-0 overflow-hidden rounded-lg border border-regla bg-hoja-2">
            <div className="flex items-center justify-between gap-3 px-3 pt-2.5">
              <span className="rotulo">Mensaje</span>
              <BotonCopiar text={texto} label="Copiar mensaje" objetivo={mensajeRef} />
            </div>
            <div
              ref={mensajeRef}
              className="whitespace-pre-wrap px-3 pb-3 pt-1 text-base text-tinta [overflow-wrap:anywhere]"
            >
              {texto}
            </div>
          </div>
        </div>
      )}
    </Dialogo>
  );
}
