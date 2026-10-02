import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type BloqueVariables } from '../../lib/api';
import { formatDate, plural } from '../../lib/format';
import { mensajeDe, type AppPasswordInfo } from '../../lib/gestion';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { MarcaFondo, Midiendo, Muestra } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { VariablesIntegracion } from '../VariablesIntegracion';
import { BandaError } from './comun';

/**
 * Contraseñas de aplicación de un buzón: una por dispositivo o programa. Se
 * revocan una a una sin cambiar la contraseña principal, de modo que perder un
 * móvil no obliga a reconfigurar todo lo demás.
 */
export function ContrasenasAplicacion({
  mailboxId,
  email,
  onPendiente,
}: {
  mailboxId: string;
  email: string;
  /** Avisa de que hay una contraseña recién creada sin confirmar (la ficha no se cierra sin preguntar). */
  onPendiente?: (pendiente: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [nueva, setNueva] = useState<{ name: string; password: string; snippets: BloqueVariables[] } | null>(null);
  const [verVariables, setVerVariables] = useState(false);
  const [aRevocar, setARevocar] = useState<string | null>(null);
  const [verRevocadas, setVerRevocadas] = useState(false);
  const key = ['app-passwords', mailboxId];

  useEffect(() => {
    onPendiente?.(nueva !== null);
  }, [nueva, onPendiente]);
  // Al salir de la vista ya no hay nada pendiente que proteger.
  useEffect(() => () => onPendiente?.(false), [onPendiente]);

  const list = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ appPasswords: AppPasswordInfo[] }>(`/api/mailboxes/${mailboxId}/app-passwords`),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ appPassword: AppPasswordInfo; password: string; snippets?: BloqueVariables[] }>(
        `/api/mailboxes/${mailboxId}/app-passwords`,
        { name },
      ),
    onSuccess: async (data) => {
      setNueva({ name: data.appPassword.name, password: data.password, snippets: data.snippets ?? [] });
      setVerVariables(false);
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
    if (!name.trim()) {
      setError('Indica el nombre del dispositivo o la aplicación.');
      return;
    }
    create.mutate();
  }

  const items = list.data?.appPasswords ?? [];
  const activas = items.filter((i) => !i.revokedAt).length;
  // Las revocadas no caducan nunca de la lista: se pliegan para que las
  // activas, que son las que importan, no queden enterradas.
  const revocadas = items.filter((i) => i.revokedAt).length;
  const visibles = verRevocadas ? items : items.filter((i) => !i.revokedAt);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-base text-tinta-2">
        Crea una contraseña para cada dispositivo o aplicación (móvil, portátil, una aplicación que envía
        correo). Se introduce en lugar de la contraseña del buzón y se puede revocar por separado; la
        contraseña principal no cambia.
      </p>

      {nueva && (
        <div className="revelar flex flex-col gap-3">
          <p className="text-base text-tinta-2">
            Contraseña para «{nueva.name}».{' '}
            <strong className="font-semibold text-tinta">Solo se muestra ahora</strong>: introdúcela en el
            dispositivo como contraseña de la cuenta.
          </p>
          <Muestra rotulo="Usuario" copiar={email}>
            <p className="valor break-all text-base text-tinta">{email}</p>
          </Muestra>
          <Muestra rotulo="Contraseña de aplicación" copiar={nueva.password}>
            <p className="valor break-all text-base text-tinta">{nueva.password}</p>
          </Muestra>
          {nueva.snippets.length > 0 && (
            <div className="flex flex-col gap-3">
              {/* Plegado: casi siempre la contraseña es para un dispositivo; los
                  bloques son para quien conecta una aplicación por SMTP. */}
              <Button
                variant="plano"
                className="self-start px-2"
                aria-expanded={verVariables}
                onClick={() => setVerVariables((v) => !v)}
              >
                {verVariables ? 'Ocultar las variables' : 'Ver las variables para una aplicación (SMTP)'}
              </Button>
              {verVariables && (
                <>
                  <p className="text-sm text-tinta-2">
                    Bloques listos para copiar con esta contraseña: el <code className="valor">.env</code> la incluye
                    y el código de Node, Laravel y Django la lee del entorno. Tampoco se volverán a mostrar.
                  </p>
                  <VariablesIntegracion bloques={nueva.snippets} />
                </>
              )}
            </div>
          )}
          <Button variant="perfil" className="self-start" onClick={() => setNueva(null)}>
            Ya la he introducido
          </Button>
        </div>
      )}

      <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1">
          <Input
            label="Nombre del dispositivo o aplicación"
            maxLength={60}
            value={name}
            onChange={(e) => {
              setError('');
              setName(e.target.value);
            }}
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
          {list.isSuccess && <span className="rotulo">{plural(activas, 'activa', 'activas')}</span>}
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
            {visibles.length === 0 && (
              <li className="px-3 py-3 text-sm text-tinta-3">No hay contraseñas de aplicación activas.</li>
            )}
            {visibles.map((item) => (
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
        {revocadas > 0 && (
          <div className="border-t border-regla px-3 py-2">
            <Button variant="plano" className="px-2" aria-expanded={verRevocadas} onClick={() => setVerRevocadas((v) => !v)}>
              {verRevocadas ? 'Ocultar las revocadas' : `Mostrar las revocadas (${revocadas})`}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
