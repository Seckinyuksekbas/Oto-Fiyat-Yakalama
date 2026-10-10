import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public';
import { PrismaService } from '../../infra/prisma.service';
import { RedisService } from '../../infra/redis.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks = { db: false, redis: false, migrations: false };
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.db = true;
      const [row] = await this.prisma.$queryRaw<{ pending: bigint }[]>`
        SELECT count(*) AS pending FROM "_prisma_migrations"
        WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`;
      checks.migrations = Number(row.pending) === 0;
    } catch {
      // checks zaten false
    }
    try {
      checks.redis = (await this.redis.ping()) === 'PONG';
    } catch {
      // checks.redis zaten false
    }
    const ok = Object.values(checks).every(Boolean);
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', checks };
  }
}
