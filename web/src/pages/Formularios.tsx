import { useState, type FormEvent } from 'react';
import { FormInput } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Client, type FormInfo, type Mailbox, type User } from '../lib/api';
import { formatDate, plural } from '../lib/format';
import { Button, estiloBoton } from '../ui/Button';
import { Input, Select, Textarea } from '../ui/Field';
import { AvisoError, Dialogo, Hoja, MarcaFondo, Membrete, Cargando, Muestra, Vacio } from '../ui/kit';
import { useToast } from '../ui/toast';
import { Botonera, Casilla } from '../components/gestion/comun';

/*
  Formularios de contacto para webs estáticas: el cliente elige el buzón que
  recibe los mensajes y las webs desde las que se puede enviar, y pega en su
  web un fragmento HTML con una clave pública (sin secretos).
*/

/** Mismos valores que server/src/modules/forms.ts (se explican en la guía). */
const LIMITE_IP = 5;
const LIMITE_HORA = 30;
const LIMITE_DIA = 200;

interface Borrador {
  clientId: string;
  name: string;
  recipientMailboxId: string;
  origins: string;
  subject: string;
  enabled: boolean;
  turnstileSiteKey: string;
  turnstileSecret: string;
  /** En la edición: retirar Turnstile al guardar. */
  quitarTurnstile: boolean;
}

const BORRADOR_VACIO: Borrador = {
  clientId: '',
  name: '',
  recipientMailboxId: '',
  origins: '',
  subject: 'Nuevo mensaje desde la web',
  enabled: true,
  turnstileSiteKey: '',
  turnstileSecret: '',
  quitarTurnstile: false,
};

function mensajeDe(err: unknown, generico: string): string {
  return err instanceof ApiError ? err.message : generico;
}

/** Una dirección por línea (también se admiten comas o espacios). */
function listaOrigenes(texto: string): string[] {
  return texto
    .split(/[\s,]+/)
    .map((o) => o.trim())
    .filter(Boolean);
}

/** Origen de una línea tal como lo guarda el servidor (https://host[:puerto]), o null. */
function origenDe(linea: string): string | null {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(linea) ? linea : `https://${linea}`);
    return url.protocol === 'https:' && url.hostname.includes('.') ? `https://${url.host.toLowerCase()}` : null;
  } catch {
    return null;
  }
}

/**
 * Variante con o sin www de las webs de la lista que todavía no figura en
 * ella. El navegador envía el origen exacto y el servidor no amplía la lista
 * por su cuenta: una web que redirige a www rechazaría todos los envíos.
 * Sin lista de sufijos públicos, solo se propone www para un dominio de dos
 * etiquetas (panaderiasol.es); quitarlo, siempre que empiece por www.
 */
function variantesWww(lineas: string[]): string[] {
  const origenes = lineas.map(origenDe).filter((o): o is string => o !== null);
  const presentes = new Set(origenes);
  const propuestas: string[] = [];
  for (const origen of origenes) {
    const host = origen.slice('https://'.length);
    const otro = host.startsWith('www.')
      ? host.slice(4)
      : host.split(':')[0]!.split('.').length === 2
        ? `www.${host}`
        : null;
    if (!otro) continue;
    const variante = `https://${otro}`;
    if (!presentes.has(variante) && !propuestas.includes(variante)) propuestas.push(variante);
  }
  return propuestas;
}

export default function Formularios({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const isAdmin = user.role === 'admin';

  const [editando, setEditando] = useState<FormInfo | 'nuevo' | null>(null);
  const [borrador, setBorrador] = useState<Borrador>(BORRADOR_VACIO);
  const [error, setError] = useState('');
  const [codigo, setCodigo] = useState<{ form: FormInfo; recienCreado: boolean } | null>(null);
  const [aEliminar, setAEliminar] = useState<FormInfo | null>(null);

  const forms = useQuery({
    queryKey: ['forms'],
    queryFn: () => api.get<{ forms: FormInfo[] }>('/api/forms'),
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
  // El administrador ve los buzones de todos: en el diálogo solo se ofrecen
  // los del cliente elegido (el servidor rechaza los demás).
  const buzonesCliente = useQuery({
    queryKey: ['mailboxes', { clientId: borrador.clientId }],
    queryFn: () =>
      api.get<{ mailboxes: Mailbox[] }>(`/api/mailboxes?clientId=${encodeURIComponent(borrador.clientId)}`),
    enabled: isAdmin && editando === 'nuevo' && borrador.clientId !== '',
  });

  const lista = forms.data?.forms ?? [];
  const todosLosBuzones = mailboxes.data?.mailboxes ?? [];
  const activos = todosLosBuzones.filter((m) => m.status === 'active');
  const clientList = clients.data?.clients ?? [];
  const nombreCliente = new Map(clientList.map((c) => [c.id, c.name]));
  const candidatos = isAdmin
    ? borrador.clientId
      ? (buzonesCliente.data?.mailboxes ?? []).filter((m) => m.status === 'active')
      : []
    : activos;
  const remitente = candidatos.some((m) => m.id === borrador.recipientMailboxId)
    ? borrador.recipientMailboxId
    : candidatos[0]?.id ?? '';

  async function refrescar() {
    await queryClient.invalidateQueries({ queryKey: ['forms'] });
  }

  const guardar = useMutation({
    mutationFn: async (): Promise<{ form: FormInfo; nuevo: boolean }> => {
      const allowedOrigins = listaOrigenes(borrador.origins);
      if (editando === 'nuevo') {
        const res = await api.post<{ form: FormInfo }>('/api/forms', {
          clientId: isAdmin ? borrador.clientId || undefined : undefined,
          name: borrador.name,
          recipientMailboxId: remitente,
          allowedOrigins,
          subject: borrador.subject,
          turnstileSiteKey: borrador.turnstileSiteKey.trim() || undefined,
          turnstileSecret: borrador.turnstileSecret.trim() || undefined,
        });
        return { form: res.form, nuevo: true };
      }
      const actual = editando as FormInfo;
      const cambios: Record<string, unknown> = {
        name: borrador.name,
        allowedOrigins,
        subject: borrador.subject,
        enabled: borrador.enabled,
      };
      if (borrador.quitarTurnstile) {
        cambios.turnstileSiteKey = null;
        cambios.turnstileSecret = null;
      } else {
        // Vacío = se conserva lo que había (el secreto nunca vuelve al navegador).
        if (borrador.turnstileSiteKey.trim() && borrador.turnstileSiteKey.trim() !== actual.turnstile?.siteKey) {
          cambios.turnstileSiteKey = borrador.turnstileSiteKey.trim();
        }
        if (borrador.turnstileSecret.trim()) cambios.turnstileSecret = borrador.turnstileSecret.trim();
      }
      const res = await api.patch<{ form: FormInfo }>(`/api/forms/${actual.id}`, cambios);
      return { form: res.form, nuevo: false };
    },
    onSuccess: async ({ form, nuevo }) => {
      await refrescar();
      setEditando(null);
      setError('');
      if (nuevo) setCodigo({ form, recienCreado: true });
      else toast('ok', 'Formulario guardado.');
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido guardar el formulario. Inténtalo de nuevo.')),
  });

  const eliminar = useMutation({
    mutationFn: (form: FormInfo) => api.delete(`/api/forms/${form.id}`),
    onSuccess: async () => {
      await refrescar();
      setAEliminar(null);
      toast('ok', 'Formulario eliminado. Los envíos desde la web se rechazarán.');
    },
    onError: (err) => {
      setAEliminar(null);
      toast('error', mensajeDe(err, 'No se ha podido eliminar el formulario.'));
    },
  });

  function cambiar(parcial: Partial<Borrador>) {
    setError('');
    setBorrador((b) => ({ ...b, ...parcial }));
  }

  function abrirNuevo() {
    setError('');
    setBorrador({ ...BORRADOR_VACIO, clientId: isAdmin && clientList.length === 1 ? clientList[0]!.id : '' });
    setEditando('nuevo');
  }

  function abrirEdicion(form: FormInfo) {
    setError('');
    setBorrador({
      ...BORRADOR_VACIO,
      clientId: form.clientId,
      name: form.name,
      recipientMailboxId: form.recipientMailboxId,
      origins: form.allowedOrigins.join('\n'),
      subject: form.subject,
      enabled: form.enabled,
      turnstileSiteKey: form.turnstile?.siteKey ?? '',
    });
    setEditando(form);
  }

  function enviar(e: FormEvent) {
    e.preventDefault();
    if (editando === 'nuevo' && isAdmin && !borrador.clientId) {
      setError('Selecciona el cliente propietario del formulario.');
      return;
    }
    if (borrador.name.trim().length < 2) {
      setError('Indica un nombre para el formulario, por ejemplo «Contacto».');
      return;
    }
    if (listaOrigenes(borrador.origins).length === 0) {
      setError('Indica al menos una web desde la que se enviará el formulario, por ejemplo https://www.tu-dominio.com.');
      return;
    }
    if (editando === 'nuevo' && !remitente) return;
    guardar.mutate();
  }

  const edicion = editando !== null && editando !== 'nuevo' ? editando : null;

  return (
    <>
      <Membrete
        title="Formularios"
        meta="Formularios de contacto para webs estáticas: los mensajes llegan a tu buzón sin claves secretas en la web."
        actions={
          <Button variant="principal" disabled={activos.length === 0} onClick={abrirNuevo}>
            Nuevo formulario
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        {mailboxes.isError && (
          <AvisoError onRetry={() => void mailboxes.refetch()} retrying={mailboxes.isFetching}>
            No se han podido leer los buzones: sin ellos no se pueden crear formularios.
          </AvisoError>
        )}

        {forms.isPending ? (
          <Hoja>
            <Cargando label="Cargando los formularios…" />
          </Hoja>
        ) : forms.isError ? (
          <AvisoError onRetry={() => void forms.refetch()} retrying={forms.isFetching}>
            No se han podido leer los formularios.
          </AvisoError>
        ) : lista.length === 0 ? (
          <Hoja>
            <Vacio icono={FormInput}
              title="Sin formularios"
              action={
                activos.length === 0 ? (
                  <Link to="/buzones" className={estiloBoton('perfil')}>
                    Crear un buzón
                  </Link>
                ) : (
                  <Button variant="perfil" onClick={abrirNuevo}>
                    Crear un formulario
                  </Button>
                )
              }
            >
              {activos.length === 0
                ? 'Crea antes un buzón activo: cada formulario entrega los mensajes en un buzón tuyo (por ejemplo, contacto@tu-dominio.com).'
                : 'Crea un formulario y pega el código en tu web: cada mensaje llegará a tu buzón y podrás responder directamente al visitante.'}
            </Vacio>
          </Hoja>
        ) : (
          <Hoja flush>
            <div className="regla-cabecera hidden items-baseline gap-x-4 bg-hoja-3 px-4 py-1.5 md:flex">
              <span className="rotulo min-w-0 flex-1">Formulario y destino</span>
              <span className="rotulo min-w-0 flex-1">Webs permitidas</span>
              <span className="rotulo shrink-0 basis-36">Mensajes</span>
              <span className="rotulo shrink-0 basis-64 text-right">Acciones</span>
            </div>
            <ul>
              {lista.map((form) => (
                <li
                  key={form.id}
                  className={`regla-fila flex flex-wrap items-start gap-x-4 gap-y-2.5 px-4 py-3 last:border-b-0 ${
                    form.enabled ? '' : 'fila-fuera'
                  }`}
                >
                  <div className="min-w-0 basis-full md:basis-0 md:grow">
                    <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-base font-medium text-tinta">
                      <span className="min-w-0 [overflow-wrap:anywhere]">{form.name}</span>
                      {!form.enabled && <MarcaFondo veredicto="sin-dato">Desactivado</MarcaFondo>}
                      {form.turnstile && <MarcaFondo veredicto="normal">Turnstile</MarcaFondo>}
                    </p>
                    <p className="mt-0.5 text-sm text-tinta-3 [overflow-wrap:anywhere]">
                      <span className="codigo text-tinta-2">{form.publicKey}</span>
                      {' · llega a '}
                      <span className="valor text-tinta-2">{form.recipientEmail}</span>
                      {isAdmin && nombreCliente.get(form.clientId) && <> · {nombreCliente.get(form.clientId)}</>}
                    </p>
                  </div>
                  <div className="min-w-0 basis-full md:basis-0 md:grow">
                    <span className="rotulo md:hidden">Webs permitidas</span>
                    <ul className="text-sm text-tinta-2">
                      {form.allowedOrigins.map((o) => (
                        <li key={o} className="valor [overflow-wrap:anywhere]">
                          {o}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="min-w-0 basis-full md:shrink-0 md:basis-36">
                    <p className="text-base text-tinta">
                      <span className="valor">{form.submissionsCount}</span>{' '}
                      {form.submissionsCount === 1 ? 'mensaje' : 'mensajes'}
                    </p>
                    <p className="text-sm text-tinta-3">
                      {form.lastSubmissionAt ? `Último: ${formatDate(form.lastSubmissionAt)}` : 'Sin mensajes todavía'}
                    </p>
                  </div>
                  <div className="flex basis-full flex-wrap justify-end gap-1.5 md:shrink-0 md:basis-64">
                    <Button variant="perfil" onClick={() => setCodigo({ form, recienCreado: false })}>
                      Código
                    </Button>
                    <Button variant="plano" onClick={() => abrirEdicion(form)}>
                      Editar
                    </Button>
                    <Button variant="plano" onClick={() => setAEliminar(form)}>
                      Eliminar
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </Hoja>
        )}

        <Hoja title="Cómo funciona" meta="Sin claves secretas en la web">
          <div className="grid gap-4 lg:grid-cols-2">
            <ol className="flex max-w-[75ch] list-decimal flex-col gap-2 pl-5 text-base text-tinta-2">
              <li>Crea un formulario: elige el buzón que recibirá los mensajes y las webs desde las que se enviará.</li>
              <li>
                Pega el código en tu web. Puedes cambiar el diseño y añadir campos: todos llegan en el mensaje. Funciona
                también sin JavaScript.
              </li>
              <li>
                Cada mensaje sale de tu propio buzón hacia ti; la dirección que escribe el visitante va en «Responder a»,
                así que basta con contestar.
              </li>
            </ol>
            <div>
              <p className="rotulo regla-cabecera pb-1.5">Protecciones</p>
              <ul>
                {[
                  'Solo se aceptan envíos desde las webs permitidas (https).',
                  'Un campo trampa invisible descarta los envíos automáticos.',
                  `Como máximo ${plural(LIMITE_IP, 'envío', 'envíos')} por visitante cada 10 minutos, y ${LIMITE_HORA} mensajes por hora y ${LIMITE_DIA} al día en cada formulario. No gastan el límite diario de envíos por API del plan: un formulario atacado no deja sin servicio a tus aplicaciones.`,
                  'Opcional: Cloudflare Turnstile para comprobar que quien envía es una persona.',
                ].map((texto) => (
                  <li key={texto} className="regla-fila py-2 text-sm text-tinta-2 last:border-b-0">
                    {texto}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Hoja>
      </div>

      {/* Crear o editar */}
      <Dialogo
        open={editando !== null}
        onClose={() => setEditando(null)}
        title={edicion ? `Editar «${edicion.name}»` : 'Nuevo formulario'}
        ancho="amplio"
      >
        <form onSubmit={enviar} noValidate className="flex flex-col gap-4">
          {isAdmin && editando === 'nuevo' && (
            <Select
              label="Cliente propietario"
              value={borrador.clientId}
              onChange={(e) => cambiar({ clientId: e.target.value, recipientMailboxId: '' })}
            >
              <option value="">Selecciona un cliente…</option>
              {clientList.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </Select>
          )}
          <Input
            label="Nombre"
            maxLength={60}
            value={borrador.name}
            onChange={(e) => cambiar({ name: e.target.value })}
            placeholder="Contacto"
            help="Para reconocerlo en el panel; también aparece como nombre del remitente de los mensajes."
          />
          {edicion ? (
            <p className="text-base text-tinta-2">
              Los mensajes llegan a <span className="valor text-tinta">{edicion.recipientEmail}</span>. Para cambiar de
              buzón, crea otro formulario.
            </p>
          ) : (
            <Select
              label="Buzón que recibe los mensajes"
              value={remitente}
              disabled={candidatos.length === 0}
              onChange={(e) => cambiar({ recipientMailboxId: e.target.value })}
              help={
                isAdmin && !borrador.clientId
                  ? 'Selecciona primero el cliente: solo se ofrecen sus buzones.'
                  : isAdmin && buzonesCliente.isPending
                    ? 'Leyendo los buzones del cliente…'
                    : candidatos.length === 0
                      ? 'No hay buzones activos. Crea uno en «Buzones».'
                      : 'Los mensajes salen de este buzón y llegan a él, con la firma de tu dominio.'
              }
            >
              {candidatos.length === 0 && <option value="">Sin buzones disponibles</option>}
              {candidatos.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.email}
                </option>
              ))}
            </Select>
          )}
          <div className="flex flex-col gap-1.5">
            <Textarea
              label="Webs permitidas"
              rows={3}
              value={borrador.origins}
              onChange={(e) => cambiar({ origins: e.target.value })}
              placeholder={'https://www.tu-dominio.com\nhttps://tu-dominio.com'}
              help="Una dirección por línea, con https://. Solo se aceptan envíos desde estas webs; con www y sin www son dos webs distintas."
            />
            {variantesWww(listaOrigenes(borrador.origins)).map((variante) => (
              <p key={variante} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-tinta-2">
                <span>
                  ¿Añadir también <span className="valor break-all text-tinta">{variante}</span>? Si la web
                  redirige a esa dirección, sin ella se rechazan los envíos.
                </span>
                <Button
                  type="button"
                  variant="plano"
                  onClick={() => cambiar({ origins: `${borrador.origins.trimEnd()}\n${variante}` })}
                >
                  Añadir
                </Button>
              </p>
            ))}
          </div>
          <Input
            label="Asunto de los mensajes"
            maxLength={150}
            value={borrador.subject}
            onChange={(e) => cambiar({ subject: e.target.value })}
          />
          {edicion && (
            <Casilla
              checked={borrador.enabled}
              onChange={(enabled) => cambiar({ enabled })}
              label="Formulario activo"
              help="Desactivado, la web recibe un aviso y no llega ningún mensaje."
            />
          )}

          <fieldset className="flex flex-col gap-3 rounded-lg border border-regla p-3">
            <legend className="rotulo px-1">Cloudflare Turnstile (opcional)</legend>
            <p className="text-sm text-tinta-2">
              Comprueba que quien envía es una persona. Crea un widget en Cloudflare para las webs permitidas y copia sus
              dos claves.
            </p>
            {edicion?.turnstile && (
              <Casilla
                checked={borrador.quitarTurnstile}
                onChange={(quitarTurnstile) => cambiar({ quitarTurnstile })}
                label="Retirar Turnstile de este formulario"
              />
            )}
            {!borrador.quitarTurnstile && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label="Clave de sitio"
                  value={borrador.turnstileSiteKey}
                  onChange={(e) => cambiar({ turnstileSiteKey: e.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Input
                  label="Clave secreta"
                  type="password"
                  value={borrador.turnstileSecret}
                  onChange={(e) => cambiar({ turnstileSecret: e.target.value })}
                  autoComplete="off"
                  help={edicion?.turnstile ? 'Déjala vacía para conservar la actual.' : 'Se guarda cifrada y no se vuelve a mostrar.'}
                />
              </div>
            )}
          </fieldset>

          {isAdmin && editando === 'nuevo' && buzonesCliente.isError && (
            <AvisoError onRetry={() => void buzonesCliente.refetch()} retrying={buzonesCliente.isFetching}>
              No se han podido leer los buzones del cliente.
            </AvisoError>
          )}
          {error && <AvisoError>{error}</AvisoError>}
          <Botonera>
            <Button type="button" variant="plano" onClick={() => setEditando(null)}>
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="principal"
              busy={guardar.isPending}
              disabled={editando === 'nuevo' && !remitente}
            >
              {edicion ? 'Guardar' : 'Crear formulario'}
            </Button>
          </Botonera>
        </form>
      </Dialogo>

      {/* Código para la web */}
      <Dialogo
        open={codigo !== null}
        onClose={() => setCodigo(null)}
        title={codigo?.recienCreado ? 'Formulario creado' : `Código de «${codigo?.form.name ?? ''}»`}
        ancho="amplio"
        pie={
          <Button variant="principal" onClick={() => setCodigo(null)}>
            Cerrar
          </Button>
        }
      >
        {codigo && (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2">
              Pega este código en tu web donde quieras que aparezca el formulario. Puedes cambiar los textos, el diseño y
              los campos: todos llegan en el mensaje, y el campo <code className="codigo text-sm">email</code> se usa para
              responder. La clave <span className="codigo text-sm text-tinta">{codigo.form.publicKey}</span> es pública:
              no hace falta protegerla. Puedes volver a ver este código cuando quieras.
            </p>
            <Muestra rotulo="Código HTML" copiar={codigo.form.embedHtml}>
              <pre className="valor whitespace-pre-wrap text-sm leading-relaxed text-tinta [overflow-wrap:anywhere]">
                {codigo.form.embedHtml}
              </pre>
            </Muestra>
            <Muestra rotulo="Dirección de envío" copiar={codigo.form.endpoint}>
              <code className="valor block break-all text-sm text-tinta">{codigo.form.endpoint}</code>
            </Muestra>
            <p className="text-sm text-tinta-3">
              Solo se aceptan envíos desde {codigo.form.allowedOrigins.join(', ')}. Para probarlo desde otra dirección,
              añádela en «Editar».
            </p>
          </div>
        )}
      </Dialogo>

      {/* Eliminar */}
      <Dialogo open={aEliminar !== null} onClose={() => setAEliminar(null)} title="Eliminar formulario">
        {aEliminar && (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2">
              El formulario <strong className="text-tinta">{aEliminar.name}</strong> dejará de aceptar mensajes de
              inmediato y la web mostrará un error al enviarlo. Si solo quieres pausarlo, desactívalo en «Editar».
            </p>
            <Botonera>
              <Button variant="plano" onClick={() => setAEliminar(null)}>
                Cancelar
              </Button>
              <Button variant="peligro" busy={eliminar.isPending} onClick={() => eliminar.mutate(aEliminar)}>
                Eliminar
              </Button>
            </Botonera>
          </div>
        )}
      </Dialogo>
    </>
  );
}
