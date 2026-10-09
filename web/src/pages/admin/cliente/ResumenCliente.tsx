import { useMemo, useState } from 'react';
import { Globe } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Client, type ClientUsage, type DomainRecord, type Mailbox, type Plan } from '../../../lib/api';
import { formatDate, formatDay, plural } from '../../../lib/format';
import { formatQuota, mensajeDe, vinculadoConSkyway, type SuspensionResult } from '../../../lib/gestion';
import { lecturaDominio, nombreVisible } from '../../../lib/cloudflare';
import { pesoVeredicto } from '../../../lib/dominios';
import { Button, estiloBoton } from '../../../ui/Button';
import { Input, Select } from '../../../ui/Field';
import { Dialogo, Escala, Hoja, MarcaFondo, Cargando, Vacio } from '../../../ui/kit';
import { useToast } from '../../../ui/toast';
import { BandaAviso, BandaError, Botonera, FilaDato, rutaCliente } from '../../../components/gestion/comun';
import { SiguientePasoBienvenida } from '../../../components/EnlaceBienvenida';
import { lecturaCuenta } from '../../puesta/comun';
import { NOMBRE_MOTOR } from '../../../lib/correoweb';
import { useRefrescarCliente, type ContextoCliente } from './datos';

/** Dominios que se enseñan en el resumen; el resto, en la pestaña «Dominios». */
const DOMINIOS_EN_RESUMEN = 6;

/**
 * Pestaña «Resumen» de la ficha del cliente: sus datos, el plan con la carga
 * actual, el estado de sus dominios y el estado del servicio (suspender o
 * eliminar). Lo que tiene listas largas vive en su propia pestaña.
 */
export default function ResumenCliente({ contexto }: { contexto: ContextoCliente }) {
  const { id, cliente: data, plan, usage, usuarios } = contexto;
  const [dialogo, setDialogo] = useState<null | 'suspender' | 'eliminar' | { plan: Plan }>(null);
  const [fallosSuspension, setFallosSuspension] = useState<SuspensionResult['failed']>([]);

  const plans = useQuery({
    queryKey: ['plans'],
    queryFn: () => api.get<{ plans: Plan[] }>('/api/plans'),
  });
  // La misma lista (y caché) que «Dominios»: el cliente se filtra aquí.
  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ domains: DomainRecord[] }>('/api/domains'),
  });
  // Los mismos datos que la pestaña «Buzones»: suspender y cambiar de plan los necesitan.
  const mailboxes = useQuery({
    queryKey: ['mailboxes', 'cliente', id],
    queryFn: () => api.get<{ mailboxes: Mailbox[] }>(`/api/mailboxes?clientId=${encodeURIComponent(id)}`),
  });

  // Mismo veredicto y orden que en «Dominios»: lo pendiente, primero.
  const domainList = useMemo(
    () =>
      (domains.data?.domains ?? [])
        .filter((d) => d.clientId === id)
        .sort((a, b) => pesoVeredicto[lecturaDominio(a).veredicto] - pesoVeredicto[lecturaDominio(b).veredicto]),
    [domains.data, id],
  );
  const mailboxList = mailboxes.data?.mailboxes ?? [];
  const activos = mailboxList.filter((m) => m.status === 'active').length;

  return (
    <>
      <h2 className="sr-only">Resumen</h2>
      {fallosSuspension.length > 0 && (
        <div className="mb-4">
          <BandaAviso>
            No se ha podido aplicar el cambio en {plural(fallosSuspension.length, 'buzón', 'buzones')} del servidor
            de correo ({fallosSuspension.map((f) => f.email).join(', ')}). Comprueba el estado del motor y vuelve a
            aplicar el cambio desde «Estado del servicio».
          </BandaAviso>
        </div>
      )}

      {/* Sin usuarios, el cliente no puede entrar en su panel: lo primero es
          darle acceso, y la forma recomendada es el enlace de bienvenida. */}
      {usuarios.length === 0 && (
        <div className="mb-4">
          <SiguientePasoBienvenida
            clientId={id}
            clientName={data.name}
            contactEmail={data.contactEmail}
            suspended={data.suspended}
            alternativa={
              <Link
                to={rutaCliente(id, 'usuarios')}
                state={{ anadirUsuario: true }}
                className="text-sm text-petroleo underline decoration-1 underline-offset-2 hover:text-tinta"
              >
                O crea el usuario con una contraseña
              </Link>
            }
          />
        </div>
      )}

      {/* Con acceso ya creado: cómo va la configuración de su equipo, con el
          camino a su puesta en marcha (donde se resuelve). */}
      {usuarios.length > 0 && mailboxList.length > 0 && (
        <EstadoPuesta clientId={id} buzones={mailboxList} />
      )}

      {/* Dos columnas independientes: sin huecos entre tarjetas de distinta
          altura y, en el móvil, en orden de lectura (lo destructivo, al final). */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
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
            {data.webmailMotor && (
              <FilaDato rotulo="Correo web">
                {NOMBRE_MOTOR[data.webmailMotor]}{' '}
                <Link
                  to={rutaCliente(id, 'marca-blanca')}
                  className="text-sm text-petroleo underline decoration-1 underline-offset-2 hover:text-tinta"
                >
                  Cambiar
                </Link>
              </FilaDato>
            )}
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
                    <Escala label="Dominios" usado={usage.domains} maximo={plan.maxDomains} />
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

        <div className="flex min-w-0 flex-col gap-4">
          <Hoja
            title="Estado de los dominios"
            meta={domains.isPending ? 'cargando…' : plural(domainList.length, 'dominio', 'dominios')}
            actions={
              domainList.length > 0 ? (
                <Link
                  to={rutaCliente(id, 'dominios')}
                  className="text-sm text-petroleo underline decoration-1 underline-offset-2 hover:text-tinta"
                >
                  Ver los dominios
                </Link>
              ) : undefined
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
              <Vacio
                icono={Globe}
                title="Sin dominios"
                action={
                  <Link to={rutaCliente(id, 'dominios')} className={estiloBoton('perfil')}>
                    Ir a Dominios
                  </Link>
                }
              >
                Sin un dominio no hay buzones ni alias. Añade el primero en la pestaña «Dominios».
              </Vacio>
            ) : (
              <ul>
                {domainList.slice(0, DOMINIOS_EN_RESUMEN).map((domain) => {
                  const { veredicto, etiqueta } = lecturaDominio(domain);
                  return (
                    <li key={domain.id} className="regla-fila last:border-b-0">
                      <Link
                        to={`/dominios/${domain.id}`}
                        className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 transition-colors duration-100 hover:bg-hoja-2"
                      >
                        <span className="min-w-0 basis-full sm:basis-0 sm:grow">
                          <span className="valor break-all text-base text-tinta">{nombreVisible(domain)}</span>
                          <span className="block text-sm text-tinta-3">
                            Comprobado: {formatDate(domain.lastCheckedAt)}
                          </span>
                        </span>
                        <span className="shrink-0">
                          <MarcaFondo veredicto={veredicto}>{etiqueta}</MarcaFondo>
                        </span>
                      </Link>
                    </li>
                  );
                })}
                {domainList.length > DOMINIOS_EN_RESUMEN && (
                  <li className="px-4 py-2.5">
                    <Link
                      to={rutaCliente(id, 'dominios')}
                      className="text-sm text-petroleo underline decoration-1 underline-offset-2 hover:text-tinta"
                    >
                      Ver los {domainList.length} dominios
                    </Link>
                  </li>
                )}
              </ul>
            )}
          </Hoja>

          <Hoja title="Estado del servicio" flush>
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
              <Button
                variant="peligro"
                disabled={domains.isPending || domainList.length > 0}
                onClick={() => setDialogo('eliminar')}
              >
                Eliminar
              </Button>
            </div>
          </Hoja>
        </div>
      </div>

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
      {dialogo !== null && typeof dialogo === 'object' && plan && usage && (
        <CambiarPlan
          clientId={id}
          actual={plan}
          nuevo={dialogo.plan}
          usage={usage}
          mailboxes={mailboxList}
          onClose={() => setDialogo(null)}
        />
      )}
    </>
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

/**
 * Cómo va la configuración de los buzones del cliente: cuántos están ya
 * configurados por su titular y cuántos sin configurar (en rojo, porque a
 * alguien no le ha llegado o no ha abierto su configuración). Se resuelve en
 * la pestaña «Puesta en marcha».
 */
function EstadoPuesta({ clientId, buzones }: { clientId: string; buzones: Mailbox[] }) {
  const activos = buzones.filter((b) => b.status === 'active');
  const lecturas = activos.map(lecturaCuenta);
  const sinConfigurar = lecturas.filter((l) => l.estado === 'sin-configurar').length;
  const enviados = lecturas.filter((l) => l.estado === 'enviado').length;
  const configurados = lecturas.filter((l) => l.estado === 'configurado').length;
  const veredicto = sinConfigurar > 0 ? 'fuera' : enviados > 0 ? 'vigilar' : 'normal';
  return (
    <div className="mb-4">
      <Hoja>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1 basis-64">
            <p className="flex flex-wrap items-center gap-2 text-md font-semibold text-tinta">
              Puesta en marcha
              <MarcaFondo veredicto={veredicto}>
                {sinConfigurar > 0
                  ? `${sinConfigurar} sin configurar`
                  : enviados > 0
                    ? `${enviados} pendientes de terminar`
                    : 'Todo configurado'}
              </MarcaFondo>
            </p>
            <p className="mt-1 max-w-[68ch] text-base text-tinta-2">
              {configurados} de {plural(activos.length, 'buzón configurado', 'buzones configurados')} por su titular.
              {sinConfigurar > 0 && ' A quien le falta se le envía la configuración desde la puesta en marcha del cliente.'}
            </p>
          </div>
          <Link to={rutaCliente(clientId, 'puesta-en-marcha')} className={estiloBoton(sinConfigurar > 0 ? 'principal' : 'perfil')}>
            Abrir la puesta en marcha
          </Link>
        </div>
      </Hoja>
    </div>
  );
}
