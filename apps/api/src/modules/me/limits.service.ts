import { Injectable } from '@nestjs/common';
import { effectiveLimits, planLimitsSchema, type PlanLimits } from '@oto/shared';
import { Errors } from '../../common/errors/app-error';
import { MeRepository } from './me.repository';

export interface UserLimits {
  planCode: string;
  limits: PlanLimits;
  emailVerified: boolean;
  /** Doğrulanmamış hesapta en fazla 1 (spec §6) */
  maxSearchProfiles: number;
}

@Injectable()
export class LimitsService {
  constructor(private readonly repo: MeRepository) {}

  /** Aktif ve süresi dolmamış abonelik yoksa FREE planı geçerlidir. */
  async forUser(userId: string, now = new Date()): Promise<UserLimits> {
    const user = await this.repo.findUser(userId);
    if (!user) throw Errors.unauthenticated();
    const sub = await this.repo.findActiveSubscription(userId);
    const live = sub && (!sub.endsAt || sub.endsAt > now) ? sub : null;
    const plan = live?.plan ?? (await this.repo.findPlanByCode('FREE'));
    if (!plan) throw new Error('FREE planı tanımlı değil (seedPlans çalıştırılmalı)');
    const limits = effectiveLimits(planLimitsSchema.parse(plan.limits), live?.limitOverrides ?? null);
    const emailVerified = user.emailVerifiedAt !== null;
    return {
      planCode: plan.code,
      limits,
      emailVerified,
      maxSearchProfiles: emailVerified ? limits.maxSearchProfiles : Math.min(1, limits.maxSearchProfiles),
    };
  }
}
