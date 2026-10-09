import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  HUECOS_IMAGEN,
  IMAGENES,
  MAX_IMAGEN_BYTES,
  NOMBRE_MOTOR,
  SE_GANA,
  SE_PIERDE,
  TIPOS_IMAGEN,
  motivoSinBulwark,
  motivoSinServicio,
  resumenImagen,
  type EstadoCorreoWeb,
  type HuecoImagen,
  type ImagenMarca,
  type MarcaCorreoWeb,
  type MotorCorreoWeb,
} from '../lib/correoweb';
import { formatDate } from '../lib/format';
import { mensajeDe } from '../lib/gestion';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';
import { AvisoError, Cargando, Dialogo, Hoja, MarcaFondo } from '../ui/kit';
import { useToast } from '../ui/toast';
import { BandaAviso, Botonera } from './gestion/comun';

/*
  Correo web de un cliente: Roundcube (el predeterminado) o el correo web
  nuevo (Bulwark, beta), y la marca de este último. Va en «Marca blanca»,
  porque solo cambia los webmail propios del cliente: la dirección general
  del webmail sigue siendo Roundcube.
  - La administración elige (con lo que se gana y se pierde) y edita la marca.
  - Un usuario del cliente solo ve la marca, y solo si usa el correo web nuevo.
*/

function claveConsulta(clientId: string) {
  return ['correo-web', clientId];
}

function urlCorreoWeb(clientId: string): string {
  return `/api/clients/${encodeURIComponent(clientId)}/webmail`;
}

export function HojasCorreoWeb({ clientId, isAdmin }: { clientId: string; isAdmin: boolean }) {
  const estado = useQuery({
    queryKey: claveConsulta(clientId),
    queryFn: () => api.get<EstadoCorreoWeb>(urlCorreoWeb(clientId)),
    // Mientras la marca se aplica en segundo plano, se vuelve a mirar; tras un
    // fallo, más despacio (el siguiente intento tarda al menos un minuto).
    refetchInterval: (q) => {
      const s = q.state.data?.sincronizacion;
      if (!s?.pendiente) return false;
      return s.error ? 30_000 : 5000;
    },
  });

  if (estado.isPending) {
    // Al cliente que usa Roundcube no se le enseña nada: tampoco mientras carga.
    if (!isAdmin) return null;
    return (
      <Hoja title="Correo web" className="mb-4">
        <Cargando label="Cargando el correo web del cliente…" />
      </Hoja>
    );
  }
  if (estado.isError || !estado.data) {
    if (!isAdmin) return null;
    return (
      <Hoja title="Correo web" className="mb-4">
        <AvisoError onRetry={() => void estado.refetch()} retrying={estado.isFetching}>
          {mensajeDe(estado.error, 'No se ha podido cargar el correo web del cliente.')}
        </AvisoError>
      </Hoja>
    );
  }

  const datos = estado.data;
  if (!isAdmin && datos.motor !== 'bulwark') return null;
  return (
    <>
      {isAdmin && <HojaEleccion clientId={clientId} estado={datos} />}
      {datos.motor === 'bulwark' && <HojaMarca clientId={clientId} estado={datos} isAdmin={isAdmin} />}
    </>
  );
}

/* -------------------------------- Elección -------------------------------- */

function HojaEleccion({ clientId, estado }: { clientId: string; estado: EstadoCorreoWeb }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmar, setConfirmar] = useState<MotorCorreoWeb | null>(null);
  const [error, setError] = useState('');
  const sinBulwark = motivoSinBulwark(estado);
  const enServicio = estado.webmails.filter((w) => w.status === 'active');

  const cambiar = useMutation({
    mutationFn: (motor: MotorCorreoWeb) => api.put<EstadoCorreoWeb>(urlCorreoWeb(clientId), { motor }),
    onSuccess: async (data) => {
      queryClient.setQueryData(claveConsulta(clientId), data);
      setConfirmar(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['client', clientId] }),
        queryClient.invalidateQueries({ queryKey: ['clients'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] }),
      ]);
      toast(
        'ok',
        data.motor === 'bulwark'
          ? 'El cliente usa ahora el correo web nuevo. Sus webmail cambian en unos segundos.'
          : 'El cliente vuelve a usar Roundcube. Sus webmail cambian en unos segundos.',
      );
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido cambiar el correo web.')),
  });

  function abrir(motor: MotorCorreoWeb) {
    setError('');
    setConfirmar(motor);
  }

  const opciones: { motor: MotorCorreoWeb; descripcion: string; bloqueo: string | null }[] = [
    {
      motor: 'roundcube',
      descripcion: 'El correo web de siempre, en español, con cambio de contraseña, filtros y aviso de ausencia.',
      bloqueo: null,
    },
    {
      motor: 'bulwark',
      descripcion:
        'Interfaz actual con calendario y contactos, aplicación instalable y la marca del cliente. Necesita Stalwart 0.16.',
      bloqueo: estado.motor === 'bulwark' ? null : sinBulwark,
    },
  ];

  return (
    <Hoja title="Correo web" meta="Webmail propios del cliente" className="mb-4" flush>
      {estado.motor === 'bulwark' && estado.enServicio !== 'bulwark' && (
        <div className="px-4 pt-4">
          <BandaAviso>
            El cliente tiene elegido el correo web nuevo, pero sus webmail se sirven ahora con Roundcube.{' '}
            {motivoSinServicio(estado)} Volverán al nuevo en cuanto esté disponible.
          </BandaAviso>
        </div>
      )}
      <ul>
        {opciones.map((opcion) => {
          const elegida = estado.motor === opcion.motor;
          return (
            <li
              key={opcion.motor}
              className="regla-fila flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3.5"
            >
              <div className="min-w-0 max-w-[68ch] flex-1 basis-64">
                <p className="text-base font-medium text-tinta">
                  {NOMBRE_MOTOR[opcion.motor]}
                  {opcion.motor === 'roundcube' && <span className="font-normal text-tinta-3"> · predeterminado</span>}
                </p>
                <p className="text-sm text-tinta-2">{opcion.descripcion}</p>
                {!elegida && opcion.bloqueo && <p className="mt-1 text-sm text-tinta-3">{opcion.bloqueo}</p>}
              </div>
              <div className="shrink-0">
                {elegida ? (
                  <MarcaFondo veredicto="normal">En uso</MarcaFondo>
                ) : (
                  <Button
                    variant="perfil"
                    disabled={Boolean(opcion.bloqueo)}
                    onClick={() => abrir(opcion.motor)}
                  >
                    {opcion.motor === 'bulwark' ? 'Usar el correo web nuevo' : 'Volver a Roundcube'}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-3 px-4 py-3.5">
        <details className="group max-w-[75ch]">
          <summary className="cursor-pointer text-sm font-medium text-petroleo hover:text-tinta">
            Qué cambia con el correo web nuevo
          </summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <ListaCambios titulo="Se gana" elementos={SE_GANA} />
            <ListaCambios titulo="Se pierde" elementos={SE_PIERDE} />
          </div>
        </details>
        <p className="max-w-[75ch] text-sm text-tinta-3">
          {enServicio.length === 0
            ? 'El cliente aún no tiene ningún webmail propio en servicio: lo elegido se aplicará cuando lo tenga. La dirección general del webmail sigue siendo Roundcube.'
            : `Se aplica a ${enServicio.map((w) => w.hostname).join(', ')}. La dirección general del webmail sigue siendo Roundcube.`}
        </p>
      </div>

      <Dialogo
        open={confirmar !== null}
        onClose={() => setConfirmar(null)}
        title={confirmar === 'bulwark' ? 'Usar el correo web nuevo' : 'Volver a Roundcube'}
        pie={
          <Botonera>
            <Button variant="plano" onClick={() => setConfirmar(null)}>
              Cancelar
            </Button>
            <Button
              variant="principal"
              busy={cambiar.isPending}
              onClick={() => confirmar && cambiar.mutate(confirmar)}
            >
              {confirmar === 'bulwark' ? 'Usar el correo web nuevo' : 'Volver a Roundcube'}
            </Button>
          </Botonera>
        }
      >
        <div className="flex flex-col gap-3 text-base text-tinta-2">
          {confirmar === 'bulwark' ? (
            <>
              <p>
                Los webmail propios del cliente abrirán el correo web nuevo en unos segundos y quien lo tenga abierto
                tendrá que volver a entrar. El correo, el calendario y los contactos siguen en el servidor.
              </p>
              <p>
                Si es el primer cliente que lo usa, se aplican también los ajustes recomendados del servidor de
                correo, que le abren el acceso desde el navegador (CORS): puede tardar hasta un minuto y medio.
              </p>
              <ListaCambios titulo="Se pierde" elementos={SE_PIERDE} />
            </>
          ) : (
            <p>
              Los webmail propios del cliente volverán a abrir Roundcube en unos segundos. Las libretas, identidades
              y firmas creadas en el correo web nuevo no pasan a Roundcube; el correo, el calendario y los contactos
              siguen en el servidor.
            </p>
          )}
          {error && <AvisoError>{error}</AvisoError>}
        </div>
      </Dialogo>
    </Hoja>
  );
}

function ListaCambios({ titulo, elementos }: { titulo: string; elementos: string[] }) {
  return (
    <div className="min-w-0">
      <p className="rotulo">{titulo}</p>
      <ul className="mt-1 list-disc pl-5 text-sm text-tinta-2">
        {elementos.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------- Marca ---------------------------------- */

type CamposMarca = Pick<MarcaCorreoWeb, 'nombre' | 'nombreCorto' | 'empresa' | 'privacidadUrl' | 'avisoLegalUrl'>;

function camposDe(marca: MarcaCorreoWeb): CamposMarca {
  return {
    nombre: marca.nombre,
    nombreCorto: marca.nombreCorto,
    empresa: marca.empresa,
    privacidadUrl: marca.privacidadUrl,
    avisoLegalUrl: marca.avisoLegalUrl,
  };
}

function esHttps(valor: string): boolean {
  try {
    const url = new URL(valor);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function HojaMarca({ clientId, estado, isAdmin }: { clientId: string; estado: EstadoCorreoWeb; isAdmin: boolean }) {
  const marca = estado.marca;
  const sincronizacion = estado.sincronizacion;

  return (
    <Hoja
      title="Marca del correo web nuevo"
      meta={
        isAdmin && sincronizacion
          ? sincronizacion.error
            ? 'Pendiente de aplicar'
            : sincronizacion.pendiente
              ? 'Aplicándose…'
              : sincronizacion.aplicadaEn
                ? `Aplicada ${formatDate(sincronizacion.aplicadaEn)}`
                : undefined
          : undefined
      }
      className="mb-4"
    >
      <div className="flex flex-col gap-5">
        {isAdmin && sincronizacion?.error && (
          <BandaAviso>
            No se ha podido aplicar la marca en el correo web. {sincronizacion.error.mensaje}{' '}
            {sincronizacion.reintentarDesde
              ? `Se reintenta solo a partir de ${formatDate(sincronizacion.reintentarDesde)}.`
              : 'Se reintenta solo.'}
          </BandaAviso>
        )}
        {!isAdmin && (
          <p className="max-w-[75ch] text-base text-tinta-2">
            Tu correo web es el nuevo (beta): su pantalla de acceso y su barra muestran esta marca en tus webmail
            propios.
          </p>
        )}
        {!isAdmin && estado.enServicio !== 'bulwark' && (
          <BandaAviso>Ahora mismo tu correo web se sirve con Roundcube. La marca se verá en cuanto vuelva el nuevo.</BandaAviso>
        )}

        {/* Se vuelve a montar cuando la marca guardada cambia (al guardar o
            desde otra pestaña): el formulario parte siempre de lo guardado. */}
        <FormularioMarca key={marca.actualizada ?? 0} clientId={clientId} marca={marca} />

        <div>
          <p className="rotulo">Imágenes</p>
          <p className="mt-0.5 max-w-[75ch] text-sm text-tinta-3">
            PNG, JPEG o WebP de hasta 512 KB y entre 16 y 4096 píxeles por lado. Los SVG no se admiten: en el
            correo web serían código, no una imagen.
          </p>
          <ul className="mt-2 overflow-hidden rounded-lg border border-regla">
            {HUECOS_IMAGEN.map((hueco) => (
              <FilaImagen key={hueco} clientId={clientId} hueco={hueco} imagen={marca.imagenes[hueco]} />
            ))}
          </ul>
        </div>
      </div>
    </Hoja>
  );
}

function FormularioMarca({ clientId, marca }: { clientId: string; marca: MarcaCorreoWeb }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [campos, setCampos] = useState<CamposMarca>(() => camposDe(marca));
  const [error, setError] = useState('');

  const guardar = useMutation({
    mutationFn: () => api.patch<{ marca: MarcaCorreoWeb }>(`${urlCorreoWeb(clientId)}/marca`, campos),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: claveConsulta(clientId) });
      toast('ok', 'Marca guardada. El correo web la muestra en unos segundos.');
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido guardar la marca.')),
  });

  function cambiar(campo: keyof CamposMarca, valor: string) {
    setError('');
    setCampos((c) => ({ ...c, [campo]: valor }));
  }

  function enviar(e: FormEvent) {
    e.preventDefault();
    for (const [campo, texto] of [
      ['privacidadUrl', 'La política de privacidad'],
      ['avisoLegalUrl', 'El aviso legal'],
    ] as const) {
      const valor = campos[campo].trim();
      if (valor && !esHttps(valor)) {
        setError(`${texto} debe ser una dirección que empiece por https://.`);
        return;
      }
    }
    setError('');
    guardar.mutate();
  }

  const sinCambios = JSON.stringify(campos) === JSON.stringify(camposDe(marca));

  return (
    <form onSubmit={enviar} noValidate className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Input
          label="Nombre del correo web"
          maxLength={60}
          value={campos.nombre}
          placeholder={marca.nombrePorDefecto}
          onChange={(e) => cambiar('nombre', e.target.value)}
          help={`Título de la pestaña y de la pantalla de acceso. Vacío: «${marca.nombrePorDefecto}».`}
        />
        <Input
          label="Nombre corto"
          maxLength={30}
          value={campos.nombreCorto}
          onChange={(e) => cambiar('nombreCorto', e.target.value)}
          help="Opcional. El de la aplicación instalada en el móvil o el ordenador."
        />
        <Input
          label="Empresa"
          maxLength={80}
          value={campos.empresa}
          onChange={(e) => cambiar('empresa', e.target.value)}
          help="Opcional. Firma la pantalla de acceso."
        />
        <Input
          label="Política de privacidad"
          type="url"
          mono
          maxLength={2048}
          value={campos.privacidadUrl}
          placeholder="https://"
          onChange={(e) => cambiar('privacidadUrl', e.target.value)}
          help="Opcional. Enlace al pie de la pantalla de acceso."
        />
        <Input
          label="Aviso legal"
          type="url"
          mono
          maxLength={2048}
          value={campos.avisoLegalUrl}
          placeholder="https://"
          onChange={(e) => cambiar('avisoLegalUrl', e.target.value)}
          help="Opcional. Enlace al pie de la pantalla de acceso."
        />
      </div>
      {error && <AvisoError>{error}</AvisoError>}
      <div>
        <Button type="submit" variant="principal" busy={guardar.isPending} disabled={sinCambios}>
          Guardar la marca
        </Button>
      </div>
    </form>
  );
}

function leerComoDataUrl(archivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(String(lector.result));
    lector.onerror = () => reject(new Error('No se ha podido leer el archivo.'));
    lector.readAsDataURL(archivo);
  });
}

function FilaImagen({ clientId, hueco, imagen }: { clientId: string; hueco: HuecoImagen; imagen: ImagenMarca | null }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const entrada = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const info = IMAGENES[hueco];
  const url = `${urlCorreoWeb(clientId)}/marca/imagenes/${hueco}`;

  const refrescar = () => queryClient.invalidateQueries({ queryKey: claveConsulta(clientId) });

  const subir = useMutation({
    mutationFn: async (archivo: File) => api.put<{ imagen: ImagenMarca }>(url, { imagen: await leerComoDataUrl(archivo) }),
    onSuccess: async () => {
      await refrescar();
      toast('ok', `${info.titulo}: imagen guardada. El correo web la muestra en unos segundos.`);
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido subir la imagen.')),
  });

  const quitar = useMutation({
    mutationFn: () => api.delete(url),
    onSuccess: async () => {
      await refrescar();
      toast('ok', `${info.titulo}: imagen retirada.`);
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido quitar la imagen.')),
  });

  function elegido(e: ChangeEvent<HTMLInputElement>) {
    const archivo = e.target.files?.[0];
    // Se vacía para poder elegir otra vez el mismo archivo tras un error.
    e.target.value = '';
    if (!archivo) return;
    setError('');
    if (archivo.type && !TIPOS_IMAGEN.includes(archivo.type)) {
      setError('Elige una imagen PNG, JPEG o WebP. Los SVG no se admiten.');
      return;
    }
    if (archivo.size > MAX_IMAGEN_BYTES) {
      setError('La imagen ocupa más de 512 KB. Elige una más ligera.');
      return;
    }
    subir.mutate(archivo);
  }

  return (
    <li className="regla-fila flex flex-wrap items-center gap-x-4 gap-y-3 px-3 py-3 last:border-b-0">
      <div
        className={`flex h-14 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-regla ${
          info.fondoOscuro ? 'bg-tinta' : 'bg-hoja-2'
        }`}
      >
        {imagen ? (
          <img src={imagen.url} alt={`${info.titulo} actual`} className="max-h-12 max-w-[88px] object-contain" />
        ) : (
          <span className="text-sm text-tinta-3">Sin imagen</span>
        )}
      </div>
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-base text-tinta">{info.titulo}</p>
        <p className="text-sm text-tinta-3">{info.ayuda}</p>
        {imagen && <p className="valor text-sm text-tinta-2">{resumenImagen(imagen)}</p>}
        {error && <p className="mt-1 text-sm text-fuera">{error}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <input
          ref={entrada}
          type="file"
          accept={TIPOS_IMAGEN.join(',')}
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={elegido}
        />
        <Button variant="perfil" busy={subir.isPending} onClick={() => entrada.current?.click()}>
          {imagen ? 'Cambiar' : 'Subir imagen'}
        </Button>
        {imagen && (
          <Button variant="plano" busy={quitar.isPending} onClick={() => quitar.mutate()}>
            Quitar
          </Button>
        )}
      </div>
    </li>
  );
}
