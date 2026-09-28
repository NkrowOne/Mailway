import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  BellRing,
  Building2,
  Gauge,
  Globe,
  Inbox,
  KeyRound,
  LogOut,
  Menu,
  Radar,
  Settings,
  Split,
  Tag,
  UserRound,
  X,
} from 'lucide-react';
import { api, type Alert, type User } from '../lib/api';

/**
 * El membrete del índice. El logotipo es la marca de una escala medida:
 * geometría, no una ilustración. Va sobre el mismo campo que la cabecera de página,
 * de modo que la banda oscura recorre todo el borde superior de la aplicación
 * en lugar de aparecer y desaparecer.
 */
function Marca({ brand }: { brand: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-laboratorio shadow-sm">
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
          <path d="M4 7.5 12 13l8-5.5M5 6h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="min-w-0">
        <span className="block truncate text-lg font-semibold tracking-[-0.02em] text-white">{brand}</span>
        <span className="block text-sm text-white/55">Gestión de correo</span>
      </div>
    </div>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
  /** Pinta el recuento de avisos abiertos junto al elemento. */
  badge?: 'alerts';
}

function buildNav(user: User): { section: string; items: NavItem[] }[] {
  const iconClass = 'h-4 w-4';
  if (user.role === 'admin') {
    return [
      {
        section: 'Vista general',
        items: [
          { to: '/', label: 'Resumen', icon: <Gauge className={iconClass} />, end: true },
          { to: '/avisos', label: 'Alertas', icon: <BellRing className={iconClass} />, badge: 'alerts' },
          { to: '/entregabilidad', label: 'Estado del correo', icon: <Radar className={iconClass} /> },
        ],
      },
      {
        section: 'Gestión',
        items: [
          { to: '/clientes', label: 'Clientes', icon: <Building2 className={iconClass} /> },
          { to: '/dominios', label: 'Dominios', icon: <Globe className={iconClass} /> },
          { to: '/buzones', label: 'Buzones', icon: <Inbox className={iconClass} /> },
          { to: '/marca-blanca', label: 'Marca blanca', icon: <Tag className={iconClass} /> },
        ],
      },
      {
        section: 'Configuración',
        items: [
          { to: '/api-envio', label: 'API de envío', icon: <KeyRound className={iconClass} /> },
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
        { to: '/', label: 'Resumen', icon: <Gauge className={iconClass} />, end: true },
        { to: '/dominios', label: 'Dominios', icon: <Globe className={iconClass} /> },
        { to: '/buzones', label: 'Buzones', icon: <Inbox className={iconClass} /> },
        { to: '/alias', label: 'Alias', icon: <Split className={iconClass} /> },
        { to: '/marca-blanca', label: 'Marca blanca', icon: <Tag className={iconClass} /> },
      ],
    },
    {
      section: 'Automatización',
      items: [{ to: '/api-envio', label: 'API de envío', icon: <KeyRound className={iconClass} /> }],
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
  const esAdmin = user.role === 'admin';

  // El recuento solo lo pinta la navegación del administrador: sondearlo en
  // los paneles de cliente sería una petición por minuto que nadie mira.
  const alerts = useQuery({
    queryKey: ['alerts', false],
    queryFn: () => api.get<{ alerts: Alert[] }>('/api/alerts'),
    refetchInterval: 60_000,
    enabled: esAdmin,
  });
  const avisosAbiertos = alerts.data?.alerts.length ?? 0;

  async function logout() {
    await api.post('/api/auth/logout');
    await queryClient.invalidateQueries({ queryKey: ['me'] });
    navigate('/login');
  }

  const sidebar = (
    <div className="sidebar-lab flex h-full flex-col text-white">
      <Marca brand={brand} />
      <nav className="flex-1 overflow-y-auto px-3 pb-5 pt-2">
        {nav.map((group) => (
          <div key={group.section} className="mt-4 first:mt-0">
            <p className="px-3 pb-2 font-estrecha text-micro font-semibold uppercase tracking-[0.12em] text-white/40">{group.section}</p>
            <ul className="flex flex-col gap-1">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={() => setOpen(false)}
                    className={({ isActive }) =>
                      `flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-base transition duration-150 ${
                        isActive
                          ? 'bg-white font-semibold text-laboratorio shadow-sm'
                          : 'text-white/70 hover:bg-white/10 hover:text-white'
                      }`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span className={isActive ? 'text-laboratorio' : 'text-white/45'}>
                          {item.icon}
                        </span>
                        {item.label}
                        {item.badge === 'alerts' && avisosAbiertos > 0 && (
                          <span
                            className="ml-auto rounded-full bg-fuera px-2 py-0.5 text-sm font-semibold text-white"
                            aria-label={`${avisosAbiertos} aviso(s) sin resolver`}
                          >
                            {avisosAbiertos}
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

      <div className="flex items-center gap-2.5 border-t border-white/10 px-4 py-3.5">
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/12
            text-sm font-semibold uppercase tracking-wider text-white"
        >
          {user.name.slice(0, 2)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{user.name}</p>
          <p className="text-sm text-white/45">{esAdmin ? 'Administrador' : 'Cliente'}</p>
        </div>
        <button
          onClick={logout}
          aria-label="Cerrar sesión"
          title="Cerrar sesión"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-white/45 hover:bg-white/10 hover:text-white"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      {/* Índice del informe: fijo en escritorio. */}
      <aside className="hidden w-64 shrink-0 lg:block">
        <div className="sticky top-0 h-screen">{sidebar}</div>
      </aside>

      {/* Cajón en móvil. */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            aria-label="Cerrar menú"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-[rgb(var(--tinta)/0.4)]"
          />
          <div className="absolute inset-y-0 left-0 w-72 shadow-flotante">
            {sidebar}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sidebar-lab flex items-center gap-3 px-4 py-3 lg:hidden">
          <button
            onClick={() => setOpen(true)}
            aria-label="Abrir menú"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/20 text-white hover:bg-white/10"
          >
            <Menu className="h-4 w-4" />
          </button>
          <span className="text-md font-semibold text-white">
            {brand}
          </span>
          {open && <X className="hidden" />}
        </header>

        <main className="min-w-0 flex-1 px-4 py-5 sm:px-7 sm:py-8 xl:px-10">
          <div className="mx-auto max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
