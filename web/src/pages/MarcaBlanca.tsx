import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  api,
  ApiError,
  type Client,
  type ClientDomain,
  type DnsInstruction,
  type User,
  type WhitelabelStatus,
} from '../lib/api';
import { formatDate } from '../lib/format';
import { nombreVisible, type DominioCorreo } from '../lib/cloudflare';
import {
  cuentaCloudflarePara,
  MAX_DOMINIOS_PROPIOS,
  type CuentaCloudflare,
  type ResultadoCloudflareMarcaBlanca,
} from '../lib/rutas';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import {
  AvisoError,
  Dialogo,
  Hoja,
  MarcaFondo,
  Membrete,
  Midiendo,
  Muestra,
  Vacio,
  type Veredicto,
} from '../ui/kit';
import { useToast } from '../ui/toast';

const estadoMeta: Record<WhitelabelStatus, { veredicto: Veredicto; etiqueta: string; pista: string }> = {
  pending_dns: {
    veredicto: 'vigilar',
    etiqueta: 'Esperando DNS',
    pista: 'Cree en su proveedor de DNS el registro que se indica a continuación.',
  },
  issuing: {
    veredicto: 'vigilar',
    etiqueta: 'Emitiendo certificado',
    pista: 'El DNS ya apunta a este servidor. El certificado suele tardar menos de un minuto.',
  },
  active: { veredicto: 'normal', etiqueta: 'En servicio', pista: 'El dominio funciona con HTTPS.' },
  error: { veredicto: 'fuera', etiqueta: 'Con error', pista: '' },
};

/** «Fuera de rango primero»: lo que requiere acción, arriba. */
const ORDEN: Record<WhitelabelStatus, number> = { error: 0, pending_dns: 1, issuing: 2, active: 3 };

/** «a.es», «a.es y b.es», «a.es, b.es y c.es». */
function listaNatural(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/**
 * Dominio de correo con la propiedad comprobada: el servidor solo admite
 * dominios propios que cuelguen de uno así, porque demuestra que el cliente
 * controla su DNS. Con un servidor anterior sin ese dato, vale estar activo.
 */
function verificado(d: DominioCorreo): boolean {
  if (d.ownershipVerifiedAt !== undefined) return d.ownershipVerifiedAt !== null;
  return d.status === 'active' || d.verifiedAt !== null;
}

/**
 * Dominios propios del cliente: su webmail en su dominio, con certificado
 * automático. El registro que hay que crear se entrega como una muestra
 * exacta para copiar; el estado es el veredicto de la última medición.
 */
export default function MarcaBlanca() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User | null }>('/api/auth/me'),
  });
  const isAdmin = me.data?.user?.role === 'admin';
  const [filtro, setFiltro] = useState('');
  const [abierto, setAbierto] = useState(false);
  const [nuevo, setNuevo] = useState<{ domain: ClientDomain; instructions: DnsInstruction[] } | null>(null);

  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: Client[] }>('/api/clients'),
    enabled: isAdmin,
  });
  const domains = useQuery({
    queryKey: ['whitelabel-domains', isAdmin ? filtro : 'propio'],
    queryFn: () =>
      api.get<{ domains: ClientDomain[] }>(
        isAdmin && filtro
          ? `/api/whitelabel/domains?clientId=${encodeURIComponent(filtro)}`
          : '/api/whitelabel/domains',
      ),
    enabled: me.isSuccess,
  });
  // Cloudflare es opcional: si el área no existe o falla, simplemente no se ofrece.
  const cuentas = useQuery({
    queryKey: ['cloudflare-accounts'],
    queryFn: () => api.get<{ accounts: CuentaCloudflare[] }>('/api/cloudflare/accounts'),
    retry: false,
    staleTime: 60_000,
  });

  const nombres = useMemo(
    () => new Map((clients.data?.clients ?? []).map((c) => [c.id, c.name])),
    [clients.data],
  );
  const lista = [...(domains.data?.domains ?? [])].sort(
    (a, b) => ORDEN[a.status] - ORDEN[b.status] || a.hostname.localeCompare(b.hostname),
  );

  return (
    <>
      <Membrete
        title="Marca blanca"
        meta={
          isAdmin || !me.isSuccess
            ? 'El webmail en el dominio de cada cliente, con su propio certificado. El nombre debe ser un subdominio de un dominio de correo del cliente con la propiedad comprobada.'
            : 'Su webmail en su propio dominio, con certificado. El nombre debe ser un subdominio de uno de sus dominios de correo con la propiedad comprobada.'
        }
        actions={
          <Button variant="campo" onClick={() => setAbierto(true)} disabled={!me.isSuccess}>
            Añadir dominio
          </Button>
        }
      />

      {isAdmin && (
        <Hoja className="mb-4">
          <div className="max-w-sm">
            <Select label="Cliente" value={filtro} onChange={(e) => setFiltro(e.target.value)}>
              <option value="">Todos los clientes</option>
              {(clients.data?.clients ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
        </Hoja>
      )}

      {me.isError || domains.isError ? (
        <AvisoError
          retrying={me.isFetching || domains.isFetching}
          onRetry={() => {
            void me.refetch();
            void domains.refetch();
          }}
        >
          No se han podido cargar los dominios propios. Compruebe la conexión y vuelva a intentarlo.
        </AvisoError>
      ) : me.isPending || domains.isPending ? (
        <Hoja>
          <Midiendo label="Leyendo los dominios propios…" />
        </Hoja>
      ) : lista.length === 0 ? (
        <Hoja>
          <Vacio
            title="No hay dominios propios"
            action={
              <Button variant="perfil" onClick={() => setAbierto(true)}>
                Añadir el primero
              </Button>
            }
          >
            Por omisión, el webmail se abre en la dirección general del servidor. Con un dominio
            propio —por ejemplo <span className="valor">webmail.suempresa.com</span>, si{' '}
            <span className="valor">suempresa.com</span> es un dominio de correo con la propiedad comprobada— se abre
            {isAdmin
              ? ` con la marca del cliente. Máximo ${MAX_DOMINIOS_PROPIOS} por cliente.`
              : ` con su marca. Máximo ${MAX_DOMINIOS_PROPIOS}.`}
          </Vacio>
        </Hoja>
      ) : (
        <div className="flex flex-col gap-4">
          {lista.map((domain) => (
            <FichaDominio
              key={domain.id}
              domain={domain}
              cliente={isAdmin ? nombres.get(domain.clientId) ?? '' : ''}
              cuentas={cuentas.data?.accounts ?? []}
            />
          ))}
        </div>
      )}

      <DialogoAlta
        open={abierto}
        isAdmin={isAdmin}
        clientes={clients.data?.clients ?? []}
        clienteInicial={filtro}
        clientePropio={me.data?.user?.clientId ?? ''}
        onClose={() => setAbierto(false)}
        onCreado={(data) => {
          setAbierto(false);
          setNuevo(data);
        }}
      />

      <Dialogo open={nuevo !== null} onClose={() => setNuevo(null)} title="Registro DNS necesario">
        {nuevo && (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2">
              Cree este registro en el proveedor de DNS de{' '}
              <span className="valor">{nuevo.domain.hostname}</span>. Cuando esté publicado, pulse
              «Comprobar» en la ficha del dominio.
            </p>
            {nuevo.instructions
              .filter((i) => i.recommended)
              .map((i) => (
                <RegistroDns key={i.type} instruccion={i} />
              ))}
            <Button variant="tinta" onClick={() => setNuevo(null)}>
              Aceptar
            </Button>
          </div>
        )}
      </Dialogo>
    </>
  );
}

/* ------------------------------ Alta de dominio ---------------------------- */

function DialogoAlta({
  open,
  isAdmin,
  clientes,
  clienteInicial,
  clientePropio,
  onClose,
  onCreado,
}: {
  open: boolean;
  isAdmin: boolean;
  clientes: Client[];
  clienteInicial: string;
  clientePropio: string;
  onClose: () => void;
  onCreado: (data: { domain: ClientDomain; instructions: DnsInstruction[] }) => void;
}) {
  const queryClient = useQueryClient();
  const [clientId, setClientId] = useState('');
  const [subdominio, setSubdominio] = useState('webmail');
  const [padre, setPadre] = useState('');
  const [error, setError] = useState('');

  // Al abrir, el cliente del filtro (administrador) o el propio (cliente).
  useEffect(() => {
    if (!open) return;
    setClientId(isAdmin ? clienteInicial : clientePropio);
    setSubdominio('webmail');
    setPadre('');
    setError('');
  }, [open, isAdmin, clienteInicial, clientePropio]);

  const dominiosCorreo = useQuery({
    queryKey: ['domains', 'cliente', isAdmin ? clientId : 'propio'],
    queryFn: () =>
      api.get<{ domains: DominioCorreo[] }>(
        isAdmin ? `/api/domains?clientId=${encodeURIComponent(clientId)}` : '/api/domains',
      ),
    enabled: open && (!isAdmin || Boolean(clientId)),
  });
  const verificados = (dominiosCorreo.data?.domains ?? []).filter(verificado);
  const pendientes = (dominiosCorreo.data?.domains ?? []).filter((d) => !verificado(d));
  const dominioPadre = padre || verificados[0]?.domain || '';
  const prefijo = subdominio.trim().toLowerCase().replace(/\.+$/, '');
  const hostname = prefijo && dominioPadre ? `${prefijo}.${dominioPadre}` : '';

  const crear = useMutation({
    mutationFn: () =>
      api.post<{ domain: ClientDomain; instructions: DnsInstruction[] }>('/api/whitelabel/domains', {
        hostname,
        kind: 'webmail',
        clientId: isAdmin ? clientId : undefined,
      }),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['whitelabel-domains'] });
      onCreado(data);
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'No se ha podido añadir el dominio.'),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    crear.mutate();
  }

  const sinCliente = isAdmin && !clientId;

  return (
    <Dialogo open={open} onClose={onClose} title="Añadir dominio propio">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {isAdmin && (
          <Select
            label="Cliente"
            required
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              setPadre('');
            }}
          >
            <option value="">Seleccione un cliente…</option>
            {clientes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}

        {sinCliente ? null : dominiosCorreo.isPending ? (
          <Midiendo label="Leyendo los dominios de correo…" />
        ) : dominiosCorreo.isError ? (
          <AvisoError onRetry={() => void dominiosCorreo.refetch()} retrying={dominiosCorreo.isFetching}>
            No se han podido leer los dominios de correo del cliente.
          </AvisoError>
        ) : verificados.length === 0 ? (
          <div className="flex flex-col gap-2 text-base text-tinta-2">
            <p>
              {pendientes.length > 0
                ? `${isAdmin ? 'El cliente todavía no tiene' : 'Todavía no tiene'} ningún dominio de correo con la propiedad comprobada (${listaNatural(
                    pendientes.map(nombreVisible),
                  )} ${pendientes.length === 1 ? 'está pendiente' : 'están pendientes'}).`
                : isAdmin
                  ? 'El cliente todavía no tiene dominios de correo.'
                  : 'Todavía no tiene dominios de correo.'}{' '}
              El dominio propio debe ser un subdominio de un dominio de correo con la propiedad comprobada: así se
              garantiza que {isAdmin ? 'el cliente controla' : 'usted controla'} su DNS.
            </p>
            <Link to="/dominios" className="text-sm text-laboratorio underline underline-offset-2 hover:text-tinta">
              Ir a Dominios
            </Link>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Subdominio"
                mono
                required
                value={subdominio}
                onChange={(e) => setSubdominio(e.target.value)}
                placeholder="webmail"
                autoFocus
              />
              <Select label="Dominio de correo" value={dominioPadre} onChange={(e) => setPadre(e.target.value)}>
                {verificados.map((d) => (
                  <option key={d.id} value={d.domain}>
                    {nombreVisible(d)}
                  </option>
                ))}
              </Select>
            </div>
            <Muestra rotulo="Dirección del webmail">
              <span className="valor break-all text-base text-tinta">
                {hostname ? `https://${hostname}` : '—'}
              </span>
            </Muestra>
            <p className="text-sm text-tinta-2">
              Solo se admiten subdominios de los dominios de correo con la propiedad comprobada
              {isAdmin ? ` del cliente, hasta ${MAX_DOMINIOS_PROPIOS} por cliente.` : `, hasta ${MAX_DOMINIOS_PROPIOS}.`} Los nombres autoconfig, autodiscover y mta-sts están
              reservados para la configuración automática de los programas de correo. Después se
              indicará el registro DNS que hay que crear.
            </p>
          </>
        )}

        {error && <AvisoError>{error}</AvisoError>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="plano" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="tinta" busy={crear.isPending} disabled={!hostname || sinCliente}>
            Añadir
          </Button>
        </div>
      </form>
    </Dialogo>
  );
}

/* --------------------------------- Fichas --------------------------------- */

function RegistroDns({ instruccion }: { instruccion: DnsInstruction }) {
  return (
    <Muestra rotulo={`Registro ${instruccion.type}`} copiar={instruccion.value}>
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-base">
        <dt className="rotulo self-baseline">Nombre</dt>
        {/* Se parte por caracteres en vez de recortarse: el botón copia el valor exacto. */}
        <dd className="valor min-w-0 break-all text-tinta">{instruccion.name}</dd>
        <dt className="rotulo self-baseline">Valor</dt>
        <dd className="valor min-w-0 break-all text-tinta">{instruccion.value}</dd>
      </dl>
      <p className="mt-2 text-sm text-tinta-2">{instruccion.help}</p>
    </Muestra>
  );
}

function FichaDominio({
  domain,
  cliente,
  cuentas,
}: {
  domain: ClientDomain;
  cliente: string;
  cuentas: CuentaCloudflare[];
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmar, setConfirmar] = useState(false);
  const meta = estadoMeta[domain.status];
  const cuenta = domain.status === 'pending_dns' ? cuentaCloudflarePara(cuentas, domain.clientId, domain.hostname) : undefined;

  const detalle = useQuery({
    queryKey: ['whitelabel-domain', domain.id],
    queryFn: () =>
      api.get<{ domain: ClientDomain; instructions: DnsInstruction[] }>(`/api/whitelabel/domains/${domain.id}`),
    // Las instrucciones solo dependen del servidor y del nombre: no cambian
    // mientras la ficha está abierta.
    staleTime: 5 * 60_000,
    enabled: domain.status !== 'active',
  });

  const comprobar = useMutation({
    mutationFn: () => api.post<{ domain: ClientDomain }>(`/api/whitelabel/domains/${domain.id}/verify`),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['whitelabel-domains'] });
      if (data.domain.status === 'active') {
        toast('ok', `${data.domain.hostname} ya funciona con HTTPS.`);
      } else {
        // Pendiente de DNS reclama una acción; emitiendo certificado, solo esperar.
        toast(
          data.domain.status === 'issuing' ? 'ok' : 'error',
          data.domain.detail || 'Se ha completado la comprobación.',
        );
      }
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se ha podido completar la comprobación.'),
  });

  const cloudflare = useMutation({
    mutationFn: () =>
      api.post<ResultadoCloudflareMarcaBlanca>(`/api/whitelabel/domains/${domain.id}/cloudflare`),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['whitelabel-domains'] });
      if (data.errors.length > 0) {
        toast('error', `Cloudflare ha rechazado el registro: ${data.errors[0]!.error}`);
      } else {
        toast('ok', 'Se ha creado el registro en Cloudflare. La comprobación se repetirá en unos minutos.');
      }
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 404) {
        toast('error', 'La configuración automática en Cloudflare no está disponible en este servidor.');
        return;
      }
      toast('error', err instanceof ApiError ? err.message : 'No se ha podido configurar Cloudflare.');
    },
  });

  const borrar = useMutation({
    mutationFn: () => api.delete(`/api/whitelabel/domains/${domain.id}`),
    onSuccess: async () => {
      setConfirmar(false);
      await queryClient.invalidateQueries({ queryKey: ['whitelabel-domains'] });
      toast('ok', `Se ha eliminado ${domain.hostname}.`);
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se ha podido eliminar el dominio.'),
  });

  const instrucciones = detalle.data?.instructions ?? [];

  return (
    <Hoja>
      {/* El dominio en su propia línea: en móvil identifica la ficha y no
          puede quedar comprimido por las acciones. */}
      <div className="regla-cabecera mb-3 flex flex-col gap-3 pb-3 sm:flex-row sm:items-baseline sm:justify-between">
        <div className="min-w-0">
          <span className="valor block break-all text-md text-tinta">{domain.hostname}</span>
          {cliente && <span className="text-sm text-tinta-3">{cliente}</span>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <MarcaFondo veredicto={meta.veredicto}>{meta.etiqueta}</MarcaFondo>
          {cuenta && (
            <Button variant="perfil" busy={cloudflare.isPending} onClick={() => cloudflare.mutate()}>
              Configurar en Cloudflare
            </Button>
          )}
          {domain.status !== 'active' && (
            <Button variant="perfil" busy={comprobar.isPending} onClick={() => comprobar.mutate()}>
              Comprobar
            </Button>
          )}
          <Button variant="plano" onClick={() => setConfirmar(true)}>
            Eliminar
          </Button>
        </div>
      </div>

      <p className="text-base text-tinta-2">{domain.detail || meta.pista}</p>

      {domain.status === 'active' ? (
        <p className="mt-2 text-base text-tinta-2">
          El webmail ya está disponible en{' '}
          <a
            href={`https://${domain.hostname}`}
            target="_blank"
            rel="noreferrer"
            className="valor break-all text-laboratorio underline underline-offset-2"
          >
            https://{domain.hostname}
          </a>
          {domain.activatedAt && (
            <span className="text-tinta-3"> · activo desde {formatDate(domain.activatedAt)}</span>
          )}
        </p>
      ) : detalle.isError ? (
        <AvisoError className="mt-3" onRetry={() => void detalle.refetch()} retrying={detalle.isFetching}>
          No se han podido leer las instrucciones de DNS de este dominio.
        </AvisoError>
      ) : (
        instrucciones.length > 0 && (
          <div className="mt-3 flex flex-col gap-3">
            {cuenta && (
              <p className="text-sm text-tinta-2">
                La zona está en Cloudflare ({cuenta.label}): «Configurar en Cloudflare» crea el registro
                sin pasar por su panel.
              </p>
            )}
            {instrucciones.map((i) => (
              <RegistroDns key={i.type} instruccion={i} />
            ))}
          </div>
        )
      )}

      <Dialogo open={confirmar} onClose={() => setConfirmar(false)} title="Eliminar dominio propio">
        <div className="flex flex-col gap-4">
          <p className="text-base text-tinta-2">
            Se eliminará <span className="valor break-all">{domain.hostname}</span>. El webmail dejará de
            responder en esa dirección en unos segundos; los buzones y el correo no se ven afectados.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="plano" onClick={() => setConfirmar(false)}>
              Cancelar
            </Button>
            <Button variant="peligro" busy={borrar.isPending} onClick={() => borrar.mutate()}>
              Eliminar
            </Button>
          </div>
        </div>
      </Dialogo>
    </Hoja>
  );
}
