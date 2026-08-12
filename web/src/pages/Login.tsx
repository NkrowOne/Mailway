import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';

export default function Login({ brand }: { brand: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/login', { email, password });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo iniciar sesión.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm animate-aparecer">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span aria-hidden className="text-accion">
            <svg viewBox="0 0 22 14" className="h-4 w-[26px]">
              <path d="M1 1l6 6-6 6M9 1l6 6-6 6" stroke="currentColor" strokeWidth="2.4" fill="none" />
            </svg>
          </span>
          <span className="font-rotulo text-xl font-semibold uppercase tracking-[0.2em]">{brand}</span>
        </div>

        <form
          onSubmit={submit}
          className="flex flex-col gap-4 rounded-md border border-suave bg-chasis p-6"
        >
          <h1 className="font-rotulo text-lg font-semibold tracking-wide">Entrar a la central</h1>
          <Input
            label="Correo"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="tu@correo.com"
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
          {error && (
            <p role="alert" className="rounded border border-[rgb(var(--devuelto)/0.4)] bg-[rgb(var(--devuelto)/0.08)] px-3 py-2 text-sm text-devuelto">
              {error}
            </p>
          )}
          <Button type="submit" variant="accion" busy={busy} className="w-full">
            Entrar
          </Button>
        </form>

        <p className="mt-4 text-center text-sm text-tinta-3">
          ¿Sin acceso? Pídeselo al administrador de tu proveedor de correo.
        </p>
      </div>
    </div>
  );
}
