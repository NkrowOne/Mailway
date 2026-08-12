import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';

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
    <div className="flex min-h-screen items-center justify-center bg-mesa px-4 py-10">
      <div className="w-full max-w-[25rem] animate-aparecer">
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
              Entrar al panel
            </h1>
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
              <p
                role="alert"
                className="border border-[rgb(var(--fuera)/0.35)] bg-fuera-fondo px-3 py-2 text-sm text-fuera"
              >
                {error}
              </p>
            )}
            <Button type="submit" variant="tinta" busy={busy} className="w-full">
              Entrar
            </Button>
          </form>
        </section>

        <p className="mt-3 text-center text-sm text-tinta-3">
          ¿Sin acceso? Pídeselo al administrador de tu proveedor de correo.
        </p>
      </div>
    </div>
  );
}
