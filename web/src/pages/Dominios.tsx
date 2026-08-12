import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError, type Client, type DomainRecord } from '../lib/api';
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
 * identifica la fila, así que en pantalla estrecha ocupa línea propia y nunca
 * se recorta.
 */
function lectura(domain: DomainRecord): { veredicto: Veredicto; etiqueta: string } {
  if (domain.status === 'active') return { veredicto: 'normal', etiqueta: 'En reparto' };
  if (!domain.lastCheckedAt) return { veredicto: 'sin-dato', etiqueta: 'Sin medir' };
  return { veredicto: 'fuera', etiqueta: 'DNS pendiente' };
}

export default function Dominios({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [domainName, setDomainName] = useState('');
  const [clientId, setClientId] = useState('');
  const [error, setError] = useState('');

  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ domains: DomainRecord[] }>('/api/domains'),
  });
  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: Client[] }>('/api/clients'),
    enabled: isAdmin,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ domain: DomainRecord }>('/api/domains', {
        domain: domainName,
        clientId: isAdmin ? clientId : undefined,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['domains'] });
      setOpen(false);
      setDomainName('');
      setError('');
      toast('ok', 'Dominio dado de alta. Ahora configura su DNS.');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'No se pudo crear.'),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  const list = domains.data?.domains ?? [];
  const enRango = list.filter((d) => d.status === 'active').length;

  return (
    <>
      <Membrete
        title="Dominios"
        meta={
          <>
            Un dominio no entra en reparto hasta que sus registros DNS coinciden con los de
            referencia.
            {list.length > 0 && (
              <span className="valor mt-1 block text-sm text-tinta-3">
                {enRango}/{list.length} en reparto
              </span>
            )}
          </>
        }
        actions={
          <Button variant="tinta" onClick={() => setOpen(true)}>
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
          <p role="alert" className="text-base text-fuera">
            No se pudo leer el registro de dominios. Recarga la página para repetir la lectura.
          </p>
        </Hoja>
      ) : list.length === 0 ? (
        <Hoja>
          <Vacio
            title="Aún no hay dominios"
            action={
              <Button variant="perfil" onClick={() => setOpen(true)}>
                Añadir el primero
              </Button>
            }
          >
            Da de alta un dominio (por ejemplo, miempresa.com) para empezar a crear buzones
            con esa dirección.
          </Vacio>
        </Hoja>
      ) : (
        <Hoja flush>
          {/* Cabecera de columnas: en móvil cada valor lleva su propio rótulo. */}
          <div className="regla-cabecera hidden items-baseline gap-x-4 bg-hoja-3 px-4 py-1.5 sm:flex">
            <span className="rotulo min-w-0 flex-1">Dominio</span>
            <span className="rotulo shrink-0 basis-24">Obligatorios</span>
            <span className="rotulo shrink-0 basis-32">Última medición</span>
            <span className="rotulo shrink-0 basis-28 text-right">Veredicto</span>
          </div>

          <ul>
            {list.map((domain) => {
              const requiredOk = domain.dnsStatus.requiredOk ?? 0;
              const requiredTotal = domain.dnsStatus.requiredTotal ?? 0;
              const { veredicto, etiqueta } = lectura(domain);
              return (
                <li
                  key={domain.id}
                  className="regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-1.5 px-4
                    py-2.5 transition-colors duration-100 last:border-b-0 hover:bg-hoja-2"
                >
                  <Link
                    to={`/dominios/${domain.id}`}
                    className="valor block min-w-0 basis-full overflow-x-auto whitespace-nowrap
                      text-base text-tinta hover:text-laboratorio hover:underline
                      [scrollbar-width:none] sm:basis-0 sm:grow [&::-webkit-scrollbar]:hidden"
                  >
                    {domain.domain}
                  </Link>

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
            >
              <option value="">Elige un cliente…</option>
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
            help="Sin «http://» ni «www». Debes poder editar su DNS en tu proveedor (Cloudflare, IONOS…)."
          />
          {error && (
            <p
              role="alert"
              className="border border-[rgb(var(--fuera)/0.4)] bg-fuera-fondo px-3 py-2 text-sm text-fuera"
            >
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="plano" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="tinta" busy={create.isPending}>
              Dar de alta
            </Button>
          </div>
        </form>
      </Dialogo>
    </>
  );
}
