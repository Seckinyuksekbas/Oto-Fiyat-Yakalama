import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, User } from '@oto/db';
import { ErrorCode, type AdminUsersQuery } from '@oto/shared';
import type { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { AuditService } from '../../common/audit/audit.service';
import { AppError, Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../infra/prisma.service';
import type { AuthUser } from '../auth/auth-user';
import { toPublicUser, type PublicUser } from '../auth/public-user';
import { SessionService } from '../auth/session.service';

export interface AdminUserDetail {
  user: PublicUser & { lastLoginAt: Date | null };
  subscription: {
    planCode: string;
    planName: string;
    status: string;
    endsAt: Date | null;
    limitOverrides: Prisma.JsonValue;
  } | null;
  counts: { searchProfiles: number; activeSessions: number };
}

type UserResult = { user: PublicUser };

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  private readonly logger = new Logger(AdminUsersService.name);

  async list(q: AdminUsersQuery) {
    const where: Prisma.UserWhereInput = {
      status: q.status ?? { not: 'DELETED' },
      ...(q.role ? { role: q.role } : {}),
      ...(q.q
        ? { OR: [{ email: { contains: q.q, mode: 'insensitive' } }, { name: { contains: q.q, mode: 'insensitive' } }] }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { subscriptions: { where: { status: 'ACTIVE' }, include: { plan: { select: { code: true } } }, take: 1 } },
      }),
    ]);
    return {
      total,
      items: rows.map((u) => ({ ...toPublicUser(u), lastLoginAt: u.lastLoginAt, planCode: u.subscriptions[0]?.plan.code ?? null })),
    };
  }

  async get(id: string): Promise<AdminUserDetail> {
    const u = await this.prisma.user.findUnique({
      where: { id },
      include: { subscriptions: { where: { status: 'ACTIVE' }, include: { plan: true }, take: 1 } },
    });
    if (!u) throw Errors.notFound();
    const [searchProfiles, activeSessions] = await Promise.all([
      this.prisma.searchProfile.count({ where: { userId: id } }),
      this.sessions.listActive(id).then((s) => s.length),
    ]);
    const sub = u.subscriptions[0];
    return {
      user: { ...toPublicUser(u), lastLoginAt: u.lastLoginAt },
      subscription: sub ? { planCode: sub.plan.code, planName: sub.plan.name, status: sub.status, endsAt: sub.endsAt, limitOverrides: sub.limitOverrides } : null,
      counts: { searchProfiles, activeSessions },
    };
  }

  async suspend(actor: AuthUser, ctx: AuditCtx, id: string): Promise<UserResult> {
    const target = await this.loadManageable(actor, id);
    if (target.id === actor.id) {
      throw new AppError(ErrorCode.INVALID_OPERATION, 409, 'Kendi hesabınızı askıya alamazsınız');
    }
    if (target.status === 'SUSPENDED') return { user: toPublicUser(target) };
    const updated = await this.prisma.$transaction(async (tx) => {
      const after = await tx.user.update({ where: { id }, data: { status: 'SUSPENDED' } });
      await this.audit.recordInTx(tx, ctx, {
        targetType: 'User',
        targetId: id,
        before: { status: target.status },
        after: { status: after.status },
      });
      return after;
    });
    // Oturum iptali commit sonrası: başarısızsa askıya alma geçerli kalır (RolesGuard/rotate durumu zaten reddeder).
    await this.sessions.revokeAllForUser(id).catch((err: unknown) => {
      this.logger.error(`Askıya alınan kullanıcının oturumları iptal edilemedi (${id}): ${err instanceof Error ? err.message : String(err)}`);
    });
    return { user: toPublicUser(updated) };
  }

  async activate(actor: AuthUser, ctx: AuditCtx, id: string): Promise<UserResult> {
    const target = await this.loadManageable(actor, id);
    if (target.status === 'ACTIVE') return { user: toPublicUser(target) };
    const updated = await this.prisma.$transaction(async (tx) => {
      const after = await tx.user.update({ where: { id }, data: { status: 'ACTIVE' } });
      await this.audit.recordInTx(tx, ctx, {
        targetType: 'User',
        targetId: id,
        before: { status: target.status },
        after: { status: after.status },
      });
      return after;
    });
    return { user: toPublicUser(updated) };
  }

  private async loadManageable(actor: AuthUser, id: string): Promise<User> {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target || target.status === 'DELETED') throw Errors.notFound();
    if (target.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') throw Errors.forbidden();
    return target;
  }

}
