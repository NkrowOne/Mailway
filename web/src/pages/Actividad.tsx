import { useQuery } from '@tanstack/react-query';
import { api, type AuditEntry } from '../lib/api';
import { Cargando, Encabezado, Panel, Vacio } from '../ui/kit';
import { formatDate } from '../lib/format';

/** Diario de a bordo: quién hizo qué y cuándo. */
const actionLabels: Record<string, string> = {
  'auth.login': 'Inicio de sesión',
  'auth.password_changed': 'Cambio de contraseña',
  'setup.admin_created': 'Administrador creado',
  'setup.engine_configured': 'Motor configurado',
  'setup.instance_configured': 'Identidad configurada',
  'setup.completed': 'Puesta en marcha completada',
  'settings.instance_updated': 'Ajustes de identidad actualizados',
  'settings.engine_updated': 'Ajustes del motor actualizados',
  'plan.created': 'Plan creado',
  'plan.updated': 'Plan actualizado',
  'plan.deleted': 'Plan eliminado',
  'client.created': 'Cliente creado',
  'client.updated': 'Cliente actualizado',
  'client.deleted': 'Cliente eliminado',
  'client.user_created': 'Usuario de panel creado',
  'client.user_updated': 'Usuario de panel actualizado',
  'client.user_deleted': 'Usuario de panel eliminado',
  'domain.created': 'Dominio dado de alta',
  'domain.verified': 'Verificación de DNS',
  'domain.dkim_regenerated': 'DKIM regenerado',
  'domain.deleted': 'Dominio eliminado',
  'mailbox.created': 'Buzón creado',
  'mailbox.updated': 'Buzón actualizado',
  'mailbox.password_reset': 'Contraseña de buzón restablecida',
  'mailbox.deleted': 'Buzón eliminado',
  'alias.created': 'Alias creado',
  'alias.deleted': 'Alias eliminado',
  'apikey.created': 'Clave de API creada',
  'apikey.revoked': 'Clave de API revocada',
};

export default function Actividad() {
  const audit = useQuery({
    queryKey: ['audit'],
    queryFn: () => api.get<{ entries: AuditEntry[] }>('/api/audit'),
  });

  if (audit.isPending) return <Cargando />;

  const entries = audit.data?.entries ?? [];

  return (
    <>
      <Encabezado title="Actividad" meta="Registro de auditoría: cada acción queda anotada." />
      <Panel flush>
        {entries.length === 0 ? (
          <Vacio title="Sin actividad todavía" />
        ) : (
          <ul>
            {entries.map((entry) => {
              const detail = Object.entries(entry.detail)
                .filter(([k]) => k !== 'id')
                .map(([, v]) => String(v))
                .filter((v) => v && v.length < 60)
                .join(' · ');
              return (
                <li
                  key={entry.id}
                  className="flex items-baseline gap-3 border-b border-suave px-4 py-2 last:border-0"
                >
                  <span className="num w-32 shrink-0 font-guia text-micro text-tinta-3">
                    {formatDate(entry.createdAt)}
                  </span>
                  <span className="text-sm font-medium text-tinta">
                    {actionLabels[entry.action] || entry.action}
                  </span>
                  {detail && <span className="min-w-0 truncate text-sm text-tinta-3">{detail}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
