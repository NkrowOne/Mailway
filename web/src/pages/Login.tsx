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
    <div className="grid min-h-screen bg-mesa lg:grid-cols-[1.05fr_0.95fr]">
      <aside className="sidebar-lab relative hidden overflow-hidden p-12 text-white lg:flex lg:flex-col lg:justify-between xl:p-16">
        <div className="membrete-panel absolute inset-0 opacity-70" aria-hidden />
        <div className="relative flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white text-laboratorio">
            <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden><path d="M4 7.5 12 13l8-5.5M5 6h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></svg>
          </span>
          <span className="text-xl font-semibold">{brand}</span>
        </div>
        <div className="relative max-w-xl">
          <p className="text-sm font-medium text-laboratorio-vivo">Todo tu correo, en un solo lugar</p>
          <h2 className="mt-4 text-4xl font-semibold leading-[1.08] tracking-[-0.035em] xl:text-5xl">
            Gestiona dominios, buzones y entregas sin complicaciones.
          </h2>
          <p className="mt-5 max-w-lg text-lg leading-relaxed text-white/65">
            Una vista clara del estado de tu servicio y los siguientes pasos para mantenerlo funcionando bien.
          </p>
        </div>
        <p className="relative text-sm text-white/40">Correo profesional, bajo tu control.</p>
      </aside>
      <div className="flex items-center justify-center px-4 py-10 sm:px-8">
      <div className="w-full max-w-[27rem] animate-aparecer">
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

          <form onSubmit={submit} className="flex flex-col gap-5 px-6 py-7 sm:px-8 sm:py-8">
            <div>
              <h1 className="text-2xl font-semibold tracking-[-0.025em] text-tinta">Te damos la bienvenida</h1>
              <p className="mt-1 text-base text-tinta-2">Accede para gestionar tu servicio de correo.</p>
            </div>
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
              Iniciar sesión
            </Button>
          </form>
        </section>

        <p className="mt-4 text-center text-sm text-tinta-3">
          ¿Sin acceso? Pídeselo al administrador de tu proveedor de correo.
        </p>
      </div></div>
    </div>
  );
}
