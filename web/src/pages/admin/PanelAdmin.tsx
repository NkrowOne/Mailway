import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type AdminDashboard, type AuditEntry, type ServerHealth } from '../../lib/api';
import {
  AvisoError,
  CabeceraMedidas,
  Hoja,
  Marca,
  MarcaFondo,
  Medida,
  Membrete,
  Midiendo,
  Vacio,
  type Veredicto,
} from '../../ui/kit';
import { estiloBoton } from '../../ui/Button';
import { formatDate } from '../../lib/format';
import { medicionCompleta, TEXTO_MEDICION_INCOMPLETA } from '../../lib/entregabilidad';
import { autorAnotacion, detalleAnotacion, etiquetaAccion } from '../../lib/tokens';

/** Atajos a las altas y conexiones más frecuentes, sin buscarlas en el índice. */
const accesosRapidos: { to: string; label: string }[] = [
  { to: '/clientes', label: 'Alta de cliente' },
  { to: '/dominios', label: 'Añadir dominio' },
  { to: '/buzones', label: 'Crear buzón' },
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
  // Solo se sustituye la página si nunca hubo lectura: un sondeo fallido con
  // datos previos se avisa con una banda y se conservan los valores medidos.
  if (!dashboard.data) {
    return (
      <>
        <Membrete title="Parte de la instancia" />
        <AvisoError onRetry={() => void dashboard.refetch()} retrying={dashboard.isFetching}>
          No se ha podido leer el parte. Compruebe que el servicio está en marcha y vuelva a intentarlo.
        </AvisoError>
      </>
    );
  }

  const { totals, messages, engine, queue, instance } = dashboard.data;
  // Sin respuesta de salud, o con una medición a medias (DNS sin respuesta),
  // no hay veredicto de reputación: se dice «sin dato», nunca «en orden».
  const completa = health.data ? medicionCompleta(health.data) : false;
  const score = health.isError || !completa ? undefined : health.data?.score;
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
        ? 'No se ha podido consultar el PTR, el registro A ni las listas negras. Repita la medición desde Entregabilidad.'
        : health.data && !completa
          ? TEXTO_MEDICION_INCOMPLETA
          : undefined,
    },
  ];

  // El veredicto del membrete resume TODAS las constantes, no solo el motor:
  // decir «en rango» con una fila en rojo justo debajo sería mentir al lector.
  const peor = ordenarPorVeredicto(constantes)[0]?.veredicto ?? 'sin-dato';
  const veredictoGlobal: Veredicto =
    criticos.length > 0 && peor !== 'fuera' ? 'fuera' : peor;
  const entradas = audit.data?.entries ?? [];

  return (
    <>
      <Membrete
        title="Parte de la instancia"
        meta={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="valor text-sm text-white/75 [overflow-wrap:anywhere]">
              {instance.mailHostname || 'servidor sin nombre'}
            </span>
            {/* La hora de la última lectura real, no la del reloj: si el
                sondeo falla, la hora no debe seguir avanzando. */}
            <span className="text-sm text-white/70">
              Medido {formatDate(dashboard.dataUpdatedAt)}
            </span>
          </span>
        }
        actions={
          <MarcaFondo veredicto={veredictoGlobal}>
            {veredictoGlobal === 'normal'
              ? 'Todo en rango'
              : veredictoGlobal === 'fuera'
                ? 'Requiere atención'
                : veredictoGlobal === 'vigilar'
                  ? 'Con avisos'
                  : 'Sin dato'}
          </MarcaFondo>
        }
      />

      {dashboard.isRefetchError && (
        <AvisoError
          className="mb-4"
          onRetry={() => void dashboard.refetch()}
          retrying={dashboard.isFetching}
        >
          No se ha podido actualizar el parte. Se muestran los valores medidos a las{' '}
          {formatDate(dashboard.dataUpdatedAt)}.
        </AvisoError>
      )}

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

      <nav aria-label="Accesos rápidos" className="mb-4 border border-regla bg-hoja px-4 py-3">
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
            <Midiendo label="Consultando PTR, registro A y listas negras…" />
          ) : health.isError ? (
            <div className="p-4">
              <AvisoError onRetry={() => void health.refetch()} retrying={health.isFetching}>
                No se ha podido comprobar la entregabilidad del servidor. Sin esta medición no hay
                veredicto sobre el PTR, el registro A ni las listas negras.
              </AvisoError>
            </div>
          ) : criticos.length === 0 && !completa ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-5">
              <Marca veredicto="sin-dato">Sin dato</Marca>
              <span className="text-base text-tinta-2">
                No se ha podido completar la comprobación del PTR, el registro A y las listas negras.
              </span>
            </div>
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
                <li key={rec.title} className="regla-fila fila-fuera px-4 py-3 last:border-b-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p className="min-w-0 text-base font-medium text-tinta">{rec.title}</p>
                    <span className="ml-auto">
                      <Marca veredicto="fuera" />
                    </span>
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
          <Midiendo label="Leyendo la actividad…" />
        ) : audit.isError ? (
          <div className="p-4">
            <AvisoError onRetry={() => void audit.refetch()} retrying={audit.isFetching}>
              No se ha podido leer la actividad reciente.
            </AvisoError>
          </div>
        ) : entradas.length === 0 ? (
          <Vacio
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
                  {/* En móvil el detalle baja a su propia línea: encajonado junto
                      a la fecha quedaba en una columna de pocas letras. */}
                  {detalle && (
                    <span className="valor order-last min-w-0 basis-full text-sm text-tinta-3 [overflow-wrap:anywhere] sm:order-none sm:basis-0 sm:flex-1">
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
        className="flex items-baseline justify-between gap-3 px-4 py-2.5 transition-colors duration-100 hover:bg-hoja-3"
      >
        <span className="text-base text-tinta-2">{label}</span>
        <span className="valor text-md font-medium text-tinta">{valor}</span>
      </Link>
    </li>
  );
}
