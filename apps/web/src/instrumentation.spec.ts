import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from './instrumentation';

afterEach(() => vi.unstubAllEnvs());

describe('instrumentation register', () => {
  it('fails server start on an invalid API_ORIGIN in the Node runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('API_ORIGIN', 'not a url');
    await expect(register()).rejects.toThrow(/API_ORIGIN/);
  });

  it('accepts a valid API_ORIGIN', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('API_ORIGIN', 'http://api:3001');
    await expect(register()).resolves.toBeUndefined();
  });

  it('skips the check outside the Node runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    vi.stubEnv('API_ORIGIN', 'not a url');
    await expect(register()).resolves.toBeUndefined();
  });
});
