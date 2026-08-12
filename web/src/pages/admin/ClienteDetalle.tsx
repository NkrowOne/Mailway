import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Client, type DomainRecord, type Plan } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Input, Select } from '../../ui/Field';
import { Cargando, Dialogo, Encabezado, Estado, Medidor, Panel } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { formatDate } from '../../lib/format';

export default function ClienteDetalle() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  const client = useQuery({
    queryKey: ['client', id],
    queryFn: () => api.get<{ client: Client }>(`/api/clients/${id}`),
  });
  const plans = useQuery({
    queryKey: ['plans'],
    queryFn: () => api.get<{ plans: Plan[] }>('/api/plans'),
  });
  const domains = useQuery({
    queryKey: ['domains', id],
    queryFn: () => api.get<{ domains: DomainRecord[] }>(`/api/domains?clientId=${id}`),
  });

  const [userOpen, setUserOpen] = useState(false);
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [userPassword, setUserPassword] = useState('');
  const [userError, setUserError] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch(`/api/clients/${id}`, patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['client', id] });
      await queryClient.invalidateQueries({ queryKey: ['clients'] });
      toast('ok', 'Cliente actualizado.');
    },
    onError: (err) => toast('error', err instanceof ApiError ? err.message : 'No se pudo actualizar.'),
  });

  const createUser = useMutation({
    mutationFn: () =>
      api.post(`/api/clients/${id}/users`, {
        name: userName,
        email: userEmail,
        password: userPassword,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['client', id] });
      setUserOpen(false);
      setUserName('');
      setUserEmail('');
      setUserPassword('');
      setUserError('');
      toast('ok', 'Usuario creado. Entrégale sus credenciales por un canal seguro.');
    },
    onError: (err) => setUserError(err instanceof ApiError ? err.message : 'No se pudo crear.'),
  });

  const removeClient = useMutation({
    mutationFn: () => api.delete(`/api/clients/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['clients'] });
      toast('ok', 'Cliente eliminado.');
      navigate('/clientes');
    },
    onError: (err) => {
      setDeleteOpen(false);
      toast('error', err instanceof ApiError ? err.message : 'No se pudo eliminar.');
    },
  });

  if (client.isPending) return <Cargando />;
  if (client.isError || !client.data) {
    return (
      <p className="text-devuelto">
        Cliente no encontrado. <Link className="underline" to="/clientes">Volver</Link>
      </p>
    );
  }

  const data = client.data.client;
  const plan = data.plan!;
  const usage = data.usage!;
  const users = data.users ?? [];
  const domainList = domains.data?.domains ?? [];

  function submitUser(e: FormEvent) {
    e.preventDefault();
    createUser.mutate();
  }

  return (
    <>
      <Encabezado
        title={data.name}
        meta={
          <span className="flex items-center gap-2.5">
            {data.suspended ? (
              <Estado tone="devuelto">Suspendido</Estado>
            ) : (
              <Estado tone="entregado">Activo</Estado>
            )}
            {data.contactEmail && <span className="text-tinta-3">{data.contactEmail}</span>}
          </span>
        }
        actions={
          <>
            <Button variant="peligro" onClick={() => setDeleteOpen(true)}>Eliminar</Button>
            <Button
              onClick={() => update.mutate({ suspended: !data.suspended })}
              busy={update.isPending}
            >
              {data.suspended ? 'Reactivar' : 'Suspender'}
            </Button>
            <Button variant="accion" onClick={() => setUserOpen(true)}>Crear usuario de acceso</Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Plan y carga">
          <div className="flex flex-col gap-4">
            <Select
              label="Plan asignado"
              value={data.planId}
              onChange={(e) => update.mutate({ planId: e.target.value })}
            >
              {(plans.data?.plans ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.maxMailboxes} buzones, {p.apiDailyLimit} envíos/día
                </option>
              ))}
            </Select>
            <Medidor label="Dominios" used={usage.domains} max={plan.maxDomains} />
            <Medidor label="Buzones" used={usage.mailboxes} max={plan.maxMailboxes} />
            <Medidor label="Alias" used={usage.aliases} max={plan.maxAliases} />
            <p className="num text-sm text-tinta-3">
              {usage.messagesLast30d} envíos por API en los últimos 30 días
            </p>
          </div>
        </Panel>

        <Panel title="Usuarios con acceso al panel" flush>
          {users.length === 0 ? (
            <div className="px-4 py-6 text-sm text-tinta-3">
              Sin usuarios: este cliente aún no puede entrar. Crea su primer usuario con la
              tecla naranja.
            </div>
          ) : (
            <ul>
              {users.map((user) => (
                <li key={user.id} className="flex items-center gap-3 border-b border-suave px-4 py-2.5 last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-medium text-tinta">{user.name}</p>
                    <p className="truncate text-sm text-tinta-3">
                      {user.email} · último acceso {formatDate(user.lastLoginAt)}
                    </p>
                  </div>
                  {user.disabled && <Estado tone="devuelto">Deshabilitado</Estado>}
                  <UserActions clientId={id} userId={user.id} disabled={user.disabled} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Dominios del cliente" className="mt-4" flush>
        {domainList.length === 0 ? (
          <div className="px-4 py-6 text-sm text-tinta-3">
            Sin dominios. El cliente puede añadirlos desde su panel, o tú desde «Dominios».
          </div>
        ) : (
          <ul>
            {domainList.map((domain) => (
              <li key={domain.id} className="border-b border-suave last:border-0">
                <Link to={`/dominios/${domain.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-chasis-2">
                  <span className="min-w-0 flex-1 truncate font-guia text-sm">{domain.domain}</span>
                  {domain.status === 'active' ? (
                    <Estado tone="entregado">En reparto</Estado>
                  ) : (
                    <Estado tone="transito">DNS pendiente</Estado>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Crear usuario */}
      <Dialogo open={userOpen} onClose={() => setUserOpen(false)} title="Usuario de acceso al panel">
        <form onSubmit={submitUser} className="flex flex-col gap-4">
          <p className="text-sm text-tinta-2">
            Este usuario entrará al panel de {data.name} y podrá gestionar sus buzones,
            dominios y claves de API, dentro de los límites del plan.
          </p>
          <Input label="Nombre" required minLength={2} value={userName} onChange={(e) => setUserName(e.target.value)} />
          <Input label="Correo (será su usuario)" type="email" required value={userEmail} onChange={(e) => setUserEmail(e.target.value)} />
          <Input
            label="Contraseña"
            type="password"
            required
            minLength={10}
            value={userPassword}
            onChange={(e) => setUserPassword(e.target.value)}
            help="Mínimo 10 caracteres. Entrégasela por un canal seguro; podrá cambiarla al entrar."
          />
          {userError && (
            <p role="alert" className="rounded border border-[rgb(var(--devuelto)/0.4)] bg-[rgb(var(--devuelto)/0.08)] px-3 py-2 text-sm text-devuelto">
              {userError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="fantasma" onClick={() => setUserOpen(false)}>Cancelar</Button>
            <Button type="submit" variant="accion" busy={createUser.isPending}>Crear usuario</Button>
          </div>
        </form>
      </Dialogo>

      {/* Eliminar cliente */}
      <Dialogo open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Eliminar cliente">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-tinta-2">
            Solo se puede eliminar un cliente sin dominios (para no dejar buzones huérfanos).
            Sus usuarios de panel se eliminarán también.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="fantasma" onClick={() => setDeleteOpen(false)}>Cancelar</Button>
            <Button variant="peligro" busy={removeClient.isPending} onClick={() => removeClient.mutate()}>
              Eliminar cliente
            </Button>
          </div>
        </div>
      </Dialogo>
    </>
  );
}

function UserActions({ clientId, userId, disabled }: { clientId: string; userId: string; disabled: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const toggle = useMutation({
    mutationFn: () =>
      api.patch(`/api/clients/${clientId}/users/${userId}`, { disabled: !disabled }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['client', clientId] });
      toast('ok', disabled ? 'Usuario rehabilitado.' : 'Usuario deshabilitado.');
    },
    onError: (err) => toast('error', err instanceof ApiError ? err.message : 'No se pudo cambiar.'),
  });
  return (
    <Button variant="fantasma" className="h-8 px-2.5 text-sm" busy={toggle.isPending} onClick={() => toggle.mutate()}>
      {disabled ? 'Rehabilitar' : 'Deshabilitar'}
    </Button>
  );
}
