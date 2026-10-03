import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, esCredencialIncorrecta, TEXTO_CREDENCIALES_INCORRECTAS, type User } from '../lib/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';
import { AvisoError, Logotipo } from '../ui/kit';


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
 * Portada de acceso: el logotipo y el nombre de la instancia encima de una
 * tarjeta centrada con el formulario, igual en escritorio y en el móvil.
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
    <div className="flex min-h-screen flex-col items-center justify-center bg-mesa px-4 py-10 sm:px-8">
      <main className="w-full max-w-[25rem] animate-aparecer">
        <div className="mb-6 flex items-center justify-center gap-3">
          <Logotipo />
          <span className="min-w-0 break-words text-lg font-semibold text-tinta">{brand}</span>
        </div>
        <section className="hoja-panel overflow-hidden rounded-2xl border border-regla bg-hoja">
          <form onSubmit={submit} noValidate className="flex flex-col gap-5 px-6 py-7 sm:px-8 sm:py-8">
            <div>
              <h1 className="text-2xl font-semibold text-tinta">Iniciar sesión</h1>
              <p className="mt-1 text-base text-tinta-2">Entra con tu correo para gestionar dominios, buzones y envíos.</p>
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
            <Button type="submit" variant="principal" busy={busy} className="w-full">
              Iniciar sesión
            </Button>
          </form>
        </section>

        <div className="mt-5 flex flex-col gap-2 text-center text-sm text-tinta-3">
          <p>
            ¿Eres titular de un buzón?{' '}
            <Link
              to="/mi-buzon"
              className="text-petroleo underline underline-offset-2 hover:text-tinta"
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
  );
}
