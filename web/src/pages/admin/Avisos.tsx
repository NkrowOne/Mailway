import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Alert, type NotifyChannelsView } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Hoja, Marca, MarcaFondo, Membrete, Midiendo, Vacio, type Veredicto } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { formatDate } from '../../lib/format';

/** La severidad es el veredicto del hallazgo, no una etiqueta decorativa. */
const severidad: Record<Alert['severity'], { veredicto: Veredicto; etiqueta: string }> = {
  critical: { veredicto: 'fuera', etiqueta: 'Crítico' },
  warning: { veredicto: 'vigilar', etiqueta: 'Aviso' },
  info: { veredicto: 'sin-dato', etiqueta: 'Info' },
};

/** Rejilla común de la tabla de hallazgos: veredicto · hallazgo · registro. */
const rejilla = 'sm:grid-cols-[8.5rem_minmax(0,1fr)_12rem]';

/**
 * Hallazgos del parte: qué está fuera de rango ahora mismo y por dónde te
 * avisa Mailway cuando no estás mirando.
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

  if (alerts.isLoading) return <Midiendo label="Leyendo avisos…" />;

  const list = alerts.data?.alerts ?? [];
  const abiertas = list.filter((a) => !a.resolvedAt);

  return (
    <>
      <Membrete
        title="Avisos"
        meta={
          abiertas.length === 0
            ? 'Sin incidencias abiertas.'
            : `${abiertas.length} incidencia(s) abierta(s).`
        }
        actions={
          <Button variant="plano" onClick={() => setVerResueltas((v) => !v)}>
            {verResueltas ? 'Ver solo abiertas' : 'Ver historial'}
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <Hoja title="Incidencias" meta={`${list.length} registrada(s)`} flush>
          {alerts.isError ? (
            <div className="p-4">
              <p
                role="alert"
                className="border border-[rgb(var(--fuera)/0.35)] bg-fuera-fondo px-3 py-2 text-sm text-fuera"
              >
                No se pudieron leer los avisos. Comprueba que el servidor de Mailway sigue en marcha
                y vuelve a intentarlo.
              </p>
              <Button variant="perfil" className="mt-3" onClick={() => void alerts.refetch()}>
                Reintentar
              </Button>
            </div>
          ) : list.length === 0 ? (
            <Vacio title="Todo en orden">
              El vigilante comprueba cada minuto el servidor de correo, el webmail y la cola de
              salida; una vez al día, las listas negras. Si algo se rompe, aparecerá aquí y te
              llegará por los canales que configures abajo.
            </Vacio>
          ) : (
            <>
              <div
                className={`regla-cabecera hidden gap-x-4 px-4 pb-1.5 pt-2.5 sm:grid ${rejilla}`}
              >
                <span className="rotulo">Veredicto</span>
                <span className="rotulo">Hallazgo</span>
                <span className="rotulo sm:text-right">Registro</span>
              </div>
              <ul>
                {list.map((alert) => {
                  const meta = severidad[alert.severity];
                  return (
                    <li
                      key={alert.id}
                      className={`regla-fila grid gap-x-4 gap-y-2 px-4 py-3 last:border-b-0 ${rejilla}`}
                    >
                      <span className="justify-self-start sm:pt-0.5">
                        <MarcaFondo veredicto={meta.veredicto}>{meta.etiqueta}</MarcaFondo>
                      </span>

                      <div className="min-w-0">
                        <p className="text-md font-semibold text-tinta">{alert.title}</p>
                        <p className="mt-0.5 text-base text-tinta-2">{alert.message}</p>
                        {alert.remedy && !alert.resolvedAt && (
                          <div className="mt-2 bg-hoja-2 px-3 py-2">
                            <p className="rotulo">Qué hacer</p>
                            <p className="mt-0.5 text-base text-tinta-2">{alert.remedy}</p>
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5 sm:flex-col sm:items-end">
                        <span className="valor text-sm text-tinta-3">
                          {formatDate(alert.createdAt)}
                        </span>
                        {alert.resolvedAt ? (
                          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 sm:justify-end">
                            <Marca veredicto="normal">Resuelto</Marca>
                            <span className="valor text-sm text-tinta-3">
                              {formatDate(alert.resolvedAt)}
                            </span>
                          </span>
                        ) : (
                          <Button
                            variant="plano"
                            busy={dismiss.isPending && dismiss.variables === alert.id}
                            onClick={() => dismiss.mutate(alert.id)}
                          >
                            Descartar
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Hoja>

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
    <Hoja
      title="Cómo quieres que te avise"
      actions={
        configured.length > 0 ? (
          <MarcaFondo veredicto="normal">{configured.join(' · ')}</MarcaFondo>
        ) : (
          <MarcaFondo veredicto="vigilar">Sin canales</MarcaFondo>
        )
      }
    >
      {channels.isPending ? (
        <Midiendo label="Leyendo canales…" />
      ) : (
        <>
          <p className="mb-4 text-base text-tinta-2">
            Rellena los que uses. Si no configuras ninguno, los avisos solo aparecerán en esta
            página y no te enterarás hasta que entres.
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
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="perfil"
                busy={test.isPending}
                onClick={() => test.mutate()}
              >
                Enviar aviso de prueba
              </Button>
              <Button type="submit" variant="tinta" busy={save.isPending}>
                Guardar canales
              </Button>
            </div>
          </form>
        </>
      )}
    </Hoja>
  );
}
