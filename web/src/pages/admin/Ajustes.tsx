import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type InstanceSettings, type WhitelabelSetup } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Input, Select } from '../../ui/Field';
import { BotonCopiar, Cargando, Encabezado, Estado, Etiqueta, Panel } from '../../ui/kit';
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

  if (settings.isPending) return <Cargando />;
  if (settings.isError || !settings.data) {
    return <p className="text-devuelto">No se pudieron cargar los ajustes.</p>;
  }

  return (
    <>
      <Encabezado title="Ajustes" meta="Identidad del servidor y conexión con el motor de correo." />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <InstancePanel initial={settings.data.instance} onSaved={() => void queryClient.invalidateQueries()} />
        <EnginePanel data={settings.data} onSaved={() => void queryClient.invalidateQueries()} toast={toast} />
        <TraefikPanel />
      </div>
    </>
  );
}

/**
 * Marca blanca: para que los dominios propios de los clientes funcionen, el
 * proxy (Traefik) tiene que sondear este panel. Esto se configura UNA vez y
 * aquí se da el bloque exacto, con su token ya generado.
 */
function TraefikPanel() {
  const setup = useQuery({
    queryKey: ['whitelabel-setup'],
    queryFn: () => api.get<WhitelabelSetup>('/api/whitelabel/setup'),
  });

  if (setup.isPending) return <Panel title="Marca blanca"><Cargando /></Panel>;
  if (setup.isError || !setup.data) {
    return (
      <Panel title="Marca blanca">
        <p className="text-devuelto">No se pudo cargar la configuración.</p>
      </Panel>
    );
  }

  const { token, publishedDomains } = setup.data;
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
      - --certificatesresolvers.le.acme.email=\${LETSENCRYPT_EMAIL:-noreply@example.com}
      - --certificatesresolvers.le.acme.storage=/letsencrypt/acme.json
      - --certificatesresolvers.le.acme.httpchallenge=true
      - --certificatesresolvers.le.acme.httpchallenge.entrypoint=web
      # --- añadido por Mailway: sondea el panel para los dominios de clientes ---
      - --providers.http.endpoint=http://mailway-panel:4100/api/traefik/config
      - --providers.http.pollInterval=15s
      - --providers.http.headers.X-Mailway-Token=${token}`;

  return (
    <Panel
      title="Marca blanca"
      actions={
        publishedDomains > 0 ? (
          <Estado tone="entregado">{publishedDomains} publicado(s)</Estado>
        ) : (
          <Estado tone="neutro">Sin dominios</Estado>
        )
      }
      className="lg:col-span-2"
    >
      <p className="text-sm text-tinta-2">
        Para que tus clientes puedan usar su propio dominio de webmail, Traefik tiene que
        preguntarle a Mailway qué dominios servir. Se configura <strong>una sola vez</strong>:
        crea este fichero junto al <span className="font-guia">docker-compose.yml</span> de Skyway
        y ejecuta <span className="font-guia">docker compose up -d</span>.
      </p>

      <div className="mt-3">
        <Etiqueta className="p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="font-rotulo text-sm font-semibold uppercase tracking-wide opacity-70">
              docker-compose.override.yml
            </span>
            <BotonCopiar text={override} label="Copiar bloque" />
          </div>
          <pre className="overflow-x-auto whitespace-pre text-sm leading-relaxed font-guia">
            {override}
          </pre>
        </Etiqueta>
      </div>

      <p className="mt-3 text-sm text-tinta-3">
        El token autentica a Traefik contra Mailway: sin él, cualquiera podría leer la lista de
        dominios. Si cambias el nombre del contenedor del panel en Skyway, ajusta también la URL
        del sondeo.
      </p>
    </Panel>
  );
}

function InstancePanel({ initial, onSaved }: { initial: InstanceSettings; onSaved: () => void }) {
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
    <Panel title="Identidad del servidor">
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
        <Button type="submit" variant="accion" busy={save.isPending} className="self-start">
          Guardar
        </Button>
      </form>
    </Panel>
  );
}

function EnginePanel({
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
    <Panel
      title="Motor de correo"
      actions={
        data.demoMode ? (
          <Estado tone="transito">Forzado a demostración por MAILWAY_DEMO=1</Estado>
        ) : engine ? (
          <Estado tone={engine.kind === 'demo' ? 'neutro' : 'entregado'}>
            {engine.kind === 'demo' ? 'Demostración' : 'Stalwart conectado'}
          </Estado>
        ) : (
          <Estado tone="transito">Sin configurar</Estado>
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
        <Select label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as 'stalwart' | 'demo')} disabled={data.demoMode}>
          <option value="stalwart">Stalwart (producción)</option>
          <option value="demo">Demostración (sin motor real)</option>
        </Select>
        {kind === 'stalwart' && (
          <>
            <Input label="URL de la API de gestión" mono required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://mailway-mail:8080" />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Usuario admin" required value={adminUser} onChange={(e) => setAdminUser(e.target.value)} />
              <Input
                label="Contraseña"
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                placeholder={engine?.hasPassword ? '(sin cambios)' : ''}
                help={engine?.hasPassword ? 'Déjala vacía para mantener la actual.' : undefined}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Host SMTP (envíos API)" mono required value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
              <Input label="Puerto SMTP" required inputMode="numeric" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} help="587 STARTTLS · 465 SSL" />
            </div>
          </>
        )}
        {testResult && (
          <p
            role="status"
            className={`rounded border px-3 py-2 text-sm ${
              testResult.ok
                ? 'border-[rgb(var(--entregado)/0.4)] bg-[rgb(var(--entregado)/0.08)] text-entregado'
                : 'border-[rgb(var(--devuelto)/0.4)] bg-[rgb(var(--devuelto)/0.08)] text-devuelto'
            }`}
          >
            {testResult.ok ? 'Conexión correcta con el motor.' : `Sin conexión: ${testResult.detail || ''}`}
          </p>
        )}
        <div className="flex gap-2">
          {kind === 'stalwart' && (
            <Button type="button" busy={test.isPending} onClick={() => test.mutate()}>
              Probar conexión
            </Button>
          )}
          {/* Acción secundaria de la vista: la única tecla naranja es «Guardar»
              (identidad). El motor se guarda en chasis para no competir. */}
          <Button type="submit" busy={save.isPending} disabled={data.demoMode}>
            Guardar motor
          </Button>
        </div>
      </form>
    </Panel>
  );
}
