import { Injectable } from '@nestjs/common';
import { Prisma, type User } from '@oto/db';
import { ErrorCode, type LoginInput, type RegisterInput } from '@oto/shared';
import { AuditService } from '../../common/audit/audit.service';
import type { ClientMeta } from '../../common/client-meta';
import { AppError, Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../infra/prisma.service';
import { LOCK_THRESHOLD, LoginAttemptService } from './login-attempt.service';
import { PasswordService } from './password.service';
import { toPublicUser, type PublicUser } from './public-user';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

export type RefreshOutcome =
  | { kind: 'ok'; accessToken: string; refreshToken: string }
  | { kind: 'invalid' }
  | { kind: 'race' }
  | { kind: 'reused' };

const emailTaken = () => new AppError(ErrorCode.EMAIL_TAKEN, 409, 'Bu e-posta adresi zaten kayıtlı');

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly attempts: LoginAttemptService,
    private readonly audit: AuditService,
  ) {}

  async register(input: RegisterInput, meta: ClientMeta): Promise<AuthResult> {
    await this.passwords.assertNotBreached(input.password);
    if (await this.prisma.user.findUnique({ where: { email: input.email } })) throw emailTaken();
    const free = await this.prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'FREE' } });
    const passwordHash = await this.passwords.hash(input.password);
    let user: User;
    try {
      user = await this.prisma.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash,
          kvkkAcceptedAt: new Date(),
          subscriptions: { create: { planId: free.id } },
          channels: { create: { type: 'IN_APP', isVerified: true } },
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw emailTaken();
      throw err;
    }
    return this.startSession(user, meta);
  }

  async login(input: LoginInput, meta: ClientMeta): Promise<AuthResult> {
    const key = { ip: meta.ip ?? 'unknown', email: input.email };
    if (await this.attempts.isLocked(key)) {
      throw new AppError(ErrorCode.LOGIN_LOCKED, 429, 'Çok fazla hatalı deneme. 15 dakika sonra tekrar deneyin.');
    }
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    const usable = user !== null && user.status !== 'DELETED';
    const ok = usable
      ? await this.passwords.verify(user.passwordHash, input.password)
      : await this.passwords.dummyVerify(input.password);
    if (!usable || !ok) {
      const count = await this.attempts.recordFailure(key);
      if (count === LOCK_THRESHOLD) {
        await this.audit.record({
          actorId: null,
          action: 'auth.login_locked',
          targetType: 'User',
          targetId: user?.id ?? null,
          after: { email: input.email },
          ip: meta.ip,
        });
      }
      throw Errors.invalidCredentials();
    }
    if (user.status === 'SUSPENDED') {
      throw new AppError(ErrorCode.ACCOUNT_SUSPENDED, 403, 'Hesabınız askıya alınmış');
    }
    await this.attempts.clear(key);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.startSession(user, meta);
  }

  async refresh(presented: string | undefined, meta: ClientMeta): Promise<RefreshOutcome> {
    if (!presented) return { kind: 'invalid' };
    const r = await this.sessions.rotate(presented, meta);
    if (r.kind === 'reused') {
      await this.audit.record({
        actorId: r.userId,
        action: 'auth.refresh_reused',
        targetType: 'Session',
        targetId: r.familyId,
        ip: meta.ip,
      });
      await this.prisma.notification.create({
        data: {
          userId: r.userId,
          kind: 'SECURITY',
          channel: 'IN_APP',
          status: 'SENT',
          sentAt: new Date(),
          payload: { type: 'REFRESH_REUSED', familyId: r.familyId },
        },
      });
      return { kind: 'reused' };
    }
    if (r.kind !== 'ok') return { kind: r.kind };
    const accessToken = await this.tokens.signAccess({ userId: r.userId, role: r.role, sessionId: r.familyId });
    return { kind: 'ok', accessToken, refreshToken: r.refreshToken };
  }

  async logout(presented: string | undefined): Promise<void> {
    if (presented) await this.sessions.revokeByToken(presented);
  }

  private async startSession(user: User, meta: ClientMeta): Promise<AuthResult> {
    const { familyId, refreshToken } = await this.sessions.create(user.id, meta);
    const accessToken = await this.tokens.signAccess({ userId: user.id, role: user.role, sessionId: familyId });
    return { user: toPublicUser(user), accessToken, refreshToken };
  }
}
