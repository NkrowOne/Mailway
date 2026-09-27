import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, ApiError, type Client, type User } from '../lib/api';
import { formatDate, plural } from '../lib/format';
import {
  detalleAnotacion,
  etiquetaAccion,
  tokenDeAnotacion,
  type AnotacionActividad,
  type PaginaActividad,
} from '../lib/tokens';
import { Button } from '../ui/Button';
import { Select } from '../ui/Field';
import { Hoja, Membrete, Midiendo, Vacio } from '../ui/kit';

/** Anotaciones por página: suficiente para una jornada sin cargar el registro entero. */
const POR_PAGINA = 50;

const bandaError =
  'border border-[rgb(var(--fuera)/0.4)] bg-fuera-fondo px-3 py-2 text-sm text-fuera';

function mensajeDe(err: unknown, porDefecto: string): string {
  return err instanceof ApiError ? err.message : porDefecto;
}

/** Registro de auditoría: quién hizo qué, cuándo y, si fue una integración, con qué token. */
export default function Actividad() {
  // El usuario ya está en la caché desde el arranque; aquí solo se lee su rol.
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User | null }>('/api/auth/me'),
  });
  const isAdmin = me.data?.user?.role === 'admin';
  const [clienteFiltro, setClienteFiltro] = useState('');

  const clientes = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: Client[] }>('/api/clients'),
    enabled: isAdmin,
  });

  const filtro = isAdmin ? clienteFiltro : '';
  // Clave propia: ['audit'] a secas la usa el parte del administrador con otra forma de datos.
  const registro = useInfiniteQuery({
    queryKey: ['audit', 'actividad', filtro],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(POR_PAGINA) });
      if (pageParam !== undefined) params.set('before', String(pageParam));
      if (filtro) params.set('clientId', filtro);
      return api.get<PaginaActividad>(`/api/audit?${params.toString()}`);
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (ultima) => ultima.nextBefore ?? undefined,
  });

  const anotaciones = registro.data?.pages.flatMap((p) => p.entries) ?? [];
  // Si falla una página posterior, lo ya leído se conserva y el error va junto a «Cargar más».
  const errorInicial = registro.isError && anotaciones.length === 0;
  const verCliente = isAdmin && !filtro;

  return (
    <>
      <Membrete
        title="Actividad"
        meta={
          <>
            <p>
              Registro de auditoría: cada acción queda anotada con su autor, su fecha y, si la
              realizó una integración, el token que utilizó.
            </p>
            {registro.isSuccess && anotaciones.length > 0 && (
              <p className="rotulo mt-1.5 text-white/70">
                {plural(anotaciones.length, 'anotación cargada', 'anotaciones cargadas')}
              </p>
            )}
          </>
        }
      />

      {isAdmin && (
        <div className="mb-4 max-w-xs">
          <Select
            label="Cliente"
            value={clienteFiltro}
            onChange={(e) => setClienteFiltro(e.target.value)}
            disabled={clientes.isPending}
          >
            <option value="">Todos los clientes y la instancia</option>
            {(clientes.data?.clients ?? []).map((cliente) => (
              <option key={cliente.id} value={cliente.id}>
                {cliente.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      <Hoja flush>
        {registro.isPending ? (
          <Midiendo label="Leyendo el registro de actividad…" />
        ) : errorInicial ? (
          <div className="flex flex-col items-start gap-3 px-4 py-4">
            <p role="alert" className={`${bandaError} w-full`}>
              No se ha podido leer el registro de actividad.{' '}
              {mensajeDe(registro.error, 'Compruebe la conexión con el servidor.')}
            </p>
            <Button variant="perfil" busy={registro.isFetching} onClick={() => registro.refetch()}>
              Reintentar
            </Button>
          </div>
        ) : anotaciones.length === 0 ? (
          <Vacio title="No hay actividad registrada">
            {filtro
              ? 'No constan acciones sobre este cliente.'
              : 'Las acciones sobre clientes, dominios, buzones y claves aparecerán aquí a medida que se realicen.'}
          </Vacio>
        ) : (
          <>
            {/* Cabecera de columnas: la fecha y el detalle van en cifras. */}
            <div className="regla-cabecera hidden items-baseline gap-x-4 px-4 py-2 sm:flex">
              <span className="rotulo w-32 shrink-0">Fecha</span>
              <span className="rotulo min-w-0 grow basis-40">Acción</span>
              <span className="rotulo shrink-0 basis-44">Autor</span>
              {verCliente && <span className="rotulo shrink-0 basis-36">Cliente</span>}
            </div>

            <ul>
              {anotaciones.map((anotacion) => (
                <FilaActividad key={anotacion.id} anotacion={anotacion} verCliente={verCliente} />
              ))}
            </ul>

            {(registro.hasNextPage || registro.isFetchNextPageError) && (
              <div className="flex flex-col items-start gap-3 border-t border-regla px-4 py-3">
                {registro.isFetchNextPageError && (
                  <p role="alert" className={`${bandaError} w-full`}>
                    No se han podido leer más anotaciones.{' '}
                    {mensajeDe(registro.error, 'Vuelva a intentarlo.')}
                  </p>
                )}
                <Button
                  variant="perfil"
                  busy={registro.isFetchingNextPage}
                  onClick={() => registro.fetchNextPage()}
                >
                  Cargar más
                </Button>
              </div>
            )}
          </>
        )}
      </Hoja>
    </>
  );
}

function FilaActividad({
  anotacion,
  verCliente,
}: {
  anotacion: AnotacionActividad;
  verCliente: boolean;
}) {
  const detalle = detalleAnotacion(anotacion.detail).join(' · ');
  const token = tokenDeAnotacion(anotacion.detail);
  const actor = anotacion.actor;
  return (
    <li
      className="regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-0.5 px-4 py-2
        transition-colors duration-100 last:border-b-0 hover:bg-hoja-2"
    >
      <span className="valor w-32 shrink-0 text-sm text-tinta-3">{formatDate(anotacion.createdAt)}</span>
      {/* La acción identifica la anotación: nunca truncada. */}
      <div className="min-w-0 grow basis-40">
        <p className="break-words text-base text-tinta">{etiquetaAccion(anotacion.action)}</p>
        {detalle && <p className="valor break-all text-sm text-tinta-3">{detalle}</p>}
        {token && (
          <p className="text-sm text-tinta-2">
            mediante el token <span className="valor">«{token}»</span>
          </p>
        )}
      </div>
      <span className="min-w-0 basis-full break-words text-sm text-tinta-2 sm:shrink-0 sm:basis-44">
        <span className="rotulo mr-1.5 sm:hidden">Autor</span>
        {actor ? (
          actor.email ? (
            <span className="valor break-all" title={actor.name}>
              {actor.email}
            </span>
          ) : (
            <span>{actor.role === 'admin' ? 'Administración del servicio' : actor.name}</span>
          )
        ) : (
          <span className="text-tinta-3">Sistema</span>
        )}
      </span>
      {verCliente && (
        <span className="min-w-0 basis-full break-words text-sm text-tinta-2 sm:shrink-0 sm:basis-36">
          <span className="rotulo mr-1.5 sm:hidden">Cliente</span>
          {anotacion.clientName ?? <span className="text-tinta-3">Instancia</span>}
        </span>
      )}
    </li>
  );
}
