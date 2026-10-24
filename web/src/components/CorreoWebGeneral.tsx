import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  ANCLA_AJUSTES_CORREO_WEB,
  DESCRIPCION_MOTOR,
  NOMBRE_MOTOR,
  SE_PIERDE,
  esHttps,
  type AjustesCorreoWeb,
  type EstadoCorreoWebGeneral,
  type MotorCorreoWeb,
} from '../lib/correoweb';
import { plural } from '../lib/format';
import { mensajeDe } from '../lib/gestion';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';
import { AvisoError, AvisoEspera, Cargando, Dialogo, Hoja, Marca, MarcaFondo, type Veredicto } from '../ui/kit';
import { useToast } from '../ui/toast';
import { ListaCambios } from './CorreoWeb';
import { BandaAviso, Botonera, Casilla } from './gestion/comun';

/*
  Ajustes → Correo web nuevo (Bulwark, beta): lo que vale para toda la
  instancia. El correo web con el que empiezan los clientes nuevos, pasar a
  todos los clientes de una vez y las funciones que ven los usuarios del
  nuevo, iguales para todos porque Bulwark tiene una sola política. La
  elección de cada cliente y su marca siguen en su tarjeta de Marca blanca.
*/

const CLAVE = ['correo-web-general'];
const URL_AJUSTES = '/api/settings/correo-web';

const ESPERA_CORS =
  'Preparando el servidor de correo para el correo web nuevo: se abre su acceso desde el navegador (CORS). Puede tardar hasta un minuto y medio.';

type Funciones = Pick<AjustesCorreoWeb, 'calendario' | 'contactos' | 'archivos' | 'relePush'>;

function funcionesDe(ajustes: AjustesCorreoWeb): Funciones {
  return {
    calendario: ajustes.calendario,
    contactos: ajustes.contactos,
    archivos: ajustes.archivos,
    relePush: ajustes.relePush,
  };
}

/** Las órdenes del servidor que trae un texto del servidor, en monoespaciada. */
function ConOrdenes({ texto }: { texto: string }) {
  const partes = texto.split(/(sudo mailway [\w-]+(?: (?:on|off|status))?)/);
  return (
    <>
      {partes.map((parte, i) =>
        i % 2 === 1 ? (
          <code key={i} className="codigo text-sm">
            {parte}
          </code>
        ) : (
          parte
        ),
      )}
    </>
  );
}

function textoUso(conBulwark: number, total: number): string {
  if (total === 0) return 'Todavía no hay clientes.';
  if (conBulwark === 0) return 'Ningún cliente lo usa todavía.';
  if (conBulwark === total) return total === 1 ? 'Lo usa el único cliente.' : `Lo usan los ${total} clientes.`;
  return `Lo ${conBulwark === 1 ? 'usa' : 'usan'} ${conBulwark} de ${total} clientes.`;
}

export function HojaCorreoWebGeneral() {
  const consulta = useQuery({
    queryKey: CLAVE,
    queryFn: () => api.get<EstadoCorreoWebGeneral>(URL_AJUSTES),
  });
  const { hash } = useLocation();
  const ancla = useRef<HTMLDivElement>(null);
  const cargada = consulta.data !== undefined;

  // Desde la tarjeta «Correo web» de un cliente se llega con el ancla: se baja
  // hasta aquí cuando ya hay contenido, no mientras la tarjeta solo carga.
  useEffect(() => {
    if (cargada && hash === `#${ANCLA_AJUSTES_CORREO_WEB}`) ancla.current?.scrollIntoView({ block: 'start' });
  }, [cargada, hash]);

  const titulo = 'Correo web nuevo';
  return (
    <div id={ANCLA_AJUSTES_CORREO_WEB} ref={ancla} className="min-w-0 scroll-mt-20 lg:col-span-2 lg:scroll-mt-8">
      {consulta.isPending ? (
        <Hoja title={titulo} meta="Beta">
          <Cargando label="Cargando el correo web nuevo…" />
        </Hoja>
      ) : consulta.isError || !consulta.data ? (
        <Hoja title={titulo} meta="Beta">
          <AvisoError onRetry={() => void consulta.refetch()} retrying={consulta.isFetching}>
            {mensajeDe(consulta.error, 'No se han podido cargar los ajustes del correo web nuevo.')}
          </AvisoError>
        </Hoja>
      ) : (
        <Hoja title={titulo} meta="Beta" flush>
          <Estado datos={consulta.data} />
          <ParaNuevos datos={consulta.data} />
          <PasarTodos datos={consulta.data} />
          {/* Se vuelve a montar cuando cambian las funciones guardadas: el
              formulario parte siempre de lo guardado, y elegir el de los
              clientes nuevos no borra lo que se esté escribiendo aquí. */}
          <FormularioFunciones
            key={JSON.stringify(funcionesDe(consulta.data.ajustes))}
            ajustes={consulta.data.ajustes}
          />
        </Hoja>
      )}
    </div>
  );
}

/* --------------------------------- Estado --------------------------------- */

function Estado({ datos }: { datos: EstadoCorreoWebGeneral }) {
  const { estado, clientes } = datos;
  // Elegido por algunos clientes pero sin servir: sus webmail abren Roundcube.
  const mientras =
    clientes.conBulwark > 0
      ? ` ${plural(clientes.conBulwark, 'cliente lo tiene elegido y se sirve', 'clientes lo tienen elegido y se sirven')} con Roundcube mientras tanto.`
      : '';

  let veredicto: Veredicto;
  let etiqueta: string;
  let detalle: ReactNode;
  if (estado.enServicio) {
    veredicto = 'normal';
    etiqueta = 'En servicio';
    detalle = textoUso(clientes.conBulwark, clientes.total);
  } else if (estado.disponible) {
    // Instalado, pero el motor no es (o no se sabe si es) Stalwart 0.16.
    veredicto = 'vigilar';
    etiqueta = 'Instalado, sin servicio';
    detalle = (
      <>
        <ConOrdenes texto={estado.motivoServicio ?? 'El correo web nuevo necesita Stalwart 0.16.'} />
        {mientras}
      </>
    );
  } else {
    veredicto = 'sin-dato';
    etiqueta = 'No disponible';
    detalle = (
      <>
        <ConOrdenes texto={estado.motivo ?? 'El correo web nuevo no está instalado en este servidor.'} /> Se activa
        en el servidor con <code className="codigo text-sm">sudo mailway bulwark on</code>.{mientras}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <p className="max-w-[75ch] text-base text-tinta-2">
        La alternativa a Roundcube para los webmail propios de los clientes: interfaz actual, calendario y
        contactos, aplicación instalable y la marca de cada cliente. Cada cliente se cambia en la tarjeta «Correo
        web» de su «Marca blanca»; aquí se elige lo que se aplica a todos.
      </p>
      <div role="status" className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Marca veredicto={veredicto}>{etiqueta}</Marca>
        <span className="min-w-0 max-w-[75ch] text-sm text-tinta-2 [overflow-wrap:anywhere]">{detalle}</span>
      </div>
    </div>
  );
}

/* ---------------------------- Clientes nuevos ------------------------------ */

function ParaNuevos({ datos }: { datos: EstadoCorreoWebGeneral }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState('');
  const { estado, ajustes } = datos;

  const elegir = useMutation({
    mutationFn: (paraNuevos: MotorCorreoWeb) => api.put<EstadoCorreoWebGeneral>(URL_AJUSTES, { paraNuevos }),
    onSuccess: async (data) => {
      queryClient.setQueryData(CLAVE, data);
      toast(
        'ok',
        data.ajustes.paraNuevos === 'bulwark'
          ? 'Los clientes nuevos empezarán con el correo web nuevo.'
          : 'Los clientes nuevos empezarán con Roundcube.',
      );
      // Elegir el nuevo puede haber abierto el CORS del motor.
      if (data.ajustes.paraNuevos === 'bulwark') {
        await queryClient.invalidateQueries({ queryKey: ['engine-status'] });
      }
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido cambiar el correo web de los clientes nuevos.')),
  });

  return (
    <section className="flex flex-col gap-3 border-t border-regla px-4 py-4" aria-labelledby="correo-web-nuevos">
      <div>
        <h3 id="correo-web-nuevos" className="text-base font-semibold text-tinta">
          Correo web de los clientes nuevos
        </h3>
        <p className="mt-0.5 max-w-[75ch] text-sm text-tinta-3">
          El que tendrá cada cliente que se dé de alta; los que ya existen conservan el suyo. Si se elige el correo
          web nuevo, antes se abre, si hace falta, el acceso al servidor de correo desde el navegador (CORS).
        </p>
      </div>
      {ajustes.paraNuevos === 'bulwark' && !estado.enServicio && (
        <BandaAviso>Mientras el correo web nuevo no esté en servicio, los clientes nuevos empiezan con Roundcube.</BandaAviso>
      )}
      <ul className="overflow-hidden rounded-lg border border-regla">
        {(['roundcube', 'bulwark'] as const).map((motor) => {
          const elegido = ajustes.paraNuevos === motor;
          const bloqueado = motor === 'bulwark' && !estado.enServicio;
          return (
            <li
              key={motor}
              className="regla-fila flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-3 last:border-b-0"
            >
              <div className="min-w-0 max-w-[68ch] flex-1 basis-64">
                <p className="text-base font-medium text-tinta">
                  {NOMBRE_MOTOR[motor]}
                  {motor === 'roundcube' && <span className="font-normal text-tinta-3"> · predeterminado</span>}
                </p>
                <p className="text-sm text-tinta-2">{DESCRIPCION_MOTOR[motor]}</p>
                {!elegido && bloqueado && (
                  <p className="mt-1 text-sm text-tinta-3">Se podrá elegir cuando el correo web nuevo esté en servicio.</p>
                )}
              </div>
              <div className="shrink-0">
                {elegido ? (
                  <MarcaFondo veredicto="normal">Elegido</MarcaFondo>
                ) : (
                  <Button
                    variant="perfil"
                    busy={elegir.isPending && elegir.variables === motor}
                    disabled={bloqueado || elegir.isPending}
                    onClick={() => {
                      setError('');
                      elegir.mutate(motor);
                    }}
                  >
                    {motor === 'bulwark' ? 'Elegir el correo web nuevo' : 'Elegir Roundcube'}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <AvisoEspera activo={elegir.isPending && elegir.variables === 'bulwark'}>{ESPERA_CORS}</AvisoEspera>
      {error && <AvisoError>{error}</AvisoError>}
    </section>
  );
}

/* ------------------------------ Pasar a todos ------------------------------ */

function PasarTodos({ datos }: { datos: EstadoCorreoWebGeneral }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmar, setConfirmar] = useState<MotorCorreoWeb | null>(null);
  const [error, setError] = useState('');
  const { estado, clientes } = datos;
  const conRoundcube = clientes.total - clientes.conBulwark;

  const pasar = useMutation({
    mutationFn: (motor: MotorCorreoWeb) =>
      api.post<EstadoCorreoWebGeneral & { cambiados: number }>(`${URL_AJUSTES}/todos`, { motor }),
    onSuccess: async ({ cambiados, ...data }, motor) => {
      queryClient.setQueryData(CLAVE, data);
      setConfirmar(null);
      toast(
        'ok',
        cambiados === 0
          ? 'No había ningún cliente por cambiar.'
          : motor === 'bulwark'
            ? `${cambiados === 1 ? '1 cliente pasa' : `${cambiados} clientes pasan`} al correo web nuevo. Sus webmail cambian en unos segundos.`
            : `${cambiados === 1 ? '1 cliente vuelve' : `${cambiados} clientes vuelven`} a Roundcube. Sus webmail cambian en unos segundos.`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['correo-web'] }),
        queryClient.invalidateQueries({ queryKey: ['client'] }),
        queryClient.invalidateQueries({ queryKey: ['clients'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['engine-status'] }),
      ]);
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido cambiar el correo web de los clientes.')),
  });

  function abrir(motor: MotorCorreoWeb) {
    setError('');
    setConfirmar(motor);
  }

  const titulo = confirmar === 'bulwark' ? 'Pasar todos al correo web nuevo' : 'Pasar todos a Roundcube';

  return (
    <section className="flex flex-col gap-3 border-t border-regla px-4 py-4" aria-labelledby="correo-web-todos">
      <div>
        <h3 id="correo-web-todos" className="text-base font-semibold text-tinta">
          Pasar a todos los clientes
        </h3>
        <p className="mt-0.5 max-w-[75ch] text-sm text-tinta-3">
          Cambia a la vez el correo web de todos los clientes que ya existen. Después, cada uno se puede cambiar en
          la tarjeta «Correo web» de su «Marca blanca». No afecta a los clientes nuevos.
        </p>
      </div>
      {clientes.total === 0 ? (
        <p className="text-sm text-tinta-2">Todavía no hay clientes.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {clientes.conBulwark > 0 && (
            <Button variant="perfil" onClick={() => abrir('roundcube')}>
              Pasar todos a Roundcube
            </Button>
          )}
          {conRoundcube > 0 && (
            <Button variant="perfil" disabled={!estado.enServicio} onClick={() => abrir('bulwark')}>
              Pasar todos al correo web nuevo
            </Button>
          )}
        </div>
      )}
      {conRoundcube > 0 && !estado.enServicio && (
        <p className="text-sm text-tinta-3">Se podrá pasar a todos al correo web nuevo cuando esté en servicio.</p>
      )}

      <Dialogo
        open={confirmar !== null}
        onClose={() => {
          if (!pasar.isPending) setConfirmar(null);
        }}
        title={titulo}
        pie={
          <Botonera>
            <Button variant="plano" disabled={pasar.isPending} onClick={() => setConfirmar(null)}>
              Cancelar
            </Button>
            <Button variant="principal" busy={pasar.isPending} onClick={() => confirmar && pasar.mutate(confirmar)}>
              {titulo}
            </Button>
          </Botonera>
        }
      >
        <div className="flex flex-col gap-3 text-base text-tinta-2">
          {confirmar === 'bulwark' ? (
            <>
              <p>
                {conRoundcube === 1
                  ? 'El cliente que usa Roundcube pasa'
                  : `Los ${conRoundcube} clientes que usan Roundcube pasan`}{' '}
                al correo web nuevo: sus webmail propios lo abrirán en unos segundos y quien tenga Roundcube abierto
                tendrá que volver a acceder. El correo, el calendario y los contactos siguen en el servidor.
              </p>
              {clientes.conBulwark === 0 && (
                <p>
                  Si ningún cliente lo usaba, se aplican también los ajustes recomendados del servidor de correo, que
                  le abren el acceso desde el navegador (CORS): puede tardar hasta un minuto y medio.
                </p>
              )}
              <ListaCambios titulo="Se pierde" elementos={SE_PIERDE} />
            </>
          ) : (
            <p>
              {clientes.conBulwark === 1
                ? 'El cliente que usa el correo web nuevo vuelve'
                : `Los ${clientes.conBulwark} clientes que usan el correo web nuevo vuelven`}{' '}
              a Roundcube: sus webmail propios lo abrirán en unos segundos. Las libretas, identidades y firmas creadas
              en el correo web nuevo no pasan a Roundcube; el correo, el calendario y los contactos siguen en el
              servidor.
            </p>
          )}
          <p>Después, cada cliente se puede cambiar en la tarjeta «Correo web» de su «Marca blanca».</p>
          <AvisoEspera activo={pasar.isPending && confirmar === 'bulwark'}>{ESPERA_CORS}</AvisoEspera>
          {error && <AvisoError>{error}</AvisoError>}
        </div>
      </Dialogo>
    </section>
  );
}

/* -------------------------------- Funciones -------------------------------- */

function FormularioFunciones({ ajustes }: { ajustes: AjustesCorreoWeb }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [campos, setCampos] = useState<Funciones>(() => funcionesDe(ajustes));
  const [error, setError] = useState('');

  const guardar = useMutation({
    mutationFn: (datos: Funciones) => api.put<EstadoCorreoWebGeneral>(URL_AJUSTES, datos),
    onSuccess: (data) => {
      queryClient.setQueryData(CLAVE, data);
      toast('ok', 'Funciones guardadas. El correo web nuevo las aplica en unos segundos.');
    },
    onError: (err) => setError(mensajeDe(err, 'No se han podido guardar las funciones.')),
  });

  function cambiar<K extends keyof Funciones>(campo: K, valor: Funciones[K]) {
    setError('');
    setCampos((c) => ({ ...c, [campo]: valor }));
  }

  function enviar(e: FormEvent) {
    e.preventDefault();
    const relePush = campos.relePush.trim();
    if (relePush && !esHttps(relePush)) {
      setError('El relé de notificaciones debe ser una dirección que empiece por https://, sin usuario ni contraseña.');
      return;
    }
    setError('');
    guardar.mutate({ ...campos, relePush });
  }

  const sinCambios = JSON.stringify(campos) === JSON.stringify(funcionesDe(ajustes));

  return (
    <form
      onSubmit={enviar}
      noValidate
      className="flex flex-col gap-4 border-t border-regla px-4 py-4"
      aria-labelledby="correo-web-funciones"
    >
      <div>
        <h3 id="correo-web-funciones" className="text-base font-semibold text-tinta">
          Funciones para los usuarios
        </h3>
        <p className="mt-0.5 max-w-[75ch] text-sm text-tinta-3">
          Valen para todos los clientes que usan el correo web nuevo: Bulwark tiene una sola política para todo el
          servidor, no una por cliente.
        </p>
      </div>
      <div className="flex max-w-[75ch] flex-col gap-3">
        <Casilla
          checked={campos.calendario}
          onChange={(v) => cambiar('calendario', v)}
          label="Calendario y tareas"
          help="Los calendarios y las tareas del buzón, los mismos que en el móvil y el ordenador."
        />
        <Casilla
          checked={campos.contactos}
          onChange={(v) => cambiar('contactos', v)}
          label="Contactos"
          help="Las libretas de contactos del buzón, las mismas que en el móvil y el ordenador."
        />
        <Casilla
          checked={campos.archivos}
          onChange={(v) => cambiar('archivos', v)}
          label="Archivos"
          help="Guardar archivos en el servidor desde el correo web. Ocupan el espacio del buzón."
        />
      </div>
      <div className="max-w-xl">
        <Input
          label="Relé de notificaciones"
          type="url"
          mono
          maxLength={2048}
          value={campos.relePush}
          placeholder="https://"
          onChange={(e) => cambiar('relePush', e.target.value)}
          help="Opcional. Entrega las notificaciones del navegador a quien las active. Si se deja vacío, se usa el relé que aloja Bulwark."
        />
      </div>
      {error && <AvisoError>{error}</AvisoError>}
      <div>
        <Button type="submit" variant="perfil" busy={guardar.isPending} disabled={sinCambios}>
          Guardar funciones
        </Button>
      </div>
    </form>
  );
}
