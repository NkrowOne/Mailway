import { useState, type FormEvent } from 'react';
import { Globe, Inbox, UserRound } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  ApiError,
  type Client,
  type ClientUsage,
  type DomainRecord,
  type Mailbox,
  type Plan,
} from '../../lib/api';
import { formatDate, formatDay, plural } from '../../lib/format';
import {
  esCorreoValido,
  formatBytes,
  formatQuota,
  mensajeDe,
  veredictoUso,
  vinculadoConSkyway,
  type ClientUser,
  type SuspensionResult,
} from '../../lib/gestion';
import { dominiosQueCuentan } from '../../lib/cambioDominio';
import { lecturaDominio } from '../../lib/cloudflare';
import { pesoVeredicto } from '../../lib/dominios';
import { Button, estiloBoton } from '../../ui/Button';
import { Input, Select, Textarea } from '../../ui/Field';
import { Dialogo, Escala, Hoja, MarcaFondo, Membrete, Cargando, Muestra, Vacio, type ConfirmarCierre } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { BandaAviso, BandaError, Botonera, FilaDato, Opcion } from '../../components/gestion/comun';
import { useDireccionPanel } from '../../components/gestion/consultas';

/** Pregunta antes de cerrar un diálogo con una contraseña recién generada. */
const CONFIRMAR_CONTRASENA: ConfirmarCierre = {
  pregunta: '¿Has guardado la contraseña?',
  detalle: 'No se podrá volver a ver.',
};

interface Respuesta {
  client: Client & { plan?: Plan; usage?: ClientUsage; users?: ClientUser[] };
  plan?: Plan;
  usage?: ClientUsage;
  users?: ClientUser[];
}

/** Buzones que se enseñan en la ficha; el resto, en «Buzones» filtrado. */
const BUZONES_EN_FICHA = 8;

export default function ClienteDetalle() {
  const { id = '' } = useParams();
  const [dialogo, setDialogo] = useState<
    null | 'editar' | 'usuario' | 'suspender' | 'eliminar' | { plan: Plan }
  >(null);
  const [fallosSuspension, setFallosSuspension] = useState<SuspensionResult['failed']>([]);

  const client = useQuery({
    queryKey: ['client', id],
    queryFn: () => api.get<Respuesta>(`/api/clients/${id}`),
  });
  const plans = useQuery({
    queryKey: ['plans'],
    queryFn: () => api.get<{ plans: Plan[] }>('/api/plans'),
  });
  const domains = useQuery({
    queryKey: ['domains', id],
    queryFn: () => api.get<{ domains: DomainRecord[] }>(`/api/domains?clientId=${encodeURIComponent(id)}`),
  });
  const mailboxes = useQuery({
    queryKey: ['mailboxes', 'cliente', id],
    queryFn: () => api.get<{ mailboxes: Mailbox[] }>(`/api/mailboxes?clientId=${encodeURIComponent(id)}`),
  });

  const volver = (
    <Link to="/clientes" className="text-sm text-petroleo underline decoration-1 underline-offset-2 hover:text-tinta">
      Volver a Clientes
    </Link>
  );

  if (client.isPending) {
    return (
      <Hoja>
        <Cargando label="Cargando el cliente…" />
      </Hoja>
    );
  }
  if (client.isError || !client.data) {
    const noExiste = client.error instanceof ApiError && client.error.status === 404;
    return (
      <div className="flex flex-col gap-3">
        <BandaError onRetry={noExiste ? undefined : () => void client.refetch()}>
          {noExiste ? 'Cliente no encontrado.' : mensajeDe(client.error, 'No se ha podido cargar la ficha del cliente.')}
        </BandaError>
        {volver}
      </div>
    );
  }

  const data = client.data.client;
  const plan = client.data.plan ?? data.plan;
  const usage = client.data.usage ?? data.usage;
  // El dominio anterior de un cambio abierto no cuenta en el plan: se descuenta
  // igual que hace el servidor en el límite y en el exceso del plan.
  const usoPlan = usage && { ...usage, domains: dominiosQueCuentan(usage.domains, domains.data?.domains ?? []) };
  const users = client.data.users ?? data.users ?? [];
  // Mismo veredicto y orden que en «Dominios»: lo pendiente, primero.
  const domainList = [...(domains.data?.domains ?? [])].sort(
    (a, b) => pesoVeredicto[lecturaDominio(a).veredicto] - pesoVeredicto[lecturaDominio(b).veredicto],
  );
  const mailboxList = mailboxes.data?.mailboxes ?? [];
  const activos = mailboxList.filter((m) => m.status === 'active').length;

  return (
    <>
      <Membrete
        title={data.name}
        meta={
          <div className="flex flex-col gap-2">
            <Link to="/clientes" className="self-start text-sm text-petroleo underline decoration-1 underline-offset-2 hover:text-tinta">
              Volver a Clientes
            </Link>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <MarcaFondo veredicto={data.suspended ? 'fuera' : 'normal'}>
                {data.suspended ? 'Suspendido' : 'Activo'}
              </MarcaFondo>
              {plan && <span className="text-sm text-tinta-3">Plan «{plan.name}»</span>}
              {data.contactEmail && (
                <span className="valor min-w-0 break-all text-sm text-tinta-3">{data.contactEmail}</span>
              )}
              {vinculadoConSkyway(data.externalRef) && <span className="text-sm text-tinta-3">Vinculado con Skyway</span>}
            </span>
          </div>
        }
        actions={
          <>
            {/* Su webmail principal se elige en Marca blanca, con el cliente ya filtrado. */}
            <Link to={`/marca-blanca?cliente=${encodeURIComponent(id)}`} className={estiloBoton('perfil')}>
              Configurar webmail
            </Link>
            <Button variant="principal" onClick={() => setDialogo('editar')}>
              Editar datos
            </Button>
          </>
        }
      />

      {data.suspended && (
        <div className="mb-4 flex flex-col gap-2">
          <BandaError>
            Cliente suspendido: sus buzones no pueden iniciar sesión y no es posible crear dominios, buzones ni
            alias ni enviar por la API.
          </BandaError>
        </div>
      )}
      {fallosSuspension.length > 0 && (
        <div className="mb-4">
          <BandaAviso>
            No se ha podido aplicar el cambio en {plural(fallosSuspension.length, 'buzón', 'buzones')} del servidor
            de correo ({fallosSuspension.map((f) => f.email).join(', ')}). Comprueba el estado del motor y vuelve a
            aplicar el cambio desde «Estado del servicio».
          </BandaAviso>
        </div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Hoja title="Datos del cliente" flush>
          <FilaDato rotulo="Nombre">{data.name}</FilaDato>
          <FilaDato rotulo="Correo de contacto">
            {data.contactEmail ? (
              <span className="valor break-all text-sm">{data.contactEmail}</span>
            ) : (
              <span className="text-tinta-3">Sin indicar</span>
            )}
          </FilaDato>
          <FilaDato rotulo="Alta">
            <span className="valor text-sm">{formatDay(data.createdAt)}</span>
          </FilaDato>
          {data.externalRef && (
            <FilaDato rotulo="Vínculo externo">
              {vinculadoConSkyway(data.externalRef) ? 'Vinculado con Skyway' : 'Vinculado'}{' '}
              <span className="valor block break-all text-sm text-tinta-3">{data.externalRef}</span>
            </FilaDato>
          )}
          <div className="px-4 py-2.5">
            <p className="rotulo">Notas</p>
            <p className="mt-1 whitespace-pre-line break-words text-base text-tinta-2">
              {data.notes || <span className="text-tinta-3">Sin notas.</span>}
            </p>
          </div>
        </Hoja>

        <Hoja title="Plan y carga">
          <div className="flex flex-col gap-4">
            {plans.isError ? (
              <BandaError onRetry={() => void plans.refetch()}>No se han podido cargar los planes.</BandaError>
            ) : (
              <Select
                label="Plan asignado"
                value={data.planId}
                onChange={(e) => {
                  const next = (plans.data?.plans ?? []).find((p) => p.id === e.target.value);
                  // No se aplica al elegir: primero se confirman los límites nuevos.
                  if (next && next.id !== data.planId) setDialogo({ plan: next });
                }}
                help="Al elegir otro plan se muestran sus límites antes de aplicarlo."
              >
                {(plans.data?.plans ?? (plan ? [plan] : [])).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {plural(p.maxMailboxes, 'buzón', 'buzones')}, {formatQuota(p.mailboxQuotaMb)} por buzón
                  </option>
                ))}
              </Select>
            )}
            {plan && usage ? (
              <>
                <div className="flex flex-col gap-3">
                  <Escala label="Dominios" usado={usoPlan?.domains ?? usage.domains} maximo={plan.maxDomains} />
                  <Escala label="Buzones" usado={usage.mailboxes} maximo={plan.maxMailboxes} />
                  <Escala label="Alias" usado={usage.aliases} maximo={plan.maxAliases} />
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-regla pt-3">
                  <span className="text-base text-tinta">Envíos por API (últimos 30 días)</span>
                  <span className="valor text-md text-tinta">{usage.messagesLast30d}</span>
                </div>
              </>
            ) : (
              <p className="text-sm text-tinta-3">Sin datos de uso.</p>
            )}
          </div>
        </Hoja>
      </div>

      <Hoja
        title="Usuarios con acceso al panel"
        meta={plural(users.length, 'usuario', 'usuarios')}
        actions={
          <Button variant="perfil" onClick={() => setDialogo('usuario')}>
            Añadir usuario
          </Button>
        }
        className="mt-4"
        flush
      >
        {users.length === 0 ? (
          <Vacio icono={UserRound} title="Sin usuarios de acceso">
            Este cliente aún no puede entrar en su panel. Añade su primer usuario con «Añadir usuario».
          </Vacio>
        ) : (
          <ul>
            {users.map((user) => (
              <FilaUsuario key={user.id} clientId={id} user={user} />
            ))}
          </ul>
        )}
      </Hoja>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-2">
        <Hoja
          title="Dominios"
          meta={domains.isPending ? 'cargando…' : plural(domainList.length, 'dominio', 'dominios')}
          actions={
            <Link to="/dominios" className="text-sm text-petroleo underline decoration-1 underline-offset-2 hover:text-tinta">
              Ir a Dominios
            </Link>
          }
          flush
        >
          {domains.isPending ? (
            <Cargando label="Cargando los dominios del cliente…" />
          ) : domains.isError ? (
            <div className="p-4">
              <BandaError onRetry={() => void domains.refetch()}>No se han podido cargar los dominios.</BandaError>
            </div>
          ) : domainList.length === 0 ? (
            <Vacio icono={Globe} title="Sin dominios">El cliente puede añadirlos desde su panel, o tú desde «Dominios».</Vacio>
          ) : (
            <ul>
              {domainList.map((domain) => (
                <li key={domain.id} className="regla-fila last:border-b-0">
                  <Link
                    to={`/dominios/${domain.id}`}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 transition-colors duration-100 hover:bg-hoja-2"
                  >
                    <span className="valor min-w-0 basis-full break-all text-base text-tinta sm:basis-0 sm:grow">
                      {domain.domain}
                    </span>
                    <span className="shrink-0">
                      <MarcaFondo veredicto={lecturaDominio(domain).veredicto}>{lecturaDominio(domain).etiqueta}</MarcaFondo>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Hoja>

        <Hoja
          title="Buzones"
          meta={mailboxes.isPending ? 'cargando…' : plural(mailboxList.length, 'buzón', 'buzones')}
          actions={
            <Link
              to={`/buzones?cliente=${encodeURIComponent(id)}`}
              className="text-sm text-petroleo underline decoration-1 underline-offset-2 hover:text-tinta"
            >
              Gestionar en Buzones
            </Link>
          }
          flush
        >
          {mailboxes.isPending ? (
            <Cargando label="Cargando los buzones del cliente…" />
          ) : mailboxes.isError ? (
            <div className="p-4">
              <BandaError onRetry={() => void mailboxes.refetch()}>No se han podido cargar los buzones.</BandaError>
            </div>
          ) : mailboxList.length === 0 ? (
            <Vacio icono={Inbox} title="Sin buzones">
              {domainList.length > 0
                ? 'Todavía no hay buzones. Créalos desde «Buzones».'
                : 'Los buzones se crean en «Buzones», una vez añadido un dominio.'}
            </Vacio>
          ) : (
            <ul>
              {mailboxList.slice(0, BUZONES_EN_FICHA).map((m) => {
                const v = veredictoUso(m.usedBytes, m.quotaMb);
                return (
                  <li
                    key={m.id}
                    className={`regla-fila flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 last:border-b-0 ${
                      v === 'fuera' ? 'fila-fuera' : v === 'vigilar' ? 'fila-vigilar' : ''
                    }`}
                  >
                    <Link
                      to={`/buzones?cliente=${encodeURIComponent(id)}&q=${encodeURIComponent(m.email)}`}
                      className="valor min-w-0 basis-full break-all text-sm text-tinta hover:text-petroleo hover:underline sm:basis-0 sm:grow"
                    >
                      {m.email}
                    </Link>
                    <span className="valor shrink-0 text-sm text-tinta-3">
                      {m.usedBytes === null ? '—' : formatBytes(m.usedBytes)} / {formatQuota(m.quotaMb)}
                    </span>
                    {m.status === 'suspended' && <MarcaFondo veredicto="fuera">Suspendido</MarcaFondo>}
                  </li>
                );
              })}
              {mailboxList.length > BUZONES_EN_FICHA && (
                <li className="px-4 py-2.5">
                  <Link
                    to={`/buzones?cliente=${encodeURIComponent(id)}`}
                    className="text-sm text-petroleo underline decoration-1 underline-offset-2 hover:text-tinta"
                  >
                    Ver los {mailboxList.length} buzones
                  </Link>
                </li>
              )}
            </ul>
          )}
        </Hoja>
      </div>

      <Hoja title="Estado del servicio" className="mt-4" flush>
        <div className="regla-fila flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <div className="min-w-0 max-w-[75ch] flex-1 basis-60">
            <p className="text-base text-tinta">{data.suspended ? 'Reactivar el cliente' : 'Suspender el cliente'}</p>
            <p className="text-sm text-tinta-3">
              {data.suspended
                ? 'Sus buzones vuelven a funcionar, salvo los que se suspendieron individualmente.'
                : 'Sus buzones dejan de poder iniciar sesión y se bloquean las altas y los envíos por API. No se borra nada.'}
            </p>
          </div>
          <Button variant={data.suspended ? 'perfil' : 'peligro'} onClick={() => setDialogo('suspender')}>
            {data.suspended ? 'Reactivar' : 'Suspender'}
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <div className="min-w-0 max-w-[75ch] flex-1 basis-60">
            <p className="text-base text-tinta">Eliminar el cliente</p>
            <p className="text-sm text-tinta-3">
              {domainList.length === 1
                ? 'Antes es necesario eliminar su dominio (y con él sus buzones).'
                : domainList.length > 1
                  ? `Antes es necesario eliminar sus ${domainList.length} dominios (y con ellos sus buzones).`
                  : 'Se eliminan el cliente y sus usuarios del panel.'}
            </p>
          </div>
          <Button variant="peligro" disabled={domainList.length > 0} onClick={() => setDialogo('eliminar')}>
            Eliminar
          </Button>
        </div>
      </Hoja>

      {dialogo === 'editar' && <EditarDatos client={data} onClose={() => setDialogo(null)} />}
      {dialogo === 'usuario' && <AnadirUsuario clientId={id} clientName={data.name} onClose={() => setDialogo(null)} />}
      {dialogo === 'suspender' && (
        <Suspender
          client={data}
          buzonesActivos={activos}
          buzones={mailboxList.length}
          onClose={() => setDialogo(null)}
          onFallos={setFallosSuspension}
        />
      )}
      {dialogo === 'eliminar' && <EliminarCliente client={data} onClose={() => setDialogo(null)} />}
      {dialogo !== null && typeof dialogo === 'object' && plan && usoPlan && (
        <CambiarPlan
          clientId={id}
          actual={plan}
          nuevo={dialogo.plan}
          usage={usoPlan}
          mailboxes={mailboxList}
          onClose={() => setDialogo(null)}
        />
      )}
    </>
  );
}

/* --------------------------------- Datos ---------------------------------- */

function useRefrescarCliente(id: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['client', id] }),
      queryClient.invalidateQueries({ queryKey: ['clients'] }),
      queryClient.invalidateQueries({ queryKey: ['plans'] }),
      queryClient.invalidateQueries({ queryKey: ['mailboxes'] }),
    ]);
}

function EditarDatos({ client, onClose }: { client: Client; onClose: () => void }) {
  const toast = useToast();
  const refrescar = useRefrescarCliente(client.id);
  const [name, setName] = useState(client.name);
  const [contactEmail, setContactEmail] = useState(client.contactEmail);
  const [notes, setNotes] = useState(client.notes);
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () => api.patch(`/api/clients/${client.id}`, { name, contactEmail, notes }),
    onSuccess: async () => {
      await refrescar();
      toast('ok', 'Datos del cliente actualizados.');
      onClose();
    },
    onError: (err) => setError(mensajeDe(err, 'No se han podido guardar los datos.')),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) {
      setError('El nombre del cliente debe tener al menos 2 caracteres.');
      return;
    }
    if (contactEmail.trim() && !esCorreoValido(contactEmail)) {
      setError('El correo de contacto no es una dirección válida.');
      return;
    }
    setError('');
    save.mutate();
  }

  return (
    <Dialogo open onClose={onClose} title="Editar datos del cliente">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Input
          label="Nombre"
          maxLength={80}
          value={name}
          onChange={(e) => {
            setError('');
            setName(e.target.value);
          }}
        />
        <Input
          label="Correo de contacto"
          type="email"
          value={contactEmail}
          onChange={(e) => {
            setError('');
            setContactEmail(e.target.value);
          }}
          help="Opcional. Se usa para comunicaciones con el cliente."
        />
        <Textarea
          label="Notas internas"
          maxLength={1000}
          value={notes}
          onChange={(e) => {
            setError('');
            setNotes(e.target.value);
          }}
          help="Solo las ve el administrador."
        />
        {error && <BandaError>{error}</BandaError>}
        <Botonera>
          <Button type="button" variant="plano" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="principal" busy={save.isPending}>
            Guardar cambios
          </Button>
        </Botonera>
      </form>
    </Dialogo>
  );
}

/* ------------------------------- Cambio de plan --------------------------- */

function CambiarPlan({
  clientId,
  actual,
  nuevo,
  usage,
  mailboxes,
  onClose,
}: {
  clientId: string;
  actual: Plan;
  nuevo: Plan;
  usage: ClientUsage;
  mailboxes: Mailbox[];
  onClose: () => void;
}) {
  const toast = useToast();
  const refrescar = useRefrescarCliente(clientId);
  const [error, setError] = useState('');

  const cuotaNueva = nuevo.mailboxQuotaMb * 1024 * 1024;
  const llenos = mailboxes.filter((m) => m.usedBytes !== null && m.usedBytes > cuotaNueva).length;
  const conCuotaMayor = mailboxes.filter((m) => m.quotaMb > nuevo.mailboxQuotaMb).length;
  const texto = (n: number) => (n === 0 ? 'Sin límite' : String(n));
  // Una fila por límite: uso actual, límite actual y límite nuevo. Se tiñe
  // la que no cabe en el plan nuevo (el servidor también lo rechazaría).
  const filas: { concepto: string; uso: string; antes: string; despues: string; fuera: boolean }[] = [
    { concepto: 'Dominios', uso: String(usage.domains), antes: String(actual.maxDomains), despues: String(nuevo.maxDomains), fuera: usage.domains > nuevo.maxDomains },
    { concepto: 'Buzones', uso: String(usage.mailboxes), antes: String(actual.maxMailboxes), despues: String(nuevo.maxMailboxes), fuera: usage.mailboxes > nuevo.maxMailboxes },
    { concepto: 'Alias', uso: String(usage.aliases), antes: String(actual.maxAliases), despues: String(nuevo.maxAliases), fuera: usage.aliases > nuevo.maxAliases },
    {
      concepto: 'Cuota por buzón',
      uso: llenos > 0 ? `${llenos === 1 ? '1 buzón supera' : `${llenos} buzones superan`} la cuota` : '—',
      antes: formatQuota(actual.mailboxQuotaMb),
      despues: formatQuota(nuevo.mailboxQuotaMb),
      fuera: llenos > 0,
    },
    { concepto: 'Envíos por API al día', uso: '—', antes: texto(actual.apiDailyLimit), despues: texto(nuevo.apiDailyLimit), fuera: false },
    { concepto: 'Envíos por API por minuto', uso: '—', antes: String(actual.apiPerMinuteLimit), despues: String(nuevo.apiPerMinuteLimit), fuera: false },
  ];
  const excede = filas.some((f) => f.fuera);

  const change = useMutation({
    mutationFn: () => api.patch(`/api/clients/${clientId}`, { planId: nuevo.id }),
    onSuccess: async () => {
      await refrescar();
      toast('ok', `Plan cambiado a «${nuevo.name}».`);
      onClose();
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido cambiar el plan.')),
  });

  return (
    <Dialogo open onClose={onClose} title="Cambiar de plan">
      <div className="flex flex-col gap-4">
        <p className="text-base text-tinta-2">
          De «{actual.name}» a «{nuevo.name}». Límites del nuevo plan frente al uso actual:
        </p>
        <div className="overflow-hidden rounded-lg border border-regla">
          <div className="regla-cabecera hidden items-baseline gap-x-3 px-3 py-1.5 sm:flex">
            <span className="rotulo min-w-0 grow basis-0">Concepto</span>
            <span className="rotulo w-20 shrink-0 text-right">Uso</span>
            <span className="rotulo w-16 shrink-0 text-right">Actual</span>
            <span className="rotulo w-16 shrink-0 text-right">Nuevo</span>
          </div>
          {filas.map((f) => (
            <div
              key={f.concepto}
              className={`regla-fila flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 last:border-b-0 ${f.fuera ? 'fila-fuera' : ''}`}
            >
              <span className="min-w-0 grow basis-full text-base text-tinta sm:basis-0">{f.concepto}</span>
              <span className="flex shrink-0 items-baseline gap-1.5 sm:w-20 sm:justify-end">
                <span className="rotulo sm:hidden">Uso</span>
                <span className={`valor text-sm ${f.fuera ? 'text-fuera' : 'text-tinta-2'}`}>{f.uso}</span>
              </span>
              <span className="flex shrink-0 items-baseline gap-1.5 sm:w-16 sm:justify-end">
                <span className="rotulo sm:hidden">Actual</span>
                <span className="valor text-sm text-tinta-3">{f.antes}</span>
              </span>
              <span className="flex shrink-0 items-baseline gap-1.5 sm:w-16 sm:justify-end">
                <span className="rotulo sm:hidden">Nuevo</span>
                <span className={`valor text-sm ${f.fuera ? 'text-fuera' : 'text-tinta'}`}>{f.despues}</span>
              </span>
            </div>
          ))}
        </div>
        {excede ? (
          <BandaError>
            El uso actual del cliente no cabe en el plan «{nuevo.name}». Reduce antes el uso (dominios, buzones,
            alias u ocupación de los buzones) o elige un plan con más capacidad.
          </BandaError>
        ) : (
          conCuotaMayor > 0 && (
            <BandaAviso>
              {conCuotaMayor === 1 ? '1 buzón tiene' : `${conCuotaMayor} buzones tienen`} una cuota mayor que la del
              nuevo plan ({formatQuota(nuevo.mailboxQuotaMb)}) y la conservarán hasta que se modifique.
            </BandaAviso>
          )
        )}
        {error && <BandaError>{error}</BandaError>}
        <Botonera>
          <Button variant="plano" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="principal" disabled={excede} busy={change.isPending} onClick={() => change.mutate()}>
            Cambiar a «{nuevo.name}»
          </Button>
        </Botonera>
      </div>
    </Dialogo>
  );
}

/* -------------------------------- Usuarios -------------------------------- */

function CredencialUsuario({ clientId, email, password }: { clientId: string; email: string; password: string }) {
  const panel = useDireccionPanel({ clientId });
  return (
    <>
      <BandaAviso>
        La contraseña <strong className="font-semibold">solo se muestra ahora</strong>. Entrégala por un canal
        seguro; el usuario podrá cambiarla desde «Mi cuenta».
      </BandaAviso>
      <Muestra rotulo="Dirección del panel" copiar={panel}>
        <p className="valor break-all text-base text-tinta">{panel}</p>
      </Muestra>
      <Muestra rotulo="Usuario" copiar={email}>
        <p className="valor break-all text-base text-tinta">{email}</p>
      </Muestra>
      <Muestra rotulo="Contraseña" copiar={password}>
        <p className="codigo break-all text-base text-tinta">{password}</p>
      </Muestra>
    </>
  );
}

function AnadirUsuario({ clientId, clientName, onClose }: { clientId: string; clientName: string; onClose: () => void }) {
  const refrescar = useRefrescarCliente(clientId);
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [modo, setModo] = useState<'generar' | 'propia'>('generar');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [creado, setCreado] = useState<{ email: string; password: string } | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ user: { email: string }; password?: string }>(`/api/clients/${clientId}/users`, {
        name,
        email,
        password: modo === 'propia' ? password : undefined,
      }),
    onSuccess: async (data) => {
      await refrescar();
      if (data.password) {
        setCreado({ email: data.user.email, password: data.password });
      } else {
        toast('ok', `Usuario ${data.user.email} creado.`);
        onClose();
      }
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido crear el usuario.')),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) {
      setError('El nombre debe tener al menos 2 caracteres.');
      return;
    }
    if (!esCorreoValido(email)) {
      setError('Indica un correo válido: será el usuario con el que entrará en el panel.');
      return;
    }
    if (modo === 'propia' && password.length < 10) {
      setError('La contraseña debe tener al menos 10 caracteres.');
      return;
    }
    setError('');
    create.mutate();
  }

  function limpiar<T>(set: (v: T) => void) {
    return (v: T) => {
      setError('');
      set(v);
    };
  }

  return (
    <Dialogo
      open
      onClose={onClose}
      title={creado ? 'Usuario creado' : 'Añadir usuario del panel'}
      confirmarCierre={creado ? CONFIRMAR_CONTRASENA : null}
      pie={
        creado ? (
          <Button variant="principal" onClick={onClose}>
            Ya he guardado la contraseña
          </Button>
        ) : undefined
      }
    >
      {creado ? (
        <div className="flex flex-col gap-4">
          <CredencialUsuario clientId={clientId} email={creado.email} password={creado.password} />
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <p className="text-base text-tinta-2">
            Este usuario entrará en el panel de {clientName} y podrá gestionar sus dominios, buzones, alias y
            claves de API, dentro de los límites del plan.
          </p>
          <Input label="Nombre" maxLength={80} value={name} onChange={(e) => limpiar(setName)(e.target.value)} />
          <Input
            label="Correo (será su usuario)"
            type="email"
            value={email}
            onChange={(e) => limpiar(setEmail)(e.target.value)}
          />
          <fieldset className="flex flex-col gap-2.5">
            <legend className="rotulo mb-2">Contraseña</legend>
            <Opcion
              name="usuario-modo"
              checked={modo === 'generar'}
              onChange={() => limpiar(setModo)('generar')}
              label="Generar una contraseña segura"
              help="Se mostrará una sola vez."
            />
            <Opcion
              name="usuario-modo"
              checked={modo === 'propia'}
              onChange={() => limpiar(setModo)('propia')}
              label="Escribir una contraseña"
            />
          </fieldset>
          {modo === 'propia' && (
            <Input
              label="Contraseña"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => limpiar(setPassword)(e.target.value)}
              help="Mínimo 10 caracteres."
            />
          )}
          {error && <BandaError>{error}</BandaError>}
          <Botonera>
            <Button type="button" variant="plano" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" variant="principal" busy={create.isPending}>
              Crear usuario
            </Button>
          </Botonera>
        </form>
      )}
    </Dialogo>
  );
}

function FilaUsuario({ clientId, user }: { clientId: string; user: ClientUser }) {
  const refrescar = useRefrescarCliente(clientId);
  const toast = useToast();
  const [dialogo, setDialogo] = useState<null | 'restablecer' | 'eliminar'>(null);
  const [nueva, setNueva] = useState<string | null>(null);
  const [error, setError] = useState('');

  const toggle = useMutation({
    mutationFn: () => api.patch(`/api/clients/${clientId}/users/${user.id}`, { disabled: !user.disabled }),
    onSuccess: async () => {
      await refrescar();
      toast('ok', user.disabled ? `Usuario ${user.email} habilitado.` : `Usuario ${user.email} deshabilitado.`);
    },
    onError: (err) => toast('error', mensajeDe(err, 'No se ha podido cambiar el usuario.')),
  });

  const reset = useMutation({
    mutationFn: () =>
      api.patch<{ ok: boolean; password?: string }>(`/api/clients/${clientId}/users/${user.id}`, {
        generatePassword: true,
      }),
    onSuccess: (data) => {
      setNueva(data.password ?? null);
      setError('');
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido restablecer la contraseña.')),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/clients/${clientId}/users/${user.id}`),
    onSuccess: async () => {
      setDialogo(null);
      await refrescar();
      toast('ok', `Usuario ${user.email} eliminado.`);
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido eliminar el usuario.')),
  });

  function cerrar() {
    setDialogo(null);
    setNueva(null);
    setError('');
  }

  function abrir(cual: 'restablecer' | 'eliminar') {
    // Cada apertura empieza limpia: sin el error ni el estado de la anterior.
    setError('');
    reset.reset();
    remove.reset();
    setDialogo(cual);
  }

  return (
    <li className="regla-fila flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 last:border-b-0">
      {/* Nombre y correo identifican la fila: nunca se recortan. */}
      <div className="min-w-0 basis-full sm:basis-0 sm:grow">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-base font-medium text-tinta">
          {user.name}
          {user.disabled && <MarcaFondo veredicto="fuera">Deshabilitado</MarcaFondo>}
        </p>
        <p className="text-sm text-tinta-3">
          <span className="valor break-all">{user.email}</span> · último acceso{' '}
          <span className="valor">{formatDate(user.lastLoginAt)}</span>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button variant="plano" className="px-2" onClick={() => abrir('restablecer')}>
          Restablecer contraseña
        </Button>
        <Button variant="plano" className="px-2" busy={toggle.isPending} onClick={() => toggle.mutate()}>
          {user.disabled ? 'Habilitar' : 'Deshabilitar'}
        </Button>
        <Button variant="peligro" className="px-2" onClick={() => abrir('eliminar')}>
          Eliminar
        </Button>
      </div>

      <Dialogo
        open={dialogo === 'restablecer'}
        onClose={cerrar}
        title={nueva ? 'Contraseña restablecida' : 'Restablecer contraseña del usuario'}
        confirmarCierre={nueva ? CONFIRMAR_CONTRASENA : null}
        pie={
          nueva ? (
            <Button variant="principal" onClick={cerrar}>
              Ya he guardado la contraseña
            </Button>
          ) : undefined
        }
      >
        {nueva ? (
          <div className="flex flex-col gap-4">
            <CredencialUsuario clientId={clientId} email={user.email} password={nueva} />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2">
              Se generará una contraseña nueva para <span className="valor break-all">{user.email}</span> y se
              cerrarán sus sesiones abiertas. La contraseña se mostrará una sola vez.
            </p>
            {error && <BandaError>{error}</BandaError>}
            <Botonera>
              <Button variant="plano" onClick={cerrar}>
                Cancelar
              </Button>
              <Button variant="principal" busy={reset.isPending} onClick={() => reset.mutate()}>
                Generar contraseña
              </Button>
            </Botonera>
          </div>
        )}
      </Dialogo>

      <Dialogo open={dialogo === 'eliminar'} onClose={cerrar} title="Eliminar usuario">
        <div className="flex flex-col gap-4">
          <p className="text-base text-tinta-2">
            <span className="valor break-all">{user.email}</span> dejará de poder entrar en el panel y se cerrarán
            sus sesiones. Los buzones y dominios del cliente no se modifican.
          </p>
          {error && <BandaError>{error}</BandaError>}
          <Botonera>
            <Button variant="plano" onClick={cerrar}>
              Cancelar
            </Button>
            <Button variant="peligro" busy={remove.isPending} onClick={() => remove.mutate()}>
              Eliminar usuario
            </Button>
          </Botonera>
        </div>
      </Dialogo>
    </li>
  );
}

/* ------------------------------ Estado y baja ----------------------------- */

function Suspender({
  client,
  buzonesActivos,
  buzones,
  onClose,
  onFallos,
}: {
  client: Client;
  buzonesActivos: number;
  buzones: number;
  onClose: () => void;
  onFallos: (fallos: SuspensionResult['failed']) => void;
}) {
  const toast = useToast();
  const refrescar = useRefrescarCliente(client.id);
  const [error, setError] = useState('');
  const suspender = !client.suspended;

  const change = useMutation({
    mutationFn: () =>
      api.patch<{ suspension?: SuspensionResult }>(`/api/clients/${client.id}`, { suspended: suspender }),
    onSuccess: async (data) => {
      await refrescar();
      const fallos = data.suspension?.failed ?? [];
      onFallos(fallos);
      if (fallos.length > 0) {
        toast('error', `No se ha podido aplicar el cambio en ${plural(fallos.length, 'buzón', 'buzones')}.`);
      } else {
        toast('ok', suspender ? `Cliente ${client.name} suspendido.` : `Cliente ${client.name} reactivado.`);
      }
      onClose();
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido cambiar el estado del cliente.')),
  });

  const individuales = buzones - buzonesActivos;

  return (
    <Dialogo open onClose={onClose} title={suspender ? 'Suspender cliente' : 'Reactivar cliente'}>
      <div className="flex flex-col gap-4">
        {suspender ? (
          <>
            <p className="text-base text-tinta-2">Al suspender {client.name}:</p>
            <ul className="list-disc pl-5 text-base text-tinta-2">
              <li>
                {buzonesActivos === 0
                  ? 'No tiene buzones activos que suspender.'
                  : `Se suspenderán ${plural(buzonesActivos, 'buzón', 'buzones')} en el servidor de correo: sus titulares no podrán iniciar sesión en ningún programa, móvil ni en el webmail.`}
              </li>
              <li>No se podrán crear dominios, buzones ni alias, ni enviar por la API.</li>
              <li>No se borra nada: el correo y la configuración se conservan.</li>
            </ul>
          </>
        ) : (
          <p className="text-base text-tinta-2">
            Al reactivar {client.name}, sus buzones vuelven a funcionar con sus contraseñas actuales.
            {individuales > 0 &&
              ` ${individuales === 1 ? 'El buzón que se suspendió' : `Los ${individuales} buzones que se suspendieron`} individualmente seguirán suspendidos.`}
          </p>
        )}
        {error && <BandaError>{error}</BandaError>}
        <Botonera>
          <Button variant="plano" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant={suspender ? 'peligro' : 'principal'} busy={change.isPending} onClick={() => change.mutate()}>
            {suspender ? 'Suspender cliente' : 'Reactivar cliente'}
          </Button>
        </Botonera>
      </div>
    </Dialogo>
  );
}

function EliminarCliente({ client, onClose }: { client: Client; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [confirmacion, setConfirmacion] = useState('');
  const [error, setError] = useState('');

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/clients/${client.id}`),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['clients'] }),
        queryClient.invalidateQueries({ queryKey: ['plans'] }),
      ]);
      toast('ok', `Cliente ${client.name} eliminado.`);
      navigate('/clientes');
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido eliminar el cliente.')),
  });

  return (
    <Dialogo open onClose={onClose} title="Eliminar cliente">
      <div className="flex flex-col gap-4">
        <p className="text-base text-tinta-2">
          Se eliminarán {client.name} y sus usuarios del panel. Esta acción no se puede deshacer.
        </p>
        <Input
          label="Escribe el nombre del cliente para confirmar"
          autoComplete="off"
          value={confirmacion}
          onChange={(e) => {
            setError('');
            setConfirmacion(e.target.value);
          }}
          placeholder={client.name}
        />
        {error && <BandaError>{error}</BandaError>}
        <Botonera>
          <Button variant="plano" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="peligro"
            disabled={confirmacion.trim() !== client.name}
            busy={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Eliminar cliente
          </Button>
        </Botonera>
      </div>
    </Dialogo>
  );
}
