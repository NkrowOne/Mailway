import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type AdminDashboard, type AuditEntry, type ServerHealth } from '../../lib/api';
import {
  CabeceraMedidas,
  Hoja,
  Marca,
  Medida,
  Membrete,
  Midiendo,
  type Veredicto,
} from '../../ui/kit';
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
  'whitelabel.domain_created': 'Dominio de marca blanca',
  'whitelabel.domain_verified': 'Marca blanca verificada',
};

interface Constante {
  concepto: string;
  valor: string | number;
  unidad?: string;
  referencia: string;
  veredicto: Veredicto;
  nota?: string;
}

/** Fuera de rango primero: lo que está mal se lee antes que lo que está bien. */
const peso: Record<Veredicto, number> = { fuera: 0, vigilar: 1, 'sin-dato': 2, normal: 3 };

function ordenarPorVeredicto(lista: Constante[]): Constante[] {
  return [...lista].sort((a, b) => peso[a.veredicto] - peso[b.veredicto]);
}

/**
 * Parte de la instancia: las constantes del servicio en una sola tabla de
 * mediciones, con lo que está fuera de rango arrastrado arriba.
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

  if (dashboard.isPending) return <Midiendo label="Midiendo las constantes…" />;
  if (dashboard.isError || !dashboard.data) {
    return (
      <p className="border border-regla bg-fuera-fondo px-4 py-3 text-base text-fuera">
        No se pudo leer el parte. Comprueba que el servicio está en marcha y recarga la página.
      </p>
    );
  }

  const { totals, messages, engine, queue, instance } = dashboard.data;
  const score = health.data?.score;
  const criticos = (health.data?.recommendations ?? []).filter((r) => r.severity === 'critical');

  const constantes: Constante[] = [
    {
      concepto: 'Servidor de correo',
      valor: engine.ok ? 'En marcha' : 'Sin conexión',
      referencia: 'En marcha',
      veredicto: engine.ok ? 'normal' : 'fuera',
      nota: engine.ok ? undefined : engine.detail,
    },
    {
      concepto: 'Cola de salida',
      valor: queue.pending,
      unidad: queue.pending === 1 ? 'mensaje' : 'mensajes',
      referencia: '< 20',
      veredicto: queue.pending >= 50 ? 'fuera' : queue.pending >= 20 ? 'vigilar' : 'normal',
      nota:
        queue.pending >= 20
          ? 'Los mensajes se acumulan sin entregarse. Suele ser el puerto 25 bloqueado o un destino rechazando.'
          : undefined,
    },
    {
      concepto: 'Envíos fallidos · 24 h',
      valor: messages.failed24h,
      unidad: `de ${messages.last24h}`,
      referencia: '0',
      veredicto: messages.failed24h > 0 ? 'vigilar' : 'normal',
    },
    {
      concepto: 'Dominios con DNS verificado',
      valor: `${totals.domainsActive}/${totals.domains}`,
      referencia: 'todos',
      veredicto:
        totals.domains === 0
          ? 'sin-dato'
          : totals.domainsActive === totals.domains
            ? 'normal'
            : 'vigilar',
    },
    {
      concepto: 'Reputación del servidor',
      valor: score === undefined ? '—' : score,
      unidad: score === undefined ? undefined : '/100',
      referencia: '≥ 80',
      veredicto:
        score === undefined ? 'sin-dato' : score >= 80 ? 'normal' : score >= 50 ? 'vigilar' : 'fuera',
    },
  ];

  // El veredicto del membrete resume TODAS las constantes, no solo el motor:
  // decir «en rango» con una fila en rojo justo debajo sería mentir al lector.
  const peor = ordenarPorVeredicto(constantes)[0]?.veredicto ?? 'sin-dato';
  const veredictoGlobal: Veredicto =
    criticos.length > 0 && peor !== 'fuera' ? 'fuera' : peor;

  return (
    <>
      <Membrete
        title="Parte de la instancia"
        meta={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="valor text-sm text-tinta-2">
              {instance.mailHostname || 'servidor sin nombre'}
            </span>
            <span className="text-sm text-tinta-3">Medido {formatDate(Date.now())}</span>
          </span>
        }
        actions={
          <Marca veredicto={veredictoGlobal}>
            {veredictoGlobal === 'normal'
              ? 'Todo en rango'
              : veredictoGlobal === 'fuera'
                ? 'Requiere atención'
                : veredictoGlobal === 'vigilar'
                  ? 'Con avisos'
                  : 'Sin datos'}
          </Marca>
        }
      />

      <Hoja title="Constantes" meta="Fuera de rango primero" className="mb-4">
        <CabeceraMedidas />
        {ordenarPorVeredicto(constantes).map((c) => (
          <Medida
            key={c.concepto}
            concepto={c.concepto}
            valor={c.valor}
            unidad={c.unidad}
            referencia={c.referencia}
            veredicto={c.veredicto}
            nota={c.nota}
          />
        ))}
      </Hoja>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Hoja
          title="Hallazgos"
          meta="Entregabilidad"
          actions={
            <Link
              to="/entregabilidad"
              className="text-sm text-laboratorio underline underline-offset-2 hover:text-tinta"
            >
              Ver informe completo
            </Link>
          }
          flush
        >
          {health.isPending ? (
            <p className="px-4 py-5 text-base text-tinta-3">
              Comprobando PTR, registro A y listas negras…
            </p>
          ) : criticos.length === 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-5">
              <Marca veredicto="normal">Sin hallazgos</Marca>
              <span className="text-base text-tinta-2">
                El PTR, el registro A y las listas negras están en orden.
              </span>
            </div>
          ) : (
            <ul>
              {criticos.slice(0, 3).map((rec) => (
                <li key={rec.title} className="regla-fila px-4 py-3 last:border-b-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p className="text-base font-medium text-tinta">{rec.title}</p>
                    <Marca veredicto="fuera" />
                  </div>
                  <p className="mt-0.5 text-sm text-tinta-2">{rec.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </Hoja>

        <Hoja title="Registro" meta="Altas en la instancia" flush>
          <ul>
            <FilaRegistro to="/clientes" label="Clientes" valor={totals.clients} />
            <FilaRegistro to="/dominios" label="Dominios" valor={totals.domains} />
            <FilaRegistro to="/buzones" label="Buzones" valor={totals.mailboxes} />
            <FilaRegistro to="/api-envio" label="Claves de API activas" valor={totals.apiKeys} />
          </ul>
        </Hoja>
      </div>

      <Hoja
        title="Movimiento reciente"
        className="mt-4"
        actions={
          <Link
            to="/actividad"
            className="text-sm text-laboratorio underline underline-offset-2 hover:text-tinta"
          >
            Ver todo
          </Link>
        }
        flush
      >
        {audit.isPending ? (
          <p className="px-4 py-5 text-base text-tinta-3">Cargando actividad…</p>
        ) : (audit.data?.entries.length ?? 0) === 0 ? (
          <p className="px-4 py-5 text-base text-tinta-3">
            Todavía no hay movimiento. Crea tu primer cliente para empezar.
          </p>
        ) : (
          <ul>
            {(audit.data?.entries ?? []).slice(0, 8).map((entry) => {
              const detalle = Object.entries(entry.detail)
                .filter(([k]) => k !== 'id')
                .map(([, v]) => String(v))
                .filter((v) => v && v.length < 48)
                .join(' · ');
              return (
                <li
                  key={entry.id}
                  className="regla-fila flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2 last:border-b-0"
                >
                  <span className="text-base text-tinta">
                    {auditLabels[entry.action] || entry.action}
                  </span>
                  {detalle && (
                    <span className="valor min-w-0 flex-1 truncate text-sm text-tinta-3">
                      {detalle}
                    </span>
                  )}
                  <span className="valor ml-auto shrink-0 text-sm text-tinta-3">
                    {formatDate(entry.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Hoja>
    </>
  );
}

function FilaRegistro({ to, label, valor }: { to: string; label: string; valor: number }) {
  return (
    <li className="regla-fila last:border-b-0">
      <Link
        to={to}
        className="flex items-baseline justify-between gap-3 px-4 py-2.5 hover:bg-hoja-3"
      >
        <span className="text-base text-tinta-2">{label}</span>
        <span className="valor text-md font-medium text-tinta">{valor}</span>
      </Link>
    </li>
  );
}
