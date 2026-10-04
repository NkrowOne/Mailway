import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, Building2, Globe2, History, Inbox, KeyRound, Radar } from 'lucide-react';
import { api, type AdminDashboard, type AuditEntry, type ServerHealth } from '../../lib/api';
import {
  AvisoError,
  CabeceraMedidas,
  Hoja,
  Marca,
  MarcaFondo,
  Medida,
  Membrete,
  Cargando,
  Vacio,
  type Veredicto,
} from '../../ui/kit';
import { estiloBoton } from '../../ui/Button';
import { formatDate } from '../../lib/format';
import { medicionCompleta, TEXTO_MEDICION_INCOMPLETA } from '../../lib/entregabilidad';
import { autorAnotacion, detalleAnotacion, etiquetaAccion } from '../../lib/tokens';

/**
 * Atajos a las altas y conexiones más frecuentes, sin buscarlas en el índice.
 * Las altas llevan `?nuevo=1`: la vista abre su diálogo directamente, que es
 * lo que promete el texto del botón.
 */
const accesosRapidos: { to: string; label: string }[] = [
  { to: '/clientes?nuevo=1', label: 'Alta de cliente' },
  { to: '/dominios?nuevo=1', label: 'Añadir dominio' },
  { to: '/buzones?nuevo=1', label: 'Crear buzón' },
  { to: '/conexiones', label: 'Conexiones' },
  { to: '/planes', label: 'Planes' },
  { to: '/ajustes', label: 'Ajustes' },
];

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

/** Las recomendaciones, también por gravedad: lo crítico antes que lo informativo. */
const pesoSeveridad: Record<string, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Resumen de la instancia: el estado general de un vistazo, las
 * recomendaciones de entregabilidad, las constantes del servicio (con lo que
 * está fuera de rango arrastrado arriba) y la actividad reciente.
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

  if (dashboard.isPending) return <Cargando label="Cargando el resumen…" />;
  // Solo se sustituye la página si nunca hubo lectura: un sondeo fallido con
  // datos previos se avisa con una banda y se conservan los valores medidos.
  if (!dashboard.data) {
    return (
      <>
        <Membrete title="Resumen del servicio" />
        <AvisoError onRetry={() => void dashboard.refetch()} retrying={dashboard.isFetching}>
          No se ha podido cargar el resumen. Comprueba que el servicio está en marcha y vuelve a intentarlo.
        </AvisoError>
      </>
    );
  }

  const { totals, messages, engine, queue, instance } = dashboard.data;
  // Sin respuesta de salud, o con una medición a medias (DNS sin respuesta),
  // no hay veredicto de reputación: se dice «sin datos», nunca «en orden».
  const completa = health.data ? medicionCompleta(health.data) : false;
  const score = health.isError || !completa ? undefined : health.data?.score;
  const recomendaciones = [...(health.data?.recommendations ?? [])].sort(
    (a, b) => (pesoSeveridad[a.severity] ?? 3) - (pesoSeveridad[b.severity] ?? 3),
  );
  const criticos = recomendaciones.filter((r) => r.severity === 'critical');

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
          ? 'Los mensajes se acumulan sin entregarse. Suele deberse al puerto 25 bloqueado o a un destino que los rechaza.'
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
      nota: health.isError
        ? 'No se ha podido consultar el PTR, el registro A ni las listas negras. Repite la comprobación desde Entregabilidad.'
        : health.data && !completa
          ? TEXTO_MEDICION_INCOMPLETA
          : undefined,
    },
  ];

  // El veredicto de la cabecera resume TODAS las constantes, no solo el motor:
  // decir «todo en orden» con una fila en rojo justo debajo sería mentir al lector.
  const peor = ordenarPorVeredicto(constantes)[0]?.veredicto ?? 'sin-dato';
  const veredictoGlobal: Veredicto =
    criticos.length > 0 && peor !== 'fuera' ? 'fuera' : peor;
  const estadoGlobal =
    veredictoGlobal === 'normal'
      ? 'Todo en orden'
      : veredictoGlobal === 'fuera'
        ? 'Requiere atención'
        : veredictoGlobal === 'vigilar'
          ? 'Hay puntos que revisar'
          : health.isFetching
            ? 'Comprobando el servicio'
            : 'Sin datos suficientes';
  const entradas = audit.data?.entries ?? [];

  return (
    <>
      <Membrete
        title="Resumen del servicio"
        meta={
          <>
            <p className="flex flex-wrap gap-x-2">
              <span className="[overflow-wrap:anywhere]">{instance.mailHostname || 'Servidor sin nombre'}</span>
              <span aria-hidden>·</span>
              {/* La hora de la última lectura real, no la del reloj: si el
                  sondeo falla, la hora no debe seguir avanzando. */}
              <span>Actualizado {formatDate(dashboard.dataUpdatedAt)}</span>
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <MarcaFondo veredicto={veredictoGlobal}>{estadoGlobal}</MarcaFondo>
              <span className="text-sm text-tinta-2">
                {veredictoGlobal === 'normal'
                  ? 'Tu correo funciona correctamente.'
                  : 'Consulta los detalles a continuación.'}
              </span>
            </div>
          </>
        }
      />

      {dashboard.isRefetchError && (
        <AvisoError
          className="mb-4"
          onRetry={() => void dashboard.refetch()}
          retrying={dashboard.isFetching}
        >
          No se ha podido actualizar el resumen. Se muestran los valores leídos a las{' '}
          {formatDate(dashboard.dataUpdatedAt)}.
        </AvisoError>
      )}

      <div className="mb-4 grid items-start gap-4 xl:grid-cols-[1.2fr_1fr]">
        <Hoja title="Estado general" meta="Indicadores clave" flush>
          <div className="grid grid-cols-2 sm:grid-cols-4 [&>*:nth-child(even)]:border-l [&>*:nth-child(even)]:border-regla sm:[&>*:nth-child(3)]:border-l sm:[&>*:nth-child(3)]:border-regla [&>*:nth-child(n+3)]:border-t [&>*:nth-child(n+3)]:border-regla sm:[&>*:nth-child(n+3)]:border-t-0">
            <ResumenNumero to="/clientes" value={totals.clients} label="Clientes" icon={<Building2 />} />
            <ResumenNumero to="/dominios" value={totals.domains} label="Dominios" icon={<Globe2 />} />
            <ResumenNumero to="/buzones" value={totals.mailboxes} label="Buzones" icon={<Inbox />} />
            <ResumenNumero
              to="/entregabilidad"
              value={score ?? '—'}
              suffix={score === undefined ? '' : '/100'}
              label="Reputación"
              icon={<Radar />}
            />
          </div>
          <div className="border-t border-regla px-4 py-2.5">
            <Link
              to="/entregabilidad"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-petroleo hover:underline"
            >
              Ver el informe de entregabilidad <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </div>
        </Hoja>

        <Hoja
          title="Recomendaciones"
          meta="Qué conviene revisar"
          actions={
            <Link to="/entregabilidad" className="text-sm text-petroleo hover:underline">
              Ver todas
            </Link>
          }
          flush
        >
          {health.isPending ? (
            <Cargando label="Consultando PTR, registro A y listas negras…" />
          ) : health.isError ? (
            <div className="p-4">
              <AvisoError onRetry={() => void health.refetch()} retrying={health.isFetching}>
                No se ha podido comprobar la entregabilidad del servidor. Sin esta comprobación no hay
                veredicto sobre el PTR, el registro A ni las listas negras.
              </AvisoError>
            </div>
          ) : recomendaciones.length === 0 && !completa ? (
            <div className="px-4 py-5">
              <Marca veredicto="sin-dato">Sin datos</Marca>
              <p className="mt-1 text-sm text-tinta-2">
                No se ha podido completar la comprobación del PTR, el registro A y las listas negras.
              </p>
            </div>
          ) : recomendaciones.length === 0 ? (
            <div className="px-4 py-5">
              <Marca veredicto="normal">Sin recomendaciones pendientes</Marca>
              <p className="mt-1 text-sm text-tinta-2">
                El PTR, el registro A y las listas negras están en orden.
              </p>
            </div>
          ) : (
            <ul>
              {recomendaciones.slice(0, 3).map((rec) => (
                <li key={`${rec.severity}-${rec.title}`} className="regla-fila last:border-b-0">
                  <Link
                    to="/entregabilidad"
                    className="group flex items-start gap-3 px-4 py-3 transition-colors duration-100 hover:bg-hoja-2"
                  >
                    {/* La gravedad, en un punto junto al título: el texto ya dice qué pasa. */}
                    <span
                      aria-hidden
                      className={`mt-2 h-2 w-2 shrink-0 rounded-full ${
                        rec.severity === 'critical'
                          ? 'bg-fuera'
                          : rec.severity === 'warning'
                            ? 'bg-vigilar'
                            : 'bg-tinta-3'
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-base font-medium text-tinta">{rec.title}</span>
                      <span className="mt-0.5 block text-sm text-tinta-2">{rec.detail}</span>
                    </span>
                    <ArrowRight
                      className="mt-1 h-4 w-4 shrink-0 text-tinta-3 transition-transform group-hover:translate-x-0.5"
                      aria-hidden
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Hoja>
      </div>

      <nav aria-label="Accesos rápidos" className="hoja-panel mb-4 rounded-xl border border-regla bg-hoja px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="rotulo mr-1">Accesos rápidos</span>
          {accesosRapidos.map((acceso) => (
            <Link key={acceso.to} to={acceso.to} className={estiloBoton('perfil', '!h-7 !px-2.5 !text-sm')}>
              {acceso.label}
            </Link>
          ))}
        </div>
      </nav>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Hoja title="Tu servicio" meta="Estado operativo" flush>
          <div className="px-1 pt-2">
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
          </div>
          <ul className="border-t border-regla">
            <FilaRegistro to="/api-envio" label="Claves de API activas" valor={totals.apiKeys} icon={<KeyRound />} />
          </ul>
        </Hoja>

        <Hoja
          title="Actividad reciente"
          actions={
            <Link to="/actividad" className="text-sm text-petroleo hover:underline">
              Ver todo
            </Link>
          }
          flush
        >
          {audit.isPending ? (
            <Cargando label="Cargando la actividad…" />
          ) : audit.isError ? (
            <div className="p-4">
              <AvisoError onRetry={() => void audit.refetch()} retrying={audit.isFetching}>
                No se ha podido cargar la actividad reciente.
              </AvisoError>
            </div>
          ) : entradas.length === 0 ? (
            <Vacio icono={History}
              title="Todavía no hay movimiento"
              action={
                <Link to="/clientes" className={estiloBoton('perfil')}>
                  Dar de alta un cliente
                </Link>
              }
            >
              Las altas, bajas y cambios de la instancia aparecerán aquí.
            </Vacio>
          ) : (
            <ul>
              {entradas.slice(0, 8).map((entry) => {
                // Las mismas etiquetas y el mismo detalle que «Actividad»: nada de
                // códigos de acción, identificadores internos ni marcas de tiempo.
                const detalle = detalleAnotacion(entry.detail).join(' · ');
                const autor = autorAnotacion(entry);
                return (
                  <li
                    key={entry.id}
                    className="regla-fila flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2 last:border-b-0"
                  >
                    <span className="min-w-0 text-base text-tinta [overflow-wrap:anywhere]">
                      {etiquetaAccion(entry.action)}
                      {/* El autor, salvo si ya figura en el detalle (inicio de sesión). */}
                      {autor.texto !== 'Sistema' && !detalle.includes(autor.texto) && (
                        <span className="text-sm text-tinta-3"> · {autor.texto}</span>
                      )}
                    </span>
                    {/* El detalle va siempre en su propia línea: esta tarjeta ocupa
                        media columna también en escritorio, y encajonado junto a
                        la fecha quedaba en una columna de pocas letras. */}
                    {detalle && (
                      <span className="valor order-last min-w-0 basis-full text-sm text-tinta-3 [overflow-wrap:anywhere]">
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

/** Cifra del estado general: enlaza a la vista que la detalla. */
function ResumenNumero({
  to,
  value,
  suffix,
  label,
  icon,
}: {
  to: string;
  value: number | string;
  suffix?: string;
  label: string;
  icon: ReactNode;
}) {
  return (
    <Link to={to} className="group min-w-0 px-4 py-4 transition-colors hover:bg-hoja-2 sm:px-5">
      <span className="flex items-center gap-2 text-sm text-tinta-2 group-hover:text-petroleo">
        <span className="text-tinta-3 group-hover:text-petroleo [&>svg]:h-4 [&>svg]:w-4" aria-hidden>
          {icon}
        </span>
        {label}
      </span>
      <span className="valor mt-1.5 block text-2xl font-semibold leading-tight text-tinta">
        {value}
        <span className="text-base font-normal text-tinta-3">{suffix}</span>
      </span>
    </Link>
  );
}

function FilaRegistro({ to, label, valor, icon }: { to: string; label: string; valor: number; icon: ReactNode }) {
  return (
    <li className="regla-fila last:border-b-0">
      <Link
        to={to}
        className="flex items-center justify-between gap-3 px-4 py-3 transition-colors duration-100 hover:bg-hoja-3"
      >
        <span className="flex items-center gap-3 text-base text-tinta-2">
          <span className="text-petroleo [&>svg]:h-4 [&>svg]:w-4" aria-hidden>
            {icon}
          </span>
          {label}
        </span>
        <span className="flex items-center gap-3">
          <span className="valor text-md font-medium text-tinta">{valor}</span>
          <ArrowRight className="h-3.5 w-3.5 text-tinta-3" aria-hidden />
        </span>
      </Link>
    </li>
  );
}
