import type { Prisma } from '@prisma/client';
import { effectiveLimits, planLimitsSchema, type PlanLimits } from '@oto/shared';

export type LimitsDb = Pick<Prisma.TransactionClient, 'userSubscription' | 'subscriptionPlan'>;

export interface ResolvedPlan {
  planCode: string;
  planName: string;
  /** Canlı abonelikte abonelik durumu; canlı abonelik yoksa 'FALLBACK' (FREE planı uygulanır) */
  status: string;
  endsAt: Date | null;
  limits: PlanLimits;
}

/** API ve worker için TEK limit çözümleme noktası. */
export async function resolveUserPlan(db: LimitsDb, userId: string, now = new Date()): Promise<ResolvedPlan> {
  const sub = await db.userSubscription.findFirst({
    where: { userId, status: 'ACTIVE', OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    include: { plan: true },
    orderBy: { startsAt: 'desc' },
  });
  if (sub) {
    return {
      planCode: sub.plan.code, planName: sub.plan.name, status: sub.status, endsAt: sub.endsAt,
      limits: effectiveLimits(planLimitsSchema.parse(sub.plan.limits), sub.limitOverrides ?? null),
    };
  }
  const free = await db.subscriptionPlan.findUnique({ where: { code: 'FREE' } });
  if (!free) throw new Error('FREE planı tanımlı değil (seedPlans çalıştırılmalı)');
  return { planCode: free.code, planName: free.name, status: 'FALLBACK', endsAt: null, limits: planLimitsSchema.parse(free.limits) };
}
