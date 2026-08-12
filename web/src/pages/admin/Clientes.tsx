import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError, type Client, type Plan } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Input, Select } from '../../ui/Field';
import { Dialogo, Escala, Hoja, MarcaFondo, Membrete, Midiendo, Vacio } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { plural } from '../../lib/format';

/**
 * Cartera de clientes: una fila por cliente, con el uso de buzones medido
 * contra el límite de su plan y el veredicto de servicio en el margen.
 */
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
      <Membrete
        title="Clientes"
        meta={
          <>
            <p>Cada cliente tiene su propio panel, sus dominios y los límites de su plan.</p>
            {!clients.isPending && list.length > 0 && (
              <p className="rotulo mt-1.5">{plural(list.length, 'cliente', 'clientes')}</p>
            )}
          </>
        }
        actions={
          <Button
            variant="tinta"
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
        <Hoja flush>
          <Midiendo label="Midiendo clientes…" />
        </Hoja>
      ) : list.length === 0 ? (
        <Hoja flush>
          <Vacio
            title="Todavía no hay clientes"
            action={
              <Button
                variant="perfil"
                onClick={() => {
                  setPlanId(planList[0]?.id ?? '');
                  setOpen(true);
                }}
              >
                Crear el primero
              </Button>
            }
          >
            Crea un cliente (una empresa o proyecto), asígnale un plan y dale acceso a su
            propio panel de autogestión.
          </Vacio>
        </Hoja>
      ) : (
        <Hoja flush>
          {/* Cabecera de columnas: en pantalla estrecha cada dato lleva su rótulo. */}
          <div className="regla-cabecera hidden items-baseline gap-x-4 px-4 py-2 sm:flex">
            <span className="rotulo min-w-0 grow basis-0">Cliente</span>
            <span className="rotulo w-24 shrink-0">Plan</span>
            <span className="rotulo w-44 shrink-0">Uso del plan</span>
            <span className="rotulo w-24 shrink-0 text-right">Envíos 30 d</span>
            <span className="rotulo w-28 shrink-0 text-right">Estado</span>
          </div>

          {list.map((client) => (
            <div
              key={client.id}
              className="regla-fila flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3
                transition-colors duration-100 last:border-b-0 hover:bg-hoja-2"
            >
              {/* El nombre identifica la fila: línea propia en móvil, sin truncar. */}
              <div className="min-w-0 grow basis-full sm:basis-0">
                <Link
                  to={`/clientes/${client.id}`}
                  className="break-words text-md font-medium text-tinta hover:text-laboratorio hover:underline"
                >
                  {client.name}
                </Link>
                {client.contactEmail && (
                  <p className="valor break-all text-sm text-tinta-3">{client.contactEmail}</p>
                )}
              </div>

              <div className="flex shrink-0 items-baseline gap-1.5 sm:w-24">
                <span className="rotulo sm:hidden">Plan</span>
                <span className="min-w-0 break-words text-sm text-tinta-2">
                  {client.plan?.name ?? '—'}
                </span>
              </div>

              <div className="basis-full sm:w-44 sm:shrink-0 sm:basis-auto">
                {client.usage && client.plan ? (
                  <Escala
                    label="Buzones"
                    usado={client.usage.mailboxes}
                    maximo={client.plan.maxMailboxes}
                  />
                ) : (
                  <div className="flex items-baseline gap-1.5">
                    <span className="rotulo">Uso del plan</span>
                    <span className="valor text-sm text-tinta-3">—</span>
                  </div>
                )}
              </div>

              <div className="flex shrink-0 items-baseline gap-1.5 sm:w-24 sm:justify-end">
                <span className="rotulo sm:hidden">Envíos 30 d</span>
                <span className="valor text-sm text-tinta-2">
                  {client.usage?.messagesLast30d ?? 0}
                </span>
              </div>

              <div className="shrink-0 sm:w-28 sm:text-right">
                {client.suspended ? (
                  <MarcaFondo veredicto="fuera">Suspendido</MarcaFondo>
                ) : (
                  <MarcaFondo veredicto="normal">Activo</MarcaFondo>
                )}
              </div>
            </div>
          ))}
        </Hoja>
      )}

      <Dialogo open={open} onClose={() => setOpen(false)} title="Nuevo cliente">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Input
            label="Nombre"
            required
            minLength={2}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Empresa o proyecto"
          />
          <Input
            label="Correo de contacto (opcional)"
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="gerencia@empresa.com"
          />
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
              <option key={plan.id} value={plan.id}>
                {plan.name}
              </option>
            ))}
          </Select>
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
              Crear cliente
            </Button>
          </div>
        </form>
      </Dialogo>
    </>
  );
}
