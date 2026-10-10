import { describe, expect, it } from 'vitest';
import { notifyBackoffMs, RetryableNotifyError } from './backoff';

describe('notifyBackoffMs', () => {
  it('follows the spec schedule', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => notifyBackoffMs(n))).toEqual([10_000, 30_000, 120_000, 600_000, 1_800_000, 1_800_000]);
  });
  it('honours retry_after when larger', () => {
    expect(notifyBackoffMs(1, new RetryableNotifyError('429', 45_000))).toBe(45_000);
    expect(notifyBackoffMs(3, new RetryableNotifyError('429', 1_000))).toBe(120_000);
  });
});
