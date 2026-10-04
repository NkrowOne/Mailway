import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  cambioDominio,
  claveCambio,
  enPreparacion,
  mensajeCambio,
  type CambioDominioVista,
} from '../../lib/cambioDominio';
import { Button, estiloBoton } from '../../ui/Button';
import { AvisoError } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { DialogoConfirmar, useAccionCambio } from './acciones';
import { BandaSkyway, EnMarcha, ListaCompuertas, Seccion } from './comun';
import { DialogoVolver } from './DialogoVolver';
import { RegistrosDns } from './RegistrosDns';

/*
  Paso «Preparar» (estados preparando, listo y pasando): las comprobaciones
  para pasar, el DNS del dominio nuevo (en Cloudflare o guiado) y las
  acciones. Mientras la vista está abierta se comprueba cada 30 segundos.
*/

const CADA = 30_000;

export function PrepararCambio({
  vista,
  enDestino,
  onCancelado,
}: {
  vista: CambioDominioVista;
  /** La ficha abierta es la del dominio nuevo (no hace falta enlazarla). */
  enDestino: boolean;
  onCancelado: (vista: CambioDominioVista) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmar, setConfirmar] = useState<'cancelar' | 'mx' | 'volver' | null>(null);
  const desde = vista.desde.domain;
  const hacia = vista.hacia.domain;
  const skyway = vista.origen === 'skyway';
  const preparando = enPreparacion(vista);

  /*
    Comprobación: la manual avisa del resultado; la automática solo si el
    dominio acaba de quedar listo. Si las comprobaciones cambian, la ficha
    del dominio nuevo (propiedad, DNS) también ha cambiado y se relee.
  */
  const comprobar = useMutation({
    mutationFn: (_manual: boolean) => cambioDominio.comprobar(vista.id),
    onSuccess: (nueva, manual) => {
      const antes = queryClient.getQueryData<CambioDominioVista>(claveCambio(vista.id));
      queryClient.setQueryData(claveCambio(vista.id), nueva);
      const firma = (v?: CambioDominioVista) => JSON.stringify(v?.compuertas.map((c) => c.ok) ?? []) + v?.estado;
      if (firma(antes) !== firma(nueva)) {
        void queryClient.invalidateQueries({ queryKey: ['domain'] });
        void queryClient.invalidateQueries({ queryKey: ['domains'] });
      }
      if (antes?.estado !== 'listo' && nueva.estado === 'listo') {
        toast('ok', `${nueva.hacia.domain} está listo para el cambio.`);
      } else if (manual) {
        toast('ok', nueva.estado === 'listo' ? `${nueva.hacia.domain} está listo para el cambio.` : 'Comprobación completada.');
      }
    },
    onError: (err, manual) => {
      if (manual) toast('error', mensajeCambio(err, 'No se ha podido comprobar el dominio nuevo.'));
    },
  });

  // El intervalo lee siempre la mutación vigente sin reiniciarse en cada render.
  const comprobarRef = useRef(comprobar);
  useEffect(() => {
    comprobarRef.current = comprobar;
  });
  useEffect(() => {
    if (!preparando) return;
    const t = window.setInterval(() => {
      // Con la pestaña oculta no se consulta el DNS de nadie.
      if (document.visibilityState === 'visible' && !comprobarRef.current.isPending) comprobarRef.current.mutate(false);
    }, CADA);
    return () => window.clearInterval(t);
  }, [preparando]);

  const pasar = useAccionCambio(vista.id, (id) => cambioDominio.pasar(id), {
    aviso: (v) => `El correo sale ya como @${v.hacia.domain}.`,
  });
  const cancelar = useAccionCambio(vista.id, (id) => cambioDominio.cancelar(id), {
    aviso: () => 'Cambio de dominio cancelado.',
    onHecho: (v) => {
      setConfirmar(null);
      onCancelado(v);
    },
  });
  const cambiarMx = useAccionCambio(vista.id, (id) => cambioDominio.cambiarMx(id), {
    aviso: (v) => `MX de ${v.hacia.domain} cambiado a este servidor.`,
    onHecho: () => setConfirmar(null),
  });

  const pasando = vista.estado === 'pasando';
  const conError = Boolean(vista.error);

  function abrir(cual: 'cancelar' | 'mx' | 'volver') {
    cancelar.reset();
    cambiarMx.reset();
    setConfirmar(cual);
  }

  return (
    <>
      {(skyway || conError || (pasando && !conError)) && (
        <Seccion className="flex flex-col gap-3">
          {skyway && <BandaSkyway />}
          {pasando && !conError && <EnMarcha texto={`Pasando a ${hacia}…`} paso={vista.paso} />}
          {pasando && conError && (
            <AvisoError onRetry={skyway ? undefined : () => pasar.mutate()} retrying={pasar.isPending}>
              <p>
                No se ha podido terminar de pasar a {hacia}: {vista.error}
              </p>
              <p className="mt-1 text-tinta">Las dos direcciones siguen recibiendo y nadie ha cambiado de usuario.</p>
            </AvisoError>
          )}
          {!pasando && conError && (
            <AvisoError onRetry={() => comprobar.mutate(true)} retrying={comprobar.isPending}>
              {vista.error}
            </AvisoError>
          )}
        </Seccion>
      )}

      <Seccion titulo="Comprobaciones para pasar" meta={preparando ? 'Se comprueba cada 30 segundos.' : undefined}>
        <div className="flex flex-col gap-3">
          <ListaCompuertas compuertas={vista.compuertas} />
          {preparando && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="perfil" busy={comprobar.isPending} onClick={() => comprobar.mutate(true)}>
                Comprobar ahora
              </Button>
              {!enDestino && vista.hacia.domainId && (
                <Link to={`/dominios/${vista.hacia.domainId}`} className={estiloBoton('plano')}>
                  Ver la ficha de {hacia}
                </Link>
              )}
            </div>
          )}
        </div>
      </Seccion>

      {preparando && (
        <Seccion titulo={`DNS de ${hacia}`}>
          {vista.hacia.cloudflare ? (
            <div className="flex flex-col gap-3">
              <p className="text-base text-tinta-2">Registros creados en Cloudflare.</p>
              {vista.hacia.recibeEnOtroProveedor && (
                <div className="flex flex-col gap-3 rounded-lg border border-regla bg-hoja-2 px-3 py-3">
                  <p className="max-w-[75ch] text-base text-tinta [overflow-wrap:anywhere]">
                    {hacia} recibe ahora el correo en otro proveedor. Cuando veas «{hacia} ya recibe en los buzones»,
                    cambia el MX a este servidor.
                  </p>
                  {!skyway && (
                    <Button
                      variant="perfil"
                      className="self-start"
                      disabled={!vista.recepcionPreparada}
                      onClick={() => abrir('mx')}
                    >
                      Cambiar el MX a este servidor
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <RegistrosDns vista={vista} />
          )}
        </Seccion>
      )}

      {!skyway && (vista.puedeCancelar || vista.puedeVolver || !pasando) && (
        <Seccion>
          <div className="flex flex-col gap-3">
            {pasar.isError && (
              <AvisoError>{mensajeCambio(pasar.error, `No se ha podido pasar a ${hacia}.`)}</AvisoError>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-2">
                {vista.puedeCancelar && (
                  <Button variant="perfil" onClick={() => abrir('cancelar')}>
                    Cancelar el cambio
                  </Button>
                )}
                {vista.puedeVolver && (
                  <Button variant="perfil" onClick={() => abrir('volver')}>
                    Volver a {desde}
                  </Button>
                )}
              </div>
              {!pasando && (
                <Button variant="principal" disabled={!vista.puedePasar} busy={pasar.isPending} onClick={() => pasar.mutate()}>
                  Pasar a {hacia}
                </Button>
              )}
            </div>
            {!pasando && !vista.puedePasar && (
              <p className="text-sm text-tinta-3 sm:text-right">
                Podrás pasar cuando las comprobaciones obligatorias estén correctas.
              </p>
            )}
          </div>
        </Seccion>
      )}

      <DialogoConfirmar
        open={confirmar === 'cancelar'}
        titulo="Cancelar el cambio de dominio"
        textoAccion="Cancelar el cambio"
        textoCancelar="Seguir con el cambio"
        variante="peligro"
        ocupado={cancelar.isPending}
        error={
          cancelar.isError && (
            <AvisoError>{mensajeCambio(cancelar.error, 'No se ha podido cancelar el cambio de dominio.')}</AvisoError>
          )
        }
        onConfirmar={() => cancelar.mutate()}
        onClose={() => setConfirmar(null)}
      >
        <p>
          Se quitarán las direcciones de {hacia} de los buzones y alias. {desde} sigue igual.
          {vista.creoDestino ? ` ${hacia} se eliminará de esta plataforma.` : ''}
        </p>
      </DialogoConfirmar>

      <DialogoConfirmar
        open={confirmar === 'mx'}
        titulo="Cambiar el MX a este servidor"
        textoAccion="Cambiar el MX"
        ocupado={cambiarMx.isPending}
        error={
          cambiarMx.isError && (
            <AvisoError>{mensajeCambio(cambiarMx.error, 'No se ha podido cambiar el MX en Cloudflare.')}</AvisoError>
          )
        }
        onConfirmar={() => cambiarMx.mutate()}
        onClose={() => setConfirmar(null)}
      >
        <p>El correo de {hacia} dejará de llegar a su proveedor actual y entrará en estos buzones.</p>
      </DialogoConfirmar>

      <DialogoVolver vista={vista} open={confirmar === 'volver'} onClose={() => setConfirmar(null)} />
    </>
  );
}

