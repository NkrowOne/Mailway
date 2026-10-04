import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type CheckStatus, type DnsCheck, type SetupStatus, type User } from '../lib/api';
import {
  invalidarTrasAltaOBaja,
  lecturaDominio,
  medicionIlegible,
  nombreVisible,
  propiedadPendiente,
  type DominioCorreo,
  type EstadoAltaDominio,
  type RegistroPropiedad,
} from '../lib/cloudflare';
import type { ConflictoDominio } from '../lib/dominios';
import { BloqueCloudflare } from '../components/cloudflare/BloqueCloudflare';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';
import {
  AvisoError,
  CabeceraMedidas,
  Dialogo,
  Hoja,
  MarcaFondo,
  Medida,
  Membrete,
  Cargando,
  Muestra,
  type Veredicto,
} from '../ui/kit';
import { useToast } from '../ui/toast';
import { formatDate } from '../lib/format';

/*
  El análisis del dominio.

  Cada registro DNS es una MEDICIÓN: `expected` es el valor de referencia,
  `found` es el valor medido y el estado es el veredicto. Lo que está fuera de
  rango se lee primero; lo que está en rango baja al final de su grupo.
*/

const veredictoDe: Record<CheckStatus, Veredicto> = {
  ok: 'normal',
  missing: 'fuera',
  mismatch: 'fuera',
  unknown: 'sin-dato',
};

const etiquetaDe: Record<CheckStatus, string> = {
  ok: 'Correcto',
  missing: 'Falta',
  mismatch: 'No coincide',
  unknown: 'Sin dato',
};

/** Orden de lectura del informe: primero lo que reclama una acción. */
const prioridad: Record<Veredicto, number> = { fuera: 0, vigilar: 1, 'sin-dato': 2, normal: 3 };

function porVeredicto(checks: DnsCheck[]): DnsCheck[] {
  return [...checks].sort(
    (a, b) => prioridad[veredictoDe[a.status]] - prioridad[veredictoDe[b.status]],
  );
}

/**
 * MTA-STS y TLS-RPT endurecen la entrega pero exigen publicar una política:
 * se miden aparte para que no cuenten como autoconfiguración pendiente.
 */
function esEndurecimiento(check: DnsCheck): boolean {
  return (
    check.id.startsWith('mtasts:') ||
    check.id.startsWith('tlsrpt:') ||
    check.name.startsWith('mta-sts.') ||
    check.name.startsWith('_mta-sts.') ||
    check.name.startsWith('_smtp._tls.')
  );
}

/** Los valores largos (claves DKIM) se parten; en móvil nunca se desplaza en horizontal. */
const partible = 'block break-all';

/** Invalidaciones tras borrar un dominio: arrastra sus buzones, alias y claves. */
const CONSULTAS_DEL_DOMINIO = [['mailboxes'], ['aliases'], ['apikeys']];

/** De dónde sale la medición: el botón del membrete o el de la propiedad. */
type OrigenMedicion = 'dns' | 'propiedad';

/**
 * ¿Recibe ya el dominio en otro proveedor y anuncia el motor un MX interno?
 * La comparten la ficha (aviso del servidor) y la descarga del fichero de
 * zona: con la misma clave, React Query hace una sola petición.
 */
function useConflicto(domainId: string) {
  return useQuery({
    queryKey: ['domain-conflicto', domainId],
    queryFn: () => api.get<ConflictoDominio>(`/api/domains/${domainId}/conflicto`),
    enabled: Boolean(domainId),
  });
}

export default function DominioDetalle() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [justVerified, setJustVerified] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  // Resultado del alta con DNS automático (llega desde Dominios al navegar).
  const [alta] = useState<EstadoAltaDominio | null>(
    () => (location.state as { alta?: EstadoAltaDominio } | null)?.alta ?? null,
  );
  // Se consume una sola vez: al recargar la página no debe repetirse el
  // resultado del alta ni volver a empezar la comprobación.
  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate]);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User | null }>('/api/auth/me'),
  });

  const domain = useQuery({
    queryKey: ['domain', id],
    queryFn: () => api.get<{ domain: DominioCorreo }>(`/api/domains/${id}`),
  });

  const conflicto = useConflicto(id);

  // En una instancia de demostración no hay DNS que medir: la propiedad se
  // puede simular para recorrer buzones, alias y el portal.
  const instancia = useQuery({
    queryKey: ['setup'],
    queryFn: () => api.get<SetupStatus>('/api/setup/status'),
  });
  const simular = useMutation({
    mutationFn: () => api.post<{ domain: DominioCorreo }>(`/api/demo/domains/${id}/ownership`),
    onSuccess: async (data) => {
      queryClient.setQueryData(['domain', id], data);
      await queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast('ok', 'Propiedad simulada: ya puedes crear buzones y alias en este dominio de demostración.');
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se ha podido simular la propiedad.'),
  });

  const verify = useMutation({
    mutationFn: (_origen: OrigenMedicion) =>
      api.post<{ domain: DominioCorreo; ownershipCheck?: boolean | null }>(`/api/domains/${id}/verify`),
    onSuccess: async (data, origen) => {
      const antes = queryClient.getQueryData<{ domain: DominioCorreo }>(['domain', id])?.domain;
      queryClient.setQueryData(['domain', id], data);
      await queryClient.invalidateQueries({ queryKey: ['domains'] });
      // Medir de nuevo también relee lo que propone el motor (su MX, por si
      // se acaba de corregir el nombre del servidor).
      void queryClient.invalidateQueries({ queryKey: ['domain-conflicto', id] });
      setJustVerified(true);
      const d = data.domain;
      const report = d.dnsStatus;
      const propiedadNueva = antes ? propiedadPendiente(antes) && !propiedadPendiente(d) : false;
      // El aviso dice qué ha pasado: un DNS que no se pudo leer no es una
      // medición completada, y la propiedad recién comprobada se anuncia.
      // «No se pudo consultar el DNS» va antes que «no se encuentra el TXT»:
      // si no, quien ya lo creó bien lo revisaría o lo volvería a crear.
      if (report.allRequiredOk) {
        toast('ok', 'Dominio verificado. Ya puede enviar y recibir correo.');
      } else if (propiedadNueva) {
        toast(
          'ok',
          'Propiedad del dominio comprobada: ya puedes crear buzones y alias. Para enviar y recibir correo, completa los registros obligatorios.',
        );
      } else if (origen === 'propiedad' && propiedadPendiente(d) && data.ownershipCheck === null) {
        toast(
          'error',
          'No se ha podido consultar el DNS para comprobar la propiedad del dominio. Vuelve a verificar en unos minutos.',
        );
      } else if (origen === 'propiedad' && propiedadPendiente(d) && data.ownershipCheck === false) {
        toast(
          'error',
          'Todavía no se encuentra el registro TXT de verificación ni un MX que apunte a este servidor. Si acabas de crearlo, espera unos minutos y vuelve a verificar.',
        );
      } else if (medicionIlegible(d)) {
        toast('error', 'No se ha podido consultar el DNS del dominio. Vuelve a comprobarlo en unos minutos.');
      } else {
        toast(
          'ok',
          `Comprobación completada: ${report.requiredOk ?? 0} de ${report.requiredTotal ?? 0} registros obligatorios correctos.`,
        );
      }
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se ha podido comprobar el DNS.'),
  });

  /**
   * El motor no generó la clave DKIM (la ficha la marca como pendiente): se
   * pide de nuevo y se vuelve a comprobarlo, para ver ya el registro que publicar.
   */
  const generarDkim = useMutation({
    mutationFn: async () => {
      await api.post(`/api/domains/${id}/dkim`);
      return api.post<{ domain: DominioCorreo }>(`/api/domains/${id}/verify`);
    },
    onSuccess: async (data) => {
      queryClient.setQueryData(['domain', id], data);
      await queryClient.invalidateQueries({ queryKey: ['domains'] });
      const sigue = (data.domain.dnsStatus.checks ?? []).some((c) => c.engineMissing && c.id === 'motor:dkim');
      toast(
        sigue ? 'error' : 'ok',
        sigue
          ? 'El servidor de correo sigue sin devolver la clave DKIM. Revisa su registro de errores.'
          : 'Clave DKIM generada. Publica su registro en el DNS y vuelve a comprobarlo.',
      );
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se ha podido generar la clave DKIM.'),
  });

  const clientId = domain.data?.domain.clientId;
  const invalidarTodo = () =>
    Promise.all([
      invalidarTrasAltaOBaja(queryClient, clientId),
      ...CONSULTAS_DEL_DOMINIO.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    ]);

  // La confirmación admite el nombre legible (con «ñ» o acentos) o el
  // técnico; al servidor siempre se envía el técnico, que es el que compara.
  const nombreTecnico = domain.data?.domain.domain ?? '';
  const escrito = confirmText.trim().toLowerCase();
  const confirmado =
    Boolean(nombreTecnico) &&
    (escrito === nombreTecnico || (domain.data ? escrito === nombreVisible(domain.data.domain).toLowerCase() : false));

  const remove = useMutation({
    mutationFn: () =>
      api.delete<{ ok: boolean; apiKeysRevoked?: number }>(
        `/api/domains/${id}?confirm=${encodeURIComponent(nombreTecnico)}`,
      ),
    onSuccess: async (data) => {
      queryClient.removeQueries({ queryKey: ['domain', id] });
      queryClient.removeQueries({ queryKey: ['domain-cloudflare', id] });
      await invalidarTodo();
      const claves = data?.apiKeysRevoked ?? 0;
      toast(
        'ok',
        claves > 0
          ? `Dominio eliminado. ${claves === 1 ? 'Se ha revocado 1 clave de API' : `Se han revocado ${claves} claves de API`} que enviaba${claves === 1 ? '' : 'n'} desde sus buzones.`
          : 'Dominio eliminado.',
      );
      navigate('/dominios');
    },
    onError: async (err) => {
      // Un borrado parcial ya ha retirado parte de los buzones: las listas
      // deben reflejarlo aunque la operación no haya terminado.
      await invalidarTodo();
      toast('error', err instanceof ApiError ? err.message : 'No se ha podido eliminar.');
    },
  });

  function abrirEliminar() {
    // Cada apertura empieza de cero: un nombre escrito antes dejaría el botón
    // «Eliminar definitivamente» ya habilitado.
    setConfirmText('');
    remove.reset();
    setConfirmOpen(true);
  }

  if (domain.isPending) {
    return (
      <Hoja>
        <Cargando label="Cargando la ficha del dominio…" />
      </Hoja>
    );
  }
  if (domain.isError || !domain.data) {
    const noExiste = domain.error instanceof ApiError && domain.error.status === 404;
    return (
      <Hoja>
        {noExiste ? (
          <p role="alert" className="text-base text-tinta-2">
            <span className="text-fuera">No se ha encontrado el dominio.</span>{' '}
            <Link className="text-petroleo underline" to="/dominios">
              Volver a dominios
            </Link>
          </p>
        ) : (
          <AvisoError onRetry={() => void domain.refetch()} retrying={domain.isFetching}>
            No se ha podido cargar la ficha del dominio.
          </AvisoError>
        )}
      </Hoja>
    );
  }

  const record = domain.data.domain;
  const isAdmin = me.data?.user?.role === 'admin';
  const checks = record.dnsStatus.checks ?? [];
  const required = checks.filter((c) => c.required);
  const optional = checks.filter((c) => !c.required && !esEndurecimiento(c));
  const endurecimiento = checks.filter((c) => !c.required && esEndurecimiento(c));
  const requiredOk = record.dnsStatus.requiredOk ?? required.filter((c) => c.status === 'ok').length;
  const requiredTotal = record.dnsStatus.requiredTotal ?? required.length;
  const optionalOk = optional.filter((c) => c.status === 'ok').length;
  const endurecimientoOk = endurecimiento.filter((c) => c.status === 'ok').length;
  const medido = Boolean(record.lastCheckedAt);
  const ilegible = medido && medicionIlegible(record);
  const lectura = lecturaDominio(record);
  const visible = nombreVisible(record);
  const conPropiedad = record.ownershipVerifiedAt !== undefined;
  const pendientePropiedad = propiedadPendiente(record);
  // MX interno que anuncia el motor: ni el fichero de zona ni Cloudflare.
  const avisoServidor = conflicto.data?.avisoServidor ?? null;
  const accionDe = (check: DnsCheck): ReactNode =>
    check.engineMissing && check.id === 'motor:dkim' ? (
      <Button variant="perfil" busy={generarDkim.isPending} onClick={() => generarDkim.mutate()}>
        Generar la clave DKIM
      </Button>
    ) : undefined;

  const veredictoObligatorios: Veredicto = !medido
    ? 'sin-dato'
    : requiredOk >= requiredTotal
      ? 'normal'
      : ilegible
        ? 'sin-dato'
        : 'fuera';

  return (
    <>
      <Membrete
        title={
          <span className="break-all">
            {visible}
          </span>
        }
        meta={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <MarcaFondo veredicto={lectura.veredicto}>{lectura.etiqueta}</MarcaFondo>
            {conPropiedad && (
              <span className="text-tinta-2">
                Propiedad: {pendientePropiedad ? 'pendiente' : 'comprobada'}
              </span>
            )}
            <span className="text-tinta-3">Última comprobación: {formatDate(record.lastCheckedAt)}</span>
            {visible !== record.domain && (
              <span className="valor break-all text-tinta-3">{record.domain}</span>
            )}
          </span>
        }
        actions={
          <Button variant="principal" busy={verify.isPending} onClick={() => verify.mutate('dns')}>
            Comprobar el DNS ahora
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        {checks.length === 0 ? (
          <Hoja title="DNS sin comprobar">
            <p className="max-w-[75ch] text-base text-tinta-2">
              Aún no hay lectura del DNS. Pulsa «Comprobar el DNS ahora» para obtener los registros
              que debes crear.
            </p>
          </Hoja>
        ) : (
          <Hoja title="Resumen de la comprobación" meta={formatDate(record.lastCheckedAt)}>
            <CabeceraMedidas />
            <Medida
              concepto="Registros obligatorios correctos"
              valor={ilegible ? '—' : `${requiredOk}/${requiredTotal}`}
              referencia={`${requiredTotal}/${requiredTotal}`}
              veredicto={veredictoObligatorios}
              nota={
                veredictoObligatorios === 'normal'
                  ? undefined
                  : ilegible
                    ? 'No se ha podido consultar el DNS. Vuelve a comprobarlo en unos minutos.'
                    : 'Mientras falte alguno, el dominio no puede enviar ni recibir correo.'
              }
            />
            {optional.length > 0 && (
              <Medida
                concepto="Registros de autoconfiguración correctos"
                valor={`${optionalOk}/${optional.length}`}
                referencia={`${optional.length}/${optional.length}`}
                veredicto={
                  !medido ? 'sin-dato' : optionalOk >= optional.length ? 'normal' : 'vigilar'
                }
              />
            )}
            {conPropiedad && (
              <Medida
                concepto="Propiedad del dominio"
                valor={pendientePropiedad ? 'Pendiente' : 'Comprobada'}
                veredicto={pendientePropiedad ? 'vigilar' : 'normal'}
                nota={
                  pendientePropiedad
                    ? 'Hasta comprobarla no se pueden crear buzones ni alias en este dominio.'
                    : undefined
                }
              />
            )}
          </Hoja>
        )}

        {avisoServidor && (
          <div role="alert" className="rounded-lg border border-[rgb(var(--fuera)/0.35)] bg-fuera-fondo px-4 py-3">
            <p className="rotulo text-fuera">Revisa el nombre del servidor de correo</p>
            <p className="mt-1 max-w-[75ch] text-base text-tinta">{avisoServidor}</p>
          </div>
        )}

        {record.recepcionExterna && (
          <BloqueRecepcionExterna dominio={visible} mx={conflicto.data?.mxActuales ?? []} />
        )}

        {conflicto.data?.avisoMtaSts && (
          <div role="alert" className="rounded-lg border border-[rgb(var(--vigilar)/0.4)] bg-vigilar-fondo px-4 py-3">
            <p className="rotulo text-vigilar">Política MTA-STS del proveedor actual</p>
            <p className="mt-1 max-w-[75ch] text-base text-tinta">{conflicto.data.avisoMtaSts}</p>
          </div>
        )}

        {pendientePropiedad && record.ownershipRecord && (
          <BloquePropiedad
            registro={record.ownershipRecord}
            midiendo={verify.isPending}
            onVerificar={() => verify.mutate('propiedad')}
            demo={
              instancia.data?.demoMode
                ? { simulando: simular.isPending, onSimular: () => simular.mutate() }
                : undefined
            }
          />
        )}

        {checks.length > 0 && (
          <Hoja
            title="Registros obligatorios"
            meta={ilegible ? 'Sin dato' : `${requiredOk} de ${requiredTotal} correctos`}
            flush
          >
            <p className="regla-fila px-4 py-3 text-sm text-tinta-2">
              Para crearlos manualmente, copia cada valor en el panel DNS de tu
              proveedor. Los cambios pueden tardar de minutos a horas en propagarse; vuelve a comprobarlo
              cuando estén creados.
            </p>
            <ul>
              {porVeredicto(required).map((check) => (
                <RegistroMedido key={check.id} check={check} recien={justVerified} accion={accionDe(check)} />
              ))}
            </ul>
          </Hoja>
        )}

        <BloqueCloudflare
          key={record.id}
          dominio={record}
          isAdmin={isAdmin}
          alta={alta}
          bloqueo={avisoServidor}
        />

        {checks.length > 0 && (
          <>
            <DescargaZona domainId={id} domain={record.domain} />

            {optional.length > 0 && (
              <Hoja
                title="Recomendados (autoconfiguración)"
                meta={`${optionalOk} de ${optional.length} correctos`}
                flush
              >
                <ul>
                  {porVeredicto(optional).map((check) => (
                    <RegistroMedido key={check.id} check={check} recien={justVerified} />
                  ))}
                </ul>
              </Hoja>
            )}

            {endurecimiento.length > 0 && (
              <Hoja
                title="Opcionales (endurecimiento)"
                meta={`${endurecimientoOk} de ${endurecimiento.length} correctos`}
                flush
              >
                <p className="regla-fila px-4 py-3 text-sm text-tinta-2">
                  MTA-STS exige que el correo entrante llegue cifrado y requiere publicar un
                  fichero de política en la web del dominio. Se recomienda activarlo cuando el
                  resto de registros sea correcto.
                </p>
                <ul>
                  {porVeredicto(endurecimiento).map((check) => (
                    <RegistroMedido key={check.id} check={check} recien={justVerified} />
                  ))}
                </ul>
              </Hoja>
            )}
          </>
        )}

        {/* La acción destructiva, lejos de la principal y sobre papel: en el
            membrete, el carmín sobre petróleo apenas se leía. */}
        <Hoja title="Eliminar el dominio" flush>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
            <p className="min-w-0 max-w-[75ch] flex-1 basis-60 text-sm text-tinta-3">
              Se eliminan el dominio, sus buzones con su correo, sus alias y los dominios de marca
              blanca que cuelgan de él. Los registros DNS no se modifican.
            </p>
            <Button variant="peligro" onClick={abrirEliminar}>
              Eliminar el dominio
            </Button>
          </div>
        </Hoja>
      </div>

      <Dialogo open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Eliminar dominio">
        <div className="flex flex-col gap-4">
          <p className="text-base text-tinta-2">
            Se eliminarán el dominio, <strong className="text-tinta">todos sus buzones con su
            correo</strong> y sus alias, tanto de Mailway como del servidor de correo. Las claves de
            API que envían desde estos buzones dejarán de funcionar, los alias de otros dominios
            que reenvían a ellos dejarán de hacerlo y los dominios de marca blanca que cuelgan de él
            (por ejemplo, webmail.{visible}) dejarán de publicarse. Esta acción no se puede deshacer.
            Los registros DNS no se modifican.
          </p>
          <Input
            label={`Escribe ${visible} para confirmar`}
            mono
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={visible}
          />
          {remove.isError && (
            <AvisoError>
              {remove.error instanceof ApiError ? remove.error.message : 'No se ha podido eliminar.'}
            </AvisoError>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="plano" onClick={() => setConfirmOpen(false)}>
              Cancelar
            </Button>
            <Button
              variant="peligro"
              disabled={!confirmado}
              busy={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Eliminar definitivamente
            </Button>
          </div>
        </div>
      </Dialogo>
    </>
  );
}

/**
 * Propiedad pendiente: el TXT que la prueba sin tocar el MX. Sirve para
 * preparar los buzones antes de trasladar el correo desde otro proveedor.
 */
function BloquePropiedad({
  registro,
  midiendo,
  onVerificar,
  demo,
}: {
  registro: RegistroPropiedad;
  midiendo: boolean;
  onVerificar: () => void;
  /** Solo en una instancia de demostración (MAILWAY_DEMO=1). */
  demo?: { simulando: boolean; onSimular: () => void };
}) {
  return (
    <Hoja
      title="Comprobar la propiedad sin cambiar el MX"
      meta="Propiedad pendiente"
      actions={
        <div className="flex flex-wrap gap-2">
          {demo && (
            <Button variant="perfil" busy={demo.simulando} onClick={demo.onSimular}>
              Simular verificación
            </Button>
          )}
          <Button variant="perfil" busy={midiendo} onClick={onVerificar}>
            Verificar
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {demo && (
          <p className="max-w-[75ch] rounded-lg border border-regla bg-hoja-2 px-3 py-2 text-sm text-tinta-2">
            Instancia de demostración: «Simular verificación» da por comprobada la propiedad sin
            consultar el DNS, para poder crear buzones y alias. Al arrancar el panel sin el modo
            demostración, la propiedad simulada vuelve a quedar pendiente.
          </p>
        )}
        <p className="max-w-[75ch] text-base text-tinta-2">
          Antes de crear buzones o alias es necesario comprobar que el dominio es tuyo. Queda
          comprobado en cuanto el registro MX apunta a este servidor. Si el correo del dominio
          todavía llega a otro proveedor (por ejemplo, para preparar los buzones antes del
          traslado), crea este registro TXT y pulsa «Verificar». El TXT no cambia dónde se recibe
          el correo: mientras el MX apunte al proveedor actual, todo el correo del dominio, también
          el que se envíe desde este servidor, sigue llegando allí.
        </p>
        <Muestra rotulo="Registro TXT de verificación" copiar={registro.content}>
          <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="rotulo sm:pt-px">Tipo</dt>
            <dd className="codigo min-w-0 text-sm text-tinta">{registro.type}</dd>
            <dt className="rotulo mt-1 sm:mt-0 sm:pt-px">Nombre</dt>
            <dd className={`codigo min-w-0 text-sm text-tinta ${partible}`}>{registro.name}</dd>
            <dt className="rotulo mt-1 sm:mt-0 sm:pt-px">Valor</dt>
            <dd className={`codigo min-w-0 text-sm text-tinta ${partible}`}>{registro.content}</dd>
          </dl>
        </Muestra>
        <p className="max-w-[75ch] text-sm text-tinta-3">
          Si el DNS del dominio está en Cloudflare, «Revisar cambios» en la configuración automática
          lo crea junto con el resto de registros. Mailway comprueba la propiedad en cada medición.
        </p>
      </div>
    </Hoja>
  );
}

/**
 * El MX apunta a otro proveedor: el servidor entrega allí lo que se envía a
 * este dominio, igual que el resto de Internet. Explica por qué los buzones
 * de aquí no reciben nada todavía y qué pasa al hacer el cambio.
 */
function BloqueRecepcionExterna({ dominio, mx }: { dominio: string; mx: string[] }) {
  return (
    <Hoja title="El correo se recibe en otro proveedor" meta="Recepción externa">
      <div className="flex flex-col gap-3">
        <p className="max-w-[75ch] text-base text-tinta-2">
          El registro MX de <span className="valor break-all">{dominio}</span> apunta a{' '}
          {mx.length > 0 ? <span className="valor break-all">{mx.join(', ')}</span> : 'otro servidor'}, así
          que su correo se recibe allí. Mientras sea así, lo que se envíe desde este servidor a
          direcciones de este dominio (buzones de otros clientes, la web, la API de envío o los
          formularios) también se entrega en ese proveedor, igual que el correo que llega de
          Internet, y los buzones y alias creados aquí no lo reciben. Las respuestas a los mensajes
          que se envíen desde aquí también llegan al proveedor actual.
        </p>
        <p className="max-w-[75ch] text-sm text-tinta-2">
          Hay una excepción: el correo que llega de Internet a un alias de otro dominio de este
          servidor que reenvía a un buzón de este dominio se entrega en el buzón de aquí, no en el
          proveedor actual. Hasta hacer el cambio, revisa esos reenvíos.
        </p>
        <p className="max-w-[75ch] text-sm text-tinta-3">
          Cuando el MX apunte a este servidor, Mailway lo detecta en la siguiente comprobación y el
          correo empieza a entregarse en los buzones de aquí. Para adelantarlo, pulsa «Comprobar el
          DNS ahora».
        </p>
      </div>
    </Hoja>
  );
}

/**
 * Una medición: el valor de referencia que hay que crear (lo que el usuario
 * se lleva a su proveedor) y, debajo, lo que el DNS devuelve ahora.
 */
function RegistroMedido({
  check,
  recien,
  accion,
}: {
  check: DnsCheck;
  recien: boolean;
  /** Acción que resuelve el registro desde la propia fila (p. ej. generar la clave DKIM). */
  accion?: ReactNode;
}) {
  const veredicto = veredictoDe[check.status];
  const fuera = veredicto === 'fuera';

  return (
    <li className={`regla-fila px-4 py-3.5 last:border-b-0 ${fuera ? 'fila-fuera' : ''}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <h3 className="min-w-0 basis-full text-base font-medium text-tinta sm:basis-0 sm:grow">
          {check.label}
        </h3>
        <span className="rotulo shrink-0">{check.type}</span>
        <span className={`ml-auto shrink-0 sm:ml-0 ${recien ? 'revelar' : ''}`}>
          <MarcaFondo veredicto={veredicto}>{etiquetaDe[check.status]}</MarcaFondo>
        </span>
      </div>

      {check.engineMissing ? (
        // Sin valor que copiar: el motor todavía no ha generado el registro.
        <p className="mt-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="rotulo shrink-0">Valor que hay que crear</span>
          <span className="text-sm text-tinta-3">pendiente de generar en el servidor de correo</span>
        </p>
      ) : (
        // Con un registro que ya existe y solo hay que completar (el SPF), se
        // copia el valor completo con el que sustituirlo, no el del servidor.
        <Muestra
          rotulo={check.suggested ? 'Sustituye el registro actual por' : 'Valor que hay que crear'}
          copiar={check.suggested ?? check.expected}
          className="mt-2.5"
        >
          <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="rotulo sm:pt-px">Nombre</dt>
            <dd className={`valor min-w-0 text-sm text-tinta ${partible}`}>{check.name}</dd>
            <dt className="rotulo mt-1 sm:mt-0 sm:pt-px">Valor</dt>
            <dd className={`valor min-w-0 text-sm text-tinta ${partible}`}>{check.suggested ?? check.expected}</dd>
          </dl>
        </Muestra>
      )}

      {check.status !== 'ok' && !check.engineMissing && (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="rotulo shrink-0">El DNS devuelve ahora</span>
          <span
            className={`valor min-w-0 basis-full text-sm sm:basis-0 sm:grow ${partible} ${
              check.found ? (fuera ? 'text-fuera' : 'text-tinta-2') : 'text-tinta-3'
            }`}
          >
            {/* null es «no se pudo consultar» aunque el veredicto sea definitivo
                (un MX interno está fuera de rango mida lo que mida el DNS). */}
            {check.found || (check.found === null ? 'no se ha podido consultar' : 'ningún registro')}
          </span>
        </p>
      )}

      <p className="mt-2 max-w-[75ch] text-sm text-tinta-2">{check.help}</p>
      {accion && <div className="mt-2.5">{accion}</div>}
    </li>
  );
}

/* ------------------------- Descarga del fichero DNS ----------------------- */

const NIVELES = [
  {
    id: 'obligatorios' as const,
    titulo: 'Solo lo obligatorio',
    descripcion: 'MX, SPF, DKIM y DMARC: lo mínimo para enviar y recibir.',
  },
  {
    id: 'recomendados' as const,
    titulo: 'Recomendado',
    descripcion:
      'Lo anterior más la autoconfiguración (el móvil y Thunderbird configuran la cuenta automáticamente) y el registro de verificación de la propiedad.',
  },
  {
    id: 'completo' as const,
    titulo: 'Todo',
    descripcion: 'Añade MTA-STS y TLS-RPT. Requieren publicar un fichero en la web del dominio.',
  },
];

/**
 * Descarga con fetch y no con un enlace: si la sesión caducó o el motor no
 * responde, un enlace descargaría el JSON del error como si fuera la zona.
 */
async function descargarZona(url: string, nombre: string): Promise<void> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    let mensaje = `Error ${res.status} del servidor.`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) mensaje = data.error;
    } catch {
      // cuerpo no JSON: se queda el mensaje genérico
    }
    throw new Error(mensaje);
  }
  const blob = await res.blob();
  const enlace = document.createElement('a');
  const objeto = URL.createObjectURL(blob);
  enlace.href = objeto;
  enlace.download = nombre;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  // Se libera después: algunos navegadores leen la URL tras el clic.
  window.setTimeout(() => URL.revokeObjectURL(objeto), 10_000);
}

/**
 * Descarga del fichero de zona. Antes de ofrecerlo se comprueba si el dominio
 * ya recibe correo en otro proveedor: importar encima no da error, rompe el
 * correo en silencio, así que el aviso tiene que llegar ANTES de la descarga.
 */
function DescargaZona({ domainId, domain }: { domainId: string; domain: string }) {
  const [nivel, setNivel] = useState<(typeof NIVELES)[number]['id']>('recomendados');
  const toast = useToast();
  const nombre = `${domain}-mailway-${nivel}.txt`;

  const conflicto = useConflicto(domainId);

  const descarga = useMutation({
    mutationFn: () => descargarZona(`/api/domains/${domainId}/zonefile?nivel=${nivel}`, nombre),
    onError: (err) => toast('error', (err as Error).message || 'No se ha podido descargar el fichero.'),
  });

  const hayConflicto = conflicto.data?.hayOtroProveedor ?? false;
  // Con un MX interno, el servidor rechaza la descarga (409): el botón no se ofrece.
  const mxInterno = Boolean(conflicto.data?.avisoServidor);

  return (
    <Hoja
      title="Importar en el proveedor de DNS"
      meta="Fichero de zona"
      actions={
        <Button
          variant="perfil"
          busy={descarga.isPending}
          disabled={mxInterno}
          onClick={() => descarga.mutate()}
        >
          Descargar
        </Button>
      }
    >
      {conflicto.isError && (
        <AvisoError
          className="mb-4"
          onRetry={() => void conflicto.refetch()}
          retrying={conflicto.isFetching}
        >
          No se ha podido comprobar si el dominio ya recibe correo en otro proveedor. Compruébalo
          antes de importar el fichero.
        </AvisoError>
      )}
      {mxInterno && (
        <p className="mb-4 max-w-[75ch] text-base text-fuera">
          No se puede descargar mientras el servidor de correo anuncie un MX interno: el fichero
          publicaría un destino que no existe en Internet. Antes hay que corregir el nombre del
          servidor.
        </p>
      )}
      {hayConflicto && conflicto.data?.aviso && (
        <div className="mb-4 rounded-lg border border-[rgb(var(--fuera)/0.35)] bg-fuera-fondo px-3 py-2.5">
          <p className="rotulo text-fuera">No lo importes todavía</p>
          <p className="mt-1 max-w-[75ch] text-base text-tinta">{conflicto.data.aviso}</p>
        </div>
      )}

      <p className="max-w-[75ch] text-base text-tinta-2">
        Para otros proveedores, o para importarlo manualmente en Cloudflare:{' '}
        <span className="valor">DNS → Records → Import and Export → Import</span>. Al terminar,
        comprueba que los registros quedan en <strong>gris (DNS only)</strong>: con la nube naranja
        el correo no funciona.
      </p>

      <fieldset className="mt-4">
        <legend className="rotulo mb-1.5">Qué incluir</legend>
        <div className="flex flex-col">
          {NIVELES.map((n) => (
            <label
              key={n.id}
              className={`regla-fila flex cursor-pointer items-baseline gap-3 py-2.5 last:border-b-0 ${
                nivel === n.id ? '' : 'text-tinta-2'
              }`}
            >
              <input
                type="radio"
                name={`nivel-${domainId}`}
                value={n.id}
                checked={nivel === n.id}
                onChange={() => setNivel(n.id)}
                className="mt-1 shrink-0"
              />
              <span className="min-w-0">
                <span className={`text-base ${nivel === n.id ? 'font-medium text-tinta' : ''}`}>
                  {n.titulo}
                </span>
                <span className="block max-w-[70ch] text-sm text-tinta-2">{n.descripcion}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <p className="mt-3 text-sm text-tinta-3">
        El fichero se llamará <span className="valor break-all">{nombre}</span> e incluye las
        instrucciones y los avisos.
      </p>
    </Hoja>
  );
}
