import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Mailbox } from '../../lib/api';
import { cambioDominio, mensajeCambio, textoMensajeEquipo, type CambioDominioVista } from '../../lib/cambioDominio';
import { AvisoError, BotonCopiar, Cargando, Dialogo } from '../../ui/kit';

/*
  «Mensaje para tu equipo»: crea un enlace de configuración (7 días, sin
  contraseña) para cada persona pendiente y prepara el texto para enviarlo.

  Cada petición crea enlaces nuevos (y una entrada de auditoría por persona),
  así que se piden la primera vez que se abre el diálogo y se conservan
  mientras la página siga abierta: abrir y cerrar no multiplica los enlaces
  válidos. Solo se vuelven a pedir si alguno está a punto de caducar.
*/

/** Margen antes de la caducidad con el que se crean enlaces nuevos al abrir. */
const MARGEN_CADUCIDAD = 60 * 60_000;

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
  const enlaces = useQuery({
    queryKey: ['domain-migration-links', vista.id],
    queryFn: () => cambioDominio.enlaces(vista.id),
    // Es un POST con efectos: solo al abrir, sin reintentos automáticos ni
    // relecturas (ni al volver a la pestaña ni al reconectar).
    enabled: open,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const mensajeRef = useRef<HTMLDivElement>(null);

  // Si la página lleva abierta casi los 7 días, los enlaces guardados caducan:
  // al abrir de nuevo se crean otros.
  const { data, refetch } = enlaces;
  useEffect(() => {
    if (!open || !data) return;
    if (data.enlaces.some((e) => e.expiresAt - Date.now() < MARGEN_CADUCIDAD)) void refetch();
  }, [open, data, refetch]);

  // Quien ya actualizó desde que se crearon los enlaces no necesita el suyo.
  const pendientes = new Set(vista.buzones.lista.filter((p) => p.pendiente).map((p) => p.id));
  const vigentes = (data?.enlaces ?? []).filter((e) => pendientes.has(e.mailboxId));

  const texto = textoMensajeEquipo(
    vista.hacia.domain,
    vigentes.map((e) => ({ email: e.email, url: e.url, nombre: nombres.get(e.mailboxId) })),
  );

  return (
    <Dialogo open={open} onClose={onClose} title="Mensaje para tu equipo" ancho="amplio">
      {enlaces.isFetching && !data ? (
        <Cargando label="Creando los enlaces…" />
      ) : enlaces.isError && !data ? (
        <AvisoError onRetry={() => void refetch()} retrying={enlaces.isFetching}>
          {mensajeCambio(enlaces.error, 'No se han podido crear los enlaces de configuración.')}
        </AvisoError>
      ) : !data ? (
        <Cargando label="Creando los enlaces…" />
      ) : vigentes.length === 0 ? (
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
