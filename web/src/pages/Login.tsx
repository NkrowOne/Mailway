import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, esCredencialIncorrecta, TEXTO_CREDENCIALES_INCORRECTAS, type User } from '../lib/api';
import { LayoutDashboard } from 'lucide-react';
import { IlustracionPanel } from '../components/Portadas';
import { CampoContrasena } from './bienvenida/CampoContrasena';
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
 * Entrada del panel de gestión. En escritorio, dos columnas: el formulario a
 * la izquierda y, a la derecha, un panel de gestión dibujado sobre el
 * petróleo de la marca; en el móvil, solo el formulario. Es a propósito muy
 * distinta de «Mi buzón» (tarjeta centrada con un móvil y un ordenador),
 * porque las dos viven en la misma dirección y se confundían.
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
  const [verContrasena, setVerContrasena] = useState(false);
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
    <div className="min-h-screen bg-hoja lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <main className="flex min-h-screen flex-col px-5 py-6 sm:px-10 sm:py-8 lg:px-14 xl:px-20">
        <div className="flex items-center gap-3">
          <Logotipo />
          <span className="min-w-0 break-words text-lg font-semibold text-tinta">{brand}</span>
        </div>

        {/* En el móvil, el formulario arriba (sin un hueco vacío encima); en
            pantallas mayores, centrado en la columna. */}
        <div className="flex flex-1 items-start pb-10 pt-12 sm:items-center sm:py-14">
          <div className="w-full max-w-[24rem] animate-aparecer lg:mx-auto">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-petroleo-claro px-2.5 py-1 text-sm font-semibold text-petroleo">
              <LayoutDashboard className="h-4 w-4" aria-hidden />
              Panel de gestión
            </span>
            <h1 className="mt-4 text-3xl font-semibold tracking-[-0.015em] text-tinta">Iniciar sesión</h1>
            <p className="mt-2 text-base text-tinta-2">Dominios, buzones y envíos de tu servicio de correo.</p>

            <form onSubmit={submit} noValidate className="mt-8 flex flex-col gap-5">
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
                className="min-h-11 sm:min-h-0"
              />
              <CampoContrasena
                label="Contraseña"
                autoComplete="current-password"
                value={password}
                visible={verContrasena}
                onAlternar={() => setVerContrasena((v) => !v)}
                onChange={(e) => {
                  setError('');
                  setPassword(e.target.value);
                }}
              />
              {error && <AvisoError>{error}</AvisoError>}
              <Button type="submit" variant="principal" busy={busy} className="mt-1 min-h-11 w-full sm:min-h-0">
                Iniciar sesión
              </Button>
            </form>

            <div className="mt-8 flex flex-col gap-3 border-t border-regla pt-6 text-sm text-tinta-3">
              <p>
                ¿Buscas tu buzón de correo?{' '}
                <Link to="/mi-buzon" className="font-medium text-petroleo underline underline-offset-2 hover:text-tinta">
                  Entra en «Mi buzón»
                </Link>
                .
              </p>
              <p>¿Has olvidado la contraseña? Ponte en contacto con quien administra tu servicio de correo.</p>
            </div>
          </div>
        </div>
      </main>

      {/* Solo en escritorio: el formulario manda en el móvil. */}
      <aside
        aria-hidden
        className="relative hidden overflow-hidden lg:flex lg:items-center lg:justify-center"
        style={{
          background:
            'radial-gradient(120% 80% at 85% 0%, rgb(122 211 200 / 0.28), transparent 55%), radial-gradient(90% 70% at 0% 100%, rgb(6 43 41 / 0.55), transparent 60%), linear-gradient(160deg, #0f6a6c, #0d5c5e 45%, #083f41)',
        }}
      >
        <IlustracionPanel className="w-[min(82%,34rem)] drop-shadow-[0_30px_60px_rgb(3_30_29_/_0.45)]" />
      </aside>
    </div>
  );
}
