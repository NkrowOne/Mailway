import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  BellRing,
  Building2,
  Cable,
  ClipboardList,
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
import { api, ApiError, type Alert, type User } from '../lib/api';
import { plural } from '../lib/format';
import { useBloqueoDesplazamiento } from '../ui/kit';
import { useToast } from '../ui/toast';
import { PanelTools } from './PanelTools';

/** Color del campo de laboratorio (--laboratorio) para la barra del navegador. */
const COLOR_CAMPO = '#0a3e45';

/**
 * El membrete del índice: logotipo y nombre de la instancia sobre el campo
 * oscuro que ocupa todo el índice. En el cajón móvil lleva además el botón
 * de cerrar (`accion`).
 */
function Marca({ brand, accion }: { brand: string; accion?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-5">
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-laboratorio shadow-sm"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
          <path
            d="M4 7.5 12 13l8-5.5M5 6h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {/* El nombre parte en lugar de recortarse: es lo que identifica la instancia. */}
      <div className="min-w-0 flex-1">
        <span className="block break-words text-lg font-semibold tracking-[-0.02em] text-white">{brand}</span>
        <span className="block text-sm text-white/60">Gestión de correo</span>
      </div>
      {accion}
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

interface NavGroup {
  section: string;
  items: NavItem[];
}

function buildNav(user: User): NavGroup[] {
  const iconClass = 'h-4 w-4';
  if (user.role === 'admin') {
    return [
      {
        section: 'Vista general',
        items: [
          { to: '/', label: 'Resumen', icon: <Gauge className={iconClass} />, end: true },
          { to: '/avisos', label: 'Avisos', icon: <BellRing className={iconClass} />, badge: 'alerts' },
          { to: '/entregabilidad', label: 'Entregabilidad', icon: <Radar className={iconClass} /> },
        ],
      },
      {
        section: 'Gestión',
        items: [
          { to: '/clientes', label: 'Clientes', icon: <Building2 className={iconClass} /> },
          { to: '/dominios', label: 'Dominios', icon: <Globe className={iconClass} /> },
          { to: '/buzones', label: 'Buzones', icon: <Inbox className={iconClass} /> },
          { to: '/alias', label: 'Alias', icon: <Split className={iconClass} /> },
          { to: '/marca-blanca', label: 'Marca blanca', icon: <Tag className={iconClass} /> },
        ],
      },
      {
        section: 'Configuración',
        items: [
          { to: '/api-envio', label: 'API de envío', icon: <KeyRound className={iconClass} /> },
          { to: '/conexiones', label: 'Conexiones', icon: <Cable className={iconClass} /> },
          { to: '/planes', label: 'Planes', icon: <ClipboardList className={iconClass} /> },
          { to: '/actividad', label: 'Actividad', icon: <Activity className={iconClass} /> },
          { to: '/ajustes', label: 'Ajustes', icon: <Settings className={iconClass} /> },
        ],
      },
      {
        // El administrador también tiene contraseña propia que cambiar.
        section: 'Cuenta',
        items: [{ to: '/cuenta', label: 'Mi cuenta', icon: <UserRound className={iconClass} /> }],
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
      items: [
        { to: '/api-envio', label: 'API de envío', icon: <KeyRound className={iconClass} /> },
        { to: '/conexiones', label: 'Conexiones', icon: <Cable className={iconClass} /> },
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

/** Nombre de la vista actual para el título de la pestaña («Buzones · Marca»). */
function etiquetaDeRuta(nav: NavGroup[], pathname: string): string | null {
  let mejor: NavItem | null = null;
  for (const item of nav.flatMap((g) => g.items)) {
    const coincide = item.end
      ? pathname === item.to
      : pathname === item.to || pathname.startsWith(`${item.to}/`);
    if (coincide && (!mejor || item.to.length > mejor.to.length)) mejor = item;
  }
  return mejor?.label ?? null;
}

/** Dos iniciales del nombre («Ana López» → «AL»), o las dos primeras letras. */
function iniciales(nombre: string): string {
  const palabras = nombre.trim().split(/\s+/).filter(Boolean);
  if (palabras.length >= 2) return `${palabras[0]![0]}${palabras[1]![0]}`;
  return nombre.trim().slice(0, 2) || '—';
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
  const location = useLocation();
  const tipoNavegacion = useNavigationType();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [saliendo, setSaliendo] = useState(false);
  const nav = buildNav(user);
  const esAdmin = user.role === 'admin';

  const menuRef = useRef<HTMLButtonElement>(null);
  const cajonRef = useRef<HTMLDivElement>(null);
  const contenidoRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const devolverFoco = useRef(false);
  const rutaAnterior = useRef(location.pathname);

  // El recuento solo lo pinta la navegación del administrador: sondearlo en
  // los paneles de cliente sería una petición por minuto que nadie mira.
  const alerts = useQuery({
    queryKey: ['alerts', false],
    queryFn: () => api.get<{ alerts: Alert[] }>('/api/alerts'),
    refetchInterval: 60_000,
    enabled: esAdmin,
  });
  const avisosAbiertos = alerts.data?.alerts.length ?? 0;

  useBloqueoDesplazamiento(open);

  // Dentro del panel, la barra del navegador móvil continúa la banda oscura
  // de identidad; al salir (portada de acceso) vuelve al color de la mesa.
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) return;
    const previo = meta.content;
    meta.content = COLOR_CAMPO;
    return () => {
      meta.content = previo;
    };
  }, []);

  const etiqueta = etiquetaDeRuta(nav, location.pathname);
  useEffect(() => {
    document.title = etiqueta ? `${etiqueta} · ${brand}` : brand;
  }, [etiqueta, brand]);

  // Cambio de vista: arriba del todo (salvo al volver atrás, donde el
  // navegador restaura la posición) y el foco al contenido, para que el lector
  // de pantalla y el teclado empiecen por la página nueva y no por el índice.
  useEffect(() => {
    if (rutaAnterior.current === location.pathname) return;
    rutaAnterior.current = location.pathname;
    setOpen(false);
    if (tipoNavegacion !== 'POP') window.scrollTo({ top: 0 });
    mainRef.current?.focus({ preventScroll: true });
  }, [location.pathname, tipoNavegacion]);

  // Cajón móvil: modal de verdad. Escape cierra, el foco no sale de él, el
  // resto de la página queda inerte y, al cerrarlo, el foco vuelve al botón
  // de menú (salvo si se cerró navegando: entonces va al contenido).
  useEffect(() => {
    if (!open) {
      if (devolverFoco.current) {
        devolverFoco.current = false;
        menuRef.current?.focus();
      }
      return;
    }
    const cajon = cajonRef.current;
    const contenido = contenidoRef.current;
    contenido?.setAttribute('inert', '');
    const inicial =
      cajon?.querySelector<HTMLElement>('[aria-current="page"]') ??
      cajon?.querySelector<HTMLElement>('a[href], button:not([disabled])');
    inicial?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        devolverFoco.current = true;
        setOpen(false);
        return;
      }
      // Trampa de foco manual además de `inert`, por los navegadores que aún
      // no lo aplican.
      if (e.key !== 'Tab' || !cajon) return;
      const enfocables = Array.from(
        cajon.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
      );
      const primero = enfocables[0];
      const ultimo = enfocables[enfocables.length - 1];
      if (!primero || !ultimo) return;
      if (e.shiftKey && (document.activeElement === primero || !cajon.contains(document.activeElement))) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && (document.activeElement === ultimo || !cajon.contains(document.activeElement))) {
        e.preventDefault();
        primero.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);

    // Si la ventana se ensancha hasta mostrar el índice fijo, el cajón sobra
    // (y con él, el bloqueo del desplazamiento).
    const anchoIndice = window.matchMedia('(min-width: 1024px)');
    const alEnsanchar = () => {
      if (anchoIndice.matches) setOpen(false);
    };
    anchoIndice.addEventListener('change', alEnsanchar);

    return () => {
      contenido?.removeAttribute('inert');
      document.removeEventListener('keydown', onKeyDown);
      anchoIndice.removeEventListener('change', alEnsanchar);
    };
  }, [open]);

  async function logout() {
    setSaliendo(true);
    try {
      await api.post('/api/auth/logout');
    } catch (err) {
      // Si el servidor no respondió, la sesión sigue viva: fingir la salida
      // dejaría la cuenta abierta al recargar.
      setSaliendo(false);
      toast(
        'error',
        err instanceof ApiError
          ? err.message
          : 'No se ha podido cerrar la sesión. Compruebe la conexión e inténtelo de nuevo.',
      );
      return;
    }
    // Se vacía TODA la caché: los datos de esta cuenta (clientes, buzones,
    // claves…) no deben quedar en la pestaña para quien entre después. Solo se
    // conserva el estado público de la instalación, para no repetir la carga.
    const setup = queryClient.getQueryData(['setup']);
    queryClient.clear();
    if (setup) queryClient.setQueryData(['setup'], setup);
    queryClient.setQueryData(['me'], { user: null });
    navigate('/login', { replace: true, state: { salida: true } });
  }

  function indice(enCajon: boolean) {
    return (
      <div className="sidebar-lab flex h-full flex-col text-white">
        <Marca
          brand={brand}
          accion={
            enCajon ? (
              <button
                type="button"
                onClick={() => {
                  devolverFoco.current = true;
                  setOpen(false);
                }}
                aria-label="Cerrar menú"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/20 text-white hover:bg-white/10"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            ) : undefined
          }
        />
        <nav aria-label="Navegación principal" className="flex-1 overflow-y-auto px-3 pb-5 pt-2">
          {nav.map((group) => (
            <div key={group.section} className="mt-4 first:mt-0">
              <p className="px-3 pb-2 font-estrecha text-micro font-semibold uppercase tracking-[0.12em] text-white/60">
                {group.section}
              </p>
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
                            : 'text-white/75 hover:bg-white/10 hover:text-white'
                        }`
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <span aria-hidden className={isActive ? 'text-laboratorio' : 'text-white/50'}>
                            {item.icon}
                          </span>
                          {item.label}
                          {item.badge === 'alerts' && avisosAbiertos > 0 && (
                            <>
                              <span
                                aria-hidden
                                className="valor ml-auto rounded-full bg-fuera px-2 py-0.5 text-sm font-semibold text-white"
                              >
                                {avisosAbiertos}
                              </span>
                              <span className="sr-only">
                                {`, ${plural(avisosAbiertos, 'aviso sin resolver', 'avisos sin resolver')}`}
                              </span>
                            </>
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
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15
              text-sm font-semibold uppercase tracking-wider text-white"
          >
            {iniciales(user.name || user.email)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white" title={user.email}>
              {user.name || user.email}
            </p>
            <p className="text-sm text-white/60">{esAdmin ? 'Administrador' : 'Cliente'}</p>
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            disabled={saliendo}
            aria-label="Cerrar sesión"
            title="Cerrar sesión"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-35"
          >
            <LogOut className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <a
        href="#contenido"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:bg-hoja
          focus:px-3 focus:py-2 focus:text-base focus:text-laboratorio focus:shadow-flotante"
      >
        Ir al contenido
      </a>

      {/* Índice del informe: fijo en escritorio. */}
      <aside className="hidden w-64 shrink-0 lg:block">
        <div className="sticky top-0 h-screen">{indice(false)}</div>
      </aside>

      {/* Cajón en móvil: un diálogo modal sobre un velo. */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            aria-hidden
            onClick={() => {
              devolverFoco.current = true;
              setOpen(false);
            }}
            className="velo-entrada absolute inset-0 bg-[rgb(var(--tinta)/0.4)]"
          />
          <div
            ref={cajonRef}
            role="dialog"
            aria-modal="true"
            aria-label="Menú de navegación"
            className="cajon-entrada absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-flotante"
          >
            {indice(true)}
          </div>
        </div>
      )}

      <div ref={contenidoRef} className="flex min-w-0 flex-1 flex-col">
        <header className="sidebar-lab flex items-center gap-3 px-4 py-3 lg:hidden">
          <button
            ref={menuRef}
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Abrir menú"
            aria-expanded={open}
            aria-haspopup="dialog"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/20 text-white
              hover:bg-white/10"
          >
            <Menu className="h-4 w-4" aria-hidden />
          </button>
          <span className="min-w-0 truncate text-md font-semibold text-white">
            {brand}
          </span>
        </header>

        <div className="min-w-0 flex-1 px-4 py-5 sm:px-7 sm:py-8 xl:px-10">
          <div className="mx-auto max-w-7xl">
            {/* Búsqueda y ayuda fuera de <main>: no se repiten al cambiar de
                vista, y el foco y «Ir al contenido» van directos a la página. */}
            <PanelTools user={user} />
            <main ref={mainRef} id="contenido" tabIndex={-1} className="min-w-0 focus:outline-none">
              {/* La clave remonta la vista con un fundido corto: la página
                  nueva entra sin saltos en lugar de sustituir a la anterior
                  de golpe. */}
              <div key={location.pathname} className="vista-entrada">
                {children}
              </div>
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}
