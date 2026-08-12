import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Alias as AliasType, type DomainRecord, type Mailbox } from '../lib/api';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import { Dialogo, Hoja, Membrete, Midiendo, Vacio } from '../ui/kit';
import { useToast } from '../ui/toast';
import { plural } from '../lib/format';

/**
 * Alias: tabla reglada de dos columnas de valores — la dirección que recibe y
 * los buzones a los que reparte.
 */
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
      <Membrete
        title="Alias"
        meta={
          <>
            <p>Direcciones de reenvío: lo que llega a un alias se reparte a buzones reales.</p>
            {!aliases.isPending && list.length > 0 && (
              <p className="rotulo mt-1.5">{plural(list.length, 'alias', 'alias')} en servicio</p>
            )}
          </>
        }
        actions={
          <Button
            variant="tinta"
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
        <Hoja flush>
          <Midiendo label="Midiendo alias…" />
        </Hoja>
      ) : list.length === 0 ? (
        <Hoja flush>
          <Vacio title="Sin alias todavía">
            Un alias como ventas@tudominio.com puede repartir a varios buzones a la vez,
            sin ocupar plaza de buzón. Necesitas al menos un buzón de destino.
          </Vacio>
        </Hoja>
      ) : (
        <Hoja flush>
          <div className="regla-cabecera hidden items-baseline gap-x-4 px-4 py-2 sm:flex">
            <span className="rotulo min-w-0 grow basis-0">Alias</span>
            <span className="rotulo min-w-0 grow-[1.4] basis-0">Reparte a</span>
            <span className="rotulo shrink-0 text-right">Acciones</span>
          </div>

          {list.map((alias) => (
            <div
              key={alias.id}
              className="regla-fila flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-2.5
                transition-colors duration-100 last:border-b-0 hover:bg-hoja-2"
            >
              {/* La dirección identifica la fila: línea propia en móvil, sin truncar. */}
              <p className="valor min-w-0 grow basis-full break-all text-base text-tinta sm:basis-0">
                {alias.email}
              </p>

              <div className="min-w-0 grow-[1.4] basis-full sm:basis-0">
                <span className="rotulo sm:hidden">Reparte a</span>
                <ul>
                  {alias.destinations.map((destination) => (
                    <li key={destination} className="valor break-all text-sm text-tinta-2">
                      {destination}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex w-full justify-end sm:w-auto">
                <Button variant="peligro" className="px-2" onClick={() => setToDelete(alias)}>
                  Eliminar
                </Button>
              </div>
            </div>
          ))}
        </Hoja>
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
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[10rem] flex-1">
              <Input
                label="Nombre del alias"
                required
                mono
                value={localPart}
                onChange={(e) => setLocalPart(e.target.value)}
                placeholder="ventas"
              />
            </div>
            <span className="valor break-all pb-2.5 text-sm text-tinta-3">
              @{domainList.find((d) => d.id === domainId)?.domain || '…'}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {destinations.map((dest, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <div className="min-w-[10rem] flex-1">
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
                    variant="plano"
                    aria-label={`Quitar destino ${i + 1}`}
                    onClick={() => setDestinations(destinations.filter((_, j) => j !== i))}
                  >
                    Quitar
                  </Button>
                )}
              </div>
            ))}
            {destinations.length < 10 && (
              <Button
                type="button"
                variant="plano"
                className="self-start px-2"
                onClick={() => setDestinations([...destinations, ''])}
              >
                Añadir otro destino
              </Button>
            )}
          </div>
          {error && (
            <p
              role="alert"
              className="border border-[rgb(var(--fuera)/0.4)] bg-fuera-fondo px-3 py-2 text-sm text-fuera"
            >
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="plano" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="tinta" busy={create.isPending}>
              Crear alias
            </Button>
          </div>
        </form>
      </Dialogo>

      <Dialogo open={toDelete !== null} onClose={() => setToDelete(null)} title="Eliminar alias">
        {toDelete && (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2">
              El alias <strong className="valor break-all font-medium text-tinta">{toDelete.email}</strong>{' '}
              dejará de repartir correo. Los buzones de destino no se tocan.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="plano" onClick={() => setToDelete(null)}>
                Cancelar
              </Button>
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
