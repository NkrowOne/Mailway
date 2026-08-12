import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type InstanceSettings, type WhitelabelSetup } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Input, Select } from '../../ui/Field';
import { Hoja, MarcaFondo, Membrete, Midiendo, Muestra } from '../../ui/kit';
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

export default function Ajustes() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<SettingsResponse>('/api/settings'),
  });

  if (settings.isPending) return <Midiendo label="Leyendo los ajustes…" />;
  if (settings.isError || !settings.data) {
    return (
      <>
        <Membrete title="Ajustes" meta="Identidad del servidor y conexión con el motor de correo." />
        <Hoja title="Ajustes">
          <FalloLectura texto="No se pudieron cargar los ajustes. Comprueba que el servidor de Mailway sigue en marcha y vuelve a intentarlo." />
          <Button variant="perfil" className="mt-3" onClick={() => void settings.refetch()}>
            Reintentar
          </Button>
        </Hoja>
      </>
    );
  }

  return (
    <>
      <Membrete title="Ajustes" meta="Identidad del servidor y conexión con el motor de correo." />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <HojaIdentidad
          initial={settings.data.instance}
          onSaved={() => void queryClient.invalidateQueries()}
        />
        <HojaMotor data={settings.data} onSaved={() => void queryClient.invalidateQueries()} toast={toast} />
        <HojaMarcaBlanca />
      </div>
    </>
  );
}

/** Fallo de lectura: nombra el problema y el arreglo, sin filete lateral. */
function FalloLectura({ texto }: { texto: string }) {
  return (
    <p
      role="alert"
      className="border border-[rgb(var(--fuera)/0.35)] bg-fuera-fondo px-3 py-2 text-sm text-fuera"
    >
      {texto}
    </p>
  );
}

/**
 * Marca blanca: para que los dominios propios de los clientes funcionen, el
 * proxy (Traefik) tiene que sondear este panel. Esto se configura UNA vez y
 * aquí se da el bloque exacto, con su token y sus destinos ya resueltos.
 */
function HojaMarcaBlanca() {
  const setup = useQuery({
    queryKey: ['whitelabel-setup'],
    queryFn: () => api.get<WhitelabelSetup>('/api/whitelabel/setup'),
  });

  if (setup.isPending) {
    return (
      <Hoja title="Marca blanca" className="min-w-0 lg:col-span-2">
        <Midiendo label="Leyendo la configuración…" />
      </Hoja>
    );
  }
  if (setup.isError || !setup.data) {
    return (
      <Hoja title="Marca blanca" className="min-w-0 lg:col-span-2">
        <FalloLectura texto="No se pudo cargar la configuración. Recarga la página; si sigue fallando, revisa el registro del servidor." />
      </Hoja>
    );
  }

  const { token, publishedDomains, certResolver, webmailBackend, panelBackend, panelDomainsAvailable } =
    setup.data;

  // El bloque se escribe con los valores REALES de esta instancia: si el
  // certresolver o el contenedor del panel no son los de serie, copiar los
  // literales de la documentación produciría un Traefik roto.
  const resolutor = certResolver || 'le';
  const panelUrl = (panelBackend || 'http://mailway-panel:4100').replace(/\/+$/, '');
  const override = `# docker-compose.override.yml — en la carpeta de Skyway.
# Compose lo lee solo; no toca el repositorio de Skyway ni se pierde al actualizar.
services:
  traefik:
    command:
      # --- los flags que Skyway ya usaba (deben mantenerse) ---
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.docker.network=skyway-edge
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.${resolutor}.acme.email=\${LETSENCRYPT_EMAIL:-noreply@example.com}
      - --certificatesresolvers.${resolutor}.acme.storage=/letsencrypt/acme.json
      - --certificatesresolvers.${resolutor}.acme.httpchallenge=true
      - --certificatesresolvers.${resolutor}.acme.httpchallenge.entrypoint=web
      # --- añadido por Mailway: sondea el panel para los dominios de clientes ---
      - --providers.http.endpoint=${panelUrl}/api/traefik/config
      - --providers.http.pollInterval=15s
      - --providers.http.headers.X-Mailway-Token=${token}`;

  const parametros = [
    { rotulo: 'Certresolver', valor: resolutor, aviso: false },
    { rotulo: 'Destino del webmail', valor: webmailBackend, aviso: false },
    { rotulo: 'Destino del panel', valor: panelUrl, aviso: !panelDomainsAvailable },
  ];

  return (
    <Hoja
      title="Marca blanca"
      actions={
        publishedDomains > 0 ? (
          <MarcaFondo veredicto="normal">{publishedDomains} publicado(s)</MarcaFondo>
        ) : (
          <MarcaFondo veredicto="sin-dato">Sin dominios</MarcaFondo>
        )
      }
      className="min-w-0 lg:col-span-2"
    >
      <p className="text-base text-tinta-2">
        Para que tus clientes puedan usar su propio dominio de webmail, Traefik tiene que
        preguntarle a Mailway qué dominios servir. Se configura <strong>una sola vez</strong>: crea
        este fichero junto al <span className="valor">docker-compose.yml</span> de Skyway y ejecuta{' '}
        <span className="valor">docker compose up -d</span>.
      </p>

      <Muestra rotulo="docker-compose.override.yml" copiar={override} className="mt-3">
        <pre className="valor overflow-x-auto whitespace-pre text-sm leading-relaxed text-tinta">
          {override}
        </pre>
      </Muestra>

      {/* Los valores que van dentro del bloque, para poder comprobarlos de un vistazo. */}
      <div className="mt-4">
        <div className="regla-cabecera flex flex-wrap items-baseline gap-x-4 gap-y-1 pb-1.5">
          <span className="rotulo min-w-0 flex-1 basis-40">Parámetro de esta instancia</span>
          <span className="rotulo shrink-0">Valor en uso</span>
        </div>
        {parametros.map((p) => (
          <div
            key={p.rotulo}
            className="regla-fila flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 last:border-b-0"
          >
            <span className="min-w-0 flex-1 basis-40 text-base text-tinta">{p.rotulo}</span>
            <span className="valor min-w-0 break-all text-sm text-tinta-2 sm:text-right">
              {p.valor}
            </span>
            {p.aviso && (
              <p className="w-full text-sm text-tinta-2">
                Sin MAILWAY_PANEL_BACKEND_URL configurada, Mailway no publica dominios de tipo
                «panel» (los de webmail sí) y el bloque usa el nombre de contenedor por omisión.
              </p>
            )}
          </div>
        ))}
      </div>

      <p className="mt-3 text-sm text-tinta-3">
        El token autentica a Traefik contra Mailway: sin él, cualquiera podría leer la lista de
        dominios. Si cambias el nombre del contenedor del panel en Skyway, ajusta también la URL del
        sondeo.
      </p>
    </Hoja>
  );
}

function HojaIdentidad({ initial, onSaved }: { initial: InstanceSettings; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial), [initial]);

  const save = useMutation({
    mutationFn: () => api.put('/api/settings/instance', form),
    onSuccess: () => {
      toast('ok', 'Ajustes guardados.');
      onSaved();
    },
    onError: (err) => toast('error', err instanceof ApiError ? err.message : 'No se pudo guardar.'),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <Hoja title="Identidad del servidor" className="min-w-0">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          label="Nombre del servicio (marca blanca)"
          value={form.brandName}
          onChange={(e) => setForm({ ...form, brandName: e.target.value })}
        />
        <Input
          label="Servidor de correo (FQDN)"
          mono
          value={form.mailHostname}
          onChange={(e) => setForm({ ...form, mailHostname: e.target.value })}
          placeholder="mail.tuempresa.com"
          help="Se usa en los datos de conexión de los buzones y en los checks de entregabilidad."
        />
        <Input
          label="IP pública"
          mono
          value={form.publicIp}
          onChange={(e) => setForm({ ...form, publicIp: e.target.value })}
          placeholder="203.0.113.10"
        />
        <Input
          label="URL del webmail"
          mono
          value={form.webmailUrl}
          onChange={(e) => setForm({ ...form, webmailUrl: e.target.value })}
          placeholder="https://webmail.tuempresa.com"
          help="Si está vacío, el panel no mostrará enlaces de webmail."
        />
        {/* Única acción principal de la vista. */}
        <Button type="submit" variant="tinta" busy={save.isPending} className="self-start">
          Guardar
        </Button>
      </form>
    </Hoja>
  );
}

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
  const [testResult, setTestResult] = useState<null | { ok: boolean; detail?: string }>(null);

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
    mutationFn: () => api.post<{ ok: boolean; detail?: string }>('/api/settings/engine/test', payload()),
    onSuccess: (result) => setTestResult(result),
    onError: (err) =>
      setTestResult({ ok: false, detail: err instanceof ApiError ? err.message : 'Fallo de red' }),
  });

  const save = useMutation({
    mutationFn: () => api.put('/api/settings/engine', payload()),
    onSuccess: () => {
      toast('ok', 'Motor guardado y verificado.');
      setAdminPassword('');
      onSaved();
    },
    onError: (err) => toast('error', err instanceof ApiError ? err.message : 'No se pudo guardar.'),
  });

  return (
    <Hoja
      title="Motor de correo"
      className="min-w-0"
      actions={
        data.demoMode ? (
          <MarcaFondo veredicto="vigilar">Forzado a demostración por MAILWAY_DEMO=1</MarcaFondo>
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
        onSubmit={(e) => {
          e.preventDefault();
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
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://mailway-mail:8080"
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Usuario admin"
                required
                value={adminUser}
                onChange={(e) => setAdminUser(e.target.value)}
              />
              <Input
                label="Contraseña"
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                placeholder={engine?.hasPassword ? '(sin cambios)' : ''}
                help={engine?.hasPassword ? 'Déjala vacía para mantener la actual.' : undefined}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Host SMTP (envíos API)"
                mono
                required
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
              />
              <Input
                label="Puerto SMTP"
                required
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
            {testResult.ok ? 'Conexión correcta con el motor.' : `Sin conexión: ${testResult.detail || ''}`}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {kind === 'stalwart' && (
            <Button type="button" variant="perfil" busy={test.isPending} onClick={() => test.mutate()}>
              Probar conexión
            </Button>
          )}
          {/* La única acción en tinta sólida de la vista es «Guardar» (identidad):
              el motor se guarda con filete para no competir con ella. */}
          <Button type="submit" variant="perfil" busy={save.isPending} disabled={data.demoMode}>
            Guardar motor
          </Button>
        </div>
      </form>
    </Hoja>
  );
}
