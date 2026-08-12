import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  type ApiKeyInfo,
  type Client,
  type Mailbox,
  type Message,
  type User,
} from '../lib/api';
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
  Sello,
  Vacio,
} from '../ui/kit';
import { useToast } from '../ui/toast';
import { formatDate } from '../lib/format';

/** Claves de API + historial de envíos + guía de integración (OTP y avisos). */
export default function ApiKeys({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const isAdmin = user.role === 'admin';

  const keys = useQuery({
    queryKey: ['apikeys'],
    queryFn: () => api.get<{ keys: ApiKeyInfo[] }>('/api/apikeys'),
  });
  const mailboxes = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => api.get<{ mailboxes: Mailbox[] }>('/api/mailboxes'),
  });
  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: Client[] }>('/api/clients'),
    enabled: isAdmin,
  });
  const messages = useQuery({
    queryKey: ['messages'],
    queryFn: () => api.get<{ messages: Message[] }>('/api/messages?limit=50'),
    refetchInterval: 30_000,
  });

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [senderMailboxId, setSenderMailboxId] = useState('');
  const [clientId, setClientId] = useState('');
  const [error, setError] = useState('');
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [toRevoke, setToRevoke] = useState<ApiKeyInfo | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ key: string; info: ApiKeyInfo }>('/api/apikeys', {
        name,
        senderMailboxId,
        clientId: isAdmin ? clientId || undefined : undefined,
      }),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['apikeys'] });
      setOpen(false);
      setName('');
      setError('');
      setRevealedKey(data.key);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'No se pudo crear.'),
  });

  const revoke = useMutation({
    mutationFn: (key: ApiKeyInfo) => api.delete(`/api/apikeys/${key.id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['apikeys'] });
      setToRevoke(null);
      toast('ok', 'Clave revocada. Los envíos con ella quedarán rechazados.');
    },
    onError: (err) => {
      setToRevoke(null);
      toast('error', err instanceof ApiError ? err.message : 'No se pudo revocar.');
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  const keyList = keys.data?.keys ?? [];
  const mailboxList = mailboxes.data?.mailboxes ?? [];
  const messageList = messages.data?.messages ?? [];
  const senderOptions = isAdmin && clientId
    ? mailboxList // el backend valida la pertenencia; el admin ve todos
    : mailboxList;

  const curlExample = `curl -X POST https://TU-PANEL/v1/send \\
  -H "Authorization: Bearer mw_TU_CLAVE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "cliente@ejemplo.com",
    "subject": "Tu código de acceso",
    "html": "<p>Tu código es <strong>482913</strong>. Caduca en 10 minutos.</p>"
  }'`;

  return (
    <>
      <Encabezado
        title="API de envío"
        meta="Envíos automatizados desde tus aplicaciones: códigos OTP, avisos, facturas."
        actions={
          <Button
            variant="accion"
            disabled={mailboxList.length === 0}
            onClick={() => {
              setSenderMailboxId(mailboxList[0]?.id ?? '');
              setOpen(true);
            }}
          >
            Nueva clave
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        {keys.isPending ? (
          <Cargando />
        ) : keyList.length === 0 ? (
          <Panel>
            <Vacio title="Sin claves de API">
              {mailboxList.length === 0
                ? 'Crea antes un buzón: cada clave envía en nombre de un buzón remitente (p. ej. noreply@tudominio.com).'
                : 'Crea una clave para que tu aplicación envíe correo con una sola llamada HTTP.'}
            </Vacio>
          </Panel>
        ) : (
          <Panel title="Claves" flush>
            <ul>
              {keyList.map((key) => (
                <li
                  key={key.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-suave px-4 py-2.5 last:border-0"
                >
                  <span className="text-tinta-3">
                    <Barcode seed={key.prefix} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-base font-medium text-tinta">
                      {key.name}
                      {key.revokedAt && <Sello tone="devuelto">Revocada</Sello>}
                    </p>
                    <p className="truncate font-guia text-micro text-tinta-3">
                      mw_{key.prefix}_•••• · remite {key.senderEmail}
                    </p>
                  </div>
                  <div className="num text-right font-guia text-sm text-tinta-2">
                    <p>{key.usedToday} hoy</p>
                    <p className="text-micro text-tinta-3">
                      {key.lastUsedAt ? `último ${formatDate(key.lastUsedAt)}` : 'sin uso'}
                    </p>
                  </div>
                  {!key.revokedAt && (
                    <Button variant="peligro" className="h-8 px-2.5 text-sm" onClick={() => setToRevoke(key)}>
                      Revocar
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {/* Guía de integración */}
        <Panel title="Cómo enviar (ejemplo listo para pegar)">
          <div className="flex flex-col gap-3">
            <p className="max-w-[75ch] text-sm text-tinta-2">
              Una petición HTTP por mensaje. La clave viaja en la cabecera{' '}
              <code className="font-guia text-micro">Authorization</code>; el remitente es el buzón
              asociado a la clave. Campos: <code className="font-guia text-micro">to</code> (uno o
              lista), <code className="font-guia text-micro">subject</code>,{' '}
              <code className="font-guia text-micro">html</code> y/o{' '}
              <code className="font-guia text-micro">text</code>; opcionales{' '}
              <code className="font-guia text-micro">fromName, replyTo, cc, bcc</code>.
            </p>
            <Etiqueta>
              <div className="flex items-start justify-between gap-3 px-4 py-3">
                <pre className="min-w-0 flex-1 overflow-x-auto font-guia text-micro leading-relaxed">{curlExample}</pre>
                <BotonCopiar text={curlExample} label="Copiar" />
              </div>
            </Etiqueta>
            <p className="text-sm text-tinta-3">
              Respuestas: <code className="font-guia text-micro">200 {'{ id, status: "sent" }'}</code> ·{' '}
              <code className="font-guia text-micro">401</code> clave no válida ·{' '}
              <code className="font-guia text-micro">429</code> límite del plan alcanzado (reintenta con
              espera exponencial).
            </p>
          </div>
        </Panel>

        {/* Historial */}
        <Panel
          title="Últimos envíos"
          actions={
            messages.isFetching ? <span className="text-micro text-tinta-3">actualizando…</span> : undefined
          }
          flush
        >
          {messageList.length === 0 ? (
            <Vacio title="Todavía no hay envíos">
              Cuando tu aplicación llame a la API, cada mensaje aparecerá aquí con su estado.
            </Vacio>
          ) : (
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-suave text-sm text-tinta-3">
                  <th className="px-4 py-2 font-medium">Para</th>
                  <th className="hidden px-4 py-2 font-medium md:table-cell">Asunto</th>
                  <th className="hidden px-4 py-2 font-medium sm:table-cell">Fecha</th>
                  <th className="px-4 py-2 text-right font-medium">Estado</th>
                </tr>
              </thead>
              <tbody>
                {messageList.map((message) => (
                  <tr key={message.id} className="border-b border-suave last:border-0">
                    <td className="max-w-[200px] truncate px-4 py-2 font-guia text-micro text-tinta">
                      {message.to.join(', ')}
                    </td>
                    <td className="hidden max-w-[280px] truncate px-4 py-2 text-sm text-tinta-2 md:table-cell">
                      {message.subject}
                    </td>
                    <td className="hidden whitespace-nowrap px-4 py-2 text-sm text-tinta-3 sm:table-cell">
                      {formatDate(message.createdAt)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {message.status === 'sent' ? (
                        <Estado tone="entregado">Enviado</Estado>
                      ) : (
                        <span title={message.error}>
                          <Estado tone="devuelto">Fallido</Estado>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      {/* Crear clave */}
      <Dialogo open={open} onClose={() => setOpen(false)} title="Nueva clave de API">
        <form onSubmit={submit} className="flex flex-col gap-4">
          {isAdmin && (
            <Select label="Cliente propietario" required value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Elige un cliente…</option>
              {(clients.data?.clients ?? []).map((client) => (
                <option key={client.id} value={client.id}>{client.name}</option>
              ))}
            </Select>
          )}
          <Input
            label="Nombre de la clave"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="OTP producción"
            help="Para reconocerla luego: una clave por aplicación o entorno."
          />
          <Select
            label="Buzón remitente"
            required
            value={senderMailboxId}
            onChange={(e) => setSenderMailboxId(e.target.value)}
            help="Los mensajes saldrán con esta dirección. Recomendado: noreply@tudominio.com"
          >
            {senderOptions.map((mailbox) => (
              <option key={mailbox.id} value={mailbox.id}>{mailbox.email}</option>
            ))}
          </Select>
          {error && (
            <p role="alert" className="rounded border border-[rgb(var(--devuelto)/0.4)] bg-[rgb(var(--devuelto)/0.08)] px-3 py-2 text-sm text-devuelto">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="fantasma" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button type="submit" variant="accion" busy={create.isPending}>Crear clave</Button>
          </div>
        </form>
      </Dialogo>

      {/* Clave impresa: una sola vez */}
      <Dialogo open={revealedKey !== null} onClose={() => setRevealedKey(null)} title="Tu clave de API">
        {revealedKey && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-tinta-2">
              Guárdala ahora en tu gestor de secretos:{' '}
              <strong className="text-tinta">no se volverá a mostrar</strong>.
            </p>
            <Etiqueta>
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <code className="break-all font-guia text-sm">{revealedKey}</code>
                <BotonCopiar text={revealedKey} />
              </div>
            </Etiqueta>
            <Button variant="accion" onClick={() => setRevealedKey(null)}>Ya la he guardado</Button>
          </div>
        )}
      </Dialogo>

      {/* Revocar */}
      <Dialogo open={toRevoke !== null} onClose={() => setToRevoke(null)} title="Revocar clave">
        {toRevoke && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-tinta-2">
              La clave <strong className="text-tinta">{toRevoke.name}</strong> dejará de funcionar
              al instante. Las aplicaciones que la usen recibirán un error 401.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="fantasma" onClick={() => setToRevoke(null)}>Cancelar</Button>
              <Button variant="peligro" busy={revoke.isPending} onClick={() => revoke.mutate(toRevoke)}>
                Revocar
              </Button>
            </div>
          </div>
        )}
      </Dialogo>
    </>
  );
}
