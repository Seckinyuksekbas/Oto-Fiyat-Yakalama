import { Injectable } from '@nestjs/common';
import type { User } from '@oto/db';
import type { PlanLimits } from '@oto/shared';
import { Errors } from '../../common/errors/app-error';
import { MeRepository } from './me.repository';

export interface UserSubscriptionInfo {
  planCode: string;
  planName: string;
  limits: PlanLimits;
  /** Canlı abonelikte DB durumu; FREE'ye düşülmüşse 'FALLBACK' */
  status: string;
  endsAt: Date | null;
}

export interface UserLimits {
  user: User;
  /** Uygulanan planla birebir aynı: /me bunu gösterir */
  subscription: UserSubscriptionInfo;
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
    const plan = await this.repo.resolvePlan(userId, now);
    const limits = plan.limits;
    const emailVerified = user.emailVerifiedAt !== null;
    return {
      user,
      subscription: {
        planCode: plan.planCode,
        planName: plan.planName,
        limits,
        status: plan.status,
        endsAt: plan.endsAt,
      },
      planCode: plan.planCode,
      limits,
      emailVerified,
      maxSearchProfiles: emailVerified ? limits.maxSearchProfiles : Math.min(1, limits.maxSearchProfiles),
    };
  }
}
