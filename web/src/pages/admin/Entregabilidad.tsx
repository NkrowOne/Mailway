import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ServerHealth } from '../../lib/api';
import { Button } from '../../ui/Button';
import {
  CabeceraMedidas,
  Hoja,
  Marca,
  MarcaFondo,
  Medida,
  Membrete,
  Midiendo,
  type Veredicto,
} from '../../ui/kit';

/**
 * El informe completo de entregabilidad: identidad de la IP, listas negras y
 * el plan de acción. Es la superficie donde el mundo (parte de análisis) y la
 * tarea (diagnosticar por qué caes en spam) coinciden exactamente.
 */
export default function Entregabilidad() {
  const queryClient = useQueryClient();
  const health = useQuery({
    queryKey: ['server-health'],
    queryFn: () => api.get<ServerHealth>('/api/deliverability/server'),
    staleTime: 5 * 60_000,
  });

  if (health.isPending) return <Midiendo label="Consultando PTR y listas negras…" />;
  if (health.isError || !health.data) {
    return (
      <p className="border border-regla bg-fuera-fondo px-4 py-3 text-base text-fuera">
        No se pudo ejecutar la comprobación. Reintenta en unos segundos.
      </p>
    );
  }

  const data = health.data;
  const veredictoGlobal: Veredicto =
    data.score >= 80 ? 'normal' : data.score >= 50 ? 'vigilar' : 'fuera';

  const severidad: Record<string, Veredicto> = {
    critical: 'fuera',
    warning: 'vigilar',
    info: 'sin-dato',
  };

  return (
    <>
      <Membrete
        title="Entregabilidad"
        meta="Si algo de esto está fuera de rango, tus correos acaban en spam o los rechazan."
        actions={
          <Button
            variant="tinta"
            busy={health.isFetching}
            onClick={() => void queryClient.invalidateQueries({ queryKey: ['server-health'] })}
          >
            Volver a medir
          </Button>
        }
      />

      {/* Resultado global: un valor con su rango, no una tarjeta de métrica. */}
      <Hoja className="mb-4">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
          <div className="flex items-end gap-4">
            <span
              className={`valor text-3xl font-semibold leading-none ${
                veredictoGlobal === 'normal'
                  ? 'text-normal'
                  : veredictoGlobal === 'vigilar'
                    ? 'text-vigilar'
                    : 'text-fuera'
              }`}
            >
              {data.score}
            </span>
            <div className="pb-0.5">
              <p className="rotulo">Puntuación · referencia ≥ 80</p>
              <p className="text-base text-tinta-2">
                {data.score >= 80
                  ? 'Buena posición para entregar en Gmail y Outlook.'
                  : 'Corrige lo que está fuera de rango antes de enviar en volumen.'}
              </p>
            </div>
          </div>
          <Marca veredicto={veredictoGlobal} />
        </div>
      </Hoja>

      <div className="grid items-start gap-4 lg:grid-cols-[1fr_1.35fr]">
        <div className="flex flex-col gap-4">
          <Hoja title="Identidad de la IP">
            <CabeceraMedidas />
            <Medida
              concepto="Servidor de correo"
              valor={<span className="valor">{data.mailHostname || '—'}</span>}
              referencia="configurado"
              veredicto={data.mailHostname ? 'normal' : 'fuera'}
            />
            <Medida
              concepto="IP pública"
              valor={<span className="valor">{data.publicIp || '—'}</span>}
              referencia="configurada"
              veredicto={data.publicIp ? 'normal' : 'fuera'}
            />
            <Medida
              concepto="Registro A"
              valor={
                <span className="valor">
                  {data.hostnameResolves === null
                    ? 'no comprobable'
                    : data.hostnameIps.join(', ') || 'no existe'}
                </span>
              }
              referencia="= IP pública"
              veredicto={
                data.hostnameResolves === null
                  ? 'sin-dato'
                  : data.hostnameResolves
                    ? 'normal'
                    : 'fuera'
              }
            />
            <Medida
              concepto="Inverso (PTR)"
              valor={
                <span className="valor">
                  {data.ptr === null ? 'no comprobable' : data.ptr.join(', ') || 'no existe'}
                </span>
              }
              referencia="= servidor"
              veredicto={data.ptrOk === null ? 'sin-dato' : data.ptrOk ? 'normal' : 'fuera'}
              nota={
                data.ptrOk === false
                  ? 'El PTR se configura en el panel de tu proveedor de servidor, no en tu DNS.'
                  : undefined
              }
            />
          </Hoja>

          <Hoja title="Listas negras" meta="DNSBL" flush>
            {data.dnsbl.length === 0 ? (
              <p className="px-4 py-5 text-base text-tinta-3">
                Configura la IP pública en Ajustes para poder comprobar las listas.
              </p>
            ) : (
              <ul>
                {data.dnsbl.map((list) => (
                  <li key={list.zone} className="regla-fila px-4 py-2.5 last:border-b-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <div className="min-w-0">
                        <p className="text-base text-tinta">{list.label}</p>
                        <p className="valor text-sm text-tinta-3">{list.zone}</p>
                      </div>
                      <MarcaFondo
                        veredicto={
                          list.status === 'clean'
                            ? 'normal'
                            : list.status === 'listed'
                              ? 'fuera'
                              : 'sin-dato'
                        }
                      >
                        {list.status === 'clean'
                          ? 'Limpia'
                          : list.status === 'listed'
                            ? 'Listada'
                            : 'No concluyente'}
                      </MarcaFondo>
                    </div>
                    {list.status !== 'clean' && (
                      <p className="mt-1 text-sm text-tinta-2">{list.detail}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Hoja>
        </div>

        <Hoja title="Plan de acción" meta="En orden de urgencia" flush>
          <ol>
            {data.recommendations.map((rec) => (
              <li key={rec.title} className="regla-fila px-4 py-3.5 last:border-b-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="min-w-0 text-base font-medium text-tinta">{rec.title}</p>
                  <Marca veredicto={severidad[rec.severity] ?? 'sin-dato'} />
                </div>
                <p className="mt-1 max-w-[70ch] text-base text-tinta-2">{rec.detail}</p>
              </li>
            ))}
          </ol>
        </Hoja>
      </div>
    </>
  );
}
