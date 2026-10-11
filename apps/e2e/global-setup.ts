import type { FullConfig } from '@playwright/test';
import { CLUSTERS } from './support/clusters';
import { analyzedCount, closeDb, db, demoSource } from './support/db';
import { injectComparables } from './support/demo';
import { PORTS } from './support/env';
import { FakeTelegram, fakeBotToken } from './support/fake-telegram';
import {
  assertPortsFree,
  buildWeb,
  DEMO_SIZE,
  ensureInfra,
  flushRedis,
  generateSecrets,
  killAll,
  logTail,
  resetDatabase,
  startProcesses,
  waitFor,
  waitReady,
} from './support/stack';

declare global {
  var __otoFakeTelegram: FakeTelegram | undefined;
}

function step(name: string, started: number): void {
  console.log(`[e2e] ${name} (${((Date.now() - started) / 1000).toFixed(1)} sn)`);
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const t0 = Date.now();
  // Önceki yarıda kalmış koşunun süreçleri (pid dosyası) temizlenir.
  killAll();
  // Kurulum yarıda kalırsa bile süreç bırakılmaz.
  process.once('exit', killAll);
  try {
    await ensureInfra();
    await assertPortsFree();
    step('altyapı hazır', t0);

    const build = buildWeb();
    step(`${build.rebuilt ? 'web e2e derlemesi (API_ORIGIN=:3101) yapıldı' : 'web e2e derlemesi güncel, yeniden kullanıldı'}; kaynak: ${build.source}`, t0);

    const secrets = generateSecrets(fakeBotToken());
    resetDatabase(secrets);
    await flushRedis();
    // Hızlı döngü: kaynak 10 sn'de bir taranır, istekler arası 20 ms.
    await db().dataSource.update({ where: { code: 'demo-site' }, data: { intervalSec: 10, minRequestGapMs: 20 } });
    process.env.E2E_ADMIN_EMAIL = secrets.adminEmail;
    process.env.E2E_ADMIN_PASSWORD = secrets.adminPassword;
    step('oto_e2e sıfırlandı + seed, redis db 14 boşaltıldı', t0);

    const tg = new FakeTelegram(secrets.botToken);
    await tg.start(PORTS.telegram);
    globalThis.__otoFakeTelegram = tg;

    startProcesses(secrets);
    await waitReady();
    step('süreçler hazır (api /health/ready, web 200)', t0);

    const source = await demoSource();
    await waitFor(
      `ilk tarama (${DEMO_SIZE} ilan) ve analizler`,
      async () => {
        const [listings, pending] = await Promise.all([
          db().listing.count({ where: { sourceId: source.id } }),
          db().listing.count({ where: { sourceId: source.id, latestAnalysisId: null } }),
        ]);
        return listings >= DEMO_SIZE && pending === 0;
      },
      180_000,
      () => `${logTail('worker')}\n--- scheduler ---\n${logTail('scheduler')}`,
    );
    step('ilk tarama ve analizler tamam', t0);

    const ids = [...(await injectComparables(CLUSTERS.user)), ...(await injectComparables(CLUSTERS.admin))];
    await waitFor('emsal kümeleri analizi', async () => (await analyzedCount(ids)) === ids.length, 120_000, () => logTail('worker'));
    step('emsal kümeleri hazır', t0);

    // Isınma bitti: bundan sonra her tarama yalnızca en yeni 2 sayfayı okur (enjekte edilen ilanlar en üstte).
    // Döngü başına iş ~%85 azalır; paylaşılan/yüklü makinede bildirim gecikmesi 60 sn sınırının altında kalır.
    // Eksik tarama (isLast yok) kaldırma tespitini atlar; senaryolar kaldırmaya dayanmaz.
    await db().dataSource.update({ where: { code: 'demo-site' }, data: { config: { baseUrl: (source.config as { baseUrl: string }).baseUrl, maxPages: 2 } } });
  } catch (err) {
    await globalThis.__otoFakeTelegram?.close();
    killAll();
    throw err;
  } finally {
    await closeDb();
  }
}
