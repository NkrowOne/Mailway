import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Building2, Globe2, Inbox, KeyRound } from 'lucide-react';
import { api, type AdminDashboard, type AuditEntry, type ServerHealth } from '../../lib/api';
import {
  Hoja,
  Marca,
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

  if (dashboard.isPending) return <Midiendo label="Cargando el resumen…" />;
  if (dashboard.isError || !dashboard.data) {
    return (
      <p className="border border-regla bg-fuera-fondo px-4 py-3 text-base text-fuera">
        No se pudo cargar el resumen. Comprueba que el servicio está en marcha y recarga la página.
      </p>
    );
  }

  const { totals, messages, engine, queue, instance } = dashboard.data;
  const score = health.data?.score;
  const recommendations = health.data?.recommendations ?? [];
  const criticos = recommendations.filter((r) => r.severity === 'critical');

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
  const estadoGlobal =
    veredictoGlobal === 'normal' ? 'Todo en orden' :
    veredictoGlobal === 'fuera' ? 'Requiere atención' :
    veredictoGlobal === 'vigilar' ? 'Hay puntos que revisar' : 'Comprobando el servicio';

  return (
    <>
      <header className="campo-lab relative mb-5 overflow-hidden rounded-xl px-5 pb-32 pt-6 shadow-panel sm:min-h-[224px] sm:px-7 sm:py-7 sm:pr-[36%]">
        <div className="relative z-10 max-w-2xl">
          <p className="mb-2 text-sm font-medium text-laboratorio-vivo">Vista general</p>
          <h1 className="titular text-3xl text-white sm:text-4xl">Resumen del servicio</h1>
          <p className="mt-3 flex flex-wrap gap-x-2 text-base text-white/70">
            <span>{instance.mailHostname || 'Servidor sin nombre'}</span>
            <span aria-hidden>·</span>
            <span>Actualizado {formatDate(Date.now())}</span>
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="inline-flex items-center gap-2 rounded-full bg-white/12 px-3 py-1.5 text-sm font-semibold text-white ring-1 ring-white/15">
              <span className={`h-2 w-2 rounded-full ${veredictoGlobal === 'normal' ? 'bg-emerald-300' : veredictoGlobal === 'vigilar' ? 'bg-amber-300' : veredictoGlobal === 'fuera' ? 'bg-rose-300' : 'bg-white/50'}`} />
              {estadoGlobal}
            </span>
            <span className="text-sm text-white/60">{veredictoGlobal === 'normal' ? 'Tu correo funciona correctamente.' : 'Consulta los detalles a continuación.'}</span>
          </div>
        </div>
        <img src="/mail-server.png" alt="" aria-hidden className="pointer-events-none absolute -bottom-10 right-0 h-[160px] w-[205px] object-contain object-bottom sm:-bottom-8 sm:h-[260px] sm:w-[350px] xl:right-6" />
      </header>

      <div className="mb-4 grid items-start gap-4 xl:grid-cols-[1.2fr_1fr]">
        <Hoja title="Estado general" meta="Indicadores clave" flush>
          <div className="grid grid-cols-2 sm:grid-cols-4 [&>*:nth-child(even)]:border-l [&>*:nth-child(even)]:border-regla sm:[&>*:nth-child(3)]:border-l sm:[&>*:nth-child(3)]:border-regla [&>*:nth-child(n+3)]:border-t [&>*:nth-child(n+3)]:border-regla sm:[&>*:nth-child(n+3)]:border-t-0">
            <ResumenNumero to="/clientes" value={totals.clients} label="Clientes" icon={<Building2 />} />
            <ResumenNumero to="/dominios" value={totals.domains} label="Dominios" icon={<Globe2 />} />
            <ResumenNumero to="/buzones" value={totals.mailboxes} label="Buzones" icon={<Inbox />} />
            <ResumenNumero to="/entregabilidad" value={score ?? '—'} suffix={score === undefined ? '' : '/100'} label="Reputación" icon={<span className="text-lg font-semibold leading-none">↗</span>} />
          </div>
          <div className="border-t border-regla px-4 py-2.5">
            <Link to="/entregabilidad" className="inline-flex items-center gap-1.5 text-sm font-medium text-laboratorio hover:underline">
              Ver estado del correo <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </Hoja>

        <Hoja title="Recomendaciones" meta="Qué conviene revisar" actions={<Link to="/entregabilidad" className="text-sm text-laboratorio hover:underline">Ver todas</Link>} flush>
          {health.isPending ? (
            <p className="px-4 py-5 text-base text-tinta-3">Comprobando la entregabilidad…</p>
          ) : recommendations.length === 0 ? (
            <div className="px-4 py-5">
              <Marca veredicto="normal">Sin recomendaciones pendientes</Marca>
              <p className="mt-1 text-sm text-tinta-2">No se han detectado problemas en la última comprobación.</p>
            </div>
          ) : (
            <ul>
              {recommendations.slice(0, 3).map((rec) => (
                <li key={`${rec.severity}-${rec.title}`} className="regla-fila last:border-b-0">
                  <Link to="/entregabilidad" className="group flex items-start gap-3 px-4 py-3 hover:bg-hoja-2">
                    <span aria-hidden className={`mt-0.5 h-9 w-0.5 shrink-0 rounded-full ${rec.severity === 'critical' ? 'bg-fuera' : rec.severity === 'warning' ? 'bg-vigilar' : 'bg-laboratorio-vivo'}`} />
                    <span className="min-w-0 flex-1"><span className="block text-base font-medium text-tinta">{rec.title}</span><span className="mt-0.5 block text-sm text-tinta-2">{rec.detail}</span></span>
                    <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-tinta-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Hoja>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Hoja title="Tu servicio" meta="Recursos activos" flush>
          <ul>
            <FilaRegistro to="/clientes" label="Clientes" valor={totals.clients} icon={<Building2 />} />
            <FilaRegistro to="/dominios" label="Dominios" valor={totals.domains} icon={<Globe2 />} />
            <FilaRegistro to="/buzones" label="Buzones" valor={totals.mailboxes} icon={<Inbox />} />
            <FilaRegistro to="/api-envio" label="Claves de API activas" valor={totals.apiKeys} icon={<KeyRound />} />
          </ul>
        </Hoja>

        <Hoja title="Actividad reciente" actions={<Link to="/actividad" className="text-sm text-laboratorio hover:underline">Ver todo</Link>} flush>
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
      </div>
    </>
  );
}

function ResumenNumero({ to, value, suffix, label, icon }: { to: string; value: number | string; suffix?: string; label: string; icon: ReactNode }) {
  return <Link to={to} className="group min-w-0 px-4 py-5 text-center transition-colors hover:bg-hoja-2">
    <span className="mb-3 flex h-5 items-center justify-center text-laboratorio [&>svg]:h-5 [&>svg]:w-5" aria-hidden>{icon}</span>
    <span className="valor block text-2xl font-semibold leading-tight text-tinta sm:text-3xl">{value}<span className="text-base font-normal text-tinta-3">{suffix}</span></span>
    <span className="mt-1 block text-sm text-tinta-2 group-hover:text-laboratorio">{label}</span>
  </Link>;
}

function FilaRegistro({ to, label, valor, icon }: { to: string; label: string; valor: number; icon: ReactNode }) {
  return (
    <li className="regla-fila last:border-b-0">
      <Link
        to={to}
        className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-hoja-3"
      >
        <span className="flex items-center gap-3 text-base text-tinta-2"><span className="text-laboratorio [&>svg]:h-4 [&>svg]:w-4" aria-hidden>{icon}</span>{label}</span>
        <span className="flex items-center gap-3"><span className="valor text-md font-medium text-tinta">{valor}</span><ArrowRight className="h-3.5 w-3.5 text-tinta-3" aria-hidden /></span>
      </Link>
    </li>
  );
}
