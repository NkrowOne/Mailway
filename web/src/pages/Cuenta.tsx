import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';
import { Encabezado, Panel } from '../ui/kit';
import { useToast } from '../ui/toast';

export default function Cuenta() {
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (newPassword !== repeat) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/password', { currentPassword, newPassword });
      toast('ok', 'Contraseña actualizada. El resto de sesiones se han cerrado.');
      setCurrentPassword('');
      setNewPassword('');
      setRepeat('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cambiar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Encabezado title="Mi cuenta" meta="Tu acceso al panel." />
      <Panel title="Cambiar contraseña" className="max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Input
            label="Contraseña actual"
            type="password"
            required
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
          <Input
            label="Nueva contraseña"
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            help="Mínimo 10 caracteres."
          />
          <Input
            label="Repite la nueva contraseña"
            type="password"
            required
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
          {error && (
            <p role="alert" className="rounded border border-[rgb(var(--devuelto)/0.4)] bg-[rgb(var(--devuelto)/0.08)] px-3 py-2 text-sm text-devuelto">
              {error}
            </p>
          )}
          <Button type="submit" variant="accion" busy={busy} className="self-start">
            Cambiar contraseña
          </Button>
        </form>
      </Panel>
    </>
  );
}
