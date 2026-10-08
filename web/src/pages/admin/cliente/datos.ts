import { useQueryClient } from '@tanstack/react-query';
import type { Client, ClientUsage, Plan } from '../../../lib/api';
import type { ClientUser } from '../../../lib/gestion';
import type { ConfirmarCierre } from '../../../ui/kit';

/** Respuesta de GET /api/clients/:id (plan, uso y usuarios pueden venir dentro o al lado). */
export interface RespuestaCliente {
  client: Client & { plan?: Plan; usage?: ClientUsage; users?: ClientUser[] };
  plan?: Plan;
  usage?: ClientUsage;
  users?: ClientUser[];
}

/** Lo que la ficha del cliente reparte entre sus pestañas, ya leído. */
export interface ContextoCliente {
  id: string;
  cliente: Client;
  plan?: Plan;
  usage?: ClientUsage;
  usuarios: ClientUser[];
}

/** Pregunta antes de cerrar un diálogo con una contraseña recién generada. */
export const CONFIRMAR_CONTRASENA: ConfirmarCierre = {
  pregunta: '¿Has guardado la contraseña?',
  detalle: 'No se podrá volver a ver.',
};

/**
 * Tras cambiar algo del cliente: su ficha, la lista de clientes, los planes
 * (cuentan sus clientes) y los buzones (la suspensión cambia su estado).
 */
export function useRefrescarCliente(id: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['client', id] }),
      queryClient.invalidateQueries({ queryKey: ['clients'] }),
      queryClient.invalidateQueries({ queryKey: ['plans'] }),
      queryClient.invalidateQueries({ queryKey: ['mailboxes'] }),
    ]);
}
