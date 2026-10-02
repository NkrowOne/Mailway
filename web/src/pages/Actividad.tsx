import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, ApiError, type Client, type User } from '../lib/api';
import { formatDate, plural } from '../lib/format';
import {
  autorAnotacion,
  detalleAnotacion,
  etiquetaAccion,
  tokenDeAnotacion,
  type AnotacionActividad,
  type PaginaActividad,
} from '../lib/tokens';
import { Button } from '../ui/Button';
import { Select } from '../ui/Field';
import { AvisoError, Hoja, Membrete, Midiendo, Vacio } from '../ui/kit';

/** Anotaciones por página: suficiente para una jornada sin cargar el registro entero. */
const POR_PAGINA = 50;

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

      {/* El filtro va en la cabecera de la hoja que filtra, no suelto sobre la mesa. */}
      <Hoja
        title="Registro"
        actions={
          isAdmin ? (
            <div className="w-full min-w-[14rem] sm:w-72">
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
          ) : undefined
        }
        flush
      >
        {registro.isPending ? (
          <Midiendo label="Cargando el registro de actividad…" />
        ) : errorInicial ? (
          <div className="px-4 py-4">
            <AvisoError onRetry={() => void registro.refetch()} retrying={registro.isFetching}>
              No se ha podido leer el registro de actividad.{' '}
              {mensajeDe(registro.error, 'Comprueba la conexión con el servidor.')}
            </AvisoError>
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
                  <AvisoError className="w-full">
                    No se han podido leer más anotaciones.{' '}
                    {mensajeDe(registro.error, 'Vuelve a intentarlo.')}
                  </AvisoError>
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
  const autor = autorAnotacion(anotacion);
  return (
    <li
      className="regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-0.5 px-4 py-2
        transition-colors duration-100 last:border-b-0 hover:bg-hoja-2"
    >
      <span className="valor w-32 shrink-0 text-sm text-tinta-3">{formatDate(anotacion.createdAt)}</span>
      {/* La acción identifica la anotación: nunca truncada. */}
      <div className="min-w-0 grow basis-40">
        <p className="break-words text-base text-tinta">{etiquetaAccion(anotacion.action)}</p>
        {/* Corte solo donde hace falta: «break-all» partía «talleres-rui/z.es». */}
        {detalle && <p className="valor text-sm text-tinta-3 [overflow-wrap:anywhere]">{detalle}</p>}
        {token && (
          <p className="text-sm text-tinta-2">
            mediante el token <span className="valor">«{token}»</span>
          </p>
        )}
      </div>
      <span className="min-w-0 basis-full text-sm text-tinta-2 [overflow-wrap:anywhere] sm:shrink-0 sm:basis-44">
        <span className="rotulo mr-1.5 sm:hidden">Autor</span>
        {autor.correo ? (
          <span className="valor [overflow-wrap:anywhere]" title={autor.titular ?? undefined}>
            {autor.correo}
          </span>
        ) : (
          <span className={autor.texto === 'Sistema' ? 'text-tinta-3' : undefined}>{autor.texto}</span>
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
