import { useState } from 'react';
import { RotateCcw, Send } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { estadoInvitacion } from '../../../lib/bienvenida';
import { plural } from '../../../lib/format';
import { mensajeDe } from '../../../lib/gestion';
import { fechaLarga } from '../../../lib/portal';
import { DialogoBienvenida, useInvitaciones } from '../../../components/EnlaceBienvenida';
import { useUsuario } from '../../../components/gestion/consultas';
import { Botonera } from '../../../components/gestion/comun';
import { Button } from '../../../ui/Button';
import { AvisoError, Cargando, Dialogo, Hoja, MarcaFondo } from '../../../ui/kit';
import { useToast } from '../../../ui/toast';
import { PuestaDelCliente } from '../../PuestaEnMarcha';
import type { ContextoCliente } from './datos';

/*
  Pestaña «Puesta en marcha» de la ficha del cliente. La configuración de los
  buzones es cosa del cliente, no de cada buzón: su persona de contacto crea
  los que necesita y envía a cada persona su configuración. Desde aquí, quien
  administra le envía el enlace para hacerlo, la reinicia desde cero tras una
  prueba o la sigue (y la hace por él) con la misma guía que ve el cliente.
*/

interface ResultadoReinicio {
  reset: number;
  skipped: number;
  failed: { email: string; error: string }[];
}

export default function PuestaCliente({ contexto }: { contexto: ContextoCliente }) {
  const { id, cliente } = contexto;
  const usuario = useUsuario();
  const invitaciones = useInvitaciones(id);
  const [enlace, setEnlace] = useState(false);
  const [reiniciar, setReiniciar] = useState(false);

  const vigente = (invitaciones.data?.invites ?? []).find((inv) => estadoInvitacion(inv).vigente);
  const estado = vigente ? estadoInvitacion(vigente) : null;
  // Quien recibe el enlace: el de contacto o, si no hay, el primer usuario.
  const destinatario = vigente?.email ?? cliente.contactEmail ?? contexto.usuarios[0]?.email ?? '';

  return (
    <>
      <h2 className="sr-only">Puesta en marcha</h2>
      <Hoja
        className="mb-4"
        title="Puesta en marcha del cliente"
        meta="La hace su persona de contacto"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="plano" disabled={cliente.suspended} onClick={() => setReiniciar(true)}>
              <RotateCcw className="h-4 w-4" aria-hidden />
              Reiniciar
            </Button>
            <Button variant="principal" disabled={cliente.suspended} onClick={() => setEnlace(true)}>
              <Send className="h-4 w-4" aria-hidden />
              {/* En el móvil, el rótulo largo no cabe en la cabecera de la tarjeta. */}
              <span className="sm:hidden">Enviar enlace</span>
              <span className="hidden sm:inline">Enviar enlace de puesta en marcha</span>
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-2.5">
          <p className="max-w-[75ch] text-base text-tinta-2">
            Con el enlace, la persona de contacto entra en su panel y sigue la guía: su dominio, los buzones que
            necesite su equipo y la configuración de cada persona. Debajo ves lo mismo que verá ella, y puedes hacerlo
            por ella.
          </p>
          {vigente && estado && (
            <p className="flex flex-wrap items-center gap-2 text-sm text-tinta-2">
              <MarcaFondo veredicto={estado.veredicto}>{estado.etiqueta}</MarcaFondo>
              Enlace enviado a <span className="valor [overflow-wrap:anywhere] text-tinta">{vigente.email}</span>; caduca
              el {fechaLarga(vigente.expiresAt)}.
            </p>
          )}
          {cliente.suspended && (
            <p className="text-sm text-tinta-3">Reactiva el cliente desde «Resumen» para enviarle el enlace.</p>
          )}
        </div>
      </Hoja>

      {usuario ? <PuestaDelCliente clientId={id} usuario={usuario} /> : <Cargando label="Preparando la puesta en marcha…" />}

      {enlace && (
        <DialogoBienvenida
          clientId={id}
          clientName={cliente.name}
          emailInicial={destinatario}
          nombreInicial={vigente?.name ?? ''}
          onClose={() => setEnlace(false)}
        />
      )}
      {reiniciar && (
        <DialogoReinicio
          clientId={id}
          clientName={cliente.name}
          onClose={() => setReiniciar(false)}
          onEnviarEnlace={() => {
            setReiniciar(false);
            setEnlace(true);
          }}
        />
      )}
    </>
  );
}

/**
 * Reiniciar la puesta en marcha: todos los buzones del cliente vuelven a
 * estar sin configurar (contraseña nueva, sin enlaces anteriores ni foto),
 * como tras una prueba. El correo de los buzones no se toca. Después, lo
 * natural es enviarle el enlace para que la haga.
 */
function DialogoReinicio({
  clientId,
  clientName,
  onClose,
  onEnviarEnlace,
}: {
  clientId: string;
  clientName: string;
  onClose: () => void;
  onEnviarEnlace: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [contrasenasApp, setContrasenasApp] = useState(false);
  const [resultado, setResultado] = useState<ResultadoReinicio | null>(null);

  const reinicio = useMutation({
    mutationFn: () =>
      api.post<ResultadoReinicio>(`/api/clients/${encodeURIComponent(clientId)}/onboarding-reset`, {
        revokeAppPasswords: contrasenasApp,
      }),
    onSuccess: async (r) => {
      setResultado(r);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mailboxes'] }),
        queryClient.invalidateQueries({ queryKey: ['client-dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['activity'] }),
      ]);
      if (r.failed.length === 0) toast('ok', `Puesta en marcha reiniciada: ${plural(r.reset, 'buzón', 'buzones')} desde cero.`);
    },
  });

  return (
    <Dialogo
      open
      onClose={onClose}
      title={resultado ? 'Puesta en marcha reiniciada' : 'Reiniciar la puesta en marcha'}
      pie={
        resultado ? (
          <Botonera>
            <Button variant="plano" onClick={onClose}>
              Cerrar
            </Button>
            <Button variant="principal" onClick={onEnviarEnlace}>
              <Send className="h-4 w-4" aria-hidden />
              Enviar enlace de puesta en marcha
            </Button>
          </Botonera>
        ) : (
          <Botonera>
            <Button variant="plano" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="peligro" busy={reinicio.isPending} onClick={() => reinicio.mutate()}>
              Reiniciar
            </Button>
          </Botonera>
        )
      }
    >
      {resultado ? (
        <div className="flex flex-col gap-3 text-base text-tinta-2">
          <p>
            {resultado.reset === 0
              ? `${clientName} no tenía buzones activos que reiniciar.`
              : `${plural(resultado.reset, 'buzón queda', 'buzones quedan')} sin configurar, con contraseña nueva y sin enlaces anteriores.`}
            {resultado.skipped > 0 && ` ${plural(resultado.skipped, 'buzón suspendido no se ha tocado', 'buzones suspendidos no se han tocado')}.`}
          </p>
          {resultado.failed.length > 0 && (
            <AvisoError>
              No se ha podido reiniciar en el servidor de correo: {resultado.failed.map((f) => f.email).join(', ')}.
              Vuelve a intentarlo en unos minutos.
            </AvisoError>
          )}
          <p>Ahora envía el enlace a la persona de contacto para que haga la puesta en marcha.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-base text-tinta-2">
          <p>
            Todos los buzones de {clientName} vuelven a empezar de cero, como tras una prueba: contraseña nueva, fuera
            los enlaces de configuración anteriores, las sesiones de «Mi buzón» y las fotos, y todos quedan sin
            configurar para que la persona de contacto envíe a cada uno su configuración.
          </p>
          <p>
            El correo que ya tengan no se toca. Quien ya use un buzón en algún dispositivo tendrá que volver a
            configurarlo.
          </p>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-regla bg-hoja-2 px-3 py-2.5">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 shrink-0 accent-[rgb(var(--petroleo))]"
              checked={contrasenasApp}
              onChange={(e) => setContrasenasApp(e.target.checked)}
            />
            <span className="text-sm text-tinta">
              Retirar también sus contraseñas de aplicación
              <span className="block text-tinta-3">Las de móviles y aplicaciones creadas durante la prueba.</span>
            </span>
          </label>
          {reinicio.isError && <AvisoError>{mensajeDe(reinicio.error, 'No se ha podido reiniciar la puesta en marcha.')}</AvisoError>}
        </div>
      )}
    </Dialogo>
  );
}
