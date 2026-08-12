import { useQuery } from '@tanstack/react-query';
import { api, type AuditEntry } from '../lib/api';
import { Hoja, Membrete, Midiendo, Vacio } from '../ui/kit';
import { formatDate, plural } from '../lib/format';

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

  const entries = audit.data?.entries ?? [];

  return (
    <>
      <Membrete
        title="Actividad"
        meta={
          <>
            <p>Registro de auditoría: cada acción queda anotada.</p>
            {!audit.isPending && entries.length > 0 && (
              <p className="rotulo mt-1.5">
                {plural(entries.length, 'anotación', 'anotaciones')}
              </p>
            )}
          </>
        }
      />

      <Hoja flush>
        {audit.isPending ? (
          <Midiendo label="Midiendo actividad…" />
        ) : entries.length === 0 ? (
          <Vacio title="Sin actividad todavía" />
        ) : (
          <>
            {/* Cabecera de columnas: la fecha y el detalle van en cifras. */}
            <div className="regla-cabecera hidden items-baseline gap-x-4 px-4 py-2 sm:flex">
              <span className="rotulo w-32 shrink-0">Fecha</span>
              <span className="rotulo min-w-0 grow basis-40">Acción</span>
              <span className="rotulo min-w-0 grow-[1.2] basis-0">Detalle</span>
            </div>

            {entries.map((entry) => {
              const detail = Object.entries(entry.detail)
                .filter(([k]) => k !== 'id')
                .map(([, v]) => String(v))
                .filter((v) => v && v.length < 60)
                .join(' · ');
              return (
                <div
                  key={entry.id}
                  className="regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-0.5 px-4 py-2
                    transition-colors duration-100 last:border-b-0 hover:bg-hoja-2"
                >
                  <span className="valor w-32 shrink-0 text-sm text-tinta-3">
                    {formatDate(entry.createdAt)}
                  </span>
                  {/* La acción identifica la anotación: nunca truncada. */}
                  <span className="min-w-0 grow basis-40 break-words text-base text-tinta">
                    {actionLabels[entry.action] || entry.action}
                  </span>
                  {detail && (
                    <span className="valor min-w-0 grow-[1.2] basis-full break-all text-sm text-tinta-3 sm:basis-0">
                      {detail}
                    </span>
                  )}
                </div>
              );
            })}
          </>
        )}
      </Hoja>
    </>
  );
}
