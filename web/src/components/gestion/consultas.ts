import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  type Client,
  type ClientDashboard,
  type ClientDomain,
  type ClientUsage,
  type Plan,
  type User,
} from '../../lib/api';

/** Usuario de la sesión (la consulta ya la hace App; aquí sale de la caché). */
export function useUsuario(): User | null {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User | null }>('/api/auth/me'),
  });
  return me.data?.user ?? null;
}

export interface FichaCliente {
  id: string;
  name: string;
  suspended: boolean;
  plan: Plan;
  usage: ClientUsage;
}

/**
 * Plan, uso y estado de los clientes visibles: el administrador los lee de
 * /api/clients; un usuario de cliente, de su propio panel. Sirve para topar
 * cuotas, explicar límites y saber si un cliente está suspendido.
 */
export function useClientes(user: User | null): {
  clientes: Map<string, FichaCliente>;
  lista: FichaCliente[];
  cargando: boolean;
} {
  const isAdmin = user?.role === 'admin';
  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: Client[] }>('/api/clients'),
    enabled: user !== null && isAdmin,
  });
  const dashboard = useQuery({
    queryKey: ['client-dashboard'],
    queryFn: () => api.get<ClientDashboard>('/api/dashboard/client'),
    enabled: user !== null && !isAdmin,
  });

  return useMemo(() => {
    const lista: FichaCliente[] = [];
    if (isAdmin) {
      for (const c of clients.data?.clients ?? []) {
        if (c.plan && c.usage) {
          lista.push({ id: c.id, name: c.name, suspended: c.suspended, plan: c.plan, usage: c.usage });
        }
      }
    } else if (dashboard.data) {
      const d = dashboard.data;
      lista.push({ id: d.client.id, name: d.client.name, suspended: d.client.suspended, plan: d.plan, usage: d.usage });
    }
    return {
      clientes: new Map(lista.map((c) => [c.id, c])),
      lista,
      cargando: isAdmin ? clients.isPending : dashboard.isPending,
    };
  }, [isAdmin, clients.data, clients.isPending, dashboard.data, dashboard.isPending]);
}

/** Dirección sin barra final, para componer rutas (`${base}/mi-buzon`). */
function sinBarraFinal(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Dirección del panel que se entrega a otras personas (credenciales de un
 * usuario, enlaces de «Mi buzón», ejemplos de la API). Si el administrador
 * entra por la IP o una URL interna, eso no es lo que debe recibir el
 * cliente: se usa la URL pública configurada en Ajustes y, para un cliente
 * con panel propio de marca blanca ya activo, su dominio. La dirección del
 * navegador queda como último recurso.
 *
 * `clientId`: cliente cuyo panel se quiere (el administrador); sin él, el del
 * usuario de cliente que ha iniciado sesión.
 */
export function useDireccionPanel(opciones: { clientId?: string | null; user?: User | null } = {}): string {
  const { clientId, user } = opciones;
  // La URL pública la da el servidor: la de Ajustes o, si no hay, la de la
  // petición. /api/setup/status no sirve aquí: sin sesión de administración
  // ya no incluye la identidad de la instancia.
  const info = useQuery({
    queryKey: ['integrations-info'],
    queryFn: () => api.get<{ panelUrl?: string }>('/api/integrations/info'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const esCliente = user?.role === 'client';
  const idCliente = esCliente ? user?.clientId ?? null : clientId ?? null;
  // Mismas claves que «Marca blanca»: comparten caché e invalidaciones.
  const marcaBlanca = useQuery({
    queryKey: ['whitelabel-domains', esCliente ? 'propio' : (idCliente ?? '')],
    queryFn: () =>
      api.get<{ domains: ClientDomain[] }>(
        esCliente ? '/api/whitelabel/domains' : `/api/whitelabel/domains?clientId=${encodeURIComponent(idCliente ?? '')}`,
      ),
    enabled: Boolean(idCliente),
    // Si la marca blanca no está disponible, basta con la URL de la instancia.
    retry: false,
  });
  const panelPropio = marcaBlanca.data?.domains.find(
    (d) => d.kind === 'panel' && d.status === 'active' && (!idCliente || d.clientId === idCliente),
  );
  if (panelPropio) return `https://${panelPropio.hostname}`;
  const configurada = info.data?.panelUrl;
  if (configurada) return sinBarraFinal(configurada);
  return typeof window !== 'undefined' ? window.location.origin : '';
}
