import { describe, expect, it } from 'vitest';
import { startOfIstanbulDay } from './time';

describe('startOfIstanbulDay', () => {
  it('returns 21:00Z of previous UTC day for late Istanbul evening', () => {
    expect(startOfIstanbulDay(new Date('2026-10-10T20:59:59Z')).toISOString()).toBe('2026-10-09T21:00:00.000Z');
  });

  it('rolls over exactly at Istanbul midnight', () => {
    expect(startOfIstanbulDay(new Date('2026-10-10T21:00:00Z')).toISOString()).toBe('2026-10-10T21:00:00.000Z');
  });
});
