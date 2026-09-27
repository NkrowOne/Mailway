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

/** Color del campo de laboratorio (--laboratorio) para la barra del navegador. */
const COLOR_CAMPO = '#0a3e45';

/**
 * El membrete del índice. El logotipo es la marca de una escala medida:
 * geometría, no una ilustración. Va sobre el mismo campo que la cabecera de página,
 * de modo que la banda oscura recorre todo el borde superior de la aplicación
 * en lugar de aparecer y desaparecer.
 */
function Marca({ brand, accion }: { brand: string; accion?: ReactNode }) {
  return (
    <div className="campo-lab flex items-center gap-2.5 px-4 py-4">
      <svg viewBox="0 0 22 16" className="h-4 w-[22px] shrink-0 text-laboratorio-vivo" aria-hidden>
        <path d="M1 13h20" stroke="currentColor" strokeWidth="1.6" />
        <path d="M4 13V7M9 13V3M14 13V9M19 13V5" stroke="currentColor" strokeWidth="1.6" />
      </svg>
      <span className="min-w-0 flex-1 break-words font-estrecha text-lg font-semibold uppercase tracking-[0.14em] text-white">
        {brand}
      </span>
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
          { to: '/alias', label: 'Alias', icon: <Split className={iconClass} /> },
          { to: '/marca-blanca', label: 'Marca blanca', icon: <Tag className={iconClass} /> },
        ],
      },
      {
        section: 'Instrumentos',
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
      section: 'Su correo',
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
          : 'No se pudo cerrar la sesión. Compruebe la conexión e inténtelo de nuevo.',
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
      <div className="flex h-full flex-col bg-hoja">
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
                className="flex h-8 w-8 shrink-0 items-center justify-center border border-white/30 text-white hover:bg-white/10"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            ) : undefined
          }
        />
        <nav aria-label="Navegación principal" className="flex-1 overflow-y-auto px-2 py-3">
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
                          <span aria-hidden className={isActive ? 'text-laboratorio' : 'text-tinta-3'}>
                            {item.icon}
                          </span>
                          {item.label}
                          {item.badge === 'alerts' && avisosAbiertos > 0 && (
                            <>
                              <span
                                aria-hidden
                                className="valor ml-auto bg-fuera-fondo px-1.5 text-sm font-semibold text-fuera"
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

        <div className="flex items-center gap-2.5 border-t border-regla px-3 py-2.5">
          <span
            aria-hidden
            className="flex h-7 w-7 shrink-0 items-center justify-center bg-laboratorio font-estrecha
              text-micro font-semibold uppercase tracking-wider text-hoja"
          >
            {iniciales(user.name || user.email)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-tinta" title={user.email}>
              {user.name || user.email}
            </p>
            <p className="rotulo">{esAdmin ? 'Responsable' : 'Cliente'}</p>
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            disabled={saliendo}
            aria-label="Cerrar sesión"
            title="Cerrar sesión"
            className="flex h-7 w-7 shrink-0 items-center justify-center text-tinta-3 hover:bg-hoja-3 hover:text-tinta disabled:opacity-35"
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
      <aside className="hidden w-56 shrink-0 border-r border-regla lg:block">
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
            className="cajon-entrada absolute inset-y-0 left-0 w-64 max-w-[85vw] border-r border-regla-fuerte shadow-flotante"
          >
            {indice(true)}
          </div>
        </div>
      )}

      <div ref={contenidoRef} className="flex min-w-0 flex-1 flex-col">
        <header className="campo-lab flex items-center gap-3 px-4 py-2.5 lg:hidden">
          <button
            ref={menuRef}
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Abrir menú"
            aria-expanded={open}
            aria-haspopup="dialog"
            className="flex h-8 w-8 shrink-0 items-center justify-center border border-white/30 text-white
              hover:bg-white/10"
          >
            <Menu className="h-4 w-4" aria-hidden />
          </button>
          <span className="min-w-0 truncate font-estrecha text-md font-semibold uppercase tracking-[0.12em] text-white">
            {brand}
          </span>
        </header>

        <main
          ref={mainRef}
          id="contenido"
          tabIndex={-1}
          className="min-w-0 flex-1 px-4 py-5 focus:outline-none sm:px-6 sm:py-7"
        >
          {/* La clave remonta la vista con un fundido corto: la página nueva
              entra sin saltos en lugar de sustituir a la anterior de golpe. */}
          <div key={location.pathname} className="vista-entrada mx-auto max-w-6xl">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
