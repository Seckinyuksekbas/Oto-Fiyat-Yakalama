import { Injectable } from '@nestjs/common';
import { planLimitsSchema, startOfIstanbulDay, type PlanLimits } from '@oto/shared';
import { Errors } from '../../common/errors/app-error';
import { toPublicUser, type PublicUser } from '../auth/public-user';
import { MeRepository } from './me.repository';

export interface MeProfile {
  user: PublicUser;
  subscription: { planCode: string; planName: string; limits: PlanLimits; status: string; endsAt: Date | null } | null;
  usage: { searchProfiles: number; notificationsToday: number };
}

@Injectable()
export class MeService {
  constructor(private readonly repo: MeRepository) {}

  async getProfile(userId: string): Promise<MeProfile> {
    const user = await this.repo.findUser(userId);
    if (!user) throw Errors.unauthenticated();
    const [sub, searchProfiles, notificationsToday] = await Promise.all([
      this.repo.findActiveSubscription(userId),
      this.repo.countSearchProfiles(userId),
      this.repo.countExternalNotificationsSince(userId, startOfIstanbulDay(new Date())),
    ]);
    return {
      user: toPublicUser(user),
      subscription: sub
        ? {
            planCode: sub.plan.code,
            planName: sub.plan.name,
            limits: planLimitsSchema.parse(sub.plan.limits),
            status: sub.status,
            endsAt: sub.endsAt,
          }
        : null,
      usage: { searchProfiles, notificationsToday },
    };
  }
}
