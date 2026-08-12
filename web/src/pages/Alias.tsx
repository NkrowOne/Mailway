import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Alias as AliasType, type DomainRecord, type Mailbox } from '../lib/api';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import { Cargando, Dialogo, Encabezado, Panel, Vacio } from '../ui/kit';
import { useToast } from '../ui/toast';

export default function Alias() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [domainId, setDomainId] = useState('');
  const [localPart, setLocalPart] = useState('');
  const [destinations, setDestinations] = useState<string[]>(['']);
  const [error, setError] = useState('');
  const [toDelete, setToDelete] = useState<AliasType | null>(null);

  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ domains: DomainRecord[] }>('/api/domains'),
  });
  const aliases = useQuery({
    queryKey: ['aliases'],
    queryFn: () => api.get<{ aliases: AliasType[] }>('/api/aliases'),
  });
  const mailboxes = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => api.get<{ mailboxes: Mailbox[] }>('/api/mailboxes'),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/aliases', {
        domainId,
        localPart,
        destinations: destinations.map((d) => d.trim()).filter(Boolean),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['aliases'] });
      setOpen(false);
      setLocalPart('');
      setDestinations(['']);
      setError('');
      toast('ok', 'Alias creado.');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'No se pudo crear.'),
  });

  const remove = useMutation({
    mutationFn: (alias: AliasType) => api.delete(`/api/aliases/${alias.id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['aliases'] });
      setToDelete(null);
      toast('ok', 'Alias eliminado.');
    },
    onError: (err) => {
      setToDelete(null);
      toast('error', err instanceof ApiError ? err.message : 'No se pudo eliminar.');
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  const domainList = domains.data?.domains ?? [];
  const list = aliases.data?.aliases ?? [];
  const mailboxOptions = mailboxes.data?.mailboxes ?? [];

  return (
    <>
      <Encabezado
        title="Alias"
        meta="Direcciones de reenvío: lo que llega a un alias se reparte a buzones reales."
        actions={
          <Button
            variant="accion"
            disabled={domainList.length === 0 || mailboxOptions.length === 0}
            onClick={() => {
              setDomainId(domainList[0]?.id ?? '');
              setOpen(true);
            }}
          >
            Crear alias
          </Button>
        }
      />

      {aliases.isPending ? (
        <Cargando />
      ) : list.length === 0 ? (
        <Panel>
          <Vacio title="Sin alias todavía">
            Un alias como ventas@tudominio.com puede repartir a varios buzones a la vez,
            sin ocupar plaza de buzón. Necesitas al menos un buzón de destino.
          </Vacio>
        </Panel>
      ) : (
        <Panel flush>
          <ul>
            {list.map((alias) => (
              <li
                key={alias.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-suave px-4 py-2.5 last:border-0"
              >
                <span className="min-w-0 flex-1 truncate font-guia text-sm text-tinta">{alias.email}</span>
                <span aria-hidden className="text-accion">
                  <svg viewBox="0 0 16 12" className="h-2.5 w-3.5">
                    <path d="M1 1l5 5-5 5M8 1l5 5-5 5" stroke="currentColor" strokeWidth="1.8" fill="none" />
                  </svg>
                </span>
                <span className="min-w-0 flex-[2] truncate text-sm text-tinta-2">
                  {alias.destinations.join(', ')}
                </span>
                <Button variant="peligro" className="h-8 px-2.5 text-sm" onClick={() => setToDelete(alias)}>
                  Eliminar
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Dialogo open={open} onClose={() => setOpen(false)} title="Crear alias">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Select label="Dominio" required value={domainId} onChange={(e) => setDomainId(e.target.value)}>
            {domainList.map((domain) => (
              <option key={domain.id} value={domain.id}>
                {domain.domain}
              </option>
            ))}
          </Select>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Input label="Nombre del alias" required mono value={localPart} onChange={(e) => setLocalPart(e.target.value)} placeholder="ventas" />
            </div>
            <span className="pb-2 font-guia text-sm text-tinta-3">
              @{domainList.find((d) => d.id === domainId)?.domain || '…'}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {destinations.map((dest, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="flex-1">
                  <Select
                    label={i === 0 ? 'Reparte a' : `Destino ${i + 1}`}
                    required={i === 0}
                    value={dest}
                    onChange={(e) => {
                      const next = [...destinations];
                      next[i] = e.target.value;
                      setDestinations(next);
                    }}
                  >
                    <option value="">Elige un buzón…</option>
                    {mailboxOptions.map((mailbox) => (
                      <option key={mailbox.id} value={mailbox.email}>
                        {mailbox.email}
                      </option>
                    ))}
                  </Select>
                </div>
                {destinations.length > 1 && (
                  <Button
                    type="button"
                    variant="fantasma"
                    className="h-9"
                    aria-label={`Quitar destino ${i + 1}`}
                    onClick={() => setDestinations(destinations.filter((_, j) => j !== i))}
                  >
                    Quitar
                  </Button>
                )}
              </div>
            ))}
            {destinations.length < 10 && (
              <Button type="button" variant="fantasma" className="self-start" onClick={() => setDestinations([...destinations, ''])}>
                Añadir otro destino
              </Button>
            )}
          </div>
          {error && (
            <p role="alert" className="rounded border border-[rgb(var(--devuelto)/0.4)] bg-[rgb(var(--devuelto)/0.08)] px-3 py-2 text-sm text-devuelto">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="fantasma" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="accion" busy={create.isPending}>
              Crear alias
            </Button>
          </div>
        </form>
      </Dialogo>

      <Dialogo open={toDelete !== null} onClose={() => setToDelete(null)} title="Eliminar alias">
        {toDelete && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-tinta-2">
              El alias <strong className="break-all font-guia text-tinta">{toDelete.email}</strong>{' '}
              dejará de repartir correo. Los buzones de destino no se tocan.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="fantasma" onClick={() => setToDelete(null)}>Cancelar</Button>
              <Button variant="peligro" busy={remove.isPending} onClick={() => remove.mutate(toDelete)}>
                Eliminar
              </Button>
            </div>
          </div>
        )}
      </Dialogo>
    </>
  );
}
