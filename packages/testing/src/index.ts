import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';

export interface TestInfra {
  databaseUrl: string;
  redisUrl: string;
  stop(): Promise<void>;
}

/** Postgres 16 + Redis 7 container'larını başlatır ve tüm Prisma migration'larını uygular. */
export async function startTestInfra(): Promise<TestInfra> {
  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  const stop = async () => {
    await Promise.all([pg.stop(), redis.stop()]);
  };
  try {
    const databaseUrl = pg.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', {
      cwd: resolve(__dirname, '../../db'),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
    return { databaseUrl, redisUrl: redis.getConnectionUrl(), stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

export async function startRedis(): Promise<{ url: string; stop(): Promise<void> }> {
  const redis = await new RedisContainer('redis:7-alpine').start();
  return { url: redis.getConnectionUrl(), stop: async () => void (await redis.stop()) };
}

export interface RawSqlClient {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
  $executeRawUnsafe(query: string): Promise<number>;
}

/** `_prisma_migrations` hariç tüm tabloları boşaltır ve kimlik sayaçlarını sıfırlar. */
export async function truncateAll(db: RawSqlClient): Promise<void> {
  const tables = await db.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (tables.length === 0) return;
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}
