import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type CheckStatus, type DnsCheck, type User } from '../lib/api';
import { nombreVisible, type DominioCorreo, type EstadoAltaDominio } from '../lib/cloudflare';
import { BloqueCloudflare } from '../components/cloudflare/BloqueCloudflare';
import { BandaError } from '../components/cloudflare/comun';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';
import {
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
  unknown: 'Sin medir',
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
const CONSULTAS_DEL_DOMINIO = [
  ['domains'],
  ['mailboxes'],
  ['aliases'],
  ['apikeys'],
  ['client-dashboard'],
  ['admin-dashboard'],
  ['clients'],
];

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
    mutationFn: () => api.post<{ domain: DominioCorreo }>(`/api/domains/${id}/verify`),
    onSuccess: async (data) => {
      queryClient.setQueryData(['domain', id], data);
      await queryClient.invalidateQueries({ queryKey: ['domains'] });
      setJustVerified(true);
      const report = data.domain.dnsStatus;
      if (report.allRequiredOk) {
        toast('ok', 'Dominio verificado. Ya está en reparto.');
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

  const invalidarTodo = () =>
    Promise.all(CONSULTAS_DEL_DOMINIO.map((queryKey) => queryClient.invalidateQueries({ queryKey })));

  const remove = useMutation({
    mutationFn: () =>
      api.delete(`/api/domains/${id}?confirm=${encodeURIComponent(confirmText.trim().toLowerCase())}`),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ['domain', id] });
      queryClient.removeQueries({ queryKey: ['domain-cloudflare', id] });
      await invalidarTodo();
      toast('ok', 'Dominio eliminado.');
      navigate('/dominios');
    },
    onError: async (err) => {
      // Un borrado parcial ya ha retirado parte de los buzones: las listas
      // deben reflejarlo aunque la operación no haya terminado.
      await invalidarTodo();
      toast('error', err instanceof ApiError ? err.message : 'No se ha podido eliminar.');
    },
  });

  if (domain.isPending) {
    return (
      <Hoja>
        <Midiendo label="Leyendo la ficha del dominio…" />
      </Hoja>
    );
  }
  if (domain.isError || !domain.data) {
    const noExiste = domain.error instanceof ApiError && domain.error.status === 404;
    return (
      <Hoja>
        <p role="alert" className="text-base text-tinta-2">
          <span className="text-fuera">
            {noExiste
              ? 'No se ha encontrado el dominio.'
              : 'No se ha podido leer la ficha del dominio. Recargue la página para repetir la lectura.'}
          </span>{' '}
          <Link className="text-laboratorio underline" to="/dominios">
            Volver a dominios
          </Link>
        </p>
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
  const enReparto = record.status === 'active';
  const visible = nombreVisible(record);

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
            <MarcaFondo veredicto={enReparto ? 'normal' : medido ? 'fuera' : 'sin-dato'}>
              {enReparto ? 'En reparto' : 'Esperando DNS'}
            </MarcaFondo>
            <span className="text-white/70">Última medición: {formatDate(record.lastCheckedAt)}</span>
            {visible !== record.domain && (
              <span className="valor break-all text-white/75">{record.domain}</span>
            )}
          </span>
        }
        actions={
          <>
            <Button variant="peligro" onClick={() => setConfirmOpen(true)}>
              Eliminar
            </Button>
            <Button variant="campo" busy={verify.isPending} onClick={() => verify.mutate()}>
              Medir el DNS ahora
            </Button>
          </>
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
              valor={`${requiredOk}/${requiredTotal}`}
              referencia={`${requiredTotal}/${requiredTotal}`}
              veredicto={
                !medido ? 'sin-dato' : requiredOk >= requiredTotal ? 'normal' : 'fuera'
              }
              nota={
                requiredOk >= requiredTotal && medido
                  ? undefined
                  : 'Mientras falte alguno, el dominio no reparte correo.'
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
          </Hoja>
        )}

        <BloqueCloudflare key={record.id} dominio={record} isAdmin={isAdmin} alta={alta} />

        {checks.length > 0 && (
          <>
            <DescargaZona domainId={id} domain={record.domain} />

            <p className="max-w-[75ch] text-base text-tinta-2">
              Para crearlos a mano, copie cada muestra tal cual en el panel DNS de su proveedor.
              Los cambios pueden tardar de minutos a horas en propagarse; vuelva a medir cuando
              estén creados.
            </p>

            <Hoja
              title="Registros obligatorios"
              meta={`${requiredOk} de ${requiredTotal} en rango`}
              flush
            >
              <ul>
                {porVeredicto(required).map((check) => (
                  <RegistroMedido key={check.id} check={check} recien={justVerified} />
                ))}
              </ul>
            </Hoja>

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
      </div>

      <Dialogo open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Eliminar dominio">
        <div className="flex flex-col gap-4">
          <p className="text-base text-tinta-2">
            Se eliminarán el dominio, <strong className="text-tinta">todos sus buzones con su
            correo</strong> y sus alias, tanto de Mailway como del servidor de correo. Esta acción
            no se puede deshacer. Los registros DNS no se modifican.
          </p>
          <Input
            label={`Escriba ${record.domain} para confirmar`}
            mono
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={record.domain}
          />
          {remove.isError && (
            <BandaError>
              {remove.error instanceof ApiError ? remove.error.message : 'No se ha podido eliminar.'}
            </BandaError>
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
 * Una medición: el valor de referencia que hay que crear (la muestra que el
 * usuario se lleva a su proveedor) y, debajo, lo que el DNS devuelve ahora.
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
            {check.found || (check.status === 'unknown' ? 'sin lectura' : 'ningún registro')}
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
      'Lo anterior más la autoconfiguración: el móvil y Thunderbird configuran la cuenta automáticamente.',
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
        Para otros proveedores, o para importarlo a mano en Cloudflare:{' '}
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
