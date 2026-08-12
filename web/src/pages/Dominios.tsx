import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError, type Client, type DomainRecord } from '../lib/api';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import { Cargando, Dialogo, Encabezado, Estado, Panel, Vacio } from '../ui/kit';
import { useToast } from '../ui/toast';
import { formatDate } from '../lib/format';

export default function Dominios({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [domainName, setDomainName] = useState('');
  const [clientId, setClientId] = useState('');
  const [error, setError] = useState('');

  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ domains: DomainRecord[] }>('/api/domains'),
  });
  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: Client[] }>('/api/clients'),
    enabled: isAdmin,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ domain: DomainRecord }>('/api/domains', {
        domain: domainName,
        clientId: isAdmin ? clientId : undefined,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['domains'] });
      setOpen(false);
      setDomainName('');
      setError('');
      toast('ok', 'Dominio dado de alta. Ahora configura su DNS.');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'No se pudo crear.'),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  const list = domains.data?.domains ?? [];

  return (
    <>
      <Encabezado
        title="Dominios"
        meta="Cada dominio pasa por la aduana del DNS antes de entrar en reparto."
        actions={
          <Button variant="accion" onClick={() => setOpen(true)}>
            Añadir dominio
          </Button>
        }
      />

      {domains.isPending ? (
        <Cargando />
      ) : list.length === 0 ? (
        <Panel>
          <Vacio
            title="Aún no hay dominios"
            action={
              <Button variant="accion" onClick={() => setOpen(true)}>
                Añadir el primero
              </Button>
            }
          >
            Da de alta un dominio (por ejemplo, miempresa.com) para empezar a crear buzones
            con esa dirección.
          </Vacio>
        </Panel>
      ) : (
        <Panel flush>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-suave text-sm text-tinta-3">
                <th className="px-4 py-2 font-medium">Dominio</th>
                <th className="hidden px-4 py-2 font-medium sm:table-cell">DNS</th>
                <th className="hidden px-4 py-2 font-medium md:table-cell">Última verificación</th>
                <th className="px-4 py-2 text-right font-medium">Estado</th>
              </tr>
            </thead>
            <tbody>
              {list.map((domain) => {
                const requiredOk = domain.dnsStatus.requiredOk ?? 0;
                const requiredTotal = domain.dnsStatus.requiredTotal ?? 0;
                return (
                  <tr key={domain.id} className="group border-b border-suave last:border-0 hover:bg-chasis-2">
                    <td className="px-4 py-2.5">
                      <Link to={`/dominios/${domain.id}`} className="font-guia text-sm text-tinta hover:text-accion">
                        {domain.domain}
                      </Link>
                    </td>
                    <td className="num hidden px-4 py-2.5 font-guia text-sm text-tinta-2 sm:table-cell">
                      {requiredTotal > 0 ? `${requiredOk}/${requiredTotal}` : '—'}
                    </td>
                    <td className="hidden px-4 py-2.5 text-sm text-tinta-3 md:table-cell">
                      {formatDate(domain.lastCheckedAt)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {domain.status === 'active' ? (
                        <Estado tone="entregado">En reparto</Estado>
                      ) : (
                        <Estado tone="transito">DNS pendiente</Estado>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      )}

      <Dialogo open={open} onClose={() => setOpen(false)} title="Añadir dominio">
        <form onSubmit={submit} className="flex flex-col gap-4">
          {isAdmin && (
            <Select
              label="Cliente propietario"
              required
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              <option value="">Elige un cliente…</option>
              {(clients.data?.clients ?? []).map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </Select>
          )}
          <Input
            label="Dominio"
            required
            mono
            value={domainName}
            onChange={(e) => setDomainName(e.target.value)}
            placeholder="miempresa.com"
            help="Sin «http://» ni «www». Debes poder editar su DNS en tu proveedor (Cloudflare, IONOS…)."
          />
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
              Dar de alta
            </Button>
          </div>
        </form>
      </Dialogo>
    </>
  );
}
