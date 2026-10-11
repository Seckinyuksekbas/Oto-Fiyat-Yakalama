import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeES } from '@/test/admin-fixtures';
import { ApiError } from './api';
import { adminErrorMessage, adminFieldErrors } from './admin-api';
import { createAdminStream, mergeKpi } from './admin-stream';

const factory = (url: string) => new FakeES(url) as unknown as EventSource;

beforeEach(() => {
  FakeES.instances = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function handlers() {
  return { onReady: vi.fn(), onAlert: vi.fn(), onJob: vi.fn(), onKpi: vi.fn(), onStatus: vi.fn() };
}

describe('createAdminStream', () => {
  it('connects to /admin/stream and routes ready/alert/job/kpi events', () => {
    const h = handlers();
    const s = createAdminStream({ ...h, eventSourceFactory: factory });
    const es = FakeES.last();
    expect(es.url).toBe('/api/v1/admin/stream');
    es.emit('ready', { users: { total: 1 } });
    expect(h.onReady).toHaveBeenCalledWith({ users: { total: 1 } });
    expect(h.onStatus).toHaveBeenLastCalledWith('open');
    const alert = { type: 'alert', key: 'k', level: 'WARN', message: 'm', at: '2026-10-11T10:00:00.000Z' };
    es.emit('alert', alert);
    es.emit('alert', alert); // tekrar → yok sayılır
    es.emit('alert', 'bozuk{');
    expect(h.onAlert).toHaveBeenCalledTimes(1);
    es.emit('job', { type: 'job', jobId: 5, sourceId: 1, status: 'SUCCEEDED', at: '2026-10-11T10:00:00.000Z' });
    expect(h.onJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 5, status: 'SUCCEEDED' }));
    es.emit('kpi', { queues: null });
    expect(h.onKpi).toHaveBeenCalledWith({ queues: null });
    s.close();
    expect(es.closed).toBe(true);
  });

  it('reconnects after an error with a refresh, and stops when the session expired', async () => {
    const h = handlers();
    const refresh = vi.fn().mockResolvedValueOnce('ok').mockResolvedValueOnce('expired');
    createAdminStream({ ...h, refresh, eventSourceFactory: factory, random: () => 0.5 });
    FakeES.last().emit('error', {});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(FakeES.instances).toHaveLength(2);
    FakeES.last().emit('error', {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(FakeES.instances).toHaveLength(2);
    expect(h.onStatus).toHaveBeenLastCalledWith('closed');
  });

  it('watchdog reconnects after 60 s of silence', async () => {
    const h = handlers();
    createAdminStream({ ...h, refresh: () => Promise.resolve('ok' as const), eventSourceFactory: factory });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(FakeES.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeES.instances).toHaveLength(2);
    expect(FakeES.instances[0]!.closed).toBe(true);
  });
});

describe('mergeKpi', () => {
  it('overwrites the KPI subset and keeps the rest of the overview', () => {
    const prev = { users: { total: 3 }, queues: { a: 1 }, workers: { alive: 1, dead: 0 } } as never;
    const next = mergeKpi(prev, { queues: null, workers: { alive: 2, dead: 1 }, notifications: {}, sources: [] } as never);
    expect(next).toMatchObject({ users: { total: 3 }, queues: null, workers: { alive: 2, dead: 1 } });
    expect(mergeKpi(undefined, { queues: null } as never)).toBeUndefined();
  });
});

describe('admin error mapping', () => {
  it('maps codes to Turkish and keeps server-provided 409 messages', () => {
    expect(adminErrorMessage(new ApiError(409, 'INVALID_OPERATION', 'Son süper admin silinemez'))).toBe('Son süper admin silinemez');
    expect(adminErrorMessage(new ApiError(403, 'FORBIDDEN', 'Forbidden'))).toMatch(/yetkiniz yok/);
    expect(adminErrorMessage(new ApiError(404, 'NOT_FOUND', 'x'))).toMatch(/bulunamadı/);
    expect(adminErrorMessage(new ApiError(429, 'RATE_LIMITED', 'x'))).toMatch(/Çok fazla/);
    expect(adminErrorMessage(new ApiError(500, 'INTERNAL', 'stack trace'))).not.toMatch(/stack/);
    expect(adminErrorMessage(new TypeError('fetch failed'))).toMatch(/Bağlantı hatası/);
  });

  it('extracts field errors from both detail path shapes', () => {
    const err = new ApiError(400, 'VALIDATION_FAILED', 'Geçersiz istek', [
      { path: ['planId'], message: 'Paket bulunamadı' },
      { path: 'limitOverrides.channels', message: 'IN_APP kanalı çıkarılamaz' },
    ]);
    expect(adminFieldErrors(err)).toEqual({ planId: 'Paket bulunamadı', 'limitOverrides.channels': 'IN_APP kanalı çıkarılamaz' });
    expect(adminFieldErrors(new Error('x'))).toEqual({});
  });
});
