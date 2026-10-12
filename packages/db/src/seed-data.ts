import type { DataSource, PrismaClient, User } from '@prisma/client';
import type { PlanLimits } from '@oto/shared';
import argon2 from 'argon2';
import { ARGON2_OPTIONS } from './argon2';

// Fiyatlar Aşama 3'te (ödeme entegrasyonu) admin panelinden belirlenir; şimdilik 0.
export const PLAN_SEEDS: { code: string; name: string; priceMonthly: number; limits: PlanLimits }[] = [
  {
    code: 'FREE',
    name: 'Ücretsiz',
    priceMonthly: 0,
    limits: { maxSearchProfiles: 2, maxNotificationsPerDay: 20, channels: ['IN_APP', 'TELEGRAM'], opportunitiesDelayHours: 0 },
  },
  {
    code: 'PRO',
    name: 'Pro',
    priceMonthly: 0,
    limits: { maxSearchProfiles: 10, maxNotificationsPerDay: 200, channels: ['IN_APP', 'TELEGRAM', 'EMAIL'], opportunitiesDelayHours: 0 },
  },
  {
    code: 'BUSINESS',
    name: 'Business',
    priceMonthly: 0,
    limits: { maxSearchProfiles: 50, maxNotificationsPerDay: 2000, channels: ['IN_APP', 'TELEGRAM', 'EMAIL'], opportunitiesDelayHours: 0 },
  },
];

export async function seedPlans(prisma: PrismaClient): Promise<void> {
  for (const plan of PLAN_SEEDS) {
    // update: {} — admin'in sonradan yaptığı limit değişikliklerini ezmez
    await prisma.subscriptionPlan.upsert({ where: { code: plan.code }, update: {}, create: plan });
  }
}

/**
 * Seed süper admin parolası kuralı. Production'da: en az 12 karakter ve `<`/`>` içermez (`.env.prod.example`
 * yer tutucusu `<...>` olduğu gibi kopyalanırsa reddedilir). Diğer ortamlarda en az 10 karakter.
 * Mesaj değeri asla içermez.
 */
export function assertSeedAdminPassword(password: string, nodeEnv: string | undefined): void {
  if (nodeEnv === 'production') {
    if (/[<>]/.test(password)) {
      throw new Error("SEED_ADMIN_PASSWORD: '<' ya da '>' içeremez (şablondaki yer tutucu değiştirilmemiş görünüyor)");
    }
    if (password.length < 12) throw new Error('SEED_ADMIN_PASSWORD: production ortamında en az 12 karakter olmalı');
    return;
  }
  if (password.length < 10) throw new Error('SEED_ADMIN_PASSWORD: en az 10 karakter olmalı');
}

export async function seedSuperAdmin(
  prisma: PrismaClient,
  input: { email: string; password: string; name: string },
): Promise<User> {
  const email = input.email.trim().toLowerCase();
  assertSeedAdminPassword(input.password, process.env.NODE_ENV);
  const free = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'FREE' } });
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return prisma.user.update({ where: { id: existing.id }, data: { role: 'SUPER_ADMIN', status: 'ACTIVE' } });
  }
  const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);
  const now = new Date();
  return prisma.user.create({
    data: {
      email,
      name: input.name,
      passwordHash,
      role: 'SUPER_ADMIN',
      emailVerifiedAt: now,
      kvkkAcceptedAt: now,
      subscriptions: { create: { planId: free.id } },
      channels: { create: { type: 'IN_APP', isVerified: true } },
    },
  });
}

/** Marka/model eşleme tablosu başlangıç verisi. Gerçek marka/model adlarıdır; demo katalog da bunları kullanır. */
export const MAKE_MODEL_ALIAS_SEEDS: { rawText: string; make: string; model: string; trim: string | null }[] = [
  { rawText: 'Renault Clio', make: 'Renault', model: 'Clio', trim: null },
  { rawText: 'Fiat Egea', make: 'Fiat', model: 'Egea', trim: null },
  { rawText: 'Toyota Corolla', make: 'Toyota', model: 'Corolla', trim: null },
  { rawText: 'Volkswagen Golf', make: 'Volkswagen', model: 'Golf', trim: null },
  { rawText: 'Volkswagen Passat', make: 'Volkswagen', model: 'Passat', trim: null },
  { rawText: 'VW Golf', make: 'Volkswagen', model: 'Golf', trim: null },
  { rawText: 'VW Passat', make: 'Volkswagen', model: 'Passat', trim: null },
  { rawText: 'BMW 3 Serisi', make: 'BMW', model: '3 Serisi', trim: null },
  { rawText: 'Mercedes-Benz C Serisi', make: 'Mercedes-Benz', model: 'C Serisi', trim: null },
  { rawText: 'Mercedes C Serisi', make: 'Mercedes-Benz', model: 'C Serisi', trim: null },
  { rawText: 'Honda Civic', make: 'Honda', model: 'Civic', trim: null },
  { rawText: 'Hyundai i20', make: 'Hyundai', model: 'i20', trim: null },
  { rawText: 'Ford Focus', make: 'Ford', model: 'Focus', trim: null },
  { rawText: 'Peugeot 3008', make: 'Peugeot', model: '3008', trim: null },
  { rawText: 'Dacia Duster', make: 'Dacia', model: 'Duster', trim: null },
];

export async function seedMakeModelAliases(prisma: PrismaClient): Promise<void> {
  for (const alias of MAKE_MODEL_ALIAS_SEEDS) {
    await prisma.makeModelAlias.upsert({ where: { rawText: alias.rawText }, update: {}, create: alias });
  }
}

/** Yalnızca geliştirme: yerel demo ilan sitesini (apps/demo-site) izinli TEST kaynağı olarak kaydeder. */
export async function seedDemoSource(prisma: PrismaClient, baseUrl: string): Promise<DataSource> {
  return prisma.dataSource.upsert({
    where: { code: 'demo-site' },
    update: { config: { baseUrl } },
    create: {
      code: 'demo-site',
      name: 'Demo İlan Sitesi',
      adapterKey: 'demo-site',
      kind: 'HTTP',
      permissionType: 'TEST',
      permissionNote: 'Yerel sahte ilan sitesi (apps/demo-site); gerçek veri içermez.',
      permissionVerifiedAt: new Date(),
      isActive: true,
      intervalSec: 120,
      minRequestGapMs: 200,
      maxConcurrency: 1,
      config: { baseUrl },
    },
  });
}
