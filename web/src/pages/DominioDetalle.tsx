import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type CheckStatus, type DnsCheck, type User } from '../lib/api';
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
  Midiendo,
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
  ok: 'En rango',
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

  const verify = useMutation({
    mutationFn: (_origen: OrigenMedicion) => api.post<{ domain: DominioCorreo }>(`/api/domains/${id}/verify`),
    onSuccess: async (data, origen) => {
      const antes = queryClient.getQueryData<{ domain: DominioCorreo }>(['domain', id])?.domain;
      queryClient.setQueryData(['domain', id], data);
      await queryClient.invalidateQueries({ queryKey: ['domains'] });
      setJustVerified(true);
      const d = data.domain;
      const report = d.dnsStatus;
      const propiedadNueva = antes ? propiedadPendiente(antes) && !propiedadPendiente(d) : false;
      // El aviso dice qué ha pasado: un DNS que no se pudo leer no es una
      // medición completada, y la propiedad recién comprobada se anuncia.
      if (report.allRequiredOk) {
        toast('ok', 'Dominio verificado. Ya puede enviar y recibir correo.');
      } else if (propiedadNueva) {
        toast(
          'ok',
          'Propiedad del dominio comprobada: ya puede crear buzones y alias. Para enviar y recibir correo, complete los registros obligatorios.',
        );
      } else if (origen === 'propiedad' && propiedadPendiente(d)) {
        toast(
          'error',
          'Todavía no se encuentra el registro TXT de verificación ni un MX que apunte a este servidor. Si acaba de crearlo, espere unos minutos y vuelva a verificar.',
        );
      } else if (medicionIlegible(d)) {
        toast('error', 'No se ha podido consultar el DNS del dominio. Vuelva a medir en unos minutos.');
      } else {
        toast(
          'ok',
          `Medición completada: ${report.requiredOk ?? 0} de ${report.requiredTotal ?? 0} registros obligatorios en rango.`,
        );
      }
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se ha podido medir el DNS.'),
  });

  const clientId = domain.data?.domain.clientId;
  const invalidarTodo = () =>
    Promise.all([
      invalidarTrasAltaOBaja(queryClient, clientId),
      ...CONSULTAS_DEL_DOMINIO.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    ]);

  const remove = useMutation({
    mutationFn: () =>
      api.delete<{ ok: boolean; apiKeysRevoked?: number }>(
        `/api/domains/${id}?confirm=${encodeURIComponent(confirmText.trim().toLowerCase())}`,
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
        <Midiendo label="Cargando la ficha del dominio…" />
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
            <Link className="text-laboratorio underline" to="/dominios">
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
          <span className="valor break-all text-xl font-semibold normal-case tracking-normal">
            {visible}
          </span>
        }
        meta={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <MarcaFondo veredicto={lectura.veredicto}>{lectura.etiqueta}</MarcaFondo>
            {conPropiedad && (
              <span className="text-white/85">
                Propiedad: {pendientePropiedad ? 'pendiente' : 'comprobada'}
              </span>
            )}
            <span className="text-white/70">Última medición: {formatDate(record.lastCheckedAt)}</span>
            {visible !== record.domain && (
              <span className="valor break-all text-white/75">{record.domain}</span>
            )}
          </span>
        }
        actions={
          <Button variant="campo" busy={verify.isPending} onClick={() => verify.mutate('dns')}>
            Medir el DNS ahora
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        {checks.length === 0 ? (
          <Hoja title="Sin lectura del DNS">
            <p className="max-w-[75ch] text-base text-tinta-2">
              Todavía no hay lectura del DNS. Pulse «Medir el DNS ahora» para obtener los registros
              que es necesario crear.
            </p>
          </Hoja>
        ) : (
          <Hoja title="Resumen de la medición" meta={formatDate(record.lastCheckedAt)}>
            <CabeceraMedidas />
            <Medida
              concepto="Registros obligatorios en rango"
              valor={ilegible ? '—' : `${requiredOk}/${requiredTotal}`}
              referencia={`${requiredTotal}/${requiredTotal}`}
              veredicto={veredictoObligatorios}
              nota={
                veredictoObligatorios === 'normal'
                  ? undefined
                  : ilegible
                    ? 'No se ha podido consultar el DNS. Vuelva a medir en unos minutos.'
                    : 'Mientras falte alguno, el dominio no puede enviar ni recibir correo.'
              }
            />
            {optional.length > 0 && (
              <Medida
                concepto="Registros de autoconfiguración en rango"
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

        {pendientePropiedad && record.ownershipRecord && (
          <BloquePropiedad
            registro={record.ownershipRecord}
            midiendo={verify.isPending}
            onVerificar={() => verify.mutate('propiedad')}
          />
        )}

        {checks.length > 0 && (
          <Hoja
            title="Registros obligatorios"
            meta={ilegible ? 'Sin dato' : `${requiredOk} de ${requiredTotal} en rango`}
            flush
          >
            <p className="regla-fila px-4 py-3 text-sm text-tinta-2">
              Para crearlos manualmente, copie cada valor de referencia en el panel DNS de su
              proveedor. Los cambios pueden tardar de minutos a horas en propagarse; vuelva a medir
              cuando estén creados.
            </p>
            <ul>
              {porVeredicto(required).map((check) => (
                <RegistroMedido key={check.id} check={check} recien={justVerified} />
              ))}
            </ul>
          </Hoja>
        )}

        <BloqueCloudflare key={record.id} dominio={record} isAdmin={isAdmin} alta={alta} />

        {checks.length > 0 && (
          <>
            <DescargaZona domainId={id} domain={record.domain} />

            {optional.length > 0 && (
              <Hoja
                title="Recomendados (autoconfiguración)"
                meta={`${optionalOk} de ${optional.length} en rango`}
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
                meta={`${endurecimientoOk} de ${endurecimiento.length} en rango`}
                flush
              >
                <p className="regla-fila px-4 py-3 text-sm text-tinta-2">
                  MTA-STS exige que el correo entrante llegue cifrado y requiere publicar un
                  fichero de política en la web del dominio. Se recomienda activarlo cuando el
                  resto de registros esté en rango.
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
              Se eliminan el dominio, sus buzones con su correo y sus alias. Los registros DNS no se
              modifican.
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
            API que envían desde estos buzones dejarán de funcionar, y los alias de otros dominios
            que reenvían a ellos dejarán de hacerlo. Esta acción no se puede deshacer. Los registros
            DNS no se modifican.
          </p>
          <Input
            label={`Escriba ${record.domain} para confirmar`}
            mono
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={record.domain}
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
              disabled={confirmText.trim().toLowerCase() !== record.domain}
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
}: {
  registro: RegistroPropiedad;
  midiendo: boolean;
  onVerificar: () => void;
}) {
  return (
    <Hoja
      title="Comprobar la propiedad sin cambiar el MX"
      meta="Propiedad pendiente"
      actions={
        <Button variant="perfil" busy={midiendo} onClick={onVerificar}>
          Verificar
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="max-w-[75ch] text-base text-tinta-2">
          Antes de crear buzones o alias es necesario comprobar que el dominio es suyo. Queda
          comprobado en cuanto el registro MX apunta a este servidor. Si el correo del dominio
          todavía llega a otro proveedor (por ejemplo, para preparar los buzones antes del
          traslado), cree este registro TXT, que no afecta al correo actual, y pulse «Verificar».
        </p>
        <Muestra rotulo="Registro TXT de verificación" copiar={registro.content}>
          <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="rotulo sm:pt-px">Tipo</dt>
            <dd className="valor min-w-0 text-sm text-tinta">{registro.type}</dd>
            <dt className="rotulo mt-1 sm:mt-0 sm:pt-px">Nombre</dt>
            <dd className={`valor min-w-0 text-sm text-tinta ${partible}`}>{registro.name}</dd>
            <dt className="rotulo mt-1 sm:mt-0 sm:pt-px">Valor</dt>
            <dd className={`valor min-w-0 text-sm text-tinta ${partible}`}>{registro.content}</dd>
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
 * Una medición: el valor de referencia que hay que crear (lo que el usuario
 * se lleva a su proveedor) y, debajo, lo que el DNS devuelve ahora.
 */
function RegistroMedido({ check, recien }: { check: DnsCheck; recien: boolean }) {
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

      <Muestra rotulo="Valor de referencia" copiar={check.expected} className="mt-2.5">
        <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="rotulo sm:pt-px">Nombre</dt>
          <dd className={`valor min-w-0 text-sm text-tinta ${partible}`}>{check.name}</dd>
          <dt className="rotulo mt-1 sm:mt-0 sm:pt-px">Valor</dt>
          <dd className={`valor min-w-0 text-sm text-tinta ${partible}`}>{check.expected}</dd>
        </dl>
      </Muestra>

      {check.status !== 'ok' && (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="rotulo shrink-0">El DNS devuelve ahora</span>
          <span
            className={`valor min-w-0 basis-full text-sm sm:basis-0 sm:grow ${partible} ${
              check.found ? (fuera ? 'text-fuera' : 'text-tinta-2') : 'text-tinta-3'
            }`}
          >
            {check.found || (check.status === 'unknown' ? 'no se ha podido consultar' : 'ningún registro')}
          </span>
        </p>
      )}

      <p className="mt-2 max-w-[75ch] text-sm text-tinta-2">{check.help}</p>
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

  const conflicto = useQuery({
    queryKey: ['domain-conflicto', domainId],
    queryFn: () =>
      api.get<{ hayOtroProveedor: boolean; mxActuales: string[]; aviso: string | null }>(
        `/api/domains/${domainId}/conflicto`,
      ),
  });

  const descarga = useMutation({
    mutationFn: () => descargarZona(`/api/domains/${domainId}/zonefile?nivel=${nivel}`, nombre),
    onError: (err) => toast('error', (err as Error).message || 'No se ha podido descargar el fichero.'),
  });

  const hayConflicto = conflicto.data?.hayOtroProveedor ?? false;

  return (
    <Hoja
      title="Importar en el proveedor de DNS"
      meta="Fichero de zona"
      actions={
        <Button variant="perfil" busy={descarga.isPending} onClick={() => descarga.mutate()}>
          Descargar
        </Button>
      }
    >
      {hayConflicto && conflicto.data?.aviso && (
        <div className="mb-4 border border-[rgb(var(--fuera)/0.35)] bg-fuera-fondo px-3 py-2.5">
          <p className="rotulo text-fuera">No lo importe todavía</p>
          <p className="mt-1 max-w-[75ch] text-base text-tinta">{conflicto.data.aviso}</p>
        </div>
      )}

      <p className="max-w-[75ch] text-base text-tinta-2">
        Para otros proveedores, o para importarlo manualmente en Cloudflare:{' '}
        <span className="valor">DNS → Records → Import and Export → Import</span>. Al terminar,
        compruebe que los registros quedan en <strong>gris (DNS only)</strong>: con la nube naranja
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
