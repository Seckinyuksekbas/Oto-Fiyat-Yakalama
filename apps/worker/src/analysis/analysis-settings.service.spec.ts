import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../infra/prisma.service';
import type { RedisService } from '../infra/redis.service';
import { ANALYSIS_SETTINGS_KEY, AnalysisSettingsService } from './analysis-settings.service';

describe('AnalysisSettingsService invalidation race', () => {
  it('does not cache a read that was in flight when invalidate() ran', async () => {
    let value: unknown = { minComparables: 20 };
    let release!: () => void;
    let gate = new Promise<void>((r) => (release = r));
    let reads = 0;
    const prisma = {
      systemSetting: {
        findUnique: async () => {
          reads += 1;
          const snapshot = { key: ANALYSIS_SETTINGS_KEY, value }; // DB okuması başlamadan önceki (bayat) değer
          await gate;
          return snapshot;
        },
      },
    } as unknown as PrismaService;
    const svc = new AnalysisSettingsService(prisma, {} as RedisService);

    const inflight = svc.get(); // eski değeri okur ve bekler
    value = { minComparables: 7 }; // API ayarı değiştirdi
    svc.invalidate(); // settings:changed geldi
    release();
    expect((await inflight).minComparables).toBe(20); // uçuştaki çağrı eski değeri döner...
    gate = Promise.resolve();
    expect((await svc.get()).minComparables).toBe(7); // ...ama önbelleğe yazılmadı; sonraki okuma yeni değeri görür
    expect(reads).toBe(2);
  });
});

describe('AnalysisSettingsService subscription', () => {
  it('re-subscribes on ready when the initial subscribe failed, and invalidates', async () => {
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    let calls = 0;
    const sub = {
      on: (ev: string, fn: (...a: unknown[]) => void) => { handlers[ev] = fn; return sub; },
      subscribe: async () => { calls += 1; if (calls === 1) throw new Error('not connected'); return 1; },
      quit: async () => 'OK',
    };
    const svc = new AnalysisSettingsService({} as PrismaService, { duplicate: () => sub } as unknown as RedisService);
    await svc.onModuleInit();
    expect(calls).toBe(1);
    handlers.ready();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2);
    handlers.ready(); // abone olduktan sonra tekrar denemez
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2);
  });
});
