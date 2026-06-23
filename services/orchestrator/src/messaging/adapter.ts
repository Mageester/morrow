/**
 * Outbound messaging adapters. Morrow can deliver notifications (e.g. when a
 * scheduled job finishes) to external channels behind a single small contract.
 * The transport (`fetchImpl`) is injectable so adapters are testable without a
 * network or real credentials, and secrets (bot tokens) are never logged — any
 * error detail is redacted before it leaves the adapter.
 */

export interface OutgoingMessage {
  text: string;
  subject?: string;
}

export interface SendResult {
  ok: boolean;
  detail: string;
}

export type MessageChannel = "webhook" | "telegram";

export interface MessageAdapter {
  id: string;
  channel: MessageChannel;
  send(message: OutgoingMessage): Promise<SendResult>;
}

export type FetchImpl = typeof fetch;

function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join("***");
}

/** Generic webhook: POSTs `{ text, subject }` as JSON to a configured URL. */
export function webhookAdapter(opts: { url: string; fetchImpl?: FetchImpl }): MessageAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    id: "webhook",
    channel: "webhook",
    async send(message) {
      try {
        const res = await fetchImpl(opts.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: message.text, ...(message.subject ? { subject: message.subject } : {}) }),
        });
        return { ok: res.ok, detail: `HTTP ${res.status}` };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** Telegram Bot API sendMessage. The bot token is redacted from any error text. */
export function telegramAdapter(opts: { botToken: string; chatId: string; fetchImpl?: FetchImpl }): MessageAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://api.telegram.org/bot${opts.botToken}/sendMessage`;
  return {
    id: "telegram",
    channel: "telegram",
    async send(message) {
      try {
        const text = message.subject ? `${message.subject}\n${message.text}` : message.text;
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: opts.chatId, text }),
        });
        return { ok: res.ok, detail: redact(`HTTP ${res.status}`, opts.botToken) };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, detail: redact(detail, opts.botToken) };
      }
    },
    // expose the resolved url only for tests via a non-enumerable-ish field is
    // unnecessary; tests assert through the injected fetch instead.
  };
}

/** Build configured adapters from the environment. Returns `[]` when none set. */
export function loadAdaptersFromEnv(env: NodeJS.ProcessEnv): MessageAdapter[] {
  const adapters: MessageAdapter[] = [];
  if (env.MORROW_WEBHOOK_URL) adapters.push(webhookAdapter({ url: env.MORROW_WEBHOOK_URL }));
  if (env.MORROW_TELEGRAM_BOT_TOKEN && env.MORROW_TELEGRAM_CHAT_ID) {
    adapters.push(telegramAdapter({ botToken: env.MORROW_TELEGRAM_BOT_TOKEN, chatId: env.MORROW_TELEGRAM_CHAT_ID }));
  }
  return adapters;
}

export interface NotifyOutcome {
  channel: string;
  ok: boolean;
  detail: string;
}

/** Fan a message out to every adapter; one failure never blocks the others. */
export async function notifyAll(adapters: MessageAdapter[], message: OutgoingMessage): Promise<NotifyOutcome[]> {
  return Promise.all(
    adapters.map(async (adapter) => {
      const result = await adapter.send(message);
      return { channel: adapter.id, ok: result.ok, detail: result.detail };
    })
  );
}
