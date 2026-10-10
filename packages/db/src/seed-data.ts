import type { PrismaClient, User } from '@prisma/client';
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

export async function seedSuperAdmin(
  prisma: PrismaClient,
  input: { email: string; password: string; name: string },
): Promise<User> {
  const email = input.email.trim().toLowerCase();
  if (input.password.length < 10) throw new Error('SEED_ADMIN_PASSWORD en az 10 karakter olmalı');
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
