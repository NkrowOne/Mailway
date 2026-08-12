import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type ConnectionInfo, type DomainRecord, type Mailbox } from '../lib/api';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import {
  Barcode,
  BotonCopiar,
  Cargando,
  Dialogo,
  Encabezado,
  Estado,
  Etiqueta,
  Panel,
  Vacio,
} from '../ui/kit';
import { useToast } from '../ui/toast';
import { formatMb } from '../lib/format';

export default function Buzones() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ domains: DomainRecord[] }>('/api/domains'),
  });
  const mailboxes = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => api.get<{ mailboxes: Mailbox[] }>('/api/mailboxes'),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [localPart, setLocalPart] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [domainId, setDomainId] = useState('');
  const [customPassword, setCustomPassword] = useState('');
  const [error, setError] = useState('');

  /** Credencial recién generada: se enseña UNA vez, impresa en etiqueta. */
  const [revealed, setRevealed] = useState<{ email: string; password: string } | null>(null);
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [toDelete, setToDelete] = useState<Mailbox | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ mailbox: Mailbox; password?: string }>('/api/mailboxes', {
        domainId,
        localPart,
        displayName,
        password: customPassword || undefined,
      }),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
      await queryClient.invalidateQueries({ queryKey: ['client-dashboard'] });
      setCreateOpen(false);
      setLocalPart('');
      setDisplayName('');
      setCustomPassword('');
      setError('');
      if (data.password) {
        setRevealed({ email: data.mailbox.email, password: data.password });
      } else {
        toast('ok', `Buzón ${data.mailbox.email} creado.`);
      }
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'No se pudo crear.'),
  });

  const resetPassword = useMutation({
    mutationFn: (mailbox: Mailbox) =>
      api
        .post<{ password?: string }>(`/api/mailboxes/${mailbox.id}/password`, {})
        .then((r) => ({ mailbox, password: r.password })),
    onSuccess: ({ mailbox, password }) => {
      if (password) setRevealed({ email: mailbox.email, password });
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se pudo restablecer.'),
  });

  const suspend = useMutation({
    mutationFn: (mailbox: Mailbox) =>
      api.patch(`/api/mailboxes/${mailbox.id}`, {
        status: mailbox.status === 'active' ? 'suspended' : 'active',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
      toast('ok', 'Estado del buzón actualizado.');
    },
    onError: (err) => toast('error', err instanceof ApiError ? err.message : 'No se pudo cambiar.'),
  });

  const remove = useMutation({
    mutationFn: (mailbox: Mailbox) => api.delete(`/api/mailboxes/${mailbox.id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
      await queryClient.invalidateQueries({ queryKey: ['client-dashboard'] });
      setToDelete(null);
      toast('ok', 'Buzón eliminado.');
    },
    onError: (err) => {
      setToDelete(null);
      toast('error', err instanceof ApiError ? err.message : 'No se pudo eliminar.');
    },
  });

  async function showConnection(mailbox: Mailbox) {
    try {
      const info = await api.get<ConnectionInfo>(`/api/mailboxes/${mailbox.id}/connection`);
      setConnection(info);
    } catch {
      toast('error', 'No se pudieron cargar los datos de conexión.');
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  const domainList = domains.data?.domains ?? [];
  const list = mailboxes.data?.mailboxes ?? [];
  const grouped = useMemo(() => {
    const groups = new Map<string, Mailbox[]>();
    for (const mailbox of list) {
      const group = groups.get(mailbox.domain) || [];
      group.push(mailbox);
      groups.set(mailbox.domain, group);
    }
    return [...groups.entries()];
  }, [list]);

  return (
    <>
      <Encabezado
        title="Buzones"
        meta="Cuentas de correo reales con IMAP, SMTP y webmail."
        actions={
          <Button
            variant="accion"
            onClick={() => {
              setDomainId(domainList[0]?.id ?? '');
              setCreateOpen(true);
            }}
            disabled={domainList.length === 0}
          >
            Crear buzón
          </Button>
        }
      />

      {mailboxes.isPending || domains.isPending ? (
        <Cargando />
      ) : domainList.length === 0 ? (
        <Panel>
          <Vacio title="Primero necesitas un dominio">
            Da de alta un dominio en la pestaña «Dominios»; después podrás crear buzones
            como nombre@tudominio.com.
          </Vacio>
        </Panel>
      ) : list.length === 0 ? (
        <Panel>
          <Vacio
            title="Aún no hay buzones"
            action={
              <Button variant="accion" onClick={() => { setDomainId(domainList[0]?.id ?? ''); setCreateOpen(true); }}>
                Crear el primero
              </Button>
            }
          >
            Crea cuentas como hola@{domainList[0]?.domain}. La contraseña se genera sola y
            se muestra una única vez.
          </Vacio>
        </Panel>
      ) : (
        <div className="flex flex-col gap-4">
          {grouped.map(([domainName, group]) => (
            <Panel
              key={domainName}
              title={<span className="font-guia text-sm font-bold">{domainName}</span>}
              flush
            >
              <ul>
                {group.map((mailbox) => (
                  <li
                    key={mailbox.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-suave px-4 py-2.5 last:border-0"
                  >
                    <span className="hidden text-tinta-3 sm:block">
                      <Barcode seed={mailbox.email} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-guia text-sm text-tinta">{mailbox.email}</p>
                      <p className="truncate text-sm text-tinta-3">
                        {mailbox.displayName || 'Sin nombre visible'} · {formatMb(mailbox.quotaMb)}
                      </p>
                    </div>
                    {mailbox.status === 'suspended' && <Estado tone="devuelto">Suspendido</Estado>}
                    <div className="flex items-center gap-1">
                      <Button variant="fantasma" className="h-8 px-2.5 text-sm" onClick={() => void showConnection(mailbox)}>
                        Conexión
                      </Button>
                      <Button
                        variant="fantasma"
                        className="h-8 px-2.5 text-sm"
                        busy={resetPassword.isPending && resetPassword.variables?.id === mailbox.id}
                        onClick={() => resetPassword.mutate(mailbox)}
                      >
                        Nueva contraseña
                      </Button>
                      <Button
                        variant="fantasma"
                        className="h-8 px-2.5 text-sm"
                        onClick={() => suspend.mutate(mailbox)}
                      >
                        {mailbox.status === 'active' ? 'Suspender' : 'Reactivar'}
                      </Button>
                      <Button
                        variant="peligro"
                        className="h-8 px-2.5 text-sm"
                        onClick={() => setToDelete(mailbox)}
                      >
                        Eliminar
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
        </div>
      )}

      {/* Crear buzón */}
      <Dialogo open={createOpen} onClose={() => setCreateOpen(false)} title="Crear buzón">
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
              <Input
                label="Nombre del buzón"
                required
                mono
                value={localPart}
                onChange={(e) => setLocalPart(e.target.value)}
                placeholder="hola"
              />
            </div>
            <span className="pb-2 font-guia text-sm text-tinta-3">
              @{domainList.find((d) => d.id === domainId)?.domain || '…'}
            </span>
          </div>
          <Input
            label="Nombre visible (opcional)"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Equipo de soporte"
          />
          <Input
            label="Contraseña (opcional)"
            type="password"
            minLength={10}
            value={customPassword}
            onChange={(e) => setCustomPassword(e.target.value)}
            help="Déjala vacía para generar una segura automáticamente (se muestra una sola vez)."
          />
          {error && (
            <p role="alert" className="rounded border border-[rgb(var(--devuelto)/0.4)] bg-[rgb(var(--devuelto)/0.08)] px-3 py-2 text-sm text-devuelto">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="fantasma" onClick={() => setCreateOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="accion" busy={create.isPending}>
              Crear buzón
            </Button>
          </div>
        </form>
      </Dialogo>

      {/* Credencial impresa: una sola vez */}
      <Dialogo open={revealed !== null} onClose={() => setRevealed(null)} title="Credenciales del buzón">
        {revealed && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-tinta-2">
              Esta contraseña <strong className="text-tinta">solo se muestra ahora</strong>.
              Entrégasela al usuario del buzón por un canal seguro.
            </p>
            <Etiqueta>
              <dl className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <dt className="text-micro font-semibold uppercase tracking-[0.1em] text-[rgb(var(--etiqueta-tinta)/0.55)]">Usuario</dt>
                    <dd className="break-all font-guia text-sm">{revealed.email}</dd>
                  </div>
                  <BotonCopiar text={revealed.email} />
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-[rgb(var(--etiqueta-borde))] pt-2">
                  <div className="min-w-0">
                    <dt className="text-micro font-semibold uppercase tracking-[0.1em] text-[rgb(var(--etiqueta-tinta)/0.55)]">Contraseña</dt>
                    <dd className="break-all font-guia text-sm">{revealed.password}</dd>
                  </div>
                  <BotonCopiar text={revealed.password} />
                </div>
              </dl>
            </Etiqueta>
            <Button variant="accion" onClick={() => setRevealed(null)}>
              Ya la he guardado
            </Button>
          </div>
        )}
      </Dialogo>

      {/* Datos de conexión */}
      <Dialogo open={connection !== null} onClose={() => setConnection(null)} title="Configurar en un dispositivo">
        {connection && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-tinta-2">
              Para Thunderbird, Outlook, iPhone o Android. Usuario y contraseña son los del
              buzón (el usuario es la dirección completa).
            </p>
            <Etiqueta>
              <dl className="grid gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-2">
                <ConnectionRow label="Entrante (IMAP)" value={`${connection.imap.host} · ${connection.imap.port} · ${connection.imap.security}`} />
                <ConnectionRow label="Saliente (SMTP)" value={`${connection.smtp.host} · ${connection.smtp.port} · ${connection.smtp.security}`} />
                <ConnectionRow label="Usuario" value={connection.username} copy />
                <ConnectionRow label="Alternativa SMTP" value={`${connection.smtpAlt.host} · ${connection.smtpAlt.port} · ${connection.smtpAlt.security}`} />
              </dl>
            </Etiqueta>
            {connection.webmailUrl && (
              <a href={connection.webmailUrl} target="_blank" rel="noreferrer" className="self-start">
                <Button>Abrir webmail</Button>
              </a>
            )}
          </div>
        )}
      </Dialogo>

      {/* Confirmar borrado */}
      <Dialogo open={toDelete !== null} onClose={() => setToDelete(null)} title="Eliminar buzón">
        {toDelete && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-tinta-2">
              Se eliminará <strong className="break-all font-guia text-tinta">{toDelete.email}</strong>{' '}
              y todo el correo que contiene, también del motor. No hay vuelta atrás.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="fantasma" onClick={() => setToDelete(null)}>
                Cancelar
              </Button>
              <Button variant="peligro" busy={remove.isPending} onClick={() => remove.mutate(toDelete)}>
                Eliminar definitivamente
              </Button>
            </div>
          </div>
        )}
      </Dialogo>
    </>
  );
}

function ConnectionRow({ label, value, copy = false }: { label: string; value: string; copy?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <dt className="text-micro font-semibold uppercase tracking-[0.1em] text-[rgb(var(--etiqueta-tinta)/0.55)]">
          {label}
        </dt>
        <dd className="break-all font-guia text-sm">{value}</dd>
      </div>
      {copy && <BotonCopiar text={value} />}
    </div>
  );
}
