import { useEffect, useState } from 'react';
import {
  cambioDominio,
  confirmacionCoincide,
  mensajeCambio,
  personaEnMensaje,
  type CambioDominioVista,
} from '../../lib/cambioDominio';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { AvisoError, Dialogo } from '../../ui/kit';
import { useAccionCambio } from './acciones';
import { BloqueosYAvisos } from './comun';
import { useNombresBuzones } from './MensajeEquipo';

/*
  «Dar de baja dominio.es»: el último paso y el único que no se deshace.
  Lo que impide la baja sin consultar la red (aplicaciones que envían con un
  buzón pendiente, dominio que aloja la plataforma) llega en la vista; el MX
  lo comprueba el servidor al pulsar y su mensaje se muestra aquí.
*/

export function DialogoBaja({
  vista,
  open,
  onClose,
  onDadoDeBaja,
}: {
  vista: CambioDominioVista;
  open: boolean;
  onClose: () => void;
  onDadoDeBaja: (vista: CambioDominioVista) => void;
}) {
  const [confirmacion, setConfirmacion] = useState('');
  const nombres = useNombresBuzones();
  const desde = vista.desde.domain;
  const hacia = vista.hacia.domain;
  const baja = useAccionCambio(vista.id, (id, confirm: string) => cambioDominio.darDeBaja(id, confirm), {
    aviso: (v) => `${v.desde.domain} se ha dado de baja.`,
    onHecho: onDadoDeBaja,
  });
  const { reset } = baja;

  // Cada apertura empieza de cero: un nombre escrito antes dejaría el botón ya habilitado.
  useEffect(() => {
    if (open) {
      setConfirmacion('');
      reset();
    }
  }, [open, reset]);

  const pendientes = vista.buzones.lista.filter((b) => b.pendiente);
  const coincide = confirmacionCoincide(confirmacion, desde);

  return (
    <Dialogo
      open={open}
      onClose={onClose}
      title={`Dar de baja ${desde}`}
      pie={
        <>
          <Button variant="plano" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="peligro"
            disabled={!coincide || !vista.puedeDarDeBaja}
            busy={baja.isPending}
            onClick={() => baja.mutate(desde)}
          >
            Dar de baja
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-base text-tinta-2 [overflow-wrap:anywhere]">
        <p>
          {desde} dejará de recibir correo en esta plataforma. Antes, su MX tiene que apuntar a otro sitio o ser un MX
          nulo («0 .»).
        </p>
        {pendientes.length > 0 && (
          <div className="flex flex-col gap-2">
            <p>
              {pendientes.length === 1
                ? `La persona que aún entra con su usuario de ${desde} pasará a entrar con su dirección de ${hacia}. Sus dispositivos sin actualizar dejarán de conectar hasta que cambien el usuario. La contraseña no cambia.`
                : `Las ${pendientes.length} personas que aún entran con su usuario de ${desde} pasarán a entrar con su dirección de ${hacia}. Sus dispositivos sin actualizar dejarán de conectar hasta que cambien el usuario. La contraseña no cambia.`}
            </p>
            <ul className="rounded-lg border border-regla bg-hoja-2">
              {pendientes.map((p) => (
                <li key={p.id} className="regla-fila valor break-all px-3 py-1.5 text-sm text-tinta last:border-b-0">
                  {personaEnMensaje(p.email, nombres.get(p.id))}
                </li>
              ))}
            </ul>
          </div>
        )}
        {vista.webmail.viejo && <p>{vista.webmail.viejo.hostname} dejará de funcionar.</p>}
        <p className="text-sm">
          Si acabas de cambiar el MX, espera al menos un día: algunos servidores tardan en ver el cambio.
        </p>
        <BloqueosYAvisos bloqueos={vista.bloqueosBaja} />
        <Input
          label={`Escribe ${desde} para confirmar`}
          mono
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={confirmacion}
          placeholder={desde}
          onChange={(e) => {
            baja.reset();
            setConfirmacion(e.target.value);
          }}
        />
        {baja.isError && <AvisoError>{mensajeCambio(baja.error, `No se ha podido dar de baja ${desde}.`)}</AvisoError>}
      </div>
    </Dialogo>
  );
}
