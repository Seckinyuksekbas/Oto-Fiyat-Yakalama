import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { truncateAll } from '@oto/testing';
import { seedPlans, type Notification, type Role } from '@oto/db';
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

export async function verifyEmail(app: NestExpressApplication, userId: string): Promise<void> {
  await app.get(PrismaService).user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
}

let listingSeq = 0;
/** Demo kaynağı (yoksa) + ilan + analiz (latestAnalysisId bağlı) */
export async function seedListing(
  app: NestExpressApplication,
  over: { listing?: Record<string, unknown>; analysis?: Record<string, unknown> } = {},
): Promise<{ listingId: number; analysisId: number }> {
  const prisma = app.get(PrismaService);
  const source =
    (await prisma.dataSource.findUnique({ where: { code: 'test-src' } })) ??
    (await prisma.dataSource.create({ data: { code: 'test-src', name: 'T', adapterKey: 'demo', kind: 'HTTP', permissionType: 'TEST' } }));
  listingSeq += 1;
  const l = await prisma.listing.create({
    data: {
      sourceId: source.id, externalId: `A${listingSeq}`, url: `http://demo/${listingSeq}`, title: `İlan ${listingSeq}`,
      make: 'BMW', model: '3 Serisi', year: 2019, km: 85_000, fuel: 'GASOLINE', transmission: 'AUTOMATIC', city: 'İstanbul',
      price: 960_000n, contentHash: `h${listingSeq}`, ...over.listing,
    },
  });
  const a = await prisma.listingAnalysis.create({
    data: {
      listingId: l.id, engineVersion: 'rules-v1', estimatedPrice: 1_200_000n, priceDiff: 240_000n, discountPct: 0.2,
      opportunityScore: 77, comparableCount: 14, confidence: 'HIGH', flags: [], explanation: {}, comparableIds: [],
      listingPrice: l.price, ...over.analysis,
    },
  });
  await prisma.listing.update({ where: { id: l.id }, data: { latestAnalysisId: a.id } });
  return { listingId: l.id, analysisId: a.id };
}

export async function seedMatch(
  app: NestExpressApplication,
  userId: string,
  profileId: string,
  over: { listing?: Record<string, unknown>; analysis?: Record<string, unknown>; reason?: 'NEW' | 'PRICE_DROP' | 'RELIST' } = {},
): Promise<number> {
  const { listingId, analysisId } = await seedListing(app, over);
  const m = await app.get(PrismaService).listingMatch.create({
    data: { userId, searchProfileId: profileId, listingId, analysisId, reason: over.reason ?? 'NEW', matchedPrice: 960_000n },
  });
  return m.id;
}

/** Giriş yapıp tüm çerezleri `Cookie` başlığı biçiminde döndürür (ham HTTP/SSE istemcileri için). */
export async function loginCookie(app: NestExpressApplication, email: string, password: string): Promise<string> {
  const res = await newAgent(app).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const raw = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  return raw.map((c) => c.split(';')[0]).join('; ');
}

export async function seedNotification(
  app: NestExpressApplication,
  userId: string,
  over: Partial<{
    kind: 'MATCH' | 'SECURITY' | 'SYSTEM_ALERT';
    channel: 'IN_APP' | 'TELEGRAM' | 'EMAIL';
    status: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED_LIMIT';
    lastError: string | null;
    readAt: Date | null;
    payload: Record<string, unknown>;
  }> = {},
): Promise<Notification> {
  return app.get(PrismaService).notification.create({
    data: {
      userId,
      kind: over.kind ?? 'SECURITY',
      channel: over.channel ?? 'IN_APP',
      status: over.status ?? 'SENT',
      lastError: over.lastError ?? null,
      readAt: over.readAt ?? null,
      sentAt: new Date(),
      payload: (over.payload ?? { type: 'TELEGRAM_LINKED' }) as object,
    },
  });
}
