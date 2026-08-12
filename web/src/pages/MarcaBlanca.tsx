import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  type ClientDomain,
  type DnsInstruction,
  type WhitelabelStatus,
} from '../lib/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';
import {
  Barcode,
  BotonCopiar,
  Cargando,
  Dialogo,
  Encabezado,
  Estado,
  Etiqueta,
  Panel,
  Sello,
  Vacio,
} from '../ui/kit';
import { useToast } from '../ui/toast';
import { formatDate } from '../lib/format';

const statusMeta: Record<
  WhitelabelStatus,
  { tone: 'entregado' | 'transito' | 'devuelto' | 'neutro'; label: string; hint: string }
> = {
  pending_dns: {
    tone: 'transito',
    label: 'Esperando DNS',
    hint: 'Crea el registro que aparece abajo en tu proveedor de dominios.',
  },
  issuing: {
    tone: 'transito',
    label: 'Emitiendo certificado',
    hint: 'El DNS ya apunta aquí. Let\'s Encrypt suele tardar menos de un minuto.',
  },
  active: {
    tone: 'entregado',
    label: 'En marcha',
    hint: 'El dominio funciona con HTTPS.',
  },
  error: { tone: 'devuelto', label: 'Con error', hint: '' },
};

/**
 * Dominios propios del cliente (marca blanca): su webmail en su dominio.
 * Mismo mundo que la aduana del dominio de correo — el registro que hay que
 * crear se imprime en etiqueta y el estado queda sellado.
 */
export default function MarcaBlanca() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [hostname, setHostname] = useState('');
  const [nuevo, setNuevo] = useState<{
    domain: ClientDomain;
    instructions: DnsInstruction[];
  } | null>(null);

  const domains = useQuery({
    queryKey: ['whitelabel-domains'],
    queryFn: () => api.get<{ domains: ClientDomain[] }>('/api/whitelabel/domains'),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ domain: ClientDomain; instructions: DnsInstruction[] }>(
        '/api/whitelabel/domains',
        { hostname: hostname.trim(), kind: 'webmail' },
      ),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['whitelabel-domains'] });
      setOpen(false);
      setHostname('');
      setNuevo(data);
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se pudo añadir el dominio.'),
  });

  if (domains.isLoading) return <Cargando label="Cargando dominios…" />;

  const list = domains.data?.domains ?? [];

  return (
    <>
      <Encabezado
        title="Marca blanca"
        meta="Sirve el webmail en el dominio de tu cliente, con su propio certificado."
        actions={
          <Button variant="accion" onClick={() => setOpen(true)}>
            Añadir dominio
          </Button>
        }
      />

      {list.length === 0 ? (
        <Panel>
          <Vacio
            title="Todavía no hay dominios propios"
            action={
              <Button variant="accion" onClick={() => setOpen(true)}>
                Añadir dominio
              </Button>
            }
          >
            Por defecto tus clientes entran al webmail por la dirección general del servidor.
            Añade aquí un dominio suyo —por ejemplo <span className="font-guia">webmail.suempresa.com</span>—
            y entrarán por una dirección con su propia marca.
          </Vacio>
        </Panel>
      ) : (
        <div className="flex flex-col gap-3">
          {list.map((domain) => (
            <TarjetaDominio key={domain.id} domain={domain} />
          ))}
        </div>
      )}

      <Dialogo open={open} onClose={() => setOpen(false)} title="Añadir dominio propio">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          className="flex flex-col gap-4"
        >
          <Input
            label="Dominio del webmail"
            help="Un subdominio que controles. Ejemplo: webmail.suempresa.com"
            mono
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="webmail.suempresa.com"
            autoFocus
            required
          />
          <p className="text-sm text-tinta-2">
            Después tendrás que crear un registro en tu proveedor de DNS. Te lo damos hecho en el
            paso siguiente.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="fantasma" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="accion" busy={create.isPending}>
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
            <p className="text-sm text-tinta-2">
              Copia este registro en el panel de tu proveedor de dominios. Cuando esté puesto,
              pulsa «Comprobar» en la tarjeta del dominio.
            </p>
            {nuevo.instructions
              .filter((i) => i.recommended)
              .map((i) => (
                <InstruccionDns key={i.type} instruction={i} />
              ))}
            <Button variant="accion" onClick={() => setNuevo(null)}>
              Entendido
            </Button>
          </div>
        )}
      </Dialogo>
    </>
  );
}

function InstruccionDns({ instruction }: { instruction: DnsInstruction }) {
  return (
    <Etiqueta className="p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-rotulo text-sm font-semibold uppercase tracking-wide opacity-70">
            Registro {instruction.type}
          </div>
          <dl className="mt-1.5 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="opacity-60">Nombre</dt>
            <dd className="font-guia break-all">{instruction.name}</dd>
            <dt className="opacity-60">Valor</dt>
            <dd className="font-guia break-all">{instruction.value}</dd>
          </dl>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <BotonCopiar text={instruction.value} label="Copiar" />
          {/* El código de barras identifica la etiqueta, pero en móvil roba
              ancho al dato que hay que copiar: ahí no aporta. */}
          <Barcode
            seed={instruction.name}
            className="hidden text-[rgb(var(--etiqueta-tinta))] sm:flex"
          />
        </div>
      </div>
      <p className="mt-2 border-t border-[rgb(var(--etiqueta-borde))] pt-2 text-sm opacity-70">
        {instruction.help}
      </p>
    </Etiqueta>
  );
}

function TarjetaDominio({ domain }: { domain: ClientDomain }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const meta = statusMeta[domain.status];

  const detail = useQuery({
    queryKey: ['whitelabel-domain', domain.id],
    queryFn: () =>
      api.get<{ domain: ClientDomain; instructions: DnsInstruction[] }>(
        `/api/whitelabel/domains/${domain.id}`,
      ),
  });

  const verify = useMutation({
    mutationFn: () =>
      api.post<{ domain: ClientDomain }>(`/api/whitelabel/domains/${domain.id}/verify`),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['whitelabel-domains'] });
      await queryClient.invalidateQueries({ queryKey: ['whitelabel-domain', domain.id] });
      if (data.domain.status === 'active') {
        toast('ok', `¡${data.domain.hostname} ya funciona con HTTPS!`);
      } else {
        toast('ok', data.domain.detail || 'Comprobación hecha.');
      }
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se pudo comprobar.'),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/whitelabel/domains/${domain.id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['whitelabel-domains'] });
      toast('ok', 'Dominio eliminado.');
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se pudo eliminar.'),
  });

  const instructions = detail.data?.instructions ?? [];

  return (
    <Panel>
      {/* Cabecera propia (no la de Panel) para que en móvil el dominio tenga
          su propia línea: con title/actions en una fila el nombre se colapsa
          a cero y la tarjeta deja de identificar de qué dominio habla. */}
      <div className="mb-3 flex flex-col gap-3 border-b border-suave pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Barcode seed={domain.hostname} className="hidden shrink-0 text-tinta-3 sm:flex" />
          <span className="truncate font-guia text-md text-tinta">{domain.hostname}</span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {domain.status === 'active' ? (
            <Sello tone="entregado">En marcha</Sello>
          ) : (
            <Estado tone={meta.tone}>{meta.label}</Estado>
          )}
          {domain.status !== 'active' && (
            <Button variant="chasis" busy={verify.isPending} onClick={() => verify.mutate()}>
              Comprobar
            </Button>
          )}
          <Button
            variant="fantasma"
            onClick={() => {
              if (confirm(`¿Eliminar ${domain.hostname}? Dejará de funcionar en unos segundos.`)) {
                remove.mutate();
              }
            }}
          >
            Eliminar
          </Button>
        </div>
      </div>

      <p className="text-sm text-tinta-2">{domain.detail || meta.hint}</p>

      {domain.status === 'active' ? (
        <p className="mt-3 text-sm text-tinta-2">
          Tus clientes ya pueden entrar en{' '}
          <a
            href={`https://${domain.hostname}`}
            target="_blank"
            rel="noreferrer"
            className="font-guia text-accion underline underline-offset-2"
          >
            https://{domain.hostname}
          </a>
          {domain.activatedAt && (
            <span className="text-tinta-3"> · activo desde {formatDate(domain.activatedAt)}</span>
          )}
        </p>
      ) : (
        instructions.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {instructions.map((i) => (
              <InstruccionDns key={i.type} instruction={i} />
            ))}
          </div>
        )
      )}
    </Panel>
  );
}
