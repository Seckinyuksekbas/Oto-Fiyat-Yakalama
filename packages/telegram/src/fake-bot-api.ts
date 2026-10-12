import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TelegramUpdate } from './client';

/** Testler için sahte Telegram Bot API (yalnızca 127.0.0.1). */
export class FakeTelegramApi {
  readonly token = 'test-token-123:ABC';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly requests: Array<{ method: string; body: any }> = [];
  private server?: Server;
  private readonly scripted = new Map<string, Array<{ status: number; body: unknown }>>();
  private updates: TelegramUpdate[] = [];
  private messageId = 0;

  respondNext(method: string, r: { status: number; body: unknown }): void {
    const q = this.scripted.get(method) ?? [];
    q.push(r);
    this.scripted.set(method, q);
  }

  reset(): void {
    this.requests.length = 0;
    this.scripted.clear();
    this.updates = [];
  }

  queueUpdates(u: TelegramUpdate[]): void {
    this.updates.push(...u);
  }

  async start(): Promise<{ apiBase: string; token: string }> {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (!m || m[1] !== this.token) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
        const method = m[2] as string;
        let body;
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return send(400, { ok: false, error_code: 400, description: 'Bad Request: malformed JSON' });
        }
        this.requests.push({ method, body });
        const next = this.scripted.get(method)?.shift();
        if (next) return send(next.status, next.body);
        if (method === 'getUpdates') {
          // Gerçek Bot API gibi: offset'ten küçük güncellemeler onaylanmış sayılıp atılır,
          // onaylanmayanlar sonraki çağrıda yeniden teslim edilir.
          const offset = Number(body.offset ?? 0);
          this.updates = this.updates.filter((u) => u.update_id >= offset);
          return send(200, { ok: true, result: [...this.updates] });
        }
        this.messageId += 1;
        return send(200, { ok: true, result: { message_id: this.messageId } });
      });
    });
    this.server = server;
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return { apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: this.token };
  }

  async close(): Promise<void> {
    await new Promise<void>((done) => (this.server ? this.server.close(() => done()) : done()));
  }
}
