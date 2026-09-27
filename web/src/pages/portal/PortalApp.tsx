import { Navigate, Route, Routes } from 'react-router-dom';
import ConectarPagina from './ConectarPagina';
import MiBuzon from './MiBuzon';

/**
 * Portal del titular del buzón: enlace de configuración de dispositivos
 * (/conectar/:token) y «Mi buzón» (/mi-buzon). Vive fuera del panel: no usa
 * la sesión de usuario del panel ni su navegación, porque quien lo abre es
 * el empleado que usa el buzón, no quien lo administra.
 */
export default function PortalApp() {
  return (
    <Routes>
      <Route path="/conectar/:token" element={<ConectarPagina />} />
      <Route path="/mi-buzon" element={<MiBuzon />} />
      <Route path="*" element={<Navigate to="/mi-buzon" replace />} />
    </Routes>
  );
}
