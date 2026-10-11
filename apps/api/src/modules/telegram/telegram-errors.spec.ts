import { Prisma } from '@oto/db';
import { describe, expect, it } from 'vitest';
import { HANDLER_MAX_ATTEMPTS, isTransientDbError } from './telegram-errors';

const known = (code: string) => new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test' });

describe('isTransientDbError', () => {
  it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034'])('%s is transient', (code) => {
    expect(isTransientDbError(known(code))).toBe(true);
  });

  it('connection-level errors are transient', () => {
    expect(isTransientDbError(new Prisma.PrismaClientInitializationError("Can't reach database server", 'test', 'P1001'))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(true);
  });

  it('deterministic errors are permanent', () => {
    expect(isTransientDbError(known('P2002'))).toBe(false);
    expect(isTransientDbError(known('P2025'))).toBe(false);
    expect(isTransientDbError(new Prisma.PrismaClientValidationError('bad arg', { clientVersion: 'test' }))).toBe(false);
    expect(isTransientDbError(new TypeError('undefined is not a function'))).toBe(false);
    expect(isTransientDbError('string')).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
  });

  it('shares one attempt limit', () => {
    expect(HANDLER_MAX_ATTEMPTS).toBe(5);
  });
});
