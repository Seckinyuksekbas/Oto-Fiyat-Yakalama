import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Plan 08 Task 6 veri göçü: Plan 07'de yöneticinin duraklattığı (isActive=false + health=PAUSED) kaynaklar, son
 * duraklat/etkinleştir denetim satırı `source.pause` ise ve o andan sonra hata görülmemişse, duraklatma öncesi
 * sağlığa döner. Engel kaynaklı PAUSED'a dokunulmaz. Göç tüm satırları koşulla seçtiği için yeniden çalıştırmak
 * güvenlidir; test önce şemayı kurar, sonra senaryo satırlarını ekleyip göç SQL'ini yeniden çalıştırır.
 */
const MIGRATION = join(process.cwd(), 'prisma', 'migrations', '20261019000000_admin_pause_health_restore', 'migration.sql');

let pg: StartedPostgreSqlContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  const url = pg.getConnectionUri();
  execSync('pnpm exec prisma migrate deploy', { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
  prisma = new PrismaClient({ datasources: { db: { url } } });
});
afterAll(async () => {
  await prisma?.$disconnect();
  await pg?.stop();
});

let seq = 0;
async function source(data: Partial<Prisma.DataSourceCreateInput>) {
  return prisma.dataSource.create({
    data: { code: `s-${++seq}`, name: 'S', adapterKey: 'demo-site', kind: 'HTTP', permissionType: 'TEST', permissionVerifiedAt: t(0), ...data },
  });
}
const t = (min: number) => new Date(Date.UTC(2026, 9, 1, 12, min));
async function audit(sourceId: number, action: string, before: object, at: Date) {
  await prisma.auditLog.create({ data: { action, targetType: 'DataSource', targetId: String(sourceId), before, after: {}, createdAt: at } });
}

describe('20261019000000_admin_pause_health_restore', () => {
  it('restores pre-pause health only for admin pauses (last toggle = source.pause, no later error); leaves block PAUSED alone', async () => {
    // 1) Plan 07 yönetici duraklatması (HEALTHY idi) → HEALTHY
    const adminHealthy = await source({ isActive: false, health: 'PAUSED' });
    await audit(adminHealthy.id, 'source.activate', { isActive: false, health: 'HEALTHY' }, t(1));
    await audit(adminHealthy.id, 'source.pause', { isActive: true, health: 'HEALTHY' }, t(2));
    // 2) DOWN iken duraklatılmış → DOWN
    const adminDown = await source({ isActive: false, health: 'PAUSED', consecutiveFailures: 7, lastErrorAt: t(0) });
    await audit(adminDown.id, 'source.pause', { isActive: true, health: 'DOWN' }, t(3));
    // 3) Engel (etkin, PAUSED) → dokunulmaz
    const blocked = await source({ isActive: true, health: 'PAUSED' });
    await audit(blocked.id, 'source.pause', { isActive: true, health: 'HEALTHY' }, t(1));
    await audit(blocked.id, 'source.activate', { isActive: false, health: 'PAUSED' }, t(2));
    // 4) Engelli kaynağı yönetici duraklattı (before.health=PAUSED) → dokunulmaz
    const blockedThenPaused = await source({ isActive: false, health: 'PAUSED' });
    await audit(blockedThenPaused.id, 'source.pause', { isActive: true, health: 'PAUSED' }, t(4));
    // 5) Duraklatmadan sonra hata (uçuştaki iş engellendi olabilir) → dokunulmaz
    const errorAfter = await source({ isActive: false, health: 'PAUSED', lastErrorAt: t(9) });
    await audit(errorAfter.id, 'source.pause', { isActive: true, health: 'HEALTHY' }, t(5));
    // 6) Denetim satırı yok (ör. seed / elle) → dokunulmaz
    const noAudit = await source({ isActive: false, health: 'PAUSED' });
    // 7) Son geçiş activate (sonra engel) ama isActive=false (izin geri alındı) → dokunulmaz
    const lastActivate = await source({ isActive: false, health: 'PAUSED' });
    await audit(lastActivate.id, 'source.pause', { isActive: true, health: 'HEALTHY' }, t(1));
    await audit(lastActivate.id, 'source.activate', { isActive: false, health: 'PAUSED' }, t(2));

    await prisma.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));

    const health = async (id: number) => (await prisma.dataSource.findUniqueOrThrow({ where: { id } })).health;
    expect(await health(adminHealthy.id)).toBe('HEALTHY');
    expect(await health(adminDown.id)).toBe('DOWN');
    expect(await health(blocked.id)).toBe('PAUSED');
    expect(await health(blockedThenPaused.id)).toBe('PAUSED');
    expect(await health(errorAfter.id)).toBe('PAUSED');
    expect(await health(noAudit.id)).toBe('PAUSED');
    expect(await health(lastActivate.id)).toBe('PAUSED');
    // isActive değişmez
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: adminHealthy.id } })).isActive).toBe(false);
  });
});
