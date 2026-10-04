import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Smartphone } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  esCredencialIncorrecta,
  TEXTO_CREDENCIALES_INCORRECTAS,
  type BloqueVariables,
  type SetupStatus,
} from '../../lib/api';
import { formatDate } from '../../lib/format';
import {
  esUsadoPorApp,
  formatoBytes,
  mensajeError,
  TEXTO_USADO_POR_APP,
  type ContrasenaAplicacion,
  type PortalMe,
  type RespuestaActualizarUsuario,
} from '../../lib/portal';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Cargando, Dialogo, Escala, Hoja, Logotipo, Marca, MarcaFondo, Muestra, Vacio } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { BotonWebmail, GuiasDispositivo } from './GuiasDispositivo';
import { AvisoError, AvisoHecho, BotonCopiarTactil, MarcoPortal, Nota, PaginaEstado, TACTIL } from './comun';
import { VariablesIntegracion } from '../../components/VariablesIntegracion';

/**
 * «Mi buzón»: el titular entra con su dirección y la contraseña del buzón
 * para configurar dispositivos, cambiar la contraseña y gestionar sus
 * contraseñas de aplicación, sin depender de quien administra el correo.
 */
export default function MiBuzon() {
  const me = useQuery({
    queryKey: ['portal-me'],
    queryFn: () => api.get<PortalMe>('/api/portal/me'),
    retry: false,
  });

  useEffect(() => {
    document.title = 'Mi buzón';
  }, []);

  if (me.isPending) {
    return (
      <PaginaEstado>
        <Cargando label="Cargando tu buzón…" />
      </PaginaEstado>
    );
  }

  if (me.isError) {
    const err = me.error;
    // Sin sesión (o caducada): se pide entrar. Suspendido: se explica.
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      return <AccesoPortal aviso={err.status === 403 ? err.message : undefined} />;
    }
    return (
      <PaginaEstado>
        <div className="flex flex-col gap-3 px-5 py-6">
          <h1 className="text-xl font-semibold text-tinta">
            No se ha podido cargar la página
          </h1>
          <AvisoError>{mensajeError(err, 'Comprueba la conexión a Internet y vuelve a intentarlo.')}</AvisoError>
          <Button variant="principal" className={TACTIL} onClick={() => void me.refetch()}>
            Volver a intentarlo
          </Button>
        </div>
      </PaginaEstado>
    );
  }

  return <InicioBuzon me={me.data} />;
}

/* --------------------------------- Acceso ---------------------------------- */

function AccesoPortal({ aviso }: { aviso?: string }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(aviso ?? '');
  const [busy, setBusy] = useState(false);
  // La marca de la instancia, para que el titular reconozca a su proveedor.
  const estado = useQuery({
    queryKey: ['setup'],
    queryFn: () => api.get<SetupStatus>('/api/setup/status'),
    retry: false,
  });
  const marca = estado.data?.instance?.brandName || 'Correo';

  async function entrar(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Indica la dirección de correo y la contraseña del buzón.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post('/api/portal/login', { email, password });
      setPassword('');
      await queryClient.invalidateQueries({ queryKey: ['portal-me'] });
    } catch (err) {
      setError(
        esCredencialIncorrecta(err)
          ? TEXTO_CREDENCIALES_INCORRECTAS
          : mensajeError(err, 'No se ha podido iniciar sesión.'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-mesa px-4 py-10">
      <div className="w-full max-w-[25rem] animate-aparecer">
        <div className="mb-6 flex items-center justify-center gap-3">
          <Logotipo />
          <span className="min-w-0 break-words text-lg font-semibold text-tinta">{marca}</span>
        </div>
        <section className="hoja-panel overflow-hidden rounded-2xl border border-regla bg-hoja">
          <form onSubmit={entrar} noValidate className="flex flex-col gap-4 px-5 py-6 sm:px-7 sm:py-7">
            <div>
              <h1 className="text-2xl font-semibold text-tinta">Mi buzón</h1>
              <p className="mt-1 text-base text-tinta-2">
                Entra con tu dirección de correo y la contraseña del buzón para configurar tus dispositivos o cambiar la
                contraseña.
              </p>
            </div>
            <Input
              label="Dirección de correo"
              type="email"
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(e) => {
                setError('');
                setEmail(e.target.value);
              }}
              placeholder="nombre@empresa.com"
              className={TACTIL}
            />
            <Input
              label="Contraseña"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setError('');
                setPassword(e.target.value);
              }}
              className={TACTIL}
            />
            {error && <AvisoError>{error}</AvisoError>}
            <Button type="submit" variant="principal" busy={busy} className={`w-full ${TACTIL}`}>
              Iniciar sesión
            </Button>
          </form>
        </section>
        <p className="mt-4 text-center text-sm text-tinta-3">
          Si no recuerdas la contraseña, solicita un restablecimiento a la persona que administra tu correo.
        </p>
      </div>
    </div>
  );
}

/* --------------------------------- Inicio ---------------------------------- */

function InicioBuzon({ me }: { me: PortalMe }) {
  const queryClient = useQueryClient();
  const [saliendo, setSaliendo] = useState(false);
  // Usuario recién actualizado: la tarjeta del cambio de dirección sigue a la
  // vista con las guías aunque `me` ya no esté pendiente.
  const [actualizado, setActualizado] = useState<string | null>(null);
  // Tras un cambio de dominio, los dispositivos entran con el usuario anterior
  // hasta actualizarlo: las guías dan ese usuario, que es el que funciona.
  const usuario = me.connection.username || me.login || me.email;

  async function salir() {
    setSaliendo(true);
    try {
      await api.post('/api/portal/logout');
    } catch {
      // Aunque falle, se descarta la sesión en esta pestaña.
    }
    queryClient.removeQueries({ queryKey: ['portal-app-passwords'] });
    await queryClient.resetQueries({ queryKey: ['portal-me'] });
    setSaliendo(false);
  }

  return (
    <MarcoPortal
      marca={me.brandName}
      titulo="Mi buzón"
      meta={
        <>
          <p className="break-all font-medium text-tinta">{me.email}</p>
          {me.displayName && <p className="mt-1">{me.displayName}</p>}
        </>
      }
      acciones={
        <Button variant="plano" onClick={() => void salir()} disabled={saliendo} className={`shrink-0 ${TACTIL}`}>
          Cerrar sesión
        </Button>
      }
    >
      {(me.loginPending || actualizado) && (
        <HojaNuevaDireccion me={me} usuario={usuario} actualizado={actualizado} onActualizado={setActualizado} />
      )}

      <HojaEspacio me={me} />

      {/* Tras actualizar, las guías van en la tarjeta del cambio de dirección. */}
      {!actualizado && (
        <Hoja title="Configurar un dispositivo">
          <GuiasDispositivo
            email={me.email}
            usuario={usuario}
            conexion={me.connection}
            appleProfileUrl={me.appleProfileUrl}
            perfilPublico={false}
            perfilIncluyeContrasena={false}
            thunderbirdAndroidQr={me.thunderbirdAndroidQr}
            notaContrasena={NOTA_CONTRASENA}
          />
        </Hoja>
      )}

      <Hoja title="Correo web">
        <div className="flex flex-col gap-3">
          <p className="max-w-[70ch] text-base text-tinta-2">
            Lee y envía correo desde cualquier navegador con tu dirección y tu contraseña.
          </p>
          <BotonWebmail url={me.webmailUrl} />
        </div>
      </Hoja>

      <HojaContrasenasAplicacion />
      <HojaCambioContrasena />
    </MarcoPortal>
  );
}

const NOTA_CONTRASENA =
  'La contraseña del buzón o, mejor, una contraseña de aplicación creada para ese dispositivo (más abajo).';

/* --------------------------- Cambio de dirección --------------------------- */

/**
 * Tras un cambio de dominio: el buzón ya recibe en las dos direcciones y sus
 * dispositivos siguen entrando con el usuario anterior. Un toque cambia el
 * usuario a la dirección nueva; la contraseña no cambia. Después, las guías
 * de siempre con el usuario nuevo resaltado.
 */
function HojaNuevaDireccion({
  me,
  usuario,
  actualizado,
  onActualizado,
}: {
  me: PortalMe;
  usuario: string;
  actualizado: string | null;
  onActualizado: (login: string) => void;
}) {
  const queryClient = useQueryClient();
  const [preguntando, setPreguntando] = useState(false);
  // El usuario anterior, tal como estaba al abrir la confirmación.
  const anterior = me.login || usuario;

  const actualizar = useMutation({
    mutationFn: () => api.post<RespuestaActualizarUsuario>('/api/portal/login-update', {}),
    onSuccess: async (data) => {
      // Se espera a releer «Mi buzón»: el perfil de Apple y el QR llevan ya el usuario nuevo.
      await queryClient.invalidateQueries({ queryKey: ['portal-me'] });
      onActualizado(data.login || me.email);
      setPreguntando(false);
    },
    onError: (err) => {
      // Una aplicación empezó a enviar con el buzón después de cargar la
      // página: se cierra la confirmación y la tarjeta lo explica sin botón.
      if (esUsadoPorApp(err)) {
        setPreguntando(false);
        void queryClient.invalidateQueries({ queryKey: ['portal-me'] });
      }
    },
  });
  const usadoPorApp = me.usadoPorApp || (actualizar.isError && esUsadoPorApp(actualizar.error));

  const titulo = (
    <h2 className="text-md font-semibold text-tinta [overflow-wrap:anywhere]">Tu dirección ahora es {me.email}</h2>
  );

  if (actualizado) {
    return (
      <Hoja title={titulo}>
        <div className="flex flex-col gap-4">
          <AvisoHecho>Listo. Ahora entras con {actualizado}. Configura cada dispositivo:</AvisoHecho>
          <Muestra rotulo="Usuario nuevo">
            <div className="flex flex-wrap items-center gap-2">
              <span className="codigo min-w-0 grow break-all text-lg text-tinta">{actualizado}</span>
              <BotonCopiarTactil texto={actualizado} />
            </div>
          </Muestra>
          <dl className="flex flex-col gap-2.5">
            <PasoDispositivo rotulo="iPhone o Mac">Instala el perfil de nuevo: sustituye al anterior.</PasoDispositivo>
            <PasoDispositivo rotulo="A mano">
              Ajustes → Mail → Cuentas → tu cuenta: cambia el usuario a{' '}
              <span className="valor [overflow-wrap:anywhere]">{actualizado}</span> en el servidor de entrada y en el de
              salida.
            </PasoDispositivo>
            <PasoDispositivo rotulo="Android con QR">
              La lectura del código crea una cuenta nueva: borra después la anterior.
            </PasoDispositivo>
          </dl>
          <div className="regla-cabecera" aria-hidden />
          <GuiasDispositivo
            email={me.email}
            usuario={usuario}
            conexion={me.connection}
            appleProfileUrl={me.appleProfileUrl}
            perfilPublico={false}
            perfilIncluyeContrasena={false}
            thunderbirdAndroidQr={me.thunderbirdAndroidQr}
            notaContrasena={NOTA_CONTRASENA}
          />
        </div>
      </Hoja>
    );
  }

  return (
    <Hoja title={titulo}>
      <div className="flex flex-col gap-3">
        <p className="max-w-[70ch] text-base text-tinta-2">
          Ya recibes el correo en las dos direcciones. Para terminar, actualiza tus dispositivos: tu contraseña no
          cambia.
        </p>
        {usadoPorApp ? (
          <Nota>{TEXTO_USADO_POR_APP}</Nota>
        ) : (
          <Button
            variant="principal"
            className={`${TACTIL} self-stretch sm:self-start`}
            onClick={() => {
              actualizar.reset();
              setPreguntando(true);
            }}
          >
            Actualizar mis dispositivos
          </Button>
        )}
      </div>

      <Dialogo open={preguntando} onClose={() => setPreguntando(false)} title="Actualizar mis dispositivos">
        <div className="flex flex-col gap-4">
          <p className="text-base text-tinta-2 [overflow-wrap:anywhere]">
            Los dispositivos que sigan configurados con {anterior} dejarán de conectar hasta que los actualices.
          </p>
          {actualizar.isError && (
            <AvisoError>{mensajeError(actualizar.error, 'No se ha podido actualizar el usuario.')}</AvisoError>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="plano" className={TACTIL} onClick={() => setPreguntando(false)}>
              Cancelar
            </Button>
            <Button
              variant="principal"
              className={TACTIL}
              busy={actualizar.isPending}
              onClick={() => actualizar.mutate()}
            >
              Actualizar
            </Button>
          </div>
        </div>
      </Dialogo>
    </Hoja>
  );
}

/** Qué hacer en cada tipo de dispositivo tras actualizar el usuario. */
function PasoDispositivo({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="rotulo shrink-0 sm:w-36 sm:pt-0.5">{rotulo}</dt>
      <dd className="min-w-0 max-w-[70ch] text-base text-tinta [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** Espacio ocupado frente a la cuota, en la unidad que se lea mejor. */
function HojaEspacio({ me }: { me: PortalMe }) {
  const enGb = me.quotaMb >= 1024;
  const usado =
    me.usedBytes === null
      ? null
      : enGb
        ? Math.round((me.usedBytes / 1024 ** 3) * 10) / 10
        : Math.round(me.usedBytes / 1024 ** 2);
  const maximo = enGb ? Math.round((me.quotaMb / 1024) * 10) / 10 : me.quotaMb;
  return (
    <Hoja
      title="Espacio ocupado"
      meta={me.usageCheckedAt ? `Actualizado: ${formatDate(me.usageCheckedAt)}` : undefined}
    >
      {usado === null ? (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-base text-tinta-2">No se ha podido consultar el espacio ocupado en este momento.</p>
          <Marca veredicto="sin-dato" />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {/* Lleno, el buzón deja de recibir correo: aquí el límite sí es fuera de rango. */}
          <Escala label="Correo guardado" usado={usado} maximo={maximo} unidad={enGb ? 'GB' : 'MB'} limiteEsFuera />
          <Nota>
            {me.usedBytes !== null && `Ocupa ${formatoBytes(me.usedBytes)}. `}
            Si se acerca al límite, elimina mensajes antiguos o con adjuntos grandes y vacía la papelera.
          </Nota>
        </div>
      )}
    </Hoja>
  );
}

/* ------------------------ Contraseñas de aplicación ------------------------ */

function HojaContrasenasAplicacion() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [nombre, setNombre] = useState('');
  const [nueva, setNueva] = useState<{ nombre: string; password: string; snippets: BloqueVariables[] } | null>(null);
  const [verVariables, setVerVariables] = useState(false);
  const [aRevocar, setARevocar] = useState<ContrasenaAplicacion | null>(null);
  const [verRevocadas, setVerRevocadas] = useState(false);

  const lista = useQuery({
    queryKey: ['portal-app-passwords'],
    queryFn: () => api.get<{ appPasswords: ContrasenaAplicacion[] }>('/api/portal/app-passwords'),
  });

  const crear = useMutation({
    mutationFn: (name: string) =>
      api.post<{ appPassword: ContrasenaAplicacion; password: string; snippets?: BloqueVariables[] }>(
        '/api/portal/app-passwords',
        { name },
      ),
    onSuccess: async (data) => {
      setNueva({ nombre: data.appPassword.name, password: data.password, snippets: data.snippets ?? [] });
      setVerVariables(false);
      setNombre('');
      await queryClient.invalidateQueries({ queryKey: ['portal-app-passwords'] });
    },
  });

  const revocar = useMutation({
    mutationFn: (app: ContrasenaAplicacion) => api.delete(`/api/portal/app-passwords/${app.id}`),
    onSuccess: async (_data, app) => {
      setARevocar(null);
      toast('ok', `Se ha revocado la contraseña de «${app.name}».`);
      await queryClient.invalidateQueries({ queryKey: ['portal-app-passwords'] });
    },
    onError: (err) => toast('error', mensajeError(err, 'No se ha podido revocar la contraseña.')),
  });

  function enviar(e: FormEvent) {
    e.preventDefault();
    crear.mutate(nombre);
  }

  const todas = lista.data?.appPasswords ?? [];
  // Las revocadas se conservan como referencia, plegadas: la lista crecía sin
  // límite y enterraba las que siguen en uso.
  const revocadas = todas.filter((app) => app.revokedAt).length;
  const apps = verRevocadas ? todas : todas.filter((app) => !app.revokedAt);

  return (
    <Hoja title="Contraseñas de aplicación" flush>
      <div className="flex flex-col gap-4 p-4">
        <p className="max-w-[70ch] text-base text-tinta-2">
          Crea una contraseña distinta para cada dispositivo o programa (el móvil, el portátil, Outlook…) y utilízala
          en lugar de la contraseña principal. Si pierdes el móvil, revoca solo la suya: el resto seguirá funcionando y
          no tendrás que cambiar la contraseña principal.
        </p>

        {nueva ? (
          <div className="revelar flex flex-col gap-3">
            <Muestra rotulo={`Contraseña para «${nueva.nombre}»`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="codigo min-w-0 grow break-all text-lg text-tinta">{nueva.password}</span>
                <BotonCopiarTactil texto={nueva.password} />
              </div>
            </Muestra>
            <Nota>
              Escríbela ahora en el dispositivo, en el campo de la contraseña. Por seguridad, no se volverá a mostrar.
            </Nota>
            {nueva.snippets.length > 0 && (
              <div className="flex flex-col gap-3">
                <Button
                  variant="plano"
                  className={`${TACTIL} self-stretch sm:self-start`}
                  aria-expanded={verVariables}
                  onClick={() => setVerVariables((v) => !v)}
                >
                  {verVariables ? 'Ocultar las variables' : 'Ver las variables para una web o una aplicación'}
                </Button>
                {verVariables && (
                  <>
                    <Nota>
                      Datos listos para copiar en la configuración de una web o una aplicación que envía correo con esta
                      contraseña. Tampoco se volverán a mostrar.
                    </Nota>
                    <VariablesIntegracion bloques={nueva.snippets} tactil />
                  </>
                )}
              </div>
            )}
            <Button variant="perfil" className={`${TACTIL} self-stretch sm:self-start`} onClick={() => setNueva(null)}>
              Hecho
            </Button>
          </div>
        ) : (
          <form onSubmit={enviar} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="grow">
              <Input
                label="Nombre del dispositivo"
                placeholder="Por ejemplo: Móvil personal"
                maxLength={60}
                value={nombre}
                onChange={(e) => {
                  crear.reset();
                  setNombre(e.target.value);
                }}
                className={TACTIL}
              />
            </div>
            <Button
              type="submit"
              variant="perfil"
              busy={crear.isPending}
              disabled={nombre.trim().length === 0}
              className={TACTIL}
            >
              Crear contraseña
            </Button>
          </form>
        )}
        {crear.isError && (
          <AvisoError>{mensajeError(crear.error, 'No se ha podido crear la contraseña de aplicación.')}</AvisoError>
        )}
      </div>

      {lista.isPending ? (
        <Cargando label="Cargando contraseñas…" />
      ) : lista.isError ? (
        <div className="px-4 pb-4">
          <AvisoError>{mensajeError(lista.error, 'No se han podido cargar las contraseñas de aplicación.')}</AvisoError>
        </div>
      ) : todas.length === 0 ? (
        <div className="border-t border-regla">
          <Vacio icono={Smartphone} title="Aún no hay contraseñas de aplicación">
            Crea la primera para el dispositivo que vayas a configurar.
          </Vacio>
        </div>
      ) : apps.length === 0 ? (
        <p className="border-t border-regla px-4 py-4 text-base text-tinta-2">
          No hay contraseñas de aplicación activas.
        </p>
      ) : (
        <div className="border-t border-regla">
          <div className="regla-cabecera hidden items-baseline gap-x-4 px-4 py-2 sm:flex">
            <span className="rotulo min-w-0 grow basis-0">Dispositivo</span>
            <span className="rotulo w-32 shrink-0">Creada</span>
            <span className="rotulo w-28 shrink-0">Estado</span>
            <span className="rotulo w-24 shrink-0 text-right">Acción</span>
          </div>
          {apps.map((app) => (
            <div
              key={app.id}
              className="regla-fila flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 last:border-b-0"
            >
              <p className="min-w-0 grow basis-full break-words text-base text-tinta sm:basis-0">{app.name}</p>
              <div className="flex shrink-0 items-baseline gap-1.5 sm:w-32">
                <span className="rotulo sm:hidden">Creada</span>
                <span className="valor text-sm text-tinta-2">{formatDate(app.createdAt)}</span>
              </div>
              <div className="shrink-0 sm:w-28">
                {app.revokedAt ? (
                  <MarcaFondo veredicto="sin-dato">Revocada</MarcaFondo>
                ) : (
                  <MarcaFondo veredicto="normal">Activa</MarcaFondo>
                )}
              </div>
              <div className="flex w-full justify-end sm:w-24">
                {!app.revokedAt && (
                  <Button variant="peligro" className={TACTIL} onClick={() => setARevocar(app)}>
                    Revocar
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {revocadas > 0 && (
        <div className="border-t border-regla px-4 py-2.5">
          <Button
            variant="plano"
            className={TACTIL}
            aria-expanded={verRevocadas}
            onClick={() => setVerRevocadas((v) => !v)}
          >
            {verRevocadas ? 'Ocultar las revocadas' : `Mostrar las revocadas (${revocadas})`}
          </Button>
        </div>
      )}

      <Dialogo open={aRevocar !== null} onClose={() => setARevocar(null)} title="Revocar contraseña">
        {aRevocar && (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2">
              El dispositivo que utiliza la contraseña «{aRevocar.name}» dejará de recibir y enviar correo hasta que se
              configure con otra contraseña. Los demás dispositivos no se ven afectados.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="plano" className={TACTIL} onClick={() => setARevocar(null)}>
                Cancelar
              </Button>
              <Button
                variant="peligro"
                className={TACTIL}
                busy={revocar.isPending}
                onClick={() => revocar.mutate(aRevocar)}
              >
                Revocar
              </Button>
            </div>
          </div>
        )}
      </Dialogo>
    </Hoja>
  );
}

/* --------------------------- Cambio de contraseña -------------------------- */

function HojaCambioContrasena() {
  const toast = useToast();
  const [actual, setActual] = useState('');
  const [nueva, setNueva] = useState('');
  const [repetida, setRepetida] = useState('');
  const [error, setError] = useState('');

  const cambiar = useMutation({
    mutationFn: () => api.post('/api/portal/password', { current: actual, next: nueva }),
    onSuccess: () => {
      setActual('');
      setNueva('');
      setRepetida('');
      setError('');
      toast('ok', 'Se ha cambiado la contraseña del buzón.');
    },
    onError: (err) => setError(mensajeError(err, 'No se ha podido cambiar la contraseña.')),
  });

  function enviar(e: FormEvent) {
    e.preventDefault();
    // Las comprobaciones evidentes se hacen aquí para no gastar intentos.
    if (!actual) return setError('Indica la contraseña actual.');
    if (nueva.length < 10) return setError('La nueva contraseña debe tener al menos 10 caracteres.');
    if (nueva !== repetida) return setError('Las dos contraseñas nuevas no coinciden.');
    if (nueva === actual) return setError('La nueva contraseña debe ser distinta de la actual.');
    setError('');
    cambiar.mutate();
  }

  return (
    <Hoja title="Cambiar la contraseña">
      <form onSubmit={enviar} noValidate className="flex flex-col gap-4">
        <Nota>
          Los dispositivos configurados con la contraseña principal dejarán de sincronizar hasta que introduzcas en ellos
          la nueva. Los que utilizan una contraseña de aplicación no se ven afectados.
        </Nota>
        <Input
          label="Contraseña actual"
          type="password"
          autoComplete="current-password"
          value={actual}
          onChange={(e) => {
            setError('');
            setActual(e.target.value);
          }}
          className={TACTIL}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Nueva contraseña"
            type="password"
            autoComplete="new-password"
            help="Al menos 10 caracteres."
            value={nueva}
            onChange={(e) => {
              setError('');
              setNueva(e.target.value);
            }}
            className={TACTIL}
          />
          <Input
            label="Repetir la nueva contraseña"
            type="password"
            autoComplete="new-password"
            value={repetida}
            onChange={(e) => {
              setError('');
              setRepetida(e.target.value);
            }}
            className={TACTIL}
          />
        </div>
        {error && <AvisoError>{error}</AvisoError>}
        <Button type="submit" variant="perfil" busy={cambiar.isPending} className={`${TACTIL} self-stretch sm:self-start`}>
          Cambiar la contraseña
        </Button>
      </form>
    </Hoja>
  );
}
