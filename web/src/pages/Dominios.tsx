import { useId, useState, type FormEvent } from 'react';
import { Globe } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, type Client } from '../lib/api';
import {
  avisoAltaDominio,
  cuentasUtilizables,
  invalidarTrasAltaOBaja,
  lecturaDominio,
  nombreVisible,
  propiedadPendiente,
  type CuentaCloudflare,
  type DominioCorreo,
  type EstadoAltaDominio,
  type RespuestaAltaDominio,
} from '../lib/cloudflare';
import { sugerenciaSinWww } from '../lib/dominios';
import { dominiosQueCuentan, etiquetaMigracion } from '../lib/cambioDominio';
import { formatDate, plural } from '../lib/format';
import { useAltaDesdeEnlace, useClientes, useUsuario } from '../components/gestion/consultas';
import { BandaAviso } from '../components/cloudflare/comun';
import { CabeceraVista, rutaCliente } from '../components/gestion/comun';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import { AvisoError, Dialogo, Hoja, MarcaFondo, Cargando, Vacio, type Veredicto } from '../ui/kit';
import { useToast } from '../ui/toast';

/**
 * Registro de dominios: una fila por dominio medido. El dominio es el dato que
 * identifica la fila, así que en pantalla estrecha ocupa línea propia y se
 * parte si hace falta; nunca se recorta ni obliga a desplazar en horizontal.
 */

/** Fuera de rango primero; después, lo que vigilar, sin dato y, al final, lo activo. */
const ordenVeredicto: Record<Veredicto, number> = { fuera: 0, vigilar: 1, 'sin-dato': 2, normal: 3 };

/**
 * `clienteFijo`: la misma vista dentro de la ficha de un cliente (pestaña
 * «Dominios»): solo sus dominios, el alta ya a su nombre y una cabecera
 * compacta bajo la del cliente.
 */
export default function Dominios({ isAdmin, clienteFijo }: { isAdmin: boolean; clienteFijo?: string }) {
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
  // El servidor pregunta antes de dar de alta www.<dominio> (domain_www).
  const [avisoWww, setAvisoWww] = useState<{ mensaje: string; sugerido: string | null } | null>(null);

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

  // El dominio anterior de un cambio de dominio abierto no cuenta en el plan
  // (el uso del cliente sí lo incluye): se descuenta como hace el servidor.
  const usadosEnPlan = (cliente: { id: string; usage: { domains: number } }) =>
    dominiosQueCuentan(
      cliente.usage.domains,
      (domains.data?.domains ?? []).filter((d) => d.clientId === cliente.id),
    );

  // Límite del plan: un cliente (o el administrador en la ficha de uno) lo
  // ve antes de rellenar nada; en la lista de todos, al elegir el cliente en
  // el formulario.
  const clienteContexto = clienteFijo
    ? clientes.get(clienteFijo)
    : !isAdmin
      ? [...clientes.values()][0]
      : undefined;
  const usadosContexto = clienteContexto ? usadosEnPlan(clienteContexto) : 0;
  const limiteContexto = clienteContexto ? usadosContexto >= clienteContexto.plan.maxDomains : false;
  const altaVetada = limiteContexto || Boolean(clienteContexto?.suspended);
  const verCliente = isAdmin && !clienteFijo;
  const elegido = isAdmin && clientId ? clientes.get(clientId) : undefined;
  const limiteElegido = elegido ? usadosEnPlan(elegido) >= elegido.plan.maxDomains : false;

  const create = useMutation({
    mutationFn: (confirmWww: boolean) =>
      api.post<RespuestaAltaDominio>('/api/domains', {
        domain: domainName,
        clientId: isAdmin ? clientId : undefined,
        ...(hayCloudflare && autoDns ? { autoDns: true } : {}),
        ...(confirmWww ? { confirmWww: true } : {}),
      }),
    onSuccess: async (data) => {
      await invalidarTrasAltaOBaja(queryClient, data.domain.clientId);
      setOpen(false);
      const pedido = hayCloudflare && autoDns;
      const aviso = avisoAltaDominio(data, pedido);
      toast(aviso.tono, aviso.texto);
      const alta: EstadoAltaDominio = {
        autoDns: pedido,
        cloudflare: data.cloudflare ?? null,
        ...(data.cloudflareReason ? { cloudflareReason: data.cloudflareReason } : {}),
      };
      navigate(`/dominios/${data.domain.id}`, { state: { alta } });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'domain_www') {
        setAvisoWww({ mensaje: err.message, sugerido: sugerenciaSinWww(domainName) });
        return;
      }
      setError(err instanceof ApiError ? err.message : 'No se ha podido dar de alta.');
    },
  });

  function abrir() {
    // Cada alta empieza de cero: un cliente elegido antes no debe arrastrarse.
    setDomainName('');
    setClientId(clienteFijo ?? '');
    setAutoDns(true);
    setError('');
    setAvisoWww(null);
    create.reset();
    setOpen(true);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setAvisoWww(null);
    create.mutate(false);
  }

  // «Añadir dominio» del resumen: con el plan lleno o la cuenta suspendida el
  // botón está desactivado, y el atajo tampoco abre el alta.
  useAltaDesdeEnlace(() => {
    if (!altaVetada) abrir();
  }, !domains.isPending);

  const list = (domains.data?.domains ?? [])
    .filter((d) => !clienteFijo || d.clientId === clienteFijo)
    .sort((a, b) => ordenVeredicto[lecturaDominio(a).veredicto] - ordenVeredicto[lecturaDominio(b).veredicto]);
  const activos = list.filter((d) => d.status === 'active').length;
  const nombreCliente = new Map((clients.data?.clients ?? []).map((c) => [c.id, c.name]));

  const recuento =
    !domains.isPending && (clienteContexto || list.length > 0)
      ? clienteContexto
        ? `${usadosContexto} de ${clienteContexto.plan.maxDomains} dominios del plan · ${activos} de ${list.length} activos`
        : `${activos} de ${list.length} activos`
      : null;

  return (
    <>
      <CabeceraVista
        title="Dominios"
        enPestana={Boolean(clienteFijo)}
        meta={
          clienteFijo ? (
            <>
              {recuento && <span className="valor block">{recuento}</span>}
              <span className="block text-sm text-tinta-3">
                Un dominio envía y recibe correo cuando sus registros DNS coinciden con los de su ficha.
              </span>
            </>
          ) : (
            <>
              {isAdmin && 'Dominios de todos los clientes. '}
              Un dominio no puede enviar ni recibir correo hasta que sus registros DNS coinciden con los
              valores que se indican en su ficha.
              {recuento && <span className="valor mt-1 block text-sm text-tinta-3">{recuento}</span>}
            </>
          )
        }
        actions={
          <Button variant="principal" onClick={abrir} disabled={altaVetada}>
            Añadir dominio
          </Button>
        }
      />

      {/* La administración ya ve la suspensión en la cabecera de la ficha del cliente. */}
      {!isAdmin && clienteContexto?.suspended && (
        <div className="mb-4">
          <BandaAviso titulo="Servicio suspendido">
            Mientras el servicio esté suspendido no se pueden añadir dominios. Ponte en contacto con el
            administrador.
          </BandaAviso>
        </div>
      )}

      {limiteContexto && clienteContexto && !clienteContexto.suspended && (
        <div className="mb-4">
          <BandaAviso titulo="Límite del plan">
            Se ha alcanzado el máximo de dominios del plan ({plural(clienteContexto.plan.maxDomains, 'dominio', 'dominios')}).
            {isAdmin
              ? ' Para añadir otro, elimina alguno o cambia el plan del cliente en «Resumen».'
              : ' Para añadir otro, elimina alguno o solicita una ampliación del plan.'}
          </BandaAviso>
        </div>
      )}

      {domains.isPending ? (
        <Hoja>
          <Cargando label="Cargando los dominios…" />
        </Hoja>
      ) : domains.isError ? (
        <AvisoError onRetry={() => void domains.refetch()} retrying={domains.isFetching}>
          No se ha podido cargar la lista de dominios.
        </AvisoError>
      ) : list.length === 0 ? (
        <Hoja>
          <Vacio icono={Globe}
            title="Todavía no hay dominios"
            action={
              <Button variant="perfil" onClick={abrir} disabled={altaVetada}>
                Añadir el primero
              </Button>
            }
          >
            {clienteFijo
              ? 'Da de alta un dominio del cliente (por ejemplo, suempresa.com) para crear buzones con esa dirección.'
              : 'Da de alta un dominio (por ejemplo, miempresa.com) para crear buzones con esa dirección.'}
          </Vacio>
        </Hoja>
      ) : (
        <Hoja flush>
          {/* Cabecera de columnas: en móvil cada valor lleva su propio rótulo. */}
          <div className="regla-cabecera hidden items-baseline gap-x-4 bg-hoja-3 px-4 py-1.5 sm:flex">
            <span className="rotulo min-w-0 flex-1">Dominio</span>
            {verCliente && <span className="rotulo shrink-0 basis-40">Cliente</span>}
            <span className="rotulo shrink-0 basis-24">Obligatorios</span>
            <span className="rotulo shrink-0 basis-32">Comprobado</span>
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
                      className="valor break-all text-base text-tinta hover:text-petroleo hover:underline"
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
                    {domain.migracion && (
                      <span className="block text-sm text-tinta-2 [overflow-wrap:anywhere]">
                        {etiquetaMigracion(domain.migracion, isAdmin)}
                      </span>
                    )}
                  </span>

                  {verCliente && (
                    <span className="min-w-0 shrink-0 sm:basis-40">
                      <span className="rotulo mr-1.5 sm:hidden">Cliente</span>
                      {/* A los dominios de su ficha: se sigue en la misma tarea, con su contexto. */}
                      <Link
                        to={rutaCliente(domain.clientId, 'dominios')}
                        className="break-words text-sm text-tinta-2 hover:text-petroleo hover:underline"
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
                    <span className="rotulo mr-1.5 sm:hidden">Comprobado</span>
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
          {verCliente && (
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
              <option value="">Selecciona un cliente…</option>
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
              {plural(elegido.plan.maxDomains, 'dominio', 'dominios')}). Para añadir otro, cambia el plan del
              cliente desde su ficha o elimina alguno de sus dominios.
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
              setAvisoWww(null);
            }}
            placeholder="miempresa.com"
            autoComplete="off"
            help="Sin «http://» ni rutas. Se admiten dominios con «ñ» y acentos. Es necesario poder editar su DNS en el proveedor (Cloudflare, IONOS…)."
          />

          {hayCloudflare && (
            <div className="rounded-lg border border-regla bg-hoja-2 px-3 py-2.5">
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
                faltan: lo que ya existe (también un SPF que habría que completar) no se
                modifica y podrás revisarlo y aplicarlo en la ficha del dominio. Si el correo del
                dominio llega hoy a otro proveedor, tampoco se crean el SPF ni el DMARC: se crean
                junto con el MX cuando hagas el cambio desde la ficha.
              </p>
            </div>
          )}

          {avisoWww && (
            <BandaAviso titulo="Revisa el dominio">
              <p>{avisoWww.mensaje}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {avisoWww.sugerido && (
                  <Button
                    type="button"
                    variant="perfil"
                    onClick={() => {
                      setDomainName(avisoWww.sugerido!);
                      setAvisoWww(null);
                    }}
                  >
                    Usar {avisoWww.sugerido}
                  </Button>
                )}
                <Button type="button" variant="plano" busy={create.isPending} onClick={() => create.mutate(true)}>
                  Mantener el subdominio www
                </Button>
              </div>
            </BandaAviso>
          )}
          {error && <AvisoError>{error}</AvisoError>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="plano" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="principal" busy={create.isPending} disabled={limiteElegido}>
              {hayCloudflare && autoDns ? 'Dar de alta y configurar' : 'Dar de alta'}
            </Button>
          </div>
        </form>
      </Dialogo>
    </>
  );
}
