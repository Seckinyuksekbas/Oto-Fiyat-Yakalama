import { CATALOG } from './catalog';
import { clampDiscount, fairPrice, generateListing, MIN_PRICE, mulberry32, roundPrice, type DemoListing, type Rng } from './generator';

export interface StoreOptions {
  seed: number;
  size: number;
  currentYear?: number;
  now?: () => number;
}

export type InjectInput = Partial<Omit<DemoListing, 'id' | 'createdAt' | 'status' | 'isOpportunity'>> & { discount?: number };

export interface TickSummary {
  added: string[];
  priceDropped: string[];
  removed: string[];
  relisted: string[];
}

export class DemoStore {
  private rng: Rng = mulberry32(0);
  private readonly listings = new Map<string, DemoListing>();
  private seq = 0;
  private readonly currentYear: number;
  private readonly now: () => number;

  constructor(opts: StoreOptions) {
    this.currentYear = opts.currentYear ?? new Date().getFullYear();
    this.now = opts.now ?? Date.now;
    this.reset(opts.seed, opts.size);
  }

  reset(seed: number, size: number): void {
    this.rng = mulberry32(seed);
    this.listings.clear();
    this.seq = 0;
    const base = this.now();
    for (let i = 0; i < size; i++) this.add(base - (size - i) * 1000);
  }

  active(): DemoListing[] {
    return [...this.listings.values()]
      .filter((l) => l.status === 'ACTIVE')
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }

  page(n: number, size = 20): { items: DemoListing[]; hasNext: boolean } {
    const all = this.active();
    const start = (n - 1) * size;
    return { items: all.slice(start, start + size), hasNext: start + size < all.length };
  }

  get(id: string): DemoListing | undefined {
    return this.listings.get(id);
  }

  inject(input: InjectInput): DemoListing {
    const { discount: rawDiscount, ...overrides } = input;
    const discount = rawDiscount === undefined ? undefined : clampDiscount(rawDiscount);
    const listing = this.add(this.now(), discount);
    Object.assign(listing, overrides);
    if (discount !== undefined && overrides.price === undefined) {
      const model = CATALOG.find((c) => c.make === listing.make && c.model === listing.model);
      if (model) {
        listing.price = Math.max(MIN_PRICE, roundPrice(fairPrice(model, listing.year, listing.km, this.currentYear) * (1 - discount)));
      }
    }
    return listing;
  }

  patch(id: string, change: { price?: number; status?: 'ACTIVE' | 'REMOVED' }): DemoListing | undefined {
    const listing = this.listings.get(id);
    if (!listing) return undefined;
    if (change.price !== undefined) listing.price = change.price;
    if (change.status !== undefined) listing.status = change.status;
    return listing;
  }

  /** Piyasayı bir adım ilerletir: %1 kaldırma, %2 fiyat düşüşü, kaldırılanların %10'u geri gelir, 5 yeni ilan (%3 fırsat). */
  tick(): TickSummary {
    const now = this.now();
    const summary: TickSummary = { added: [], priceDropped: [], removed: [], relisted: [] };
    const removedBefore = [...this.listings.values()].filter((l) => l.status === 'REMOVED');
    for (const l of this.active()) {
      const r = this.rng();
      if (r < 0.01) {
        l.status = 'REMOVED';
        summary.removed.push(l.id);
      } else if (r < 0.03) {
        const next = Math.max(MIN_PRICE, roundPrice(l.price * (0.9 + this.rng() * 0.07)));
        if (next < l.price) {
          l.price = next;
          summary.priceDropped.push(l.id);
        }
      }
    }
    for (const l of removedBefore) {
      if (this.rng() < 0.1) {
        l.status = 'ACTIVE';
        summary.relisted.push(l.id);
      }
    }
    for (let i = 0; i < 5; i++) {
      const opportunity = this.rng() < 0.03;
      summary.added.push(this.add(now + i, opportunity ? 0.15 + this.rng() * 0.15 : undefined).id);
    }
    return summary;
  }

  private add(createdAt: number, discount?: number): DemoListing {
    this.seq += 1;
    const id = `D${String(this.seq).padStart(6, '0')}`;
    const listing = generateListing(this.rng, id, createdAt, this.currentYear, discount);
    this.listings.set(id, listing);
    return listing;
  }
}
