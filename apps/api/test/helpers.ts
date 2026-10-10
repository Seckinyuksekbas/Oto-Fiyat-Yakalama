import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { truncateAll } from '@oto/testing';
import { seedPlans, type Role } from '@oto/db';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { MailService } from '../src/modules/mail/mail.service';

export async function createTestApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app);
  await app.init();
  return app;
}

export async function resetState(app: NestExpressApplication): Promise<void> {
  const prisma = app.get(PrismaService);
  await truncateAll(prisma);
  await app.get(RedisService).flushdb();
  await seedPlans(prisma);
  app.get(MailService).outbox.length = 0;
}

export function newAgent(app: NestExpressApplication): TestAgent {
  return request.agent(app.getHttpServer()).set('X-Requested-With', 'XMLHttpRequest');
}

let userSeq = 0;
export async function registerUser(
  app: NestExpressApplication,
  overrides: Partial<{ email: string; password: string; name: string }> = {},
) {
  userSeq += 1;
  const email = overrides.email ?? `user${userSeq}@test.com`;
  const password = overrides.password ?? 'a-very-strong-pass';
  const agent = newAgent(app);
  const res = await agent
    .post('/api/v1/auth/register')
    .send({ email, password, name: overrides.name ?? `Kullanıcı ${userSeq}`, kvkkAccepted: true });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, user: res.body.user as { id: string; email: string; role: string }, email, password };
}

export function cookieFrom(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const hit = raw?.find((c) => c.startsWith(`${name}=`));
  const value = hit?.split(';')[0].slice(name.length + 1);
  return value ? value : undefined;
}

export function tokenFromMail(text: string): string {
  const m = text.match(/token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`no token in mail: ${text}`);
  return m[1];
}

export async function setRole(app: NestExpressApplication, userId: string, role: Role): Promise<void> {
  await app.get(PrismaService).user.update({ where: { id: userId }, data: { role } });
}
