import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  type ClientDomain,
  type Client,
  type DnsInstruction,
  type WhitelabelStatus,
} from '../lib/api';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import {
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
import { formatDate } from '../lib/format';

const estadoMeta: Record<
  WhitelabelStatus,
  { veredicto: Veredicto; etiqueta: string; pista: string }
> = {
  pending_dns: {
    veredicto: 'vigilar',
    etiqueta: 'Esperando DNS',
    pista: 'Crea el registro que aparece abajo en tu proveedor de dominios.',
  },
  issuing: {
    veredicto: 'vigilar',
    etiqueta: 'Pendiente de HTTPS',
    pista: 'El DNS ya apunta aquí. Falta confirmar que el webmail responde con un certificado válido.',
  },
  active: { veredicto: 'normal', etiqueta: 'En marcha', pista: 'El dominio funciona con HTTPS.' },
  error: { veredicto: 'fuera', etiqueta: 'Con error', pista: '' },
};

/**
 * Dominios propios del cliente: su webmail en su dominio, con certificado
 * automático. El registro que hay que crear se entrega como una muestra
 * exacta para copiar; el estado es el veredicto de la última medición.
 */
export default function MarcaBlanca({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const clientId = isAdmin ? params.get('clientId') || '' : '';
  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: Client[] }>('/api/clients'),
    enabled: isAdmin,
  });
  const [abierto, setAbierto] = useState(false);
  const [hostname, setHostname] = useState('');
  const [nuevo, setNuevo] = useState<{
    domain: ClientDomain;
    instructions: DnsInstruction[];
  } | null>(null);

  const domains = useQuery({
    queryKey: ['whitelabel-domains', clientId],
    queryFn: () => api.get<{ domains: ClientDomain[] }>(
      `/api/whitelabel/domains${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''}`,
    ),
    refetchInterval: 15_000,
  });

  const crear = useMutation({
    mutationFn: () =>
      api.post<{ domain: ClientDomain; instructions: DnsInstruction[] }>(
        '/api/whitelabel/domains',
        { hostname: hostname.trim(), kind: 'webmail', ...(isAdmin ? { clientId } : {}) },
      ),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['whitelabel-domains'] });
      setAbierto(false);
      setHostname('');
      setNuevo(data);
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se pudo añadir el dominio.'),
  });

  if (domains.isLoading) return <Midiendo label="Cargando dominios…" />;

  const lista = domains.data?.domains ?? [];

  return (
    <>
      <Membrete
        title="Webmail personalizado"
        meta="El correo de cada cliente, en su propia dirección."
        actions={
          <Button variant="campo" disabled={isAdmin && !clientId} onClick={() => setAbierto(true)}>
            Añadir dominio
          </Button>
        }
      />

      {isAdmin && (
        <Hoja className="mb-4">
          <Select
            label="Cliente"
            value={clientId}
            onChange={(e) => setParams(e.target.value ? { clientId: e.target.value } : {})}
            help="Selecciona un cliente para configurar su dirección de webmail."
          >
            <option value="">Todos los clientes</option>
            {(clients.data?.clients ?? []).map((client) => (
              <option key={client.id} value={client.id}>{client.name}</option>
            ))}
          </Select>
          {clients.isError && (
            <p role="alert" className="mt-2 text-fuera">
              No se pudieron cargar los clientes.{' '}
              <button onClick={() => void clients.refetch()} className="underline">Reintentar</button>
            </p>
          )}
        </Hoja>
      )}
      <p className="mb-4 text-base text-tinta-2">
        Los accesos desde Inicio y Buzones usan el dominio principal que esté activo.
        Sin elegir uno, se usa el primer dominio activo que añadiste.
        Si no hay ninguno disponible, se usa la dirección general del webmail.
      </p>

      {domains.isError ? (
        <Hoja>
          <p role="alert">No se pudieron cargar los dominios.</p>
          <Button variant="perfil" onClick={() => void domains.refetch()}>Reintentar</Button>
        </Hoja>
      ) : lista.length === 0 ? (
        <Hoja>
          <Vacio title="Todavía no hay dominios propios">
            Por defecto tus clientes entran al webmail por la dirección general del servidor.
            Añade aquí un dominio suyo —por ejemplo{' '}
            <span className="valor">mail.sudominio.com</span>— y entrarán por una dirección
            con su propia marca.
          </Vacio>
        </Hoja>
      ) : (
        <div className="flex flex-col gap-4">
          {lista.map((domain) => (
            <FichaDominio
              key={domain.id}
              domain={domain}
              clientName={isAdmin ? clients.data?.clients.find((c) => c.id === domain.clientId)?.name : undefined}
            />
          ))}
        </div>
      )}

      <Dialogo open={abierto} onClose={() => setAbierto(false)} title="Añadir dominio propio">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            crear.mutate();
          }}
          className="flex flex-col gap-4"
        >
          <Input
            label="Dominio del webmail"
            help="Un subdominio que controles. Ejemplo: mail.sudominio.com"
            mono
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="mail.sudominio.com"
            autoFocus
            required
          />
          <p className="text-base text-tinta-2">
            Después tendrás que crear un registro en tu proveedor de DNS. Te lo damos hecho en el
            paso siguiente.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="plano" onClick={() => setAbierto(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="tinta" busy={crear.isPending}>
              Añadir
            </Button>
          </div>
        </form>
      </Dialogo>

      <Dialogo
        open={nuevo !== null}
        onClose={() => setNuevo(null)}
        title="Crea este registro en tu DNS"
      >
        {nuevo && (
          <div className="flex flex-col gap-4">
            <p className="text-base text-tinta-2">
              Copia este registro en el panel de tu proveedor de dominios. Cuando esté puesto,
              pulsa «Comprobar» en la ficha del dominio.
            </p>
            {nuevo.instructions
              .filter((i) => i.recommended)
              .map((i) => (
                <RegistroDns key={i.type} instruccion={i} />
              ))}
            <Button variant="tinta" onClick={() => setNuevo(null)}>
              Entendido
            </Button>
          </div>
        )}
      </Dialogo>
    </>
  );
}

function RegistroDns({ instruccion }: { instruccion: DnsInstruction }) {
  return (
    <Muestra rotulo={`Registro ${instruccion.type}`} copiar={instruccion.value}>
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-base">
        <dt className="rotulo self-baseline">Nombre</dt>
        {/* Desplazamiento horizontal, nunca partir el valor a mitad de palabra:
            un DNS mal copiado no falla, funciona mal. */}
        <dd className="valor overflow-x-auto whitespace-nowrap text-tinta">{instruccion.name}</dd>
        <dt className="rotulo self-baseline">Valor</dt>
        <dd className="valor overflow-x-auto whitespace-nowrap text-tinta">{instruccion.value}</dd>
      </dl>
      <p className="mt-2 text-sm text-tinta-2">{instruccion.help}</p>
    </Muestra>
  );
}

function FichaDominio({ domain, clientName }: { domain: ClientDomain; clientName?: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const meta = estadoMeta[domain.status];
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['whitelabel-domains'] });
    await queryClient.invalidateQueries({ queryKey: ['client-dashboard'] });
    await queryClient.invalidateQueries({ queryKey: ['whitelabel-domain', domain.id] });
  };

  const principal = useMutation({
    mutationFn: () => api.post(`/api/whitelabel/domains/${domain.id}/primary`),
    onSuccess: async () => {
      await invalidate();
      toast('ok', 'Los accesos de este cliente usarán este dominio.');
    },
    onError: (err) => toast('error', err instanceof ApiError ? err.message : 'No se pudo cambiar el dominio principal.'),
  });

  const detalle = useQuery({
    queryKey: ['whitelabel-domain', domain.id],
    queryFn: () =>
      api.get<{ domain: ClientDomain; instructions: DnsInstruction[] }>(
        `/api/whitelabel/domains/${domain.id}`,
      ),
    // Las instrucciones solo dependen del servidor y del hostname: no cambian
    // mientras la ficha está abierta.
    staleTime: 5 * 60_000,
  });

  const comprobar = useMutation({
    mutationFn: () =>
      api.post<{ domain: ClientDomain }>(`/api/whitelabel/domains/${domain.id}/verify`),
    onSuccess: async (data) => {
      await invalidate();
      if (data.domain.status === 'active') {
        toast('ok', `¡${data.domain.hostname} ya funciona con HTTPS!`);
      } else {
        toast('ok', data.domain.detail || 'Comprobación hecha.');
      }
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se pudo comprobar.'),
  });

  const borrar = useMutation({
    mutationFn: () => api.delete(`/api/whitelabel/domains/${domain.id}`),
    onSuccess: async () => {
      await invalidate();
      toast('ok', 'Dominio eliminado.');
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se pudo eliminar.'),
  });

  const instrucciones = detalle.data?.instructions ?? [];

  return (
    <Hoja>
      {/* El dominio en su propia línea: en móvil es lo que identifica la ficha
          y no puede quedar comprimido por las acciones. */}
      <div className="regla-cabecera mb-3 flex flex-col gap-3 pb-3 sm:flex-row sm:items-baseline sm:justify-between">
        <div className="min-w-0">
          {clientName && <p className="mb-1 text-sm text-tinta-2">{clientName}</p>}
          <span className="valor break-words text-md text-tinta">{domain.hostname}</span>
          {domain.isPrimary && <p className="mt-1 text-sm text-tinta-2">Dirección principal del cliente</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <MarcaFondo veredicto={meta.veredicto}>{meta.etiqueta}</MarcaFondo>
          {domain.kind === 'webmail' && domain.status === 'active' && !domain.isPrimary && (
            <Button variant="perfil" busy={principal.isPending} onClick={() => principal.mutate()}>
              Usar como principal
            </Button>
          )}
          <Button variant="perfil" busy={comprobar.isPending} onClick={() => comprobar.mutate()}>
            Comprobar
          </Button>
          <Button
            variant="plano"
            onClick={() => {
              if (confirm(`¿Eliminar ${domain.hostname}? Dejará de funcionar en unos segundos.`)) {
                borrar.mutate();
              }
            }}
          >
            Eliminar
          </Button>
        </div>
      </div>

      <p className="text-base text-tinta-2">{domain.detail || meta.pista}</p>

      {domain.status === 'active' ? (
        <p className="mt-2 text-base text-tinta-2">
          Tus clientes ya pueden entrar en{' '}
          <a
            href={`https://${domain.hostname}`}
            target="_blank"
            rel="noreferrer"
            className="valor text-laboratorio underline underline-offset-2"
          >
            https://{domain.hostname}
          </a>
          {domain.activatedAt && (
            <span className="text-tinta-3"> · activo desde {formatDate(domain.activatedAt)}</span>
          )}
        </p>
      ) : (
        instrucciones.length > 0 && (
          <div className="mt-3 flex flex-col gap-3">
            {instrucciones.map((i) => (
              <RegistroDns key={i.type} instruccion={i} />
            ))}
          </div>
        )
      )}
    </Hoja>
  );
}
