import { useState, type FormEvent, type ReactNode } from 'react';
import { FingerprintPattern } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { formatDate, formatDay, plural } from '../lib/format';
import {
  claveLlaves,
  eliminarLlave,
  llavesDisponibles,
  MAX_LLAVES,
  mensajeErrorLlave,
  motivoSinLlaves,
  registrarLlave,
  renombrarLlave,
  type BaseLlaves,
  type ListaLlaves,
  type Llave,
} from '../lib/llaves';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';
import { AvisoError, Cargando, Dialogo, Hoja, Vacio } from '../ui/kit';
import { useToast } from '../ui/toast';
import { TACTIL } from '../pages/portal/comun';

/*
  Llaves de acceso de la sesión abierta: las del usuario del panel
  (`/api/auth`) o las del titular del buzón en «Mi buzón» (`/api/portal`).
  Misma tarjeta en los dos sitios; en el portal, con controles táctiles.
*/

/**
 * Tarjeta «Llaves de acceso»: lista, alta con nombre opcional, cambio de
 * nombre en la propia fila y eliminación con confirmación.
 */
export function HojaLlavesAcceso({
  base,
  tactil = false,
  nota,
  notaEliminar,
}: {
  base: BaseLlaves;
  /** Controles de 44 px en el móvil (portal del titular). */
  tactil?: boolean;
  /** Contexto propio del área, debajo de la explicación (p. ej. el webmail en «Mi buzón»). */
  nota?: (lista: ListaLlaves) => ReactNode;
  /** Frase añadida a la confirmación de eliminar. */
  notaEliminar?: string;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  // El soporte del navegador no cambia mientras la página está abierta.
  const [disponible] = useState(llavesDisponibles);
  const [nombre, setNombre] = useState('');
  const [editando, setEditando] = useState<string | null>(null);
  const [aEliminar, setAEliminar] = useState<Llave | null>(null);
  const alto = tactil ? TACTIL : '';
  const clave = claveLlaves(base);

  const lista = useQuery({
    queryKey: clave,
    queryFn: () => api.get<ListaLlaves>(`${base}/llaves`),
  });

  const anadir = useMutation({
    mutationFn: () => registrarLlave(base, nombre),
    onSuccess: async (llave) => {
      setNombre('');
      toast('ok', `Se ha añadido la llave de acceso «${llave.nombre}».`);
      await queryClient.invalidateQueries({ queryKey: clave });
    },
  });

  const eliminar = useMutation({
    mutationFn: (llave: Llave) => eliminarLlave(base, llave.id),
    onSuccess: async (_data, llave) => {
      setAEliminar(null);
      if (editando === llave.id) setEditando(null);
      toast('ok', `Se ha eliminado la llave de acceso «${llave.nombre}».`);
      await queryClient.invalidateQueries({ queryKey: clave });
    },
    onError: (err) => {
      setAEliminar(null);
      toast('error', err instanceof ApiError ? err.message : 'No se ha podido eliminar la llave de acceso.');
    },
  });

  function enviarAlta(e: FormEvent) {
    e.preventDefault();
    anadir.mutate();
  }

  const llaves = lista.data?.llaves ?? [];
  const hostActual = lista.data?.hostActual ?? '';
  const alLimite = llaves.length >= MAX_LLAVES;

  return (
    <Hoja
      title="Llaves de acceso"
      meta={lista.isSuccess && llaves.length > 0 ? plural(llaves.length, 'llave', 'llaves') : undefined}
      flush
    >
      <div className="flex flex-col gap-4 p-4">
        <p className="max-w-[70ch] text-base text-tinta-2">
          Entra con la huella, la cara o el PIN de tu dispositivo, sin escribir la contraseña. Cada llave funciona solo en
          la dirección desde la que se añade
          {hostActual ? (
            <>
              ; ahora estás en <span className="font-medium text-tinta [overflow-wrap:anywhere]">{hostActual}</span>.
            </>
          ) : (
            '.'
          )}
        </p>
        {lista.isSuccess && nota?.(lista.data)}

        {!disponible ? (
          <p className="max-w-[70ch] text-sm text-tinta-2">{motivoSinLlaves()}</p>
        ) : alLimite ? (
          <p className="max-w-[70ch] text-sm text-tinta-2">
            Has llegado al máximo de {MAX_LLAVES} llaves de acceso. Elimina una para añadir otra.
          </p>
        ) : (
          <form onSubmit={enviarAlta} noValidate className="flex flex-col gap-2">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="min-w-0 grow">
                <Input
                  label="Nombre (opcional)"
                  placeholder="Por ejemplo: Portátil del trabajo"
                  maxLength={60}
                  value={nombre}
                  onChange={(e) => {
                    anadir.reset();
                    setNombre(e.target.value);
                  }}
                  className={alto}
                />
              </div>
              <Button type="submit" variant="perfil" busy={anadir.isPending} className={`shrink-0 ${alto}`}>
                Añadir llave de acceso
              </Button>
            </div>
            <p className="text-sm text-tinta-3">
              Si no le pones nombre, se llamará como el gestor de contraseñas en el que la guardes.
            </p>
          </form>
        )}
        {anadir.isError && <AvisoError>{mensajeErrorLlave(anadir.error, 'registrar')}</AvisoError>}
      </div>

      {lista.isPending ? (
        <Cargando label="Cargando las llaves de acceso…" />
      ) : lista.isError ? (
        <div className="px-4 pb-4">
          <AvisoError onRetry={() => void lista.refetch()} retrying={lista.isFetching}>
            {lista.error instanceof ApiError
              ? lista.error.message
              : 'No se han podido cargar las llaves de acceso. Comprueba la conexión.'}
          </AvisoError>
        </div>
      ) : llaves.length === 0 ? (
        <div className="border-t border-regla">
          <Vacio icono={FingerprintPattern} title="Aún no hay llaves de acceso">
            Una llave de acceso se guarda en tu gestor de contraseñas o en el propio dispositivo y sustituye a la
            contraseña; funcionan Proton Pass, 1Password, Bitwarden, iCloud, Google o Windows Hello.
          </Vacio>
        </div>
      ) : (
        // La tabla decide su forma por el ancho de su tarjeta (consulta de
        // contenedor), no por el de la ventana: en «Mi cuenta» la columna es
        // estrecha aunque la pantalla sea ancha.
        <div className="border-t border-regla [container-type:inline-size]">
          <div className="regla-cabecera hidden items-baseline gap-x-4 bg-hoja-2 px-4 py-2 [@container(min-width:40rem)]:flex">
            <span className="rotulo min-w-0 grow basis-0">Llave</span>
            <span className="rotulo shrink-0 basis-24">Creada</span>
            <span className="rotulo shrink-0 basis-32">Último uso</span>
            <span className="rotulo shrink-0 basis-44 text-right">Acción</span>
          </div>
          <ul>
            {llaves.map((llave) =>
              editando === llave.id ? (
                <FilaRenombrar
                  key={llave.id}
                  base={base}
                  llave={llave}
                  alto={alto}
                  onTerminar={() => setEditando(null)}
                />
              ) : (
                <FilaLlave
                  key={llave.id}
                  llave={llave}
                  hostActual={hostActual}
                  alto={alto}
                  onRenombrar={() => setEditando(llave.id)}
                  onEliminar={() => {
                    eliminar.reset();
                    setAEliminar(llave);
                  }}
                />
              ),
            )}
          </ul>
        </div>
      )}

      <Dialogo open={aEliminar !== null} onClose={() => setAEliminar(null)} title="Eliminar llave de acceso">
        {aEliminar && (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2 [overflow-wrap:anywhere]">
              La llave «{aEliminar.nombre}» dejará de servir para entrar.{notaEliminar ? ` ${notaEliminar}` : ''} Si
              sigue guardada en tu gestor de contraseñas, bórrala también allí para que no te la vuelva a ofrecer.
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="plano" className={alto} onClick={() => setAEliminar(null)}>
                Cancelar
              </Button>
              <Button
                variant="peligro"
                className={alto}
                busy={eliminar.isPending}
                onClick={() => eliminar.mutate(aEliminar)}
              >
                Eliminar
              </Button>
            </div>
          </div>
        )}
      </Dialogo>
    </Hoja>
  );
}

/* ------------------------------ Fila de la tabla -------------------------- */

function FilaLlave({
  llave,
  hostActual,
  alto,
  onRenombrar,
  onEliminar,
}: {
  llave: Llave;
  hostActual: string;
  alto: string;
  onRenombrar: () => void;
  onEliminar: () => void;
}) {
  // El nombre por defecto ya es el del gestor: no se repite debajo.
  const proveedor = llave.proveedor && llave.proveedor !== llave.nombre ? llave.proveedor : null;
  const enOtraDireccion = hostActual !== '' && llave.host.toLowerCase() !== hostActual.toLowerCase();
  return (
    <li className="regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-1.5 px-4 py-3 last:border-b-0">
      {/* El nombre identifica la fila: línea propia en el móvil, nunca recortado. */}
      <div className="min-w-0 basis-full [@container(min-width:40rem)]:basis-0 [@container(min-width:40rem)]:grow">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 break-words text-base font-medium text-tinta">{llave.nombre}</p>
          {llave.sincronizada && (
            <span
              className="inline-flex items-center whitespace-nowrap rounded-md bg-hoja-3 px-2 py-0.5 text-sm font-medium text-tinta-2"
              title="El gestor de contraseñas la copia en tus otros dispositivos."
            >
              Sincronizada
            </span>
          )}
        </div>
        {proveedor && <p className="mt-0.5 break-words text-sm text-tinta-2">{proveedor}</p>}
        <p className="mt-0.5 text-sm text-tinta-3 [overflow-wrap:anywhere]">
          Funciona en <span className="text-tinta-2">{llave.host}</span>
          {enOtraDireccion && ' (no en esta dirección)'}
        </p>
      </div>
      <span className="shrink-0 text-sm text-tinta-2 [@container(min-width:40rem)]:basis-24">
        <span className="rotulo mr-1.5 [@container(min-width:40rem)]:hidden">Creada</span>
        <span className="valor">{formatDay(llave.creadaEn)}</span>
      </span>
      <span className="shrink-0 text-sm text-tinta-2 [@container(min-width:40rem)]:basis-32">
        <span className="rotulo mr-1.5 [@container(min-width:40rem)]:hidden">Último uso</span>
        {llave.ultimoUso ? (
          <span className="valor">{formatDate(llave.ultimoUso)}</span>
        ) : (
          <span className="text-tinta-3">Sin uso</span>
        )}
      </span>
      <span className="ml-auto flex shrink-0 justify-end gap-1 [@container(min-width:40rem)]:basis-44">
        <Button variant="plano" className={`!px-2.5 ${alto}`} onClick={onRenombrar}>
          Renombrar
        </Button>
        <Button variant="plano" className={`!px-2.5 ${alto}`} onClick={onEliminar}>
          Eliminar
        </Button>
      </span>
    </li>
  );
}

/** La fila en edición: el nombre pasa a ser un campo con «Guardar» y «Cancelar». */
function FilaRenombrar({
  base,
  llave,
  alto,
  onTerminar,
}: {
  base: BaseLlaves;
  llave: Llave;
  alto: string;
  onTerminar: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [valor, setValor] = useState(llave.nombre);
  const [error, setError] = useState('');

  const renombrar = useMutation({
    mutationFn: (nombre: string) => renombrarLlave(base, llave.id, nombre),
    onSuccess: async () => {
      toast('ok', 'Se ha cambiado el nombre de la llave de acceso.');
      await queryClient.invalidateQueries({ queryKey: claveLlaves(base) });
      onTerminar();
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'No se ha podido cambiar el nombre. Vuelve a intentarlo.'),
  });

  const limpio = valor.trim();

  function enviar(e: FormEvent) {
    e.preventDefault();
    if (!limpio) {
      setError('Escribe un nombre para la llave.');
      return;
    }
    if (limpio === llave.nombre) {
      onTerminar();
      return;
    }
    renombrar.mutate(limpio);
  }

  return (
    <li className="regla-fila px-4 py-3 last:border-b-0">
      <form onSubmit={enviar} noValidate className="flex flex-col gap-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 grow">
            <Input
              label="Nombre de la llave"
              autoFocus
              maxLength={60}
              value={valor}
              error={error || undefined}
              onChange={(e) => {
                setError('');
                setValor(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  onTerminar();
                }
              }}
              className={alto}
            />
          </div>
          <div className="flex shrink-0 gap-2 sm:pb-0">
            <Button type="button" variant="plano" className={alto} onClick={onTerminar}>
              Cancelar
            </Button>
            <Button type="submit" variant="perfil" busy={renombrar.isPending} className={alto}>
              Guardar
            </Button>
          </div>
        </div>
        <p className="text-sm text-tinta-3 [overflow-wrap:anywhere]">Funciona en {llave.host}</p>
      </form>
    </li>
  );
}

/* --------------------------- Entrar con una llave -------------------------- */

/**
 * Alternativa a la contraseña en las pantallas de acceso: una «o» discreta y
 * el botón «Entrar con llave de acceso». No aparece si el navegador no admite
 * llaves. `onEntrar` hace la operación completa y lanza el error si falla.
 */
export function EntrarConLlave({
  onEntrar,
  onEmpezar,
  className = '',
}: {
  onEntrar: () => Promise<void>;
  /** Al pulsar: la pantalla puede retirar el error del formulario de contraseña. */
  onEmpezar?: () => void;
  className?: string;
}) {
  const [disponible] = useState(llavesDisponibles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!disponible) return null;

  async function entrar() {
    onEmpezar?.();
    setBusy(true);
    setError('');
    try {
      await onEntrar();
    } catch (err) {
      setError(mensajeErrorLlave(err, 'entrar'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      <div aria-hidden className="flex items-center gap-3 text-sm text-tinta-3">
        <span className="h-px flex-1 bg-regla" />o<span className="h-px flex-1 bg-regla" />
      </div>
      {/* type="button": puede ir dentro del formulario de la contraseña sin enviarlo. */}
      <Button type="button" variant="perfil" busy={busy} onClick={() => void entrar()} className={`w-full ${TACTIL}`}>
        {!busy && <FingerprintPattern className="h-4 w-4" aria-hidden />}
        Entrar con llave de acceso
      </Button>
      {error && <AvisoError>{error}</AvisoError>}
    </div>
  );
}
