import { useState } from 'react';
import {
  cambioDominio,
  textoUsadoPorApp,
  type CambioDominioVista,
  type PersonaCambio,
} from '../../lib/cambioDominio';
import { plural } from '../../lib/format';
import { Button } from '../../ui/Button';
import { AvisoError, MarcaFondo } from '../../ui/kit';
import { DialogoActualizarUsuario, type BuzonPendiente } from './ActualizarUsuario';
import { useAccionCambio } from './acciones';
import { BandaSkyway, EnMarcha, Seccion } from './comun';
import { DialogoBaja } from './DialogoBaja';
import { DialogoVolver } from './DialogoVolver';
import { MensajeEquipo } from './MensajeEquipo';

/*
  Paso «En transición» (estados pasado, volviendo y dando_de_baja): el correo
  sale ya con la dirección nueva y la anterior sigue recibiendo. Aquí se ve
  quién falta por actualizar sus dispositivos y se decide volver o dar de
  baja el dominio anterior.
*/

export function TransicionCambio({
  vista,
  onDadoDeBaja,
}: {
  vista: CambioDominioVista;
  onDadoDeBaja: (vista: CambioDominioVista) => void;
}) {
  const [dialogo, setDialogo] = useState<'volver' | 'baja' | 'mensaje' | null>(null);
  const [aActualizar, setAActualizar] = useState<BuzonPendiente | null>(null);
  const desde = vista.desde.domain;
  const hacia = vista.hacia.domain;
  const skyway = vista.origen === 'skyway';
  const conError = Boolean(vista.error);

  // «Reintentar» repite la acción interrumpida; la baja ya se confirmó al empezarla.
  const volver = useAccionCambio(vista.id, (id) => cambioDominio.volver(id), {
    aviso: (v) => `El correo vuelve a salir como @${v.desde.domain}.`,
  });
  const baja = useAccionCambio(vista.id, (id) => cambioDominio.darDeBaja(id, desde), {
    aviso: (v) => `${v.desde.domain} se ha dado de baja.`,
    onHecho: onDadoDeBaja,
  });
  const reintento = vista.estado === 'volviendo' ? volver : baja;

  // Pendientes primero: es la lista de lo que falta por hacer.
  const personas = [...vista.buzones.lista].sort(
    (a, b) => Number(b.pendiente) - Number(a.pendiente) || a.email.localeCompare(b.email),
  );
  const enMarcha = (vista.estado === 'volviendo' || vista.estado === 'dando_de_baja') && !conError;

  return (
    <>
      {(skyway || conError || enMarcha) && (
        <Seccion className="flex flex-col gap-3">
          {skyway && <BandaSkyway />}
          {enMarcha && (
            <EnMarcha
              texto={vista.estado === 'volviendo' ? `Volviendo a ${desde}…` : `Dando de baja ${desde}…`}
              paso={vista.paso}
            />
          )}
          {conError && (
            <AvisoError
              onRetry={skyway || vista.estado === 'pasado' ? undefined : () => reintento.mutate()}
              retrying={reintento.isPending}
            >
              {vista.estado === 'volviendo'
                ? `No se ha podido terminar de volver a ${desde}: ${vista.error}`
                : vista.estado === 'dando_de_baja'
                  ? `No se ha podido terminar de dar de baja ${desde}: ${vista.error}`
                  : vista.error}
            </AvisoError>
          )}
          {reintento.isError && !reintento.isPending && (
            <AvisoError>{reintento.error instanceof Error ? reintento.error.message : 'No se ha podido reintentar.'}</AvisoError>
          )}
        </Seccion>
      )}

      <Seccion>
        <p className="max-w-[75ch] text-base text-tinta [overflow-wrap:anywhere]">
          Desde ahora el correo sale como @{hacia}. Lo que llegue a @{desde} sigue entrando en los mismos buzones.
        </p>
      </Seccion>

      <Seccion
        titulo="Personas"
        meta={
          vista.buzones.total > 0
            ? vista.buzones.pendientes > 0
              ? `${plural(vista.buzones.pendientes, 'pendiente', 'pendientes')} de ${vista.buzones.total}`
              : 'Todas al día'
            : undefined
        }
      >
        {personas.length === 0 ? (
          <p className="text-base text-tinta-2">{desde} no tenía buzones: no hay dispositivos que actualizar.</p>
        ) : (
          <ul className="rounded-lg border border-regla">
            {personas.map((p) => (
              <FilaPersona key={p.id} persona={p} onActualizar={() => setAActualizar(p)} />
            ))}
          </ul>
        )}
        {vista.buzones.pendientes > 0 && (
          <div className="mt-3">
            <Button variant="perfil" onClick={() => setDialogo('mensaje')}>
              Mensaje para tu equipo
            </Button>
          </div>
        )}
      </Seccion>

      {!skyway && vista.estado === 'pasado' && (
        <Seccion>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="perfil" disabled={!vista.puedeVolver} onClick={() => setDialogo('volver')}>
              Volver a {desde}
            </Button>
            <Button variant="peligro" onClick={() => setDialogo('baja')}>
              Dar de baja {desde}…
            </Button>
          </div>
        </Seccion>
      )}

      <DialogoVolver vista={vista} open={dialogo === 'volver'} onClose={() => setDialogo(null)} />
      <DialogoBaja
        vista={vista}
        open={dialogo === 'baja'}
        onClose={() => setDialogo(null)}
        onDadoDeBaja={(v) => {
          setDialogo(null);
          onDadoDeBaja(v);
        }}
      />
      <MensajeEquipo vista={vista} open={dialogo === 'mensaje'} onClose={() => setDialogo(null)} />
      <DialogoActualizarUsuario buzon={aActualizar} onClose={() => setAActualizar(null)} />
    </>
  );
}

/** Una persona: su dirección, con qué usuario entra y si ya actualizó sus dispositivos. */
function FilaPersona({ persona, onActualizar }: { persona: PersonaCambio; onActualizar: () => void }) {
  return (
    <li
      className={`regla-fila flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5 last:border-b-0 ${
        persona.pendiente ? 'fila-vigilar' : ''
      }`}
    >
      <div className="min-w-0 flex-1 basis-56">
        <p className="valor break-all text-base text-tinta">{persona.email}</p>
        {persona.pendiente && (
          <p className="text-sm text-tinta-2">
            Entra con <span className="valor break-all">{persona.login}</span>
          </p>
        )}
      </div>
      {/* El rótulo largo puede partirse: a 320 px no cabe en una línea. */}
      <span className="min-w-0 max-w-full [&>span]:whitespace-normal">
        {persona.pendiente ? (
          <MarcaFondo veredicto="vigilar">Pendiente de actualizar dispositivos</MarcaFondo>
        ) : (
          <MarcaFondo veredicto="normal">Al día</MarcaFondo>
        )}
      </span>
      {persona.pendiente && (
        <div className="flex w-full justify-end sm:w-auto">
          {persona.usadoPorApps.length > 0 ? (
            <p className="max-w-xs text-sm text-tinta-3 sm:text-right">{textoUsadoPorApp(persona.usadoPorApps)}</p>
          ) : (
            <Button variant="perfil" className="px-2" onClick={onActualizar}>
              Actualizar ahora
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
