import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import {
  esDispositivoMovil,
  esUsadoPorApp,
  fechaLarga,
  mensajeError,
  TEXTO_USADO_POR_APP,
  type RespuestaActualizarUsuario,
  type SetupPublico,
} from '../../lib/portal';
import { QR } from '../../components/QR';
import { Button } from '../../ui/Button';
import { Dialogo, Hoja, Cargando, Muestra } from '../../ui/kit';
import { BotonWebmail, GuiasDispositivo } from './GuiasDispositivo';
import { HojaPerfil } from './Perfil';
import {
  AvisoError,
  AvisoHecho,
  BotonCopiarTactil,
  MarcoPortal,
  Nota,
  PaginaEstado,
  TACTIL,
  claseEnlaceBoton,
} from './comun';

/**
 * Página del enlace de configuración (/conectar/:token). La abre el titular
 * del buzón, normalmente en el móvil y sin cuenta en ningún sitio: todo lo
 * que necesita para configurar su correo está aquí, en el orden en que lo va
 * a usar (contraseña, instrucciones de su dispositivo, alternativas).
 */
export default function ConectarPagina() {
  const { token = '' } = useParams();
  const queryClient = useQueryClient();
  const clave = ['setup-publico', token];
  const consulta = useQuery({
    queryKey: clave,
    queryFn: () => api.get<SetupPublico>(`/api/public/setup/${encodeURIComponent(token)}`),
    // Un 404 (caducado, revocado) no mejora reintentando.
    retry: false,
    staleTime: Infinity,
  });
  const [confirmado, setConfirmado] = useState(false);
  const [preguntando, setPreguntando] = useState(false);
  const hecho = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>(`/api/public/setup/${encodeURIComponent(token)}/done`),
    onSuccess: () => {
      setConfirmado(true);
      setPreguntando(false);
      // La contraseña ya no está en el servidor: tampoco debe quedar en pantalla.
      queryClient.setQueryData<SetupPublico>(clave, (prev) =>
        prev ? { ...prev, password: undefined, hasPassword: false } : prev,
      );
    },
  });

  // Tras un cambio de dominio: «Actualizar y continuar» cambia el usuario a la
  // dirección nueva y lleva a las guías, que ya lo muestran.
  const [actualizado, setActualizado] = useState<string | null>(null);
  const guiasRef = useRef<HTMLDivElement>(null);
  const actualizar = useMutation({
    mutationFn: () =>
      api.post<RespuestaActualizarUsuario>(`/api/public/setup/${encodeURIComponent(token)}/login-update`, {}),
    onSuccess: async (data) => {
      // Se relee el enlace: el perfil de Apple, el QR y los datos manuales
      // llevan ya el usuario nuevo.
      await queryClient.invalidateQueries({ queryKey: clave });
      setActualizado(data.login);
      guiasRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  });

  useEffect(() => {
    document.title = 'Configurar tu correo';
  }, []);

  if (consulta.isPending) {
    return (
      <PaginaEstado>
        <Cargando label="Cargando la configuración…" />
      </PaginaEstado>
    );
  }

  if (consulta.isError) {
    const err = consulta.error;
    const caducado = err instanceof ApiError && err.status === 404;
    const suspendido = err instanceof ApiError && err.status === 403;
    // Caducado o suspendido no se arregla reintentando: no se ofrece.
    const definitivo = caducado || suspendido;
    return (
      <PaginaEstado>
        <div className="flex flex-col gap-3 px-5 py-6">
          <h1 className="text-xl font-semibold text-tinta">
            {caducado ? 'Enlace no disponible' : suspendido ? 'Buzón suspendido' : 'No se ha podido cargar la página'}
          </h1>
          <p className="text-base text-tinta-2">
            {caducado
              ? mensajeError(err, 'Este enlace de configuración no es válido o ha caducado.')
              : mensajeError(err, 'Comprueba la conexión a Internet y vuelve a intentarlo.')}
          </p>
          {!definitivo && (
            <Button variant="principal" className={TACTIL} onClick={() => void consulta.refetch()}>
              Volver a intentarlo
            </Button>
          )}
          <Nota>
            Si ya tienes la contraseña de tu buzón, también puedes acceder a{' '}
            <a href="/mi-buzon" className="text-petroleo underline hover:text-tinta">
              «Mi buzón»
            </a>{' '}
            para configurar tus dispositivos.
          </Nota>
        </div>
      </PaginaEstado>
    );
  }

  const datos = consulta.data;
  const movil = esDispositivoMovil();
  // El usuario que funciona ahora: el anterior mientras no se actualice.
  const usuario = datos.connection.username || datos.login || datos.email;
  // Con una aplicación que envía con el buzón, el titular no puede actualizar
  // (lo hace Skyway): no se ofrece el botón. El enlace no siempre lo dice de
  // antemano; si no, se sabe al pulsar.
  const usadoPorApp = Boolean(datos.usadoPorApp) || (actualizar.isError && esUsadoPorApp(actualizar.error));
  const notaContrasena = datos.password
    ? 'La indicada en el apartado «Contraseña del buzón».'
    : 'La contraseña del buzón que te ha facilitado la persona que administra tu correo.';

  return (
    <MarcoPortal
      marca={datos.brandName}
      titulo="Configurar tu correo"
      meta={
        <>
          <p className="break-all font-medium text-tinta">{datos.email}</p>
          <p className="mt-1">
            Sigue los pasos para tu dispositivo. Este enlace es válido hasta el {fechaLarga(datos.expiresAt)}.
          </p>
        </>
      }
    >
      {datos.loginPending && !actualizado && usadoPorApp && (
        <Hoja
          title={
            <h2 className="text-md font-semibold text-tinta [overflow-wrap:anywhere]">
              Tu dirección ahora es {datos.email}
            </h2>
          }
        >
          <div className="flex flex-col gap-3">
            <p className="max-w-[70ch] text-base text-tinta-2">Ya recibes el correo en las dos direcciones.</p>
            <Nota>{TEXTO_USADO_POR_APP}</Nota>
          </div>
        </Hoja>
      )}
      {datos.loginPending && !actualizado && !usadoPorApp && (
        <Hoja
          title={
            <h2 className="text-md font-semibold text-tinta [overflow-wrap:anywhere]">
              Antes de configurar, actualiza tu usuario a {datos.email}
            </h2>
          }
        >
          <div className="flex flex-col gap-3">
            <p className="max-w-[70ch] text-base text-tinta-2 [overflow-wrap:anywhere]">
              Los dispositivos que sigan configurados con {datos.login || usuario} dejarán de conectar hasta que los
              actualices.
            </p>
            {actualizar.isError && (
              <AvisoError>{mensajeError(actualizar.error, 'No se ha podido actualizar el usuario.')}</AvisoError>
            )}
            <Button
              variant="principal"
              className={`${TACTIL} self-stretch sm:self-start`}
              busy={actualizar.isPending}
              onClick={() => actualizar.mutate()}
            >
              Actualizar y continuar
            </Button>
          </div>
        </Hoja>
      )}
      {actualizado && <AvisoHecho>Listo. Ahora entras con {actualizado}.</AvisoHecho>}

      {datos.password ? (
        <Hoja title="Contraseña del buzón">
          <div className="flex flex-col gap-3">
            <ContrasenaRevelable password={datos.password} />
            <Nota>
              Necesitarás esta contraseña si configuras el correo manualmente. Por seguridad, se eliminará de este
              enlace cuando indiques que has terminado (al final de esta página) o cuando el enlace caduque; si quieres
              conservarla, guárdala en un lugar seguro.
            </Nota>
          </div>
        </Hoja>
      ) : confirmado ? (
        <AvisoHecho>
          Se ha eliminado la contraseña de este enlace. Puedes seguir consultando las instrucciones para otros
          dispositivos.
        </AvisoHecho>
      ) : (
        // Sin contraseña (el enlace no la incluía, o el titular ya la cambió):
        // se dice cuál usar en lugar de dejar el campo en blanco sin explicación.
        <Hoja title="Contraseña del buzón">
          <Nota>
            Este enlace no incluye la contraseña del buzón. Utiliza la contraseña actual de tu buzón; si no la
            conoces, solicítala a la persona que administra tu correo.
          </Nota>
        </Hoja>
      )}

      {/* Antes de los dispositivos: el perfil de Apple y el QR de Thunderbird
          llevan el nombre guardado. Es opcional y no bloquea nada de lo demás. */}
      <HojaPerfil
        displayName={datos.displayName}
        fotoUrl={datos.photoUrl}
        urlPerfil={`/api/public/setup/${encodeURIComponent(token)}/profile`}
        urlFoto={`/api/public/setup/${encodeURIComponent(token)}/photo`}
        explicacion={
          <p>
            Así te verán quienes reciban tus correos. Indica tu nombre antes de configurar tus dispositivos para que
            lo incluyan. Es opcional y puedes cambiarlo más adelante en «Mi buzón».
          </p>
        }
        onCambio={() => queryClient.invalidateQueries({ queryKey: clave })}
      />

      <div ref={guiasRef} className="scroll-mt-4">
        <Hoja title="Elige tu dispositivo">
          <GuiasDispositivo
            email={datos.email}
            usuario={usuario}
            conexion={datos.connection}
            appleProfileUrl={datos.appleProfileUrl}
            perfilPublico
            perfilIncluyeContrasena={Boolean(datos.password)}
            thunderbirdAndroidQr={datos.thunderbirdAndroidQr}
            notaContrasena={notaContrasena}
          />
        </Hoja>
      </div>

      {!movil && (
        <Hoja title="Abrir en el móvil">
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <QR texto={window.location.href} etiqueta="Código QR para abrir esta página en el móvil" />
            <div className="flex flex-col gap-2">
              <p className="max-w-[60ch] text-base text-tinta">
                Para configurar el móvil, escanea este código con tu cámara: se abrirá esta misma página.
              </p>
              <Nota>En el iPhone, ábrela en Safari para poder instalar el perfil.</Nota>
            </div>
          </div>
        </Hoja>
      )}

      <Hoja title="Correo web">
        <div className="flex flex-col gap-3">
          <p className="max-w-[70ch] text-base text-tinta-2">
            También puedes leer y enviar correo desde el navegador, sin configurar nada, con tu dirección y tu
            contraseña.
          </p>
          <BotonWebmail url={datos.connection.webmailUrl} />
        </div>
      </Hoja>

      <Hoja title="Mi buzón">
        <div className="flex flex-col gap-3">
          <p className="max-w-[70ch] text-base text-tinta-2">
            En «Mi buzón» puedes cambiar la contraseña y crear una contraseña distinta para cada dispositivo, de modo que
            perder el móvil no obligue a cambiar la de todos los demás.
          </p>
          <a href={datos.portalUrl || '/mi-buzon'} className={`${claseEnlaceBoton('perfil')} self-stretch sm:self-start`}>
            Acceder a «Mi buzón»
          </a>
        </div>
      </Hoja>

      {/* Al final, cuando ya se han seguido las instrucciones: pulsarlo antes
          de configurar dejaba al titular sin la contraseña a mitad de camino. */}
      {datos.password && (
        <Hoja title="¿Has terminado?">
          <div className="flex flex-col gap-3">
            <p className="max-w-[70ch] text-base text-tinta-2">
              Cuando el correo funcione en tus dispositivos, indícalo para eliminar la contraseña de este enlace.
              Las instrucciones seguirán disponibles.
            </p>
            <Button
              variant="perfil"
              className={`${TACTIL} self-stretch sm:self-start`}
              onClick={() => {
                hecho.reset();
                setPreguntando(true);
              }}
            >
              Ya lo he configurado
            </Button>
          </div>
        </Hoja>
      )}

      <Dialogo open={preguntando} onClose={() => setPreguntando(false)} title="Eliminar la contraseña del enlace">
        <div className="flex flex-col gap-4">
          <p className="text-base text-tinta-2">
            Se eliminará la contraseña de este enlace. Asegúrate de que el correo funciona en tu dispositivo o de
            haberla guardado. ¿Quieres continuar?
          </p>
          {hecho.isError && (
            <AvisoError>{mensajeError(hecho.error, 'No se ha podido registrar la configuración.')}</AvisoError>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="plano" className={TACTIL} onClick={() => setPreguntando(false)}>
              Cancelar
            </Button>
            <Button variant="peligro" className={TACTIL} busy={hecho.isPending} onClick={() => hecho.mutate()}>
              Eliminar la contraseña
            </Button>
          </div>
        </div>
      </Dialogo>
    </MarcoPortal>
  );
}

/** Contraseña oculta por defecto: la pantalla del móvil se ve desde cerca. */
function ContrasenaRevelable({ password }: { password: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <Muestra rotulo="Contraseña">
      <div className="flex flex-wrap items-center gap-2">
        <span className="codigo min-w-0 grow break-all text-lg text-tinta" aria-live="polite">
          {visible ? password : '•'.repeat(Math.min(password.length, 16))}
        </span>
        <Button variant="perfil" className={TACTIL} onClick={() => setVisible((v) => !v)} aria-pressed={visible}>
          {visible ? 'Ocultar' : 'Mostrar'}
        </Button>
        <BotonCopiarTactil texto={password} />
      </div>
    </Muestra>
  );
}
