import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Client, type DomainRecord, type Plan } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Input, Select } from '../../ui/Field';
import {
  Dialogo,
  Escala,
  Hoja,
  MarcaFondo,
  Membrete,
  Midiendo,
  Vacio,
} from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { formatDate, plural } from '../../lib/format';

/** Valores largos: se desplazan en horizontal, no se parten a mitad de palabra. */
const cinta =
  'block overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';

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

  if (client.isPending) {
    return (
      <Hoja>
        <Midiendo label="Leyendo la ficha del cliente…" />
      </Hoja>
    );
  }
  if (client.isError || !client.data) {
    return (
      <Hoja>
        <p role="alert" className="text-base text-tinta-2">
          <span className="text-fuera">Cliente no encontrado.</span>{' '}
          <Link className="text-laboratorio underline" to="/clientes">
            Volver
          </Link>
        </p>
      </Hoja>
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
      <Membrete
        title={data.name}
        meta={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <MarcaFondo veredicto={data.suspended ? 'fuera' : 'normal'}>
              {data.suspended ? 'Suspendido' : 'Activo'}
            </MarcaFondo>
            {data.contactEmail && (
              <span className={`valor min-w-0 text-sm text-tinta-3 ${cinta}`}>
                {data.contactEmail}
              </span>
            )}
          </span>
        }
        actions={
          <>
            <Button variant="peligro" onClick={() => setDeleteOpen(true)}>Eliminar</Button>
            <Button
              variant="perfil"
              onClick={() => update.mutate({ suspended: !data.suspended })}
              busy={update.isPending}
            >
              {data.suspended ? 'Reactivar' : 'Suspender'}
            </Button>
            <Button variant="tinta" onClick={() => setUserOpen(true)}>Crear usuario de acceso</Button>
          </>
        }
      />

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Hoja title="Plan y carga">
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
            <div className="flex flex-col gap-3">
              <Escala label="Dominios" usado={usage.domains} maximo={plan.maxDomains} />
              <Escala label="Buzones" usado={usage.mailboxes} maximo={plan.maxMailboxes} />
              <Escala label="Alias" usado={usage.aliases} maximo={plan.maxAliases} />
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-regla pt-3">
              <span className="text-base text-tinta">Envíos por API (últimos 30 días)</span>
              <span className="valor text-md text-tinta">{usage.messagesLast30d}</span>
            </div>
          </div>
        </Hoja>

        <Hoja
          title="Usuarios con acceso al panel"
          meta={plural(users.length, 'usuario', 'usuarios')}
          flush
        >
          {users.length === 0 ? (
            <Vacio title="Sin usuarios de acceso">
              Este cliente aún no puede entrar. Crea su primer usuario con «Crear usuario de
              acceso».
            </Vacio>
          ) : (
            <ul>
              {users.map((user) => (
                <li
                  key={user.id}
                  className="regla-fila flex flex-wrap items-baseline gap-x-3 gap-y-1.5 px-4 py-2.5
                    last:border-b-0"
                >
                  {/* Nombre y correo identifican la fila: nunca se recortan. */}
                  <div className="min-w-0 basis-full sm:basis-0 sm:grow">
                    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-base font-medium text-tinta">
                      {user.name}
                      {user.disabled && (
                        <MarcaFondo veredicto="fuera">Deshabilitado</MarcaFondo>
                      )}
                    </p>
                    <p className={`text-sm text-tinta-3 ${cinta}`}>
                      <span className="valor">{user.email}</span> · último acceso{' '}
                      {formatDate(user.lastLoginAt)}
                    </p>
                  </div>
                  <div className="ml-auto shrink-0 sm:ml-0">
                    <UserActions clientId={id} userId={user.id} disabled={user.disabled} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Hoja>
      </div>

      <Hoja
        title="Dominios del cliente"
        meta={
          domains.isPending ? 'midiendo…' : plural(domainList.length, 'dominio', 'dominios')
        }
        className="mt-4"
        flush
      >
        {domains.isPending ? (
          <Midiendo label="Leyendo los dominios del cliente…" />
        ) : domainList.length === 0 ? (
          <Vacio title="Sin dominios">
            El cliente puede añadirlos desde su panel, o tú desde «Dominios».
          </Vacio>
        ) : (
          <ul>
            {domainList.map((domain) => (
              <li key={domain.id} className="regla-fila last:border-b-0">
                <Link
                  to={`/dominios/${domain.id}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5
                    transition-colors duration-100 hover:bg-hoja-2"
                >
                  <span
                    className={`valor min-w-0 basis-full text-base text-tinta sm:basis-0 sm:grow ${cinta}`}
                  >
                    {domain.domain}
                  </span>
                  <span className="ml-auto shrink-0 sm:ml-0">
                    {domain.status === 'active' ? (
                      <MarcaFondo veredicto="normal">En reparto</MarcaFondo>
                    ) : (
                      <MarcaFondo veredicto={domain.lastCheckedAt ? 'fuera' : 'sin-dato'}>
                        {domain.lastCheckedAt ? 'DNS pendiente' : 'Sin medir'}
                      </MarcaFondo>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Hoja>

      {/* Crear usuario */}
      <Dialogo open={userOpen} onClose={() => setUserOpen(false)} title="Usuario de acceso al panel">
        <form onSubmit={submitUser} className="flex flex-col gap-4">
          <p className="text-base text-tinta-2">
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
            <p
              role="alert"
              className="border border-[rgb(var(--fuera)/0.4)] bg-fuera-fondo px-3 py-2 text-sm text-fuera"
            >
              {userError}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="plano" onClick={() => setUserOpen(false)}>Cancelar</Button>
            <Button type="submit" variant="tinta" busy={createUser.isPending}>Crear usuario</Button>
          </div>
        </form>
      </Dialogo>

      {/* Eliminar cliente */}
      <Dialogo open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Eliminar cliente">
        <div className="flex flex-col gap-4">
          <p className="text-base text-tinta-2">
            Solo se puede eliminar un cliente sin dominios (para no dejar buzones huérfanos).
            Sus usuarios de panel se eliminarán también.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="plano" onClick={() => setDeleteOpen(false)}>Cancelar</Button>
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
    <Button variant="plano" busy={toggle.isPending} onClick={() => toggle.mutate()}>
      {disabled ? 'Rehabilitar' : 'Deshabilitar'}
    </Button>
  );
}
