import { Controller, Get } from '@nestjs/common';
import { startOfIstanbulDay, type SubscriptionView } from '@oto/shared';
import { CurrentUser } from '../../common/decorators/current-user';
import type { AuthUser } from '../auth/auth-user';
import { LimitsService } from './limits.service';
import { MeRepository } from './me.repository';

@Controller('me/subscription')
export class SubscriptionController {
  constructor(
    private readonly limits: LimitsService,
    private readonly repo: MeRepository,
  ) {}

  @Get()
  async get(@CurrentUser() user: AuthUser): Promise<SubscriptionView> {
    const [lim, searchProfiles, notificationsToday] = await Promise.all([
      this.limits.forUser(user.id),
      this.repo.countSearchProfiles(user.id),
      this.repo.countExternalNotificationsSince(user.id, startOfIstanbulDay(new Date())),
    ]);
    const s = lim.subscription;
    return {
      planCode: s.planCode,
      planName: s.planName,
      status: s.status,
      endsAt: s.endsAt?.toISOString() ?? null,
      limits: s.limits,
      usage: { searchProfiles, notificationsToday },
    };
  }
}
