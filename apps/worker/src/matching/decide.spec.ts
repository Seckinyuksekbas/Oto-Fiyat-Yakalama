import { describe, expect, it } from 'vitest';
import { decideMatchReason } from './decide';

const P = { notifyOnPriceDrop: true, priceDropPct: 0.05, notifyOnRelist: true };

describe('decideMatchReason', () => {
  it('never-matched profile gets NEW for every event', () => {
    expect(decideMatchReason('NEW', P, null, 1000n)).toBe('NEW');
    expect(decideMatchReason('PRICE_DROP', { ...P, notifyOnPriceDrop: false }, null, 1000n)).toBe('NEW');
    expect(decideMatchReason('RELIST', { ...P, notifyOnRelist: false }, null, 1000n)).toBe('NEW');
  });
  it('already matched: repeated NEW at same or higher price yields nothing', () => {
    expect(decideMatchReason('NEW', P, 1000n, 1000n)).toBeNull();
    expect(decideMatchReason('NEW', P, 1000n, 1100n)).toBeNull();
  });
  it('price drop threshold is inclusive and relative to the last matched price', () => {
    expect(decideMatchReason('PRICE_DROP', P, 1_000_000n, 950_000n)).toBe('PRICE_DROP');
    expect(decideMatchReason('PRICE_DROP', P, 1_000_000n, 950_001n)).toBeNull();
    expect(decideMatchReason('PRICE_DROP', { ...P, notifyOnPriceDrop: false }, 1_000_000n, 500_000n)).toBeNull();
    // Yükseltme kaynaklı NEW olayı da yeterli düşüşte PRICE_DROP üretir
    expect(decideMatchReason('NEW', P, 1_000_000n, 900_000n)).toBe('PRICE_DROP');
  });
  it('relist goes to RELIST profiles; a cheaper relist also feeds price-drop profiles', () => {
    expect(decideMatchReason('RELIST', P, 1_000_000n, 1_000_000n)).toBe('RELIST');
    expect(decideMatchReason('RELIST', { ...P, notifyOnRelist: false }, 1_000_000n, 1_000_000n)).toBeNull();
    expect(decideMatchReason('RELIST', { ...P, notifyOnRelist: false }, 1_000_000n, 900_000n)).toBe('PRICE_DROP');
  });
});
