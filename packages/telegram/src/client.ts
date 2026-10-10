export type InlineButton = { text: string; url?: string; callback_data?: string };
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };

export interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
  my_chat_member?: { chat: { id: number }; new_chat_member: { status: string } };
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly errorCode: number,
    readonly description: string,
    readonly retryAfterSec: number | null,
  ) {
    super(`Telegram ${method} başarısız (${status}): ${description}`);
    this.name = 'TelegramApiError';
  }
}

interface ApiEnvelope<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramClient {
  private readonly apiBase: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: { token: string; apiBase?: string; timeoutMs?: number }) {
    this.apiBase = (opts.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** Hata mesajları URL'yi (dolayısıyla token'ı) içermez. */
  async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs ?? this.timeoutMs);
    const res = await fetch(`${this.apiBase}/bot${this.opts.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const json = (await res.json().catch(() => ({ ok: false, description: 'Geçersiz JSON yanıtı' }))) as ApiEnvelope<T>;
    if (!res.ok || !json.ok) {
      throw new TelegramApiError(method, res.status, json.error_code ?? res.status, json.description ?? 'Bilinmeyen hata', json.parameters?.retry_after ?? null);
    }
    return json.result as T;
  }

  sendMessage(chatId: number | string, text: string, replyMarkup?: InlineKeyboard) {
    return this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }

  sendPhoto(chatId: number | string, photo: string, caption: string, replyMarkup?: InlineKeyboard) {
    return this.call('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }

  answerCallbackQuery(id: string, text: string) {
    return this.call('answerCallbackQuery', { callback_query_id: id, text });
  }

  /** Uzun yoklama: istemci zaman aşımı sunucu bekleme süresinden 10 sn uzundur. */
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query', 'my_chat_member'] },
      signal,
      timeoutSec * 1000 + 10_000,
    );
  }
}
