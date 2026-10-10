import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import {
  actualizarUsuarioBuzon,
  invalidarTrasActualizarUsuario,
  mensajeCambio,
  textoAppsManuales,
  textoConfirmarActualizar,
} from '../../lib/cambioDominio';
import type { AppPasswordInfo } from '../../lib/gestion';
import { Button } from '../../ui/Button';
import { AvisoError, Dialogo } from '../../ui/kit';
import { useToast } from '../../ui/toast';

/*
  «Actualizar ahora»: el usuario con el que entran los dispositivos de un
  buzón pasa a ser su dirección nueva. Lo usan la lista de buzones, su ficha
  y la lista «Personas» del asistente. La contraseña no cambia; los
  dispositivos que sigan con el usuario anterior dejan de conectar, por eso
  siempre se confirma antes.
*/

export interface BuzonPendiente {
  id: string;
  /** Dirección vigente (la nueva). */
  email: string;
  /** Usuario actual de los dispositivos (el de la dirección anterior). */
  login: string;
  /**
   * Contraseñas de aplicación creadas a mano, si quien abre el diálogo ya las
   * sabe (la vista del cambio). Sin el campo (la ficha del buzón), se piden.
   */
  appsManuales?: string[];
}

/**
 * Línea bajo la dirección de un buzón pendiente: con qué usuario entra y, si
 * se puede, la acción para actualizarlo.
 */
export function LineaUsuarioPendiente({
  login,
  onActualizar,
  className = '',
}: {
  login: string;
  onActualizar?: () => void;
  className?: string;
}) {
  return (
    <p className={`text-sm ${className}`}>
      <span className="text-tinta-2">
        Entra con <span className="valor break-all">{login}</span>
      </span>
      <span className="text-tinta-3"> · </span>
      <span className="font-medium text-vigilar">Pendiente de actualizar dispositivos</span>
      {onActualizar && (
        <>
          <span className="text-tinta-3"> · </span>
          <button
            type="button"
            onClick={onActualizar}
            className="text-petroleo underline decoration-1 underline-offset-2 hover:text-tinta"
          >
            Actualizar ahora
          </button>
        </>
      )}
    </p>
  );
}

/**
 * Confirmación y acción. Se puede incrustar en una vista de la ficha del
 * buzón (sin apilar diálogos) o en el diálogo de abajo.
 */
export function ConfirmarActualizarUsuario({
  buzon,
  onHecho,
  onCancelar,
}: {
  buzon: BuzonPendiente;
  onHecho: () => void;
  onCancelar: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  // La misma consulta que la vista de contraseñas de aplicación de la ficha.
  // Solo completa la confirmación: mientras carga, o si falla, se omite la línea.
  const apps = useQuery({
    queryKey: ['app-passwords', buzon.id],
    queryFn: () => api.get<{ appPasswords: AppPasswordInfo[] }>(`/api/mailboxes/${buzon.id}/app-passwords`),
    enabled: buzon.appsManuales === undefined,
  });
  // Mismo criterio que el servidor (appsManualesDe): activas y que no son de Skyway.
  const appsManuales =
    buzon.appsManuales ??
    (apps.data?.appPasswords ?? []).filter((a) => !a.revokedAt && !a.name.startsWith('skyway:')).map((a) => a.name);
  const actualizar = useMutation({
    mutationFn: () => actualizarUsuarioBuzon(buzon.id),
    onSuccess: async () => {
      await invalidarTrasActualizarUsuario(queryClient);
      toast('ok', `Usuario actualizado: ${buzon.email} entra ahora con su dirección.`);
      onHecho();
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-base text-tinta-2 [overflow-wrap:anywhere]">
        {textoConfirmarActualizar(buzon.email, buzon.login)}
      </p>
      {appsManuales.length > 0 && (
        <p className="text-base text-tinta-2 [overflow-wrap:anywhere]">{textoAppsManuales(appsManuales, buzon.email)}</p>
      )}
      {actualizar.isError && (
        <AvisoError>{mensajeCambio(actualizar.error, 'No se ha podido actualizar el usuario del buzón.')}</AvisoError>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="plano" onClick={onCancelar}>
          Cancelar
        </Button>
        <Button variant="principal" busy={actualizar.isPending} onClick={() => actualizar.mutate()}>
          Actualizar ahora
        </Button>
      </div>
    </div>
  );
}

/** Diálogo de «Actualizar ahora» para las listas (buzones del asistente). */
export function DialogoActualizarUsuario({
  buzon,
  onClose,
}: {
  buzon: BuzonPendiente | null;
  onClose: () => void;
}) {
  return (
    <Dialogo open={buzon !== null} onClose={onClose} title="Actualizar el usuario">
      {buzon && <ConfirmarActualizarUsuario key={buzon.id} buzon={buzon} onHecho={onClose} onCancelar={onClose} />}
    </Dialogo>
  );
}
