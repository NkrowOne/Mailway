import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import {
  esDispositivoMovil,
  fechaLarga,
  mensajeError,
  type SetupPublico,
} from '../../lib/portal';
import { QR } from '../../components/QR';
import { Button } from '../../ui/Button';
import { Hoja, Midiendo, Muestra } from '../../ui/kit';
import { BotonWebmail, GuiasDispositivo } from './GuiasDispositivo';
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
  const hecho = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>(`/api/public/setup/${encodeURIComponent(token)}/done`),
    onSuccess: () => {
      setConfirmado(true);
      // La contraseña ya no está en el servidor: tampoco debe quedar en pantalla.
      queryClient.setQueryData<SetupPublico>(clave, (prev) =>
        prev ? { ...prev, password: undefined, hasPassword: false } : prev,
      );
    },
  });

  useEffect(() => {
    document.title = 'Configurar su correo';
  }, []);

  if (consulta.isPending) {
    return (
      <PaginaEstado>
        <Midiendo label="Cargando la configuración…" />
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
          <h1 className="font-estrecha text-xl font-semibold uppercase tracking-[0.04em] text-tinta">
            {caducado ? 'Enlace no disponible' : suspendido ? 'Buzón suspendido' : 'No se ha podido cargar la página'}
          </h1>
          <p className="text-base text-tinta-2">
            {caducado
              ? mensajeError(err, 'Este enlace de configuración no es válido o ha caducado.')
              : mensajeError(err, 'Compruebe la conexión a Internet y vuelva a intentarlo.')}
          </p>
          {!definitivo && (
            <Button variant="tinta" className={TACTIL} onClick={() => void consulta.refetch()}>
              Volver a intentarlo
            </Button>
          )}
          <Nota>
            Si ya tiene la contraseña de su buzón, también puede entrar en{' '}
            <a href="/mi-buzon" className="text-laboratorio underline hover:text-tinta">
              Mi buzón
            </a>{' '}
            para configurar sus dispositivos.
          </Nota>
        </div>
      </PaginaEstado>
    );
  }

  const datos = consulta.data;
  const movil = esDispositivoMovil();
  const notaContrasena = datos.password
    ? 'La indicada en el apartado «Contraseña del buzón».'
    : 'La contraseña del buzón que le ha facilitado la persona que administra su correo.';

  return (
    <MarcoPortal
      marca={datos.brandName}
      titulo="Configurar su correo"
      meta={
        <>
          <p className="valor break-all text-white/90">{datos.email}</p>
          <p className="mt-1">
            Siga los pasos para su dispositivo. Este enlace es válido hasta el {fechaLarga(datos.expiresAt)}.
          </p>
        </>
      }
    >
      {datos.password ? (
        <Hoja title="Contraseña del buzón">
          <div className="flex flex-col gap-3">
            <ContrasenaRevelable password={datos.password} />
            <Nota>
              Necesitará esta contraseña si configura el correo a mano. Por seguridad, se eliminará de este enlace
              cuando pulse «Ya lo he configurado» o cuando el enlace caduque; si desea conservarla, guárdela en un
              lugar seguro.
            </Nota>
            {hecho.isError && (
              <AvisoError>{mensajeError(hecho.error, 'No se ha podido registrar la configuración.')}</AvisoError>
            )}
            <Button
              variant="perfil"
              className={`${TACTIL} self-stretch sm:self-start`}
              busy={hecho.isPending}
              onClick={() => hecho.mutate()}
            >
              Ya lo he configurado
            </Button>
          </div>
        </Hoja>
      ) : (
        confirmado && (
          <AvisoHecho>
            Se ha eliminado la contraseña de este enlace. Puede seguir consultando las instrucciones para otros
            dispositivos.
          </AvisoHecho>
        )
      )}

      <Hoja title="Elija su dispositivo">
        <GuiasDispositivo
          email={datos.email}
          conexion={datos.connection}
          appleProfileUrl={datos.appleProfileUrl}
          perfilPublico
          perfilIncluyeContrasena={Boolean(datos.password)}
          thunderbirdAndroidQr={datos.thunderbirdAndroidQr}
          notaContrasena={notaContrasena}
        />
      </Hoja>

      {!movil && (
        <Hoja title="Abrir en el móvil">
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <QR texto={window.location.href} etiqueta="Código QR para abrir esta página en el móvil" />
            <div className="flex flex-col gap-2">
              <p className="max-w-[60ch] text-base text-tinta">
                Para configurar el móvil, escanee este código con su cámara: se abrirá esta misma página.
              </p>
              <Nota>En el iPhone, ábrala en Safari para poder instalar el perfil.</Nota>
            </div>
          </div>
        </Hoja>
      )}

      <Hoja title="Correo web">
        <div className="flex flex-col gap-3">
          <p className="max-w-[70ch] text-base text-tinta-2">
            También puede leer y enviar correo desde el navegador, sin configurar nada, con su dirección y su
            contraseña.
          </p>
          <BotonWebmail url={datos.connection.webmailUrl} />
        </div>
      </Hoja>

      <Hoja title="Mi buzón">
        <div className="flex flex-col gap-3">
          <p className="max-w-[70ch] text-base text-tinta-2">
            En «Mi buzón» puede cambiar la contraseña y crear una contraseña distinta para cada dispositivo, de modo que
            perder el móvil no obligue a cambiar la de todos los demás.
          </p>
          <a href={datos.portalUrl || '/mi-buzon'} className={`${claseEnlaceBoton('perfil')} self-stretch sm:self-start`}>
            Entrar en Mi buzón
          </a>
        </div>
      </Hoja>
    </MarcoPortal>
  );
}

/** Contraseña oculta por defecto: la pantalla del móvil se ve desde cerca. */
function ContrasenaRevelable({ password }: { password: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <Muestra rotulo="Contraseña">
      <div className="flex flex-wrap items-center gap-2">
        <span className="valor min-w-0 grow break-all text-lg text-tinta" aria-live="polite">
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
