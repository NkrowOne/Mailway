import { useEffect, useMemo, useRef } from 'react';
import { ListChecks, Plus } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type ClientDashboard, type Mailbox, type User } from '../lib/api';
import { propiedadPendiente, type DominioCorreo } from '../lib/cloudflare';
import { useUsuario } from '../components/gestion/consultas';
import { useTituloVista } from '../shell/AppShell';
import { Button, estiloBoton } from '../ui/Button';
import { Select } from '../ui/Field';
import { AvisoError, Cargando, Hoja, Membrete, Vacio } from '../ui/kit';
import {
  clave,
  esPaso,
  lecturaCuenta,
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
import { buzonPropioSeguro, PasoDispositivos } from './puesta/PasoDispositivos';
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

  if (!usuario) return <Cargando label="Preparando la puesta en marcha…" />;

  if (usuario.role !== 'client') {
    return (
      <>
        <Membrete title="Puesta en marcha" />
        <Hoja>
          <Vacio
            icono={ListChecks}
            title="La puesta en marcha es de cada cliente"
            action={
              <Link to="/clientes" className={estiloBoton('perfil')}>
                Ir a Clientes
              </Link>
            }
          >
            Abre la ficha del cliente y su pestaña «Puesta en marcha»: ahí ves lo mismo que ve el cliente, le envías
            el enlace o la haces por él.
          </Vacio>
        </Hoja>
      </>
    );
  }

  return <CargaPuesta usuario={usuario} />;
}

/**
 * La puesta en marcha de un cliente desde su ficha (administración): la misma
 * guía que ve el cliente, con sus datos, para seguirla, enviarle el enlace o
 * hacerla por él. Sin cabecera propia: la ficha ya tiene la suya.
 */
export function PuestaDelCliente({ clientId, usuario }: { clientId: string; usuario: User }) {
  return <CargaPuesta usuario={usuario} clientId={clientId} />;
}

/** Carga lo que necesita la guía: el resumen del cliente, sus dominios y sus buzones. */
function CargaPuesta({ usuario, clientId }: { usuario: User; clientId?: string }) {
  const sufijo = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  const panel = useQuery({
    queryKey: clientId ? ['client-dashboard', clientId] : ['client-dashboard'],
    queryFn: () => api.get<ClientDashboard>(`/api/dashboard/client${sufijo}`),
  });
  const dominios = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ domains: DominioCorreo[] }>('/api/domains'),
  });
  // La misma clave que la pestaña «Buzones» de la ficha: comparten caché.
  const buzones = useQuery({
    queryKey: clientId ? ['mailboxes', 'cliente', clientId] : ['mailboxes'],
    queryFn: () => api.get<{ mailboxes: Mailbox[] }>(`/api/mailboxes${sufijo}`),
  });

  if (panel.isPending || dominios.isPending || buzones.isPending) {
    return <Cargando label="Preparando la puesta en marcha…" />;
  }
  if (!panel.data || !dominios.data || !buzones.data) {
    return (
      <>
        {!clientId && <Membrete title="Puesta en marcha" />}
        <AvisoError
          onRetry={() => {
            void panel.refetch();
            void dominios.refetch();
            void buzones.refetch();
          }}
          retrying={panel.isFetching || dominios.isFetching || buzones.isFetching}
        >
          {clientId
            ? 'No se ha podido cargar la puesta en marcha del cliente. Comprueba la conexión y vuelve a intentarlo.'
            : 'No se ha podido cargar el estado de tu correo. Comprueba la conexión y vuelve a intentarlo.'}
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
      modoAdmin={Boolean(clientId)}
    />
  );
}

function Asistente({
  usuario,
  panel,
  dominios,
  buzonesCliente,
  modoAdmin,
}: {
  usuario: User;
  panel: ClientDashboard;
  dominios: DominioCorreo[];
  buzonesCliente: Mailbox[];
  /** Desde la ficha del cliente: el paso de los dispositivos es suyo, no de quien administra. */
  modoAdmin: boolean;
}) {
  const clientId = panel.client.id;
  const [params, setParams] = useSearchParams();
  const tituloRef = useRef<HTMLHeadingElement>(null);

  const [enlacesGuardados, setEnlaces] = useRecordado<EnlaceGuardado[]>(clave(clientId, 'enlaces'), () => [], 'sesion');
  const enlaces = useMemo(() => vigentes(enlacesGuardados), [enlacesGuardados]);
  const [mioId, setMioId] = useRecordado<string | null>(clave(clientId, 'mio'), () => null, 'local');
  const [personales, setPersonales] = useRecordado<Record<string, string>>(
    clave(clientId, 'personales'),
    () => ({}),
    'sesion',
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

  // El estado de cada buzón lo da el servidor: rojo mientras a alguien no le
  // haya llegado (ni abierto) su configuración. Mientras quede alguno, «Tu
  // equipo» no está hecho: así la puesta en marcha vuelve ahí, que es donde
  // se resuelve, y no a un paso posterior.
  // El buzón propio no cuenta aquí: se configura en el paso 4, que sale en
  // rojo él solo.
  // Desde la administración no hay «buzón propio»: es el del cliente.
  const propio = modoAdmin ? null : buzonPropioSeguro({ buzones, mioId, usuario });
  const buzonMio = buzones.find((b) => b.id === propio) ?? null;
  const sinConfigurar = buzones.filter((b) => b.id !== propio && lecturaCuenta(b).estado === 'sin-configurar').length;
  const configurados = buzones.filter((b) => lecturaCuenta(b).estado === 'configurado').length;

  const estados: Record<PasoId, EstadoPaso> = {
    dominio: !dominio
      ? { hecho: false, detalle: 'Pendiente', veredicto: 'sin-dato' }
      : propiedadPendiente(dominio)
        ? { hecho: false, detalle: 'Propiedad pendiente', veredicto: 'vigilar' }
        : dominio.status === 'active'
          ? { hecho: true, detalle: 'Listo', veredicto: 'normal' }
          : { hecho: true, detalle: 'DNS pendiente', veredicto: 'vigilar' },
    equipo:
      buzones.length === 0
        ? { hecho: false, detalle: 'Pendiente', veredicto: 'sin-dato' }
        : sinConfigurar > 0
          ? { hecho: false, detalle: `${sinConfigurar} sin configurar`, veredicto: 'fuera' }
          : configurados === buzones.length
            ? { hecho: true, detalle: buzones.length === 1 ? '1 buzón configurado' : `${buzones.length} buzones configurados`, veredicto: 'normal' }
            : { hecho: true, detalle: `${configurados} de ${buzones.length} configurados`, veredicto: 'vigilar' },
    obligatorias: panel.onboarding.hasEssentialAddresses
      ? { hecho: true, detalle: 'Creadas', veredicto: 'normal' }
      : { hecho: false, detalle: 'Pendiente', veredicto: 'sin-dato' },
    dispositivos: modoAdmin
      ? { hecho: false, detalle: 'Lo hace el cliente', veredicto: 'sin-dato' }
      : !buzonMio
      ? { hecho: false, detalle: buzones.length > 0 ? 'Recomendado' : 'Pendiente', veredicto: 'sin-dato' }
      : buzonMio.configuredAt
        ? { hecho: true, detalle: 'Configurados', veredicto: 'normal' }
        : { hecho: false, detalle: 'Tu buzón sin configurar', veredicto: 'fuera' },
    listo: { hecho: false, detalle: '', veredicto: 'sin-dato' },
  };
  const pendiente = PASOS.find(
    (p) => p.id !== 'listo' && !(modoAdmin && p.id === 'dispositivos') && !estados[p.id].hecho,
  );
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
      n.delete('anadir');
      return n;
    });
  }

  // Añadir buzones lleva siempre a «Tu equipo» con el alta abierta, esté
  // donde esté la puesta en marcha.
  function anadirBuzones() {
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      n.set('paso', 'equipo');
      n.set('anadir', '1');
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
    // El suyo, aunque no lo marcara al crear el equipo (otro navegador).
    mioId: propio,
    setMioId,
    personales,
    setPersonal: (mailboxId, correo) => setPersonales((prev) => ({ ...prev, [mailboxId]: correo })),
    anadir: params.get('anadir') === '1',
    irA,
    anadirBuzones,
    suspendido: panel.client.suspended,
    modoAdmin,
  };
  // En «Tu equipo» ya está en la lista de buzones: aquí sobraría.
  const puedeAnadir = Boolean(dominio && !propiedadPendiente(dominio)) && !ctx.suspendido && paso !== 'equipo';

  const acciones =
    propios.length > 1 || puedeAnadir ? (
            <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:flex-row sm:items-end">
              {puedeAnadir && (
                <Button variant="perfil" onClick={anadirBuzones} className="sm:order-2">
                  <Plus className="h-4 w-4" aria-hidden />
                  Añadir buzones
                </Button>
              )}
              {propios.length > 1 && (
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
              )}
            </div>
    ) : undefined;

  return (
    <>
      {modoAdmin ? (
        // En la ficha del cliente: sin otra cabecera, solo lo que se puede elegir.
        acciones && <div className="mb-4 flex justify-end">{acciones}</div>
      ) : (
        <Membrete
          title="Puesta en marcha"
          meta={`Todo lo necesario para que ${panel.client.name} tenga su correo funcionando, paso a paso.`}
          actions={acciones}
        />
      )}

      {ctx.suspendido && (
        <AvisoError className="mb-4">
          {modoAdmin
            ? 'El cliente está suspendido: no se pueden añadir dominios ni buzones. Se reactiva desde «Resumen».'
            : 'Tu cuenta está suspendida: no se pueden añadir dominios ni buzones. Ponte en contacto con tu proveedor.'}
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
