import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Alias, type DomainRecord, type Mailbox } from '../lib/api';
import { plural } from '../lib/format';
import {
  formatBytes,
  formatQuota,
  mensajeDe,
  ordenVeredicto,
  veredictoUso,
  type BulkResponse,
} from '../lib/gestion';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import { Dialogo, Hoja, MarcaFondo, Membrete, Midiendo, Vacio } from '../ui/kit';
import { AltaMasiva } from '../components/gestion/AltaMasiva';
import { BandaAviso, BandaError, Botonera, Opcion } from '../components/gestion/comun';
import { useClientes, useUsuario } from '../components/gestion/consultas';
import { FichaBuzon, type VistaFicha } from '../components/gestion/FichaBuzon';

interface FichaAbierta {
  id: string;
  vista: VistaFicha;
  password?: string;
  /** Copia del buzón por si la lista aún no lo incluye (recién creado). */
  mailbox: Mailbox;
  n: number;
}

/**
 * Registro de buzones: tabla reglada agrupada por dominio, con búsqueda y
 * filtros (cliente y dominio, en la URL para poder enlazarlos), ocupación
 * medida contra la cuota y una ficha por buzón con todas sus acciones.
 */
export default function Buzones() {
  const queryClient = useQueryClient();
  const user = useUsuario();
  const isAdmin = user?.role === 'admin';
  const { clientes } = useClientes(user);
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const filtroCliente = isAdmin ? (params.get('cliente') ?? '') : '';
  const filtroDominio = params.get('dominio') ?? '';

  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ domains: DomainRecord[] }>('/api/domains'),
  });
  const mailboxes = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => api.get<{ mailboxes: Mailbox[] }>('/api/mailboxes'),
  });
  const aliases = useQuery({
    queryKey: ['aliases'],
    queryFn: () => api.get<{ aliases: Alias[] }>('/api/aliases'),
  });

  const [ficha, setFicha] = useState<FichaAbierta | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [altaOpen, setAltaOpen] = useState(false);
  const [altaResultado, setAltaResultado] = useState<{ dominio: string; respuesta: BulkResponse } | null>(null);

  function setFiltro(clave: 'q' | 'cliente' | 'dominio', valor: string) {
    const next = new URLSearchParams(params);
    if (valor) next.set(clave, valor);
    else next.delete(clave);
    // Al cambiar de cliente, el dominio elegido puede no ser suyo.
    if (clave === 'cliente') next.delete('dominio');
    setParams(next, { replace: true });
  }

  function abrirFicha(mailbox: Mailbox, vista: VistaFicha = 'resumen', password?: string) {
    setFicha((prev) => ({ id: mailbox.id, vista, password, mailbox, n: (prev?.n ?? 0) + 1 }));
  }

  const domainList = useMemo(() => domains.data?.domains ?? [], [domains.data]);
  const all = useMemo(() => mailboxes.data?.mailboxes ?? [], [mailboxes.data]);

  const dominiosVisibles = useMemo(
    () => (filtroCliente ? domainList.filter((d) => d.clientId === filtroCliente) : domainList),
    [domainList, filtroCliente],
  );

  const filtrados = useMemo(() => {
    const texto = q.trim().toLowerCase();
    return all.filter(
      (m) =>
        (!filtroCliente || m.clientId === filtroCliente) &&
        (!filtroDominio || m.domainId === filtroDominio) &&
        (!texto || m.email.toLowerCase().includes(texto) || m.displayName.toLowerCase().includes(texto)),
    );
  }, [all, q, filtroCliente, filtroDominio]);

  // Por dominio y, dentro de cada uno, «fuera de rango primero» (DESIGN.md).
  const grouped = useMemo(() => {
    const groups = new Map<string, Mailbox[]>();
    for (const mailbox of filtrados) {
      const group = groups.get(mailbox.domain) || [];
      group.push(mailbox);
      groups.set(mailbox.domain, group);
    }
    for (const group of groups.values()) {
      group.sort(
        (a, b) =>
          ordenVeredicto[veredictoUso(a.usedBytes, a.quotaMb)] - ordenVeredicto[veredictoUso(b.usedBytes, b.quotaMb)] ||
          a.localPart.localeCompare(b.localPart),
      );
    }
    return [...groups.entries()];
  }, [filtrados]);

  const etiquetaDominio = (d: DomainRecord) => {
    const cliente = isAdmin ? clientes.get(d.clientId)?.name : undefined;
    return cliente ? `${d.domain} · ${cliente}` : d.domain;
  };

  const fichaMailbox = ficha ? (all.find((m) => m.id === ficha.id) ?? ficha.mailbox) : null;
  const fichaCliente = fichaMailbox?.clientId ? clientes.get(fichaMailbox.clientId) : undefined;
  const clientePropio = !isAdmin ? [...clientes.values()][0] : undefined;
  const hayFiltros = Boolean(q || filtroCliente || filtroDominio);
  const cargando = mailboxes.isPending || domains.isPending;

  return (
    <>
      <Membrete
        title="Buzones"
        meta={
          <>
            <p>Cuentas de correo con IMAP, SMTP y webmail. Cada buzón tiene su propia contraseña y cuota.</p>
            {!cargando && all.length > 0 && (
              <p className="rotulo mt-1.5 text-white/70">
                {plural(all.length, 'buzón', 'buzones')}
                {clientePropio && ` de ${clientePropio.plan.maxMailboxes} del plan`} ·{' '}
                {plural(new Set(all.map((m) => m.domainId)).size, 'dominio', 'dominios')}
              </p>
            )}
          </>
        }
        actions={
          <Button variant="campo" onClick={() => setCreateOpen(true)} disabled={domainList.length === 0}>
            Crear buzón
          </Button>
        }
      />

      {altaResultado && !altaOpen && (
        <div className="mb-4">
          <BandaAviso>
            Hay credenciales del último alta masiva sin confirmar.{' '}
            <button type="button" className="underline" onClick={() => setAltaOpen(true)}>
              Ver las credenciales
            </button>
          </BandaAviso>
        </div>
      )}
      {clientePropio?.suspended && (
        <div className="mb-4">
          <BandaError>
            La cuenta está suspendida: sus buzones no pueden iniciar sesión y no es posible crear buzones
            nuevos. Póngase en contacto con su proveedor.
          </BandaError>
        </div>
      )}

      {cargando ? (
        <Hoja flush>
          <Midiendo label="Midiendo buzones…" />
        </Hoja>
      ) : mailboxes.isError || domains.isError ? (
        <BandaError
          onRetry={() => {
            void mailboxes.refetch();
            void domains.refetch();
          }}
        >
          {mensajeDe(mailboxes.error ?? domains.error, 'No se han podido cargar los buzones.')} Compruebe la
          conexión y vuelva a intentarlo.
        </BandaError>
      ) : domainList.length === 0 ? (
        <Hoja flush>
          <Vacio
            title="Primero se necesita un dominio"
            action={
              <Link to="/dominios" className="text-sm text-laboratorio underline">
                Ir a Dominios
              </Link>
            }
          >
            Dé de alta un dominio en «Dominios»; después podrá crear buzones como nombre@sudominio.com.
          </Vacio>
        </Hoja>
      ) : all.length === 0 ? (
        <Hoja flush>
          <Vacio
            title="Aún no hay buzones"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="perfil" onClick={() => setCreateOpen(true)}>
                  Crear el primero
                </Button>
                <Button variant="plano" onClick={() => setAltaOpen(true)}>
                  Alta masiva
                </Button>
              </div>
            }
          >
            Cree cuentas como hola@{domainList[0]?.domain}. La contraseña se genera automáticamente y se muestra
            una sola vez.
          </Vacio>
        </Hoja>
      ) : (
        <Hoja
          title="Registro de buzones"
          meta={hayFiltros ? `${filtrados.length} de ${all.length}` : undefined}
          actions={
            <Button variant="perfil" onClick={() => setAltaOpen(true)}>
              Alta masiva
            </Button>
          }
          flush
        >
          <div className="regla-fila grid gap-3 px-4 py-3 sm:grid-cols-2 lg:grid-cols-3">
            <Input
              label="Buscar"
              type="search"
              value={q}
              onChange={(e) => setFiltro('q', e.target.value)}
              placeholder="Dirección o nombre visible"
            />
            {isAdmin && (
              <Select label="Cliente" value={filtroCliente} onChange={(e) => setFiltro('cliente', e.target.value)}>
                <option value="">Todos los clientes</option>
                {[...clientes.values()]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </Select>
            )}
            <Select label="Dominio" value={filtroDominio} onChange={(e) => setFiltro('dominio', e.target.value)}>
              <option value="">Todos los dominios</option>
              {dominiosVisibles.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.domain}
                </option>
              ))}
            </Select>
          </div>

          {filtrados.length === 0 ? (
            <Vacio
              title="Ningún buzón coincide con la búsqueda"
              action={
                <Button variant="perfil" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                  Quitar filtros
                </Button>
              }
            />
          ) : (
            <>
              {/* Cabecera de columnas: en pantalla estrecha cada dato lleva su rótulo. */}
              <div className="regla-cabecera hidden items-baseline gap-x-4 px-4 py-2 lg:flex">
                <span className="rotulo min-w-0 grow basis-0">Buzón</span>
                {isAdmin && <span className="rotulo w-28 shrink-0">Cliente</span>}
                <span className="rotulo w-32 shrink-0">Ocupación</span>
                <span className="rotulo w-32 shrink-0">Estado</span>
                <span className="rotulo w-44 shrink-0 text-right">Acciones</span>
              </div>

              {grouped.map(([domainName, group]) => (
                <div key={domainName}>
                  <div className="regla-fila flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 bg-hoja-3 px-4 py-1.5">
                    <span className="valor break-all text-sm font-medium text-tinta">{domainName}</span>
                    <span className="rotulo">{plural(group.length, 'buzón', 'buzones')}</span>
                  </div>
                  {group.map((mailbox) => (
                    <FilaBuzon
                      key={mailbox.id}
                      mailbox={mailbox}
                      isAdmin={isAdmin}
                      clienteSuspendido={mailbox.clientId ? clientes.get(mailbox.clientId)?.suspended : undefined}
                      onAbrir={(vista) => abrirFicha(mailbox, vista)}
                    />
                  ))}
                </div>
              ))}
            </>
          )}
        </Hoja>
      )}

      {createOpen && (
        <CrearBuzon
          domains={dominiosVisibles.length > 0 ? dominiosVisibles : domainList}
          dominioInicial={filtroDominio}
          etiquetaDominio={etiquetaDominio}
          onClose={() => setCreateOpen(false)}
          onCreado={(mailbox, password) => {
            setCreateOpen(false);
            abrirFicha(mailbox, password ? 'credenciales' : 'conectar', password);
          }}
        />
      )}

      {altaOpen && (
        <AltaMasiva
          open
          onClose={() => {
            setAltaOpen(false);
            void queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
          }}
          domains={dominiosVisibles.length > 0 ? dominiosVisibles : domainList}
          dominioInicial={filtroDominio}
          resultado={altaResultado}
          onResultado={setAltaResultado}
          etiquetaDominio={etiquetaDominio}
        />
      )}

      <FichaBuzon
        key={ficha ? `${ficha.id}-${ficha.n}` : 'ninguna'}
        mailbox={fichaMailbox}
        vistaInicial={ficha?.vista}
        passwordInicial={ficha?.password}
        planQuotaMb={fichaCliente?.plan.mailboxQuotaMb}
        clienteSuspendido={fichaCliente?.suspended}
        aliases={aliases.data?.aliases ?? []}
        onClose={() => setFicha(null)}
      />
    </>
  );
}

/* ---------------------------------- Fila ---------------------------------- */

const rellenoUso = {
  normal: 'bg-normal',
  vigilar: 'bg-vigilar',
  fuera: 'bg-fuera',
  'sin-dato': 'bg-tinta-3',
} as const;

function FilaBuzon({
  mailbox,
  isAdmin,
  clienteSuspendido,
  onAbrir,
}: {
  mailbox: Mailbox;
  isAdmin: boolean;
  clienteSuspendido?: boolean;
  onAbrir: (vista: VistaFicha) => void;
}) {
  const veredicto = veredictoUso(mailbox.usedBytes, mailbox.quotaMb);
  const ratio = mailbox.usedBytes !== null ? Math.min(1, mailbox.usedBytes / (mailbox.quotaMb * 1024 * 1024)) : 0;
  // El veredicto de ocupación tiñe la fila entera (DESIGN.md).
  const tinte = veredicto === 'fuera' ? 'fila-fuera' : veredicto === 'vigilar' ? 'fila-vigilar' : '';
  return (
    <div
      className={`regla-fila flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 transition-colors duration-100
        last:border-b-0 hover:bg-hoja-2 ${tinte}`}
    >
      {/* El dato que identifica la fila: línea propia en móvil, nunca truncado. */}
      <div className="min-w-0 grow basis-full lg:basis-0">
        <button
          type="button"
          onClick={() => onAbrir('resumen')}
          className="valor break-all text-left text-base text-tinta hover:text-laboratorio hover:underline"
        >
          {mailbox.email}
        </button>
        <p className="text-sm text-tinta-3">{mailbox.displayName || 'Sin nombre visible'}</p>
      </div>

      {isAdmin && (
        <div className="flex min-w-0 shrink-0 items-baseline gap-1.5 lg:w-28">
          <span className="rotulo lg:hidden">Cliente</span>
          {mailbox.clientId ? (
            <Link
              to={`/clientes/${mailbox.clientId}`}
              className="min-w-0 break-words text-sm text-tinta-2 hover:text-laboratorio hover:underline"
            >
              {mailbox.clientName}
            </Link>
          ) : (
            <span className="text-sm text-tinta-3">—</span>
          )}
        </div>
      )}

      <div className="flex shrink-0 flex-col gap-1 lg:w-32">
        <div className="flex items-baseline gap-1.5">
          <span className="rotulo lg:hidden">Ocupación</span>
          <span className={`valor text-sm ${veredicto === 'fuera' ? 'text-fuera' : veredicto === 'vigilar' ? 'text-vigilar' : 'text-tinta-2'}`}>
            {mailbox.usedBytes === null ? '—' : formatBytes(mailbox.usedBytes)}
            <span className="text-tinta-3"> / {formatQuota(mailbox.quotaMb)}</span>
          </span>
        </div>
        <div
          role="meter"
          aria-label={`Ocupación de ${mailbox.email}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
          className="h-1 w-32 bg-hoja-3"
        >
          <div className={`h-full ${rellenoUso[veredicto]}`} style={{ width: `${Math.max(ratio * 100, ratio > 0 ? 2 : 0)}%` }} />
        </div>
      </div>

      <div className="shrink-0 lg:w-32">
        {mailbox.status === 'suspended' ? (
          <MarcaFondo veredicto="fuera">Suspendido</MarcaFondo>
        ) : clienteSuspendido ? (
          <MarcaFondo veredicto="fuera">Cliente suspendido</MarcaFondo>
        ) : (
          <MarcaFondo veredicto="normal">Activo</MarcaFondo>
        )}
      </div>

      <div className="flex w-full flex-wrap items-center gap-1 lg:w-44 lg:flex-nowrap lg:justify-end">
        <Button variant="plano" className="px-2" onClick={() => onAbrir('conectar')}>
          Conectar
        </Button>
        <Button variant="perfil" className="px-2" onClick={() => onAbrir('resumen')}>
          Gestionar
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------- Crear buzón ------------------------------ */

function CrearBuzon({
  domains,
  dominioInicial,
  etiquetaDominio,
  onClose,
  onCreado,
}: {
  domains: DomainRecord[];
  dominioInicial: string;
  etiquetaDominio: (d: DomainRecord) => string;
  onClose: () => void;
  onCreado: (mailbox: Mailbox, password?: string) => void;
}) {
  const queryClient = useQueryClient();
  const [domainId, setDomainId] = useState(
    domains.some((d) => d.id === dominioInicial) ? dominioInicial : (domains[0]?.id ?? ''),
  );
  const [localPart, setLocalPart] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [modo, setModo] = useState<'generar' | 'propia'>('generar');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.post<{ mailbox: Mailbox; password?: string }>('/api/mailboxes', {
        domainId,
        localPart,
        displayName,
        password: modo === 'propia' ? password : undefined,
      }),
    onSuccess: async (data) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mailboxes'] }),
        queryClient.invalidateQueries({ queryKey: ['client-dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['clients'] }),
      ]);
      onCreado(data.mailbox, data.password);
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido crear el buzón.')),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (modo === 'propia' && password.length < 10) {
      setError('La contraseña debe tener al menos 10 caracteres.');
      return;
    }
    setError('');
    create.mutate();
  }

  return (
    <Dialogo open onClose={onClose} title="Crear buzón">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Select label="Dominio" required value={domainId} onChange={(e) => setDomainId(e.target.value)}>
          {domains.map((domain) => (
            <option key={domain.id} value={domain.id}>
              {etiquetaDominio(domain)}
            </option>
          ))}
        </Select>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[10rem] flex-1">
            <Input
              label="Nombre del buzón"
              required
              mono
              autoComplete="off"
              value={localPart}
              onChange={(e) => setLocalPart(e.target.value)}
              placeholder="hola"
            />
          </div>
          <span className="valor break-all pb-2.5 text-sm text-tinta-3">
            @{domains.find((d) => d.id === domainId)?.domain || '…'}
          </span>
        </div>
        <Input
          label="Nombre visible (opcional)"
          maxLength={80}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Equipo de soporte"
        />
        <fieldset className="flex flex-col gap-2.5">
          <legend className="rotulo mb-2">Contraseña</legend>
          <Opcion
            name="crear-modo"
            checked={modo === 'generar'}
            onChange={() => setModo('generar')}
            label="Generar una contraseña segura"
            help="Se mostrará una sola vez, junto con los datos para conectar dispositivos."
          />
          <Opcion
            name="crear-modo"
            checked={modo === 'propia'}
            onChange={() => setModo('propia')}
            label="Escribir una contraseña"
          />
        </fieldset>
        {modo === 'propia' && (
          <Input
            label="Contraseña"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            help="Mínimo 10 caracteres."
          />
        )}
        <p className="text-sm text-tinta-3">
          La cuota es la máxima del plan; se puede reducir después desde «Gestionar».
        </p>
        {error && <BandaError>{error}</BandaError>}
        <Botonera>
          <Button type="button" variant="plano" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="tinta" busy={create.isPending}>
            Crear buzón
          </Button>
        </Botonera>
      </form>
    </Dialogo>
  );
}
