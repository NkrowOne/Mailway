import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type AdminDashboard, type AuditEntry, type ServerHealth } from '../../lib/api';
import { Cargando, Encabezado, Estado, Panel } from '../../ui/kit';
import { formatDate } from '../../lib/format';

const auditLabels: Record<string, string> = {
  'auth.login': 'Inicio de sesión',
  'client.created': 'Cliente creado',
  'client.updated': 'Cliente actualizado',
  'client.deleted': 'Cliente eliminado',
  'client.user_created': 'Usuario de panel creado',
  'domain.created': 'Dominio dado de alta',
  'domain.verified': 'Verificación de DNS',
  'domain.deleted': 'Dominio eliminado',
  'mailbox.created': 'Buzón creado',
  'mailbox.deleted': 'Buzón eliminado',
  'mailbox.password_reset': 'Contraseña restablecida',
  'alias.created': 'Alias creado',
  'apikey.created': 'Clave de API creada',
  'apikey.revoked': 'Clave de API revocada',
};

/**
 * Panel de operaciones del administrador: el estado de la nave de un vistazo.
 * Foco: ¿está el motor en marcha y el correo saliendo?
 */
export default function PanelAdmin() {
  const dashboard = useQuery({
    queryKey: ['admin-dashboard'],
    queryFn: () => api.get<AdminDashboard>('/api/dashboard/admin'),
    refetchInterval: 30_000,
  });
  const health = useQuery({
    queryKey: ['server-health'],
    queryFn: () => api.get<ServerHealth>('/api/deliverability/server'),
    staleTime: 5 * 60_000,
  });
  const audit = useQuery({
    queryKey: ['audit'],
    queryFn: () => api.get<{ entries: AuditEntry[] }>('/api/audit'),
  });

  if (dashboard.isPending) return <Cargando label="Leyendo el estado de la nave…" />;
  if (dashboard.isError || !dashboard.data) {
    return <p className="text-devuelto">No se pudo cargar el panel. Recarga la página.</p>;
  }

  const { totals, messages, engine, queue } = dashboard.data;
  const score = health.data?.score;
  const criticalRecs = (health.data?.recommendations ?? []).filter((r) => r.severity === 'critical');

  return (
    <>
      <Encabezado
        title="Panel de operaciones"
        meta={
          engine.ok ? (
            <Estado tone="entregado">Motor de correo en marcha</Estado>
          ) : (
            <Estado tone="devuelto">{engine.detail || 'Motor sin conexión'}</Estado>
          )
        }
      />

      {/* Línea de operación: una fila de manifiesto encadenada por chevrones
          de enrutado, no cuatro tarjetas KPI iguales. */}
      <Panel title="En marcha ahora" flush className="mb-4">
        <dl className="grid grid-cols-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]">
          <OperationCell
            label="Envíos API · 24 h"
            value={messages.last24h}
            detail={messages.failed24h > 0 ? `${messages.failed24h} fallidos` : 'sin fallos'}
            alert={messages.failed24h > 0}
          />
          <RoutingSep />
          <OperationCell
            label="Cola de salida"
            value={queue.pending}
            detail={queue.pending === 0 ? 'todo entregado' : 'mensajes esperando'}
            alert={queue.pending > 20}
          />
          <RoutingSep />
          <OperationCell
            label="Dominios en reparto"
            value={`${totals.domainsActive}/${totals.domains}`}
            detail="DNS verificado"
            alert={totals.domains > 0 && totals.domainsActive < totals.domains}
          />
          <RoutingSep />
          <OperationCell
            label="Reputación del servidor"
            value={score === undefined ? '…' : `${score}`}
            detail={score === undefined ? 'comprobando' : score >= 80 ? 'buena' : 'necesita atención'}
            alert={score !== undefined && score < 80}
          />
        </dl>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="La central en cifras" flush>
          <ul>
            <InventoryRow to="/clientes" label="Clientes" value={totals.clients} />
            <InventoryRow to="/dominios" label="Dominios" value={totals.domains} />
            <InventoryRow to="/buzones" label="Buzones" value={totals.mailboxes} />
            <InventoryRow to="/api-envio" label="Claves de API activas" value={totals.apiKeys} />
          </ul>
        </Panel>

        <Panel
          title="Avisos de entregabilidad"
          actions={
            <Link to="/entregabilidad" className="text-sm text-tinta-2 hover:text-tinta">
              Ver centro completo
            </Link>
          }
        >
          {health.isPending ? (
            <p className="text-sm text-tinta-3">Comprobando PTR y listas negras…</p>
          ) : criticalRecs.length === 0 ? (
            <div className="flex items-center gap-2.5 text-sm text-tinta-2">
              <Estado tone="entregado">Sin avisos críticos</Estado>
              El PTR, el registro A y las listas negras están en orden.
            </div>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {criticalRecs.slice(0, 3).map((rec) => (
                <li key={rec.title} className="flex items-start gap-2.5">
                  <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-devuelto" />
                  <div>
                    <p className="text-sm font-medium text-tinta">{rec.title}</p>
                    <p className="text-sm text-tinta-3">{rec.detail.slice(0, 140)}…</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* Movimiento reciente: la cinta en marcha, no un hueco muerto. */}
      <Panel
        title="Movimiento reciente"
        className="mt-4"
        actions={
          <Link to="/actividad" className="text-sm text-tinta-2 hover:text-tinta">
            Ver todo
          </Link>
        }
        flush
      >
        {audit.isPending ? (
          <p className="px-4 py-6 text-sm text-tinta-3">Cargando actividad…</p>
        ) : (audit.data?.entries.length ?? 0) === 0 ? (
          <p className="px-4 py-6 text-sm text-tinta-3">
            Aún no hay movimiento. Crea tu primer cliente para poner la central en marcha.
          </p>
        ) : (
          <ul>
            {(audit.data?.entries ?? []).slice(0, 8).map((entry) => {
              const detail = Object.entries(entry.detail)
                .filter(([k]) => k !== 'id')
                .map(([, v]) => String(v))
                .filter((v) => v && v.length < 48)
                .join(' · ');
              return (
                <li
                  key={entry.id}
                  className="flex items-center gap-3 border-b border-suave px-4 py-2 last:border-0"
                >
                  <span aria-hidden className="text-tinta-3">
                    <svg viewBox="0 0 16 12" className="h-2.5 w-4">
                      <path d="M1 1l5 5-5 5M8 1l5 5-5 5" stroke="currentColor" strokeWidth="1.6" fill="none" />
                    </svg>
                  </span>
                  <span className="text-sm font-medium text-tinta">
                    {auditLabels[entry.action] || entry.action}
                  </span>
                  {detail && (
                    <span className="min-w-0 flex-1 truncate font-guia text-micro text-tinta-3">{detail}</span>
                  )}
                  <span className="num shrink-0 font-guia text-micro text-tinta-3">
                    {formatDate(entry.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}

/** Chevron de enrutado que encadena las celdas de la línea de operación. */
function RoutingSep() {
  return (
    <div aria-hidden className="hidden items-center justify-center text-tinta-3 sm:flex">
      <svg viewBox="0 0 12 20" className="h-4 w-3">
        <path d="M2 3l5 7-5 7" stroke="currentColor" strokeWidth="1.4" fill="none" />
      </svg>
    </div>
  );
}

function OperationCell({
  label,
  value,
  detail,
  alert = false,
}: {
  label: string;
  value: number | string;
  detail: string;
  alert?: boolean;
}) {
  return (
    <div className="px-4 py-3">
      <dt className="text-sm text-tinta-3">{label}</dt>
      <dd className={`num mt-0.5 font-guia text-xl font-bold ${alert ? 'text-transito' : 'text-tinta'}`}>
        {value}
      </dd>
      <dd className={`text-sm ${alert ? 'text-transito' : 'text-tinta-3'}`}>{detail}</dd>
    </div>
  );
}

function InventoryRow({ to, label, value }: { to: string; label: string; value: number }) {
  return (
    <li className="border-b border-suave last:border-0">
      <Link to={to} className="flex items-center justify-between px-4 py-2.5 hover:bg-chasis-2">
        <span className="text-base text-tinta-2">{label}</span>
        <span className="num font-guia text-md font-bold text-tinta">{value}</span>
      </Link>
    </li>
  );
}
