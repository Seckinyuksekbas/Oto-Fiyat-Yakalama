import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotificationStream } from './sse';

class FakeES {
  static instances: FakeES[] = [];
  readonly url: string;
  closed = false;
  private listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeES.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data ?? {}) } as MessageEvent);
  }
}
const factory = (url: string) => new FakeES(url) as unknown as EventSource;
const notif = (id: number) => ({ id, kind: 'MATCH', channel: 'IN_APP', status: 'PENDING', payload: {}, createdAt: '2026-10-11T10:00:00.000Z' });

describe('createNotificationStream', () => {
  beforeEach(() => {
    FakeES.instances = [];
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter 0
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ready sets count and lastId; older or duplicate events are not double counted', () => {
    let count = 0;
    const onReady = vi.fn((r: { unreadCount: number }) => {
      count = r.unreadCount;
    });
    createNotificationStream({ onReady, onNotification: () => count++, eventSourceFactory: factory });
    const es = FakeES.instances[0]!;
    expect(es.url).toBe('/api/v1/me/notifications/stream');
    es.emit('ready', { unreadCount: 3, lastId: 10 });
    expect(count).toBe(3);
    es.emit('notification', notif(9));
    expect(count).toBe(3);
    es.emit('notification', notif(11));
    expect(count).toBe(4);
    es.emit('notification', notif(11));
    expect(count).toBe(4);
  });

  it('reconnects with exponential backoff after error and refreshes before reconnecting', async () => {
    const refresh = vi.fn().mockResolvedValue(true);
    createNotificationStream({ onReady: vi.fn(), onNotification: vi.fn(), eventSourceFactory: factory, refresh });
    FakeES.instances[0]!.emit('error');
    expect(FakeES.instances[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeES.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(FakeES.instances).toHaveLength(2);
    FakeES.instances[1]!.emit('error');
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeES.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeES.instances).toHaveLength(3);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('resets the backoff after a successful ready', async () => {
    createNotificationStream({ onReady: vi.fn(), onNotification: vi.fn(), eventSourceFactory: factory });
    FakeES.instances[0]!.emit('error');
    await vi.advanceTimersByTimeAsync(1000);
    FakeES.instances[1]!.emit('ready', { unreadCount: 0, lastId: null });
    FakeES.instances[1]!.emit('error');
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeES.instances).toHaveLength(3);
  });

  it('proactively reconnects before the 15 minute server cutoff', async () => {
    createNotificationStream({ onReady: vi.fn(), onNotification: vi.fn(), eventSourceFactory: factory });
    await vi.advanceTimersByTimeAsync(14 * 60_000 + 29_000);
    expect(FakeES.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeES.instances).toHaveLength(2);
    expect(FakeES.instances[0]!.closed).toBe(true);
  });

  it('close() stops reconnecting', async () => {
    const stream = createNotificationStream({ onReady: vi.fn(), onNotification: vi.fn(), eventSourceFactory: factory });
    FakeES.instances[0]!.emit('error');
    stream.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeES.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
