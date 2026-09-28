import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, CircleHelp, ArrowRight } from 'lucide-react';
import { api, type Client, type DomainRecord, type Mailbox, type User } from '../lib/api';
import { Dialogo } from '../ui/kit';

/** Search uses the same server-scoped resources as the management pages. */
export function PanelTools({ user }: { user: User }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [term, setTerm] = useState('');
  const domains = useQuery({ queryKey: ['domains'], queryFn: () => api.get<{ domains: DomainRecord[] }>('/api/domains'), enabled: searchOpen });
  const mailboxes = useQuery({ queryKey: ['mailboxes'], queryFn: () => api.get<{ mailboxes: Mailbox[] }>('/api/mailboxes'), enabled: searchOpen });
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api.get<{ clients: Client[] }>('/api/clients'), enabled: searchOpen && user.role === 'admin' });
  const query = term.trim().toLocaleLowerCase('es');
  const results = [
    ...(domains.data?.domains ?? []).map(d => ({ key: `d-${d.id}`, label: d.domain, kind: 'Dominio', to: `/dominios/${d.id}` })),
    ...(mailboxes.data?.mailboxes ?? []).map(m => ({ key: `m-${m.id}`, label: m.email, kind: 'Buzón', to: `/buzones?q=${encodeURIComponent(m.email)}` })),
    ...(user.role === 'admin' ? clients.data?.clients ?? [] : []).map(c => ({ key: `c-${c.id}`, label: c.name, kind: 'Cliente', to: `/clientes/${c.id}` })),
  ].filter(r => r.label.toLocaleLowerCase('es').includes(query)).slice(0, 12);
  const loading = domains.isPending || mailboxes.isPending || (user.role === 'admin' && clients.isPending);
  const error = domains.isError || mailboxes.isError || (user.role === 'admin' && clients.isError);
  return <>
    <div className="mb-5 flex items-center justify-between gap-3">
      <button onClick={() => setSearchOpen(true)} className="flex min-h-10 w-full max-w-lg items-center gap-3 rounded-lg border border-regla bg-hoja px-3 text-left text-base text-tinta-3 hover:border-regla-fuerte">
        <Search className="h-4 w-4 shrink-0" /><span>Buscar {user.role === 'admin' ? 'clientes, ' : ''}dominios o buzones…</span>
      </button>
      <button onClick={() => setHelpOpen(true)} className="inline-flex min-h-10 items-center gap-2 text-base text-tinta-2 hover:text-laboratorio"><CircleHelp className="h-4 w-4" />Ayuda</button>
      <Link to="/cuenta" className="hidden shrink-0 text-right text-sm text-tinta-2 md:block"><span className="block font-semibold text-tinta">{user.name}</span>{user.role === 'admin' ? 'Administrador' : 'Mi cuenta'}</Link>
    </div>
    <Dialogo open={searchOpen} onClose={() => setSearchOpen(false)} title="Buscar en tu servicio">
      <input autoFocus aria-label="Buscar clientes, dominios o buzones" value={term} onChange={e => setTerm(e.target.value)} placeholder="Nombre, dominio o dirección de correo" className="h-11 w-full rounded-lg border border-regla px-3 text-base" />
      <div className="mt-3" aria-live="polite">
        {loading && <p className="py-2 text-sm text-tinta-3">Cargando recursos…</p>}
        {error && <p role="alert" className="py-2 text-sm text-fuera">No se pudieron cargar todos los resultados. Cierra la búsqueda e inténtalo de nuevo.</p>}
        {!loading && !error && results.length === 0 && <p className="py-4 text-tinta-2">No hay resultados para esta búsqueda.</p>}
        <ul>{results.map(r => <li key={r.key}><Link to={r.to} onClick={() => setSearchOpen(false)} className="flex items-center gap-3 border-b border-regla py-3 hover:text-laboratorio"><span className="min-w-0 flex-1 break-words">{r.label}<span className="block text-sm text-tinta-3">{r.kind}</span></span><ArrowRight className="h-4 w-4 shrink-0" /></Link></li>)}</ul>
      </div>
    </Dialogo>
    <Dialogo open={helpOpen} onClose={() => setHelpOpen(false)} title="¿Qué necesitas hacer?">
      <ul className="space-y-4">
        {[
          { to: '/dominios', title: 'Configurar tu dominio', text: 'Añade el dominio y copia los registros DNS indicados. Después comprueba la configuración.' },
          { to: '/buzones', title: 'Crear una cuenta o conectar un dispositivo', text: 'Desde Buzones puedes crear direcciones y consultar los datos de conexión para móvil y ordenador.' },
          { to: '/cuenta', title: 'Cambiar tu contraseña', text: 'Actualiza la contraseña de acceso a este panel desde Mi cuenta.' },
        ].map(item => <li key={item.to}><Link to={item.to} onClick={() => setHelpOpen(false)} className="font-semibold text-laboratorio hover:underline">{item.title} →</Link><p className="mt-1 text-sm text-tinta-2">{item.text}</p></li>)}
      </ul>
    </Dialogo>
  </>;
}
