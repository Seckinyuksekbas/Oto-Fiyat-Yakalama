import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWithTimeout } from './close-with-timeout';

const logger = () => ({ warn: vi.fn(), error: vi.fn() });

describe('closeWithTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('forces close(true) when the graceful close exceeds the limit', async () => {
    const close = vi.fn((force?: boolean) => (force ? Promise.resolve() : new Promise<void>(() => undefined)));
    const log = logger();
    const done = closeWithTimeout({ close }, 100, log);
    await vi.advanceTimersByTimeAsync(99);
    expect(close).not.toHaveBeenCalledWith(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBe('forced');
    expect(close).toHaveBeenCalledWith(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('100'));
  });

  it('does not force when the graceful close finishes within the limit', async () => {
    const close = vi.fn(() => new Promise<void>((r) => setTimeout(r, 50)));
    const log = logger();
    const done = closeWithTimeout({ close }, 100, log);
    await vi.advanceTimersByTimeAsync(50);
    await expect(done).resolves.toBe('graceful');
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalledWith(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(close).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('waits for active jobs with pause() so a later close(true) is a real force (BullMQ caches close())', async () => {
    const calls: string[] = [];
    const worker = {
      pause: vi.fn(() => {
        calls.push('pause');
        return new Promise<void>(() => undefined); // aktif iş hiç bitmiyor
      }),
      close: vi.fn((force?: boolean) => {
        calls.push(force ? 'close(force)' : 'close');
        return Promise.resolve();
      }),
    };
    const done = closeWithTimeout(worker, 100, logger());
    await vi.advanceTimersByTimeAsync(100);
    await expect(done).resolves.toBe('forced');
    expect(calls).toEqual(['pause', 'close(force)']);
  });

  it('pauses then closes gracefully when active jobs finish in time', async () => {
    const calls: string[] = [];
    const worker = {
      pause: vi.fn(async () => void calls.push('pause')),
      close: vi.fn(async (force?: boolean) => void calls.push(force ? 'close(force)' : 'close')),
    };
    await expect(closeWithTimeout(worker, 100, logger())).resolves.toBe('graceful');
    expect(calls).toEqual(['pause', 'close']);
  });

  it('bounds a hanging forced close as well', async () => {
    const close = vi.fn(() => new Promise<void>(() => undefined));
    const log = logger();
    const done = closeWithTimeout({ close }, 100, log);
    await vi.advanceTimersByTimeAsync(200);
    await expect(done).resolves.toBe('forced');
    expect(log.error).toHaveBeenCalled();
  });

  it('falls back to force when the graceful close rejects', async () => {
    const close = vi.fn((force?: boolean) => (force ? Promise.resolve() : Promise.reject(new Error('boom'))));
    const log = logger();
    await expect(closeWithTimeout({ close }, 100, log)).resolves.toBe('forced');
    expect(close).toHaveBeenCalledWith(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});
