import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api, type SetupStatus, type User } from './lib/api';
import { AppShell } from './shell/AppShell';
import { Midiendo } from './ui/kit';
import Login from './pages/Login';
import Setup from './pages/Setup';
import PanelAdmin from './pages/admin/PanelAdmin';
import Clientes from './pages/admin/Clientes';
import ClienteDetalle from './pages/admin/ClienteDetalle';
import Entregabilidad from './pages/admin/Entregabilidad';
import Ajustes from './pages/admin/Ajustes';
import Avisos from './pages/admin/Avisos';
import MarcaBlanca from './pages/MarcaBlanca';
import InicioCliente from './pages/InicioCliente';
import Dominios from './pages/Dominios';
import DominioDetalle from './pages/DominioDetalle';
import Buzones from './pages/Buzones';
import Alias from './pages/Alias';
import ApiKeys from './pages/ApiKeys';
import Actividad from './pages/Actividad';
import Cuenta from './pages/Cuenta';

export default function App() {
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
        <Midiendo label="Preparando el informe…" />
      </div>
    );
  }

  if (setup.isError) {
    return (
      <div className="grid min-h-screen place-items-center px-6 text-center">
        <div>
          <p className="text-lg font-semibold">No se pudo contactar con el servidor de Mailway.</p>
          <p className="mt-1 text-sm text-tinta-2">
            Comprueba que el servicio está en marcha y recarga la página.
          </p>
        </div>
      </div>
    );
  }

  const user = me.data?.user ?? null;
  const status = setup.data!;
  const needsSetup = !status.setupComplete;

  if (needsSetup) {
    return (
      <Routes>
        <Route path="/setup" element={<Setup status={status} user={user} />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login brand={status.instance.brandName} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const isAdmin = user.role === 'admin';
  return (
    <AppShell user={user} brand={status.instance.brandName}>
      <Routes>
        {isAdmin ? (
          <>
            <Route path="/" element={<PanelAdmin />} />
            <Route path="/clientes" element={<Clientes />} />
            <Route path="/clientes/:id" element={<ClienteDetalle />} />
            <Route path="/entregabilidad" element={<Entregabilidad />} />
            <Route path="/avisos" element={<Avisos />} />
            <Route path="/ajustes" element={<Ajustes />} />
          </>
        ) : (
          <Route path="/" element={<InicioCliente />} />
        )}
        <Route path="/dominios" element={<Dominios isAdmin={isAdmin} />} />
        <Route path="/dominios/:id" element={<DominioDetalle />} />
        <Route path="/buzones" element={<Buzones />} />
        <Route path="/alias" element={<Alias />} />
        <Route path="/marca-blanca" element={<MarcaBlanca />} />
        <Route path="/api-envio" element={<ApiKeys user={user} />} />
        <Route path="/actividad" element={<Actividad />} />
        <Route path="/cuenta" element={<Cuenta />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
