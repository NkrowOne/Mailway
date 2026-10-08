import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type SetupStatus, type User } from '../../lib/api';
import {
  destinoTrasAceptar,
  MAXIMO_CONTRASENA,
  MINIMO_CONTRASENA,
  type AceptacionInvitacion,
  type InvitacionPublica,
} from '../../lib/bienvenida';
import { fechaLarga, mensajeError } from '../../lib/portal';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { AvisoError, Cargando, Logotipo } from '../../ui/kit';
import { TACTIL, claseEnlaceBoton } from '../portal/comun';
import { CampoContrasena } from './CampoContrasena';

/*
  Página del enlace de bienvenida (/bienvenida/:token). La abre la persona de
  contacto de la empresa cliente, a menudo en el móvil y sin saber de correo:
  primero le cuenta qué va a hacer y cuánto le llevará, y después le pide lo
  mínimo para crear su acceso (nombre y contraseña; el correo ya lo puso su
  proveedor). Al terminar entra directamente en la puesta en marcha, con la
  sesión ya abierta.
*/

/** Desenlaces que sustituyen al formulario: ya no hay nada que rellenar. */
type Final = 'invalido' | 'usado' | 'existe' | 'suspendido';

const FINAL_POR_CODIGO: Record<string, Final> = {
  invite_invalid: 'invalido',
  invite_used: 'usado',
  user_exists: 'existe',
  client_suspended: 'suspendido',
};

function finalDeError(err: unknown): Final | null {
  return err instanceof ApiError ? (FINAL_POR_CODIGO[err.code] ?? null) : null;
}

/**
 * Tras entrar, adónde: a la puesta en marcha. Con `next` y no con el enlace de
 * arranque, que aquí es este mismo enlace ya gastado.
 */
const IR_A_LOGIN = `/login?next=${encodeURIComponent('/puesta-en-marcha')}`;

export default function Bienvenida() {
  const { token = '' } = useParams();
  const invitacion = useQuery({
    queryKey: ['invitacion', token],
    queryFn: () => api.get<InvitacionPublica>(`/api/invite/${encodeURIComponent(token)}`),
    // Caducado, usado o suspendido no mejora reintentando.
    retry: false,
    staleTime: Infinity,
  });
  // La marca de la instancia, para que los estados sin invitación también
  // digan de quién es la página.
  const estado = useQuery({
    queryKey: ['setup'],
    queryFn: () => api.get<SetupStatus>('/api/setup/status'),
    retry: false,
  });
  // Quien abre su enlace con otra sesión del panel abierta (la administración
  // probándolo, por ejemplo) debe saber que va a cambiar de cuenta.
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User | null }>('/api/auth/me'),
    retry: false,
  });
  const [final, setFinal] = useState<Final | null>(null);

  const marca = invitacion.data?.brandName || estado.data?.instance?.brandName || 'Correo';
  const usuario = me.data?.user ?? null;

  useEffect(() => {
    document.title = `Crea tu acceso · ${marca}`;
  }, [marca]);

  if (invitacion.isPending) {
    return (
      <Portada marca={estado.data?.instance?.brandName}>
        <Cargando label="Cargando tu enlace de bienvenida…" />
      </Portada>
    );
  }

  const desenlace = final ?? (invitacion.isError ? finalDeError(invitacion.error) : null);
  if (desenlace) {
    return <Desenlace final={desenlace} marca={marca} email={invitacion.data?.email} usuario={usuario} />;
  }

  if (invitacion.isError) {
    return (
      <Portada marca={marca}>
        <div className="flex flex-col gap-4 px-5 py-6 sm:px-7 sm:py-7">
          <h1 className="text-xl font-semibold text-tinta">No se ha podido abrir tu enlace</h1>
          <AvisoError>
            {mensajeError(invitacion.error, 'No hay conexión con el servidor. Comprueba la conexión a Internet.')}
          </AvisoError>
          <Button
            variant="principal"
            className={`w-full ${TACTIL}`}
            busy={invitacion.isFetching}
            onClick={() => void invitacion.refetch()}
          >
            Volver a intentarlo
          </Button>
        </div>
      </Portada>
    );
  }

  return <Acogida token={token} datos={invitacion.data} usuario={usuario} onFinal={setFinal} />;
}

/* --------------------------------- Acogida --------------------------------- */

/**
 * Lo que cubre la puesta en marcha, en el orden en que se hace. Frases
 * cortas: es una promesa de lo que viene, no las instrucciones.
 */
const PASOS: { titulo: string; texto: string }[] = [
  {
    titulo: 'Conectar tu dominio',
    texto: 'Te indicamos qué registros DNS hay que añadir y comprobamos que todo esté en orden.',
  },
  {
    titulo: 'Elegir quién recibe los avisos',
    texto: 'Las direcciones postmaster y abuse, que exigen los estándares del correo.',
  },
  {
    titulo: 'Crear los buzones de tu equipo',
    texto: 'Todos de una vez, cada uno con un enlace para que su titular lo configure.',
  },
  {
    titulo: 'Configurar tus dispositivos',
    texto: 'Tu correo en el móvil y en el ordenador.',
  },
];

function Acogida({
  token,
  datos,
  usuario,
  onFinal,
}: {
  token: string;
  datos: InvitacionPublica;
  usuario: User | null;
  onFinal: (final: Final) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [nombre, setNombre] = useState(datos.name);
  const [clave, setClave] = useState('');
  const [repetida, setRepetida] = useState('');
  const [visible, setVisible] = useState(false);
  const [tocados, setTocados] = useState({ nombre: false, clave: false, repetida: false });
  const [intentado, setIntentado] = useState(false);
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);
  const refNombre = useRef<HTMLInputElement>(null);
  const refClave = useRef<HTMLInputElement>(null);
  const refRepetida = useRef<HTMLInputElement>(null);

  const errores = {
    nombre:
      nombre.trim().length === 0
        ? 'Indica tu nombre.'
        : nombre.trim().length < 2
          ? 'Tu nombre debe tener al menos 2 caracteres.'
          : '',
    clave:
      clave.length === 0
        ? `Elige una contraseña de al menos ${MINIMO_CONTRASENA} caracteres.`
        : clave.length < MINIMO_CONTRASENA
          ? `Necesita al menos ${MINIMO_CONTRASENA} caracteres (llevas ${clave.length}).`
          : clave.length > MAXIMO_CONTRASENA
            ? `Como máximo ${MAXIMO_CONTRASENA} caracteres.`
            : '',
    repetida: repetida.length === 0 ? 'Repite la contraseña.' : repetida !== clave ? 'Las contraseñas no coinciden.' : '',
  };
  // Cada error aparece cuando se sale del campo (o al enviar), no mientras se
  // escribe. La repetición avisa antes: en cuanto tiene tantos caracteres como
  // la contraseña ya se sabe si coinciden.
  const mostrar = {
    nombre: intentado || tocados.nombre,
    clave: intentado || tocados.clave,
    repetida:
      intentado || tocados.repetida || (repetida.length >= clave.length && clave.length > 0 && repetida.length > 0),
  };

  function tocar(campo: keyof typeof tocados) {
    setTocados((t) => (t[campo] ? t : { ...t, [campo]: true }));
  }

  async function crearAcceso(e: FormEvent) {
    e.preventDefault();
    setIntentado(true);
    setError('');
    // El foco va al primer campo que falla: en el móvil, el aviso puede
    // quedar fuera de la pantalla.
    if (errores.nombre) return refNombre.current?.focus();
    if (errores.clave) return refClave.current?.focus();
    if (errores.repetida) return refRepetida.current?.focus();

    setEnviando(true);
    try {
      const res = await api.post<AceptacionInvitacion>(`/api/invite/${encodeURIComponent(token)}/accept`, {
        name: nombre.trim(),
        password: clave,
      });
      // Igual que al iniciar sesión: caché limpia (si había otra sesión en esta
      // pestaña, sus datos no deben asomar) salvo el estado público de la
      // instalación, que se vuelve a leer completo con la sesión nueva.
      const setup = queryClient.getQueryData(['setup']);
      queryClient.clear();
      if (setup) queryClient.setQueryData(['setup'], setup);
      void queryClient.invalidateQueries({ queryKey: ['setup'] });
      try {
        await queryClient.fetchQuery({
          queryKey: ['me'],
          queryFn: () => api.get<{ user: User | null }>('/api/auth/me'),
        });
      } catch {
        // El panel vuelve a pedirlo al cargar; si la sesión no llegó, pedirá entrar.
      }
      // Sin volver atrás a un enlace que ya no sirve.
      navigate(destinoTrasAceptar(res?.redirect), { replace: true });
    } catch (err) {
      setEnviando(false);
      const final = finalDeError(err);
      if (final) {
        onFinal(final);
        return;
      }
      setError(mensajeError(err, 'No se ha podido crear tu acceso. Comprueba la conexión y vuelve a intentarlo.'));
    }
  }

  const otraSesion = usuario && usuario.email.toLowerCase() !== datos.email.toLowerCase() ? usuario : null;

  return (
    <div className="min-h-screen bg-mesa">
      <div className="mx-auto w-full max-w-5xl px-4 pb-12 pt-6 sm:px-8 sm:pb-16 sm:pt-10">
        <header className="flex items-center gap-3">
          <Logotipo />
          <span className="min-w-0 break-words text-md font-semibold text-tinta">{datos.brandName}</span>
        </header>

        <main className="mt-8 grid animate-aparecer items-start gap-8 sm:mt-12 lg:grid-cols-[minmax(0,1fr)_26rem] lg:gap-16">
          {/* 1. Qué es esto y qué va a pasar. */}
          <section aria-labelledby="bienvenida-titulo" className="min-w-0 lg:pt-2">
            <p className="break-words text-base font-medium text-tinta-2">{datos.clientName}</p>
            <h1 id="bienvenida-titulo" className="titular mt-1 text-2xl text-tinta [overflow-wrap:anywhere] sm:text-3xl">
              {datos.name ? `Te damos la bienvenida, ${datos.name}` : 'Te damos la bienvenida'}
            </h1>
            <p className="mt-3 max-w-[60ch] text-base text-tinta-2">
              {datos.existingUser
                ? `${datos.brandName} te invita a la puesta en marcha del correo de ${datos.clientName}. Elige una contraseña nueva y te guiaremos paso a paso hasta dejarlo funcionando para todo tu equipo.`
                : `${datos.brandName} ha preparado el correo de ${datos.clientName}. Crea tu acceso al panel y te guiaremos paso a paso hasta dejarlo funcionando para todo tu equipo.`}
            </p>

            <h2 className="mt-8 text-md font-semibold text-tinta">Lo que vas a hacer</h2>
            <ol className="mt-4 flex flex-col gap-4">
              {PASOS.map((paso, i) => (
                <li key={paso.titulo} className="flex gap-3">
                  <span
                    aria-hidden
                    className="valor flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-petroleo-claro text-sm font-semibold text-petroleo"
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 max-w-[60ch] pt-0.5">
                    <p className="text-base font-medium text-tinta">{paso.titulo}</p>
                    <p className="text-base text-tinta-2">{paso.texto}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-6 max-w-[60ch] text-sm text-tinta-3">
              En total, unos 15 minutos. Los cambios de DNS pueden tardar algo más en aplicarse; si lo dejas a medias,
              podrás continuar desde tu panel.
            </p>
          </section>

          {/* 2. Lo único que se pide: nombre y contraseña. */}
          <section
            aria-labelledby="acceso-titulo"
            className="hoja-panel min-w-0 overflow-hidden rounded-2xl border border-regla bg-hoja"
          >
            <form onSubmit={crearAcceso} noValidate className="flex flex-col gap-4 px-5 py-6 sm:px-7 sm:py-7">
              <div>
                <h2 id="acceso-titulo" className="text-xl font-semibold text-tinta">
                  {datos.existingUser ? 'Elige una contraseña nueva' : 'Crea tu acceso'}
                </h2>
                <p className="mt-1 text-base text-tinta-2">
                  {datos.existingUser
                    ? `Ya tienes acceso al panel de ${datos.clientName}: desde ahora entrarás con tu correo y esta contraseña.`
                    : `Con tu correo y esta contraseña entrarás en el panel de ${datos.clientName}.`}
                </p>
              </div>

              {/* Para que el gestor de contraseñas guarde la cuenta con su usuario. */}
              <input type="email" name="username" autoComplete="username" value={datos.email} readOnly hidden />

              <div className="flex flex-col gap-1.5">
                <span className="rotulo">Correo electrónico</span>
                <p className="valor [overflow-wrap:anywhere] rounded-lg border border-regla bg-hoja-2 px-3 py-2 text-base text-tinta">
                  {datos.email}
                </p>
                <p className="text-sm text-tinta-3">Lo ha indicado {datos.brandName}: será tu usuario.</p>
              </div>

              <Input
                ref={refNombre}
                label="Tu nombre"
                autoComplete="name"
                maxLength={80}
                value={nombre}
                onChange={(e) => {
                  setError('');
                  setNombre(e.target.value);
                }}
                onBlur={() => tocar('nombre')}
                error={mostrar.nombre ? errores.nombre || undefined : undefined}
                className={TACTIL}
              />
              <CampoContrasena
                ref={refClave}
                label="Contraseña"
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
                onBlur={() => tocar('clave')}
                help={`Al menos ${MINIMO_CONTRASENA} caracteres. Una frase que recuerdes con facilidad funciona bien.`}
                error={mostrar.clave ? errores.clave || undefined : undefined}
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
                onBlur={() => tocar('repetida')}
                error={mostrar.repetida ? errores.repetida || undefined : undefined}
              />

              {otraSesion && (
                <p className="rounded-lg border border-regla bg-hoja-2 px-3 py-2 text-sm text-tinta-2">
                  Ahora tienes abierta la sesión de <span className="valor [overflow-wrap:anywhere]">{otraSesion.email}</span>. Al
                  crear tu acceso, en este navegador entrarás con la cuenta nueva.
                </p>
              )}
              {error && <AvisoError>{error}</AvisoError>}

              <Button type="submit" variant="principal" busy={enviando} className={`w-full ${TACTIL}`}>
                {datos.existingUser ? 'Guardar y empezar' : 'Crear mi acceso y empezar'}
              </Button>
              <p className="text-center text-sm text-tinta-3">
                Este enlace es personal y es válido hasta el {fechaLarga(datos.expiresAt)}.
              </p>
            </form>
          </section>
        </main>
      </div>
    </div>
  );
}

/* -------------------------------- Desenlaces ------------------------------- */

/**
 * Portada para los estados sin formulario: el logotipo y el nombre de la
 * instancia encima de una tarjeta centrada, como la de acceso.
 */
function Portada({ marca, children }: { marca?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-mesa px-4 py-10">
      <main className="w-full max-w-[28rem] animate-aparecer">
        {marca && (
          <div className="mb-6 flex items-center justify-center gap-3">
            <Logotipo />
            <span className="min-w-0 break-words text-lg font-semibold text-tinta">{marca}</span>
          </div>
        )}
        <section className="hoja-panel overflow-hidden rounded-2xl border border-regla bg-hoja">{children}</section>
      </main>
    </div>
  );
}

function Desenlace({
  final,
  marca,
  email,
  usuario,
}: {
  final: Final;
  marca: string;
  /** Solo se sabe si la invitación llegó a cargarse (el fallo vino al aceptar). */
  email?: string;
  usuario: User | null;
}) {
  // Con la sesión ya abierta (por ejemplo, tras crear el acceso en otra
  // pestaña), lo útil es ir al panel, no volver a iniciar sesión.
  const accion = usuario ? (
    <Link to="/" className={`w-full ${claseEnlaceBoton('principal')}`}>
      Ir a tu panel
    </Link>
  ) : (
    <Link to={IR_A_LOGIN} className={`w-full ${claseEnlaceBoton('principal')}`}>
      Iniciar sesión
    </Link>
  );

  const contenido: Record<Final, { titulo: string; texto: ReactNode; accion?: ReactNode; nota?: ReactNode }> = {
    invalido: {
      titulo: 'Este enlace ya no es válido',
      texto: (
        <>
          Puede que haya caducado o que se haya sustituido por uno más reciente. Pide a tu proveedor de correo,{' '}
          {marca}, que te envíe un enlace de bienvenida nuevo.
        </>
      ),
      nota: (
        <>
          ¿Ya creaste tu acceso?{' '}
          <Link to={IR_A_LOGIN} className="text-petroleo underline underline-offset-2 hover:text-tinta">
            Inicia sesión
          </Link>
          .
        </>
      ),
    },
    usado: {
      titulo: 'Este enlace ya se ha usado',
      texto: usuario
        ? `Tu acceso al panel ya está creado y tienes la sesión abierta como ${usuario.email}.`
        : 'Tu acceso al panel ya está creado. Inicia sesión con tu correo y la contraseña que elegiste.',
      accion,
      nota: 'Si no recuerdas la contraseña, pide a tu proveedor de correo que la restablezca.',
    },
    existe: {
      titulo: 'Ya tienes acceso al panel',
      texto: email ? (
        <>
          Ya hay un usuario del panel con el correo <span className="valor [overflow-wrap:anywhere] text-tinta">{email}</span>. Inicia
          sesión con él para continuar.
        </>
      ) : (
        'Ya hay un usuario del panel con tu correo. Inicia sesión con él para continuar.'
      ),
      accion,
      nota: 'Si no recuerdas la contraseña, pide a tu proveedor de correo que la restablezca.',
    },
    suspendido: {
      titulo: 'Cuenta suspendida',
      texto: `La cuenta de correo de tu empresa está suspendida y ahora no se puede crear el acceso. Ponte en contacto con ${marca}, tu proveedor de correo.`,
    },
  };
  const c = contenido[final];

  return (
    <Portada marca={marca}>
      <div className="flex flex-col gap-4 px-5 py-6 sm:px-7 sm:py-7">
        <div>
          <h1 className="text-xl font-semibold text-tinta">{c.titulo}</h1>
          <p className="mt-2 text-base text-tinta-2">{c.texto}</p>
        </div>
        {c.accion}
        {c.nota && <p className="text-sm text-tinta-3">{c.nota}</p>}
      </div>
    </Portada>
  );
}
