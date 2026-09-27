import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { mensajeDe, type AppPasswordInfo } from '../../lib/gestion';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { MarcaFondo, Midiendo, Muestra } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { BandaError } from './comun';

/**
 * Contraseñas de aplicación de un buzón: una por dispositivo o programa. Se
 * revocan una a una sin cambiar la contraseña principal, de modo que perder un
 * móvil no obliga a reconfigurar todo lo demás.
 */
export function ContrasenasAplicacion({ mailboxId, email }: { mailboxId: string; email: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [nueva, setNueva] = useState<{ name: string; password: string } | null>(null);
  const [aRevocar, setARevocar] = useState<string | null>(null);
  const key = ['app-passwords', mailboxId];

  const list = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ appPasswords: AppPasswordInfo[] }>(`/api/mailboxes/${mailboxId}/app-passwords`),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ appPassword: AppPasswordInfo; password: string }>(`/api/mailboxes/${mailboxId}/app-passwords`, {
        name,
      }),
    onSuccess: async (data) => {
      setNueva({ name: data.appPassword.name, password: data.password });
      setName('');
      setError('');
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido crear la contraseña de aplicación.')),
  });

  const revoke = useMutation({
    mutationFn: (appId: string) => api.delete(`/api/mailboxes/${mailboxId}/app-passwords/${appId}`),
    onSuccess: async () => {
      setARevocar(null);
      await queryClient.invalidateQueries({ queryKey: key });
      toast('ok', 'Contraseña de aplicación revocada.');
    },
    onError: (err) => toast('error', mensajeDe(err, 'No se ha podido revocar la contraseña.')),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  const items = list.data?.appPasswords ?? [];
  const activas = items.filter((i) => !i.revokedAt).length;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-base text-tinta-2">
        Cree una contraseña para cada dispositivo o aplicación (móvil, portátil, una aplicación que envía
        correo). Se introduce en lugar de la contraseña del buzón y se puede revocar por separado; la
        contraseña principal no cambia.
      </p>

      {nueva && (
        <div className="revelar flex flex-col gap-3">
          <p className="text-base text-tinta-2">
            Contraseña para «{nueva.name}».{' '}
            <strong className="font-semibold text-tinta">Solo se muestra ahora</strong>: introdúzcala en el
            dispositivo como contraseña de la cuenta.
          </p>
          <Muestra rotulo="Usuario" copiar={email}>
            <p className="valor break-all text-base text-tinta">{email}</p>
          </Muestra>
          <Muestra rotulo="Contraseña de aplicación" copiar={nueva.password}>
            <p className="valor break-all text-base text-tinta">{nueva.password}</p>
          </Muestra>
          <Button variant="perfil" className="self-start" onClick={() => setNueva(null)}>
            Ya la he introducido
          </Button>
        </div>
      )}

      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1">
          <Input
            label="Nombre del dispositivo o aplicación"
            required
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Móvil de Ana"
          />
        </div>
        <Button type="submit" variant="tinta" busy={create.isPending}>
          Crear contraseña
        </Button>
      </form>
      {error && <BandaError>{error}</BandaError>}

      <div className="border border-regla">
        <div className="regla-cabecera flex items-baseline justify-between gap-3 px-3 py-2">
          <span className="rotulo">Contraseñas creadas</span>
          {list.isSuccess && <span className="rotulo">{activas} activas</span>}
        </div>
        {list.isPending ? (
          <Midiendo label="Consultando las contraseñas de aplicación…" />
        ) : list.isError ? (
          <div className="p-3">
            <BandaError onRetry={() => void list.refetch()}>
              {mensajeDe(list.error, 'No se han podido cargar las contraseñas de aplicación.')}
            </BandaError>
          </div>
        ) : items.length === 0 ? (
          <p className="px-3 py-4 text-sm text-tinta-3">Este buzón no tiene contraseñas de aplicación.</p>
        ) : (
          <ul className="max-h-72 overflow-y-auto">
            {items.map((item) => (
              <li key={item.id} className="regla-fila flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 last:border-b-0">
                <div className="min-w-0 grow basis-full sm:basis-0">
                  <p className="break-words text-base text-tinta">{item.name}</p>
                  <p className="text-sm text-tinta-3">
                    Creada <span className="valor">{formatDate(item.createdAt)}</span>
                    {item.revokedAt && (
                      <>
                        {' '}
                        · revocada <span className="valor">{formatDate(item.revokedAt)}</span>
                      </>
                    )}
                  </p>
                </div>
                {item.revokedAt ? (
                  <MarcaFondo veredicto="sin-dato">Revocada</MarcaFondo>
                ) : aRevocar === item.id ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm text-tinta-2">El dispositivo que la use dejará de conectarse.</span>
                    <Button variant="plano" className="px-2" onClick={() => setARevocar(null)}>
                      Cancelar
                    </Button>
                    <Button variant="peligro" className="px-2" busy={revoke.isPending} onClick={() => revoke.mutate(item.id)}>
                      Revocar
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <MarcaFondo veredicto="normal">Activa</MarcaFondo>
                    <Button variant="plano" className="px-2" onClick={() => setARevocar(item.id)}>
                      Revocar
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
