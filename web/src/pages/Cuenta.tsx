import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type User } from '../lib/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';
import { AvisoError, Hoja, Membrete } from '../ui/kit';
import { useToast } from '../ui/toast';

const LONGITUD_MINIMA = 10;

export default function Cuenta() {
  const toast = useToast();
  const queryClient = useQueryClient();
  // Ya está en caché (App la lee al arrancar): no genera otra petición.
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User | null }>('/api/auth/me'),
  });
  const user = me.data?.user ?? null;

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [intentado, setIntentado] = useState(false);

  const noCoinciden = repeat !== '' && newPassword !== repeat;
  const corta = newPassword !== '' && newPassword.length < LONGITUD_MINIMA;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setIntentado(true);
    if (!currentPassword || newPassword !== repeat || newPassword.length < LONGITUD_MINIMA) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/password', { currentPassword, newPassword });
      toast('ok', 'Contraseña actualizada. Se han cerrado las demás sesiones abiertas.');
      setCurrentPassword('');
      setNewPassword('');
      setRepeat('');
      setIntentado(false);
      // Si el servidor cerró también esta sesión, la aplicación lo detecta
      // aquí y lleva a la portada de acceso en lugar de fallar más tarde.
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se ha podido cambiar la contraseña. Comprueba la conexión e inténtalo de nuevo.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Membrete title="Mi cuenta" meta="Datos de acceso al panel." />
      <div className="flex max-w-2xl flex-col gap-4">
        {user && (
          <Hoja title="Identidad" flush>
            <dl>
              <FilaDato rotulo="Nombre">{user.name || '—'}</FilaDato>
              <FilaDato rotulo="Correo de acceso" valor>
                {user.email}
              </FilaDato>
              <FilaDato rotulo="Perfil">
                {user.role === 'admin' ? 'Administrador del servicio' : 'Usuario de cliente'}
              </FilaDato>
            </dl>
          </Hoja>
        )}

        {user?.passwordFromEnv ? (
          // La fija el entorno del panel: cambiarla aquí no duraría.
          <Hoja title="Contraseña">
            <div className="flex max-w-[68ch] flex-col gap-2 text-base text-tinta-2">
              <p>
                La contraseña de esta cuenta es la de la variable{' '}
                <span className="codigo text-sm text-tinta">MAILWAY_ADMIN_PASSWORD</span> del panel, y es siempre la que
                vale para entrar.
              </p>
              <p>
                Para cambiarla, edita esa variable en las variables del servicio del panel (en Skyway) y vuelve a
                desplegarlo. Si la quitas, podrás cambiarla aquí.
              </p>
            </div>
          </Hoja>
        ) : (
        <Hoja title="Cambiar contraseña">
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <Input
              label="Contraseña actual"
              type="password"
              required
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              error={intentado && !currentPassword ? 'Indica la contraseña actual.' : undefined}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Nueva contraseña"
                type="password"
                required
                minLength={LONGITUD_MINIMA}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                help={`Mínimo ${LONGITUD_MINIMA} caracteres.`}
                error={
                  intentado && (corta || newPassword === '')
                    ? `Debe tener al menos ${LONGITUD_MINIMA} caracteres.`
                    : undefined
                }
              />
              <Input
                label="Repite la nueva contraseña"
                type="password"
                required
                autoComplete="new-password"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
                error={
                  noCoinciden || (intentado && repeat === '' && newPassword !== '')
                    ? 'Las contraseñas no coinciden.'
                    : undefined
                }
              />
            </div>
            {error && <AvisoError>{error}</AvisoError>}
            <p className="text-sm text-tinta-3">
              Al cambiarla se cierran las demás sesiones abiertas con esta cuenta.
            </p>
            <Button type="submit" variant="principal" busy={busy} className="self-start">
              Cambiar contraseña
            </Button>
          </form>
        </Hoja>
        )}
      </div>
    </>
  );
}

function FilaDato({
  rotulo,
  valor = false,
  children,
}: {
  rotulo: string;
  valor?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-0.5 px-4 py-2.5 last:border-b-0">
      <dt className="rotulo basis-full sm:basis-40">{rotulo}</dt>
      <dd
        className={`min-w-0 flex-1 text-base text-tinta [overflow-wrap:anywhere] ${valor ? 'valor text-sm' : ''}`}
      >
        {children}
      </dd>
    </div>
  );
}
