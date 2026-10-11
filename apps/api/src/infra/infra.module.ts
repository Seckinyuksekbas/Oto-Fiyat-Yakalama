import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';
import { UserEventsService } from './user-events.service';

@Global()
@Module({
  providers: [PrismaService, RedisService, UserEventsService],
  exports: [PrismaService, RedisService, UserEventsService],
})
export class InfraModule {}
