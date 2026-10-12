import { PrismaClient } from '@oto/db';
import { DATABASE_URL } from './env';

/** E2E veritabanına (oto_e2e) doğrudan erişim: yalnızca kurulum ve "hazır mı" beklemeleri için. */
let client: PrismaClient | undefined;
export function db(): PrismaClient {
  client ??= new PrismaClient({ datasourceUrl: DATABASE_URL });
  return client;
}

export async function closeDb(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}

export async function demoSource() {
  return db().dataSource.findUniqueOrThrow({ where: { code: 'demo-site' } });
}

/** Demo ilan kimliklerinin (externalId) tümü ingest edilip analiz edildi mi? */
export async function analyzedCount(externalIds: string[]): Promise<number> {
  return db().listing.count({ where: { externalId: { in: externalIds }, latestAnalysisId: { not: null } } });
}

export async function listingByExternalId(externalId: string) {
  return db().listing.findFirst({ where: { externalId }, include: { latestAnalysis: true } });
}
