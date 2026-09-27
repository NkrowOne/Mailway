import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, type Client } from '../lib/api';
import {
  cuentasUtilizables,
  invalidarTrasAltaOBaja,
  lecturaDominio,
  nombreVisible,
  propiedadPendiente,
  type CuentaCloudflare,
  type DominioCorreo,
  type EstadoAltaDominio,
  type ResultadoAplicacion,
} from '../lib/cloudflare';
import { formatDate, plural } from '../lib/format';
import { useClientes, useUsuario } from '../components/gestion/consultas';
import { BandaAviso } from '../components/cloudflare/comun';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import { AvisoError, Dialogo, Hoja, MarcaFondo, Membrete, Midiendo, Vacio, type Veredicto } from '../ui/kit';
import { useToast } from '../ui/toast';

/**
 * Registro de dominios: una fila por dominio medido. El dominio es el dato que
 * identifica la fila, así que en pantalla estrecha ocupa línea propia y se
 * parte si hace falta; nunca se recorta ni obliga a desplazar en horizontal.
 */

/** Fuera de rango primero; después, lo que vigilar, sin dato y, al final, lo activo. */
const ordenVeredicto: Record<Veredicto, number> = { fuera: 0, vigilar: 1, 'sin-dato': 2, normal: 3 };

interface RespuestaAlta {
  domain: DominioCorreo;
  cloudflare: ResultadoAplicacion | null;
  cloudflareReason?: string;
}

/**
 * Aviso tras el alta según lo que pasó con Cloudflare. Un motivo o unos
 * conflictos sin aplicar reclaman atención: no se anuncian como un éxito.
 */
function avisoAlta(data: RespuestaAlta, pedido: boolean): { tono: 'ok' | 'error'; texto: string } {
  if (!pedido) return { tono: 'ok', texto: 'Dominio dado de alta. Configure ahora su DNS.' };
  const cf = data.cloudflare;
  if (!cf || data.cloudflareReason) {
    return {
      tono: 'error',
      texto:
        'Dominio dado de alta, pero no se ha configurado el DNS en Cloudflare. Consulte el motivo en la ficha del dominio.',
    };
  }
  if (cf.errors.length > 0) {
    return {
      tono: 'error',
      texto:
        cf.applied.length > 0
          ? 'Dominio dado de alta. Parte de los registros no se ha podido aplicar en Cloudflare: consulte el detalle en la ficha del dominio.'
          : 'Dominio dado de alta, pero no se ha podido aplicar el DNS en Cloudflare. Consulte el detalle en la ficha del dominio.',
    };
  }
  if ((cf.skipped ?? []).length > 0) {
    return {
      tono: 'error',
      texto:
        'Dominio dado de alta. Hay registros en conflicto en Cloudflare que no se han modificado: revíselos en la ficha del dominio.',
    };
  }
  if (cf.applied.length > 0) return { tono: 'ok', texto: 'Dominio dado de alta y DNS aplicado en Cloudflare.' };
  return { tono: 'ok', texto: 'Dominio dado de alta. Los registros ya estaban configurados en Cloudflare.' };
}

export default function Dominios({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const idCasilla = useId();
  const usuario = useUsuario();
  const { clientes } = useClientes(usuario);
  const [open, setOpen] = useState(false);
  const [domainName, setDomainName] = useState('');
  const [clientId, setClientId] = useState('');
  const [autoDns, setAutoDns] = useState(true);
  const [error, setError] = useState('');

  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ domains: DominioCorreo[] }>('/api/domains'),
  });
  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: Client[] }>('/api/clients'),
    enabled: isAdmin,
  });
  const cuentas = useQuery({
    queryKey: ['cloudflare-accounts'],
    queryFn: () => api.get<{ accounts: CuentaCloudflare[] }>('/api/cloudflare/accounts'),
  });

  // Cuentas que servirían para el cliente elegido: las suyas y, si quien da
  // de alta es el administrador, también las de la instancia.
  // (Un cliente solo recibe sus propias cuentas.)
  const todas = cuentas.data?.accounts ?? [];
  const utilizables = isAdmin
    ? cuentasUtilizables(todas, { clientId: clientId || null, isAdmin: true })
    : todas;
  const hayCloudflare = utilizables.length > 0;

  // Límite del plan: un cliente lo ve antes de rellenar nada; el
  // administrador, al elegir el cliente en el formulario.
  const clientePropio = !isAdmin ? [...clientes.values()][0] : undefined;
  const limitePropio = clientePropio ? clientePropio.usage.domains >= clientePropio.plan.maxDomains : false;
  const elegido = isAdmin && clientId ? clientes.get(clientId) : undefined;
  const limiteElegido = elegido ? elegido.usage.domains >= elegido.plan.maxDomains : false;

  const create = useMutation({
    mutationFn: () =>
      api.post<RespuestaAlta>('/api/domains', {
        domain: domainName,
        clientId: isAdmin ? clientId : undefined,
        ...(hayCloudflare && autoDns ? { autoDns: true } : {}),
      }),
    onSuccess: async (data) => {
      await invalidarTrasAltaOBaja(queryClient, data.domain.clientId);
      setOpen(false);
      const pedido = hayCloudflare && autoDns;
      const aviso = avisoAlta(data, pedido);
      toast(aviso.tono, aviso.texto);
      const alta: EstadoAltaDominio = {
        autoDns: pedido,
        cloudflare: data.cloudflare ?? null,
        ...(data.cloudflareReason ? { cloudflareReason: data.cloudflareReason } : {}),
      };
      navigate(`/dominios/${data.domain.id}`, { state: { alta } });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'No se ha podido dar de alta.'),
  });

  function abrir() {
    // Cada alta empieza de cero: un cliente elegido antes no debe arrastrarse.
    setDomainName('');
    setClientId('');
    setAutoDns(true);
    setError('');
    create.reset();
    setOpen(true);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    create.mutate();
  }

  const list = [...(domains.data?.domains ?? [])].sort(
    (a, b) => ordenVeredicto[lecturaDominio(a).veredicto] - ordenVeredicto[lecturaDominio(b).veredicto],
  );
  const activos = list.filter((d) => d.status === 'active').length;
  const nombreCliente = new Map((clients.data?.clients ?? []).map((c) => [c.id, c.name]));

  return (
    <>
      <Membrete
        title="Dominios"
        meta={
          <>
            Un dominio no puede enviar ni recibir correo hasta que sus registros DNS coinciden con los
            valores de referencia.
            {!domains.isPending && (clientePropio || list.length > 0) && (
              <span className="valor mt-1 block text-sm text-white/70">
                {clientePropio
                  ? `${clientePropio.usage.domains} de ${clientePropio.plan.maxDomains} dominios del plan · ${activos} de ${list.length} activos`
                  : `${activos} de ${list.length} activos`}
              </span>
            )}
          </>
        }
        actions={
          <Button variant="campo" onClick={abrir} disabled={limitePropio || clientePropio?.suspended}>
            Añadir dominio
          </Button>
        }
      />

      {clientePropio?.suspended && (
        <div className="mb-4">
          <BandaAviso titulo="Servicio suspendido">
            Mientras el servicio esté suspendido no se pueden añadir dominios. Póngase en contacto con el
            administrador.
          </BandaAviso>
        </div>
      )}

      {limitePropio && clientePropio && !clientePropio.suspended && (
        <div className="mb-4">
          <BandaAviso titulo="Límite del plan">
            Se ha alcanzado el máximo de dominios del plan ({plural(clientePropio.plan.maxDomains, 'dominio', 'dominios')}).
            Para añadir otro, elimine alguno o solicite una ampliación del plan.
          </BandaAviso>
        </div>
      )}

      {domains.isPending ? (
        <Hoja>
          <Midiendo label="Cargando los dominios…" />
        </Hoja>
      ) : domains.isError ? (
        <AvisoError onRetry={() => void domains.refetch()} retrying={domains.isFetching}>
          No se ha podido cargar la lista de dominios.
        </AvisoError>
      ) : list.length === 0 ? (
        <Hoja>
          <Vacio
            title="Todavía no hay dominios"
            action={
              <Button variant="perfil" onClick={abrir} disabled={limitePropio || clientePropio?.suspended}>
                Añadir el primero
              </Button>
            }
          >
            Dé de alta un dominio (por ejemplo, miempresa.com) para crear buzones con esa
            dirección.
          </Vacio>
        </Hoja>
      ) : (
        <Hoja flush>
          {/* Cabecera de columnas: en móvil cada valor lleva su propio rótulo. */}
          <div className="regla-cabecera hidden items-baseline gap-x-4 bg-hoja-3 px-4 py-1.5 sm:flex">
            <span className="rotulo min-w-0 flex-1">Dominio</span>
            {isAdmin && <span className="rotulo shrink-0 basis-40">Cliente</span>}
            <span className="rotulo shrink-0 basis-24">Obligatorios</span>
            <span className="rotulo shrink-0 basis-32">Última medición</span>
            <span className="rotulo shrink-0 basis-28 text-right">Veredicto</span>
          </div>

          <ul>
            {list.map((domain) => {
              const requiredOk = domain.dnsStatus.requiredOk ?? 0;
              const requiredTotal = domain.dnsStatus.requiredTotal ?? 0;
              const { veredicto, etiqueta } = lecturaDominio(domain);
              const visible = nombreVisible(domain);
              return (
                <li
                  key={domain.id}
                  className={`regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-1.5 px-4 py-2.5
                    transition-colors duration-100 last:border-b-0 hover:bg-hoja-2
                    ${veredicto === 'fuera' ? 'fila-fuera' : veredicto === 'vigilar' ? 'fila-vigilar' : ''}`}
                >
                  <span className="min-w-0 basis-full sm:basis-0 sm:grow">
                    <Link
                      to={`/dominios/${domain.id}`}
                      className="valor break-all text-base text-tinta hover:text-laboratorio hover:underline"
                    >
                      {visible}
                    </Link>
                    {domain.cloudflare && <span className="rotulo ml-2 whitespace-nowrap">Cloudflare</span>}
                    {propiedadPendiente(domain) && (
                      <span className="rotulo ml-2 whitespace-nowrap text-vigilar">Propiedad pendiente</span>
                    )}
                    {visible !== domain.domain && (
                      <span className="valor block break-all text-sm text-tinta-3">{domain.domain}</span>
                    )}
                  </span>

                  {isAdmin && (
                    <span className="min-w-0 shrink-0 sm:basis-40">
                      <span className="rotulo mr-1.5 sm:hidden">Cliente</span>
                      <Link
                        to={`/clientes/${domain.clientId}`}
                        className="break-words text-sm text-tinta-2 hover:text-laboratorio hover:underline"
                      >
                        {nombreCliente.get(domain.clientId) ?? '—'}
                      </Link>
                    </span>
                  )}

                  <span className="shrink-0 sm:basis-24">
                    <span className="rotulo mr-1.5 sm:hidden">Obligatorios</span>
                    <span className="valor text-sm text-tinta-2">
                      {requiredTotal > 0 ? `${requiredOk}/${requiredTotal}` : '—'}
                    </span>
                  </span>

                  <span className="shrink-0 sm:basis-32">
                    <span className="rotulo mr-1.5 sm:hidden">Medido</span>
                    <span className="text-sm text-tinta-3">{formatDate(domain.lastCheckedAt)}</span>
                  </span>

                  <span className="ml-auto shrink-0 sm:ml-0 sm:basis-28 sm:text-right">
                    <MarcaFondo veredicto={veredicto}>{etiqueta}</MarcaFondo>
                  </span>
                </li>
              );
            })}
          </ul>
        </Hoja>
      )}

      <Dialogo open={open} onClose={() => setOpen(false)} title="Añadir dominio">
        <form onSubmit={submit} className="flex flex-col gap-4">
          {isAdmin && (
            <Select
              label="Cliente propietario"
              required
              value={clientId}
              onChange={(e) => {
                setClientId(e.target.value);
                setError('');
              }}
              error={clients.isError ? 'No se ha podido cargar la lista de clientes.' : undefined}
            >
              <option value="">Seleccione un cliente…</option>
              {(clients.data?.clients ?? []).map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </Select>
          )}
          {limiteElegido && elegido && (
            <BandaAviso titulo="Límite del plan">
              {elegido.name} ha alcanzado el máximo de dominios de su plan «{elegido.plan.name}» (
              {plural(elegido.plan.maxDomains, 'dominio', 'dominios')}). Para añadir otro, cambie el plan del
              cliente desde su ficha o elimine alguno de sus dominios.
            </BandaAviso>
          )}
          <Input
            label="Dominio"
            required
            mono
            value={domainName}
            onChange={(e) => {
              setDomainName(e.target.value);
              setError('');
            }}
            placeholder="miempresa.com"
            autoComplete="off"
            help="Sin «http://» ni rutas. Se admiten dominios con «ñ» y acentos. Es necesario poder editar su DNS en el proveedor (Cloudflare, IONOS…)."
          />

          {hayCloudflare && (
            <div className="border border-regla bg-hoja-2 px-3 py-2.5">
              <label htmlFor={idCasilla} className="flex cursor-pointer items-baseline gap-2.5">
                <input
                  id={idCasilla}
                  type="checkbox"
                  checked={autoDns}
                  onChange={(e) => setAutoDns(e.target.checked)}
                  className="mt-0.5 shrink-0"
                />
                <span className="text-base text-tinta">
                  Configurar el DNS automáticamente en Cloudflare
                </span>
              </label>
              <p className="mt-1 max-w-[70ch] text-sm text-tinta-2">
                La zona del dominio debe estar en una cuenta conectada (
                {utilizables.map((c) => c.label).join(', ')}). Solo se crean los registros que
                faltan y se completa el SPF existente; si hay registros en conflicto, no se
                modifican y podrá revisarlos en la ficha del dominio.
              </p>
            </div>
          )}

          {error && <AvisoError>{error}</AvisoError>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="plano" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="tinta" busy={create.isPending} disabled={limiteElegido}>
              {hayCloudflare && autoDns ? 'Dar de alta y configurar' : 'Dar de alta'}
            </Button>
          </div>
        </form>
      </Dialogo>
    </>
  );
}
