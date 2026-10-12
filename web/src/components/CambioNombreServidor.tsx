import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import type { ImpactoCambioNombre } from '../lib/motor';
import { Button } from '../ui/Button';
import { AvisoError, Cargando, Dialogo, MarcaFondo, Muestra, type Veredicto } from '../ui/kit';

/**
 * Confirmación antes de cambiar el nombre del servidor de correo, con lo que
 * arrastra. Guardarlo en Ajustes cambia al momento los datos de conexión que
 * ven los titulares; aplicarlo en el motor cambia el MX que se exige a todos
 * los dominios. Fuera del panel quedan el registro A, el PTR, el certificado y
 * las rutas de Traefik, que solo mueve el instalador.
 */
export function DialogoCambioNombre({
  open,
  nombre,
  accion,
  confirmando,
  onConfirmar,
  onClose,
}: {
  open: boolean;
  /** Nombre nuevo del servidor de correo. */
  nombre: string;
  /** `guardar`: desde la identidad del servidor; `aplicar`: en el motor. */
  accion: 'guardar' | 'aplicar';
  confirmando: boolean;
  onConfirmar: () => void;
  onClose: () => void;
}) {
  const impacto = useQuery({
    queryKey: ['impacto-nombre', nombre],
    queryFn: () =>
      api.get<ImpactoCambioNombre>(`/api/settings/mail-hostname/impact?nombre=${encodeURIComponent(nombre)}`),
    enabled: open && Boolean(nombre),
    staleTime: 30_000,
  });

  return (
    <Dialogo
      open={open}
      onClose={onClose}
      title={accion === 'guardar' ? 'Cambiar el nombre del servidor de correo' : 'Aplicar el nombre en el motor'}
      ancho="amplio"
      pie={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="plano" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="principal" busy={confirmando} onClick={onConfirmar}>
            {accion === 'guardar' ? 'Guardar el nombre nuevo' : 'Aplicar en el motor'}
          </Button>
        </div>
      }
    >
      {impacto.isPending ? (
        <Cargando label="Comprobando lo que cambia…" />
      ) : impacto.isError || !impacto.data ? (
        <AvisoError onRetry={() => void impacto.refetch()} retrying={impacto.isFetching}>
          No se ha podido comprobar lo que cambia.{' '}
          {impacto.error instanceof ApiError ? impacto.error.message : 'Comprueba la conexión con el servidor.'}
        </AvisoError>
      ) : (
        <Consecuencias impacto={impacto.data} accion={accion} />
      )}
    </Dialogo>
  );
}

function Consecuencias({ impacto, accion }: { impacto: ImpactoCambioNombre; accion: 'guardar' | 'aplicar' }) {
  const { actual, nuevo, dominios, registroA, ptr, certificado } = impacto;
  const filas: { concepto: string; veredicto: Veredicto; marca: string; nota: ReactNode }[] = [];

  filas.push({
    concepto: 'Dominios de correo',
    veredicto: dominios.total === 0 ? 'normal' : 'vigilar',
    marca: dominios.total === 0 ? 'Ninguno' : `${dominios.total}`,
    nota:
      dominios.total === 0
        ? 'Todavía no hay dominios: ningún MX que cambiar.'
        : `Con el MX medido hacia ${actual || 'el nombre actual'}: ${dominios.conMxAlActual} de ${dominios.total}. Con el nombre aplicado en el motor, ${
            dominios.total === 1 ? 'el dominio pasará' : 'todos pasarán'
          } a exigir el MX hacia ${nuevo} y ${dominios.total === 1 ? 'figurará' : 'figurarán'} como pendiente${
            dominios.total === 1 ? '' : 's'
          } de DNS hasta cambiarlo. El correo sigue llegando mientras ${actual || 'el nombre actual'} apunte a este servidor.`,
  });

  filas.push({
    concepto: `Registro A de ${nuevo}`,
    ...(registroA.ips === null
      ? { veredicto: 'sin-dato' as const, marca: 'Sin dato', nota: 'No se ha podido consultar el DNS.' }
      : registroA.ips.length === 0
        ? {
            veredicto: 'fuera' as const,
            marca: 'No existe',
            nota: `Crea un registro A: ${nuevo} → ${registroA.ip || 'la IP del servidor'}.`,
          }
        : registroA.apuntaAqui === false
          ? {
              veredicto: 'fuera' as const,
              marca: 'Otra IP',
              nota: `Apunta a ${registroA.ips.join(', ')} en lugar de a ${registroA.ip}.`,
            }
          : { veredicto: 'normal' as const, marca: 'Correcto', nota: `Apunta a ${registroA.ips.join(', ')}.` }),
  });

  if (ptr) {
    filas.push({
      concepto: `Registro inverso (PTR) de ${ptr.ip}`,
      ...(ptr.coincide === null
        ? { veredicto: 'sin-dato' as const, marca: 'Sin dato', nota: 'No se ha podido consultar.' }
        : ptr.coincide
          ? { veredicto: 'normal' as const, marca: 'Correcto', nota: `Devuelve ${nuevo}.` }
          : {
              veredicto: 'fuera' as const,
              marca: 'Cambiar',
              nota: `Devuelve ${(ptr.nombres ?? []).join(', ') || 'nada'} y debe devolver ${nuevo}. Se cambia en el panel del proveedor del servidor; sin él, Gmail y Outlook rechazan el correo.`,
            }),
    });
  }

  filas.push({
    concepto: 'Certificado del servidor de correo',
    veredicto: certificado.cubre === null ? 'sin-dato' : certificado.cubre ? 'normal' : 'fuera',
    marca: certificado.cubre === null ? 'Sin dato' : certificado.cubre ? 'Lo cubre' : 'No lo cubre',
    nota: certificado.detalle,
  });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-base text-tinta-2">
        {accion === 'guardar'
          ? `Al guardar ${nuevo}, los datos de conexión que ven los titulares (portal, perfiles y enlaces de configuración) cambian al momento. El motor, el certificado y Traefik siguen con ${actual || 'el nombre actual'} hasta que se actualicen.`
          : `El motor pasará a anunciarse como ${nuevo}: los registros que se exigen a cada dominio cambian con él.`}
      </p>
      <ul className="border-y border-regla">
        {filas.map((fila) => (
          <li key={fila.concepto} className="regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5 last:border-b-0">
            <span className="min-w-0 flex-1 basis-48 text-base font-medium text-tinta">{fila.concepto}</span>
            <span className="shrink-0">
              <MarcaFondo veredicto={fila.veredicto}>{fila.marca}</MarcaFondo>
            </span>
            <p className="basis-full text-sm text-tinta-2">{fila.nota}</p>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2">
        <p className="text-sm text-tinta-2">
          Las rutas de Traefik del servidor de correo, el certificado que copia el extractor y el nombre del
          motor (MAIL_HOSTNAME en deploy/.env) solo los actualiza el instalador. Ejecuta en el servidor, en la
          carpeta de Mailway:
        </p>
        <Muestra rotulo="Orden del instalador" copiar={impacto.comando}>
          <code className="valor block break-all text-sm text-tinta">{impacto.comando}</code>
        </Muestra>
        {impacto.cambiaDominioBase && (
          <p className="text-sm text-tinta-3">
            El nombre nuevo cuelga de otro dominio base: el instalador también traslada a ese dominio los
            nombres del webmail y del panel.
          </p>
        )}
      </div>
    </div>
  );
}
