import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';

export interface SseEvent {
  event: string;
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface SseClient {
  events: SseEvent[];
  status: number;
  waitFor(pred: (e: SseEvent) => boolean, ms?: number): Promise<SseEvent>;
  /** Sunucu yanıtı bitirdiğinde (akış kapandığında) çözülür. */
  ended: Promise<void>;
  close(): void;
}

const ports = new WeakMap<object, number>();

async function portOf(app: NestExpressApplication): Promise<number> {
  let port = ports.get(app);
  if (port === undefined) {
    const server = await app.listen(0);
    port = (server.address() as AddressInfo).port;
    ports.set(app, port);
  }
  return port;
}

/** SSE akışına ham HTTP ile bağlanır; yanıt başlıkları gelince döner. */
export async function openSse(
  app: NestExpressApplication,
  cookie: string,
  path = '/api/v1/me/notifications/stream',
): Promise<SseClient> {
  const port = await portOf(app);
  const events: SseEvent[] = [];
  const waiters: Array<() => void> = [];
  let buffer = '';

  const parseChunk = (chunk: string) => {
    buffer += chunk.replace(/\r\n/g, '\n');
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      const text = data.join('\n');
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* düz metin */
      }
      events.push({ event, data: parsed });
    }
    for (const w of waiters.splice(0)) w();
  };

  let req!: http.ClientRequest;
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', agent: false, headers: { Cookie: cookie, Accept: 'text/event-stream' } },
      resolve,
    );
    req.on('error', reject);
    req.end();
  });
  req.on('error', () => undefined);
  res.setEncoding('utf8');
  res.on('data', parseChunk);
  res.on('error', () => undefined);
  const ended = new Promise<void>((resolve) => {
    res.on('end', () => resolve());
    res.on('close', () => resolve());
  });

  return {
    events,
    ended,
    status: res.statusCode ?? 0,
    async waitFor(pred, ms = 3000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`SSE olayı beklerken zaman aşımı; alınanlar: ${JSON.stringify(events)}`);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, left);
          waiters.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    },
    close() {
      req.destroy();
      res.destroy();
    },
  };
}
