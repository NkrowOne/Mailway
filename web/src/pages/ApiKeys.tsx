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
  Dialogo,
  Escala,
  Hoja,
  MarcaFondo,
  Membrete,
  Midiendo,
  Muestra,
  Vacio,
} from '../ui/kit';
import { useToast } from '../ui/toast';
import { formatDate } from '../lib/format';

/** Valores largos: se desplazan en horizontal, no se parten a mitad de palabra. */
const cinta =
  'block overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';

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
      <Membrete
        title="API de envío"
        meta="Envíos automatizados desde tus aplicaciones: códigos OTP, avisos, facturas."
        actions={
          <Button
            variant="tinta"
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
          <Hoja>
            <Midiendo label="Leyendo las claves de API…" />
          </Hoja>
        ) : keys.isError ? (
          <Hoja>
            <p role="alert" className="text-base text-fuera">
              No se pudieron leer las claves de API. Recarga la página para repetir la lectura.
            </p>
          </Hoja>
        ) : keyList.length === 0 ? (
          <Hoja>
            <Vacio title="Sin claves de API">
              {mailboxList.length === 0
                ? 'Crea antes un buzón: cada clave envía en nombre de un buzón remitente (p. ej. noreply@tudominio.com).'
                : 'Crea una clave para que tu aplicación envíe correo con una sola llamada HTTP.'}
            </Vacio>
          </Hoja>
        ) : (
          <Hoja flush>
            <div className="regla-cabecera hidden items-baseline gap-x-4 bg-hoja-3 px-4 py-1.5 sm:flex">
              <span className="rotulo min-w-0 flex-1">Clave y remitente</span>
              <span className="rotulo shrink-0 basis-52">Envíos de hoy</span>
              <span className="rotulo shrink-0 basis-20 text-right">Acción</span>
            </div>

            <ul>
              {keyList.map((key) => (
                <li
                  key={key.id}
                  className="regla-fila flex flex-wrap items-start gap-x-4 gap-y-2.5 px-4 py-3
                    last:border-b-0"
                >
                  <div className="min-w-0 basis-full sm:basis-0 sm:grow">
                    <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-base font-medium text-tinta">
                      {key.name}
                      {key.revokedAt && <MarcaFondo veredicto="fuera">Revocada</MarcaFondo>}
                    </p>
                    {/* Prefijo y remitente identifican la clave: nunca se recortan. */}
                    <p className={`mt-0.5 text-sm text-tinta-3 ${cinta}`}>
                      <span className="valor text-tinta-2">mw_{key.prefix}_••••</span>
                      {' · remite '}
                      <span className="valor text-tinta-2">{key.senderEmail}</span>
                    </p>
                  </div>

                  <div className="min-w-0 basis-full sm:shrink-0 sm:basis-52">
                    {key.dailyLimit != null ? (
                      <Escala label="Envíos hoy" usado={key.usedToday} maximo={key.dailyLimit} />
                    ) : (
                      <p className="flex items-baseline justify-between gap-2">
                        <span className="text-base text-tinta">Envíos hoy</span>
                        <span className="valor text-base text-tinta">
                          {key.usedToday}
                          <span className="text-tinta-3"> / límite del plan</span>
                        </span>
                      </p>
                    )}
                    <p className="mt-1 text-sm text-tinta-3">
                      {key.lastUsedAt ? `último uso ${formatDate(key.lastUsedAt)}` : 'sin uso'}
                    </p>
                  </div>

                  <div className="ml-auto shrink-0 sm:ml-0 sm:basis-20 sm:text-right">
                    {!key.revokedAt && (
                      <Button variant="plano" onClick={() => setToRevoke(key)}>
                        Revocar
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Hoja>
        )}

        {/* Guía de integración */}
        <Hoja title="Cómo enviar (ejemplo listo para pegar)">
          <div className="flex flex-col gap-3">
            <p className="max-w-[75ch] text-base text-tinta-2">
              Una petición HTTP por mensaje. La clave viaja en la cabecera{' '}
              <code className="valor text-sm text-tinta">Authorization</code>; el remitente es el
              buzón asociado a la clave. Campos:{' '}
              <code className="valor text-sm text-tinta">to</code> (uno o lista),{' '}
              <code className="valor text-sm text-tinta">subject</code>,{' '}
              <code className="valor text-sm text-tinta">html</code> y/o{' '}
              <code className="valor text-sm text-tinta">text</code>; opcionales{' '}
              <code className="valor text-sm text-tinta">fromName, replyTo, cc, bcc</code>.
            </p>
            <Muestra rotulo="Petición de ejemplo" copiar={curlExample}>
              {/* <pre> conserva sus saltos de línea: aquí solo hace falta el
                  desplazamiento horizontal, nunca partir una línea. */}
              <pre
                className="valor overflow-x-auto text-sm leading-relaxed text-tinta
                  [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >{curlExample}</pre>
            </Muestra>
            <p className="text-sm text-tinta-3">
              Respuestas: <code className="valor text-sm">200 {'{ id, status: "sent" }'}</code> ·{' '}
              <code className="valor text-sm">401</code> clave no válida ·{' '}
              <code className="valor text-sm">429</code> límite del plan alcanzado (reintenta con
              espera exponencial).
            </p>
          </div>
        </Hoja>

        {/* Historial */}
        <Hoja
          title="Últimos envíos"
          meta={messages.isFetching ? <span className="rotulo">midiendo…</span> : undefined}
          flush
        >
          {messages.isPending ? (
            <Midiendo label="Leyendo los últimos envíos…" />
          ) : messageList.length === 0 ? (
            <Vacio title="Todavía no hay envíos">
              Cuando tu aplicación llame a la API, cada mensaje aparecerá aquí con su estado.
            </Vacio>
          ) : (
            <>
              <div className="regla-cabecera hidden items-baseline gap-x-4 bg-hoja-3 px-4 py-1.5 sm:flex">
                <span className="rotulo min-w-0 flex-1">Para</span>
                <span className="rotulo min-w-0 flex-1">Asunto</span>
                <span className="rotulo shrink-0 basis-28">Fecha</span>
                <span className="rotulo shrink-0 basis-24 text-right">Veredicto</span>
              </div>
              <ul>
                {messageList.map((message) => (
                  <li
                    key={message.id}
                    className="regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5
                      last:border-b-0"
                  >
                    {/* El destinatario identifica la fila: línea propia en móvil. */}
                    <span
                      className={`valor min-w-0 basis-full text-sm text-tinta sm:basis-0 sm:grow ${cinta}`}
                    >
                      {message.to.join(', ')}
                    </span>
                    <span className="min-w-0 basis-full truncate text-sm text-tinta-2 sm:basis-0 sm:grow">
                      {message.subject}
                    </span>
                    <span className="shrink-0 whitespace-nowrap text-sm text-tinta-3 sm:basis-28">
                      {formatDate(message.createdAt)}
                    </span>
                    <span className="ml-auto shrink-0 sm:ml-0 sm:basis-24 sm:text-right">
                      {message.status === 'sent' ? (
                        <MarcaFondo veredicto="normal">Enviado</MarcaFondo>
                      ) : (
                        <span title={message.error}>
                          <MarcaFondo veredicto="fuera">Fallido</MarcaFondo>
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Hoja>
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
            <p
              role="alert"
              className="border border-[rgb(var(--fuera)/0.4)] bg-fuera-fondo px-3 py-2 text-sm text-fuera"
            >
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="plano" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button type="submit" variant="tinta" busy={create.isPending}>Crear clave</Button>
          </div>
        </form>
      </Dialogo>

      {/* La clave, una sola vez */}
      <Dialogo open={revealedKey !== null} onClose={() => setRevealedKey(null)} title="Tu clave de API">
        {revealedKey && (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2">
              Guárdala ahora en tu gestor de secretos:{' '}
              <strong className="text-tinta">no se volverá a mostrar</strong>.
            </p>
            <Muestra rotulo="Clave de API" copiar={revealedKey}>
              <code className={`valor text-sm text-tinta ${cinta}`}>{revealedKey}</code>
            </Muestra>
            <div className="flex justify-end">
              <Button variant="tinta" onClick={() => setRevealedKey(null)}>Ya la he guardado</Button>
            </div>
          </div>
        )}
      </Dialogo>

      {/* Revocar */}
      <Dialogo open={toRevoke !== null} onClose={() => setToRevoke(null)} title="Revocar clave">
        {toRevoke && (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2">
              La clave <strong className="text-tinta">{toRevoke.name}</strong> dejará de funcionar
              al instante. Las aplicaciones que la usen recibirán un error 401.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="plano" onClick={() => setToRevoke(null)}>Cancelar</Button>
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
