import { useEffect, useMemo, useRef } from 'react';
import { ListChecks } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type ClientDashboard, type Mailbox, type User } from '../lib/api';
import { propiedadPendiente, type DominioCorreo } from '../lib/cloudflare';
import { plural } from '../lib/format';
import { useUsuario } from '../components/gestion/consultas';
import { useTituloVista } from '../shell/AppShell';
import { estiloBoton } from '../ui/Button';
import { Select } from '../ui/Field';
import { AvisoError, Cargando, Hoja, Membrete, Vacio } from '../ui/kit';
import {
  clave,
  esPaso,
  PASOS,
  useRecordado,
  vigentes,
  type EnlaceGuardado,
  type PasoId,
} from './puesta/comun';
import {
  IndiceCompacto,
  IndicePasos,
  type ContextoPuesta,
  type EstadoPaso,
} from './puesta/marco';
import { PasoDominio } from './puesta/PasoDominio';
import { PasoEquipo } from './puesta/PasoEquipo';
import { PasoObligatorias } from './puesta/PasoObligatorias';
import { PasoDispositivos } from './puesta/PasoDispositivos';
import { PasoListo } from './puesta/PasoListo';

/*
  Puesta en marcha del cliente: de «no tengo nada» a «mi equipo tiene correo»
  en cinco pasos. La persona que la hace no suele saber de correo (la dueña
  de una empresa pequeña, quien lleva la oficina), así que cada paso hace
  una sola cosa, dice por qué en una frase y deja saltar lo opcional.

  El estado sale del servidor (dominio, propiedad, buzones, postmaster): al
  volver otro día se sigue donde se dejó. El paso actual va en la dirección
  (?paso=…) para que recargar no devuelva al principio.
*/

export default function PuestaEnMarcha() {
  useTituloVista('Puesta en marcha');
  const usuario = useUsuario();
  const esCliente = usuario?.role === 'client';

  const panel = useQuery({
    queryKey: ['client-dashboard'],
    queryFn: () => api.get<ClientDashboard>('/api/dashboard/client'),
    enabled: esCliente,
  });
  const dominios = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ domains: DominioCorreo[] }>('/api/domains'),
    enabled: esCliente,
  });
  const buzones = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => api.get<{ mailboxes: Mailbox[] }>('/api/mailboxes'),
    enabled: esCliente,
  });

  if (!usuario) return <Cargando label="Preparando la puesta en marcha…" />;

  if (!esCliente) {
    return (
      <>
        <Membrete title="Puesta en marcha" />
        <Hoja>
          <Vacio
            icono={ListChecks}
            title="Esta guía es para los clientes"
            action={
              <Link to="/clientes" className={estiloBoton('perfil')}>
                Ir a Clientes
              </Link>
            }
          >
            Cada cliente pone en marcha su correo desde su propio panel. Para configurar el de un cliente, abre su
            ficha.
          </Vacio>
        </Hoja>
      </>
    );
  }

  if (panel.isPending || dominios.isPending || buzones.isPending) {
    return <Cargando label="Preparando la puesta en marcha…" />;
  }
  if (!panel.data || !dominios.data || !buzones.data) {
    return (
      <>
        <Membrete title="Puesta en marcha" />
        <AvisoError
          onRetry={() => {
            void panel.refetch();
            void dominios.refetch();
            void buzones.refetch();
          }}
          retrying={panel.isFetching || dominios.isFetching || buzones.isFetching}
        >
          No se ha podido cargar el estado de tu correo. Comprueba la conexión y vuelve a intentarlo.
        </AvisoError>
      </>
    );
  }

  return (
    <Asistente
      usuario={usuario}
      panel={panel.data}
      dominios={dominios.data.domains}
      buzonesCliente={buzones.data.mailboxes}
    />
  );
}

function Asistente({
  usuario,
  panel,
  dominios,
  buzonesCliente,
}: {
  usuario: User;
  panel: ClientDashboard;
  dominios: DominioCorreo[];
  buzonesCliente: Mailbox[];
}) {
  const clientId = panel.client.id;
  const [params, setParams] = useSearchParams();
  const tituloRef = useRef<HTMLHeadingElement>(null);

  const [enlacesGuardados, setEnlaces] = useRecordado<EnlaceGuardado[]>(clave(clientId, 'enlaces'), () => [], 'sesion');
  const enlaces = useMemo(() => vigentes(enlacesGuardados), [enlacesGuardados]);
  const [mioId, setMioId] = useRecordado<string | null>(clave(clientId, 'mio'), () => null, 'local');
  const [dispositivosVistos, setDispositivosVistos] = useRecordado<boolean>(
    clave(clientId, 'dispositivos'),
    () => false,
    'local',
  );

  // El dominio que se pone en marcha: el elegido o, si no, el primero que se
  // dio de alta (estable: no cambia porque otro se active antes).
  const propios = useMemo(
    () => dominios.filter((d) => d.clientId === clientId).sort((a, b) => a.createdAt - b.createdAt),
    [dominios, clientId],
  );
  const dominio = propios.find((d) => d.id === params.get('dominio')) ?? propios[0] ?? null;
  const buzones = useMemo(
    () => (dominio ? buzonesCliente.filter((b) => b.domainId === dominio.id) : []),
    [buzonesCliente, dominio],
  );

  const estados: Record<PasoId, EstadoPaso> = {
    dominio: !dominio
      ? { hecho: false, detalle: 'Pendiente', veredicto: 'sin-dato' }
      : propiedadPendiente(dominio)
        ? { hecho: false, detalle: 'Propiedad pendiente', veredicto: 'vigilar' }
        : dominio.status === 'active'
          ? { hecho: true, detalle: 'Listo', veredicto: 'normal' }
          : { hecho: true, detalle: 'DNS pendiente', veredicto: 'vigilar' },
    equipo:
      buzones.length > 0
        ? { hecho: true, detalle: plural(buzones.length, 'buzón', 'buzones'), veredicto: 'normal' }
        : { hecho: false, detalle: 'Pendiente', veredicto: 'sin-dato' },
    obligatorias: panel.onboarding.hasEssentialAddresses
      ? { hecho: true, detalle: 'Creadas', veredicto: 'normal' }
      : { hecho: false, detalle: 'Pendiente', veredicto: 'sin-dato' },
    dispositivos: dispositivosVistos
      ? { hecho: true, detalle: 'Configurados', veredicto: 'normal' }
      : { hecho: false, detalle: 'Recomendado', veredicto: 'sin-dato' },
    listo: { hecho: false, detalle: '', veredicto: 'sin-dato' },
  };
  const pendiente = PASOS.find((p) => p.id !== 'listo' && !estados[p.id].hecho);
  estados.listo = pendiente || dominio?.status !== 'active'
    ? { hecho: false, detalle: '', veredicto: 'sin-dato' }
    : { hecho: true, detalle: 'Todo en marcha', veredicto: 'normal' };

  const pedido = params.get('paso');
  const paso: PasoId = esPaso(pedido) ? pedido : (pendiente?.id ?? 'listo');

  // Sin paso en la dirección se fija el que toca: si no, al comprobarse la
  // propiedad (cada minuto, sola) el asistente saltaría de paso sin pedirlo.
  useEffect(() => {
    if (esPaso(pedido)) return;
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.set('paso', paso);
        return n;
      },
      { replace: true },
    );
  }, [pedido, paso, setParams]);

  // Al cambiar de paso: arriba y el foco en su título (no en la carga inicial,
  // donde el marco ya lleva el foco al contenido).
  const pasoAnterior = useRef(paso);
  useEffect(() => {
    if (pasoAnterior.current === paso) return;
    pasoAnterior.current = paso;
    window.scrollTo({ top: 0 });
    tituloRef.current?.focus({ preventScroll: true });
  }, [paso]);

  function irA(destino: PasoId) {
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      n.set('paso', destino);
      return n;
    });
  }

  const ctx: ContextoPuesta = {
    usuario,
    panel,
    dominios: propios,
    dominio,
    buzones,
    buzonesCliente,
    enlaces,
    setEnlaces: (fn) => setEnlaces((prev) => fn(vigentes(prev))),
    mioId,
    setMioId,
    setDispositivosVistos,
    irA,
    suspendido: panel.client.suspended,
  };

  return (
    <>
      <Membrete
        title="Puesta en marcha"
        meta={`Todo lo necesario para que ${panel.client.name} tenga su correo funcionando, paso a paso.`}
        actions={
          propios.length > 1 ? (
            <div className="w-full min-w-0 sm:w-72">
              <Select
                label="Dominio"
                value={dominio?.id ?? ''}
                onChange={(e) =>
                  setParams((prev) => {
                    const n = new URLSearchParams(prev);
                    n.set('dominio', e.target.value);
                    return n;
                  })
                }
              >
                {propios.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.domainUnicode || d.domain}
                  </option>
                ))}
              </Select>
            </div>
          ) : undefined
        }
      />

      {ctx.suspendido && (
        <AvisoError className="mb-4">
          Tu cuenta está suspendida: no se pueden añadir dominios ni buzones. Ponte en contacto con tu proveedor.
        </AvisoError>
      )}

      <div className="grid items-start gap-4 xl:grid-cols-[17rem_minmax(0,1fr)] xl:gap-8">
        <div className="xl:sticky xl:top-8">
          <div className="hidden xl:block">
            <IndicePasos actual={paso} estados={estados} onIr={irA} />
          </div>
          <div className="xl:hidden">
            <IndiceCompacto actual={paso} estados={estados} onIr={irA} />
          </div>
        </div>

        <section key={paso} className="vista-entrada flex min-w-0 max-w-3xl flex-col gap-4">
          {paso === 'dominio' && <PasoDominio ctx={ctx} tituloRef={tituloRef} />}
          {paso === 'equipo' && <PasoEquipo ctx={ctx} tituloRef={tituloRef} />}
          {paso === 'obligatorias' && <PasoObligatorias ctx={ctx} tituloRef={tituloRef} />}
          {paso === 'dispositivos' && <PasoDispositivos ctx={ctx} tituloRef={tituloRef} />}
          {paso === 'listo' && <PasoListo ctx={ctx} estados={estados} tituloRef={tituloRef} />}
        </section>
      </div>
    </>
  );
}
