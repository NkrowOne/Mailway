import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError, type Client, type Plan } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Input, Select } from '../../ui/Field';
import { Cargando, Dialogo, Encabezado, Estado, Panel, Vacio } from '../../ui/kit';
import { useToast } from '../../ui/toast';

export default function Clientes() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [planId, setPlanId] = useState('');
  const [error, setError] = useState('');

  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: Client[] }>('/api/clients'),
  });
  const plans = useQuery({
    queryKey: ['plans'],
    queryFn: () => api.get<{ plans: Plan[] }>('/api/plans'),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ client: Client }>('/api/clients', { name, contactEmail, planId }),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['clients'] });
      setOpen(false);
      setName('');
      setContactEmail('');
      setError('');
      toast('ok', `Cliente ${data.client.name} creado. Ahora crea su usuario de acceso.`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'No se pudo crear.'),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  const list = clients.data?.clients ?? [];
  const planList = plans.data?.plans ?? [];

  return (
    <>
      <Encabezado
        title="Clientes"
        meta="Cada cliente tiene su propio panel, sus dominios y los límites de su plan."
        actions={
          <Button
            variant="accion"
            onClick={() => {
              setPlanId(planList[0]?.id ?? '');
              setOpen(true);
            }}
          >
            Nuevo cliente
          </Button>
        }
      />

      {clients.isPending ? (
        <Cargando />
      ) : list.length === 0 ? (
        <Panel>
          <Vacio
            title="Todavía no hay clientes"
            action={
              <Button variant="accion" onClick={() => { setPlanId(planList[0]?.id ?? ''); setOpen(true); }}>
                Crear el primero
              </Button>
            }
          >
            Crea un cliente (una empresa o proyecto), asígnale un plan y dale acceso a su
            propio panel de autogestión.
          </Vacio>
        </Panel>
      ) : (
        <Panel flush>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-suave text-sm text-tinta-3">
                <th className="px-4 py-2 font-medium">Cliente</th>
                <th className="hidden px-4 py-2 font-medium sm:table-cell">Plan</th>
                <th className="num hidden px-4 py-2 font-medium md:table-cell">Buzones</th>
                <th className="num hidden px-4 py-2 font-medium md:table-cell">Envíos 30 d</th>
                <th className="px-4 py-2 text-right font-medium">Estado</th>
              </tr>
            </thead>
            <tbody>
              {list.map((client) => (
                <tr key={client.id} className="border-b border-suave last:border-0 hover:bg-chasis-2">
                  <td className="px-4 py-2.5">
                    <Link to={`/clientes/${client.id}`} className="font-medium text-tinta hover:text-accion">
                      {client.name}
                    </Link>
                    {client.contactEmail && (
                      <p className="truncate text-sm text-tinta-3">{client.contactEmail}</p>
                    )}
                  </td>
                  <td className="hidden px-4 py-2.5 text-sm text-tinta-2 sm:table-cell">
                    {client.plan?.name ?? '—'}
                  </td>
                  <td className="num hidden px-4 py-2.5 font-guia text-sm text-tinta-2 md:table-cell">
                    {client.usage ? `${client.usage.mailboxes}/${client.plan?.maxMailboxes ?? '—'}` : '—'}
                  </td>
                  <td className="num hidden px-4 py-2.5 font-guia text-sm text-tinta-2 md:table-cell">
                    {client.usage?.messagesLast30d ?? 0}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {client.suspended ? (
                      <Estado tone="devuelto">Suspendido</Estado>
                    ) : (
                      <Estado tone="entregado">Activo</Estado>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Dialogo open={open} onClose={() => setOpen(false)} title="Nuevo cliente">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Input label="Nombre" required minLength={2} value={name} onChange={(e) => setName(e.target.value)} placeholder="Empresa o proyecto" />
          <Input label="Correo de contacto (opcional)" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="gerencia@empresa.com" />
          <Select
            label="Plan"
            required
            value={planId}
            onChange={(e) => setPlanId(e.target.value)}
            help={(() => {
              const plan = planList.find((p) => p.id === planId);
              return plan
                ? `${plan.maxDomains} dominio(s) · ${plan.maxMailboxes} buzones · ${plan.apiDailyLimit} envíos API/día`
                : undefined;
            })()}
          >
            {planList.map((plan) => (
              <option key={plan.id} value={plan.id}>{plan.name}</option>
            ))}
          </Select>
          {error && (
            <p role="alert" className="rounded border border-[rgb(var(--devuelto)/0.4)] bg-[rgb(var(--devuelto)/0.08)] px-3 py-2 text-sm text-devuelto">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="fantasma" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button type="submit" variant="accion" busy={create.isPending}>Crear cliente</Button>
          </div>
        </form>
      </Dialogo>
    </>
  );
}
