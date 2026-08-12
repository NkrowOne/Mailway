import { getJsonSetting } from '../modules/settings';

export type Severity = 'critical' | 'warning' | 'info';

export interface NotifyChannels {
  /** Webhook genérico (n8n, Zapier, tu propio endpoint): recibe JSON. */
  webhookUrl: string;
  /** URL de webhook de un canal de Discord. */
  discordUrl: string;
  /** Token del bot de Telegram (de @BotFather). */
  telegramToken: string;
  /** ID del chat de Telegram al que enviar. */
  telegramChat: string;
}

const EMPTY: NotifyChannels = {
  webhookUrl: '',
  discordUrl: '',
  telegramToken: '',
  telegramChat: '',
};

export function getChannels(): NotifyChannels {
  return { ...EMPTY, ...(getJsonSetting<Partial<NotifyChannels>>('notify') || {}) };
}

export function channelsConfigured(): string[] {
  const c = getChannels();
  const list: string[] = [];
  if (c.webhookUrl) list.push('webhook');
  if (c.discordUrl) list.push('discord');
  if (c.telegramToken && c.telegramChat) list.push('telegram');
  return list;
}

const EMOJI: Record<Severity, string> = {
  critical: '🔴',
  warning: '🟡',
  info: '🔵',
};

export interface OutgoingNotification {
  severity: Severity;
  title: string;
  message: string;
  /** Qué hacer para arreglarlo; se añade al final del aviso. */
  remedy?: string;
  /** Nombre del cliente afectado, si la alerta es de uno concreto. */
  client?: string | null;
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function plainText(n: OutgoingNotification): string {
  const context = n.client ? ` — ${n.client}` : '';
  return [
    `${EMOJI[n.severity]} [Mailway] ${n.title}${context}`,
    n.message,
    n.remedy ? `\nQué hacer: ${n.remedy}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Envía el aviso a todos los canales configurados. Nunca lanza: devuelve la
 * lista de canales que fallaron para poder mostrarla en el panel.
 */
export async function dispatch(n: OutgoingNotification): Promise<string[]> {
  const channels = getChannels();
  const failures: string[] = [];
  const text = plainText(n);

  if (channels.webhookUrl) {
    try {
      await post(channels.webhookUrl, {
        source: 'mailway',
        severity: n.severity,
        title: n.title,
        message: n.message,
        remedy: n.remedy ?? null,
        client: n.client ?? null,
        ts: Date.now(),
      });
    } catch {
      failures.push('webhook');
    }
  }

  if (channels.discordUrl) {
    try {
      // Discord corta a 2000 caracteres; dejamos margen.
      await post(channels.discordUrl, { content: text.slice(0, 1900) });
    } catch {
      failures.push('discord');
    }
  }

  if (channels.telegramToken && channels.telegramChat) {
    try {
      await post(`https://api.telegram.org/bot${channels.telegramToken}/sendMessage`, {
        chat_id: channels.telegramChat,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      });
    } catch {
      failures.push('telegram');
    }
  }

  return failures;
}
