import { describe, expect, it } from 'vitest';
import { CATALOG, DemoStore, fairPrice } from './index';

const make = (size = 50) => new DemoStore({ seed: 7, size, currentYear: 2026, now: () => 1_000_000 });

describe('DemoStore', () => {
  it('is deterministic for the same seed', () => {
    expect(make().active().map((l) => [l.id, l.price])).toEqual(make().active().map((l) => [l.id, l.price]));
  });

  it('paginates newest first and reports hasNext', () => {
    const s = make(45);
    expect(s.page(1, 20).items).toHaveLength(20);
    expect(s.page(3, 20)).toMatchObject({ hasNext: false });
    expect(s.page(3, 20).items).toHaveLength(5);
    expect(s.page(9, 20).items).toHaveLength(0);
    expect(s.page(1, 20).items[0].id).toBe('D000045');
  });

  it('generates realistic, valid values', () => {
    for (const l of make(200).active()) {
      expect(l.year).toBeGreaterThanOrEqual(2015);
      expect(l.year).toBeLessThanOrEqual(2026);
      expect(l.km).toBeGreaterThanOrEqual(0);
      expect(l.km).toBeLessThan(400_000);
      expect(l.price).toBeGreaterThanOrEqual(50_000);
      expect(l.price % 1000).toBe(0);
    }
  });

  it('injects a discounted listing priced below fair value', () => {
    const s = make();
    const l = s.inject({ make: 'BMW', model: '3 Serisi', trim: '320i', year: 2020, km: 60_000, discount: 0.25 });
    const m = CATALOG.find((c) => c.make === 'BMW')!;
    expect(l.price).toBe(Math.round((fairPrice(m, 2020, 60_000, 2026) * 0.75) / 1000) * 1000);
    expect(l.isOpportunity).toBe(true);
    expect(s.page(1, 20).items[0].id).toBe(l.id);
  });

  it('patches price/status and tick() mutates the market', () => {
    const s = make(300);
    const first = s.active()[0];
    s.patch(first.id, { price: 500_000 });
    expect(s.get(first.id)?.price).toBe(500_000);
    s.patch(first.id, { status: 'REMOVED' });
    expect(s.active().some((l) => l.id === first.id)).toBe(false);
    const before = s.active().length;
    const summary = s.tick();
    expect(summary.added).toHaveLength(5);
    expect(s.active().length).toBe(before + 5 - summary.removed.length + summary.relisted.length);
  });

  it('tick() is deterministic for the same seed', () => {
    const a = make(100);
    const b = make(100);
    const sa = [a.tick(), a.tick(), a.tick()];
    const sb = [b.tick(), b.tick(), b.tick()];
    expect(sa).toEqual(sb);
  });

  it('eventually relists a removed listing through tick()', () => {
    const s = make(100);
    const id = s.active()[0].id;
    s.patch(id, { status: 'REMOVED' });
    let relisted = false;
    for (let i = 0; i < 100 && !relisted; i++) relisted = s.tick().relisted.includes(id);
    expect(relisted).toBe(true);
    expect(s.get(id)?.status).toBe('ACTIVE');
    expect(s.active().some((l) => l.id === id)).toBe(true);
  });

  it('price drops lower the price to a multiple of 1000', () => {
    const s = make(300);
    let drops = 0;
    for (let i = 0; i < 20; i++) {
      const before = new Map(s.active().map((l) => [l.id, l.price]));
      const summary = s.tick();
      for (const id of summary.priceDropped) {
        drops++;
        const now = s.get(id)!.price;
        expect(now).toBeLessThan(before.get(id)!);
        expect(now % 1000).toBe(0);
      }
    }
    expect(drops).toBeGreaterThan(0);
  });

  it('never prices below the 50_000 TL floor, even with an extreme discount', () => {
    const s = make();
    const l = s.inject({ discount: 5 });
    expect(l.price).toBeGreaterThanOrEqual(50_000);
    expect(l.price % 1000).toBe(0);
  });
});
