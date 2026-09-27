import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type User } from '../lib/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';
import { AvisoError } from '../ui/kit';

/**
 * Dirección con la que se abrió la aplicación. Se captura al cargar el módulo,
 * antes de que el enrutador redirija a /login y la pierda: así, quien abre un
 * enlace guardado sin sesión vuelve a él tras entrar.
 */
const enlaceDeArranque =
  typeof window !== 'undefined'
    ? `${window.location.pathname}${window.location.search}${window.location.hash}`
    : '/';

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

function destinoTrasEntrar(search: string, state: unknown): string {
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
 * Portada del parte: la mesa clara y, encima, la hoja con su membrete.
 * Sin fondos decorativos: aquí solo se identifica el laboratorio y se entra.
 */
export default function Login({ brand }: { brand: string }) {
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
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{ user?: User }>('/api/auth/login', { email, password });
      const destino = destinoTrasEntrar(location.search, location.state);
      // Caché limpia: si antes hubo otra sesión en esta pestaña (caducada, o
      // de otra persona), sus datos no deben asomar en la cuenta nueva. Se
      // conserva el estado público de la instalación para no recargarlo.
      const setup = queryClient.getQueryData(['setup']);
      queryClient.clear();
      if (setup) queryClient.setQueryData(['setup'], setup);
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
        err instanceof ApiError
          ? err.message
          : 'No se pudo iniciar sesión. Compruebe la conexión e inténtelo de nuevo.',
      );
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-mesa px-4 py-10">
      <main className="w-full max-w-[25rem] animate-aparecer">
        <section className="border border-regla bg-hoja">
          {/* Membrete de la hoja: quién firma el parte. */}
          <header className="border-b-2 border-b-[rgb(var(--laboratorio))] px-5 py-4">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <svg viewBox="0 0 22 16" className="h-4 w-[22px] shrink-0 text-laboratorio" aria-hidden>
                <path d="M1 13h20" stroke="currentColor" strokeWidth="1.6" />
                <path d="M4 13V7M9 13V3M14 13V9M19 13V5" stroke="currentColor" strokeWidth="1.6" />
              </svg>
              <span className="min-w-0 break-words font-estrecha text-lg font-semibold uppercase tracking-[0.14em] text-tinta">
                {brand}
              </span>
            </div>
          </header>

          <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-5">
            <h1 className="font-estrecha text-xl font-semibold uppercase tracking-[0.04em] text-tinta">
              Acceso al panel
            </h1>
            {trasSalir && (
              <p role="status" className="text-sm text-tinta-2">
                Ha cerrado la sesión.
              </p>
            )}
            <Input
              label="Correo electrónico"
              type="email"
              autoComplete="username"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="nombre@empresa.com"
            />
            <Input
              label="Contraseña"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••"
            />
            {error && <AvisoError>{error}</AvisoError>}
            <Button type="submit" variant="tinta" busy={busy} className="w-full">
              Entrar
            </Button>
          </form>
        </section>

        <div className="mt-3 flex flex-col gap-1.5 text-center text-sm text-tinta-3">
          <p>
            ¿Es titular de un buzón?{' '}
            <Link
              to="/mi-buzon"
              className="text-laboratorio underline underline-offset-2 hover:text-tinta"
            >
              Acceda a Mi buzón
            </Link>{' '}
            para configurar sus dispositivos o cambiar la contraseña.
          </p>
          <p>
            ¿No tiene acceso o ha olvidado la contraseña? Solicítelo al administrador de su
            proveedor de correo.
          </p>
        </div>
      </main>
    </div>
  );
}
