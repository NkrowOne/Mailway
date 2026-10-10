import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Client, type DnsCheck, type SetupStatus, type User } from '../lib/api';
import {
  invalidarTrasAltaOBaja,
  lecturaDominio,
  medicionIlegible,
  nombreVisible,
  propiedadPendiente,
  type DominioCorreo,
  type EstadoAltaDominio,
} from '../lib/cloudflare';
import type { ConflictoDominio } from '../lib/dominios';
import { BloqueCloudflare } from '../components/cloudflare/BloqueCloudflare';
import {
  BloquePropiedad,
  BloqueRecepcionExterna,
  esEndurecimiento,
  porVeredicto,
  RegistroMedido,
} from '../components/dominio/RegistrosDominio';
import { EnlaceVolver, rutaCliente } from '../components/gestion/comun';
import { ANCLA_CAMBIO, HojaCambioDominio } from '../components/cambio-dominio/HojaCambioDominio';
import { etiquetaMigracion, type CambioDominioVista } from '../lib/cambioDominio';
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

/**
 * Cada dominio monta su ficha desde cero (`key`): al pasar de la ficha de un
 * dominio a la de otro (al terminar un cambio de dominio, por ejemplo) no se
 * arrastran diálogos abiertos ni el estado que llega al navegar.
 */
export default function DominioDetalle() {
  const { id = '' } = useParams();
  return <FichaDominio key={id} id={id} />;
}

function FichaDominio({ id }: { id: string }) {
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
  // Cambio de dominio recién dado de baja desde la ficha del dominio
  // anterior, que ya no existe: aquí se muestra su paso «Terminado».
  const [cambioTerminado] = useState<CambioDominioVista | null>(
    () => (location.state as { cambioTerminado?: CambioDominioVista } | null)?.cambioTerminado ?? null,
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
  const isAdmin = me.data?.user?.role === 'admin';

  const domain = useQuery({
    queryKey: ['domain', id],
    queryFn: () => api.get<{ domain: DominioCorreo }>(`/api/domains/${id}`),
  });
  // La administración vuelve a la ficha del cliente dueño del dominio, con
  // su nombre: así se sabe de quién es y se sigue trabajando en su contexto.
  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: Client[] }>('/api/clients'),
    enabled: isAdmin,
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
  const nombreCliente = clients.data?.clients.find((c) => c.id === clientId)?.name;
  const volverA = isAdmin && clientId ? rutaCliente(clientId, 'dominios') : '/dominios';
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
      navigate(volverA);
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
      <>
        <EnlaceVolver to="/dominios">Dominios</EnlaceVolver>
        <Hoja>
          <Cargando label="Cargando la ficha del dominio…" />
        </Hoja>
      </>
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
  const migracion = record.migracion ?? null;
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
      <EnlaceVolver to={volverA}>
        {isAdmin ? (nombreCliente ? `Dominios de ${nombreCliente}` : 'Dominios del cliente') : 'Dominios'}
      </EnlaceVolver>
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
            {migracion && (
              // El asistente está al final de la ficha: desde aquí se llega sin desplazarse a ciegas.
              <span className="basis-full text-tinta-2 [overflow-wrap:anywhere]">
                {etiquetaMigracion(migracion, isAdmin)} ·{' '}
                <button
                  type="button"
                  className="text-petroleo underline decoration-1 underline-offset-2 hover:text-tinta"
                  onClick={() =>
                    document.getElementById(ANCLA_CAMBIO)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }
                >
                  Ver el cambio de dominio
                </button>
              </span>
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

        <HojaCambioDominio dominio={record} isAdmin={isAdmin} terminado={cambioTerminado} />

        {/* La acción destructiva, lejos de la principal y sobre papel: en el
            membrete, el carmín sobre petróleo apenas se leía. */}
        <Hoja title="Eliminar el dominio" flush>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
            <p className="min-w-0 max-w-[75ch] flex-1 basis-60 text-sm text-tinta-3">
              {migracion
                ? // El servidor lo rechaza (domain_migrating): se dice antes de pulsar.
                  `${visible} está en un cambio de dominio. Gestiónalo desde el asistente.`
                : 'Se eliminan el dominio, sus buzones con su correo, sus alias y los dominios de marca blanca que cuelgan de él. Los registros DNS no se modifican.'}
            </p>
            <Button variant="peligro" onClick={abrirEliminar} disabled={Boolean(migracion)}>
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
