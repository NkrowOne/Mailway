import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, esCredencialIncorrecta, TEXTO_CREDENCIALES_INCORRECTAS, type User } from '../lib/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';
import { AvisoError } from '../ui/kit';


/**
 * Solo rutas internas del panel: nada de `//otro-sitio` ni URL absolutas, que
 * convertirían el enlace de acceso en una redirección abierta.
 */
function destinoSeguro(valor: unknown): string | null {
  if (typeof valor !== 'string' || !valor.startsWith('/')) return null;
  if (valor.startsWith('//') || valor.startsWith('/\\')) return null;
  const ruta = valor.split(/[?#]/)[0] ?? '';
  if (ruta === '/' || ruta === '/login' || ruta === '/setup') return null;
  return valor;
}

interface EstadoAcceso {
  /** Ubicación desde la que se redirigió a /login (patrón de react-router). */
  from?: string | { pathname?: string; search?: string; hash?: string };
  /** Se llega tras cerrar sesión: no se vuelve al enlace de arranque. */
  salida?: boolean;
}

function destinoTrasEntrar(search: string, state: unknown, enlaceDeArranque: string): string {
  const estado = (state ?? {}) as EstadoAcceso;
  const desdeEstado =
    typeof estado.from === 'string'
      ? estado.from
      : estado.from
        ? `${estado.from.pathname ?? ''}${estado.from.search ?? ''}${estado.from.hash ?? ''}`
        : null;
  return (
    destinoSeguro(new URLSearchParams(search).get('next')) ??
    destinoSeguro(desdeEstado) ??
    (estado.salida ? null : destinoSeguro(enlaceDeArranque)) ??
    '/'
  );
}

/**
 * Portada de acceso. En escritorio, el campo de identidad con la ilustración
 * del servidor de correo a la izquierda; la hoja de acceso, a la derecha. En
 * el móvil solo queda la hoja, con la marca en su cabecera.
 */
export default function Login({
  brand,
  enlaceDeArranque = '/',
}: {
  brand: string;
  /** Dirección con la que se abrió la aplicación (ver lib/arranque.ts). */
  enlaceDeArranque?: string;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const trasSalir = Boolean((location.state as EstadoAcceso | null)?.salida);

  useEffect(() => {
    document.title = `Acceso · ${brand}`;
  }, [brand]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Indica el correo electrónico y la contraseña.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{ user?: User }>('/api/auth/login', { email, password });
      const destino = destinoTrasEntrar(location.search, location.state, enlaceDeArranque);
      // Caché limpia: si antes hubo otra sesión en esta pestaña (caducada, o
      // de otra persona), sus datos no deben asomar en la cuenta nueva. Se
      // conserva el estado público de la instalación para no recargarlo.
      const setup = queryClient.getQueryData(['setup']);
      queryClient.clear();
      if (setup) queryClient.setQueryData(['setup'], setup);
      // Sin sesión el estado de la instalación llega recortado (solo la
      // marca); con la sesión recién abierta se vuelve a leer completo.
      void queryClient.invalidateQueries({ queryKey: ['setup'] });
      if (res?.user) {
        queryClient.setQueryData(['me'], { user: res.user });
      } else {
        await queryClient.fetchQuery({
          queryKey: ['me'],
          queryFn: () => api.get<{ user: User | null }>('/api/auth/me'),
        });
      }
      navigate(destino, { replace: true });
    } catch (err) {
      setError(
        esCredencialIncorrecta(err)
          ? TEXTO_CREDENCIALES_INCORRECTAS
          : err instanceof ApiError
            ? err.message
            : 'No se ha podido iniciar sesión. Comprueba la conexión y vuelve a intentarlo.',
      );
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen bg-mesa lg:grid-cols-[1.05fr_0.95fr]">
      <aside className="sidebar-lab relative hidden overflow-hidden p-12 text-white lg:flex lg:flex-col lg:justify-between xl:p-16">
        <div className="membrete-panel absolute inset-0 opacity-70" aria-hidden />
        <div className="relative flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-laboratorio">
            <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden>
              <path
                d="M4 7.5 12 13l8-5.5M5 6h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="min-w-0 break-words text-xl font-semibold">{brand}</span>
        </div>
        <div className="relative max-w-xl">
          <p className="text-sm font-medium text-laboratorio-vivo">Todo tu correo, en un solo lugar</p>
          {/* Lema, no encabezado: el título de la página es el <h1> del formulario. */}
          <p className="mt-4 text-4xl font-semibold leading-[1.08] tracking-[-0.035em] xl:text-5xl">
            Gestiona dominios, buzones y entregas sin complicaciones.
          </p>
          <p className="mt-5 max-w-lg text-lg leading-relaxed text-white/65">
            Una vista clara del estado de tu servicio y los siguientes pasos para mantenerlo funcionando bien.
          </p>
          <img
            src="/mail-server.png"
            alt=""
            aria-hidden
            className="mt-4 h-56 w-full object-contain object-left-bottom xl:h-72"
          />
        </div>
        <p className="relative text-sm text-white/60">Correo profesional, bajo tu control.</p>
      </aside>
      <div className="flex items-center justify-center px-4 py-10 sm:px-8">
        <main className="w-full max-w-[27rem] animate-aparecer">
          <section className="hoja-panel overflow-hidden rounded-2xl border border-regla bg-hoja">
            {/* Membrete de la hoja: quién firma el parte. */}
            <header className="border-b border-regla px-6 py-5 lg:hidden">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <svg viewBox="0 0 22 16" className="h-4 w-[22px] shrink-0 text-laboratorio" aria-hidden>
                  <path d="M1 13h20" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M4 13V7M9 13V3M14 13V9M19 13V5" stroke="currentColor" strokeWidth="1.6" />
                </svg>
                <span className="min-w-0 break-words text-lg font-semibold tracking-[-0.02em] text-tinta">
                  {brand}
                </span>
              </div>
            </header>

            <form onSubmit={submit} noValidate className="flex flex-col gap-5 px-6 py-7 sm:px-8 sm:py-8">
              <div>
                <h1 className="text-2xl font-semibold tracking-[-0.025em] text-tinta">Te damos la bienvenida</h1>
                <p className="mt-1 text-base text-tinta-2">Accede para gestionar tu servicio de correo.</p>
              </div>
              {trasSalir && (
                <p role="status" className="text-sm text-tinta-2">
                  Has cerrado la sesión.
                </p>
              )}
              <Input
                label="Correo electrónico"
                type="email"
                autoComplete="username"
                autoFocus
                value={email}
                onChange={(e) => {
                  setError('');
                  setEmail(e.target.value);
                }}
                placeholder="nombre@empresa.com"
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
                placeholder="••••••••••"
              />
              {error && <AvisoError>{error}</AvisoError>}
              <Button type="submit" variant="tinta" busy={busy} className="w-full">
                Iniciar sesión
              </Button>
            </form>
          </section>

          <div className="mt-4 flex flex-col gap-1.5 text-center text-sm text-tinta-3">
            <p>
              ¿Eres titular de un buzón?{' '}
              <Link
                to="/mi-buzon"
                className="text-laboratorio underline underline-offset-2 hover:text-tinta"
              >
                Accede a «Mi buzón»
              </Link>{' '}
              para configurar tus dispositivos o cambiar la contraseña.
            </p>
            <p>
              ¿No tienes acceso o has olvidado la contraseña? Ponte en contacto con el administrador de tu
              proveedor de correo.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
