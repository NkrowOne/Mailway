import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type ClientDomain } from '../lib/api';
import { Button } from '../ui/Button';
import { AvisoError, Cargando, Dialogo, Hoja } from '../ui/kit';
import { useToast } from '../ui/toast';
import { Botonera, Casilla } from './gestion/comun';

interface EstadoWebmailAutomatico {
  webmailAutomatico: boolean;
  global: boolean;
  webmailDomains: ClientDomain[];
}

/**
 * Interruptor del webmail automático de un cliente: con él activado, cada
 * dominio de correo con la propiedad comprobada recibe su webmail en
 * webmail.<dominio> sin darlo de alta a mano. Desactivarlo retira los que se
 * crearon solos, así que pide confirmación. Es el mismo interruptor que el
 * botón de Skyway.
 */
export function HojaWebmailAutomatico({ clientId, isAdmin }: { clientId: string; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmar, setConfirmar] = useState(false);
  const clave = ['webmail-automatico', clientId];

  const estado = useQuery({
    queryKey: clave,
    queryFn: () => api.get<EstadoWebmailAutomatico>(`/api/clients/${encodeURIComponent(clientId)}/webmail-automatico`),
  });

  const cambiar = useMutation({
    mutationFn: (activo: boolean) =>
      api.put<EstadoWebmailAutomatico>(`/api/clients/${encodeURIComponent(clientId)}/webmail-automatico`, { activo }),
    onSuccess: async (data) => {
      setConfirmar(false);
      queryClient.setQueryData(clave, data);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['whitelabel-domains'] }),
        queryClient.invalidateQueries({ queryKey: ['client-dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['conexion'] }),
      ]);
      toast(
        'ok',
        data.webmailAutomatico
          ? 'Webmail automático activado. Los dominios comprobados tendrán su webmail en unos minutos.'
          : 'Webmail automático desactivado. Los webmail que se crearon solos se han retirado.',
      );
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se ha podido cambiar el webmail automático.'),
  });

  const titulo = 'Webmail automático';
  if (estado.isPending) {
    return (
      <Hoja title={titulo} className="mb-4">
        <Cargando label="Cargando el webmail automático…" />
      </Hoja>
    );
  }
  if (estado.isError || !estado.data) {
    return (
      <Hoja title={titulo} className="mb-4">
        <AvisoError onRetry={() => void estado.refetch()} retrying={estado.isFetching}>
          No se ha podido cargar el estado del webmail automático.
        </AvisoError>
      </Hoja>
    );
  }

  const { webmailAutomatico, global } = estado.data;
  return (
    <Hoja title={titulo} className="mb-4">
      <div className="flex max-w-[75ch] flex-col gap-3">
        <Casilla
          checked={webmailAutomatico}
          disabled={cambiar.isPending}
          onChange={(activo) => (activo ? cambiar.mutate(true) : setConfirmar(true))}
          label="Crear el webmail automáticamente"
          help={
            <>
              Cada dominio de correo con la propiedad comprobada recibe su webmail en{' '}
              <span className="valor">webmail.&lt;dominio&gt;</span>, con su registro en Cloudflare y su
              certificado, sin darlo de alta a mano. Si ese nombre ya se usa para otra cosa, no se toca.
            </>
          }
        />
        {!global && (
          <p className="text-sm text-tinta-2">
            {isAdmin
              ? 'El webmail automático está desactivado para todo el servidor en Ajustes: este ajuste no tiene efecto hasta que se active allí.'
              : 'La administración ha desactivado el webmail automático para todo el servidor: este ajuste no tiene efecto por ahora.'}
          </p>
        )}
      </div>

      <Dialogo
        open={confirmar}
        onClose={() => setConfirmar(false)}
        title="Desactivar el webmail automático"
        pie={
          <Botonera>
            <Button variant="perfil" onClick={() => setConfirmar(false)}>
              Cancelar
            </Button>
            <Button variant="peligro" busy={cambiar.isPending} onClick={() => cambiar.mutate(false)}>
              Desactivar
            </Button>
          </Botonera>
        }
      >
        <p className="text-base text-tinta-2">
          Los webmail que Mailway creó solos dejarán de funcionar en unos segundos y sus usuarios volverán a la
          dirección general del webmail; también se elimina su registro en Cloudflare. Los que se dieron de alta
          a mano se mantienen. Puedes volver a activarlo cuando quieras.
        </p>
      </Dialogo>
    </Hoja>
  );
}

/**
 * Interruptor general (Ajustes): apagado, Mailway no crea el webmail de
 * ningún dominio, tenga cada cliente el suyo como lo tenga.
 */
export function HojaWebmailAutomaticoGeneral() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const estado = useQuery({
    queryKey: ['webmail-automatico-general'],
    queryFn: () => api.get<{ webmailAutomatico: boolean }>('/api/settings/webmail-automatico'),
  });
  const cambiar = useMutation({
    mutationFn: (activo: boolean) =>
      api.put<{ webmailAutomatico: boolean }>('/api/settings/webmail-automatico', { activo }),
    onSuccess: async (data) => {
      queryClient.setQueryData(['webmail-automatico-general'], data);
      await queryClient.invalidateQueries({ queryKey: ['webmail-automatico'] });
      toast(
        'ok',
        data.webmailAutomatico
          ? 'Webmail automático activado para todo el servidor.'
          : 'Webmail automático desactivado: no se creará el webmail de ningún dominio nuevo.',
      );
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se ha podido cambiar el webmail automático.'),
  });

  const titulo = 'Webmail automático';
  return (
    <Hoja title={titulo} className="min-w-0 lg:col-span-2">
      {estado.isPending ? (
        <Cargando label="Cargando el webmail automático…" />
      ) : estado.isError || !estado.data ? (
        <AvisoError onRetry={() => void estado.refetch()} retrying={estado.isFetching}>
          No se ha podido cargar el estado del webmail automático.
        </AvisoError>
      ) : (
        <div className="max-w-[75ch]">
          <Casilla
            checked={estado.data.webmailAutomatico}
            disabled={cambiar.isPending}
            onChange={(activo) => cambiar.mutate(activo)}
            label="Crear el webmail de cada dominio automáticamente"
            help={
              <>
                Cada dominio de correo con la propiedad comprobada recibe su webmail en{' '}
                <span className="valor">webmail.&lt;dominio&gt;</span>, con su registro en Cloudflare con proxy
                y su certificado. Cada cliente puede desactivarlo en su ficha (Marca blanca) o desde Skyway.
                Apagarlo aquí no retira los que ya existen.
              </>
            }
          />
        </div>
      )}
    </Hoja>
  );
}
