import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type SetupStatus, type User } from '../lib/api';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import { useToast } from '../ui/toast';

/**
 * Asistente de primera puesta en marcha, en 4 paradas de la cinta:
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

  const stops = ['Administrador', 'Motor de correo', 'Servidor', 'Arranque'];

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center gap-2.5">
        <span aria-hidden className="text-accion">
          <svg viewBox="0 0 22 14" className="h-4 w-[26px]">
            <path d="M1 1l6 6-6 6M9 1l6 6-6 6" stroke="currentColor" strokeWidth="2.4" fill="none" />
          </svg>
        </span>
        <span className="font-rotulo text-xl font-semibold uppercase tracking-[0.2em]">Mailway</span>
        <span className="ml-2 text-sm text-tinta-3">Primera puesta en marcha</span>
      </div>

      {/* Paradas de la cinta */}
      <ol className="mb-6 flex items-center gap-1 overflow-x-auto">
        {stops.map((stop, i) => (
          <li key={stop} className="flex items-center gap-1">
            {i > 0 && (
              <svg aria-hidden viewBox="0 0 8 10" className="h-2.5 w-2 text-tinta-3">
                <path d="M1 1l5 4-5 4" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
            )}
            <span
              className={`whitespace-nowrap rounded-sm px-2 py-1 font-rotulo text-sm font-semibold uppercase tracking-[0.1em] ${
                i === step
                  ? 'bg-accion text-accion-tinta'
                  : i < step
                    ? 'text-entregado'
                    : 'text-tinta-3'
              }`}
            >
              {i < step ? '✓ ' : ''}
              {stop}
            </span>
          </li>
        ))}
      </ol>

      <div className="rounded-md border border-suave bg-chasis p-6">
        {step === 0 && (
          <form onSubmit={submitAdmin} className="flex flex-col gap-4">
            <div>
              <h1 className="font-rotulo text-xl font-semibold tracking-wide">Tu cuenta de administrador</h1>
              <p className="mt-1 text-sm text-tinta-2">
                Con ella controlas toda la instancia: clientes, dominios y ajustes.
              </p>
            </div>
            <Input label="Tu nombre" required minLength={2} value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Nombre y apellido" />
            <Input label="Correo" type="email" required value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="tu@correo.com" />
            <Input
              label="Contraseña"
              type="password"
              required
              minLength={10}
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              help="Mínimo 10 caracteres. Guárdala en tu gestor de contraseñas."
            />
            {error && <ErrorBox text={error} />}
            <Button type="submit" variant="accion" busy={busy}>Crear y continuar</Button>
          </form>
        )}

        {step === 1 && (
          <form onSubmit={submitEngine} className="flex flex-col gap-4">
            <div>
              <h1 className="font-rotulo text-xl font-semibold tracking-wide">Conectar el motor de correo</h1>
              <p className="mt-1 text-sm text-tinta-2">
                El motor (Stalwart) es quien mueve el correo de verdad. Si aún no lo has
                desplegado, elige el modo demostración y conéctalo más tarde desde Ajustes.
              </p>
            </div>
            <Select label="Motor" value={engineKind} onChange={(e) => setEngineKind(e.target.value as 'stalwart' | 'demo')}>
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
                <div className="grid grid-cols-2 gap-3">
                  <Input label="Usuario administrador" required value={engineUser} onChange={(e) => setEngineUser(e.target.value)} />
                  <Input
                    label="Contraseña"
                    type="password"
                    required
                    value={enginePassword}
                    onChange={(e) => setEnginePassword(e.target.value)}
                    help="La de STALWART_ADMIN_PASSWORD del .env"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Input label="Host SMTP (envíos API)" required mono value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
                  <Input label="Puerto SMTP" required inputMode="numeric" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} help="587 (STARTTLS) o 465 (SSL)" />
                </div>
              </>
            )}
            {error && <ErrorBox text={error} />}
            <div className="flex gap-2">
              <Button type="submit" variant="accion" busy={busy}>
                {engineKind === 'stalwart' ? 'Probar conexión y continuar' : 'Continuar en demostración'}
              </Button>
            </div>
          </form>
        )}

        {step === 2 && (
          <form onSubmit={submitInstance} className="flex flex-col gap-4">
            <div>
              <h1 className="font-rotulo text-xl font-semibold tracking-wide">Identidad del servidor</h1>
              <p className="mt-1 text-sm text-tinta-2">
                Estos datos alimentan las recomendaciones de DNS y entregabilidad. Puedes
                cambiarlos después en Ajustes.
              </p>
            </div>
            <Input label="Nombre de tu servicio" value={brandName} onChange={(e) => setBrandName(e.target.value)} help="Aparece en el panel que ven tus clientes (marca blanca)." />
            <Input
              label="Nombre del servidor de correo (FQDN)"
              mono
              value={mailHostname}
              onChange={(e) => setMailHostname(e.target.value)}
              placeholder="mail.tuempresa.com"
              help="Debe apuntar (registro A) a la IP del servidor y coincidir con el PTR."
            />
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input label="IP pública del servidor" mono value={publicIp} onChange={(e) => setPublicIp(e.target.value)} placeholder="203.0.113.10" />
              </div>
              <Button type="button" onClick={() => void detectIp()}>Detectar</Button>
            </div>
            <Input label="URL del webmail (opcional)" mono value={webmailUrl} onChange={(e) => setWebmailUrl(e.target.value)} placeholder="https://webmail.tuempresa.com" help="Si desplegaste Roundcube, el enlace que verán tus clientes." />
            {error && <ErrorBox text={error} />}
            <Button type="submit" variant="accion" busy={busy}>Guardar y continuar</Button>
          </form>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-4">
            <div>
              <h1 className="font-rotulo text-xl font-semibold tracking-wide">Todo listo para arrancar</h1>
              <p className="mt-1 text-sm text-tinta-2">Con esto la central queda operativa. Tus primeros pasos serán:</p>
            </div>
            <ol className="flex flex-col gap-2 text-base">
              {[
                'Crear tu primer cliente y su usuario de acceso',
                'Añadir su dominio y configurar el DNS con el asistente',
                'Crear buzones y, si automatizas envíos, una clave de API',
                'Revisar el centro de entregabilidad (PTR, listas negras)',
              ].map((item, i) => (
                <li key={item} className="flex items-start gap-2.5">
                  <span className="num mt-0.5 font-guia text-sm text-accion">{i + 1}</span>
                  <span className="text-tinta-2">{item}</span>
                </li>
              ))}
            </ol>
            {error && <ErrorBox text={error} />}
            <Button variant="accion" busy={busy} onClick={finish}>Entrar al panel</Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorBox({ text }: { text: string }) {
  return (
    <p role="alert" className="rounded border border-[rgb(var(--devuelto)/0.4)] bg-[rgb(var(--devuelto)/0.08)] px-3 py-2 text-sm text-devuelto">
      {text}
    </p>
  );
}
