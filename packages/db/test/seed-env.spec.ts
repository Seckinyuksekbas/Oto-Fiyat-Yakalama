import { describe, expect, it } from 'vitest';
import { assertSeedEnv } from '../prisma/seed-env';

describe('assertSeedEnv', () => {
  it('refuses to seed the demo source in production', () => {
    expect(() => assertSeedEnv({ NODE_ENV: 'production', SEED_DEMO_SOURCE: 'true' })).toThrow(/SEED_DEMO_SOURCE/);
  });

  it('allows production without the demo source', () => {
    expect(() => assertSeedEnv({ NODE_ENV: 'production' })).not.toThrow();
    expect(() => assertSeedEnv({ NODE_ENV: 'production', SEED_DEMO_SOURCE: 'false' })).not.toThrow();
  });

  it('allows the demo source outside production', () => {
    expect(() => assertSeedEnv({ NODE_ENV: 'development', SEED_DEMO_SOURCE: 'true' })).not.toThrow();
    expect(() => assertSeedEnv({ SEED_DEMO_SOURCE: 'true' })).not.toThrow();
  });
});
