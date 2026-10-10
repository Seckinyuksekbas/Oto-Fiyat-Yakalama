import { describe, expect, it } from 'vitest';
import { adminUsersQuerySchema, loginSchema, registerSchema, updateMeSchema } from './index';

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
