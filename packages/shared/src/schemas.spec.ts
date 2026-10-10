import { describe, expect, it } from 'vitest';
import {
  adminUsersQuerySchema,
  confidenceAtLeast,
  createSearchProfileSchema,
  effectiveLimits,
  listMatchesQuerySchema,
  loginSchema,
  previewSearchProfileSchema,
  registerSchema,
  updateMeSchema,
  updateSearchProfileSchema,
  withProfileDefaults,
} from './index';

describe('registerSchema', () => {
  const valid = { email: 'user@example.com', password: 'a-strong-pass', name: 'Ali', kvkkAccepted: true };

  it('trims and lowercases the email', () => {
    const r = registerSchema.parse({ ...valid, email: '  User@Example.COM ' });
    expect(r.email).toBe('user@example.com');
  });

  it('requires kvkkAccepted to be exactly true', () => {
    expect(registerSchema.safeParse({ ...valid, kvkkAccepted: false }).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(registerSchema.safeParse({ ...valid, role: 'SUPER_ADMIN' }).success).toBe(false);
  });

  it('enforces password length 10..128', () => {
    expect(registerSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, password: 'x'.repeat(129) }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, password: 'x'.repeat(128) }).success).toBe(true);
  });

  it('rejects names longer than 80 chars', () => {
    expect(registerSchema.safeParse({ ...valid, name: 'a'.repeat(10_000) }).success).toBe(false);
  });
});

describe('loginSchema', () => {
  it('caps password at 128 chars so argon2 never sees huge input', () => {
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'x'.repeat(129) }).success).toBe(false);
  });
});

describe('updateMeSchema', () => {
  it('trims the name and rejects blank', () => {
    expect(updateMeSchema.parse({ name: '  Ayşe  ' }).name).toBe('Ayşe');
    expect(updateMeSchema.safeParse({ name: '   ' }).success).toBe(false);
  });
});

describe('adminUsersQuerySchema', () => {
  it('coerces paging and applies defaults', () => {
    expect(adminUsersQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(adminUsersQuerySchema.parse({ page: '2', pageSize: '50' })).toEqual({ page: 2, pageSize: 50 });
  });

  it('rejects pageSize above 100', () => {
    expect(adminUsersQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
  });
});

describe('search profile schemas', () => {
  const base = { name: 'BMW fırsat' };

  it('accepts a minimal profile and applies defaults', () => {
    const p = withProfileDefaults(createSearchProfileSchema.parse(base));
    expect(p).toMatchObject({
      name: 'BMW fırsat', make: null, model: null, yearMin: null, priceMin: null, fuels: [], cities: [],
      minDiscountPct: 0, minConfidence: 'MEDIUM', excludeDamaged: false, notifyOnPriceDrop: true,
      priceDropPct: 0.05, notifyOnRelist: false, channels: ['IN_APP'],
    });
  });

  it('always includes IN_APP once and dedupes cities', () => {
    const p = withProfileDefaults(createSearchProfileSchema.parse({ ...base, channels: ['TELEGRAM', 'TELEGRAM'], cities: [' İstanbul ', 'İstanbul', 'Ankara'] }));
    expect(p.channels).toEqual(['IN_APP', 'TELEGRAM']);
    expect(p.cities).toEqual(['İstanbul', 'Ankara']);
  });

  it('rejects EMAIL channel, unknown fields, bad money and >4 decimals', () => {
    expect(createSearchProfileSchema.safeParse({ ...base, channels: ['EMAIL'] }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, foo: 1 }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, priceMax: 1000 }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, priceMax: '-5' }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, minDiscountPct: 0.12345 }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, minDiscountPct: 0.95 }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, priceDropPct: 0 }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, minConfidence: 'INSUFFICIENT' }).success).toBe(false);
  });

  it('enforces cross-field consistency', () => {
    expect(createSearchProfileSchema.safeParse({ ...base, model: '3 Serisi' }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, yearMin: 2020, yearMax: 2018 }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, priceMin: '900000', priceMax: '100000' }).success).toBe(false);
    expect(createSearchProfileSchema.safeParse({ ...base, priceMin: '99', priceMax: '100' }).success).toBe(true);
  });

  it('update requires at least one field and stays strict', () => {
    expect(updateSearchProfileSchema.safeParse({}).success).toBe(false);
    expect(updateSearchProfileSchema.safeParse({ name: 'x' }).success).toBe(true);
    expect(updateSearchProfileSchema.safeParse({ userId: 'x' }).success).toBe(false);
  });

  it('preview accepts only filter fields', () => {
    expect(previewSearchProfileSchema.safeParse({ make: 'BMW', minDiscountPct: 0.1 }).success).toBe(true);
    expect(previewSearchProfileSchema.safeParse({ name: 'x' }).success).toBe(false);
  });

  it('list matches query coerces and bounds', () => {
    expect(listMatchesQuerySchema.parse({ limit: '50', minScore: '60', cursor: '10' })).toMatchObject({ limit: 50, minScore: 60, cursor: 10 });
    expect(listMatchesQuerySchema.parse({}).limit).toBe(20);
    expect(listMatchesQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listMatchesQuerySchema.safeParse({ sort: 'score' }).success).toBe(false);
  });

  it('confidenceAtLeast', () => {
    expect(confidenceAtLeast('MEDIUM')).toEqual(['MEDIUM', 'HIGH']);
    expect(confidenceAtLeast('INSUFFICIENT')).toEqual(['INSUFFICIENT', 'LOW', 'MEDIUM', 'HIGH']);
  });
});

describe('effectiveLimits', () => {
  const plan = { maxSearchProfiles: 2, maxNotificationsPerDay: 20, channels: ['IN_APP', 'TELEGRAM'] as ('IN_APP' | 'TELEGRAM' | 'EMAIL')[], opportunitiesDelayHours: 0 };
  it('applies valid overrides and ignores invalid ones', () => {
    expect(effectiveLimits(plan, { maxSearchProfiles: 5 }).maxSearchProfiles).toBe(5);
    expect(effectiveLimits(plan, null)).toEqual(plan);
    expect(effectiveLimits(plan, { maxSearchProfiles: -1 })).toEqual(plan);
    expect(effectiveLimits(plan, 'garbage')).toEqual(plan);
  });
});
