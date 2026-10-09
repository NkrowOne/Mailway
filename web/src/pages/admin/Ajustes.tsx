import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type InstanceSettings } from '../../lib/api';
import { formatDate, plural } from '../../lib/format';
import {
  etiquetaHost,
  peorEstado,
  usoHost,
  veredictoHost,
  type ConfiguracionTraefik,
  type EstadoAutoconfig,
  type EstadoHostAutoconfig,
  type ResumenComprobacion,
  type UsoHost,
} from '../../lib/rutas';
import { HojaServidorCorreo } from '../../components/HojaServidorCorreo';
import { nombreMotor, type EngineApi } from '../../lib/motor';
import { HojaWebmailAutomaticoGeneral } from '../../components/WebmailAutomatico';
import { Button } from '../../ui/Button';
import { Input, Select } from '../../ui/Field';
import { AvisoError, Hoja, Marca, MarcaFondo, Membrete, Cargando, Muestra } from '../../ui/kit';
import { useToast } from '../../ui/toast';

interface SettingsResponse {
  instance: InstanceSettings;
  engine: {
    kind: 'stalwart' | 'demo';
    url: string;
    adminUser: string;
    hasPassword: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
  } | null;
  demoMode: boolean;
}

const META =
  'Identidad del servidor, conexión con el motor de correo y rutas que Traefik publica para los dominios de los clientes.';

export default function Ajustes() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<SettingsResponse>('/api/settings'),
  });

  if (settings.isPending) {
    return (
      <>
        <Membrete title="Ajustes" meta={META} />
        <Hoja>
          <Cargando label="Cargando los ajustes…" />
        </Hoja>
      </>
    );
  }
  if (settings.isError || !settings.data) {
    return (
      <>
        <Membrete title="Ajustes" meta={META} />
        <AvisoError onRetry={() => void settings.refetch()} retrying={settings.isFetching}>
          No se han podido cargar los ajustes. Comprueba que el servidor de Mailway sigue en marcha y vuelve a
          intentarlo.
        </AvisoError>
      </>
    );
  }

  // Cambiar el nombre del servidor o la IP cambia los registros y las rutas:
  // se vuelve a leer lo que depende de ellos, y nada más. Invalidar toda la
  // caché reponía también el formulario de la otra hoja y borraba en silencio
  // lo que se estuviera escribiendo en ella.
  const refrescarIdentidad = () => {
    for (const clave of [
      ['settings'],
      ['setup'],
      ['admin-dashboard'],
      ['server-health'],
      ['autoconfig-status'],
      ['whitelabel-setup'],
      ['domains'],
      ['domain'],
      ['conexion'],
      ['integrations-info'],
    ]) {
      void queryClient.invalidateQueries({ queryKey: clave });
    }
  };
  const refrescarMotor = () => {
    for (const clave of [['settings'], ['setup'], ['admin-dashboard'], ['engine-status']]) {
      void queryClient.invalidateQueries({ queryKey: clave });
    }
  };

  return (
    <>
      <Membrete title="Ajustes" meta={META} />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <HojaIdentidad initial={settings.data.instance} onSaved={refrescarIdentidad} />
        <HojaMotor data={settings.data} onSaved={refrescarMotor} toast={toast} />
        {/* Hoja propia del área del motor; si no tiene nada que mostrar, no ocupa sitio. */}
        <div className="min-w-0 empty:hidden lg:col-span-2">
          <HojaServidorCorreo />
        </div>
        <HojaAutoconfiguracion />
        <HojaWebmailAutomaticoGeneral />
        <HojaTraefik />
      </div>
    </>
  );
}

/** Aviso sobre papel (vigilar): algo que conviene resolver, sin ser un error. */
function Aviso({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-[rgb(var(--vigilar)/0.35)] bg-vigilar-fondo px-3 py-2 text-sm text-tinta">
      {children}
    </div>
  );
}

/* ------------------------------- Identidad -------------------------------- */

function HojaIdentidad({ initial, onSaved }: { initial: InstanceSettings; onSaved: () => void }) {
  const toast = useToast();
  // Sin URL guardada ni detectada (PUBLIC_URL), se propone la del navegador:
  // es por donde el administrador está entrando al panel ahora mismo.
  const propuesta = !initial.panelUrl && typeof window !== 'undefined' ? window.location.origin : '';
  const [form, setForm] = useState<InstanceSettings>({ ...initial, panelUrl: initial.panelUrl || propuesta });
  const [error, setError] = useState('');
  // Con cambios sin guardar, una relectura de los ajustes (al guardar el
  // motor, por ejemplo) no debe pisar lo que se está escribiendo.
  const [modificado, setModificado] = useState(false);
  useEffect(() => {
    if (modificado) return;
    setForm({ ...initial, panelUrl: initial.panelUrl || propuesta });
  }, [initial, propuesta, modificado]);

  const save = useMutation({
    mutationFn: () => api.put('/api/settings/instance', form),
    onSuccess: () => {
      setError('');
      setModificado(false);
      toast('ok', 'Se han guardado los ajustes del servidor.');
      onSaved();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'No se han podido guardar los ajustes.'),
  });

  const detectar = useMutation({
    mutationFn: () => api.get<{ ip: string }>('/api/setup/detect-ip'),
    onSuccess: (data) => {
      if (data.ip) {
        setModificado(true);
        setForm((f) => ({ ...f, publicIp: data.ip }));
        toast('ok', `IP pública detectada: ${data.ip}. Guarda los cambios para aplicarla.`);
      } else {
        toast('error', 'No se ha podido detectar la IP pública. Introdúcela manualmente.');
      }
    },
    onError: () => toast('error', 'No se ha podido detectar la IP pública. Introdúcela manualmente.'),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.brandName.trim()) {
      setError('Indica el nombre del servicio.');
      return;
    }
    save.mutate();
  }

  const set = (campo: keyof InstanceSettings) => (e: { target: { value: string } }) => {
    setError('');
    setModificado(true);
    setForm((f) => ({ ...f, [campo]: e.target.value }));
  };

  return (
    <Hoja title="Identidad del servidor" className="min-w-0">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Input
          label="Nombre del servicio"
          value={form.brandName}
          onChange={set('brandName')}
          help="Aparece en el panel, en los perfiles de configuración y en los avisos."
        />
        <Input
          label="URL pública del panel"
          mono
          value={form.panelUrl}
          onChange={set('panelUrl')}
          placeholder="https://panel.tuempresa.com"
          help={
            propuesta && form.panelUrl === propuesta
              ? 'Propuesta a partir de la dirección actual del navegador. Guarda los cambios para confirmarla.'
              : 'Se usa en los enlaces que reciben los titulares de los buzones (perfil de Apple, «Mi buzón», enlaces de configuración).'
          }
        />
        <Input
          label="Servidor de correo (FQDN)"
          mono
          value={form.mailHostname}
          onChange={set('mailHostname')}
          placeholder="mail.tuempresa.com"
          help="Figura en los datos de conexión de los buzones y en los registros DNS de los dominios."
        />
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Input
              label="IP pública"
              mono
              value={form.publicIp}
              onChange={set('publicIp')}
              placeholder="203.0.113.10"
              inputMode="decimal"
            />
          </div>
          <Button
            type="button"
            variant="perfil"
            className="h-10"
            busy={detectar.isPending}
            onClick={() => detectar.mutate()}
          >
            Detectar
          </Button>
        </div>
        <Input
          label="URL general del webmail"
          mono
          value={form.webmailUrl}
          onChange={set('webmailUrl')}
          placeholder="https://webmail.tuempresa.com"
          help="Se usa para los clientes sin dominio propio de webmail en servicio (se configura en Marca blanca). Si se deja vacía, a esos clientes no se les muestran enlaces al webmail."
        />
        {error && <AvisoError>{error}</AvisoError>}
        {/* Única acción principal de la vista: el resto de hojas usan filete. */}
        <Button type="submit" variant="principal" busy={save.isPending} className="self-start">
          Guardar cambios
        </Button>
      </form>
    </Hoja>
  );
}

/* --------------------------------- Motor ---------------------------------- */

function HojaMotor({
  data,
  onSaved,
  toast,
}: {
  data: SettingsResponse;
  onSaved: () => void;
  toast: (tone: 'ok' | 'error', text: string) => void;
}) {
  const engine = data.engine;
  const [kind, setKind] = useState<'stalwart' | 'demo'>(engine?.kind ?? 'stalwart');
  const [url, setUrl] = useState(engine?.url ?? 'http://mailway-mail:8080');
  const [adminUser, setAdminUser] = useState(engine?.adminUser ?? 'admin');
  const [adminPassword, setAdminPassword] = useState('');
  const [smtpHost, setSmtpHost] = useState(engine?.smtpHost ?? 'mailway-mail');
  const [smtpPort, setSmtpPort] = useState(String(engine?.smtpPort ?? 587));
  const [testResult, setTestResult] = useState<null | { ok: boolean; api?: EngineApi; detail?: string }>(null);
  const [intentado, setIntentado] = useState(false);

  // Cambiar el destino (URL, usuario o servidor SMTP) sin volver a escribir
  // la contraseña reenviaría la guardada a otro servidor: el servidor lo
  // rechaza (engine_password_required) y aquí se avisa antes de enviar.
  const destinoCambia =
    kind === 'stalwart' &&
    engine?.kind === 'stalwart' &&
    (url.trim().replace(/\/+$/, '').toLowerCase() !== engine.url.trim().replace(/\/+$/, '').toLowerCase() ||
      adminUser !== engine.adminUser ||
      smtpHost.trim().toLowerCase() !== engine.smtpHost.trim().toLowerCase());
  const faltaContrasena = kind === 'stalwart' && !adminPassword && (destinoCambia || !engine?.hasPassword);
  const errorContrasena =
    intentado && faltaContrasena
      ? destinoCambia
        ? 'Para cambiar la URL, el usuario o el servidor SMTP del motor, indica también la contraseña.'
        : 'Indica la contraseña del administrador del motor.'
      : undefined;

  const payload = () => ({
    kind,
    url: kind === 'stalwart' ? url : '',
    adminUser,
    adminPassword,
    smtpHost: kind === 'stalwart' ? smtpHost : '',
    smtpPort: Number(smtpPort) || 587,
    smtpSecure: Number(smtpPort) === 465,
  });

  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; api?: EngineApi; detail?: string }>('/api/settings/engine/test', payload()),
    onSuccess: (result) => setTestResult(result),
    onError: (err) =>
      setTestResult({
        ok: false,
        detail: err instanceof ApiError ? err.message : 'No se ha podido contactar con el servidor.',
      }),
  });

  const save = useMutation({
    mutationFn: () => api.put('/api/settings/engine', payload()),
    onSuccess: () => {
      toast('ok', 'Se ha guardado y verificado la conexión con el motor.');
      setAdminPassword('');
      onSaved();
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se ha podido guardar la conexión con el motor.'),
  });

  return (
    <Hoja
      title="Motor de correo"
      className="min-w-0"
      actions={
        data.demoMode ? (
          <MarcaFondo veredicto="vigilar">Demostración (MAILWAY_DEMO)</MarcaFondo>
        ) : engine ? (
          <MarcaFondo veredicto={engine.kind === 'demo' ? 'sin-dato' : 'normal'}>
            {engine.kind === 'demo' ? 'Demostración' : 'Stalwart conectado'}
          </MarcaFondo>
        ) : (
          <MarcaFondo veredicto="vigilar">Sin configurar</MarcaFondo>
        )
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setIntentado(true);
          if (kind === 'stalwart' && (!url.trim() || !adminUser.trim() || !smtpHost.trim())) {
            toast('error', 'Indica la URL de la API de gestión, el usuario administrador y el host SMTP.');
            return;
          }
          if (faltaContrasena) return;
          save.mutate();
        }}
        className="flex flex-col gap-4"
      >
        <Select
          label="Tipo"
          value={kind}
          onChange={(e) => setKind(e.target.value as 'stalwart' | 'demo')}
          disabled={data.demoMode}
        >
          <option value="stalwart">Stalwart (producción)</option>
          <option value="demo">Demostración (sin motor real)</option>
        </Select>
        {kind === 'stalwart' && (
          <>
            <Input
              label="URL de la API de gestión"
              mono
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://mailway-mail:8080"
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Usuario administrador"
                value={adminUser}
                onChange={(e) => setAdminUser(e.target.value)}
              />
              <Input
                label="Contraseña"
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                placeholder={engine?.hasPassword && !destinoCambia ? '(sin cambios)' : ''}
                error={errorContrasena}
                help={
                  engine?.hasPassword
                    ? destinoCambia
                      ? 'Obligatoria: has cambiado la URL, el usuario o el servidor SMTP.'
                      : 'Déjala vacía para conservar la actual. Es obligatoria si cambias la URL, el usuario o el servidor SMTP.'
                    : undefined
                }
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Host SMTP (envíos por API)"
                mono
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
              />
              <Input
                label="Puerto SMTP"
                inputMode="numeric"
                value={smtpPort}
                onChange={(e) => setSmtpPort(e.target.value)}
                help="587 STARTTLS · 465 SSL"
              />
            </div>
          </>
        )}
        {testResult && (
          <p
            role="status"
            className={`revelar border px-3 py-2 text-sm ${
              testResult.ok
                ? 'border-[rgb(var(--normal)/0.35)] bg-normal-fondo text-normal'
                : 'border-[rgb(var(--fuera)/0.35)] bg-fuera-fondo text-fuera'
            }`}
          >
            {testResult.ok
              ? `La conexión con el motor es correcta${testResult.api ? `: ${nombreMotor(testResult.api)}` : ''}.`
              : `No hay conexión con el motor: ${testResult.detail || 'sin detalle'}`}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {kind === 'stalwart' && (
            <Button type="button" variant="perfil" busy={test.isPending} onClick={() => test.mutate()}>
              Probar conexión
            </Button>
          )}
          <Button type="submit" variant="perfil" busy={save.isPending} disabled={data.demoMode}>
            Guardar motor
          </Button>
        </div>
        <p className="text-sm text-tinta-3">
          Probar y guardar la conexión con el motor requiere una sesión iniciada en el panel: no es posible
          hacerlo con un token de gestión.
        </p>
      </form>
    </Hoja>
  );
}

/* -------------------------- Autoconfiguración ----------------------------- */

const COLUMNAS: UsoHost[] = ['autoconfig', 'autodiscover', 'mta-sts'];
const MAX_FILAS = 60;
const ORDEN: Record<string, number> = { pending: 0, unknown: 1, ok: 2 };

function CeldaHost({ uso, host }: { uso: UsoHost; host: EstadoHostAutoconfig | undefined }) {
  return (
    <span className="shrink-0 sm:basis-32">
      <span className="rotulo mr-1.5 sm:hidden">{usoHost[uso]}</span>
      {host ? (
        <span title={host.detail}>
          <Marca veredicto={veredictoHost[host.state]}>{etiquetaHost[host.state]}</Marca>
        </span>
      ) : (
        <span className="valor text-sm text-tinta-3">—</span>
      )}
    </span>
  );
}

/**
 * Hosts que los programas de correo consultan para configurarse solos. Traefik
 * solo los enruta cuando su DNS ya apunta aquí; esta hoja muestra cuáles lo
 * hacen y qué registros faltan en el dominio de la instancia.
 */
function HojaAutoconfiguracion() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const status = useQuery({
    queryKey: ['autoconfig-status'],
    queryFn: () => api.get<EstadoAutoconfig>('/api/autoconfig/status'),
  });

  const comprobar = useMutation({
    mutationFn: () =>
      api.post<{ summary: ResumenComprobacion; status: EstadoAutoconfig }>('/api/autoconfig/refresh'),
    onSuccess: (data) => {
      queryClient.setQueryData(['autoconfig-status'], data.status);
      void queryClient.invalidateQueries({ queryKey: ['whitelabel-setup'] });
      const { ok, pending, unknown } = data.summary;
      toast(
        'ok',
        `Comprobación terminada: ${plural(ok, 'nombre apunta', 'nombres apuntan')} a este servidor, ${pending} sin DNS y ${unknown} sin dato.`,
      );
    },
    onError: (err) =>
      toast('error', err instanceof ApiError ? err.message : 'No se ha podido comprobar el DNS.'),
  });

  const titulo = 'Autoconfiguración de dispositivos';
  if (status.isPending) {
    return (
      <Hoja title={titulo} className="min-w-0 lg:col-span-2">
        <Cargando label="Consultando el estado de los nombres…" />
      </Hoja>
    );
  }
  if (status.isError || !status.data) {
    return (
      <Hoja title={titulo} className="min-w-0 lg:col-span-2">
        <AvisoError onRetry={() => void status.refetch()} retrying={status.isFetching}>
          No se ha podido leer el estado de la autoconfiguración. Si el problema continúa, revisa el registro
          del servidor.
        </AvisoError>
      </Hoja>
    );
  }

  const data = status.data;
  const instancia = data.instance.hosts;
  const dominios = [...data.domains].sort(
    (a, b) =>
      ORDEN[peorEstado(a.hosts.map((h) => h.state))]! - ORDEN[peorEstado(b.hosts.map((h) => h.state))]! ||
      a.domain.localeCompare(b.domain),
  );
  const visibles = dominios.slice(0, MAX_FILAS);
  const instanciaPendiente = instancia.some((h) => h.state !== 'ok');

  return (
    <Hoja
      title={titulo}
      meta={data.checkedAt ? `Comprobado ${formatDate(data.checkedAt)}` : 'Sin comprobar'}
      actions={
        <Button variant="perfil" busy={comprobar.isPending} onClick={() => comprobar.mutate()}>
          Comprobar ahora
        </Button>
      }
      className="min-w-0 lg:col-span-2"
      flush
    >
      <div className="flex flex-col gap-3 p-4">
        <p className="max-w-[75ch] text-base text-tinta-2">
          Thunderbird, Outlook y los móviles se configuran solos al escribir la dirección cuando
          estos nombres apuntan a este servidor. Con los dos nombres de la instancia, Thunderbird
          configura cualquier dominio cuyo MX sea{' '}
          <span className="valor">{data.mailHostname || 'el servidor de correo'}</span> sin
          registros adicionales en el dominio del cliente.
        </p>

        {!data.routingAvailable && (
          <Aviso>
            No se ha detectado el contenedor del panel, por lo que Traefik no puede enrutar estos
            nombres. Despliega el panel con Skyway (lo detecta automáticamente) o define{' '}
            <span className="valor">MAILWAY_PANEL_BACKEND_URL</span>, por ejemplo{' '}
            <span className="valor">http://mailway-panel:4100</span>.
          </Aviso>
        )}

        {data.records.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="rotulo">Registros DNS de la instancia</p>
            <div className="grid gap-2 md:grid-cols-2">
              {data.records.map((r) => (
                <Muestra key={r.name} rotulo={`${r.type} · ${usoHost[r.purpose]}`} copiar={r.value}>
                  <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-base">
                    <dt className="rotulo self-baseline">Nombre</dt>
                    <dd className="valor min-w-0 break-all text-tinta">{r.name}</dd>
                    <dt className="rotulo self-baseline">Valor</dt>
                    <dd className="codigo min-w-0 break-all text-tinta">{r.value}</dd>
                  </dl>
                </Muestra>
              ))}
            </div>
          </div>
        ) : (
          <Aviso>
            Indica el servidor de correo en «Identidad del servidor» para calcular los registros
            DNS de la instancia.
          </Aviso>
        )}
      </div>

      {/* Cabecera de columnas: en móvil cada celda lleva su propio rótulo. */}
      <div className="regla-cabecera hidden items-baseline gap-x-4 border-t border-regla bg-hoja-3 px-4 py-1.5 sm:flex">
        <span className="rotulo min-w-0 flex-1">Dominio</span>
        {COLUMNAS.map((c) => (
          <span key={c} className="rotulo shrink-0 basis-32">
            {usoHost[c]}
          </span>
        ))}
      </div>
      <ul>
        {data.instance.base && (
          <li
            className={`regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-1.5 px-4 py-2.5 ${
              instanciaPendiente ? 'fila-vigilar' : ''
            }`}
          >
            <span className="min-w-0 basis-full sm:basis-0 sm:grow">
              <span className="valor break-all text-base text-tinta">{data.instance.base}</span>
              <span className="rotulo ml-2">Instancia</span>
            </span>
            {COLUMNAS.map((c) => (
              <CeldaHost key={c} uso={c} host={instancia.find((h) => h.purpose === c)} />
            ))}
            {instanciaPendiente && (
              // basis-full fuerza la línea propia; el ancho de lectura va dentro.
              <div className="basis-full">
                <p className="max-w-[75ch] text-sm text-tinta-2">
                  {instancia
                    .filter((h) => h.state !== 'ok')
                    .map((h) => `${h.host}: ${h.detail}`)
                    .join(' ')}{' '}
                  Crea los registros de arriba y pulsa «Comprobar ahora».
                </p>
              </div>
            )}
          </li>
        )}
        {visibles.map((d) => (
          <li
            key={d.domainId}
            className="regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-1.5 px-4 py-2.5 last:border-b-0"
          >
            <span className="min-w-0 basis-full sm:basis-0 sm:grow">
              <span className="valor break-all text-base text-tinta">{d.domain}</span>
              {d.clientName && <span className="ml-2 text-sm text-tinta-3">{d.clientName}</span>}
            </span>
            {COLUMNAS.map((c) => (
              <CeldaHost key={c} uso={c} host={d.hosts.find((h) => h.purpose === c)} />
            ))}
          </li>
        ))}
      </ul>
      {dominios.length > MAX_FILAS && (
        <p className="border-t border-regla px-4 py-2 text-sm text-tinta-3">
          Se muestran {MAX_FILAS} de {dominios.length} dominios, primero los que tienen nombres sin DNS.
        </p>
      )}
      <p className="border-t border-regla px-4 py-3 text-sm text-tinta-3">
        Los nombres de cada dominio son opcionales: sin ellos, los programas de correo usan los de la
        instancia. Cuando apuntan aquí, Traefik los publica y Let&apos;s Encrypt emite su certificado en
        el siguiente sondeo. La comprobación se repite cada hora; una consulta sin respuesta conserva
        el estado anterior.
      </p>
    </Hoja>
  );
}

/* --------------------------------- Traefik --------------------------------- */

/**
 * Conexión de Traefik con Mailway. Con Skyway 0.34 o posterior no hay nada que
 * instalar; para versiones anteriores o un Traefik propio se entrega el bloque
 * exacto, generado en el servidor con los valores reales de esta instancia.
 */
function HojaTraefik() {
  const setup = useQuery({
    queryKey: ['whitelabel-setup'],
    queryFn: () => api.get<ConfiguracionTraefik>('/api/whitelabel/setup'),
    // Traefik consulta cada 15 s: así «Última consulta» se mantiene al día.
    refetchInterval: 15_000,
  });
  const [manual, setManual] = useState<boolean | null>(null);

  const titulo = 'Rutas de Traefik';
  if (setup.isPending) {
    return (
      <Hoja title={titulo} className="min-w-0 lg:col-span-2">
        <Cargando label="Cargando la configuración de Traefik…" />
      </Hoja>
    );
  }
  if (setup.isError || !setup.data) {
    return (
      <Hoja title={titulo} className="min-w-0 lg:col-span-2">
        <AvisoError onRetry={() => void setup.refetch()} retrying={setup.isFetching}>
          No se ha podido cargar la configuración de Traefik. Si el problema continúa, revisa el registro del
          servidor.
        </AvisoError>
      </Hoja>
    );
  }

  const s = setup.data;
  // Más de 90 s sin consultas (seis sondeos perdidos) indica que el proxy ya no
  // llega a Mailway, directamente o a través de Skyway.
  const consultaReciente = s.lastPollAt !== null && Date.now() - s.lastPollAt < 90_000;
  // Bajo Skyway el puente es lo normal: el bloque manual queda plegado.
  const mostrarManual = manual ?? !s.underSkyway;
  // El token es un secreto: va aparte, enmascarado, con «Mostrar» y «Copiar».
  const parametros: { rotulo: string; valor: string; aviso?: string; vigilar?: boolean }[] = [
    { rotulo: 'URL que sondea Traefik', valor: s.providerEndpoint },
    { rotulo: 'Emisor de certificados', valor: s.certResolver },
    { rotulo: 'Destino del webmail', valor: s.webmailBackend },
    {
      rotulo: 'Destino del panel',
      valor: s.panelBackend || 'Sin detectar',
      vigilar: !s.panelBackend,
      aviso: s.panelBackend
        ? undefined
        : 'Sin el contenedor del panel no se publican los dominios de tipo panel ni los nombres de autoconfiguración. Define MAILWAY_PANEL_BACKEND_URL o despliega el panel con Skyway.',
    },
    { rotulo: 'URL pública del panel', valor: s.panelUrl || 'Sin configurar' },
  ];

  return (
    <Hoja
      title={titulo}
      className="min-w-0 lg:col-span-2"
      actions={
        <MarcaFondo veredicto={s.publishedDomains + s.autoconfig.routedHosts > 0 ? 'normal' : 'sin-dato'}>
          {plural(s.publishedDomains + s.autoconfig.routedHosts, 'nombre publicado', 'nombres publicados')}
        </MarcaFondo>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="max-w-[75ch] text-base text-tinta-2">
          Traefik consulta a Mailway cada 15 segundos qué nombres debe servir: los webmails de marca
          blanca de los clientes y los nombres de autoconfiguración cuyo DNS ya apunta aquí.
        </p>

        <div role="status" className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Marca veredicto={consultaReciente ? 'normal' : s.lastPollAt ? 'vigilar' : 'sin-dato'}>
            {consultaReciente
              ? 'Traefik consulta las rutas'
              : s.lastPollAt
                ? 'Sin consultas recientes'
                : 'Sin consultas de Traefik'}
          </Marca>
          <span className="max-w-[75ch] text-sm text-tinta-2">
            {s.lastPollAt
              ? `Última consulta: ${formatDate(s.lastPollAt)}.${
                  consultaReciente ? '' : ' Revisa la conexión antes de añadir dominios.'
                }`
              : 'Conecta Mailway con Skyway o configura tu Traefik para que publique los dominios propios de los clientes.'}{' '}
            La consulta confirma la conexión, no que cada dominio esté operativo.
          </span>
        </div>

        <div className="rounded-lg border border-regla bg-hoja-2 px-3 py-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-base font-semibold text-tinta">
              Skyway {s.skywayBridge.minVersion.replace(/\.0$/, '')} o posterior
            </span>
            {s.underSkyway ? (
              <MarcaFondo veredicto="normal">Desplegado con Skyway</MarcaFondo>
            ) : (
              <span className="rotulo">Recomendado</span>
            )}
          </div>
          <p className="mt-1 max-w-[75ch] text-sm text-tinta-2">{s.skywayBridge.note}</p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-base font-semibold text-tinta">Traefik propio o Skyway anterior</span>
            <Button variant="plano" onClick={() => setManual(!mostrarManual)} aria-expanded={mostrarManual}>
              {mostrarManual ? 'Ocultar configuración manual' : 'Mostrar configuración manual'}
            </Button>
          </div>
          {mostrarManual && (
            <>
              <p className="max-w-[75ch] text-sm text-tinta-2">
                Crea este fichero junto al <span className="valor">docker-compose.yml</span> de Skyway
                y ejecuta <span className="valor">docker compose up -d</span>. No lo instales si Skyway ya
                incluye el puente: Traefik solo admite un proveedor HTTP y el fichero lo sustituiría.
              </p>
              <Muestra rotulo="docker-compose.override.yml" copiar={s.overrideSnippet}>
                <pre className="valor whitespace-pre-wrap break-all text-sm leading-relaxed text-tinta">
                  {s.overrideSnippet}
                </pre>
              </Muestra>
              <p className="max-w-[75ch] text-sm text-tinta-3">
                Compose sustituye la lista completa de comandos: conserva todos los parámetros de tu versión
                de Skyway y añade los de providers.http. Si ya tienes un override, incorpora los cambios en él.
              </p>
            </>
          )}
        </div>

        <TokenTraefik token={s.token} desdeEntorno={s.tokenFromEnv} />

        <div>
          <div className="regla-cabecera hidden items-baseline gap-x-4 pb-1.5 sm:flex">
            <span className="rotulo min-w-0 flex-1 basis-40">Parámetro de esta instancia</span>
            <span className="rotulo shrink-0">Valor en uso</span>
          </div>
          {parametros.map((p) => (
            <div
              key={p.rotulo}
              className={`regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 last:border-b-0 ${
                p.vigilar ? 'fila-vigilar -mx-2 px-2' : ''
              }`}
            >
              <span className="min-w-0 basis-full text-base text-tinta sm:basis-40 sm:flex-1">{p.rotulo}</span>
              <span className="valor min-w-0 break-all text-sm text-tinta-2 sm:text-right">{p.valor}</span>
              {p.aviso && <p className="w-full text-sm text-tinta-2">{p.aviso}</p>}
            </div>
          ))}
        </div>

        <p className="max-w-[75ch] text-sm text-tinta-3">
          El token autentica a Traefik ante Mailway: sin él, cualquiera podría leer la lista de
          nombres publicados. Si cambia el contenedor del panel, actualiza también la URL del sondeo.
        </p>
      </div>
    </Hoja>
  );
}

/**
 * Token con el que Traefik se identifica ante Mailway. Es un secreto: se
 * muestra enmascarado y solo se revela a petición (la pantalla de ajustes se
 * comparte o se proyecta), y se copia sin necesidad de revelarlo.
 */
function TokenTraefik({ token, desdeEntorno }: { token: string; desdeEntorno?: boolean }) {
  const [visible, setVisible] = useState(false);
  const enmascarado = token ? `••••••••${token.slice(-3)}` : '—';
  return (
    <Muestra rotulo="Token (X-Mailway-Token)" copiar={token}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <code className="valor min-w-0 flex-1 break-all text-sm text-tinta">{visible ? token : enmascarado}</code>
        <Button
          variant="plano"
          className="!h-6 px-1.5 text-sm"
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? 'Ocultar' : 'Mostrar'}
        </Button>
      </div>
      {desdeEntorno && <p className="mt-1 text-sm text-tinta-3">Fijado por la variable MAILWAY_TRAEFIK_TOKEN.</p>}
    </Muestra>
  );
}
