import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Client, type ClientDashboard, type ClientUsage, type Plan, type User } from '../../lib/api';

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
