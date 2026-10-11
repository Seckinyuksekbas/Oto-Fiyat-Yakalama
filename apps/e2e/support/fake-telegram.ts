import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * E2E için sahte Telegram Bot API (yalnızca 127.0.0.1). api (polling) ve worker (gönderim) buna konuşur.
 *
 * Bot API:  POST /bot<token>/<method>   getMe, getUpdates (long-poll), sendMessage, sendPhoto, answerCallbackQuery,
 *           setWebhook, deleteWebhook, getWebhookInfo
 * Test:     GET  /__messages[?chatId=]  gönderilen mesajlar (sendMessage/sendPhoto)
 *           POST /__pushUpdate          { message } | { chatId, text } → update_id atanıp kuyruğa eklenir
 *           POST /__fail                { method, chatId?, status, description } → eşleşen çağrılar bu hatayla döner
 *           POST /__clearFail           { chatId? } → o sohbetin (ya da tüm) hata kurallarını kaldırır
 *           POST /__reset
 */
export interface SentMessage {
  method: string;
  chatId: string;
  text: string;
  replyMarkup?: { inline_keyboard?: Array<Array<{ text: string; url?: string; callback_data?: string }>> };
  at: string;
}

interface Update {
  update_id: number;
  [k: string]: unknown;
}

interface FailRule {
  method: string;
  chatId?: string;
  status: number;
  description: string;
}

/** Token biçimli literal repoya girmez; çalışma anında üretilir. */
export function fakeBotToken(): string {
  return ['123456789', 'TEST'.padEnd(35, 'x')].join(':');
}

export class FakeTelegram {
  readonly messages: SentMessage[] = [];
  readonly calls: string[] = [];
  private updates: Update[] = [];
  private nextUpdateId = 1;
  private messageId = 0;
  private failRules: FailRule[] = [];
  private waiters = new Set<() => void>();
  private server?: Server;

  constructor(private readonly token: string) {}

  async start(port: number, host = '127.0.0.1'): Promise<void> {
    const server = createServer((req, res) => void this.route(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
  }

  async close(): Promise<void> {
    for (const wake of this.waiters) wake();
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await new Promise<string>((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
    });
    const send = (status: number, body: unknown) => {
      if (res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return send(400, { ok: false, error_code: 400, description: 'Bad Request: malformed JSON' });
    }
    const url = new URL(req.url ?? '/', 'http://fake');

    if (url.pathname === '/__messages') {
      const chatId = url.searchParams.get('chatId');
      return send(200, chatId ? this.messages.filter((m) => m.chatId === chatId) : this.messages);
    }
    if (url.pathname === '/__pushUpdate' && req.method === 'POST') {
      const update: Update = body.message
        ? { update_id: this.nextUpdateId++, ...body }
        : {
            update_id: this.nextUpdateId++,
            message: { message_id: ++this.messageId, chat: { id: Number(body.chatId), type: 'private' }, from: { id: Number(body.chatId) }, text: String(body.text ?? '') },
          };
      this.updates.push(update);
      for (const wake of this.waiters) wake();
      return send(201, { update_id: update.update_id });
    }
    if (url.pathname === '/__fail' && req.method === 'POST') {
      this.failRules.push({
        method: String(body.method),
        chatId: body.chatId === undefined ? undefined : String(body.chatId),
        status: Number(body.status ?? 403),
        description: String(body.description ?? 'Forbidden: bot was blocked by the user'),
      });
      return send(201, { ok: true });
    }
    if (url.pathname === '/__clearFail' && req.method === 'POST') {
      const chatId = body.chatId === undefined ? undefined : String(body.chatId);
      this.failRules = chatId === undefined ? [] : this.failRules.filter((r) => r.chatId !== chatId);
      return send(200, { ok: true });
    }
    if (url.pathname === '/__reset' && req.method === 'POST') {
      this.messages.length = 0;
      this.calls.length = 0;
      this.updates = [];
      this.failRules = [];
      return send(200, { ok: true });
    }

    const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    if (!m || m[1] !== this.token) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const method = m[2] as string;
    this.calls.push(method);
    const chatId = body.chat_id === undefined ? undefined : String(body.chat_id);
    const rule = this.failRules.find((r) => r.method === method && (r.chatId === undefined || r.chatId === chatId));
    if (rule) return send(rule.status, { ok: false, error_code: rule.status, description: rule.description });

    switch (method) {
      case 'getMe':
        return send(200, { ok: true, result: { id: 123456789, is_bot: true, first_name: 'Oto E2E', username: 'oto_e2e_bot' } });
      case 'getUpdates': {
        const offset = Number(body.offset ?? 0);
        this.updates = this.updates.filter((u) => u.update_id >= offset);
        if (this.updates.length === 0) {
          // Gerçek Bot API gibi long-poll: güncelleme gelene ya da timeout dolana kadar bekle (en fazla 25 sn).
          const timeoutSec = Math.min(Number(body.timeout ?? 0), 25);
          if (timeoutSec > 0) await this.waitForUpdate(timeoutSec * 1000, req);
          this.updates = this.updates.filter((u) => u.update_id >= offset);
        }
        return send(200, { ok: true, result: [...this.updates] });
      }
      case 'sendMessage':
      case 'sendPhoto': {
        const replyMarkup = body.reply_markup as SentMessage['replyMarkup'];
        this.messages.push({
          method,
          chatId: chatId ?? '',
          text: String(body.text ?? body.caption ?? ''),
          replyMarkup,
          at: new Date().toISOString(),
        });
        return send(200, { ok: true, result: { message_id: ++this.messageId } });
      }
      case 'answerCallbackQuery':
      case 'setWebhook':
      case 'deleteWebhook':
        return send(200, { ok: true, result: true });
      case 'getWebhookInfo':
        return send(200, { ok: true, result: { url: '', pending_update_count: 0 } });
      default:
        return send(200, { ok: true, result: true });
    }
  }

  private waitForUpdate(ms: number, req: IncomingMessage): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        req.off('close', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      req.on('close', done);
    });
  }
}
