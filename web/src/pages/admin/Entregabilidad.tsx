import { CircleCheck, CircleDashed, Server } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type ServerHealth } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { medicionCompleta, TEXTO_MEDICION_INCOMPLETA } from '../../lib/entregabilidad';
import { Button, estiloBoton } from '../../ui/Button';
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
            Si algún valor necesita atención, los mensajes pueden acabar en spam o ser
            rechazados. Última comprobación: {formatDate(health.data.checkedAt || health.dataUpdatedAt)}.
          </span>
        ) : (
          'Si algún valor necesita atención, los mensajes pueden acabar en spam o ser rechazados.'
        )
      }
      actions={
        <Button
          variant="principal"
          busy={health.isFetching}
          onClick={() => void health.refetch()}
        >
          Comprobar de nuevo
        </Button>
      }
    />
  );

  if (health.isPending) {
    return (
      <>
        {membrete}
        <Cargando label="Consultando PTR y listas negras…" />
      </>
    );
  }
  if (!health.data) {
    return (
      <>
        {membrete}
        <AvisoError onRetry={() => void health.refetch()} retrying={health.isFetching}>
          No se ha podido ejecutar la comprobación de entregabilidad. Vuelve a intentarlo en unos
          segundos.
        </AvisoError>
      </>
    );
  }

  const data = health.data;
  // Con el PTR, el registro A o alguna lista sin respuesta, la puntuación se
  // calcularía sobre datos que faltan: no se muestra ni se califica.
  const completa = medicionCompleta(data);
  const veredictoGlobal: Veredicto = !completa
    ? 'sin-dato'
    : data.score >= 80
      ? 'normal'
      : data.score >= 50
        ? 'vigilar'
        : 'fuera';
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
          No se ha podido completar la nueva comprobación. Se muestran los resultados de las{' '}
          {formatDate(data.checkedAt || health.dataUpdatedAt)}.
        </AvisoError>
      )}

      {/* Resultado global: la puntuación con su objetivo y qué significa. */}
      <Hoja className="mb-4">
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
          <div className="min-w-0 flex-1 basis-64">
            <p className="rotulo">Puntuación de entregabilidad · se espera 80 o más</p>
            <p
              className={`valor mt-1 text-3xl font-semibold leading-tight ${
                veredictoGlobal === 'normal'
                  ? 'text-normal'
                  : veredictoGlobal === 'vigilar'
                    ? 'text-vigilar'
                    : veredictoGlobal === 'fuera'
                      ? 'text-fuera'
                      : 'text-tinta-3'
              }`}
            >
              {completa ? data.score : '—'}
              {completa && <span className="text-lg font-normal text-tinta-3">/100</span>}
            </p>
            <p className="mt-1 max-w-2xl text-base text-tinta-2">
              {!completa
                ? TEXTO_MEDICION_INCOMPLETA
                : data.score >= 80
                  ? 'Buena posición para entregar en Gmail y Outlook.'
                  : 'Corrige lo que necesita atención antes de enviar en volumen.'}
            </p>
          </div>
          <MarcaFondo veredicto={veredictoGlobal} />
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
                    Indica el nombre del servidor de correo en{' '}
                    <Link to="/ajustes" className="text-petroleo underline underline-offset-2">
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
              concepto="Registro AAAA (IPv6)"
              valor={
                <span className="valor">
                  {data.hostnameIpv6 == null
                    ? 'no comprobable'
                    : data.hostnameIpv6.join(', ') || 'no existe'}
                </span>
              }
              referencia="inverso = servidor"
              veredicto={
                data.ipv6Ok == null ? 'sin-dato' : data.ipv6Ok ? 'normal' : 'vigilar'
              }
              nota={
                data.ipv6Ok === false
                  ? 'Su inverso no apunta al servidor. Si esa dirección no es de este servidor, o el servidor no tiene IPv6, elimina el registro AAAA; si es suya, configura su PTR.'
                  : data.hostnameIpv6?.length === 0
                    ? 'Sin IPv6: el servidor solo recibe correo por IPv4, que admiten todos los servidores de correo.'
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
              <Vacio icono={Server}
                title="Sin IP que comprobar"
                action={
                  <Link to="/ajustes" className={estiloBoton('perfil')}>
                    Ir a Ajustes
                  </Link>
                }
              >
                Configura la IP pública del servidor en Ajustes para comprobar las listas negras.
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
          {acciones.length === 0 && !completa ? (
            <Vacio icono={CircleDashed} title="Comprobación incompleta">
              No se ha podido consultar todo lo necesario para proponer un plan de acción. Vuelve a
              medir en unos minutos.
            </Vacio>
          ) : acciones.length === 0 ? (
            <Vacio icono={CircleCheck} title="Sin acciones pendientes">
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
