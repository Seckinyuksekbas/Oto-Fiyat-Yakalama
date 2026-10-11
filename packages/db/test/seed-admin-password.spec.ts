import { describe, expect, it } from 'vitest';
import { assertSeedAdminPassword } from '../src/seed-data';

// Parola literal'i yazılmaz: değerler çalışma anında üretilir.
const of = (n: number, ch = 'a') => ch.repeat(n);

describe('assertSeedAdminPassword', () => {
  it('rejects template placeholders (< or >) in production without echoing the value', () => {
    const placeholder = `<${of(20)}>`;
    for (const pw of [placeholder, `${of(12)}<`, `${of(12)}>`]) {
      let message = '';
      try {
        assertSeedAdminPassword(pw, 'production');
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/SEED_ADMIN_PASSWORD/);
      expect(message).toMatch(/yer tutucu/);
      expect(message).not.toContain(pw);
    }
  });

  it('requires at least 12 characters in production', () => {
    expect(() => assertSeedAdminPassword(of(11), 'production')).toThrow(/SEED_ADMIN_PASSWORD.*12/);
    expect(() => assertSeedAdminPassword(of(12), 'production')).not.toThrow();
  });

  it('keeps the 10 character minimum outside production', () => {
    expect(() => assertSeedAdminPassword(of(9), 'development')).toThrow(/SEED_ADMIN_PASSWORD.*10/);
    expect(() => assertSeedAdminPassword(of(10), 'development')).not.toThrow();
    expect(() => assertSeedAdminPassword(`<${of(10)}>`, undefined)).not.toThrow();
  });
});
