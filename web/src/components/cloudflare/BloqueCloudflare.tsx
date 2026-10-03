import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import {
  cuentasUtilizables,
  zonaCubre,
  type CuentaCloudflare,
  type DominioCorreo,
  type EstadoAltaDominio,
  type PlanCloudflare,
  type ResultadoAplicacion,
} from '../../lib/cloudflare';
import { Button } from '../../ui/Button';
import { Dialogo, Hoja, Cargando } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { BandaAviso, BandaError, ResultadoCloudflare, claseEnlacePerfil } from './comun';
import { RevisionCambios } from './RevisionCambios';

/*
  Configuración automática del DNS de un dominio en Cloudflare, dentro de su
  ficha. Tres momentos:
  1. Disponibilidad: ¿alguna cuenta conectada contiene la zona?
  2. Revisión: el plan completo (crear, actualizar, conservar, conflicto) en
     un diálogo, con el reemplazo de conflictos como decisión explícita.
  3. Verificación: tras aplicar, se mide el DNS público cada 15 segundos
     durante 5 minutos, a la vista, hasta que el dominio queda activo.
*/

const INTERVALO_MS = 15_000;
const MAX_MEDICIONES = 20;

interface Sondeo {
  medicion: number;
  siguienteEn: number;
  estado: 'midiendo' | 'completado' | 'agotado';
}

function mensajeError(err: unknown, porDefecto: string): string {
  return err instanceof ApiError ? err.message : porDefecto;
}

export function BloqueCloudflare({
  dominio,
  isAdmin,
  alta,
  bloqueo,
}: {
  dominio: DominioCorreo;
  isAdmin: boolean;
  /** Resultado del «DNS automático» del alta, si se acaba de crear. */
  alta?: EstadoAltaDominio | null;
  /**
   * Motivo por el que no se puede aplicar nada (el servidor de correo anuncia
   * un MX interno): el servidor respondería 409, así que ni se lee el plan.
   */
  bloqueo?: string | null;
}) {
  const id = dominio.id;
  const queryClient = useQueryClient();
  const toast = useToast();
  const [dialogo, setDialogo] = useState(false);
  const [reemplazar, setReemplazar] = useState(false);
  const [resultado, setResultado] = useState<ResultadoAplicacion | null>(alta?.cloudflare ?? null);
  const [sondeo, setSondeo] = useState<Sondeo | null>(() =>
    alta?.cloudflare && alta.cloudflare.applied.length > 0 && dominio.status !== 'active'
      ? { medicion: 0, siguienteEn: Date.now() + INTERVALO_MS, estado: 'midiendo' }
      : null,
  );
  const [ahora, setAhora] = useState(() => Date.now());
  // Momento en que se abrió la revisión: hasta tener un plan leído después,
  // el diálogo muestra la lectura en curso y no un plan anterior.
  const [abiertoEn, setAbiertoEn] = useState(0);

  const cuentas = useQuery({
    queryKey: ['cloudflare-accounts'],
    queryFn: () => api.get<{ accounts: CuentaCloudflare[] }>('/api/cloudflare/accounts'),
  });

  const utilizables = cuentasUtilizables(cuentas.data?.accounts ?? [], {
    clientId: dominio.clientId,
    isAdmin,
  });
  const cuentaConZona = utilizables.find((c) => c.zones?.some((z) => zonaCubre(z, dominio.domain)));
  // Para un usuario del cliente, el dominio solo cuenta como gestionado si la
  // cuenta asociada es suya: si el administrador aplicó el DNS con la cuenta
  // de la instancia, el servidor no se la deja usar, y ofrecer «Revisar
  // cambios» prometería algo que después falla.
  const asociada = dominio.cloudflare?.accountId ?? null;
  const gestionado = Boolean(asociada) && (isAdmin || utilizables.some((c) => c.id === asociada));
  const delAdministrador = !isAdmin && Boolean(asociada) && !gestionado;
  const posible = gestionado || utilizables.length > 0;
  const pendiente = dominio.status !== 'active';
  // Con el dominio pendiente y la zona localizada, el plan se lee al abrir la
  // ficha: así se ve de entrada qué haría el clic, sin tener que pedirlo.
  const resumenAutomatico = !bloqueo && pendiente && (gestionado || Boolean(cuentaConZona));

  const plan = useQuery({
    queryKey: ['domain-cloudflare', id],
    queryFn: () => api.get<PlanCloudflare>(`/api/domains/${id}/cloudflare`),
    enabled: posible && (dialogo || resumenAutomatico),
    staleTime: 30_000,
  });

  const aplicar = useMutation({
    mutationFn: () =>
      api.post<ResultadoAplicacion & { domain: DominioCorreo }>(`/api/domains/${id}/cloudflare/apply`, {
        replaceConflicts: reemplazar,
        includeRecommended: true,
      }),
    onSuccess: async (data) => {
      queryClient.setQueryData(['domain', id], { domain: data.domain });
      setResultado({ applied: data.applied, errors: data.errors, skipped: data.skipped });
      setDialogo(false);
      setReemplazar(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['domains'] }),
        queryClient.invalidateQueries({ queryKey: ['domain-cloudflare', id] }),
      ]);
      const omitidos = data.skipped?.length ?? 0;
      if (data.applied.length > 0 && !data.domain.dnsStatus.allRequiredOk) {
        setSondeo({ medicion: 0, siguienteEn: Date.now() + INTERVALO_MS, estado: 'midiendo' });
      } else {
        setSondeo(null);
      }
      // El aviso dice lo que pasó: un fallo parcial o unos conflictos sin
      // tocar reclaman atención y no se anuncian como un éxito.
      if (data.errors.length > 0) {
        toast(
          'error',
          data.applied.length > 0
            ? 'Parte de los registros no se ha podido aplicar en Cloudflare. Consulta el detalle en la ficha.'
            : 'No se ha podido aplicar ningún registro en Cloudflare. Consulta el detalle en la ficha.',
        );
      } else if (data.domain.dnsStatus.allRequiredOk) {
        toast('ok', 'DNS aplicado en Cloudflare. El dominio ya puede enviar y recibir correo.');
      } else if (data.applied.length > 0) {
        toast('ok', 'DNS aplicado en Cloudflare. Se comprobará la propagación durante 5 minutos.');
      } else if (omitidos > 0) {
        toast('error', 'No se ha modificado nada: los registros en conflicto necesitan tu confirmación.');
      } else {
        toast('ok', 'No había cambios pendientes en Cloudflare.');
      }
    },
  });

  // Sondeo de la propagación: una medición cada 15 s, hasta 20 (5 minutos).
  useEffect(() => {
    if (!sondeo || sondeo.estado !== 'midiendo') return;
    const espera = Math.max(0, sondeo.siguienteEn - Date.now());
    const temporizador = window.setTimeout(async () => {
      let activo = false;
      try {
        const data = await api.post<{ domain: DominioCorreo }>(`/api/domains/${id}/verify?auto=1`);
        queryClient.setQueryData(['domain', id], data);
        activo = Boolean(data.domain.dnsStatus.allRequiredOk);
      } catch {
        // Un fallo puntual de red no detiene el sondeo: se reintenta.
      }
      if (activo) {
        void queryClient.invalidateQueries({ queryKey: ['domains'] });
        toast('ok', 'Los registros obligatorios ya son correctos. El dominio ya puede enviar y recibir correo.');
      }
      setSondeo((s) => {
        if (!s) return s;
        const medicion = s.medicion + 1;
        if (activo) return { ...s, medicion, estado: 'completado' };
        if (medicion >= MAX_MEDICIONES) return { ...s, medicion, estado: 'agotado' };
        return { medicion, siguienteEn: Date.now() + INTERVALO_MS, estado: 'midiendo' };
      });
    }, espera);
    return () => window.clearTimeout(temporizador);
  }, [sondeo, id, queryClient, toast]);

  // Reloj de la cuenta atrás visible; solo corre mientras se mide.
  const midiendo = sondeo?.estado === 'midiendo';
  useEffect(() => {
    if (!midiendo) return;
    const reloj = window.setInterval(() => setAhora(Date.now()), 1000);
    return () => window.clearInterval(reloj);
  }, [midiendo]);

  function abrirRevision() {
    aplicar.reset();
    setReemplazar(false);
    setAbiertoEn(Date.now());
    setDialogo(true);
    void plan.refetch();
  }

  const titulo = 'Configuración automática en Cloudflare';

  if (cuentas.isPending && !gestionado) {
    return (
      <Hoja title={titulo}>
        <Cargando label="Consultando las cuentas de Cloudflare…" />
      </Hoja>
    );
  }

  if (!posible && delAdministrador) {
    return (
      <Hoja title={titulo} meta="Gestionado por el administrador">
        {cuentas.isError && (
          <div className="mb-3">
            <BandaError onRetry={() => void cuentas.refetch()} retrying={cuentas.isFetching}>
              {mensajeError(cuentas.error, 'No se han podido consultar las cuentas de Cloudflare.')}
            </BandaError>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[75ch] text-base text-tinta-2">
            El DNS de este dominio lo configuró el administrador de la plataforma con su propia cuenta
            de Cloudflare, que solo utiliza el administrador. Para revisarlo o cambiarlo desde aquí,
            conecta una cuenta de Cloudflare propia que contenga la zona; si no, solicita los cambios
            al administrador.
          </p>
          <Link to="/conexiones" className={claseEnlacePerfil}>
            Conectar Cloudflare
          </Link>
        </div>
      </Hoja>
    );
  }

  if (!posible) {
    return (
      <Hoja title={titulo} meta="Sin cuenta conectada">
        {cuentas.isError && (
          <div className="mb-3">
            <BandaError onRetry={() => void cuentas.refetch()} retrying={cuentas.isFetching}>
              {mensajeError(cuentas.error, 'No se han podido consultar las cuentas de Cloudflare.')}
            </BandaError>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[75ch] text-base text-tinta-2">
            Si el DNS de este dominio está en Cloudflare, conecta la cuenta para crear todos estos
            registros con un clic, sin copiarlos manualmente. Mailway muestra los cambios antes de
            aplicarlos y nunca activa el proxy de Cloudflare en los registros de correo.
          </p>
          <Link to="/conexiones" className={claseEnlacePerfil}>
            Conectar Cloudflare
          </Link>
        </div>
      </Hoja>
    );
  }

  const zonaVista = plan.data?.zone?.name ?? cuentaConZona?.zones?.find((z) => zonaCubre(z, dominio.domain));
  const cuentaVista = plan.data?.account?.label ?? cuentaConZona?.label;
  const meta = zonaVista ? `Zona ${zonaVista}${cuentaVista ? ` · ${cuentaVista}` : ''}` : 'Cloudflare';
  const resumen = plan.data?.available ? plan.data.summary : null;

  return (
    <>
      <Hoja
        title={titulo}
        meta={meta}
        actions={
          <Button variant="perfil" disabled={Boolean(bloqueo)} onClick={abrirRevision}>
            Revisar cambios
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {bloqueo && (
            <BandaAviso titulo="Pendiente del servidor de correo">
              Mientras el servidor de correo anuncie un MX interno no se aplica nada en Cloudflare:
              el registro rompería el correo del dominio. Antes hay que corregir el nombre del
              servidor.
            </BandaAviso>
          )}
          {resultado ? (
            <ResultadoCloudflare resultado={resultado} apex={dominio.domain} />
          ) : alta?.autoDns && alta.cloudflareReason ? (
            <BandaAviso titulo="No se ha aplicado el DNS automáticamente">{alta.cloudflareReason}</BandaAviso>
          ) : resumenAutomatico && plan.isPending ? (
            <Cargando label="Leyendo la zona en Cloudflare…" />
          ) : resumenAutomatico && plan.isError ? (
            <BandaError onRetry={() => void plan.refetch()} retrying={plan.isFetching}>
              {mensajeError(plan.error, 'No se ha podido leer la zona en Cloudflare.')}
            </BandaError>
          ) : resumen ? (
            <p className="max-w-[75ch] text-base text-tinta-2">
              {resumen.create + resumen.update + resumen.conflict === 0 ? (
                'Todos los registros de correo ya están en Cloudflare.'
              ) : (
                <>
                  Con un clic se{' '}
                  {resumen.create === 1 ? 'creará 1 registro' : `crearán ${resumen.create} registros`}
                  {resumen.update > 0 &&
                    (resumen.update === 1 ? ' y se actualizará 1' : ` y se actualizarán ${resumen.update}`)}
                  .
                  {resumen.conflict > 0 && (
                    <span className="text-fuera">
                      {' '}
                      {resumen.conflict === 1
                        ? 'Hay 1 registro en conflicto que requiere tu decisión.'
                        : `Hay ${resumen.conflict} registros en conflicto que requieren tu decisión.`}
                    </span>
                  )}
                </>
              )}
            </p>
          ) : plan.data && !plan.data.available ? (
            <BandaAviso titulo="No disponible">{plan.data.reason}</BandaAviso>
          ) : (
            <p className="max-w-[75ch] text-base text-tinta-2">
              Mailway puede crear o corregir los registros de este dominio directamente en
              Cloudflare. Antes de aplicar se muestran todos los cambios, y nunca se activa el proxy
              de Cloudflare en los registros de correo.
            </p>
          )}

          {sondeo && (
            <ProgresoSondeo
              sondeo={sondeo}
              ahora={ahora}
              onReanudar={() => setSondeo({ medicion: 0, siguienteEn: Date.now(), estado: 'midiendo' })}
            />
          )}
        </div>
      </Hoja>

      <Dialogo open={dialogo} onClose={() => setDialogo(false)} title="Cambios en Cloudflare">
        <RevisionCambios
          plan={plan.data}
          cargando={(!plan.data && !plan.isError) || (plan.isFetching && plan.dataUpdatedAt < abiertoEn)}
          error={plan.isError ? mensajeError(plan.error, 'No se ha podido leer la zona en Cloudflare.') : null}
          apex={dominio.domain}
          reemplazar={reemplazar}
          onReemplazar={setReemplazar}
          aplicando={aplicar.isPending}
          errorAplicar={aplicar.isError ? mensajeError(aplicar.error, 'No se ha podido aplicar en Cloudflare.') : null}
          onAplicar={() => aplicar.mutate()}
          onCancelar={() => setDialogo(false)}
        />
      </Dialogo>
    </>
  );
}

/** Progreso visible de la verificación tras aplicar el DNS. */
function ProgresoSondeo({
  sondeo,
  ahora,
  onReanudar,
}: {
  sondeo: Sondeo;
  ahora: number;
  onReanudar: () => void;
}) {
  const segundos = Math.max(0, Math.ceil((sondeo.siguienteEn - ahora) / 1000));
  const progreso = Math.min(1, sondeo.medicion / MAX_MEDICIONES);
  if (sondeo.estado === 'completado') {
    return (
      <p className="revelar text-base text-normal" role="status">
        Los registros obligatorios ya son correctos: el dominio ya puede enviar y recibir correo.
      </p>
    );
  }
  if (sondeo.estado === 'agotado') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3" role="status">
        <p className="max-w-[75ch] text-base text-tinta-2">
          Transcurridos 5 minutos, el DNS público todavía no muestra todos los registros. La
          propagación puede tardar más; Mailway seguirá comprobando este dominio cada 10 minutos.
        </p>
        <Button variant="perfil" onClick={onReanudar}>
          Seguir comprobando
        </Button>
      </div>
    );
  }
  // Solo el número de comprobación se anuncia (cambia cada 15 s); la cuenta
  // atrás cambia cada segundo y, anunciada, taparía todo lo demás.
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-base text-tinta">Comprobando la propagación del DNS</span>
        <span className="valor text-sm text-tinta-3">
          <span role="status">
            comprobación {sondeo.medicion + 1} de {MAX_MEDICIONES}
          </span>
          <span aria-hidden> · {segundos} s</span>
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Progreso de la comprobación"
        aria-valuemin={0}
        aria-valuemax={MAX_MEDICIONES}
        aria-valuenow={sondeo.medicion}
        className="h-1.5 bg-hoja-3"
      >
        <div
          className="h-full bg-tinta-3 transition-[width] duration-500"
          style={{ width: `${Math.max(progreso * 100, 2)}%` }}
        />
      </div>
    </div>
  );
}
