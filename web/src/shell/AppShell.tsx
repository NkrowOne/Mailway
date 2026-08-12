import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AtSign,
  BellRing,
  Building2,
  Gauge,
  Globe,
  Inbox,
  KeyRound,
  LogOut,
  Mail,
  Menu,
  Radar,
  Settings,
  Split,
  Tag,
  UserRound,
  X,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api, type Alert, type User } from '../lib/api';

/** Marca: MAILWAY con chevrones de enrutado. */
function Marca({ brand }: { brand: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-4">
      <span aria-hidden className="flex items-center text-accion">
        <svg viewBox="0 0 22 14" className="h-3.5 w-[22px]">
          <path d="M1 1l6 6-6 6M9 1l6 6-6 6" stroke="currentColor" strokeWidth="2.4" fill="none" />
        </svg>
      </span>
      <span className="font-rotulo text-lg font-semibold uppercase tracking-[0.18em] text-tinta">
        {brand}
      </span>
    </div>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
  /** Clave para pintar un contador junto al elemento (avisos abiertos). */
  badge?: 'alerts';
}

function buildNav(user: User): { section: string; items: NavItem[] }[] {
  const iconClass = 'h-4 w-4';
  if (user.role === 'admin') {
    return [
      {
        section: 'Operación',
        items: [
          { to: '/', label: 'Panel', icon: <Gauge className={iconClass} />, end: true },
          { to: '/clientes', label: 'Clientes', icon: <Building2 className={iconClass} /> },
          { to: '/dominios', label: 'Dominios', icon: <Globe className={iconClass} /> },
          { to: '/buzones', label: 'Buzones', icon: <Inbox className={iconClass} /> },
          { to: '/marca-blanca', label: 'Marca blanca', icon: <Tag className={iconClass} /> },
        ],
      },
      {
        section: 'Envío',
        items: [
          { to: '/api-envio', label: 'API de envío', icon: <KeyRound className={iconClass} /> },
          { to: '/entregabilidad', label: 'Entregabilidad', icon: <Radar className={iconClass} /> },
        ],
      },
      {
        section: 'Sistema',
        items: [
          { to: '/avisos', label: 'Avisos', icon: <BellRing className={iconClass} />, badge: 'alerts' },
          { to: '/actividad', label: 'Actividad', icon: <Activity className={iconClass} /> },
          { to: '/ajustes', label: 'Ajustes', icon: <Settings className={iconClass} /> },
        ],
      },
    ];
  }
  return [
    {
      section: 'Tu correo',
      items: [
        { to: '/', label: 'Inicio', icon: <Gauge className={iconClass} />, end: true },
        { to: '/dominios', label: 'Dominios', icon: <Globe className={iconClass} /> },
        { to: '/buzones', label: 'Buzones', icon: <Inbox className={iconClass} /> },
        { to: '/alias', label: 'Alias', icon: <Split className={iconClass} /> },
        { to: '/marca-blanca', label: 'Marca blanca', icon: <Tag className={iconClass} /> },
      ],
    },
    {
      section: 'Automatización',
      items: [
        { to: '/api-envio', label: 'API de envío', icon: <KeyRound className={iconClass} /> },
      ],
    },
    {
      section: 'Cuenta',
      items: [
        { to: '/actividad', label: 'Actividad', icon: <Activity className={iconClass} /> },
        { to: '/cuenta', label: 'Mi cuenta', icon: <UserRound className={iconClass} /> },
      ],
    },
  ];
}

export function AppShell({
  user,
  brand,
  children,
}: {
  user: User;
  brand: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const nav = buildNav(user);

  // Contador de avisos abiertos: la campana de la nave. Se refresca solo para
  // que una incidencia nueva se vea sin recargar.
  const alerts = useQuery({
    queryKey: ['alerts', false],
    queryFn: () => api.get<{ alerts: Alert[] }>('/api/alerts'),
    refetchInterval: 60_000,
  });
  const openAlerts = alerts.data?.alerts.length ?? 0;

  async function logout() {
    await api.post('/api/auth/logout');
    await queryClient.invalidateQueries({ queryKey: ['me'] });
    navigate('/login');
  }

  const sidebar = (
    <div className="flex h-full flex-col">
      <Marca brand={brand} />
      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {nav.map((group) => (
          <div key={group.section} className="mt-4 first:mt-1">
            <p className="px-2 pb-1 font-rotulo text-micro font-semibold uppercase tracking-[0.16em] text-tinta-3">
              {group.section}
            </p>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={() => setOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 rounded px-2 py-1.5 text-base transition-colors duration-100 ${
                        isActive
                          ? 'bg-chasis-2 font-medium text-tinta'
                          : 'text-tinta-2 hover:bg-chasis hover:text-tinta'
                      }`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span className={isActive ? 'text-accion' : 'text-tinta-3'}>{item.icon}</span>
                        {item.label}
                        {item.badge === 'alerts' && openAlerts > 0 && (
                          <span
                            className="num ml-auto rounded-full bg-[rgb(var(--devuelto)/0.18)] px-1.5
                              text-sm font-semibold text-devuelto"
                            aria-label={`${openAlerts} aviso(s) sin resolver`}
                          >
                            {openAlerts}
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t border-suave px-3 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-chasis-2 font-rotulo text-sm font-semibold uppercase text-tinta-2">
            {user.name.slice(0, 2)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-tinta">{user.name}</p>
            <p className="truncate text-micro text-tinta-3">
              {user.role === 'admin' ? 'Administración' : user.email}
            </p>
          </div>
          <button
            onClick={logout}
            title="Cerrar sesión"
            aria-label="Cerrar sesión"
            className="flex h-8 w-8 items-center justify-center rounded text-tinta-3 hover:bg-chasis-2 hover:text-tinta"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      {/* Escritorio */}
      <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 border-r border-suave lg:block">
        {sidebar}
      </aside>

      {/* Móvil */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[264px] border-r border-fuerte bg-cinta shadow-flotante">
            <button
              onClick={() => setOpen(false)}
              aria-label="Cerrar menú"
              className="absolute right-3 top-4 flex h-8 w-8 items-center justify-center rounded text-tinta-3 hover:text-tinta"
            >
              <X className="h-4 w-4" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="min-w-0 flex-1">
        {/* Barra superior móvil */}
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-suave bg-cinta/95 px-4 py-2.5 backdrop-blur lg:hidden">
          <button
            onClick={() => setOpen(true)}
            aria-label="Abrir menú"
            className="flex h-9 w-9 items-center justify-center rounded text-tinta-2 hover:bg-chasis"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="font-rotulo text-md font-semibold uppercase tracking-[0.18em]">{brand}</span>
        </header>
        <main className="mx-auto w-full max-w-[1200px] px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

/** Icono compartido para enlaces de webmail. */
export const WebmailIcon = Mail;
export const AliasIcon = AtSign;
