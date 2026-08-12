import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ServerHealth } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Cargando, Encabezado, Estado, Panel, Sello } from '../../ui/kit';

/**
 * Centro de entregabilidad: la aduana de salida del servidor. Reputación de
 * la IP, PTR, listas negras y recomendaciones accionables en español.
 */
export default function Entregabilidad() {
  const queryClient = useQueryClient();
  const health = useQuery({
    queryKey: ['server-health'],
    queryFn: () => api.get<ServerHealth>('/api/deliverability/server'),
    staleTime: 5 * 60_000,
  });

  if (health.isPending) return <Cargando label="Consultando PTR y listas negras…" />;
  if (health.isError || !health.data) {
    return <p className="text-devuelto">No se pudo ejecutar la comprobación. Reintenta en unos segundos.</p>;
  }

  const data = health.data;
  const scoreTone = data.score >= 80 ? 'entregado' : data.score >= 50 ? 'transito' : 'devuelto';

  return (
    <>
      <Encabezado
        title="Entregabilidad"
        meta="Que tus correos lleguen a la bandeja de entrada, no al spam."
        actions={
          <Button
            busy={health.isFetching}
            onClick={() => void queryClient.invalidateQueries({ queryKey: ['server-health'] })}
          >
            Volver a comprobar
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_1.6fr]">
        <div className="flex flex-col gap-4">
          {/* Puntuación de reputación */}
          <Panel title="Reputación del servidor">
            <div className="flex items-center gap-5">
              <span
                className={`num font-guia text-3xl font-bold ${
                  scoreTone === 'entregado' ? 'text-entregado' : scoreTone === 'transito' ? 'text-transito' : 'text-devuelto'
                }`}
              >
                {data.score}
              </span>
              <div className="text-sm text-tinta-2">
                <p className="font-medium text-tinta">sobre 100</p>
                <p>
                  {data.score >= 80
                    ? 'Buena posición para entregar en Gmail y Outlook.'
                    : 'Corrige los avisos críticos antes de enviar en volumen.'}
                </p>
              </div>
            </div>
          </Panel>

          {/* Identidad */}
          <Panel title="Identidad de la IP" flush>
            <ul>
              <IdentityRow
                label="Servidor"
                value={data.mailHostname || 'sin configurar'}
                ok={Boolean(data.mailHostname)}
              />
              <IdentityRow
                label="IP pública"
                value={data.publicIp || 'sin configurar'}
                ok={Boolean(data.publicIp)}
              />
              <IdentityRow
                label="Registro A"
                value={
                  data.hostnameResolves === null
                    ? 'no comprobable'
                    : data.hostnameIps.join(', ') || 'no existe'
                }
                ok={data.hostnameResolves === true}
              />
              <IdentityRow
                label="Inverso (PTR)"
                value={data.ptr === null ? 'no comprobable' : data.ptr.join(', ') || 'no existe'}
                ok={data.ptrOk === true}
              />
            </ul>
          </Panel>

          {/* Listas negras */}
          <Panel title="Listas negras (DNSBL)" flush>
            {data.dnsbl.length === 0 ? (
              <p className="px-4 py-4 text-sm text-tinta-3">
                Configura la IP pública en Ajustes para poder comprobar las listas.
              </p>
            ) : (
              <ul>
                {data.dnsbl.map((list) => (
                  <li key={list.zone} className="flex items-center gap-3 border-b border-suave px-4 py-2.5 last:border-0">
                    <div className="min-w-0 flex-1">
                      <p className="text-base text-tinta">{list.label}</p>
                      <p className="truncate font-guia text-micro text-tinta-3">{list.zone}</p>
                    </div>
                    {list.status === 'clean' ? (
                      <Sello tone="entregado">Limpia</Sello>
                    ) : list.status === 'listed' ? (
                      <Sello tone="devuelto">Listada</Sello>
                    ) : (
                      <Estado tone="neutro">No concluyente</Estado>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {/* Recomendaciones */}
        <Panel title="Qué hacer, en orden" flush>
          <ol>
            {data.recommendations.map((rec, i) => (
              <li key={rec.title} className={`px-4 py-3.5 ${i > 0 ? 'border-t border-suave' : ''}`}>
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                      rec.severity === 'critical'
                        ? 'bg-devuelto'
                        : rec.severity === 'warning'
                          ? 'bg-transito'
                          : 'bg-tinta-3'
                    }`}
                  />
                  <div className="min-w-0">
                    <p className="text-base font-medium text-tinta">{rec.title}</p>
                    <p className="mt-0.5 max-w-[70ch] text-sm leading-relaxed text-tinta-2">{rec.detail}</p>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </>
  );
}

function IdentityRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <li className="flex items-center gap-3 border-b border-suave px-4 py-2.5 last:border-0">
      <span className="w-24 shrink-0 text-sm text-tinta-3">{label}</span>
      <span className="min-w-0 flex-1 truncate font-guia text-sm text-tinta">{value}</span>
      <span
        aria-label={ok ? 'correcto' : 'pendiente'}
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${ok ? 'bg-entregado' : 'bg-transito'}`}
      />
    </li>
  );
}
