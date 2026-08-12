import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type SetupStatus, type User } from '../lib/api';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import { Hoja, Marca, Membrete } from '../ui/kit';
import { useToast } from '../ui/toast';

/**
 * Primera puesta en marcha: el encabezamiento del parte, que se rellena por
 * apartados. Aquí el orden importa —cada apartado bloquea el siguiente—, así
 * que los apartados van numerados.
 * 1. Cuenta de administrador  2. Motor de correo  3. Identidad del servidor
 * 4. Resumen y arranque.
 */
export default function Setup({ status, user }: { status: SetupStatus; user: User | null }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const initialStep = !status.hasAdmin || !user ? 0 : !status.engineConfigured ? 1 : 2;
  const [step, setStep] = useState(initialStep);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Paso 1: administrador
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');

  // Paso 2: motor
  const [engineKind, setEngineKind] = useState<'stalwart' | 'demo'>(
    status.demoMode ? 'demo' : 'stalwart',
  );
  const [engineUrl, setEngineUrl] = useState(status.engineDefaults.url || 'http://mailway-mail:8080');
  const [engineUser, setEngineUser] = useState(status.engineDefaults.adminUser || 'admin');
  const [enginePassword, setEnginePassword] = useState('');
  const [smtpHost, setSmtpHost] = useState(status.engineDefaults.smtpHost || 'mailway-mail');
  const [smtpPort, setSmtpPort] = useState(String(status.engineDefaults.smtpPort || 587));

  // Paso 3: identidad
  const [brandName, setBrandName] = useState(status.instance.brandName);
  const [mailHostname, setMailHostname] = useState(status.instance.mailHostname);
  const [publicIp, setPublicIp] = useState(status.instance.publicIp);
  const [webmailUrl, setWebmailUrl] = useState(status.instance.webmailUrl);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Algo falló. Reintenta.');
    } finally {
      setBusy(false);
    }
  }

  function submitAdmin(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api.post('/api/setup/admin', {
        name: adminName,
        email: adminEmail,
        password: adminPassword,
      });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      setStep(1);
    });
  }

  function submitEngine(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api.post('/api/setup/engine', {
        kind: engineKind,
        url: engineKind === 'stalwart' ? engineUrl : '',
        adminUser: engineUser,
        adminPassword: enginePassword,
        smtpHost: engineKind === 'stalwart' ? smtpHost : '',
        smtpPort: Number(smtpPort) || 587,
        smtpSecure: Number(smtpPort) === 465,
      });
      toast('ok', engineKind === 'demo' ? 'Modo demostración activado.' : 'Motor conectado.');
      setStep(2);
    });
  }

  function submitInstance(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api.post('/api/setup/instance', { brandName, mailHostname, publicIp, webmailUrl });
      setStep(3);
    });
  }

  function finish() {
    void run(async () => {
      await api.post('/api/setup/complete');
      await queryClient.invalidateQueries();
    });
  }

  async function detectIp() {
    const { ip } = await api.get<{ ip: string }>('/api/setup/detect-ip');
    if (ip) {
      setPublicIp(ip);
      toast('ok', `IP detectada: ${ip}`);
    } else {
      toast('error', 'No se pudo detectar la IP automáticamente; escríbela a mano.');
    }
  }

  const apartados = [
    { rotulo: 'Administrador', titulo: 'Tu cuenta de administrador' },
    { rotulo: 'Motor de correo', titulo: 'Conectar el motor de correo' },
    { rotulo: 'Servidor', titulo: 'Identidad del servidor' },
    { rotulo: 'Arranque', titulo: 'Todo listo para arrancar' },
  ];

  return (
    <div className="min-h-screen bg-mesa px-4 py-8 sm:py-10">
      <div className="mx-auto w-full max-w-2xl">
        <Membrete
          title={
            <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <svg viewBox="0 0 22 16" className="h-4 w-[22px] shrink-0 text-laboratorio" aria-hidden>
                <path d="M1 13h20" stroke="currentColor" strokeWidth="1.6" />
                <path d="M4 13V7M9 13V3M14 13V9M19 13V5" stroke="currentColor" strokeWidth="1.6" />
              </svg>
              Mailway
            </span>
          }
          meta="Primera puesta en marcha. Cada apartado se cierra antes de abrir el siguiente."
        />

        <div className="flex flex-col gap-4">
          <Hoja title="Apartados" meta={`${step + 1} de ${apartados.length}`} flush>
            <div className="regla-cabecera flex items-baseline gap-x-3 px-4 pb-1.5 pt-2.5">
              <span className="rotulo w-5 shrink-0 text-right">N.º</span>
              <span className="rotulo min-w-0 flex-1">Apartado</span>
              <span className="rotulo shrink-0">Estado</span>
            </div>
            <ol>
              {apartados.map((apartado, i) => {
                const hecho = i < step;
                const actual = i === step;
                return (
                  <li
                    key={apartado.rotulo}
                    aria-current={actual ? 'step' : undefined}
                    className={`regla-fila flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2
                      last:border-b-0 ${actual ? 'bg-laboratorio-claro' : ''}`}
                  >
                    <span
                      className={`valor w-5 shrink-0 text-right text-sm ${
                        actual ? 'text-laboratorio' : 'text-tinta-3'
                      }`}
                    >
                      {i + 1}
                    </span>
                    <span
                      className={`min-w-0 flex-1 basis-32 text-base ${
                        actual
                          ? 'font-semibold text-laboratorio'
                          : hecho
                            ? 'text-tinta'
                            : 'text-tinta-3'
                      }`}
                    >
                      {apartado.rotulo}
                    </span>
                    <span className="shrink-0">
                      {hecho ? (
                        <Marca veredicto="normal">Cerrado</Marca>
                      ) : actual ? (
                        <span className="rotulo text-laboratorio">En curso</span>
                      ) : (
                        <span className="rotulo">Pendiente</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          </Hoja>

          <Hoja title={apartados[step].titulo}>
            {step === 0 && (
              <form onSubmit={submitAdmin} className="flex flex-col gap-4">
                <p className="text-base text-tinta-2">
                  Con ella controlas toda la instancia: clientes, dominios y ajustes.
                </p>
                <Input
                  label="Tu nombre"
                  required
                  minLength={2}
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                  placeholder="Nombre y apellido"
                />
                <Input
                  label="Correo"
                  type="email"
                  required
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="tu@correo.com"
                />
                <Input
                  label="Contraseña"
                  type="password"
                  required
                  minLength={10}
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  help="Mínimo 10 caracteres. Guárdala en tu gestor de contraseñas."
                />
                {error && <AvisoError text={error} />}
                <Button type="submit" variant="tinta" busy={busy} className="self-start">
                  Crear y continuar
                </Button>
              </form>
            )}

            {step === 1 && (
              <form onSubmit={submitEngine} className="flex flex-col gap-4">
                <p className="text-base text-tinta-2">
                  El motor (Stalwart) es quien mueve el correo de verdad. Si aún no lo has
                  desplegado, elige el modo demostración y conéctalo más tarde desde Ajustes.
                </p>
                <Select
                  label="Motor"
                  value={engineKind}
                  onChange={(e) => setEngineKind(e.target.value as 'stalwart' | 'demo')}
                >
                  <option value="stalwart">Stalwart (recomendado, producción)</option>
                  <option value="demo">Modo demostración (sin servidor de correo)</option>
                </Select>
                {engineKind === 'stalwart' && (
                  <>
                    <Input
                      label="URL de la API de gestión"
                      required
                      mono
                      value={engineUrl}
                      onChange={(e) => setEngineUrl(e.target.value)}
                      placeholder="http://mailway-mail:8080"
                      help="Con el docker-compose de Mailway: http://mailway-mail:8080"
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
                        value={enginePassword}
                        onChange={(e) => setEnginePassword(e.target.value)}
                        help="La de STALWART_ADMIN_PASSWORD del .env"
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Input
                        label="Host SMTP (envíos API)"
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
                {error && <AvisoError text={error} />}
                <Button type="submit" variant="tinta" busy={busy} className="self-start">
                  {engineKind === 'stalwart' ? 'Probar conexión y continuar' : 'Continuar en demostración'}
                </Button>
              </form>
            )}

            {step === 2 && (
              <form onSubmit={submitInstance} className="flex flex-col gap-4">
                <p className="text-base text-tinta-2">
                  Estos datos alimentan las recomendaciones de DNS y entregabilidad. Puedes
                  cambiarlos después en Ajustes.
                </p>
                <Input
                  label="Nombre de tu servicio"
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value)}
                  help="Aparece en el panel que ven tus clientes (marca blanca)."
                />
                <Input
                  label="Nombre del servidor de correo (FQDN)"
                  mono
                  value={mailHostname}
                  onChange={(e) => setMailHostname(e.target.value)}
                  placeholder="mail.tuempresa.com"
                  help="Debe apuntar (registro A) a la IP del servidor y coincidir con el PTR."
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
                  <Button type="button" variant="perfil" onClick={() => void detectIp()}>
                    Detectar
                  </Button>
                </div>
                <Input
                  label="URL del webmail (opcional)"
                  mono
                  value={webmailUrl}
                  onChange={(e) => setWebmailUrl(e.target.value)}
                  placeholder="https://webmail.tuempresa.com"
                  help="Si desplegaste Roundcube, el enlace que verán tus clientes."
                />
                {error && <AvisoError text={error} />}
                <Button type="submit" variant="tinta" busy={busy} className="self-start">
                  Guardar y continuar
                </Button>
              </form>
            )}

            {step === 3 && (
              <div className="flex flex-col gap-4">
                <p className="text-base text-tinta-2">
                  Con esto la instancia queda operativa. Tus primeros pasos serán:
                </p>
                <ol>
                  {[
                    'Crear tu primer cliente y su usuario de acceso',
                    'Añadir su dominio y configurar el DNS con el asistente',
                    'Crear buzones y, si automatizas envíos, una clave de API',
                    'Revisar el centro de entregabilidad (PTR, listas negras)',
                  ].map((item, i) => (
                    <li
                      key={item}
                      className="regla-fila flex items-baseline gap-x-3 py-2 last:border-b-0"
                    >
                      <span className="valor w-5 shrink-0 text-right text-sm text-tinta-3">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 text-base text-tinta-2">{item}</span>
                    </li>
                  ))}
                </ol>
                {error && <AvisoError text={error} />}
                <Button variant="tinta" busy={busy} onClick={finish} className="self-start">
                  Entrar al panel
                </Button>
              </div>
            )}
          </Hoja>
        </div>
      </div>
    </div>
  );
}

/** Error del apartado: se nombra el problema sin filete lateral de color. */
function AvisoError({ text }: { text: string }) {
  return (
    <p
      role="alert"
      className="border border-[rgb(var(--fuera)/0.35)] bg-fuera-fondo px-3 py-2 text-sm text-fuera"
    >
      {text}
    </p>
  );
}
