import { Global, Module } from '@nestjs/common';
import { AdminQueues } from './admin-queues.service';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';
import { DEFAULT_SSE_RECHECK_MS, SSE_RECHECK_MS, StreamSessionService } from './stream-session.service';
import { UserEventsService } from './user-events.service';

@Global()
@Module({
  providers: [PrismaService, RedisService, UserEventsService, AdminQueues, StreamSessionService, { provide: SSE_RECHECK_MS, useValue: DEFAULT_SSE_RECHECK_MS }],
  exports: [PrismaService, RedisService, UserEventsService, AdminQueues, StreamSessionService, SSE_RECHECK_MS],
})
export class InfraModule {}
