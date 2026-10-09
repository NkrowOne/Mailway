import { useState, type FormEvent, type ReactNode } from 'react';
import { Server } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type User } from '../lib/api';
import { formatDate, formatDay } from '../lib/format';
import {
  nombreMotor,
  notaEnEjecucion,
  ORDEN_VEREDICTO,
  resumenTls,
  veredictoEnEjecucion,
  veredictoTls,
  type CuentaCloudflare,
  type EngineStatus,
  type EngineTlsStatus,
  type RecommendedResult,
} from '../lib/motor';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import { AvisoError, AvisoEspera, Hoja, Marca, Cargando, Vacio, type Veredicto } from '../ui/kit';
import { useToast } from '../ui/toast';
import { BandaAviso } from './gestion/comun';

/**
 * Servidor de correo: qué motor hay detrás (Stalwart 0.15 o 0.16), nombre del
 * servidor en el motor, ajustes recomendados y certificado TLS (estado,
 * emisión con Let's Encrypt mediante Cloudflare en 0.15, recarga). Se
 * muestra en Ajustes.
 *
 * Los programas de correo exigen un certificado válido en IMAP y SMTP; por
 * eso el estado se mide conectando al puerto 993 como lo haría un móvil, y
 * no leyendo la configuración del motor.
 */
export function HojaServidorCorreo() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const estado = useQuery({
    queryKey: ['engine-status'],
    queryFn: () => api.get<EngineStatus>('/api/engine/status'),
    staleTime: 60_000,
  });

  const refrescar = () => void queryClient.invalidateQueries({ queryKey: ['engine-status'] });

  const aplicar = useMutation({
    mutationFn: () => api.post<RecommendedResult>('/api/engine/recommended'),
    onSuccess: (res) => {
      if (res.errors.length > 0) {
        toast('error', `El motor rechazó parte de los ajustes: ${res.errors[0]}`);
      } else if (res.restartRequired && res.restartRequired.length > 0) {
        // Guardado, pero un puerto nuevo solo se abre al reiniciar el contenedor.
        toast('error', `Ajustes guardados. Reinicia el motor para aplicar: ${res.restartRequired.join('; ')}.`);
      } else if (res.running && res.running !== res.hostname) {
        // Guardado y recargado, pero el motor sigue anunciándose con otro
        // nombre: lo fija su configuración local, y eso no es un éxito.
        toast(
          'error',
          `Ajustes aplicados, pero el motor sigue anunciándose como ${res.running}. Revisa su configuración local.`,
        );
      } else {
        toast('ok', `Ajustes recomendados aplicados en el motor para ${res.hostname}.`);
      }
      refrescar();
    },
    onError: (err) => toast('error', err instanceof ApiError ? err.message : 'No se han podido aplicar los ajustes.'),
  });

  const recargar = useMutation({
    mutationFn: () => api.post<{ ok: boolean; tls: EngineTlsStatus }>('/api/engine/reload-certificate'),
    onSuccess: (res) => {
      queryClient.setQueryData<EngineStatus>(['engine-status'], (prev) => (prev ? { ...prev, tls: res.tls } : prev));
      toast('ok', 'Certificado recargado en el motor.');
    },
    onError: (err) => toast('error', err instanceof ApiError ? err.message : 'No se ha podido recargar el certificado.'),
  });

  if (estado.isPending) {
    return (
      <Hoja title="Servidor de correo" className="min-w-0">
        <Cargando label="Cargando el servidor de correo…" />
      </Hoja>
    );
  }

  if (estado.isError || !estado.data) {
    return (
      <Hoja title="Servidor de correo" className="min-w-0">
        <BandaError
          texto={
            estado.error instanceof ApiError
              ? estado.error.message
              : 'No se ha podido leer el estado del servidor de correo. Comprueba que Mailway sigue en marcha.'
          }
        />
        <Button variant="perfil" className="mt-3" onClick={() => void estado.refetch()}>
          Reintentar
        </Button>
      </Hoja>
    );
  }

  const data = estado.data;
  if (data.engine.kind !== 'stalwart') {
    return (
      <Hoja title="Servidor de correo" className="min-w-0">
        <Vacio icono={Server} title={data.engine.kind === 'demo' ? 'Modo demostración' : 'Motor sin conectar'}>
          {data.engine.kind === 'demo'
            ? 'No hay un servidor de correo real. El nombre del servidor y el certificado se configuran al conectar Stalwart en «Motor de correo».'
            : 'Conecta el motor en «Motor de correo» para configurar el nombre del servidor y el certificado.'}
        </Vacio>
      </Hoja>
    );
  }

  const tls = data.tls;
  const filas = construirFilas(data);

  return (
    <Hoja
      title="Servidor de correo"
      meta={data.hostname.expected ?? 'Sin nombre de servidor'}
      className="min-w-0"
      flush
    >
      {data.maintenance.active && (
        <div className="px-4 pt-4">
          <BandaAviso>
            <strong className="font-semibold">El servidor de correo se está actualizando.</strong> Hasta que termine
            {data.maintenance.until ? ` (como muy tarde, ${formatDate(data.maintenance.until)})` : ''} no se pueden
            hacer cambios en dominios, buzones, alias ni contraseñas, y el vigilante no avisa de que el motor no responde.
          </BandaAviso>
        </div>
      )}
      {data.engine.error && (
        <div className="px-4 pt-4">
          <BandaError texto={`No se ha podido leer la configuración del motor: ${data.engine.error}`} />
        </div>
      )}
      {data.restartRequired.length > 0 && (
        <div className="px-4 pt-4">
          <BandaAviso>
            <strong className="font-semibold">El motor necesita reiniciarse</strong> para aplicar lo que tiene guardado:{' '}
            {data.restartRequired.join('; ')}. Reinicia su contenedor (por ejemplo, «docker restart mailway-mail») y
            pulsa «Comprobar de nuevo».
          </BandaAviso>
        </div>
      )}

      <div className="regla-cabecera hidden items-baseline gap-x-4 px-4 pb-1.5 pt-3 sm:flex">
        <span className="rotulo min-w-0 flex-1">Concepto</span>
        <span className="rotulo shrink-0">Veredicto</span>
      </div>
      <div>
        {filas.map((fila) => (
          <FilaEstado key={fila.concepto} {...fila} />
        ))}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-regla px-4 py-3">
        {(!data.recommendedApplied || data.hostname.runningOk === false) && (
          <Button
            variant="perfil"
            busy={aplicar.isPending}
            disabled={!data.hostname.expected}
            onClick={() => aplicar.mutate()}
          >
            Aplicar ajustes recomendados
          </Button>
        )}
        <Button variant="perfil" busy={recargar.isPending} onClick={() => recargar.mutate()}>
          Recargar certificado
        </Button>
        <Button variant="plano" busy={estado.isFetching && !estado.isPending} onClick={refrescar}>
          Comprobar de nuevo
        </Button>
      </div>
      <AvisoEspera activo={aplicar.isPending} className="px-4 pb-3">
        Aplicando los ajustes en el motor y recargándolo. Puede tardar un minuto o más.
      </AvisoEspera>
      {!data.hostname.expected && (
        <p className="px-4 pb-3 text-sm text-tinta-3">
          Indica el nombre del servidor de correo en «Identidad del servidor» para poder aplicar los
          ajustes y emitir el certificado.
        </p>
      )}

      {data.hostname.expected && data.acmeSupported && (
        <EmisionCertificado
          estado={data}
          tlsOk={tls.ok}
          onEmitido={refrescar}
        />
      )}
      {!data.acmeSupported && (
        <p className="max-w-[75ch] border-t border-regla px-4 py-3 text-sm text-tinta-2">
          Con Stalwart 0.16 el certificado del servidor de correo lo obtiene Traefik y el extractor lo copia al motor,
          que lo recarga a diario: el motor ya no lo emite por sí mismo. Si caduca o aparece como autofirmado, revisa el
          extractor («docker logs mailway-certs-dumper») o ejecuta «sudo bash deploy/instalar.sh --comprobar».
        </p>
      )}
    </Hoja>
  );
}

/* --------------------------------- Filas ---------------------------------- */

export interface Fila {
  concepto: string;
  valor: string;
  veredicto: Veredicto;
  marca?: string;
  nota?: ReactNode;
}


function construirFilas(data: EngineStatus): Fila[] {
  const filas: Fila[] = [];
  const esperado = data.hostname.expected;

  // Qué versión del motor hay detrás de la URL: cambia lo que se puede
  // gestionar (el ACME propio, el límite de contraseñas de aplicación…).
  filas.push({
    concepto: 'Motor de correo',
    valor: nombreMotor(data.api),
    veredicto: data.api ? 'normal' : 'sin-dato',
    nota: data.api ? undefined : 'No se ha podido averiguar la versión del motor: no responde o rechaza las credenciales.',
  });

  filas.push({
    concepto: 'Nombre guardado en el motor',
    valor: data.hostname.configured ?? 'Sin fijar',
    veredicto: data.engine.error
      ? 'sin-dato'
      : data.hostname.ok
        ? 'normal'
        : data.hostname.configured
          ? 'fuera'
          : 'vigilar',
    nota: data.hostname.ok
      ? undefined
      : esperado
        ? `El motor debe anunciarse como ${esperado}. Sin ese nombre, los registros MX y SRV que propone apuntan al identificador del contenedor.`
        : 'Falta el nombre del servidor de correo en la identidad del servidor.',
  });

  // Lo guardado no basta: el nombre que cuenta es con el que el motor genera
  // los registros de los dominios (el destino de su MX).
  filas.push({
    concepto: 'Nombre en ejecución',
    valor: data.hostname.running ?? 'Sin dato',
    veredicto: veredictoEnEjecucion(data),
    nota: notaEnEjecucion(data),
  });

  filas.push({
    concepto: 'Ajustes recomendados del motor',
    valor: data.recommendedApplied ? 'Aplicados' : 'Pendientes',
    veredicto: data.engine.error ? 'sin-dato' : data.recommendedApplied ? 'normal' : 'vigilar',
    nota: data.recommendedApplied ? undefined : (
      <>
        Confianza en la cabecera X-Forwarded-For de Traefik y exención de bloqueo automático para la
        red interna del webmail
        {data.trustedNetworks.length > 0 && (
          <>
            {' '}
            (<span className="valor">{data.trustedNetworks.join(', ')}</span>)
          </>
        )}
        . Sin ellos, un escáner puede bloquear la IP de Traefik y los errores de contraseña del
        webmail acaban bloqueando al propio webmail.
      </>
    ),
  });

  // Lo propio de cada versión del motor (en 0.16: puerto 587, límite de
  // contraseñas de aplicación, autoservicio bloqueado…).
  for (const comprobacion of data.extraChecks) {
    filas.push({
      concepto: comprobacion.label,
      valor: comprobacion.ok ? 'Aplicado' : 'Pendiente',
      veredicto: data.engine.error ? 'sin-dato' : comprobacion.ok ? 'normal' : 'vigilar',
      nota: comprobacion.ok
        ? undefined
        : data.restartRequired.length > 0
          ? 'Guardado en el motor: se aplica al reiniciar su contenedor.'
          : 'Forma parte de los ajustes recomendados: aplícalos para fijarlo.',
    });
  }

  const tls = data.tls;
  const veredicto = veredictoTls(tls);
  let notaTls: ReactNode;
  if (tls.error) {
    notaTls = `No se ha podido conectar al puerto ${tls.port} de ${tls.host || 'el servidor'}: ${tls.error}`;
  } else {
    const caducidad =
      tls.validTo && tls.daysLeft !== null
        ? tls.daysLeft < 0
          ? `Caducó el ${formatDay(Date.parse(tls.validTo))}.`
          : `Caduca el ${formatDay(Date.parse(tls.validTo))} (${tls.daysLeft} ${tls.daysLeft === 1 ? 'día' : 'días'}).`
        : '';
    const problema = tls.selfSigned
      ? 'Los programas de correo muestran un aviso de seguridad con un certificado autofirmado.'
      : tls.hostnameMatches === false
        ? `El certificado es de «${tls.subject ?? 'otro nombre'}», no de ${esperado}.`
        : tls.authorizationError
          ? `La cadena no es de confianza (${tls.authorizationError}).`
          : '';
    const via =
      tls.via === 'interno'
        ? ` Comprobado desde la red interna: el nombre público no respondió desde el panel (${tls.publicError ?? 'sin detalle'}); comprueba que el puerto ${tls.port} está abierto en el cortafuegos.`
        : '';
    notaTls = `${[problema, caducidad].filter(Boolean).join(' ')}${via}`.trim() || undefined;
  }
  filas.push({
    concepto: `Certificado TLS (IMAP ${tls.port})`,
    valor: resumenTls(tls),
    veredicto,
    nota: notaTls,
  });

  const origen = data.acme.configured
    ? `Let’s Encrypt · ${data.acme.provider === 'cloudflare' ? 'Cloudflare' : (data.acme.provider ?? 'ACME')}`
    : data.certificateFiles
      ? 'Volcado de Traefik'
      : 'Sin configurar';
  const sinEmision = data.acmeSupported
    ? 'El motor no renueva ningún certificado por sí mismo.'
    : 'El extractor de Traefik aún no ha dejado el certificado en el motor.';
  filas.push({
    concepto: 'Emisión y renovación',
    valor: origen,
    veredicto: data.acme.configured || data.certificateFiles ? 'normal' : 'vigilar',
    nota: data.acme.configured
      ? [
          data.acme.accountLabel ? `Cuenta «${data.acme.accountLabel}»` : null,
          data.acme.zone ? `zona ${data.acme.zone}` : null,
          data.acme.contact ? `contacto ${data.acme.contact}` : null,
        ]
          .filter(Boolean)
          .join(', ') || undefined
      : data.certificateFiles
        ? 'El motor lee el certificado que obtiene Traefik; se recarga a diario.'
        : sinEmision,
  });

  return filas.sort((a, b) => ORDEN_VEREDICTO[a.veredicto] - ORDEN_VEREDICTO[b.veredicto]);
}

/** Fila de estado: concepto, valor medido y veredicto; el veredicto tiñe la fila. */
export function FilaEstado({ concepto, valor, veredicto, nota }: Fila) {
  const fondo = veredicto === 'fuera' ? 'fila-fuera' : veredicto === 'vigilar' ? 'fila-vigilar' : '';
  return (
    <div className={`regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5 ${fondo}`}>
      <span className="min-w-0 flex-1 basis-40 text-base text-tinta">{concepto}</span>
      <span className="valor min-w-0 break-all text-sm text-tinta">{valor}</span>
      <span className="shrink-0 basis-28 text-right">
        <Marca veredicto={veredicto} />
      </span>
      {nota && <p className="w-full max-w-[75ch] text-sm text-tinta-2">{nota}</p>}
    </div>
  );
}

/* ------------------------- Emisión del certificado ------------------------ */

function EmisionCertificado({
  estado,
  tlsOk,
  onEmitido,
}: {
  estado: EngineStatus;
  tlsOk: boolean;
  onEmitido: () => void;
}) {
  const toast = useToast();
  // Con un certificado bueno y emisión configurada, el formulario queda
  // plegado: volver a emitir es la excepción, no la tarea del día.
  const [abierto, setAbierto] = useState(!estado.acme.configured && !tlsOk);
  const cuentas = useQuery({
    queryKey: ['cloudflare-accounts', 'servidor-correo'],
    queryFn: () => api.get<{ accounts: CuentaCloudflare[] }>('/api/cloudflare/accounts'),
    enabled: abierto,
    staleTime: 30_000,
    retry: false,
  });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User | null }>('/api/auth/me'),
    staleTime: Infinity,
  });

  // Solo las cuentas de la instancia: el certificado es de la plataforma.
  const instancia = (cuentas.data?.accounts ?? []).filter((c) => c.clientId === null);
  const [cuentaId, setCuentaId] = useState('');
  // null = sin tocar: se propone el contacto anterior o el correo del administrador.
  const [email, setEmail] = useState<string | null>(null);
  const cuentaElegida = cuentaId || instancia[0]?.id || '';
  const contacto = email ?? (estado.acme.contact || me.data?.user?.email || '');

  const emitir = useMutation({
    mutationFn: () =>
      api.post<{ errors: string[]; acme: { zone: string } }>('/api/engine/acme', {
        cloudflareAccountId: cuentaElegida,
        email: contacto,
      }),
    onSuccess: (res) => {
      if (res.errors.length > 0) {
        toast('error', `El motor aceptó la configuración con errores: ${res.errors[0]}`);
      } else {
        toast(
          'ok',
          `Emisión solicitada en la zona ${res.acme.zone}. Let’s Encrypt tarda unos minutos; pulsa «Comprobar de nuevo» después.`,
        );
        setAbierto(false);
      }
      onEmitido();
    },
  });

  const [errorContacto, setErrorContacto] = useState('');

  function enviar(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contacto.trim())) {
      setErrorContacto('Indica un correo de contacto válido.');
      return;
    }
    emitir.mutate();
  }

  if (!abierto) {
    return (
      <div className="border-t border-regla px-4 py-3">
        <Button variant="plano" onClick={() => setAbierto(true)}>
          {estado.acme.configured
            ? 'Volver a emitir con otra cuenta de Cloudflare'
            : 'Emitir certificado con Let’s Encrypt mediante Cloudflare'}
        </Button>
      </div>
    );
  }

  return (
    <div className="border-t border-regla px-4 py-4">
      <h3 className="rotulo mb-2">Emitir certificado con Let’s Encrypt mediante Cloudflare</h3>
      <p className="mb-3 max-w-[75ch] text-sm text-tinta-2">
        El motor solicita el certificado de {estado.hostname.expected} con un registro DNS temporal
        en Cloudflare y lo renueva solo 30 días antes de caducar. No depende de Traefik ni del puerto
        80, y sirve para IMAP y SMTP.
      </p>

      {cuentas.isPending ? (
        <Cargando label="Leyendo las cuentas de Cloudflare…" />
      ) : cuentas.isError ? (
        <BandaError
          texto={
            cuentas.error instanceof ApiError
              ? `No se han podido leer las cuentas de Cloudflare: ${cuentas.error.message}`
              : 'No se han podido leer las cuentas de Cloudflare.'
          }
        />
      ) : instancia.length === 0 ? (
        <p className="text-sm text-tinta-2">
          No hay ninguna cuenta de Cloudflare de la instancia.{' '}
          <Link to="/conexiones" className="font-semibold text-petroleo underline underline-offset-2">
            Conectar una cuenta en Conexiones
          </Link>{' '}
          con permisos de Zona: Lectura y DNS: Edición sobre la zona de {estado.hostname.expected}.
        </p>
      ) : (
        <form onSubmit={enviar} noValidate className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Cuenta de Cloudflare" value={cuentaElegida} onChange={(e) => setCuentaId(e.target.value)}>
              {instancia.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} (…{c.tokenHint})
                </option>
              ))}
            </Select>
            <Input
              label="Correo de contacto"
              type="email"
              value={contacto}
              onChange={(e) => {
                setErrorContacto('');
                setEmail(e.target.value);
              }}
              error={errorContacto || undefined}
              help="Let’s Encrypt avisa a esta dirección si una renovación falla."
            />
          </div>
          {emitir.isError && (
            <BandaError
              texto={emitir.error instanceof ApiError ? emitir.error.message : 'No se ha podido solicitar el certificado.'}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="principal" busy={emitir.isPending} disabled={!cuentaElegida || !contacto}>
              Emitir certificado
            </Button>
            {(estado.acme.configured || tlsOk) && (
              <Button type="button" variant="plano" onClick={() => setAbierto(false)}>
                Cancelar
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

/** Error en línea: la banda de error común del kit, con el texto indicado. */
export function BandaError({ texto, onRetry }: { texto: string; onRetry?: () => void }) {
  return <AvisoError onRetry={onRetry}>{texto}</AvisoError>;
}
