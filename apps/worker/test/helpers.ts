import type { DynamicModule, Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { seedMakeModelAliases } from '@oto/db';
import { truncateAll } from '@oto/testing';
import { CoreModule } from '../src/core.module';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';

export async function createContext(imports: (Type<unknown> | DynamicModule)[] = []): Promise<TestingModule> {
  const ref = await Test.createTestingModule({ imports: [CoreModule, ...imports] }).compile();
  await ref.init();
  return ref;
}

export async function resetState(ref: TestingModule): Promise<void> {
  const prisma = ref.get(PrismaService);
  await truncateAll(prisma);
  await ref.get(RedisService).flushdb();
  await seedMakeModelAliases(prisma);
}

export async function createAdmin(ref: TestingModule, status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  return ref.get(PrismaService).user.create({
    data: { email: `admin-${Math.random().toString(36).slice(2)}@test.com`, name: 'Admin', passwordHash: 'x', role: 'ADMIN', status },
  });
}
