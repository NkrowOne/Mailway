import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Alert, type NotifyChannelsView } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import {
  AvisoError,
  Hoja,
  Marca,
  MarcaFondo,
  Membrete,
  Midiendo,
  Vacio,
  type Veredicto,
} from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { formatDate, plural } from '../../lib/format';

/** La severidad es el veredicto del hallazgo, no una etiqueta decorativa. */
const severidad: Record<Alert['severity'], { veredicto: Veredicto; etiqueta: string; peso: number }> = {
  critical: { veredicto: 'fuera', etiqueta: 'Crítico', peso: 0 },
  warning: { veredicto: 'vigilar', etiqueta: 'Advertencia', peso: 1 },
  info: { veredicto: 'sin-dato', etiqueta: 'Información', peso: 2 },
};

/** Abiertas antes que resueltas y, dentro de ellas, lo más grave primero. */
function ordenar(lista: Alert[]): Alert[] {
  return [...lista].sort((a, b) => {
    const abiertaA = a.resolvedAt === null ? 0 : 1;
    const abiertaB = b.resolvedAt === null ? 0 : 1;
    if (abiertaA !== abiertaB) return abiertaA - abiertaB;
    const gravedad = severidad[a.severity].peso - severidad[b.severity].peso;
    return gravedad !== 0 ? gravedad : b.createdAt - a.createdAt;
  });
}

/** Rejilla común de la tabla de hallazgos: veredicto · hallazgo · registro. */
const rejilla = 'sm:grid-cols-[8.5rem_minmax(0,1fr)_12rem]';

/** Nombre visible de cada canal (el servidor los identifica en minúsculas). */
const NOMBRE_CANAL: Record<string, string> = { webhook: 'Webhook', discord: 'Discord', telegram: 'Telegram' };

function mensajeDe(err: unknown, porDefecto: string): string {
  return err instanceof ApiError ? err.message : porDefecto;
}

/**
 * Hallazgos del parte: qué está fuera de rango ahora mismo y por qué canales
 * avisa Mailway cuando nadie está mirando el panel.
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
    onError: (err) => toast('error', mensajeDe(err, 'No se ha podido descartar el aviso.')),
  });

  const list = ordenar(alerts.data?.alerts ?? []);
  const abiertas = list.filter((a) => !a.resolvedAt);

  return (
    <>
      <Membrete
        title="Avisos"
        meta={
          alerts.isPending
            ? 'Cargando los avisos…'
            : abiertas.length === 0
              ? 'Sin incidencias abiertas.'
              : `${plural(abiertas.length, 'incidencia abierta', 'incidencias abiertas')}.`
        }
        actions={
          <Button
            variant="contorno"
            aria-pressed={verResueltas}
            onClick={() => setVerResueltas((v) => !v)}
          >
            {verResueltas ? 'Ver solo abiertas' : 'Ver historial'}
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <Hoja
          title="Incidencias"
          meta={alerts.data ? plural(list.length, 'registrada', 'registradas') : undefined}
          flush
        >
          {alerts.isPending ? (
            <Midiendo label="Cargando los avisos…" />
          ) : !alerts.data ? (
            <div className="p-4">
              <AvisoError onRetry={() => void alerts.refetch()} retrying={alerts.isFetching}>
                No se han podido leer los avisos. Compruebe que el servidor de Mailway sigue en
                marcha.
              </AvisoError>
            </div>
          ) : list.length === 0 ? (
            <Vacio title={verResueltas ? 'Sin avisos registrados' : 'Todo en orden'}>
              El vigilante comprueba cada minuto el servidor de correo, el webmail y la cola de
              salida y, una vez al día, las listas negras. Si algo falla, aparecerá aquí y se
              notificará por los canales configurados más abajo.
            </Vacio>
          ) : (
            <>
              {alerts.isRefetchError && (
                <div className="px-4 pt-4">
                  <AvisoError onRetry={() => void alerts.refetch()} retrying={alerts.isFetching}>
                    No se ha podido actualizar la lista. Se muestra la última lectura.
                  </AvisoError>
                </div>
              )}
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
                  const abierta = !alert.resolvedAt;
                  // La fila abierta se tiñe con su veredicto; resuelta, ya no califica nada.
                  const tinte = !abierta
                    ? ''
                    : meta.veredicto === 'fuera'
                      ? 'fila-fuera'
                      : meta.veredicto === 'vigilar'
                        ? 'fila-vigilar'
                        : '';
                  return (
                    <li
                      key={alert.id}
                      className={`regla-fila grid gap-x-4 gap-y-2 px-4 py-3 last:border-b-0 ${rejilla} ${tinte}`}
                    >
                      <span className="justify-self-start sm:pt-0.5">
                        <MarcaFondo veredicto={abierta ? meta.veredicto : 'sin-dato'}>
                          {meta.etiqueta}
                        </MarcaFondo>
                      </span>

                      <div className="min-w-0">
                        <p className="text-md font-semibold text-tinta [overflow-wrap:anywhere]">
                          {alert.title}
                        </p>
                        <p className="mt-0.5 text-base text-tinta-2 [overflow-wrap:anywhere]">
                          {alert.message}
                        </p>
                        {alert.remedy && abierta && (
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
    mutationFn: (opciones: { clearTelegramToken?: boolean } = {}) =>
      api.put('/api/notify/channels', { ...form, ...opciones }),
    onSuccess: async (_res, opciones) => {
      await queryClient.invalidateQueries({ queryKey: ['notify-channels'] });
      onToast(
        'ok',
        opciones?.clearTelegramToken ? 'Token de Telegram eliminado.' : 'Canales guardados.',
      );
    },
    onError: (err) => onToast('error', mensajeDe(err, 'No se han podido guardar los canales.')),
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
          `No se ha podido entregar por: ${(res.failures || []).join(', ')}. Revise la URL o el token.`,
        );
      }
    },
    onError: (err) => onToast('error', mensajeDe(err, 'No se ha podido enviar el aviso de prueba.')),
  });

  const configured = channels.data?.configured ?? [];
  const hayToken = channels.data?.channels.hasTelegramToken ?? false;

  return (
    <Hoja
      title="Canales de aviso"
      actions={
        channels.data ? (
          configured.length > 0 ? (
            <MarcaFondo veredicto="normal">
              {configured.map((c) => NOMBRE_CANAL[c] ?? c).join(' · ')}
            </MarcaFondo>
          ) : (
            <MarcaFondo veredicto="vigilar">Sin canales</MarcaFondo>
          )
        ) : undefined
      }
    >
      {channels.isPending ? (
        <Midiendo label="Cargando los canales de aviso…" />
      ) : !channels.data ? (
        <AvisoError onRetry={() => void channels.refetch()} retrying={channels.isFetching}>
          No se han podido leer los canales de aviso.
        </AvisoError>
      ) : (
        <>
          <p className="mb-4 max-w-[75ch] text-base text-tinta-2">
            Complete los canales que utilice. Si no configura ninguno, los avisos solo aparecerán
            en esta página y no recibirá ninguna notificación hasta que acceda al panel. El aviso
            de prueba se envía por los canales ya guardados.
          </p>
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate({});
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
              <div className="flex flex-col gap-1.5">
                <Input
                  label="Token del bot de Telegram"
                  help={
                    hayToken
                      ? 'Hay un token guardado. Déjelo vacío para conservarlo.'
                      : 'Se obtiene al crear el bot con @BotFather en Telegram.'
                  }
                  mono
                  type="password"
                  autoComplete="off"
                  value={form.telegramToken}
                  onChange={(e) => setForm({ ...form, telegramToken: e.target.value })}
                  placeholder="123456:ABC-DEF…"
                />
                {hayToken && (
                  <Button
                    type="button"
                    variant="plano"
                    className="self-start"
                    busy={save.isPending && save.variables?.clearTelegramToken === true}
                    onClick={() => save.mutate({ clearTelegramToken: true })}
                  >
                    Eliminar el token guardado
                  </Button>
                )}
              </div>
              <Input
                label="ID del chat de Telegram"
                help="Escriba al bot y consulte getUpdates, o utilice @userinfobot."
                mono
                value={form.telegramChat}
                onChange={(e) => setForm({ ...form, telegramChat: e.target.value })}
                placeholder="-1001234567890"
              />
            </div>
            <Input
              label="Webhook genérico"
              help="Recibe un JSON con cada aviso. Útil para n8n, Zapier o un sistema propio."
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
              <Button
                type="submit"
                variant="tinta"
                busy={save.isPending && !save.variables?.clearTelegramToken}
              >
                Guardar canales
              </Button>
            </div>
          </form>
        </>
      )}
    </Hoja>
  );
}
