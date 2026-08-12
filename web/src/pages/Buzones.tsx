import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type ConnectionInfo, type DomainRecord, type Mailbox } from '../lib/api';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import {
  Dialogo,
  Hoja,
  MarcaFondo,
  Membrete,
  Midiendo,
  Muestra,
  Vacio,
} from '../ui/kit';
import { useToast } from '../ui/toast';
import { formatMb, plural } from '../lib/format';

/**
 * Registro de buzones: una tabla reglada agrupada por dominio. Cada fila es un
 * buzón medido — dirección, cuota y veredicto de servicio.
 */
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

  /** Credencial recién generada: se enseña UNA vez, como una muestra recortable. */
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

  const cargando = mailboxes.isPending || domains.isPending;

  return (
    <>
      <Membrete
        title="Buzones"
        meta={
          <>
            <p>Cuentas de correo reales con IMAP, SMTP y webmail.</p>
            {!cargando && list.length > 0 && (
              <p className="rotulo mt-1.5">
                {plural(list.length, 'buzón', 'buzones')} ·{' '}
                {plural(grouped.length, 'dominio', 'dominios')}
              </p>
            )}
          </>
        }
        actions={
          <Button
            variant="tinta"
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

      {cargando ? (
        <Hoja flush>
          <Midiendo label="Midiendo buzones…" />
        </Hoja>
      ) : domainList.length === 0 ? (
        <Hoja flush>
          <Vacio title="Primero necesitas un dominio">
            Da de alta un dominio en la pestaña «Dominios»; después podrás crear buzones
            como nombre@tudominio.com.
          </Vacio>
        </Hoja>
      ) : list.length === 0 ? (
        <Hoja flush>
          <Vacio
            title="Aún no hay buzones"
            action={
              <Button
                variant="perfil"
                onClick={() => {
                  setDomainId(domainList[0]?.id ?? '');
                  setCreateOpen(true);
                }}
              >
                Crear el primero
              </Button>
            }
          >
            Crea cuentas como hola@{domainList[0]?.domain}. La contraseña se genera sola y
            se muestra una única vez.
          </Vacio>
        </Hoja>
      ) : (
        <Hoja flush>
          {/* Cabecera de columnas: en pantalla estrecha cada dato lleva su rótulo. */}
          <div className="regla-cabecera hidden items-baseline gap-x-4 px-4 py-2 sm:flex">
            <span className="rotulo min-w-0 grow basis-0">Buzón</span>
            <span className="rotulo w-24 shrink-0">Cuota</span>
            <span className="rotulo w-28 shrink-0">Estado</span>
            <span className="rotulo shrink-0 text-right">Acciones</span>
          </div>

          {grouped.map(([domainName, group]) => (
            <div key={domainName}>
              <div className="regla-fila flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 bg-hoja-3 px-4 py-1.5">
                <span className="valor break-all text-sm font-medium text-tinta">{domainName}</span>
                <span className="rotulo">{plural(group.length, 'buzón', 'buzones')}</span>
              </div>

              {group.map((mailbox) => (
                <div
                  key={mailbox.id}
                  className="regla-fila flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5
                    transition-colors duration-100 last:border-b-0 hover:bg-hoja-2"
                >
                  {/* El dato que identifica la fila: línea propia en móvil, nunca truncado. */}
                  <div className="min-w-0 grow basis-full sm:basis-0">
                    <p className="valor break-all text-base text-tinta">{mailbox.email}</p>
                    <p className="text-sm text-tinta-3">
                      {mailbox.displayName || 'Sin nombre visible'}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-baseline gap-1.5 sm:w-24">
                    <span className="rotulo sm:hidden">Cuota</span>
                    <span className="valor text-sm text-tinta-2">{formatMb(mailbox.quotaMb)}</span>
                  </div>

                  <div className="shrink-0 sm:w-28">
                    {mailbox.status === 'suspended' ? (
                      <MarcaFondo veredicto="fuera">Suspendido</MarcaFondo>
                    ) : (
                      <MarcaFondo veredicto="normal">Activo</MarcaFondo>
                    )}
                  </div>

                  <div className="flex w-full flex-wrap items-center gap-1 sm:w-auto sm:justify-end">
                    <Button
                      variant="plano"
                      className="px-2"
                      onClick={() => void showConnection(mailbox)}
                    >
                      Conexión
                    </Button>
                    <Button
                      variant="plano"
                      className="px-2"
                      busy={resetPassword.isPending && resetPassword.variables?.id === mailbox.id}
                      onClick={() => resetPassword.mutate(mailbox)}
                    >
                      Nueva contraseña
                    </Button>
                    <Button
                      variant="plano"
                      className="px-2"
                      onClick={() => suspend.mutate(mailbox)}
                    >
                      {mailbox.status === 'active' ? 'Suspender' : 'Reactivar'}
                    </Button>
                    <Button variant="peligro" className="px-2" onClick={() => setToDelete(mailbox)}>
                      Eliminar
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </Hoja>
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
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[10rem] flex-1">
              <Input
                label="Nombre del buzón"
                required
                mono
                value={localPart}
                onChange={(e) => setLocalPart(e.target.value)}
                placeholder="hola"
              />
            </div>
            <span className="valor break-all pb-2.5 text-sm text-tinta-3">
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
            <p
              role="alert"
              className="border border-[rgb(var(--fuera)/0.4)] bg-fuera-fondo px-3 py-2 text-sm text-fuera"
            >
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="plano" onClick={() => setCreateOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="tinta" busy={create.isPending}>
              Crear buzón
            </Button>
          </div>
        </form>
      </Dialogo>

      {/* Credencial: una sola lectura */}
      <Dialogo open={revealed !== null} onClose={() => setRevealed(null)} title="Credenciales del buzón">
        {revealed && (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2">
              Esta contraseña <strong className="font-semibold text-tinta">solo se muestra ahora</strong>.
              Entrégasela al usuario del buzón por un canal seguro.
            </p>
            <Muestra rotulo="Usuario" copiar={revealed.email}>
              <p className="valor break-all text-base text-tinta">{revealed.email}</p>
            </Muestra>
            <Muestra rotulo="Contraseña" copiar={revealed.password}>
              <p className="valor break-all text-base text-tinta">{revealed.password}</p>
            </Muestra>
            <Button variant="tinta" onClick={() => setRevealed(null)}>
              Ya la he guardado
            </Button>
          </div>
        )}
      </Dialogo>

      {/* Datos de conexión */}
      <Dialogo open={connection !== null} onClose={() => setConnection(null)} title="Configurar en un dispositivo">
        {connection && (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2">
              Para Thunderbird, Outlook, iPhone o Android. Usuario y contraseña son los del
              buzón (el usuario es la dirección completa).
            </p>
            <Muestra rotulo="Usuario" copiar={connection.username}>
              <p className="valor break-all text-base text-tinta">{connection.username}</p>
            </Muestra>
            <div className="border border-regla bg-hoja-2">
              <FilaConexion
                rotulo="Entrante (IMAP)"
                valor={`${connection.imap.host} · ${connection.imap.port} · ${connection.imap.security}`}
              />
              <FilaConexion
                rotulo="Saliente (SMTP)"
                valor={`${connection.smtp.host} · ${connection.smtp.port} · ${connection.smtp.security}`}
              />
              <FilaConexion
                rotulo="Alternativa SMTP"
                valor={`${connection.smtpAlt.host} · ${connection.smtpAlt.port} · ${connection.smtpAlt.security}`}
              />
            </div>
            {connection.webmailUrl && (
              <a href={connection.webmailUrl} target="_blank" rel="noreferrer" className="self-start">
                <Button variant="perfil">Abrir webmail</Button>
              </a>
            )}
          </div>
        )}
      </Dialogo>

      {/* Confirmar borrado */}
      <Dialogo open={toDelete !== null} onClose={() => setToDelete(null)} title="Eliminar buzón">
        {toDelete && (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2">
              Se eliminará <strong className="valor break-all font-medium text-tinta">{toDelete.email}</strong>{' '}
              y todo el correo que contiene, también del motor. No hay vuelta atrás.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="plano" onClick={() => setToDelete(null)}>
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

/** Fila de un ajuste de conexión: rótulo a la izquierda, valor exacto a la derecha. */
function FilaConexion({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="regla-fila flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2 last:border-b-0">
      <span className="rotulo">{rotulo}</span>
      <span className="valor break-all text-sm text-tinta">{valor}</span>
    </div>
  );
}
