import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
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
import { Button, estiloBoton } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import {
  AvisoError,
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
import { useDireccionPanel } from '../components/gestion/consultas';

/** Documentación completa de la API (solo se enlaza para el administrador). */
const DOCS_API = 'https://github.com/NkrowOne/Mailway/blob/main/docs/API.md';

/** Nombre de variable de entorno neutro: el panel puede ir con marca blanca. */
const VARIABLE = 'MAIL_API_KEY';

type Lenguaje = 'curl' | 'node' | 'php' | 'python';

const LENGUAJES: { id: Lenguaje; label: string }[] = [
  { id: 'curl', label: 'curl' },
  { id: 'node', label: 'Node.js' },
  { id: 'php', label: 'PHP' },
  { id: 'python', label: 'Python' },
];

/** Ejemplos listos para pegar, con la dirección real de este panel. */
function ejemplo(lenguaje: Lenguaje, base: string): string {
  const url = `${base}/v1/send`;
  switch (lenguaje) {
    case 'curl':
      return [
        `curl -X POST ${url} \\`,
        `  -H "Authorization: Bearer $${VARIABLE}" \\`,
        '  -H "Content-Type: application/json" \\',
        "  -d '{",
        '    "to": "cliente@ejemplo.com",',
        '    "subject": "Su código de acceso",',
        '    "text": "Su código es 482913. Caduca en 10 minutos.",',
        '    "html": "<p>Su código es <strong>482913</strong>. Caduca en 10 minutos.</p>"',
        "  }'",
      ].join('\n');
    case 'node':
      return [
        '// Node.js 18 o superior (fetch incluido).',
        `const res = await fetch('${url}', {`,
        "  method: 'POST',",
        '  headers: {',
        `    Authorization: \`Bearer \${process.env.${VARIABLE}}\`,`,
        "    'Content-Type': 'application/json',",
        '  },',
        '  body: JSON.stringify({',
        "    to: 'cliente@ejemplo.com',",
        "    subject: 'Su código de acceso',",
        "    text: 'Su código es 482913. Caduca en 10 minutos.',",
        '  }),',
        '});',
        'const data = await res.json();',
        'if (!res.ok) throw new Error(data.error); // 4xx/5xx: { error, code }',
        "if (data.status !== 'sent') console.error(data.error);",
      ].join('\n');
    case 'php':
      return [
        '<?php',
        `$ch = curl_init('${url}');`,
        'curl_setopt_array($ch, [',
        '    CURLOPT_POST => true,',
        '    CURLOPT_RETURNTRANSFER => true,',
        '    CURLOPT_HTTPHEADER => [',
        `        'Authorization: Bearer ' . getenv('${VARIABLE}'),`,
        "        'Content-Type: application/json',",
        '    ],',
        '    CURLOPT_POSTFIELDS => json_encode([',
        "        'to' => 'cliente@ejemplo.com',",
        "        'subject' => 'Su código de acceso',",
        "        'text' => 'Su código es 482913. Caduca en 10 minutos.',",
        '    ]),',
        ']);',
        '$respuesta = json_decode(curl_exec($ch), true);',
        '$estado = curl_getinfo($ch, CURLINFO_HTTP_CODE); // 200, 400, 401, 403 o 429',
        'curl_close($ch);',
      ].join('\n');
    case 'python':
      return [
        'import os',
        'import requests',
        '',
        'res = requests.post(',
        `    "${url}",`,
        `    headers={"Authorization": f"Bearer {os.environ['${VARIABLE}']}"},`,
        '    json={',
        '        "to": "cliente@ejemplo.com",',
        '        "subject": "Su código de acceso",',
        '        "text": "Su código es 482913. Caduca en 10 minutos.",',
        '    },',
        '    timeout=15,',
        ')',
        'res.raise_for_status()',
        "print(res.json())  # {'id': ..., 'status': 'sent', 'messageId': ...}",
      ].join('\n');
  }
}

const CAMPOS: { campo: string; tipo: string; nota: string }[] = [
  { campo: 'to', tipo: 'texto o lista', nota: 'Obligatorio. Hasta 50 destinatarios.' },
  { campo: 'subject', tipo: 'texto', nota: 'Obligatorio. Máximo 300 caracteres.' },
  { campo: 'html · text', tipo: 'texto', nota: 'Al menos uno. Máximo 2 MB cada uno; incluya los dos para una mejor entrega.' },
  { campo: 'fromName', tipo: 'texto', nota: 'Nombre visible del remitente. La dirección es siempre la del buzón de la clave.' },
  { campo: 'replyTo', tipo: 'dirección', nota: 'Dirección de respuesta.' },
  { campo: 'cc · bcc', tipo: 'lista', nota: 'Hasta 20 direcciones cada uno.' },
  { campo: 'headers', tipo: 'objeto', nota: 'Cabeceras adicionales, por ejemplo X-Campaign.' },
];

const RESPUESTAS: { codigo: string; nota: string }[] = [
  { codigo: '200', nota: '{ id, status: "sent", messageId }: entregado al servidor de correo. Con status "failed", el campo error indica el motivo.' },
  { codigo: '400', nota: 'Datos no válidos: el campo error indica cuál.' },
  { codigo: '401', nota: 'Clave ausente, no válida o revocada.' },
  { codigo: '403', nota: 'Cuenta del cliente o buzón remitente suspendidos.' },
  {
    codigo: '429',
    nota: 'Límite alcanzado: el del plan (por minuto o diario, compartido por todas las claves del cliente) o el diario propio de la clave. El campo error indica cuál. Reintente con espera exponencial.',
  },
];

/** Pestañas accesibles: flechas para moverse entre lenguajes, una sola parada de tabulación. */
function PestanasLenguaje({
  activo,
  onCambio,
  panelId,
}: {
  activo: Lenguaje;
  onCambio: (l: Lenguaje) => void;
  panelId: string;
}) {
  const refs = useRef<Partial<Record<Lenguaje, HTMLButtonElement | null>>>({});

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = LENGUAJES.findIndex((l) => l.id === activo);
    let siguiente = -1;
    if (e.key === 'ArrowRight') siguiente = (i + 1) % LENGUAJES.length;
    if (e.key === 'ArrowLeft') siguiente = (i - 1 + LENGUAJES.length) % LENGUAJES.length;
    if (e.key === 'Home') siguiente = 0;
    if (e.key === 'End') siguiente = LENGUAJES.length - 1;
    if (siguiente < 0) return;
    e.preventDefault();
    const id = LENGUAJES[siguiente]!.id;
    onCambio(id);
    refs.current[id]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Lenguaje del ejemplo"
      onKeyDown={onKeyDown}
      className="flex flex-wrap gap-1.5"
    >
      {LENGUAJES.map((l) => {
        const seleccionado = l.id === activo;
        return (
          <button
            key={l.id}
            ref={(el) => {
              refs.current[l.id] = el;
            }}
            type="button"
            role="tab"
            id={`${panelId}-${l.id}`}
            aria-selected={seleccionado}
            aria-controls={panelId}
            tabIndex={seleccionado ? 0 : -1}
            onClick={() => onCambio(l.id)}
            // Como la navegación activa: fondo petróleo tenue, sin filete de
            // acento (DESIGN.md solo admite dos bordes de petróleo).
            className={`rounded-lg border px-3 py-1.5 text-base transition-colors duration-100 ${
              seleccionado
                ? 'border-[rgb(var(--laboratorio)/0.35)] bg-laboratorio-claro font-semibold text-laboratorio'
                : 'border-regla text-tinta-2 hover:bg-hoja-3 hover:text-tinta'
            }`}
          >
            {l.label}
          </button>
        );
      })}
    </div>
  );
}

/** Claves de API + historial de envíos + guía de integración (OTP y avisos). */
export default function ApiKeys({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const isAdmin = user.role === 'admin';
  // Los ejemplos se copian a otras máquinas: la dirección pública del panel,
  // no la IP o la URL interna por la que se esté entrando ahora.
  const base = useDireccionPanel({ user });

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [senderMailboxId, setSenderMailboxId] = useState('');
  const [clientId, setClientId] = useState('');
  const [limite, setLimite] = useState('');
  const [error, setError] = useState('');
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [toRevoke, setToRevoke] = useState<ApiKeyInfo | null>(null);
  const [lenguaje, setLenguaje] = useState<Lenguaje>('curl');

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
  // El administrador ve los buzones de todos los clientes: en el diálogo solo
  // se ofrecen los del cliente elegido (el servidor rechaza los demás).
  const buzonesCliente = useQuery({
    queryKey: ['mailboxes', { clientId }],
    queryFn: () =>
      api.get<{ mailboxes: Mailbox[] }>(`/api/mailboxes?clientId=${encodeURIComponent(clientId)}`),
    enabled: isAdmin && open && clientId !== '',
  });
  const messages = useQuery({
    queryKey: ['messages'],
    queryFn: () => api.get<{ messages: Message[] }>('/api/messages?limit=50'),
    refetchInterval: 30_000,
  });

  const create = useMutation({
    mutationFn: (datos: { senderMailboxId: string; dailyLimit?: number }) =>
      api.post<{ key: string; info: ApiKeyInfo }>('/api/apikeys', {
        name,
        senderMailboxId: datos.senderMailboxId,
        dailyLimit: datos.dailyLimit,
        clientId: isAdmin ? clientId || undefined : undefined,
      }),
    onSuccess: async (data) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['apikeys'] }),
        // La puesta en marcha del cliente y el parte cuentan las claves.
        queryClient.invalidateQueries({ queryKey: ['client-dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] }),
      ]);
      setOpen(false);
      setName('');
      setLimite('');
      setError('');
      setRevealedKey(data.key);
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'No se ha podido crear la clave. Inténtelo de nuevo.'),
  });

  const revoke = useMutation({
    mutationFn: (key: ApiKeyInfo) => api.delete(`/api/apikeys/${key.id}`),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['apikeys'] }),
        queryClient.invalidateQueries({ queryKey: ['client-dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] }),
      ]);
      setToRevoke(null);
      toast('ok', 'Clave revocada. Los envíos con ella se rechazarán.');
    },
    onError: (err) => {
      setToRevoke(null);
      toast('error', err instanceof ApiError ? err.message : 'No se ha podido revocar la clave.');
    },
  });

  const keyList = [...(keys.data?.keys ?? [])].sort(
    (a, b) => Number(a.revokedAt !== null) - Number(b.revokedAt !== null),
  );
  const mailboxList = mailboxes.data?.mailboxes ?? [];
  const activos = mailboxList.filter((m) => m.status === 'active');
  const messageList = messages.data?.messages ?? [];
  const clientList = clients.data?.clients ?? [];
  const nombreCliente = new Map(clientList.map((c) => [c.id, c.name]));

  const candidatos = isAdmin ? (clientId ? buzonesCliente.data?.mailboxes ?? [] : []) : mailboxList;
  // Un buzón suspendido no puede enviar: no se ofrece como remitente.
  const senderOptions = candidatos.filter((m) => m.status === 'active');
  const remitente = senderOptions.some((m) => m.id === senderMailboxId)
    ? senderMailboxId
    : senderOptions[0]?.id ?? '';
  const limiteNumero = limite.trim() === '' ? undefined : Number(limite);
  const limiteInvalido =
    limiteNumero !== undefined && (!Number.isInteger(limiteNumero) || limiteNumero < 1);

  function abrir() {
    setError('');
    setName('');
    setLimite('');
    setSenderMailboxId('');
    if (isAdmin) setClientId(clientList.length === 1 ? clientList[0]!.id : '');
    setOpen(true);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (isAdmin && !clientId) {
      setError('Seleccione el cliente propietario de la clave.');
      return;
    }
    if (!name.trim()) {
      setError('Indique un nombre para reconocer la clave.');
      return;
    }
    if (limiteInvalido || !remitente) return;
    setError('');
    create.mutate({ senderMailboxId: remitente, dailyLimit: limiteNumero });
  }

  return (
    <>
      <Membrete
        title="API de envío"
        meta="Envíos automatizados desde sus aplicaciones: códigos de acceso, avisos, facturas."
        actions={
          <Button variant="campo" disabled={activos.length === 0} onClick={abrir}>
            Nueva clave
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        {mailboxes.isError && (
          <AvisoError onRetry={() => void mailboxes.refetch()} retrying={mailboxes.isFetching}>
            No se han podido leer los buzones remitentes: sin ellos no se pueden crear claves.
          </AvisoError>
        )}

        {keys.isPending ? (
          <Hoja>
            <Midiendo label="Cargando las claves de API…" />
          </Hoja>
        ) : keys.isError ? (
          <AvisoError onRetry={() => void keys.refetch()} retrying={keys.isFetching}>
            No se han podido leer las claves de API.
          </AvisoError>
        ) : keyList.length === 0 ? (
          <Hoja>
            <Vacio
              title="Sin claves de API"
              action={
                activos.length === 0 ? (
                  <Link to="/buzones" className={estiloBoton('perfil')}>
                    Crear un buzón
                  </Link>
                ) : (
                  <Button variant="perfil" onClick={abrir}>
                    Crear una clave
                  </Button>
                )
              }
            >
              {activos.length === 0
                ? 'Cree antes un buzón activo: cada clave envía en nombre de un buzón remitente (por ejemplo, noreply@su-dominio.com).'
                : 'Cree una clave para que su aplicación envíe correo con una sola petición HTTP.'}
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
                      <span className="min-w-0 [overflow-wrap:anywhere]">{key.name}</span>
                      {key.revokedAt && <MarcaFondo veredicto="fuera">Revocada</MarcaFondo>}
                    </p>
                    {/* Prefijo y remitente identifican la clave: nunca se recortan. */}
                    <p className="mt-0.5 text-sm text-tinta-3 [overflow-wrap:anywhere]">
                      <span className="valor text-tinta-2">mw_{key.prefix}_••••</span>
                      {' · remite '}
                      <span className="valor text-tinta-2">{key.senderEmail}</span>
                      {isAdmin && nombreCliente.get(key.clientId) && (
                        <> · {nombreCliente.get(key.clientId)}</>
                      )}
                    </p>
                  </div>

                  <div className="min-w-0 basis-full sm:shrink-0 sm:basis-52">
                    {key.dailyLimit != null ? (
                      <Escala label="Envíos hoy" usado={key.usedToday} maximo={key.dailyLimit} limiteEsFuera />
                    ) : (
                      <p className="flex items-baseline justify-between gap-2">
                        <span className="text-base text-tinta">Envíos hoy</span>
                        <span className="valor text-base text-tinta">
                          {key.usedToday}
                          <span className="text-tinta-3"> / límite del plan (compartido)</span>
                        </span>
                      </p>
                    )}
                    <p className="mt-1 text-sm text-tinta-3">
                      {key.lastUsedAt ? `Último uso: ${formatDate(key.lastUsedAt)}` : 'Sin uso todavía'}
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
        <Hoja
          title="Cómo enviar"
          meta="Ejemplo listo para pegar"
          actions={
            isAdmin ? (
              <a
                href={DOCS_API}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-laboratorio underline underline-offset-2 hover:text-tinta"
              >
                Documentación completa
              </a>
            ) : undefined
          }
        >
          <div className="flex flex-col gap-4">
            <p className="max-w-[75ch] text-base text-tinta-2">
              Una petición HTTP por mensaje a{' '}
              <code className="valor text-sm text-tinta [overflow-wrap:anywhere]">{base}/v1/send</code>.
              La clave viaja en la cabecera{' '}
              <code className="valor text-sm text-tinta">Authorization</code> y el remitente es
              siempre el buzón asociado a la clave. Guarde la clave en una variable de entorno (
              <code className="valor text-sm text-tinta">{VARIABLE}</code> en los ejemplos), nunca
              en el código.
            </p>

            <div>
              <PestanasLenguaje activo={lenguaje} onCambio={setLenguaje} panelId="ejemplo-envio" />
              <div
                id="ejemplo-envio"
                role="tabpanel"
                aria-labelledby={`ejemplo-envio-${lenguaje}`}
                className="pt-3"
              >
                <Muestra rotulo="Petición de ejemplo" copiar={ejemplo(lenguaje, base)}>
                  {/* Sin desplazamiento horizontal: a 360 px las líneas largas
                      se parten, y lo copiado es siempre el texto original. */}
                  <pre className="valor whitespace-pre-wrap text-sm leading-relaxed text-tinta [overflow-wrap:anywhere]">
                    {ejemplo(lenguaje, base)}
                  </pre>
                </Muestra>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <p className="rotulo regla-cabecera pb-1.5">Campos del cuerpo (JSON)</p>
                <ul>
                  {CAMPOS.map((c) => (
                    <li key={c.campo} className="regla-fila flex flex-wrap gap-x-3 gap-y-0.5 py-2 last:border-b-0">
                      <code className="valor shrink-0 basis-24 text-sm text-tinta">{c.campo}</code>
                      <span className="shrink-0 basis-24 text-sm text-tinta-3">{c.tipo}</span>
                      <span className="min-w-0 flex-1 basis-48 text-sm text-tinta-2">{c.nota}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="rotulo regla-cabecera pb-1.5">Respuestas</p>
                <ul>
                  {RESPUESTAS.map((r) => (
                    <li key={r.codigo} className="regla-fila flex gap-x-3 py-2 last:border-b-0">
                      <code className="valor w-10 shrink-0 text-sm text-tinta">{r.codigo}</code>
                      <span className="min-w-0 flex-1 text-sm text-tinta-2 [overflow-wrap:anywhere]">
                        {r.nota}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-sm text-tinta-3">
                  Los errores devuelven <code className="valor">{'{ error, code }'}</code> con el
                  motivo en español. Los límites del plan son del cliente: todas sus claves suman. El
                  contador diario se reinicia a medianoche UTC.
                </p>
              </div>
            </div>
          </div>
        </Hoja>

        {/* Historial */}
        <Hoja
          title="Últimos envíos"
          meta={messages.isFetching && !messages.isPending ? 'Actualizando…' : 'Se actualiza cada 30 s'}
          flush
        >
          {messages.isPending ? (
            <Midiendo label="Cargando los últimos envíos…" />
          ) : messages.isError ? (
            <div className="p-4">
              <AvisoError onRetry={() => void messages.refetch()} retrying={messages.isFetching}>
                No se ha podido leer el historial de envíos.
              </AvisoError>
            </div>
          ) : messageList.length === 0 ? (
            <Vacio title="Todavía no hay envíos">
              Cuando su aplicación llame a la API, cada mensaje aparecerá aquí con su estado.
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
                {messageList.map((message) => {
                  const fallido = message.status !== 'sent';
                  return (
                    <li
                      key={message.id}
                      className={`regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5
                        last:border-b-0 ${fallido ? 'fila-fuera' : ''}`}
                    >
                      {/* El destinatario identifica la fila: línea propia en móvil. */}
                      <span className="valor min-w-0 basis-full text-sm text-tinta [overflow-wrap:anywhere] sm:basis-0 sm:grow">
                        {message.to.join(', ')}
                      </span>
                      <span className="min-w-0 basis-full text-sm text-tinta-2 [overflow-wrap:anywhere] sm:basis-0 sm:grow">
                        {message.subject}
                      </span>
                      <span className="shrink-0 whitespace-nowrap text-sm text-tinta-3 sm:basis-28">
                        {formatDate(message.createdAt)}
                      </span>
                      <span className="ml-auto shrink-0 sm:ml-0 sm:basis-24 sm:text-right">
                        {fallido ? (
                          <MarcaFondo veredicto="fuera">Fallido</MarcaFondo>
                        ) : (
                          <MarcaFondo veredicto="normal">Enviado</MarcaFondo>
                        )}
                      </span>
                      {/* El motivo del fallo, visible también en móvil (antes
                          solo estaba en un title, que no existe al tacto). */}
                      {fallido && message.error && (
                        <p className="basis-full text-sm text-fuera [overflow-wrap:anywhere]">
                          {message.error}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Hoja>
      </div>

      {/* Crear clave */}
      <Dialogo open={open} onClose={() => setOpen(false)} title="Nueva clave de API">
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          {isAdmin && (
            <Select
              label="Cliente propietario"
              value={clientId}
              onChange={(e) => {
                setError('');
                setClientId(e.target.value);
                setSenderMailboxId('');
              }}
            >
              <option value="">Seleccione un cliente…</option>
              {clientList.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </Select>
          )}
          <Input
            label="Nombre de la clave"
            maxLength={60}
            value={name}
            onChange={(e) => {
              setError('');
              setName(e.target.value);
            }}
            placeholder="OTP producción"
            help="Para reconocerla después: una clave por aplicación y entorno."
          />
          <Select
            label="Buzón remitente"
            value={remitente}
            disabled={senderOptions.length === 0}
            onChange={(e) => {
              setError('');
              setSenderMailboxId(e.target.value);
            }}
            help={
              isAdmin && !clientId
                ? 'Seleccione primero el cliente: solo se ofrecen sus buzones.'
                : isAdmin && buzonesCliente.isPending
                  ? 'Leyendo los buzones del cliente…'
                  : senderOptions.length === 0
                    ? 'Este cliente no tiene buzones activos. Cree uno en «Buzones».'
                    : 'Los mensajes saldrán con esta dirección. Recomendado: noreply@su-dominio.com.'
            }
          >
            {senderOptions.length === 0 && <option value="">Sin buzones disponibles</option>}
            {senderOptions.map((mailbox) => (
              <option key={mailbox.id} value={mailbox.id}>
                {mailbox.email}
              </option>
            ))}
          </Select>
          <Input
            label="Límite diario (opcional)"
            type="number"
            inputMode="numeric"
            step={1}
            value={limite}
            onChange={(e) => {
              setError('');
              setLimite(e.target.value);
            }}
            placeholder="Límite del plan"
            error={limiteInvalido ? 'Indique un número entero mayor que cero.' : undefined}
            help="Los límites del plan (diario y por minuto) se aplican al total del cliente, sumando todas sus claves. Este límite, opcional, restringe además solo esta clave y no puede superar el del plan."
          />
          {isAdmin && buzonesCliente.isError && (
            <AvisoError
              onRetry={() => void buzonesCliente.refetch()}
              retrying={buzonesCliente.isFetching}
            >
              No se han podido leer los buzones del cliente.
            </AvisoError>
          )}
          {error && <AvisoError>{error}</AvisoError>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="plano" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="tinta"
              busy={create.isPending}
              disabled={!remitente || limiteInvalido}
            >
              Crear clave
            </Button>
          </div>
        </form>
      </Dialogo>

      {/* La clave, una sola vez: no se cierra sin confirmar que se ha guardado. */}
      <Dialogo
        open={revealedKey !== null}
        onClose={() => setRevealedKey(null)}
        title="Clave de API creada"
        confirmarCierre={{ pregunta: '¿Ha guardado la clave?', detalle: 'No se podrá volver a ver.' }}
        pie={
          <Button variant="tinta" onClick={() => setRevealedKey(null)}>
            Ya la he guardado
          </Button>
        }
      >
        {revealedKey && (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2">
              Guárdela ahora en su gestor de secretos o como variable de entorno:{' '}
              <strong className="text-tinta">no se volverá a mostrar</strong>.
            </p>
            <Muestra rotulo="Clave de API" copiar={revealedKey}>
              <code className="valor block break-all text-sm text-tinta">{revealedKey}</code>
            </Muestra>
          </div>
        )}
      </Dialogo>

      {/* Revocar */}
      <Dialogo open={toRevoke !== null} onClose={() => setToRevoke(null)} title="Revocar clave">
        {toRevoke && (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2">
              La clave <strong className="text-tinta">{toRevoke.name}</strong> dejará de funcionar
              de inmediato. Las aplicaciones que la utilicen recibirán un error 401.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="plano" onClick={() => setToRevoke(null)}>
                Cancelar
              </Button>
              <Button
                variant="peligro"
                busy={revoke.isPending}
                onClick={() => revoke.mutate(toRevoke)}
              >
                Revocar
              </Button>
            </div>
          </div>
        )}
      </Dialogo>
    </>
  );
}
