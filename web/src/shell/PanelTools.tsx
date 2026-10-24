import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, CircleHelp, ArrowRight, SearchX } from 'lucide-react';
import { api, type Client, type DomainRecord, type Mailbox, type User } from '../lib/api';
import { AvisoError, Dialogo, Cargando, Vacio } from '../ui/kit';
import { rutaCliente } from '../components/gestion/comun';

/**
 * Búsqueda y ayuda del panel. La búsqueda usa los mismos recursos (y la misma
 * caché) que las páginas de gestión, así que solo ve lo que el servidor ya
 * deja ver a quien ha iniciado sesión.
 */
export function PanelTools({ user }: { user: User }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [term, setTerm] = useState('');
  const esAdmin = user.role === 'admin';
  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ domains: DomainRecord[] }>('/api/domains'),
    enabled: searchOpen,
  });
  const mailboxes = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => api.get<{ mailboxes: Mailbox[] }>('/api/mailboxes'),
    enabled: searchOpen,
  });
  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: Client[] }>('/api/clients'),
    enabled: searchOpen && esAdmin,
  });
  const query = term.trim().toLocaleLowerCase('es');
  const results = [
    ...(domains.data?.domains ?? []).map((d) => ({
      key: `d-${d.id}`,
      label: d.domain,
      kind: 'Dominio',
      to: `/dominios/${d.id}`,
    })),
    ...(mailboxes.data?.mailboxes ?? []).map((m) => ({
      key: `m-${m.id}`,
      label: m.email,
      kind: 'Buzón',
      // El administrador lo encuentra dentro de la ficha de su cliente, junto
      // a sus dominios y alias; el usuario de un cliente, en su «Buzones».
      to: esAdmin && m.clientId
        ? `${rutaCliente(m.clientId, 'buzones')}?q=${encodeURIComponent(m.email)}`
        : `/buzones?q=${encodeURIComponent(m.email)}`,
    })),
    ...(esAdmin ? clients.data?.clients ?? [] : []).map((c) => ({
      key: `c-${c.id}`,
      label: c.name,
      kind: 'Cliente',
      to: `/clientes/${c.id}`,
    })),
  ]
    .filter((r) => r.label.toLocaleLowerCase('es').includes(query))
    .slice(0, 12);
  const loading = domains.isPending || mailboxes.isPending || (esAdmin && clients.isPending);
  const error = domains.isError || mailboxes.isError || (esAdmin && clients.isError);
  const reintentando = domains.isFetching || mailboxes.isFetching || (esAdmin && clients.isFetching);

  function reintentar() {
    if (domains.isError) void domains.refetch();
    if (mailboxes.isError) void mailboxes.refetch();
    if (esAdmin && clients.isError) void clients.refetch();
  }

  return (
    <>
      <div className="mb-5 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="flex min-h-10 w-full min-w-0 max-w-lg items-center gap-3 rounded-lg border border-regla-fuerte bg-hoja px-3
            text-left text-base text-tinta-3 shadow-boton hover:border-[rgb(var(--tinta)/0.32)]"
        >
          <Search className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            Buscar<span className="hidden sm:inline"> {esAdmin ? 'clientes, ' : ''}dominios o buzones</span>…
          </span>
        </button>
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className="inline-flex min-h-10 shrink-0 items-center gap-2 text-base text-tinta-2 hover:text-petroleo"
        >
          <CircleHelp className="h-4 w-4" aria-hidden />
          Ayuda
        </button>
        <Link to="/cuenta" className="hidden shrink-0 text-right text-sm text-tinta-2 md:block">
          <span className="block font-semibold text-tinta">{user.name || user.email}</span>
          {esAdmin ? 'Administrador' : 'Mi cuenta'}
        </Link>
      </div>

      <Dialogo open={searchOpen} onClose={() => setSearchOpen(false)} title="Buscar en el panel">
        <input
          data-autofocus
          type="search"
          aria-label={esAdmin ? 'Buscar clientes, dominios o buzones' : 'Buscar dominios o buzones'}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={esAdmin ? 'Nombre, dominio o dirección de correo' : 'Dominio o dirección de correo'}
          className="h-11 w-full rounded-lg border border-regla-fuerte bg-hoja px-3 text-base text-tinta placeholder:text-tinta-3
            focus:border-[rgb(var(--petroleo))] focus:outline-none focus:ring-[3px] focus:ring-petroleo/15"
        />
        <div className="mt-3" aria-live="polite">
          {loading && !error ? (
            <Cargando label="Cargando dominios y buzones…" />
          ) : error ? (
            <AvisoError onRetry={reintentar} retrying={reintentando}>
              No se han podido cargar todos los resultados.
            </AvisoError>
          ) : results.length === 0 ? (
            <Vacio icono={SearchX} title="Sin resultados">
              {query ? 'Revisa lo que has escrito o prueba con otra parte del nombre.' : 'Todavía no hay dominios ni buzones.'}
            </Vacio>
          ) : (
            <ul>
              {results.map((r) => (
                <li key={r.key}>
                  <Link
                    to={r.to}
                    onClick={() => setSearchOpen(false)}
                    className="flex items-center gap-3 border-b border-regla py-3 text-tinta hover:text-petroleo"
                  >
                    {/* Un identificador largo parte de línea, no se recorta. */}
                    <span className="min-w-0 flex-1 break-words">
                      {r.label}
                      <span className="block text-sm text-tinta-3">{r.kind}</span>
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialogo>

      <Dialogo open={helpOpen} onClose={() => setHelpOpen(false)} title="Ayuda">
        <ul className="space-y-4">
          {[
            {
              to: '/dominios',
              title: 'Configurar tu dominio',
              text: 'Añade el dominio, copia los registros DNS indicados en tu proveedor y comprueba la configuración.',
            },
            {
              to: '/buzones',
              title: 'Crear un buzón o conectar un dispositivo',
              text: 'En «Buzones» se crean las direcciones y se consultan los datos de conexión para el móvil y el ordenador.',
            },
            {
              to: '/cuenta',
              title: 'Cambiar tu contraseña',
              text: 'En «Mi cuenta» se cambia la contraseña con la que accedes a este panel.',
            },
          ].map((item) => (
            <li key={item.to}>
              <Link
                to={item.to}
                onClick={() => setHelpOpen(false)}
                className="font-semibold text-petroleo hover:underline"
              >
                {item.title} →
              </Link>
              <p className="mt-1 text-sm text-tinta-2">{item.text}</p>
            </li>
          ))}
        </ul>
      </Dialogo>
    </>
  );
}
