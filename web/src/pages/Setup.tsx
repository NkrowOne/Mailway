import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type SetupStatus, type User } from '../lib/api';
import {
  nombreMotor,
  notaEnEjecucion,
  ORDEN_VEREDICTO,
  resumenTls,
  textoDns,
  veredictoDns,
  veredictoEnEjecucion,
  veredictoTls,
  type EngineStatus,
  type PlatformDns,
  type RecommendedResult,
} from '../lib/motor';
import { BandaError, FilaEstado, type Fila } from '../components/HojaServidorCorreo';
import { BandaAviso } from '../components/gestion/comun';
import type { CuentaCloudflare } from '../lib/cloudflare';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import { AvisoEspera, Cargando, Hoja, Logotipo, Marca, Membrete, Muestra } from '../ui/kit';
import { useToast } from '../ui/toast';

/**
 * Valores por defecto del motor si el estado no los trae: con la instalación
 * ya terminada y sin sesión, el servidor solo devuelve lo imprescindible.
 */
const MOTOR_POR_DEFECTO = {
  url: '',
  adminUser: '',
  hasPassword: false,
  smtpHost: '',
  smtpPort: 587,
};

interface ResultadoRecomendados {
  applied: boolean;
  hostname: string;
  errors: string[];
  warnings: string[];
  /** Lo que el motor solo aplica al reiniciar su contenedor (Stalwart 0.16). */
  restartRequired?: string[];
  error?: string;
}

/**
 * Primera puesta en marcha: el encabezamiento del parte, que se rellena por
 * apartados. Aquí el orden importa —cada apartado bloquea el siguiente—, así
 * que los apartados van numerados.
 * 1. Cuenta de administrador  2. Motor de correo  3. Identidad del servidor
 * 4. Comprobación de la instalación.
 *
 * Lo que el instalador ya sabe no se vuelve a preguntar: el motor del
 * entorno se conecta solo, y la identidad llega prerrellenada.
 */
export default function Setup({ status, user }: { status: SetupStatus; user: User | null }) {
  const estado = status;
  const motorPorDefecto = status.engineDefaults ?? MOTOR_POR_DEFECTO;
  const queryClient = useQueryClient();
  const toast = useToast();
  // Con la identidad ya guardada, recargar en la comprobación no vuelve atrás.
  const initialStep = !status.hasAdmin || !user ? 0 : !status.engineConfigured ? 1 : status.instanceSaved ? 3 : 2;
  const [step, setStep] = useState(initialStep);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Paso 1: administrador. El instalador imprime la dirección con el token
  // (…/setup?token=…) para no tener que copiarlo a mano.
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [setupToken, setSetupToken] = useState(
    () => new URLSearchParams(window.location.search).get('token') ?? '',
  );

  // Paso 2: motor
  const motorDelEntorno = Boolean(estado.engineFromEnv) && !status.demoMode;
  // El motor ya conectado manda: tras recargar, una demostración elegida en el
  // paso anterior no debe exigir el nombre del servidor.
  const [engineKind, setEngineKind] = useState<'stalwart' | 'demo'>(
    status.demoMode || status.engineKind === 'demo' ? 'demo' : 'stalwart',
  );
  const [engineUrl, setEngineUrl] = useState(motorPorDefecto.url || 'http://mailway-mail:8080');
  const [engineUser, setEngineUser] = useState(motorPorDefecto.adminUser || 'admin');
  const [enginePassword, setEnginePassword] = useState('');
  const [smtpHost, setSmtpHost] = useState(motorPorDefecto.smtpHost || 'mailway-mail');
  const [smtpPort, setSmtpPort] = useState(String(motorPorDefecto.smtpPort || 587));
  const [formularioManual, setFormularioManual] = useState(!motorDelEntorno);

  // Paso 3: identidad, con propuestas deducidas de la dirección del panel.
  const sugerencias = sugerir(status);
  const [brandName, setBrandName] = useState(status.instance.brandName);
  const [mailHostname, setMailHostname] = useState(sugerencias.mailHostname);
  const [publicIp, setPublicIp] = useState(status.instance.publicIp ?? '');
  const [panelUrl, setPanelUrl] = useState(sugerencias.panelUrl);
  const [webmailUrl, setWebmailUrl] = useState(sugerencias.webmailUrl);
  const [detectando, setDetectando] = useState(false);
  const [errorHostname, setErrorHostname] = useState('');

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se ha podido completar la operación. Vuelve a intentarlo.');
    } finally {
      setBusy(false);
    }
  }

  function avisarRecomendados(resultado: ResultadoRecomendados | null | undefined) {
    if (!resultado) return;
    if (resultado.applied && resultado.restartRequired && resultado.restartRequired.length > 0) {
      // Guardado, pero un puerto nuevo solo se abre al reiniciar el contenedor.
      toast(
        'error',
        `Ajustes guardados en el motor. Reinícialo para aplicar: ${resultado.restartRequired.join('; ')}.`,
      );
    } else if (resultado.applied) {
      toast('ok', `Nombre del servidor ${resultado.hostname} aplicado en el motor.`);
    } else {
      toast(
        'error',
        `El motor no aceptó los ajustes recomendados: ${resultado.error || resultado.errors[0] || 'sin detalle'}. Puedes repetirlo en Ajustes → Servidor de correo.`,
      );
    }
  }

  function submitAdmin(e: FormEvent) {
    e.preventDefault();
    // Validación propia (el formulario es noValidate): el globo del navegador
    // sale en su idioma y tapa los mensajes del asistente.
    if (estado.requiresSetupToken && !setupToken.trim()) {
      setError('Indica el token de puesta en marcha que mostró el instalador.');
      return;
    }
    if (adminName.trim().length < 2) {
      setError('El nombre debe tener al menos 2 caracteres.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail.trim())) {
      setError('Indica un correo electrónico válido.');
      return;
    }
    if (adminPassword.length < 10) {
      setError('La contraseña debe tener al menos 10 caracteres.');
      return;
    }
    void run(async () => {
      await api.post('/api/setup/admin', {
        name: adminName,
        email: adminEmail,
        password: adminPassword,
        ...(estado.requiresSetupToken ? { setupToken } : {}),
      });
      // El token ya no hace falta: fuera de la barra de direcciones y del historial.
      if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      setStep(1);
    });
  }

  /* Motor del entorno: un clic, o ninguno si responde a la primera. */
  const conectarEntorno = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; recommended: ResultadoRecomendados | null }>('/api/setup/engine', {
        useEnvDefaults: true,
      }),
    onSuccess: (res) => {
      toast('ok', 'Motor del servidor conectado.');
      avisarRecomendados(res.recommended);
      setStep(2);
    },
  });
  const { mutate: conectarEntornoMutate } = conectarEntorno;
  const intentoAutomatico = useRef(false);
  useEffect(() => {
    if (step !== 1 || !motorDelEntorno || intentoAutomatico.current) return;
    intentoAutomatico.current = true;
    conectarEntornoMutate();
  }, [step, motorDelEntorno, conectarEntornoMutate]);

  function submitEngine(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      const res = await api.post<{ recommended: ResultadoRecomendados | null }>('/api/setup/engine', {
        kind: engineKind,
        url: engineKind === 'stalwart' ? engineUrl : '',
        adminUser: engineUser,
        adminPassword: enginePassword,
        smtpHost: engineKind === 'stalwart' ? smtpHost : '',
        smtpPort: Number(smtpPort) || 587,
        smtpSecure: Number(smtpPort) === 465,
      });
      toast('ok', engineKind === 'demo' ? 'Modo demostración activado.' : 'Motor conectado.');
      avisarRecomendados(res.recommended);
      setStep(2);
    });
  }

  const detectarIp = useRef<() => Promise<void>>();
  detectarIp.current = async () => {
    setDetectando(true);
    try {
      const { ip } = await api.get<{ ip: string }>('/api/setup/detect-ip');
      if (ip) {
        setPublicIp(ip);
      } else {
        toast('error', 'No se ha podido detectar la IP automáticamente. Escríbela manualmente.');
      }
    } catch {
      toast('error', 'No se ha podido detectar la IP automáticamente. Escríbela manualmente.');
    } finally {
      setDetectando(false);
    }
  };

  // Al llegar a la identidad sin IP conocida, se intenta detectar sola.
  const ipIntentada = useRef(false);
  useEffect(() => {
    if (step !== 2 || publicIp || ipIntentada.current) return;
    ipIntentada.current = true;
    void detectarIp.current?.();
  }, [step, publicIp]);

  function submitInstance(e: FormEvent) {
    e.preventDefault();
    // Sin él, los datos de conexión de los buzones salen sin servidor (el
    // formulario es noValidate: el `required` del campo no basta).
    if (engineKind === 'stalwart' && !mailHostname.trim()) {
      setErrorHostname('Indica el nombre del servidor de correo, por ejemplo mail.miempresa.com.');
      return;
    }
    setErrorHostname('');
    void run(async () => {
      const res = await api.post<{ recommended: ResultadoRecomendados | null }>('/api/setup/instance', {
        brandName,
        mailHostname: mailHostname.trim().toLowerCase(),
        publicIp,
        panelUrl: panelUrl.trim().replace(/\/+$/, ''),
        webmailUrl: webmailUrl.trim().replace(/\/+$/, ''),
      });
      avisarRecomendados(res.recommended);
      setStep(3);
    });
  }

  function finish() {
    void run(async () => {
      await api.post('/api/setup/complete');
      await queryClient.invalidateQueries();
    });
  }

  const apartados = [
    { rotulo: 'Administrador', titulo: 'Cuenta de administrador' },
    { rotulo: 'Motor de correo', titulo: 'Conectar el motor de correo' },
    { rotulo: 'Servidor', titulo: 'Identidad del servidor' },
    { rotulo: 'Comprobación', titulo: 'Comprobación de la instalación' },
  ];

  return (
    <div className="min-h-screen bg-mesa px-4 py-8 sm:py-10">
      <div className="mx-auto w-full max-w-2xl">
        <Membrete
          title={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Logotipo />
              Mailway
            </span>
          }
          meta="Primera puesta en marcha. Cada apartado se cierra antes de abrir el siguiente."
        />

        <div className="flex flex-col gap-4">
          <Hoja title="Apartados" meta={`${step + 1} de ${apartados.length}`} flush>
            <ol>
              {apartados.map((apartado, i) => {
                const hecho = i < step;
                const actual = i === step;
                return (
                  <li
                    key={apartado.rotulo}
                    aria-current={actual ? 'step' : undefined}
                    className={`regla-fila flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 sm:px-5
                      last:border-b-0 ${actual ? 'bg-hoja-2' : ''}`}
                  >
                    <span
                      className={`valor flex h-6 w-6 shrink-0 items-center justify-center self-center rounded-full text-sm font-semibold ${
                        actual ? 'bg-petroleo text-white' : hecho ? 'bg-petroleo-claro text-petroleo' : 'bg-hoja-3 text-tinta-3'
                      }`}
                    >
                      {i + 1}
                    </span>
                    <span
                      className={`min-w-0 flex-1 basis-32 text-base ${
                        actual ? 'font-semibold text-petroleo' : hecho ? 'text-tinta' : 'text-tinta-3'
                      }`}
                    >
                      {apartado.rotulo}
                    </span>
                    <span className="shrink-0">
                      {hecho ? (
                        <Marca veredicto="normal">Hecho</Marca>
                      ) : actual ? (
                        <span className="text-sm font-medium text-petroleo">En curso</span>
                      ) : (
                        <span className="text-sm text-tinta-3">Pendiente</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          </Hoja>

          <Hoja title={apartados[step]!.titulo}>
            {step === 0 && (
              <form onSubmit={submitAdmin} noValidate className="flex flex-col gap-4">
                <p className="text-base text-tinta-2">
                  Esta cuenta controla toda la instancia: clientes, dominios y ajustes. No es la cuenta
                  del motor de correo.
                </p>
                {estado.requiresSetupToken && (
                  <Input
                    label="Token de puesta en marcha"
                    required
                    mono
                    autoComplete="off"
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    help="Lo muestra el instalador al terminar; también está en la variable MAILWAY_SETUP_TOKEN del panel. Impide que otra persona se adelante a crear el administrador."
                  />
                )}
                <Input
                  label="Nombre"
                  required
                  minLength={2}
                  autoComplete="name"
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                  placeholder="Nombre y apellidos"
                />
                <Input
                  label="Correo"
                  type="email"
                  required
                  autoComplete="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="administracion@miempresa.com"
                />
                <Input
                  label="Contraseña"
                  type="password"
                  required
                  minLength={10}
                  autoComplete="new-password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  help="Mínimo 10 caracteres. Guárdala en un gestor de contraseñas."
                />
                {error && <BandaError texto={error} />}
                <Button type="submit" variant="principal" busy={busy} className="self-start">
                  Crear y continuar
                </Button>
              </form>
            )}

            {step === 1 && (
              <div className="flex flex-col gap-4">
                <p className="text-base text-tinta-2">
                  El motor (Stalwart) es el servidor que recibe, guarda y envía el correo. Mailway lo
                  gestiona por su API de administración.
                </p>

                {motorDelEntorno && (
                  <div className="flex flex-col gap-3">
                    <Muestra rotulo="Motor configurado en el servidor">
                      <p className="valor break-all text-sm text-tinta">{motorPorDefecto.url}</p>
                      <p className="mt-1 text-sm text-tinta-3">
                        Usuario {motorPorDefecto.adminUser || 'admin'}. La contraseña está en el
                        entorno del panel y no sale del servidor.
                      </p>
                    </Muestra>
                    {conectarEntorno.isPending && (
                      <Cargando label="Comprobando la conexión con el motor y aplicando los ajustes recomendados (puede tardar un minuto o más)…" />
                    )}
                    {conectarEntorno.isError && (
                      <BandaError
                        texto={
                          conectarEntorno.error instanceof ApiError
                            ? conectarEntorno.error.message
                            : 'No se ha podido conectar con el motor configurado en el servidor.'
                        }
                      />
                    )}
                    {!conectarEntorno.isPending && (
                      <div className="flex flex-wrap gap-2">
                        <Button variant="principal" onClick={() => conectarEntorno.mutate()}>
                          {conectarEntorno.isError
                            ? 'Reintentar con el motor del servidor'
                            : 'Usar el motor configurado en el servidor'}
                        </Button>
                        {!formularioManual && (
                          <Button variant="plano" onClick={() => setFormularioManual(true)}>
                            Indicar los datos manualmente
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {formularioManual && (
                  <form onSubmit={submitEngine} noValidate className="flex flex-col gap-4">
                    {motorDelEntorno && <h3 className="rotulo">Datos del motor</h3>}
                    <Select
                      label="Motor"
                      value={engineKind}
                      onChange={(e) => setEngineKind(e.target.value as 'stalwart' | 'demo')}
                    >
                      <option value="stalwart">Stalwart (recomendado, producción)</option>
                      <option value="demo">Modo demostración (sin servidor de correo)</option>
                    </Select>
                    {engineKind === 'demo' && (
                      <p className="text-sm text-tinta-3">
                        El modo demostración permite recorrer el panel sin servidor de correo. El motor
                        real se conecta más tarde en Ajustes → Motor de correo.
                      </p>
                    )}
                    {engineKind === 'stalwart' && (
                      <>
                        <Input
                          label="URL de la API de gestión"
                          required
                          mono
                          value={engineUrl}
                          onChange={(e) => setEngineUrl(e.target.value)}
                          placeholder="http://mailway-mail:8080"
                          help="Con el compose de Mailway: http://mailway-mail:8080"
                        />
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Input
                            label="Usuario administrador"
                            required
                            value={engineUser}
                            onChange={(e) => setEngineUser(e.target.value)}
                          />
                          <Input
                            label="Contraseña"
                            type="password"
                            required
                            autoComplete="off"
                            value={enginePassword}
                            onChange={(e) => setEnginePassword(e.target.value)}
                            help="La de STALWART_ADMIN_PASSWORD en deploy/.env"
                          />
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Input
                            label="Host SMTP (envíos por API)"
                            required
                            mono
                            value={smtpHost}
                            onChange={(e) => setSmtpHost(e.target.value)}
                          />
                          <Input
                            label="Puerto SMTP"
                            required
                            inputMode="numeric"
                            value={smtpPort}
                            onChange={(e) => setSmtpPort(e.target.value)}
                            help="587 (STARTTLS) o 465 (SSL)"
                          />
                        </div>
                      </>
                    )}
                    {error && <BandaError texto={error} />}
                    <Button
                      type="submit"
                      variant={motorDelEntorno ? 'perfil' : 'principal'}
                      busy={busy}
                      className="self-start"
                    >
                      {engineKind === 'stalwart' ? 'Probar la conexión y continuar' : 'Continuar en demostración'}
                    </Button>
                    <AvisoEspera activo={busy && engineKind === 'stalwart'}>
                      Comprobando la conexión y aplicando los ajustes recomendados en el motor. Puede tardar un minuto
                      o más.
                    </AvisoEspera>
                  </form>
                )}
              </div>
            )}

            {step === 2 && (
              <form onSubmit={submitInstance} noValidate className="flex flex-col gap-4">
                <p className="text-base text-tinta-2">
                  Estos datos alimentan las recomendaciones de DNS, la entregabilidad y los datos de
                  conexión de los buzones. Se pueden cambiar después en Ajustes.
                </p>
                <Input
                  label="Nombre del servicio"
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value)}
                  help="Aparece en el panel que ven los clientes y en el webmail (marca blanca)."
                />
                <Input
                  label="Nombre del servidor de correo (FQDN)"
                  mono
                  // En demostración no hay servidor real: no se exige.
                  required={engineKind === 'stalwart'}
                  value={mailHostname}
                  onChange={(e) => {
                    setErrorHostname('');
                    setMailHostname(e.target.value);
                  }}
                  error={errorHostname || undefined}
                  placeholder="mail.miempresa.com"
                  help="Debe apuntar (registro A) a la IP del servidor y coincidir con el PTR de esa IP. Se aplica en el motor al guardar."
                />
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[12rem] flex-1">
                    <Input
                      label="IP pública del servidor"
                      mono
                      value={publicIp}
                      onChange={(e) => setPublicIp(e.target.value)}
                      placeholder="203.0.113.10"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="perfil"
                    busy={detectando}
                    onClick={() => void detectarIp.current?.()}
                  >
                    Detectar
                  </Button>
                </div>
                <Input
                  label="URL del panel"
                  mono
                  value={panelUrl}
                  onChange={(e) => setPanelUrl(e.target.value)}
                  placeholder="https://panel.miempresa.com"
                  help="Dirección pública de este panel: se usa en los enlaces de configuración de dispositivos."
                />
                <Input
                  label="URL del webmail"
                  mono
                  value={webmailUrl}
                  onChange={(e) => setWebmailUrl(e.target.value)}
                  placeholder="https://webmail.miempresa.com"
                  help="El enlace al webmail que verán los clientes. Vacío si no hay webmail."
                />
                {error && <BandaError texto={error} />}
                <Button type="submit" variant="principal" busy={busy} className="self-start">
                  Guardar y continuar
                </Button>
                <AvisoEspera activo={busy}>
                  Guardando y aplicando el nombre del servidor en el motor. Puede tardar un minuto o más.
                </AvisoEspera>
              </form>
            )}

            {step === 3 && (
              <Comprobacion error={error} busy={busy} onFinish={finish} onVolver={() => setStep(2)} />
            )}
          </Hoja>
        </div>
      </div>
    </div>
  );
}

/**
 * Propuestas para la identidad: lo guardado o lo que trae el entorno manda;
 * si falta, se deduce del nombre por el que se ha abierto el panel
 * (panel.miempresa.com → mail.miempresa.com y webmail.miempresa.com).
 */
function sugerir(status: SetupStatus): { mailHostname: string; panelUrl: string; webmailUrl: string } {
  const origen = typeof window !== 'undefined' ? window.location.origin : '';
  const panelUrl = status.instance.panelUrl || (origen.startsWith('https://') ? origen : '');
  let base = '';
  try {
    const host = new URL(panelUrl || origen).hostname;
    if (host.startsWith('panel.')) base = host.slice('panel.'.length);
  } catch {
    base = '';
  }
  const guardado = status.instance.mailHostname ?? '';
  if (!base && guardado.startsWith('mail.')) {
    base = guardado.slice('mail.'.length);
  }
  return {
    panelUrl,
    mailHostname: guardado || (base ? `mail.${base}` : ''),
    webmailUrl: status.instance.webmailUrl || (base ? `https://webmail.${base}` : ''),
  };
}

/* --------------------------- Comprobación final --------------------------- */

const PASO_CLOUDFLARE = 'Conexiones → Cloudflare: conecta una cuenta para publicar el DNS de los dominios con un clic.';

/**
 * Con una cuenta de la instancia ya conectada (la que deja el instalador con
 * su token), no se pide conectar otra: pegar el mismo token daría «ya está
 * conectado». Se indica que se compruebe la que hay.
 */
function pasoCloudflare(cuentas: CuentaCloudflare[] | undefined): string {
  const deInstancia = (cuentas ?? []).filter((c) => c.clientId === null);
  if (deInstancia.length === 0) return PASO_CLOUDFLARE;
  return `Conexiones → Cloudflare: comprueba la cuenta de la instancia (${deInstancia
    .map((c) => `«${c.label}»`)
    .join(', ')}). Los dominios que des de alta configurarán su DNS en Cloudflare automáticamente.`;
}

const PASOS_SIGUIENTES = [
  'Ajustes → Servidor de correo: emite el certificado de Let’s Encrypt si aún es autofirmado.',
  'Clientes → Nuevo cliente: crea el primer cliente, su dominio y sus buzones.',
  'Entregabilidad: revisa el PTR y las listas negras antes de enviar en volumen.',
];

const ROLES: Record<string, string> = {
  mail: 'Servidor de correo',
  panel: 'Panel',
  webmail: 'Webmail',
};

function Comprobacion({
  error,
  busy,
  onFinish,
  onVolver,
}: {
  error: string;
  busy: boolean;
  onFinish: () => void;
  /** Vuelve a la identidad del servidor para corregirla. */
  onVolver: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const motor = useQuery({
    queryKey: ['engine-status'],
    queryFn: () => api.get<EngineStatus>('/api/engine/status'),
  });
  const dns = useQuery({
    queryKey: ['setup-platform-dns'],
    queryFn: () => api.get<PlatformDns>('/api/setup/platform-dns'),
  });
  // Mientras se consulta (o si falla), el paso genérico: no bloquea nada.
  const cuentasInstancia = useQuery({
    queryKey: ['cloudflare-accounts', 'instancia'],
    queryFn: () => api.get<{ accounts: CuentaCloudflare[] }>('/api/cloudflare/accounts?clientId=instancia'),
  });
  const pasos = [pasoCloudflare(cuentasInstancia.data?.accounts), ...PASOS_SIGUIENTES];
  const aplicar = useMutation({
    mutationFn: () => api.post<RecommendedResult>('/api/engine/recommended'),
    onSuccess: (res) => {
      if (res.errors.length > 0) toast('error', `El motor rechazó parte de los ajustes: ${res.errors[0]}`);
      else if (res.restartRequired && res.restartRequired.length > 0) {
        toast('error', `Ajustes guardados. Reinicia el motor para aplicar: ${res.restartRequired.join('; ')}.`);
      } else if (res.running && res.running !== res.hostname) {
        toast('error', `Ajustes aplicados, pero el motor sigue anunciándose como ${res.running}. Revisa su configuración local.`);
      } else toast('ok', `Nombre del servidor ${res.hostname} aplicado en el motor.`);
      void queryClient.invalidateQueries({ queryKey: ['engine-status'] });
    },
    onError: (err) => toast('error', err instanceof ApiError ? err.message : 'No se han podido aplicar los ajustes.'),
  });

  const filas: Fila[] = [];
  if (motor.data) {
    const m = motor.data;
    filas.push({
      concepto: 'Motor de correo',
      valor:
        m.engine.kind === 'stalwart'
          ? m.api
            ? nombreMotor(m.api)
            : 'Stalwart'
          : m.engine.kind === 'demo'
            ? 'Demostración'
            : 'Sin conectar',
      veredicto: m.engine.error ? 'fuera' : m.engine.kind === 'stalwart' ? 'normal' : 'vigilar',
      nota: m.engine.error ?? (m.engine.kind === 'demo' ? 'Sin servidor de correo real: no se entrega ni se envía correo.' : undefined),
    });
    if (m.engine.kind === 'stalwart') {
      filas.push({
        concepto: 'Nombre del servidor en el motor',
        valor: m.hostname.configured ?? 'Sin fijar',
        veredicto: m.recommendedApplied ? 'normal' : 'vigilar',
        nota: m.recommendedApplied
          ? undefined
          : 'Faltan el nombre del servidor o los ajustes recomendados del motor (proxy y exención del webmail).',
      });
      // Solo si no coincide: es informativo y no impide terminar la puesta en marcha.
      if (m.hostname.runningOk === false) {
        filas.push({
          concepto: 'Nombre en ejecución',
          valor: m.hostname.running ?? 'Sin dato',
          veredicto: veredictoEnEjecucion(m),
          nota: notaEnEjecucion(m),
        });
      }
      filas.push({
        concepto: `Certificado TLS (IMAP ${m.tls.port})`,
        valor: resumenTls(m.tls),
        veredicto: veredictoTls(m.tls),
        nota: m.tls.error
          ? m.tls.error
          : m.tls.ok
            ? undefined
            : m.acmeSupported
              ? 'Emítelo desde Ajustes → Servidor de correo; hasta entonces los programas de correo muestran un aviso de seguridad.'
              : 'Con Stalwart 0.16 lo copia al motor el extractor de Traefik; hasta entonces los programas de correo muestran un aviso de seguridad.',
      });
    }
  }
  if (dns.data) {
    for (const r of dns.data.records) {
      filas.push({
        concepto: `DNS · ${ROLES[r.role] ?? r.role}`,
        valor: r.host,
        veredicto: veredictoDns(r.status),
        nota:
          r.status === 'ok'
            ? undefined
            : r.status === 'unknown'
              ? 'No se ha podido consultar el DNS desde el servidor.'
              : r.status === 'missing'
                ? `${textoDns[r.status]}: crea un registro A hacia ${r.expected ?? 'la IP del servidor'}.`
                : `${textoDns[r.status]}: apunta a ${(r.found ?? []).join(', ')} en lugar de ${r.expected}.`,
      });
    }
    if (dns.data.ptr) {
      const p = dns.data.ptr;
      filas.push({
        concepto: 'DNS inverso (PTR)',
        valor: p.ip,
        veredicto: veredictoDns(p.status),
        nota:
          p.status === 'ok'
            ? undefined
            : `Debe devolver ${p.expected}. Se configura en el panel del proveedor del servidor, no en el DNS del dominio.`,
      });
    }
  }
  filas.sort((a, b) => ORDEN_VEREDICTO[a.veredicto] - ORDEN_VEREDICTO[b.veredicto]);

  const cargando = motor.isPending || dns.isPending;
  const fallo = motor.isError || dns.isError;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-base text-tinta-2">
        Medición de la instalación tal y como la verán los clientes. Lo pendiente se puede resolver
        después desde el panel.
      </p>

      {cargando ? (
        <Cargando label="Cargando la instalación…" />
      ) : (
        <div className="-mx-4 border-y border-regla">
          <div className="regla-cabecera hidden items-baseline gap-x-4 px-4 pb-1.5 pt-2.5 sm:flex">
            <span className="rotulo min-w-0 flex-1">Concepto</span>
            <span className="rotulo shrink-0">Veredicto</span>
          </div>
          {filas.map((fila) => (
            <FilaEstado key={fila.concepto} {...fila} />
          ))}
        </div>
      )}

      {fallo && (
        <BandaError texto="Parte de la comprobación no se ha podido completar. Puedes repetirla o continuar y revisarla en Ajustes." />
      )}

      {motor.data && motor.data.restartRequired.length > 0 && (
        <BandaAviso>
          <strong className="font-semibold">El motor necesita reiniciarse</strong> para aplicar lo que tiene guardado:{' '}
          {motor.data.restartRequired.join('; ')}. Reinicia su contenedor (por ejemplo, «docker restart mailway-mail») y
          pulsa «Comprobar de nuevo».
        </BandaAviso>
      )}

      {!cargando && (
        <div className="flex flex-wrap gap-2">
          {motor.data?.engine.kind === 'stalwart' &&
            (!motor.data.recommendedApplied || motor.data.hostname.runningOk === false) && (
              <Button variant="perfil" busy={aplicar.isPending} onClick={() => aplicar.mutate()}>
                Aplicar ajustes recomendados
              </Button>
            )}
          <Button
            variant="plano"
            busy={motor.isFetching || dns.isFetching}
            onClick={() => {
              void motor.refetch();
              void dns.refetch();
            }}
          >
            Comprobar de nuevo
          </Button>
        </div>
      )}
      <AvisoEspera activo={aplicar.isPending}>
        Aplicando los ajustes en el motor y recargándolo. Puede tardar un minuto o más.
      </AvisoEspera>

      <div>
        <h3 className="rotulo mb-1">Próximos pasos</h3>
        <ol>
          {pasos.map((item, i) => (
            <li key={item} className="regla-fila flex items-baseline gap-x-3 py-2 last:border-b-0">
              <span className="valor w-5 shrink-0 text-right text-sm text-tinta-3">{i + 1}</span>
              <span className="min-w-0 flex-1 text-base text-tinta-2">{item}</span>
            </li>
          ))}
        </ol>
      </div>

      {error && <BandaError texto={error} />}
      <div className="flex flex-wrap gap-2">
        <Button variant="principal" busy={busy} onClick={onFinish}>
          Entrar al panel
        </Button>
        <Button variant="plano" disabled={busy} onClick={onVolver}>
          Revisar la identidad del servidor
        </Button>
      </div>
    </div>
  );
}
