import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Tag } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
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
  interpretarSubdominio,
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
  Cargando,
  Muestra,
  Vacio,
  type Veredicto,
} from '../ui/kit';
import { useToast } from '../ui/toast';
import { CabeceraVista, rutaCliente } from '../components/gestion/comun';
import { HojasCorreoWeb } from '../components/CorreoWeb';
import { HojaWebmailAutomatico } from '../components/WebmailAutomatico';

const estadoMeta: Record<WhitelabelStatus, { veredicto: Veredicto; etiqueta: string; pista: string }> = {
  pending_dns: {
    veredicto: 'vigilar',
    etiqueta: 'Esperando DNS',
    pista: 'Crea en tu proveedor de DNS el registro que se indica a continuación.',
  },
  issuing: {
    veredicto: 'vigilar',
    etiqueta: 'Emitiendo certificado',
    pista:
      'El DNS ya apunta a este servidor. Falta confirmar que el webmail responde por HTTPS con un certificado válido; el certificado suele tardar menos de un minuto.',
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
 * Webmail que usa cada cliente, con el mismo criterio que el servidor
 * (connection.ts): el principal elegido o, si no hay ninguno, el primero que
 * entró en servicio. Así la ficha dice cuál se usa aunque nadie lo haya
 * elegido, y «Usar como principal» solo aparece en los demás.
 */
function webmailsPrincipales(lista: ClientDomain[]): Set<string> {
  const porCliente = new Map<string, ClientDomain>();
  const clave = (d: ClientDomain) =>
    [d.isPrimary ? 0 : 1, d.activatedAt ?? 0, d.createdAt, d.id] as const;
  for (const d of lista) {
    if (d.kind !== 'webmail' || d.status !== 'active') continue;
    const actual = porCliente.get(d.clientId);
    if (!actual) {
      porCliente.set(d.clientId, d);
      continue;
    }
    const [a, b] = [clave(d), clave(actual)];
    const antes = a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0);
    if (antes < 0) porCliente.set(d.clientId, d);
  }
  return new Set([...porCliente.values()].map((d) => d.id));
}

/**
 * Dominios propios del cliente: su webmail en su dominio, con certificado
 * automático. El registro que hay que crear se entrega como una muestra
 * exacta para copiar; el estado es el veredicto de la última medición.
 */
export default function MarcaBlanca({ isAdmin, clienteFijo }: { isAdmin: boolean; clienteFijo?: string }) {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User | null }>('/api/auth/me'),
  });
  // El filtro del administrador vive en la dirección (?cliente=, como en
  // Buzones y Alias): la ficha del cliente enlaza aquí con él ya elegido.
  // `clienteFijo`: la misma vista en la pestaña «Marca blanca» de la ficha del
  // cliente, con el filtro fijado y sin selector.
  const [params, setParams] = useSearchParams();
  const filtro = clienteFijo ?? (isAdmin ? (params.get('cliente') ?? '') : '');
  const elegible = isAdmin && !clienteFijo;
  const [abierto, setAbierto] = useState(false);
  const [nuevo, setNuevo] = useState<{ domain: ClientDomain; instructions: DnsInstruction[] } | null>(null);

  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: Client[] }>('/api/clients'),
    enabled: elegible,
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
    // El vigilante del servidor activa los dominios cuando su DNS y su HTTPS
    // responden: la lista se refresca sola mientras la página está abierta.
    refetchInterval: 15_000,
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
  const principales = webmailsPrincipales(lista);
  // El interruptor del webmail automático es de un cliente concreto: el de la
  // ficha, el elegido en el filtro o, para un cliente, el suyo.
  const clienteDelInterruptor = clienteFijo || (isAdmin ? filtro : (me.data?.user?.clientId ?? ''));
  // El ejemplo es del lector si es un cliente y de un tercero si es la administración.
  const ejemploDominio = isAdmin ? 'sucliente.com' : 'tuempresa.com';

  return (
    <>
      <CabeceraVista
        title="Marca blanca"
        enPestana={Boolean(clienteFijo)}
        meta={
          clienteFijo
            ? 'El webmail en el dominio del cliente, con su propio certificado. El nombre debe ser un subdominio de uno de sus dominios de correo con la propiedad comprobada.'
            : isAdmin || !me.isSuccess
              ? 'El webmail en el dominio de cada cliente, con su propio certificado. El nombre debe ser un subdominio de un dominio de correo del cliente con la propiedad comprobada.'
              : 'Tu webmail en tu propio dominio, con certificado. El nombre debe ser un subdominio de uno de tus dominios de correo con la propiedad comprobada.'
        }
        actions={
          <Button variant="principal" onClick={() => setAbierto(true)} disabled={!me.isSuccess}>
            Añadir dominio
          </Button>
        }
      />

      {elegible && (
        <Hoja className="mb-4">
          <div className="max-w-sm">
            <Select
              label="Cliente"
              value={filtro}
              onChange={(e) =>
                setParams(e.target.value ? { cliente: e.target.value } : {}, { replace: true })
              }
              help="Selecciona un cliente para configurar su dirección de webmail."
            >
              <option value="">Todos los clientes</option>
              {(clients.data?.clients ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          {clients.isError && (
            <AvisoError className="mt-3" onRetry={() => void clients.refetch()} retrying={clients.isFetching}>
              No se han podido cargar los clientes.
            </AvisoError>
          )}
        </Hoja>
      )}

      {/* El correo web de sus webmail propios (Roundcube o el nuevo) y su marca. */}
      {clienteDelInterruptor && <HojasCorreoWeb clientId={clienteDelInterruptor} isAdmin={isAdmin} />}
      {clienteDelInterruptor && <HojaWebmailAutomatico clientId={clienteDelInterruptor} isAdmin={isAdmin} />}

      {me.isError || domains.isError ? (
        <AvisoError
          retrying={me.isFetching || domains.isFetching}
          onRetry={() => {
            void me.refetch();
            void domains.refetch();
          }}
        >
          No se han podido cargar los dominios propios. Comprueba la conexión y vuelve a intentarlo.
        </AvisoError>
      ) : me.isPending || domains.isPending ? (
        <Hoja>
          <Cargando label="Cargando los dominios propios…" />
        </Hoja>
      ) : lista.length === 0 ? (
        <Hoja>
          <Vacio icono={Tag}
            title="No hay dominios propios"
            action={
              <Button variant="perfil" onClick={() => setAbierto(true)}>
                Añadir el primero
              </Button>
            }
          >
            Por omisión, el webmail se abre en la dirección general del servidor. Con un dominio
            propio —por ejemplo <span className="valor">webmail.{ejemploDominio}</span>, si{' '}
            <span className="valor">{ejemploDominio}</span> es un dominio de correo con la propiedad comprobada— se abre
            {isAdmin
              ? ` con la marca del cliente. Máximo ${MAX_DOMINIOS_PROPIOS} por cliente.`
              : ` con tu marca. Máximo ${MAX_DOMINIOS_PROPIOS}.`}
          </Vacio>
        </Hoja>
      ) : (
        <>
          <p className="mb-4 max-w-[75ch] text-base text-tinta-2">
            El webmail principal es el que se abre desde el resumen, los datos de conexión de los buzones y
            los enlaces de configuración. Si no se elige ninguno, se usa el primer dominio que entró en
            servicio y, si no hay ninguno en servicio, la dirección general del webmail.
          </p>
          <div className="flex flex-col gap-4">
            {lista.map((domain) => (
              <FichaDominio
                key={domain.id}
                domain={domain}
                cliente={elegible ? nombres.get(domain.clientId) ?? '' : ''}
                cuentas={cuentas.data?.accounts ?? []}
                principal={principales.has(domain.id)}
              />
            ))}
          </div>
        </>
      )}

      <DialogoAlta
        open={abierto}
        isAdmin={isAdmin}
        clienteFijo={Boolean(clienteFijo)}
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
              Crea este registro en el proveedor de DNS de{' '}
              <span className="valor">{nuevo.domain.hostname}</span>. Cuando esté publicado, pulsa
              «Comprobar» en la ficha del dominio.
            </p>
            {nuevo.instructions
              .filter((i) => i.recommended)
              .map((i) => (
                <RegistroDns key={i.type} instruccion={i} />
              ))}
            <Button variant="principal" onClick={() => setNuevo(null)}>
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
  clienteFijo,
  clientes,
  clienteInicial,
  clientePropio,
  onClose,
  onCreado,
}: {
  open: boolean;
  isAdmin: boolean;
  /** El cliente ya viene dado (ficha del cliente): no se ofrece elegirlo. */
  clienteFijo: boolean;
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
  // Si se escribe el nombre completo, el dominio del final manda sobre la lista.
  const interpretado = interpretarSubdominio(subdominio, verificados, pendientes);
  const dominioPadre = interpretado.padre || padre || verificados[0]?.domain || '';
  const hostname =
    interpretado.prefijo && !interpretado.error && dominioPadre ? `${interpretado.prefijo}.${dominioPadre}` : '';

  /** Al salir del campo, el nombre completo se reparte entre el campo y la lista. */
  function separarNombreCompleto() {
    if (interpretado.padre && !interpretado.error) {
      setSubdominio(interpretado.prefijo);
      setPadre(interpretado.padre);
    }
  }

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
        {isAdmin && !clienteFijo && (
          <Select
            label="Cliente"
            required
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              setPadre('');
            }}
          >
            <option value="">Selecciona un cliente…</option>
            {clientes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}

        {sinCliente ? null : dominiosCorreo.isPending ? (
          <Cargando label="Cargando los dominios de correo…" />
        ) : dominiosCorreo.isError ? (
          <AvisoError onRetry={() => void dominiosCorreo.refetch()} retrying={dominiosCorreo.isFetching}>
            No se han podido leer los dominios de correo del cliente.
          </AvisoError>
        ) : verificados.length === 0 ? (
          <div className="flex flex-col gap-2 text-base text-tinta-2">
            <p>
              {pendientes.length > 0
                ? `${isAdmin ? 'El cliente todavía no tiene' : 'Todavía no tienes'} ningún dominio de correo con la propiedad comprobada (${listaNatural(
                    pendientes.map(nombreVisible),
                  )} ${pendientes.length === 1 ? 'está pendiente' : 'están pendientes'}).`
                : isAdmin
                  ? 'El cliente todavía no tiene dominios de correo.'
                  : 'Todavía no tienes dominios de correo.'}{' '}
              El dominio propio debe ser un subdominio de un dominio de correo con la propiedad comprobada: así se
              garantiza que {isAdmin ? 'el cliente controla su' : 'controlas tu'} DNS.
            </p>
            <Link
              to={isAdmin && clientId ? rutaCliente(clientId, 'dominios') : '/dominios'}
              className="text-sm text-petroleo underline underline-offset-2 hover:text-tinta"
            >
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
                onChange={(e) => {
                  setError('');
                  setSubdominio(e.target.value);
                }}
                onBlur={separarNombreCompleto}
                placeholder="webmail"
                autoFocus
                error={interpretado.error ?? undefined}
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
          <Button type="submit" variant="principal" busy={crear.isPending} disabled={!hostname || sinCliente}>
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
        <dd className="codigo min-w-0 break-all text-tinta">{instruccion.value}</dd>
      </dl>
      <p className="mt-2 text-sm text-tinta-2">{instruccion.help}</p>
    </Muestra>
  );
}

function FichaDominio({
  domain,
  cliente,
  cuentas,
  principal,
}: {
  domain: ClientDomain;
  cliente: string;
  cuentas: CuentaCloudflare[];
  /** Es el webmail que usa el cliente (elegido o, sin elección, el primero en servicio). */
  principal: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmar, setConfirmar] = useState(false);
  const meta = estadoMeta[domain.status];
  // El webmail va con el proxy de Cloudflare: el botón sigue a mano también en
  // servicio, para activárselo a un registro que se creó sin él.
  const cuenta =
    domain.status === 'pending_dns' || domain.kind === 'webmail'
      ? cuentaCloudflarePara(cuentas, domain.clientId, domain.hostname)
      : undefined;

  // Activar, elegir o quitar un dominio cambia el webmail que ven el resumen
  // del cliente y los datos de conexión de sus buzones.
  const invalidar = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['whitelabel-domains'] }),
      queryClient.invalidateQueries({ queryKey: ['whitelabel-domain', domain.id] }),
      queryClient.invalidateQueries({ queryKey: ['client-dashboard'] }),
      queryClient.invalidateQueries({ queryKey: ['conexion'] }),
    ]);

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
      await invalidar();
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

  const usarComoPrincipal = useMutation({
    mutationFn: () => api.post<{ domain: ClientDomain }>(`/api/whitelabel/domains/${domain.id}/primary`),
    onSuccess: async () => {
      await invalidar();
      toast('ok', `${domain.hostname} es ahora el webmail principal${cliente ? ` de ${cliente}` : ''}.`);
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se ha podido cambiar el webmail principal.'),
  });

  const cloudflare = useMutation({
    mutationFn: () =>
      api.post<ResultadoCloudflareMarcaBlanca>(`/api/whitelabel/domains/${domain.id}/cloudflare`),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['whitelabel-domains'] });
      if (data.errors.length > 0) {
        toast('error', `Cloudflare ha rechazado el registro: ${data.errors[0]!.error}`);
      } else if (data.applied.length > 0) {
        toast('ok', 'Se ha configurado el registro en Cloudflare. La comprobación se repetirá en unos minutos.');
      } else if ((data.skipped ?? []).length > 0) {
        toast('error', data.skipped[0]!.reason);
      } else {
        toast('ok', 'El registro ya estaba configurado en Cloudflare.');
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
      await invalidar();
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
          {cliente && <span className="block text-sm text-tinta-3">{cliente}</span>}
          {domain.automatico && <span className="block text-sm text-tinta-3">Creado automáticamente</span>}
          {principal && (
            <span className="mt-1 block text-sm text-tinta-2">
              {domain.isPrimary ? 'Webmail principal' : 'Webmail principal: el primero que entró en servicio'}
            </span>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <MarcaFondo veredicto={meta.veredicto}>{meta.etiqueta}</MarcaFondo>
          {cuenta && (
            <Button variant="perfil" busy={cloudflare.isPending} onClick={() => cloudflare.mutate()}>
              Configurar en Cloudflare
            </Button>
          )}
          {domain.kind === 'webmail' && domain.status === 'active' && !principal && (
            <Button
              variant="perfil"
              busy={usarComoPrincipal.isPending}
              onClick={() => usarComoPrincipal.mutate()}
            >
              Usar como principal
            </Button>
          )}
          {/* También en servicio: la comprobación confirma que el webmail sigue
              respondiendo por HTTPS (un 404 o un 5xx indican que la ruta falla). */}
          <Button variant="perfil" busy={comprobar.isPending} onClick={() => comprobar.mutate()}>
            Comprobar
          </Button>
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
            className="valor break-all text-petroleo underline underline-offset-2"
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
                sin pasar por su panel{domain.kind === 'webmail' ? ', con el proxy de Cloudflare activo' : ''}.
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
            {principal &&
              ' Es el webmail principal: los accesos pasarán al siguiente dominio en servicio o, si no hay ninguno, a la dirección general del webmail.'}
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
