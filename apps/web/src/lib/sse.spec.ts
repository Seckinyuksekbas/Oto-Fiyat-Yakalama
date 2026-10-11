import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay, createNotificationStream, createToastLimiter } from './sse';

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
    // 25 sn'de bir ping: bekçi zamanlayıcısı devreye girmesin.
    for (let i = 0; i < 34; i++) {
      await vi.advanceTimersByTimeAsync(25_000);
      FakeES.instances.at(-1)!.emit('ping');
    }
    await vi.advanceTimersByTimeAsync(19_000); // 14 dk 29 sn
    expect(FakeES.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeES.instances).toHaveLength(2);
    expect(FakeES.instances[0]!.closed).toBe(true);
  });

  it('stops reconnecting and reports closed when refresh returns false (session over)', async () => {
    const onStatus = vi.fn();
    const refresh = vi.fn().mockResolvedValue(false);
    createNotificationStream({ onReady: vi.fn(), onNotification: vi.fn(), onStatus, eventSourceFactory: factory, refresh });
    FakeES.instances[0]!.emit('error');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(FakeES.instances).toHaveLength(1);
    expect(onStatus).toHaveBeenLastCalledWith('closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps retrying with backoff when refresh throws a transient error', async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(true);
    createNotificationStream({ onReady: vi.fn(), onNotification: vi.fn(), eventSourceFactory: factory, refresh });
    FakeES.instances[0]!.emit('error');
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(FakeES.instances).toHaveLength(1); // refresh patladı, bağlanılmadı
    await vi.advanceTimersByTimeAsync(2000); // ikinci bekleme: 2 sn
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(FakeES.instances).toHaveLength(2);
  });

  it("detailed refresh: 'expired' stops, 'transient' keeps retrying", async () => {
    const onStatus = vi.fn();
    const refresh = vi.fn().mockResolvedValueOnce('transient').mockResolvedValueOnce('ok');
    createNotificationStream({ onReady: vi.fn(), onNotification: vi.fn(), onStatus, eventSourceFactory: factory, refresh });
    FakeES.instances[0]!.emit('error');
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeES.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeES.instances).toHaveLength(2);
    refresh.mockResolvedValueOnce('expired');
    FakeES.instances[1]!.emit('error');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeES.instances).toHaveLength(2);
    expect(onStatus).toHaveBeenLastCalledWith('closed');
  });

  it('reconnects when nothing (not even a ping) arrives for 60 seconds', async () => {
    createNotificationStream({ onReady: vi.fn(), onNotification: vi.fn(), eventSourceFactory: factory });
    await vi.advanceTimersByTimeAsync(59_000);
    FakeES.instances[0]!.emit('ping');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(FakeES.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeES.instances).toHaveLength(2);
    expect(FakeES.instances[0]!.closed).toBe(true);
  });

  it('ignores non IN_APP notifications', () => {
    const onNotification = vi.fn();
    createNotificationStream({ onReady: vi.fn(), onNotification, eventSourceFactory: factory });
    FakeES.instances[0]!.emit('ready', { unreadCount: 0, lastId: null });
    FakeES.instances[0]!.emit('notification', { ...notif(5), channel: 'TELEGRAM' });
    expect(onNotification).not.toHaveBeenCalled();
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

describe('backoffDelay', () => {
  it('doubles up to 30 s and stays within +-20% jitter', () => {
    expect(backoffDelay(0, () => 0.5)).toBe(1000);
    expect(backoffDelay(3, () => 0.5)).toBe(8000);
    expect(backoffDelay(10, () => 0.5)).toBe(30_000);
    expect(backoffDelay(0, () => 0)).toBe(800);
    expect(backoffDelay(0, () => 1)).toBe(1200);
    expect(backoffDelay(10, () => 1)).toBeLessThanOrEqual(36_000);
  });
});

describe('createToastLimiter', () => {
  const ev = (id: number) => notif(id) as never;
  it('allows 3 per sliding 5 s window and collapses the rest', () => {
    let t = 0;
    const show = vi.fn();
    const showOverflow = vi.fn();
    const push = createToastLimiter({ show, showOverflow, now: () => t });
    for (let i = 1; i <= 5; i++) push(ev(i));
    expect(show).toHaveBeenCalledTimes(3);
    expect(showOverflow).toHaveBeenLastCalledWith(2);
    t = 4_999;
    push(ev(6));
    expect(show).toHaveBeenCalledTimes(3);
    expect(showOverflow).toHaveBeenLastCalledWith(3);
    t = 5_000; // ilk üç toast penceresi doldu
    push(ev(7));
    expect(show).toHaveBeenCalledTimes(4);
    push(ev(8));
    push(ev(9));
    push(ev(10));
    expect(show).toHaveBeenCalledTimes(6);
    expect(showOverflow).toHaveBeenLastCalledWith(1);
  });
});
