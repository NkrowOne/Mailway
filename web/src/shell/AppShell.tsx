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
    <div className="campo-lab flex items-center gap-2.5 px-4 py-4">
      <svg viewBox="0 0 22 16" className="h-4 w-[22px] shrink-0 text-laboratorio-vivo" aria-hidden>
        <path d="M1 13h20" stroke="currentColor" strokeWidth="1.6" />
        <path d="M4 13V7M9 13V3M14 13V9M19 13V5" stroke="currentColor" strokeWidth="1.6" />
      </svg>
      <span className="font-estrecha text-lg font-semibold uppercase tracking-[0.14em] text-white">
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
  /** Pinta el recuento de avisos abiertos junto al elemento. */
  badge?: 'alerts';
}

function buildNav(user: User): { section: string; items: NavItem[] }[] {
  const iconClass = 'h-4 w-4';
  if (user.role === 'admin') {
    return [
      {
        section: 'Parte diario',
        items: [
          { to: '/', label: 'Constantes', icon: <Gauge className={iconClass} />, end: true },
          { to: '/avisos', label: 'Avisos', icon: <BellRing className={iconClass} />, badge: 'alerts' },
          { to: '/entregabilidad', label: 'Entregabilidad', icon: <Radar className={iconClass} /> },
        ],
      },
      {
        section: 'Registro',
        items: [
          { to: '/clientes', label: 'Clientes', icon: <Building2 className={iconClass} /> },
          { to: '/dominios', label: 'Dominios', icon: <Globe className={iconClass} /> },
          { to: '/buzones', label: 'Buzones', icon: <Inbox className={iconClass} /> },
          { to: '/marca-blanca', label: 'Marca blanca', icon: <Tag className={iconClass} /> },
        ],
      },
      {
        section: 'Instrumentos',
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
        { to: '/', label: 'Tu parte', icon: <Gauge className={iconClass} />, end: true },
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
    <div className="flex h-full flex-col bg-hoja">
      <Marca brand={brand} />
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {nav.map((group) => (
          <div key={group.section} className="mt-4 first:mt-0">
            <p className="rotulo px-2 pb-1.5">{group.section}</p>
            <ul className="flex flex-col">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={() => setOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 px-2 py-1.5 text-base transition-colors duration-100 ${
                        isActive
                          ? 'bg-laboratorio-claro font-semibold text-laboratorio'
                          : 'text-tinta-2 hover:bg-hoja-3 hover:text-tinta'
                      }`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span className={isActive ? 'text-laboratorio' : 'text-tinta-3'}>
                          {item.icon}
                        </span>
                        {item.label}
                        {item.badge === 'alerts' && avisosAbiertos > 0 && (
                          <span
                            className="valor ml-auto bg-fuera-fondo px-1.5 text-sm font-semibold text-fuera"
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

      <div className="flex items-center gap-2.5 border-t border-regla px-3 py-2.5">
        <span
          aria-hidden
          className="flex h-7 w-7 shrink-0 items-center justify-center bg-laboratorio font-estrecha
            text-micro font-semibold uppercase tracking-wider text-hoja"
        >
          {user.name.slice(0, 2)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-tinta">{user.name}</p>
          <p className="rotulo">{esAdmin ? 'Responsable' : 'Cliente'}</p>
        </div>
        <button
          onClick={logout}
          aria-label="Cerrar sesión"
          title="Cerrar sesión"
          className="flex h-7 w-7 items-center justify-center text-tinta-3 hover:bg-hoja-3 hover:text-tinta"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      {/* Índice del informe: fijo en escritorio. */}
      <aside className="hidden w-56 shrink-0 border-r border-regla lg:block">
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
          <div className="absolute inset-y-0 left-0 w-64 border-r border-regla-fuerte shadow-flotante">
            {sidebar}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="campo-lab flex items-center gap-3 px-4 py-2.5 lg:hidden">
          <button
            onClick={() => setOpen(true)}
            aria-label="Abrir menú"
            className="flex h-8 w-8 items-center justify-center border border-white/30 text-white
              hover:bg-white/10"
          >
            <Menu className="h-4 w-4" />
          </button>
          <span className="font-estrecha text-md font-semibold uppercase tracking-[0.12em] text-white">
            {brand}
          </span>
          {open && <X className="hidden" />}
        </header>

        <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 sm:py-7">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
