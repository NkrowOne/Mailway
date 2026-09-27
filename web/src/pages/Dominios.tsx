import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, type Client } from '../lib/api';
import {
  cuentasUtilizables,
  nombreVisible,
  type CuentaCloudflare,
  type DominioCorreo,
  type EstadoAltaDominio,
  type ResultadoAplicacion,
} from '../lib/cloudflare';
import { BandaError } from '../components/cloudflare/comun';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import {
  Dialogo,
  Hoja,
  MarcaFondo,
  Membrete,
  Midiendo,
  Vacio,
  type Veredicto,
} from '../ui/kit';
import { useToast } from '../ui/toast';
import { formatDate } from '../lib/format';

/**
 * Registro de dominios: una fila por dominio medido. El dominio es el dato que
 * identifica la fila, así que en pantalla estrecha ocupa línea propia y se
 * parte si hace falta; nunca se recorta ni obliga a desplazar en horizontal.
 */
function lectura(domain: DominioCorreo): { veredicto: Veredicto; etiqueta: string } {
  if (domain.status === 'active') return { veredicto: 'normal', etiqueta: 'En reparto' };
  if (!domain.lastCheckedAt) return { veredicto: 'sin-dato', etiqueta: 'Sin medir' };
  return { veredicto: 'fuera', etiqueta: 'DNS pendiente' };
}

/** Fuera de rango primero; después, sin medir y, al final, lo que está en reparto. */
const ordenVeredicto: Record<Veredicto, number> = { fuera: 0, vigilar: 1, 'sin-dato': 2, normal: 3 };

interface RespuestaAlta {
  domain: DominioCorreo;
  cloudflare: ResultadoAplicacion | null;
  cloudflareReason?: string;
}

export default function Dominios({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const idCasilla = useId();
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

  const create = useMutation({
    mutationFn: () =>
      api.post<RespuestaAlta>('/api/domains', {
        domain: domainName,
        clientId: isAdmin ? clientId : undefined,
        ...(hayCloudflare && autoDns ? { autoDns: true } : {}),
      }),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['domains'] });
      void queryClient.invalidateQueries({ queryKey: ['client-dashboard'] });
      setOpen(false);
      const pedido = hayCloudflare && autoDns;
      if (pedido && data.cloudflare && data.cloudflare.applied.length > 0) {
        toast('ok', 'Dominio dado de alta y DNS aplicado en Cloudflare.');
      } else if (pedido && data.cloudflare?.errors.length) {
        toast('error', 'Dominio dado de alta, pero no se ha podido aplicar el DNS en Cloudflare.');
      } else {
        toast('ok', 'Dominio dado de alta. Configure ahora su DNS.');
      }
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
    (a, b) => ordenVeredicto[lectura(a).veredicto] - ordenVeredicto[lectura(b).veredicto],
  );
  const enRango = list.filter((d) => d.status === 'active').length;
  const nombreCliente = new Map((clients.data?.clients ?? []).map((c) => [c.id, c.name]));

  return (
    <>
      <Membrete
        title="Dominios"
        meta={
          <>
            Un dominio no entra en reparto hasta que sus registros DNS coinciden con los de
            referencia.
            {list.length > 0 && (
              <span className="valor mt-1 block text-sm text-white/70">
                {enRango}/{list.length} en reparto
              </span>
            )}
          </>
        }
        actions={
          <Button variant="campo" onClick={abrir}>
            Añadir dominio
          </Button>
        }
      />

      {domains.isPending ? (
        <Hoja>
          <Midiendo label="Leyendo el registro de dominios…" />
        </Hoja>
      ) : domains.isError ? (
        <Hoja>
          <BandaError>
            No se ha podido leer el registro de dominios. Recargue la página para repetir la
            lectura.
          </BandaError>
        </Hoja>
      ) : list.length === 0 ? (
        <Hoja>
          <Vacio
            title="Todavía no hay dominios"
            action={
              <Button variant="perfil" onClick={abrir}>
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
              const { veredicto, etiqueta } = lectura(domain);
              const visible = nombreVisible(domain);
              return (
                <li
                  key={domain.id}
                  className={`regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-1.5 px-4 py-2.5
                    transition-colors duration-100 last:border-b-0 hover:bg-hoja-2
                    ${veredicto === 'fuera' ? 'fila-fuera' : ''}`}
                >
                  <span className="min-w-0 basis-full sm:basis-0 sm:grow">
                    <Link
                      to={`/dominios/${domain.id}`}
                      className="valor break-all text-base text-tinta hover:text-laboratorio hover:underline"
                    >
                      {visible}
                    </Link>
                    {domain.cloudflare && <span className="rotulo ml-2 whitespace-nowrap">Cloudflare</span>}
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
              onChange={(e) => setClientId(e.target.value)}
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
          <Input
            label="Dominio"
            required
            mono
            value={domainName}
            onChange={(e) => setDomainName(e.target.value)}
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

          {error && <BandaError>{error}</BandaError>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="plano" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="tinta" busy={create.isPending}>
              {hayCloudflare && autoDns ? 'Dar de alta y configurar' : 'Dar de alta'}
            </Button>
          </div>
        </form>
      </Dialogo>
    </>
  );
}
