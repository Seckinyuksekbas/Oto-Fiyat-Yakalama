import { Injectable } from '@nestjs/common';
import {
  startOfIstanbulDay,
  type ChangePasswordInput,
  type DeleteMeInput,
  type PlanLimits,
  type UpdateMeInput,
} from '@oto/shared';
import { AppError, Errors } from '../../common/errors/app-error';
import type { AuthUser } from '../auth/auth-user';
import { PasswordService } from '../auth/password.service';
import { toPublicUser, type PublicUser } from '../auth/public-user';
import { SessionService, type SessionView } from '../auth/session.service';
import { LimitsService } from './limits.service';
import { MeRepository } from './me.repository';

export interface MeProfile {
  user: PublicUser;
  subscription: { planCode: string; planName: string; limits: PlanLimits; status: string; endsAt: Date | null } | null;
  usage: { searchProfiles: number; notificationsToday: number };
}

@Injectable()
export class MeService {
  constructor(
    private readonly repo: MeRepository,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly limits: LimitsService,
  ) {}

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
            limits: (await this.limits.forUser(userId)).limits,
            status: sub.status,
            endsAt: sub.endsAt,
          }
        : null,
      usage: { searchProfiles, notificationsToday },
    };
  }

  async updateName(userId: string, input: UpdateMeInput): Promise<{ user: PublicUser }> {
    const user = await this.repo.updateName(userId, input.name);
    if (!user) throw Errors.unauthenticated();
    return { user: toPublicUser(user) };
  }

  async changePassword(user: AuthUser, input: ChangePasswordInput): Promise<void> {
    await this.assertPassword(user.id, input.currentPassword);
    await this.passwords.assertNotBreached(input.newPassword);
    await this.repo.updatePasswordHash(user.id, await this.passwords.hash(input.newPassword));
    await this.repo.invalidateResetTokens(user.id);
    await this.sessions.revokeAllForUser(user.id, { exceptFamilyId: user.sessionId });
  }

  async listSessions(user: AuthUser): Promise<{ items: (SessionView & { current: boolean })[] }> {
    const items = await this.sessions.listActive(user.id);
    return { items: items.map((s) => ({ ...s, current: s.id === user.sessionId })) };
  }

  async revokeSession(userId: string, familyId: string): Promise<void> {
    if (!(await this.sessions.revokeFamilyForUser(userId, familyId))) throw Errors.notFound();
  }

  async deleteAccount(userId: string, input: DeleteMeInput): Promise<void> {
    await this.assertPassword(userId, input.password);
    if ((await this.repo.findRole(userId)) === 'SUPER_ADMIN' && !(await this.repo.hasOtherActiveSuperAdmin(userId))) {
      throw new AppError('INVALID_OPERATION', 409, 'Son süper admin hesabı silinemez');
    }
    await this.repo.anonymizeAndDelete(userId);
  }

  private async assertPassword(userId: string, password: string): Promise<void> {
    const hash = await this.repo.findPasswordHash(userId);
    if (!hash || !(await this.passwords.verify(hash, password))) throw Errors.invalidCredentials(400);
  }
}
