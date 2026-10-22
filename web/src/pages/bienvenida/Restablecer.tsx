import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type SetupStatus, type User } from '../../lib/api';
import { MAXIMO_CONTRASENA, MINIMO_CONTRASENA } from '../../lib/bienvenida';
import { fechaLarga, mensajeError } from '../../lib/portal';
import { Button } from '../../ui/Button';
import { AvisoError, Cargando } from '../../ui/kit';
import { TACTIL, claseEnlaceBoton } from '../portal/comun';
import { Portada } from './Bienvenida';
import { CampoContrasena } from './CampoContrasena';

/*
  Página del enlace para restablecer la contraseña del panel
  (/restablecer/:token). La administración lo envía por correo a un usuario
  de un cliente que ha olvidado su contraseña: aquí elige una nueva y entra
  directamente en su panel. Sin pasos de puesta en marcha: solo la
  contraseña.
*/

/** GET /api/password-reset/:token. */
interface RestablecimientoPublico {
  email: string;
  name: string;
  clientName: string;
  brandName: string;
  expiresAt: number;
}

/** Errores que sustituyen al formulario: ya no hay nada que rellenar. */
const FINALES: Record<string, { titulo: string; texto: (marca: string) => string }> = {
  reset_invalid: {
    titulo: 'Este enlace ya no es válido',
    texto: (marca) =>
      `Puede que haya caducado, que ya se haya usado o que se haya sustituido por uno más reciente. Pide a tu proveedor de correo, ${marca}, que te envíe uno nuevo.`,
  },
  client_suspended: {
    titulo: 'Cuenta suspendida',
    texto: (marca) =>
      `La cuenta de correo de tu empresa está suspendida y ahora no se puede cambiar la contraseña. Ponte en contacto con ${marca}, tu proveedor de correo.`,
  },
  user_disabled: {
    titulo: 'Acceso deshabilitado',
    texto: (marca) => `Tu acceso al panel está deshabilitado. Ponte en contacto con ${marca}, tu proveedor de correo.`,
  },
};

function finalDe(err: unknown) {
  return err instanceof ApiError ? (FINALES[err.code] ?? null) : null;
}

export default function Restablecer() {
  const { token = '' } = useParams();
  const enlace = useQuery({
    queryKey: ['restablecer', token],
    queryFn: () => api.get<RestablecimientoPublico>(`/api/password-reset/${encodeURIComponent(token)}`),
    // Caducado, usado o suspendido no mejora reintentando.
    retry: false,
    staleTime: Infinity,
  });
  const estado = useQuery({
    queryKey: ['setup'],
    queryFn: () => api.get<SetupStatus>('/api/setup/status'),
    retry: false,
  });
  const [errorFinal, setErrorFinal] = useState<unknown>(null);
  const marca = enlace.data?.brandName || estado.data?.instance?.brandName || 'Correo';

  useEffect(() => {
    document.title = `Restablecer contraseña · ${marca}`;
  }, [marca]);

  if (enlace.isPending) {
    return (
      <Portada marca={estado.data?.instance?.brandName}>
        <Cargando label="Cargando tu enlace…" />
      </Portada>
    );
  }

  const final = finalDe(errorFinal) ?? (enlace.isError ? finalDe(enlace.error) : null);
  if (final) {
    return (
      <Portada marca={marca}>
        <div className="flex flex-col gap-4 px-5 py-6 sm:px-7 sm:py-7">
          <div>
            <h1 className="text-xl font-semibold text-tinta">{final.titulo}</h1>
            <p className="mt-2 text-base text-tinta-2">{final.texto(marca)}</p>
          </div>
          <Link to="/login" className={`w-full ${claseEnlaceBoton('principal')}`}>
            Iniciar sesión
          </Link>
        </div>
      </Portada>
    );
  }

  if (enlace.isError) {
    return (
      <Portada marca={marca}>
        <div className="flex flex-col gap-4 px-5 py-6 sm:px-7 sm:py-7">
          <h1 className="text-xl font-semibold text-tinta">No se ha podido abrir tu enlace</h1>
          <AvisoError>
            {mensajeError(enlace.error, 'No hay conexión con el servidor. Comprueba la conexión a Internet.')}
          </AvisoError>
          <Button
            variant="principal"
            className={`w-full ${TACTIL}`}
            busy={enlace.isFetching}
            onClick={() => void enlace.refetch()}
          >
            Volver a intentarlo
          </Button>
        </div>
      </Portada>
    );
  }

  return <Formulario token={token} datos={enlace.data} marca={marca} onFinal={setErrorFinal} />;
}

function Formulario({
  token,
  datos,
  marca,
  onFinal,
}: {
  token: string;
  datos: RestablecimientoPublico;
  marca: string;
  onFinal: (err: unknown) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [clave, setClave] = useState('');
  const [repetida, setRepetida] = useState('');
  const [visible, setVisible] = useState(false);
  const [intentado, setIntentado] = useState(false);
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);
  const refClave = useRef<HTMLInputElement>(null);
  const refRepetida = useRef<HTMLInputElement>(null);

  const errores = {
    clave:
      clave.length < MINIMO_CONTRASENA
        ? `Necesita al menos ${MINIMO_CONTRASENA} caracteres${clave.length ? ` (llevas ${clave.length})` : ''}.`
        : clave.length > MAXIMO_CONTRASENA
          ? `Como máximo ${MAXIMO_CONTRASENA} caracteres.`
          : '',
    repetida: repetida.length === 0 ? 'Repite la contraseña.' : repetida !== clave ? 'Las contraseñas no coinciden.' : '',
  };

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setIntentado(true);
    if (errores.clave) return refClave.current?.focus();
    if (errores.repetida) return refRepetida.current?.focus();
    setEnviando(true);
    try {
      const res = await api.post<{ ok: true; redirect?: string }>(
        `/api/password-reset/${encodeURIComponent(token)}`,
        { password: clave },
      );
      // Igual que al iniciar sesión: caché limpia salvo el estado público.
      const setup = queryClient.getQueryData(['setup']);
      queryClient.clear();
      if (setup) queryClient.setQueryData(['setup'], setup);
      try {
        await queryClient.fetchQuery({
          queryKey: ['me'],
          queryFn: () => api.get<{ user: User | null }>('/api/auth/me'),
        });
      } catch {
        // El panel vuelve a pedirlo al cargar; si la sesión no llegó, pedirá entrar.
      }
      // Solo rutas internas (nunca «//otro-sitio»); sin volver atrás a un
      // enlace que ya no sirve.
      const destino = typeof res?.redirect === 'string' && /^\/(?![/\\])/.test(res.redirect) ? res.redirect : '/';
      navigate(destino, { replace: true });
    } catch (err) {
      setEnviando(false);
      if (finalDe(err)) {
        onFinal(err);
        return;
      }
      setError(mensajeError(err, 'No se ha podido guardar la contraseña. Comprueba la conexión y vuelve a intentarlo.'));
    }
  }

  return (
    <Portada marca={marca}>
      <form onSubmit={guardar} noValidate className="flex flex-col gap-4 px-5 py-6 sm:px-7 sm:py-7">
        <div>
          <p className="break-words text-sm font-medium text-tinta-2">{datos.clientName}</p>
          <h1 className="mt-1 text-xl font-semibold text-tinta">Elige una contraseña nueva</h1>
          <p className="mt-1 text-base text-tinta-2">
            Desde ahora entrarás en el panel con tu correo y esta contraseña. Se cerrarán las sesiones abiertas con la
            anterior.
          </p>
        </div>

        {/* Para que el gestor de contraseñas guarde la cuenta con su usuario. */}
        <input type="email" name="username" autoComplete="username" value={datos.email} readOnly hidden />

        <div className="flex flex-col gap-1.5">
          <span className="rotulo">Usuario</span>
          <p className="valor [overflow-wrap:anywhere] rounded-lg border border-regla bg-hoja-2 px-3 py-2 text-base text-tinta">
            {datos.email}
          </p>
        </div>

        <CampoContrasena
          ref={refClave}
          label="Contraseña nueva"
          autoComplete="new-password"
          name="new-password"
          maxLength={MAXIMO_CONTRASENA}
          value={clave}
          visible={visible}
          onAlternar={() => setVisible((v) => !v)}
          onChange={(e) => {
            setError('');
            setClave(e.target.value);
          }}
          help={`Al menos ${MINIMO_CONTRASENA} caracteres. Una frase que recuerdes con facilidad funciona bien.`}
          error={intentado ? errores.clave || undefined : undefined}
        />
        <CampoContrasena
          ref={refRepetida}
          label="Repite la contraseña"
          autoComplete="new-password"
          maxLength={MAXIMO_CONTRASENA}
          value={repetida}
          visible={visible}
          onAlternar={() => setVisible((v) => !v)}
          onChange={(e) => {
            setError('');
            setRepetida(e.target.value);
          }}
          error={intentado ? errores.repetida || undefined : undefined}
        />

        {error && <AvisoError>{error}</AvisoError>}

        <Button type="submit" variant="principal" busy={enviando} className={`w-full ${TACTIL}`}>
          Guardar y entrar
        </Button>
        <p className="text-center text-sm text-tinta-3">
          Este enlace es personal y es válido hasta el {fechaLarga(datos.expiresAt)}.
        </p>
      </form>
    </Portada>
  );
}
