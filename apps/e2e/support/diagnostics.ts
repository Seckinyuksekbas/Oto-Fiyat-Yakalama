import type { TestInfo } from '@playwright/test';
import { redactSecrets } from '@oto/server-common';
import { db } from './db';
import { logTail } from './stack';

/** Başarısız testte yığın durumunu ekler: son tarama işleri, bildirimler ve worker/scheduler log kuyrukları. */
export async function attachDiagnostics(testInfo: TestInfo): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
  const jobs = await db()
    .collectionJob.findMany({ orderBy: { id: 'desc' }, take: 15 })
    .catch((e: unknown) => String(e));
  const notifications = await db()
    .notification.findMany({ where: { kind: 'MATCH' }, orderBy: { id: 'desc' }, take: 15, select: { id: true, userId: true, channel: true, status: true, lastError: true, createdAt: true } })
    .catch((e: unknown) => String(e));
  await testInfo.attach('collection-jobs.json', { body: json(jobs), contentType: 'application/json' });
  await testInfo.attach('match-notifications.json', { body: json(notifications), contentType: 'application/json' });
  for (const name of ['worker', 'scheduler', 'api']) {
    // Log kuyrukları eklenmeden önce maskelenir (URL kimlik bilgileri, token'lar).
    await testInfo.attach(`${name}.log`, { body: redactSecrets(logTail(name, 80)), contentType: 'text/plain' });
  }
}
