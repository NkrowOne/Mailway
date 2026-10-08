import { lazy, Suspense, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, type SetupStatus, type User } from './lib/api';
// Se lee aquí, en el paquete principal, para capturar la dirección de arranque
// antes de cualquier redirección (la pantalla de acceso se descarga después).
import { enlaceDeArranque } from './lib/arranque';
import { Cargando } from './ui/kit';

/*
  Cada área se descarga cuando se visita. El titular que abre su enlace de
  configuración en el móvil solo baja el portal, no el panel de
  administración entero; y quien administra no baja el portal.
*/
const PortalApp = lazy(() => import('./pages/portal/PortalApp'));
// El enlace de bienvenida lo abre la empresa cliente antes de tener cuenta:
// tampoco necesita el panel para crear su acceso.
const Bienvenida = lazy(() => import('./pages/bienvenida/Bienvenida'));
// El marco del panel (índice, iconos) tampoco lo necesita el titular del buzón.
const AppShell = lazy(() => import('./shell/AppShell').then((m) => ({ default: m.AppShell })));
const Login = lazy(() => import('./pages/Login'));
const Setup = lazy(() => import('./pages/Setup'));
const PanelAdmin = lazy(() => import('./pages/admin/PanelAdmin'));
const Clientes = lazy(() => import('./pages/admin/Clientes'));
const ClienteDetalle = lazy(() => import('./pages/admin/ClienteDetalle'));
const Entregabilidad = lazy(() => import('./pages/admin/Entregabilidad'));
const Ajustes = lazy(() => import('./pages/admin/Ajustes'));
const Avisos = lazy(() => import('./pages/admin/Avisos'));
const Planes = lazy(() => import('./pages/admin/Planes'));
const MarcaBlanca = lazy(() => import('./pages/MarcaBlanca'));
const InicioCliente = lazy(() => import('./pages/InicioCliente'));
const PuestaEnMarcha = lazy(() => import('./pages/PuestaEnMarcha'));
const Dominios = lazy(() => import('./pages/Dominios'));
const DominioDetalle = lazy(() => import('./pages/DominioDetalle'));
const Buzones = lazy(() => import('./pages/Buzones'));
const Alias = lazy(() => import('./pages/Alias'));
const ApiKeys = lazy(() => import('./pages/ApiKeys'));
const Formularios = lazy(() => import('./pages/Formularios'));
const Actividad = lazy(() => import('./pages/Actividad'));
const Cuenta = lazy(() => import('./pages/Cuenta'));
const Conexiones = lazy(() => import('./pages/Conexiones'));

/**
 * Las páginas del titular del buzón (enlace de configuración y «Mi buzón»)
 * viven fuera del panel: no dependen de la sesión de usuario del panel ni del
 * asistente de puesta en marcha.
 */
export function esRutaPortal(pathname: string): boolean {
  return pathname.startsWith('/conectar/') || pathname === '/mi-buzon' || pathname.startsWith('/mi-buzon/');
}

/**
 * El enlace de bienvenida de la empresa cliente también queda fuera: quien lo
 * abre aún no tiene usuario, y la puerta de acceso del panel lo mandaría a
 * iniciar sesión con una cuenta que todavía no existe.
 */
export function esRutaBienvenida(pathname: string): boolean {
  return pathname.startsWith('/bienvenida/');
}

/** Mientras llega el código de una vista, el indicador de carga del sistema. */
function ConCarga({ pantalla = false, children }: { pantalla?: boolean; children: ReactNode }) {
  return (
    <Suspense
      fallback={
        pantalla ? (
          <div className="grid min-h-screen place-items-center">
            <Cargando label="Cargando…" />
          </div>
        ) : (
          <Cargando label="Cargando…" />
        )
      }
    >
      {children}
    </Suspense>
  );
}

export default function App() {
  const location = useLocation();
  if (esRutaPortal(location.pathname)) {
    return (
      <ConCarga pantalla>
        <PortalApp />
      </ConCarga>
    );
  }
  if (esRutaBienvenida(location.pathname)) {
    return (
      <ConCarga pantalla>
        <Routes>
          <Route path="/bienvenida/:token" element={<Bienvenida />} />
        </Routes>
      </ConCarga>
    );
  }
  return <PanelApp />;
}

function PanelApp() {
  const location = useLocation();
  // Al volver a entrar se regresa a la página que se intentaba abrir.
  const irALogin = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  const setup = useQuery({
    queryKey: ['setup'],
    queryFn: () => api.get<SetupStatus>('/api/setup/status'),
  });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User | null }>('/api/auth/me'),
  });

  if (setup.isPending || me.isPending) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Cargando label="Preparando tu panel…" />
      </div>
    );
  }

  if (setup.isError) {
    return (
      <div className="grid min-h-screen place-items-center px-6 text-center">
        <div>
          <p className="text-lg font-semibold">No se ha podido contactar con el servidor de Mailway.</p>
          <p className="mt-1 text-sm text-tinta-2">
            Comprueba que el servicio está en marcha y vuelve a cargar la página.
          </p>
        </div>
      </div>
    );
  }

  const user = me.data?.user ?? null;
  const status = setup.data!;
  // Sin sesión, el estado llega recortado: la marca es lo único seguro.
  const marca = status.instance?.brandName || 'Mailway';
  const needsSetup = !status.setupComplete;

  // Si el administrador ya existe pero no hay sesión (caducó, otro
  // navegador…), el asistente no puede continuar: primero hay que entrar.
  if (needsSetup && status.hasAdmin && !user) {
    return (
      <ConCarga pantalla>
        <Routes>
          <Route path="/login" element={<Login brand={marca} enlaceDeArranque={enlaceDeArranque} />} />
          <Route path="*" element={<Navigate to={irALogin} replace />} />
        </Routes>
      </ConCarga>
    );
  }

  if (needsSetup) {
    return (
      <ConCarga pantalla>
        <Routes>
          <Route path="/setup" element={<Setup status={status} user={user} />} />
          <Route path="*" element={<Navigate to="/setup" replace />} />
        </Routes>
      </ConCarga>
    );
  }

  if (!user) {
    return (
      <ConCarga pantalla>
        <Routes>
          <Route path="/login" element={<Login brand={marca} enlaceDeArranque={enlaceDeArranque} />} />
          <Route path="*" element={<Navigate to={irALogin} replace />} />
        </Routes>
      </ConCarga>
    );
  }

  const isAdmin = user.role === 'admin';
  return (
    <ConCarga pantalla>
      <AppShell user={user} brand={marca}>
        {/* Dentro del marco: al cambiar de vista, la navegación sigue en su
            sitio mientras llega el código de la nueva. */}
        <ConCarga>
          <Routes>
            {isAdmin ? (
              <>
                <Route path="/" element={<PanelAdmin />} />
                <Route path="/clientes" element={<Clientes />} />
                {/* La ficha del cliente lleva sus propias pestañas (dominios, buzones…). */}
                <Route path="/clientes/:id/*" element={<ClienteDetalle user={user} />} />
                <Route path="/entregabilidad" element={<Entregabilidad />} />
                <Route path="/avisos" element={<Avisos />} />
                <Route path="/planes" element={<Planes />} />
                <Route path="/ajustes" element={<Ajustes />} />
                {/* La puesta en marcha es del cliente: la administración tiene su resumen. */}
                <Route path="/puesta-en-marcha" element={<Navigate to="/" replace />} />
              </>
            ) : (
              <>
                <Route path="/" element={<InicioCliente />} />
                <Route path="/puesta-en-marcha" element={<PuestaEnMarcha />} />
              </>
            )}
            <Route path="/dominios" element={<Dominios isAdmin={isAdmin} />} />
            <Route path="/dominios/:id" element={<DominioDetalle />} />
            <Route path="/buzones" element={<Buzones />} />
            <Route path="/alias" element={<Alias />} />
            <Route path="/marca-blanca" element={<MarcaBlanca isAdmin={isAdmin} />} />
            <Route path="/api-envio" element={<ApiKeys user={user} />} />
            <Route path="/formularios" element={<Formularios user={user} />} />
            <Route path="/actividad" element={<Actividad />} />
            <Route path="/cuenta" element={<Cuenta />} />
            <Route path="/conexiones" element={<Conexiones isAdmin={isAdmin} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ConCarga>
      </AppShell>
    </ConCarga>
  );
}
