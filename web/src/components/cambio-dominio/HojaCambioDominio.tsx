import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import type { DominioCorreo } from '../../lib/cloudflare';
import {
  accionEnMarcha,
  cambioDominio,
  claveCambio,
  faseDe,
  mensajeCambio,
  type CambioDominioVista,
} from '../../lib/cambioDominio';
import { AvisoError, Cargando, Hoja } from '../../ui/kit';
import { PasosCambio, Seccion } from './comun';
import { ElegirDominio } from './ElegirDominio';
import { PrepararCambio } from './PrepararCambio';
import { TransicionCambio } from './TransicionCambio';

/*
  Tarjeta «Cambiar de dominio» de la ficha del dominio. Sin cambio abierto,
  el paso «Elegir»; con uno, el asistente en su fase. La ven la ficha del
  dominio anterior y la del nuevo: el cambio es el mismo.
*/

/** Ancla de la tarjeta: el membrete de la ficha enlaza aquí cuando hay un cambio abierto. */
export const ANCLA_CAMBIO = 'cambio-de-dominio';

export function HojaCambioDominio({
  dominio,
  isAdmin,
  terminado,
}: {
  dominio: DominioCorreo;
  isAdmin: boolean;
  /** Cambio recién dado de baja (llega al navegar desde la ficha del dominio anterior, que ya no existe). */
  terminado?: CambioDominioVista | null;
}) {
  const migracion = dominio.migracion ?? null;
  /*
    El cambio dado de baja mientras la ficha estaba abierta (o el que llega
    al navegar desde la del dominio anterior). Se guarda aquí, y no en el
    asistente, porque al releer el dominio `migracion` pasa a null y el
    asistente desaparece: sin esto, la tarjeta saltaba a «Elegir» y se perdía
    el aviso de mantener registrado el dominio anterior.
  */
  const [final, setFinal] = useState<CambioDominioVista | null>(terminado ?? null);
  return (
    <div id={ANCLA_CAMBIO} className="scroll-mt-20">
      <Hoja title="Cambiar de dominio" flush>
        {migracion ? (
          <AsistenteCambio key={migracion.id} id={migracion.id} dominio={dominio} onDadoDeBaja={setFinal} />
        ) : final && final.estado === 'dado_de_baja' ? (
          <>
            <Seccion>
              <PasosCambio actual="terminado" />
            </Seccion>
            <CambioTerminado vista={final} />
          </>
        ) : (
          <>
            <Seccion>
              <PasosCambio actual="elegir" />
            </Seccion>
            <ElegirDominio dominio={dominio} isAdmin={isAdmin} />
          </>
        )}
      </Hoja>
    </div>
  );
}

/**
 * Cada cuánto se relee la vista. Con una acción en marcha, cada pocos
 * segundos, para seguir el paso. En la transición, cada 30 segundos: las
 * personas actualizan sus dispositivos desde «Mi buzón» o su enlace, y Skyway
 * puede volver o dar de baja, sin pasar por esta página. En la preparación
 * no hace falta: la comprobación de cada 30 segundos ya devuelve la vista.
 * Con la pestaña oculta no se relee (React Query no sondea en segundo plano).
 */
function intervaloVista(v: CambioDominioVista | undefined): number | false {
  if (!v) return false;
  if (accionEnMarcha(v)) return 3000;
  if (faseDe(v.estado) === 'transicion') return 30_000;
  return false;
}

function AsistenteCambio({
  id,
  dominio,
  onDadoDeBaja,
}: {
  id: string;
  dominio: DominioCorreo;
  onDadoDeBaja: (vista: CambioDominioVista) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const vista = useQuery({
    queryKey: claveCambio(id),
    queryFn: () => cambioDominio.obtener(id),
    refetchInterval: (q) => intervaloVista(q.state.data),
    // Al volver a la pestaña se relee: el portal, los enlaces o Skyway
    // cambian el cambio sin pasar por esta página.
    refetchOnWindowFocus: true,
  });

  // Un cambio que ya terminó (cancelado o dado de baja en otro sitio) deja la
  // ficha con un `migracion` antiguo: se relee el dominio. Si se dio de baja,
  // la tarjeta conserva el paso «Terminado» aunque el asistente desaparezca.
  const fase = vista.data ? faseDe(vista.data.estado) : null;
  const dadoDeBaja = vista.data?.estado === 'dado_de_baja' ? vista.data : null;
  useEffect(() => {
    if (dadoDeBaja) onDadoDeBaja(dadoDeBaja);
  }, [dadoDeBaja, onDadoDeBaja]);
  useEffect(() => {
    if (fase === 'terminado') void queryClient.invalidateQueries({ queryKey: ['domain', dominio.id] });
  }, [fase, dominio.id, queryClient]);

  if (vista.isPending) return <Cargando label="Cargando el cambio de dominio…" />;
  if (vista.isError) {
    const noExiste = vista.error instanceof ApiError && vista.error.status === 404;
    return (
      <Seccion>
        <AvisoError onRetry={noExiste ? undefined : () => void vista.refetch()} retrying={vista.isFetching}>
          {noExiste
            ? 'Este cambio de dominio ya no existe.'
            : mensajeCambio(vista.error, 'No se ha podido cargar el cambio de dominio.')}
        </AvisoError>
      </Seccion>
    );
  }

  const v = vista.data;
  const enDestino = v.hacia.domainId === dominio.id;

  return (
    <>
      <Seccion>
        <PasosCambio actual={faseDe(v.estado)} />
      </Seccion>
      {faseDe(v.estado) === 'preparar' && (
        <PrepararCambio
          vista={v}
          enDestino={enDestino}
          onCancelado={(nueva) => {
            // Si el dominio nuevo lo creó el cambio, cancelar lo elimina: se
            // vuelve a la ficha del anterior, que sigue igual.
            if (enDestino && nueva.desde.domainId) navigate(`/dominios/${nueva.desde.domainId}`);
          }}
        />
      )}
      {faseDe(v.estado) === 'transicion' && (
        <TransicionCambio
          vista={v}
          onDadoDeBaja={(nueva) => {
            // La ficha del dominio anterior ya no existe: se sigue en la del
            // nuevo, sustituyendo la entrada del historial («Atrás» no debe
            // llevar a un dominio que ya no está). Si la ficha abierta ya es
            // la del nuevo, no se navega: «Terminado» lo guarda la tarjeta.
            if (nueva.hacia.domainId && nueva.hacia.domainId !== dominio.id) {
              navigate(`/dominios/${nueva.hacia.domainId}`, { replace: true, state: { cambioTerminado: nueva } });
            }
          }}
        />
      )}
      {faseDe(v.estado) === 'terminado' && <CambioTerminado vista={v} />}
    </>
  );
}

/** Paso «Terminado». */
export function CambioTerminado({ vista }: { vista: CambioDominioVista }) {
  const desde = vista.desde.domain;
  const hacia = vista.hacia.domain;
  if (vista.estado === 'cancelada') {
    return (
      <Seccion>
        <p className="text-base text-tinta-2 [overflow-wrap:anywhere]">
          El cambio de {desde} a {hacia} se ha cancelado. {desde} sigue igual.
        </p>
      </Seccion>
    );
  }
  return (
    <Seccion className="flex flex-col gap-2">
      <p className="max-w-[75ch] text-base text-tinta [overflow-wrap:anywhere]">
        {desde} se ha dado de baja. El correo de tu equipo funciona en {hacia}.
      </p>
      <p className="max-w-[75ch] text-sm text-tinta-2 [overflow-wrap:anywhere]">
        Mantén {desde} registrado al menos uno o dos años: quien lo registrara recibiría el correo que aún se envíe a
        las direcciones antiguas.
      </p>
    </Seccion>
  );
}
