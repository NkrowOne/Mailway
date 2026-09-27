import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type ServerHealth } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { Button, estiloBoton } from '../../ui/Button';
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

const severidad: Record<string, Veredicto> = {
  critical: 'fuera',
  warning: 'vigilar',
  info: 'sin-dato',
};

const pesoVeredicto: Record<Veredicto, number> = { fuera: 0, vigilar: 1, 'sin-dato': 2, normal: 3 };

const estadoLista: Record<ServerHealth['dnsbl'][number]['status'], Veredicto> = {
  listed: 'fuera',
  inconclusive: 'sin-dato',
  clean: 'normal',
};

/**
 * El informe completo de entregabilidad: identidad de la IP, listas negras y
 * el plan de acción. Es la superficie donde el mundo (parte de análisis) y la
 * tarea (diagnosticar por qué los mensajes acaban en spam) coinciden exactamente.
 */
export default function Entregabilidad() {
  const health = useQuery({
    queryKey: ['server-health'],
    queryFn: () => api.get<ServerHealth>('/api/deliverability/server'),
    staleTime: 5 * 60_000,
  });

  // El membrete no depende de la medición: se pinta ya, y la acción de volver
  // a medir está disponible incluso si la primera lectura falló.
  const membrete = (
    <Membrete
      title="Entregabilidad"
      meta={
        health.data ? (
          <span>
            Si algún valor está fuera de rango, los mensajes pueden acabar en spam o ser
            rechazados. Medido {formatDate(health.data.checkedAt || health.dataUpdatedAt)}.
          </span>
        ) : (
          'Si algún valor está fuera de rango, los mensajes pueden acabar en spam o ser rechazados.'
        )
      }
      actions={
        <Button
          variant="campo"
          busy={health.isFetching}
          onClick={() => void health.refetch()}
        >
          Volver a medir
        </Button>
      }
    />
  );

  if (health.isPending) {
    return (
      <>
        {membrete}
        <Midiendo label="Consultando PTR y listas negras…" />
      </>
    );
  }
  if (!health.data) {
    return (
      <>
        {membrete}
        <AvisoError onRetry={() => void health.refetch()} retrying={health.isFetching}>
          No se pudo ejecutar la comprobación de entregabilidad. Vuelva a intentarlo en unos
          segundos.
        </AvisoError>
      </>
    );
  }

  const data = health.data;
  const veredictoGlobal: Veredicto =
    data.score >= 80 ? 'normal' : data.score >= 50 ? 'vigilar' : 'fuera';
  const listas = [...data.dnsbl].sort(
    (a, b) => pesoVeredicto[estadoLista[a.status]] - pesoVeredicto[estadoLista[b.status]],
  );
  const acciones = [...data.recommendations].sort(
    (a, b) =>
      pesoVeredicto[severidad[a.severity] ?? 'sin-dato'] -
      pesoVeredicto[severidad[b.severity] ?? 'sin-dato'],
  );

  return (
    <>
      {membrete}

      {health.isRefetchError && (
        <AvisoError
          className="mb-4"
          onRetry={() => void health.refetch()}
          retrying={health.isFetching}
        >
          La nueva medición falló. Se muestran los resultados de las{' '}
          {formatDate(data.checkedAt || health.dataUpdatedAt)}.
        </AvisoError>
      )}

      {/* Resultado global: un valor con su rango, no una tarjeta de métrica. */}
      <Hoja className="mb-4">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
          <div className="flex min-w-0 items-end gap-4">
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
            <div className="min-w-0 pb-0.5">
              <p className="rotulo">Puntuación · referencia ≥ 80</p>
              <p className="text-base text-tinta-2">
                {data.score >= 80
                  ? 'Buena posición para entregar en Gmail y Outlook.'
                  : 'Corrija lo que está fuera de rango antes de enviar en volumen.'}
              </p>
            </div>
          </div>
          <Marca veredicto={veredictoGlobal} />
        </div>
      </Hoja>

      <div className="grid items-start gap-4 lg:grid-cols-[1fr_1.35fr]">
        <div className="flex min-w-0 flex-col gap-4">
          <Hoja title="Identidad de la IP">
            <CabeceraMedidas />
            <Medida
              concepto="Servidor de correo"
              valor={<span className="valor">{data.mailHostname || '—'}</span>}
              referencia="configurado"
              veredicto={data.mailHostname ? 'normal' : 'fuera'}
              nota={
                data.mailHostname ? undefined : (
                  <>
                    Indique el nombre del servidor de correo en{' '}
                    <Link to="/ajustes" className="text-laboratorio underline underline-offset-2">
                      Ajustes
                    </Link>
                    .
                  </>
                )
              }
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
              nota={
                data.hostnameResolves === false
                  ? 'El nombre del servidor debe apuntar a la IP pública con un registro A en el DNS.'
                  : undefined
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
                  ? 'El PTR se configura en el panel del proveedor del servidor, no en el DNS del dominio.'
                  : undefined
              }
            />
          </Hoja>

          <Hoja title="Listas negras" meta="DNSBL · listadas primero" flush>
            {listas.length === 0 ? (
              <Vacio
                title="Sin IP que comprobar"
                action={
                  <Link to="/ajustes" className={estiloBoton('perfil')}>
                    Ir a Ajustes
                  </Link>
                }
              >
                Configure la IP pública del servidor en Ajustes para comprobar las listas negras.
              </Vacio>
            ) : (
              <ul>
                {listas.map((list) => {
                  const veredicto = estadoLista[list.status];
                  return (
                    <li
                      key={list.zone}
                      className={`regla-fila px-4 py-2.5 last:border-b-0 ${
                        veredicto === 'fuera' ? 'fila-fuera' : ''
                      }`}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <div className="min-w-0">
                          <p className="text-base text-tinta">{list.label}</p>
                          <p className="valor text-sm text-tinta-3 [overflow-wrap:anywhere]">
                            {list.zone}
                          </p>
                        </div>
                        <span className="ml-auto">
                          <MarcaFondo veredicto={veredicto}>
                            {list.status === 'clean'
                              ? 'Limpia'
                              : list.status === 'listed'
                                ? 'Listada'
                                : 'No concluyente'}
                          </MarcaFondo>
                        </span>
                      </div>
                      {list.status !== 'clean' && (
                        <p className="mt-1 text-sm text-tinta-2">{list.detail}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Hoja>
        </div>

        <Hoja title="Plan de acción" meta="En orden de urgencia" flush>
          {acciones.length === 0 ? (
            <Vacio title="Sin acciones pendientes">
              No hay nada que corregir en la identidad del servidor.
            </Vacio>
          ) : (
            <ol>
              {acciones.map((rec) => {
                const veredicto = severidad[rec.severity] ?? 'sin-dato';
                return (
                  <li
                    key={rec.title}
                    className={`regla-fila px-4 py-3.5 last:border-b-0 ${
                      veredicto === 'fuera' ? 'fila-fuera' : veredicto === 'vigilar' ? 'fila-vigilar' : ''
                    }`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <p className="min-w-0 text-base font-medium text-tinta">{rec.title}</p>
                      <span className="ml-auto">
                        <Marca veredicto={veredicto} />
                      </span>
                    </div>
                    <p className="mt-1 max-w-[70ch] text-base text-tinta-2">{rec.detail}</p>
                  </li>
                );
              })}
            </ol>
          )}
        </Hoja>
      </div>
    </>
  );
}
