import type { TestingModule } from '@nestjs/testing';
import { parseSettingValue } from '@oto/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnalysisModule } from '../src/analysis/analysis.module';
import { ANALYSIS_SETTINGS_KEY, AnalysisSettingsService, SETTINGS_CHANGED_CHANNEL } from '../src/analysis/analysis-settings.service';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { createContext, resetState } from './helpers';

// Review Focus 2: API'nin kaydettiği biçimdeki (kısmi, parseSettingValue ile doğrulanmış) değer + `settings:changed` yayını,
// çalışan bir worker'ın AnalysisSettingsService'inde 60 sn TTL beklenmeden ~2 sn içinde etkili olur.
let ref: TestingModule;
let prisma: PrismaService;

beforeAll(async () => {
  ref = await createContext([AnalysisModule]);
  prisma = ref.get(PrismaService);
});
afterAll(async () => {
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
  ref.get(AnalysisSettingsService).invalidate();
});

const pollUntil = async (fn: () => Promise<boolean>, ms: number) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

describe('settings propagation API -> worker', () => {
  it('a committed setting + settings:changed publish is visible to the worker within 2s', async () => {
    const settings = ref.get(AnalysisSettingsService);
    expect(SETTINGS_CHANGED_CHANNEL).toBe('settings:changed'); // API ile aynı kanal adı
    const before = await settings.get();
    expect(before.minComparables).toBe(5);

    const stored = parseSettingValue(ANALYSIS_SETTINGS_KEY, { minComparables: 6, smallPoolMax: 9 });
    if (!stored.ok) throw new Error('fixture invalid');
    await prisma.systemSetting.create({ data: { key: ANALYSIS_SETTINGS_KEY, value: stored.value as object } });
    expect((await settings.get()).minComparables).toBe(5); // önbellekte: yayın olmadan TTL dolana dek eski değer

    const t0 = Date.now();
    await ref.get(RedisService).publish(SETTINGS_CHANGED_CHANNEL, ANALYSIS_SETTINGS_KEY);
    expect(await pollUntil(async () => (await settings.get()).minComparables === 6, 2000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await settings.get()).toMatchObject({ minComparables: 6, smallPoolMax: 9, theilSenMinPool: 8 });
  });
});
