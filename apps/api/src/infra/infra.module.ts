import { Global, Module } from '@nestjs/common';
import { AdminQueues } from './admin-queues.service';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';
import { UserEventsService } from './user-events.service';

@Global()
@Module({
  providers: [PrismaService, RedisService, UserEventsService, AdminQueues],
  exports: [PrismaService, RedisService, UserEventsService, AdminQueues],
})
export class InfraModule {}
