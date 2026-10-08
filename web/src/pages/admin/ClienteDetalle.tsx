import { lazy, Suspense, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { api, ApiError, type Client, type User } from '../../lib/api';
import { esCorreoValido, mensajeDe, vinculadoConSkyway } from '../../lib/gestion';
import { Button } from '../../ui/Button';
import { Input, Textarea } from '../../ui/Field';
import { Cargando, Dialogo, Hoja, MarcaFondo, Membrete } from '../../ui/kit';
import { PestanasRuta, type PestanaRuta } from '../../ui/PestanasRuta';
import { useToast } from '../../ui/toast';
import { useTituloVista } from '../../shell/AppShell';
import {
  BandaError,
  Botonera,
  EnlaceVolver,
  rutaCliente,
  type SeccionCliente,
} from '../../components/gestion/comun';
import { useRefrescarCliente, type ContextoCliente, type RespuestaCliente } from './cliente/datos';

/*
  Cada pestaña se descarga al abrirla. Las de dominios, buzones, alias, marca
  blanca, API, formularios y actividad son las mismas vistas que las páginas
  de «Todos los clientes», con el cliente fijado: una sola implementación y
  las mismas funciones (altas, alta masiva, ficha del buzón, filtros).
*/
const ResumenCliente = lazy(() => import('./cliente/ResumenCliente'));
const UsuariosCliente = lazy(() => import('./cliente/UsuariosCliente'));
const Dominios = lazy(() => import('../Dominios'));
const Buzones = lazy(() => import('../Buzones'));
const Alias = lazy(() => import('../Alias'));
const MarcaBlanca = lazy(() => import('../MarcaBlanca'));
const ApiKeys = lazy(() => import('../ApiKeys'));
const Formularios = lazy(() => import('../Formularios'));
const Actividad = lazy(() => import('../Actividad'));

const NOMBRES: Record<SeccionCliente, string> = {
  '': 'Resumen',
  dominios: 'Dominios',
  buzones: 'Buzones',
  alias: 'Alias',
  usuarios: 'Usuarios',
  'marca-blanca': 'Marca blanca',
  'api-envio': 'API de envío',
  formularios: 'Formularios',
  actividad: 'Actividad',
};

/** Lo que se espera mientras llega el código de la pestaña («Cargando los buzones…»). */
const CARGANDO: Record<SeccionCliente, string> = {
  '': 'el resumen',
  dominios: 'los dominios',
  buzones: 'los buzones',
  alias: 'los alias',
  usuarios: 'los usuarios',
  'marca-blanca': 'la marca blanca',
  'api-envio': 'la API de envío',
  formularios: 'los formularios',
  actividad: 'la actividad',
};

/**
 * Ficha del cliente: el sitio donde se gestiona todo lo suyo, sin saltar de
 * una página a otra. La cabecera (nombre, estado, plan y contacto) se mantiene
 * en todas las pestañas, y cada pestaña tiene su dirección
 * («/clientes/:id/buzones») para poder enlazarla y volver atrás con el navegador.
 */
export default function ClienteDetalle({ user }: { user: User }) {
  const { id = '' } = useParams();
  const { pathname } = useLocation();
  const [editar, setEditar] = useState(false);

  const client = useQuery({
    queryKey: ['client', id],
    queryFn: () => api.get<RespuestaCliente>(`/api/clients/${id}`),
  });

  // Sección actual: lo que sigue a «/clientes/:id/» (vacío en el resumen).
  const resto = pathname.split('/')[3] ?? '';
  const seccion: SeccionCliente = Object.prototype.hasOwnProperty.call(NOMBRES, resto)
    ? (resto as SeccionCliente)
    : '';
  const nombre = client.data?.client.name;
  useTituloVista(nombre ? `${NOMBRES[seccion]} · ${nombre}` : 'Clientes');

  const volver = <EnlaceVolver to="/clientes">Clientes</EnlaceVolver>;

  if (client.isPending) {
    return (
      <>
        {volver}
        <Hoja>
          <Cargando label="Cargando el cliente…" />
        </Hoja>
      </>
    );
  }
  if (client.isError || !client.data) {
    const noExiste = client.error instanceof ApiError && client.error.status === 404;
    return (
      <>
        {volver}
        <BandaError onRetry={noExiste ? undefined : () => void client.refetch()}>
          {noExiste ? 'Cliente no encontrado.' : mensajeDe(client.error, 'No se ha podido cargar la ficha del cliente.')}
        </BandaError>
      </>
    );
  }

  const data = client.data.client;
  const contexto: ContextoCliente = {
    id,
    cliente: data,
    plan: client.data.plan ?? data.plan,
    usage: client.data.usage ?? data.usage,
    usuarios: client.data.users ?? data.users ?? [],
  };
  const { plan, usage, usuarios } = contexto;

  const pestanas: PestanaRuta[] = [
    { to: rutaCliente(id), label: NOMBRES[''] },
    { to: rutaCliente(id, 'dominios'), label: NOMBRES.dominios, cuenta: usage?.domains },
    { to: rutaCliente(id, 'buzones'), label: NOMBRES.buzones, cuenta: usage?.mailboxes },
    { to: rutaCliente(id, 'alias'), label: NOMBRES.alias, cuenta: usage?.aliases },
    { to: rutaCliente(id, 'usuarios'), label: NOMBRES.usuarios, cuenta: usuarios.length },
    { to: rutaCliente(id, 'marca-blanca'), label: NOMBRES['marca-blanca'] },
    // Sin recuento: así las nueve pestañas caben en una fila en un portátil
    // de 1280 px. Los envíos por API se ven en «Plan y carga».
    { to: rutaCliente(id, 'api-envio'), label: NOMBRES['api-envio'] },
    { to: rutaCliente(id, 'formularios'), label: NOMBRES.formularios },
    { to: rutaCliente(id, 'actividad'), label: NOMBRES.actividad },
  ];

  return (
    <>
      {volver}
      <Membrete
        title={data.name}
        meta={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <MarcaFondo veredicto={data.suspended ? 'fuera' : 'normal'}>
              {data.suspended ? 'Suspendido' : 'Activo'}
            </MarcaFondo>
            {plan && <span className="text-sm text-tinta-3">Plan «{plan.name}»</span>}
            {data.contactEmail && (
              <span className="valor min-w-0 break-all text-sm text-tinta-3">{data.contactEmail}</span>
            )}
            {vinculadoConSkyway(data.externalRef) && <span className="text-sm text-tinta-3">Vinculado con Skyway</span>}
          </span>
        }
        actions={
          // Secundaria: la acción principal de cada pestaña va en la propia pestaña.
          <Button variant="perfil" onClick={() => setEditar(true)}>
            Editar datos
          </Button>
        }
      />

      <PestanasRuta pestanas={pestanas} etiqueta={`Secciones de ${data.name}`} />

      {data.suspended && (
        <div className="mb-4">
          <BandaError>
            Cliente suspendido: sus buzones no pueden iniciar sesión y no es posible crear dominios, buzones ni
            alias ni enviar por la API. Se reactiva desde «Resumen».
          </BandaError>
        </div>
      )}

      {/* La clave hace entrar cada pestaña con el fundido de las vistas. */}
      <div key={seccion} className="vista-entrada">
        <Suspense fallback={<Cargando label={`Cargando ${CARGANDO[seccion]}…`} />}>
          <Routes>
            <Route index element={<ResumenCliente contexto={contexto} />} />
            <Route path="dominios" element={<Dominios isAdmin clienteFijo={id} />} />
            <Route path="buzones" element={<Buzones clienteFijo={id} />} />
            <Route path="alias" element={<Alias clienteFijo={id} />} />
            <Route path="usuarios" element={<UsuariosCliente contexto={contexto} />} />
            <Route path="marca-blanca" element={<MarcaBlanca isAdmin clienteFijo={id} />} />
            <Route path="api-envio" element={<ApiKeys user={user} clienteFijo={id} />} />
            <Route path="formularios" element={<Formularios user={user} clienteFijo={id} />} />
            <Route path="actividad" element={<Actividad clienteFijo={id} />} />
            <Route path="*" element={<Navigate to={rutaCliente(id)} replace />} />
          </Routes>
        </Suspense>
      </div>

      {editar && <EditarDatos client={data} onClose={() => setEditar(false)} />}
    </>
  );
}

/* --------------------------------- Datos ---------------------------------- */

function EditarDatos({ client, onClose }: { client: Client; onClose: () => void }) {
  const toast = useToast();
  const refrescar = useRefrescarCliente(client.id);
  const [name, setName] = useState(client.name);
  const [contactEmail, setContactEmail] = useState(client.contactEmail);
  const [notes, setNotes] = useState(client.notes);
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () => api.patch(`/api/clients/${client.id}`, { name, contactEmail, notes }),
    onSuccess: async () => {
      await refrescar();
      toast('ok', 'Datos del cliente actualizados.');
      onClose();
    },
    onError: (err) => setError(mensajeDe(err, 'No se han podido guardar los datos.')),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) {
      setError('El nombre del cliente debe tener al menos 2 caracteres.');
      return;
    }
    if (contactEmail.trim() && !esCorreoValido(contactEmail)) {
      setError('El correo de contacto no es una dirección válida.');
      return;
    }
    setError('');
    save.mutate();
  }

  return (
    <Dialogo open onClose={onClose} title="Editar datos del cliente">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Input
          label="Nombre"
          maxLength={80}
          value={name}
          onChange={(e) => {
            setError('');
            setName(e.target.value);
          }}
        />
        <Input
          label="Correo de contacto"
          type="email"
          value={contactEmail}
          onChange={(e) => {
            setError('');
            setContactEmail(e.target.value);
          }}
          help="Opcional. Se usa para comunicaciones con el cliente."
        />
        <Textarea
          label="Notas internas"
          maxLength={1000}
          value={notes}
          onChange={(e) => {
            setError('');
            setNotes(e.target.value);
          }}
          help="Solo las ve el administrador."
        />
        {error && <BandaError>{error}</BandaError>}
        <Botonera>
          <Button type="button" variant="plano" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="principal" busy={save.isPending}>
            Guardar cambios
          </Button>
        </Botonera>
      </form>
    </Dialogo>
  );
}

