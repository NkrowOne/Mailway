import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Alert, type NotifyChannelsView } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Cargando, Encabezado, Estado, Panel, Sello, Vacio } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { formatDate } from '../../lib/format';

const severityMeta = {
  critical: { tone: 'devuelto' as const, label: 'Crítico' },
  warning: { tone: 'transito' as const, label: 'Aviso' },
  info: { tone: 'neutro' as const, label: 'Info' },
};

/**
 * Sala de avisos: qué está roto ahora mismo y por dónde te avisa Mailway
 * cuando no estás mirando.
 */
export default function Avisos() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [verResueltas, setVerResueltas] = useState(false);

  const alerts = useQuery({
    queryKey: ['alerts', verResueltas],
    queryFn: () =>
      api.get<{ alerts: Alert[] }>(`/api/alerts${verResueltas ? '?includeResolved=1' : ''}`),
    refetchInterval: 60_000,
  });

  const dismiss = useMutation({
    mutationFn: (id: number) => api.post(`/api/alerts/${id}/dismiss`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
  });

  if (alerts.isLoading) return <Cargando label="Cargando avisos…" />;

  const list = alerts.data?.alerts ?? [];
  const abiertas = list.filter((a) => !a.resolvedAt);

  return (
    <>
      <Encabezado
        title="Avisos"
        meta={
          abiertas.length === 0
            ? 'Sin incidencias abiertas.'
            : `${abiertas.length} incidencia(s) abierta(s).`
        }
        actions={
          <Button variant="fantasma" onClick={() => setVerResueltas((v) => !v)}>
            {verResueltas ? 'Ver solo abiertas' : 'Ver historial'}
          </Button>
        }
      />

      <div className="flex flex-col gap-5">
        <Panel title="Incidencias" flush>
          {list.length === 0 ? (
            <Vacio title="Todo en orden">
              El vigilante comprueba cada minuto el servidor de correo, el webmail y la cola de
              salida; una vez al día, las listas negras. Si algo se rompe, aparecerá aquí y te
              llegará por los canales que configures abajo.
            </Vacio>
          ) : (
            <ul className="divide-y divide-suave">
              {list.map((alert) => {
                const meta = severityMeta[alert.severity];
                return (
                  <li key={alert.id} className="flex flex-col gap-2 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Estado tone={meta.tone}>{meta.label}</Estado>
                      <span className="min-w-0 flex-1 text-md font-semibold text-tinta">
                        {alert.title}
                      </span>
                      {alert.resolvedAt ? (
                        <Sello tone="entregado">Resuelto</Sello>
                      ) : (
                        <Button variant="fantasma" onClick={() => dismiss.mutate(alert.id)}>
                          Descartar
                        </Button>
                      )}
                    </div>
                    <p className="text-sm text-tinta-2">{alert.message}</p>
                    {alert.remedy && !alert.resolvedAt && (
                      <div className="rounded bg-chasis-2 px-3 py-2">
                        <p className="font-rotulo text-micro font-semibold uppercase tracking-[0.14em] text-tinta-3">
                          Qué hacer
                        </p>
                        <p className="mt-0.5 text-sm text-tinta-2">{alert.remedy}</p>
                      </div>
                    )}
                    <p className="text-sm text-tinta-3">
                      {formatDate(alert.createdAt)}
                      {alert.resolvedAt && ` · resuelto ${formatDate(alert.resolvedAt)}`}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <CanalesAviso onToast={toast} />
      </div>
    </>
  );
}

function CanalesAviso({ onToast }: { onToast: ReturnType<typeof useToast> }) {
  const queryClient = useQueryClient();
  const channels = useQuery({
    queryKey: ['notify-channels'],
    queryFn: () =>
      api.get<{ channels: NotifyChannelsView; configured: string[] }>('/api/notify/channels'),
  });

  const [form, setForm] = useState({
    webhookUrl: '',
    discordUrl: '',
    telegramToken: '',
    telegramChat: '',
  });

  useEffect(() => {
    const c = channels.data?.channels;
    if (!c) return;
    setForm({
      webhookUrl: c.webhookUrl,
      discordUrl: c.discordUrl,
      telegramToken: '',
      telegramChat: c.telegramChat,
    });
  }, [channels.data]);

  const save = useMutation({
    mutationFn: () => api.put('/api/notify/channels', form),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['notify-channels'] });
      onToast('ok', 'Canales guardados.');
    },
    onError: (err) =>
      onToast('error', err instanceof ApiError ? err.message : 'No se pudo guardar.'),
  });

  const test = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; error?: string; delivered?: string[]; failures?: string[] }>(
        '/api/notify/test',
      ),
    onSuccess: (res) => {
      if (res.ok) {
        onToast('ok', `Aviso de prueba enviado por: ${(res.delivered || []).join(', ')}.`);
      } else if (res.error) {
        onToast('error', res.error);
      } else {
        onToast(
          'error',
          `Fallaron: ${(res.failures || []).join(', ')}. Revisa la URL o el token.`,
        );
      }
    },
  });

  const configured = channels.data?.configured ?? [];

  return (
    <Panel
      title="Cómo quieres que te avise"
      actions={
        configured.length > 0 ? (
          <Estado tone="entregado">{configured.join(' · ')}</Estado>
        ) : (
          <Estado tone="transito">Sin canales</Estado>
        )
      }
    >
      <p className="mb-4 text-sm text-tinta-2">
        Rellena los que uses. Si no configuras ninguno, los avisos solo aparecerán en esta página
        y no te enterarás hasta que entres.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="flex flex-col gap-4"
      >
        <Input
          label="Webhook de Discord"
          help="En Discord: Ajustes del canal → Integraciones → Webhooks → Copiar URL."
          mono
          type="url"
          value={form.discordUrl}
          onChange={(e) => setForm({ ...form, discordUrl: e.target.value })}
          placeholder="https://discord.com/api/webhooks/…"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Token del bot de Telegram"
            help={
              channels.data?.channels.hasTelegramToken
                ? 'Ya hay un token guardado. Déjalo vacío para conservarlo.'
                : 'Créalo hablando con @BotFather en Telegram.'
            }
            mono
            type="password"
            value={form.telegramToken}
            onChange={(e) => setForm({ ...form, telegramToken: e.target.value })}
            placeholder="123456:ABC-DEF…"
          />
          <Input
            label="ID del chat de Telegram"
            help="Escribe a tu bot y consulta getUpdates, o usa @userinfobot."
            mono
            value={form.telegramChat}
            onChange={(e) => setForm({ ...form, telegramChat: e.target.value })}
            placeholder="-1001234567890"
          />
        </div>
        <Input
          label="Webhook genérico"
          help="Recibe un JSON con la alerta. Útil para n8n, Zapier o tu propio sistema."
          mono
          type="url"
          value={form.webhookUrl}
          onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })}
          placeholder="https://…"
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="chasis"
            busy={test.isPending}
            onClick={() => test.mutate()}
          >
            Enviar aviso de prueba
          </Button>
          <Button type="submit" variant="accion" busy={save.isPending}>
            Guardar canales
          </Button>
        </div>
      </form>
    </Panel>
  );
}
