import { useEffect, useId, useRef, useState, type FormEvent, type Ref } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import {
  avisoAltaDominio,
  cuentasUtilizables,
  invalidarTrasAltaOBaja,
  medicionIlegible,
  nombreVisible,
  propiedadPendiente,
  zonaCubre,
  type CuentaCloudflare,
  type DominioCorreo,
  type RespuestaAltaDominio,
} from '../../lib/cloudflare';
import { formatDate } from '../../lib/format';
import { BloqueCloudflare } from '../../components/cloudflare/BloqueCloudflare';
import { BloquePropiedad, porVeredicto, RegistroMedido } from '../../components/dominio/RegistrosDominio';
import { Casilla } from '../../components/gestion/comun';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { AvisoError, Cargando, Hoja } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { CabeceraPaso, FilaEstado, PieDePaso, type ContextoPuesta } from './marco';

/** Cada cuánto se vuelve a mirar el DNS solo mientras falta algo, y cuántas veces. */
const INTERVALO_AUTO_MS = 60_000;
const MAX_AUTO = 15;

/**
 * Lo que la gente escribe cuando se le pide «el dominio»: una web
 * («https://www.empresa.com/contacto») o su correo («ana@empresa.com»). Se
 * queda con el dominio y se le enseña qué se va a usar.
 */
export function limpiarDominio(texto: string): string {
  let d = texto.trim().toLowerCase();
  if (d.includes('@')) d = d.slice(d.lastIndexOf('@') + 1);
  d = d.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  d = d.replace(/^www\./, '').replace(/\.+$/, '');
  return d;
}

export function PasoDominio({ ctx, tituloRef }: { ctx: ContextoPuesta; tituloRef: Ref<HTMLHeadingElement> }) {
  if (!ctx.dominio) return <AltaDominio ctx={ctx} tituloRef={tituloRef} />;
  return <DnsDominio key={ctx.dominio.id} ctx={ctx} dominioLista={ctx.dominio} tituloRef={tituloRef} />;
}

/* --------------------------------- Alta ----------------------------------- */

function AltaDominio({ ctx, tituloRef }: { ctx: ContextoPuesta; tituloRef: Ref<HTMLHeadingElement> }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const idFormulario = useId();
  const [texto, setTexto] = useState('');
  const [autoDns, setAutoDns] = useState(true);
  const [error, setError] = useState('');

  const cuentas = useQuery({
    queryKey: ['cloudflare-accounts'],
    queryFn: () => api.get<{ accounts: CuentaCloudflare[] }>('/api/cloudflare/accounts'),
  });
  const hayCloudflare = (cuentas.data?.accounts ?? []).length > 0;
  const limpio = limpiarDominio(texto);
  const plan = ctx.panel.plan;
  const sinPlazas = ctx.panel.usage.domains >= plan.maxDomains;

  const alta = useMutation({
    mutationFn: () =>
      api.post<RespuestaAltaDominio>('/api/domains', {
        domain: limpio,
        ...(hayCloudflare && autoDns ? { autoDns: true } : {}),
      }),
    onSuccess: async (data) => {
      await invalidarTrasAltaOBaja(queryClient, data.domain.clientId);
      queryClient.setQueryData(['domain', data.domain.id], { domain: data.domain });
      const pedido = hayCloudflare && autoDns;
      const aviso = avisoAltaDominio(data, pedido);
      // El aviso genérico habla de «la ficha»; aquí la ficha es este mismo paso.
      toast(aviso.tono, pedido ? aviso.texto : 'Dominio añadido. Ahora falta su DNS.');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'No se ha podido añadir el dominio.'),
  });

  function enviar(e: FormEvent) {
    e.preventDefault();
    if (!limpio || !limpio.includes('.')) {
      setError('Escribe el dominio completo, con su terminación: por ejemplo, tuempresa.com.');
      return;
    }
    setError('');
    alta.mutate();
  }

  return (
    <>
      <CabeceraPaso ref={tituloRef} titulo="¿Cuál es el dominio de tu empresa?">
        Es lo que va detrás de la @ en vuestras direcciones de correo. Con él se crean los buzones de
        todo el equipo.
      </CabeceraPaso>

      {sinPlazas && (
        <AvisoError>
          Tu plan no admite más dominios. Pide a tu proveedor que lo amplíe para continuar.
        </AvisoError>
      )}

      <Hoja>
        <form id={idFormulario} noValidate onSubmit={enviar} className="flex flex-col gap-4">
          <Input
            label="Dominio"
            mono
            autoFocus
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="url"
            value={texto}
            onChange={(e) => {
              setTexto(e.target.value);
              setError('');
            }}
            placeholder="tuempresa.com"
            error={error || undefined}
            help="Tiene que ser vuestro y poder cambiar su DNS donde lo gestionáis (IONOS, GoDaddy, DonDominio, Cloudflare…)."
          />
          {limpio && limpio !== texto.trim().toLowerCase() && !error && (
            <p className="-mt-2 text-sm text-tinta-2">
              Se usará <span className="valor font-medium text-tinta">{limpio}</span>.
            </p>
          )}
          {hayCloudflare && (
            <div className="rounded-lg border border-regla bg-hoja-2 px-3 py-2.5">
              <Casilla
                checked={autoDns}
                onChange={setAutoDns}
                label="Configurar el DNS automáticamente en Cloudflare"
                help={`Si la zona está en una de tus cuentas conectadas (${(cuentas.data?.accounts ?? [])
                  .map((c) => c.label)
                  .join(', ')}), se crean los registros que faltan sin tocar lo que ya existe.`}
              />
            </div>
          )}
        </form>
      </Hoja>

      <PieDePaso
        principal={
          <Button
            type="submit"
            form={idFormulario}
            variant="principal"
            busy={alta.isPending}
            disabled={sinPlazas || ctx.suspendido}
          >
            Continuar
          </Button>
        }
      />
    </>
  );
}

/* ---------------------------------- DNS ------------------------------------ */

function DnsDominio({
  ctx,
  dominioLista,
  tituloRef,
}: {
  ctx: ContextoPuesta;
  dominioLista: DominioCorreo;
  tituloRef: Ref<HTMLHeadingElement>;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = dominioLista.id;
  const [recien, setRecien] = useState(false);

  // La ficha (misma clave que /dominios/:id): la comprobación la actualiza al
  // momento, sin esperar a releer la lista.
  const ficha = useQuery({
    queryKey: ['domain', id],
    queryFn: () => api.get<{ domain: DominioCorreo }>(`/api/domains/${id}`),
    initialData: { domain: dominioLista },
    initialDataUpdatedAt: 0,
  });
  const dominio = ficha.data.domain;

  const cuentas = useQuery({
    queryKey: ['cloudflare-accounts'],
    queryFn: () => api.get<{ accounts: CuentaCloudflare[] }>('/api/cloudflare/accounts'),
  });
  const utilizables = cuentasUtilizables(cuentas.data?.accounts ?? [], { clientId: dominio.clientId, isAdmin: false });
  // Con la zona en una cuenta conectada, Cloudflare es el camino corto: va
  // antes que los registros para copiar.
  const conCloudflare =
    Boolean(dominio.cloudflare) || utilizables.some((c) => c.zones?.some((z) => zonaCubre(z, dominio.domain)));

  async function tras(data: { domain: DominioCorreo }) {
    queryClient.setQueryData(['domain', id], data);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['domains'] }),
      queryClient.invalidateQueries({ queryKey: ['client-dashboard'] }),
    ]);
  }

  const comprobar = useMutation({
    mutationFn: () => api.post<{ domain: DominioCorreo }>(`/api/domains/${id}/verify`),
    onSuccess: async (data) => {
      const antes = dominio;
      await tras(data);
      setRecien(true);
      const d = data.domain;
      if (d.dnsStatus.allRequiredOk) {
        toast('ok', 'Todo correcto: tu dominio ya puede enviar y recibir correo.');
      } else if (propiedadPendiente(antes) && !propiedadPendiente(d)) {
        toast('ok', 'Propiedad comprobada: ya puedes crear los buzones de tu equipo.');
      } else if (propiedadPendiente(d)) {
        toast(
          'error',
          'Todavía no se ve el registro de verificación. Si acabas de crearlo, espera unos minutos: se vuelve a comprobar solo.',
        );
      } else if (medicionIlegible(d)) {
        toast('error', 'No se ha podido consultar el DNS ahora mismo. Vuelve a comprobarlo en unos minutos.');
      } else {
        toast(
          'ok',
          `Comprobado: ${d.dnsStatus.requiredOk ?? 0} de ${d.dnsStatus.requiredTotal ?? 0} registros correctos.`,
        );
      }
    },
    onError: (err) => toast('error', err instanceof ApiError ? err.message : 'No se ha podido comprobar el DNS.'),
  });

  const pendientePropiedad = propiedadPendiente(dominio);
  const todoBien = Boolean(dominio.dnsStatus.allRequiredOk) || dominio.status === 'active';

  // Mientras falte algo, se vuelve a comprobar solo cada minuto (sin avisos,
  // salvo la buena noticia): quien ha creado el registro no tiene que volver
  // a pulsar el botón cada vez.
  const intentos = useRef(0);
  const [comprobandoSolo, setComprobandoSolo] = useState(false);
  useEffect(() => {
    if (todoBien) return;
    const reloj = window.setInterval(async () => {
      if (document.hidden || intentos.current >= MAX_AUTO) return;
      intentos.current += 1;
      setComprobandoSolo(true);
      try {
        const antes = queryClient.getQueryData<{ domain: DominioCorreo }>(['domain', id])?.domain;
        const data = await api.post<{ domain: DominioCorreo }>(`/api/domains/${id}/verify?auto=1`);
        queryClient.setQueryData(['domain', id], data);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['domains'] }),
          queryClient.invalidateQueries({ queryKey: ['client-dashboard'] }),
        ]);
        if (data.domain.dnsStatus.allRequiredOk) {
          toast('ok', 'Todo correcto: tu dominio ya puede enviar y recibir correo.');
        } else if (antes && propiedadPendiente(antes) && !propiedadPendiente(data.domain)) {
          toast('ok', 'Propiedad comprobada: ya puedes crear los buzones de tu equipo.');
        }
      } catch {
        // Un fallo puntual no interrumpe nada: se intenta en la próxima vuelta.
      } finally {
        setComprobandoSolo(false);
      }
    }, INTERVALO_AUTO_MS);
    return () => window.clearInterval(reloj);
  }, [id, todoBien, queryClient, toast]);

  const checks = dominio.dnsStatus.checks ?? [];
  const obligatorios = checks.filter((c) => c.required);
  const correctos = dominio.dnsStatus.requiredOk ?? obligatorios.filter((c) => c.status === 'ok').length;
  const total = dominio.dnsStatus.requiredTotal ?? obligatorios.length;
  const medido = Boolean(dominio.lastCheckedAt);
  const ilegible = medido && medicionIlegible(dominio);
  const visible = nombreVisible(dominio);

  const titulo = todoBien
    ? `${visible} está listo`
    : pendientePropiedad
      ? `Conecta ${visible}`
      : `Termina el DNS de ${visible}`;

  const bloqueCloudflare = <BloqueCloudflare dominio={dominio} isAdmin={false} />;

  return (
    <>
      <CabeceraPaso ref={tituloRef} titulo={<span className="break-all">{titulo}</span>}>
        {todoBien ? (
          'El dominio ya puede enviar y recibir correo. Sigue con los buzones de tu equipo.'
        ) : (
          <>
            El DNS le dice a Internet que el correo de tu dominio llega a este servidor. Se cambia en el
            panel de la empresa donde gestionas el dominio, en el apartado «DNS» o «Zona DNS».
          </>
        )}
      </CabeceraPaso>

      <Hoja
        title="Estado del dominio"
        meta={medido ? `Comprobado: ${formatDate(dominio.lastCheckedAt)}` : 'Sin comprobar'}
        actions={
          <Button variant="perfil" busy={comprobar.isPending} onClick={() => comprobar.mutate()}>
            Comprobar ahora
          </Button>
        }
        flush
      >
        <FilaEstado
          concepto="El dominio es tuyo"
          veredicto={pendientePropiedad ? 'vigilar' : 'normal'}
          estado={pendientePropiedad ? 'Pendiente' : 'Comprobado'}
          nota={
            pendientePropiedad
              ? 'Es lo primero: sin esta comprobación no se pueden crear buzones.'
              : 'Ya puedes crear los buzones de tu equipo.'
          }
        />
        <FilaEstado
          concepto="Registros para enviar y recibir correo"
          veredicto={!medido || ilegible ? 'sin-dato' : correctos >= total ? 'normal' : 'vigilar'}
          estado={!medido ? 'Sin comprobar' : ilegible ? 'Sin dato' : `${correctos} de ${total} correctos`}
          nota={
            todoBien
              ? undefined
              : ilegible
                ? 'No se ha podido consultar el DNS. Se vuelve a intentar solo.'
                : 'Hasta que estén todos, el correo no llega ni sale. Puedes ir creando los buzones mientras tanto.'
          }
        />
        {!todoBien && (
          <p className="border-t border-regla px-4 py-2.5 text-sm text-tinta-3" aria-live="polite">
            {comprobandoSolo
              ? 'Comprobando el DNS…'
              : 'Se comprueba solo cada minuto mientras tengas esta página abierta. Los cambios de DNS pueden tardar unos minutos en verse.'}
          </p>
        )}
      </Hoja>

      {ficha.isError && (
        <AvisoError onRetry={() => void ficha.refetch()} retrying={ficha.isFetching}>
          No se ha podido actualizar el estado del dominio.
        </AvisoError>
      )}

      {!todoBien && conCloudflare && bloqueCloudflare}

      {pendientePropiedad && dominio.ownershipRecord && (
        <BloquePropiedad
          registro={dominio.ownershipRecord}
          midiendo={comprobar.isPending}
          onVerificar={() => comprobar.mutate()}
          titulo="Primero, demuestra que el dominio es tuyo"
          explicacion={
            <p>
              Crea este registro TXT en el DNS de tu dominio y pulsa «Verificar». No cambia nada del correo
              que ya funcione. También queda comprobado en cuanto el registro MX de la lista de abajo apunte a
              este servidor.
            </p>
          }
          pie={
            <p className="max-w-[75ch] text-sm text-tinta-3">
              En la mayoría de proveedores: «Añadir registro», tipo TXT, el nombre y el valor tal cual. Si el
              proveedor añade el dominio al nombre por su cuenta, escribe solo la parte de delante.
            </p>
          }
        />
      )}

      {!todoBien && (
        <Hoja
          title="Registros que hay que crear"
          meta={ilegible ? 'Sin dato' : `${correctos} de ${total} correctos`}
          flush
        >
          {obligatorios.length === 0 ? (
            ficha.isFetching ? (
              <Cargando label="Leyendo los registros del dominio…" />
            ) : (
              <p className="px-4 py-3.5 text-base text-tinta-2">
                Aún no hay lectura del DNS. Pulsa «Comprobar ahora» para ver los registros que hay que crear.
              </p>
            )
          ) : (
            <>
              <p className="regla-fila px-4 py-3 text-sm text-tinta-2">
                Copia cada uno en el DNS de tu dominio con el mismo tipo, nombre y valor. Cuando estén todos, pulsa
                «Comprobar ahora».
              </p>
              <ul>
                {porVeredicto(obligatorios).map((check) => (
                  <RegistroMedido key={check.id} check={check} recien={recien} />
                ))}
              </ul>
            </>
          )}
          <p className="border-t border-regla px-4 py-3 text-sm text-tinta-2">
            Los registros recomendados (configuración automática de los móviles) y el fichero para importarlos de una
            vez están en la{' '}
            <Link to={`/dominios/${id}`} className="text-petroleo underline underline-offset-2 hover:text-tinta">
              ficha completa del dominio
            </Link>
            .
          </p>
        </Hoja>
      )}

      {!todoBien && !conCloudflare && bloqueCloudflare}

      <PieDePaso
        principal={
          <Button variant="principal" disabled={pendientePropiedad} onClick={() => ctx.irA('equipo')}>
            Continuar
          </Button>
        }
        nota={
          pendientePropiedad
            ? 'Para continuar falta comprobar que el dominio es tuyo.'
            : !todoBien
              ? 'Puedes seguir: los buzones ya se pueden crear. El correo funcionará cuando estén todos los registros.'
              : undefined
        }
      />
    </>
  );
}

