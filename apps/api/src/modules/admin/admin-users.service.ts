import { Injectable, Logger } from '@nestjs/common';
import { anonymizeUser, COUNTS_TOWARD_QUOTA, isLastActiveSuperAdmin, lockUserForUpdate, maxSearchProfilesFor, resolveUserPlan, type Prisma, type User } from '@oto/db';
import {
  ErrorCode,
  escapeLike,
  startOfIstanbulDay,
  userEventChannel,
  type AdminSubscription,
  type AdminUsersQuery,
  type UserEvent,
} from '@oto/shared';
import type { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { AuditService } from '../../common/audit/audit.service';
import { AppError, Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../infra/prisma.service';
import { RedisService } from '../../infra/redis.service';
import type { AuthUser } from '../auth/auth-user';
import { toPublicUser, type PublicUser } from '../auth/public-user';
import { SessionService } from '../auth/session.service';
import { toSearchProfileView } from '../me/search-profile.view';

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

export interface AdminUserNotification {
  id: number; kind: string; channel: string; status: string; attempts: number; lastError: string | null;
  payload: unknown; sentAt: Date | null; readAt: Date | null; latencyMs: number | null; createdAt: Date;
}

type UserResult = { user: PublicUser };
type Role = 'USER' | 'ADMIN' | 'SUPER_ADMIN';

/** Canlı abonelik: ACTIVE ve süresi dolmamış (resolveUserPlan ile aynı tanım); yoksa FREE geçerlidir. */
const liveSubscription = (now: Date): Prisma.UserSubscriptionWhereInput => ({
  status: 'ACTIVE',
  OR: [{ endsAt: null }, { endsAt: { gt: now } }],
});

const conflict = (msg: string) => new AppError(ErrorCode.INVALID_OPERATION, 409, msg);

interface Locked {
  target: User;
  /** Kilit altında sayılan ACTIVE SUPER_ADMIN adedi */
  activeSupers: number;
}

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  async list(q: AdminUsersQuery) {
    const and: Prisma.UserWhereInput[] = [];
    if (q.q) {
      // Prisma `contains` joker karakterleri kaçışlamaz (doğrulandı): % ve _ burada kaçışlanır.
      const like = escapeLike(q.q);
      and.push({ OR: [{ email: { contains: like, mode: 'insensitive' } }, { name: { contains: like, mode: 'insensitive' } }] });
    }
    if (q.plan) {
      const live = liveSubscription(new Date());
      and.push(
        q.plan === 'FREE'
          ? { OR: [{ subscriptions: { some: { ...live, plan: { code: 'FREE' } } } }, { subscriptions: { none: live } }] }
          : { subscriptions: { some: { ...live, plan: { code: q.plan } } } },
      );
    }
    const where: Prisma.UserWhereInput = {
      status: q.status ?? { not: 'DELETED' },
      ...(q.role ? { role: q.role } : {}),
      AND: and,
    };
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { subscriptions: { where: liveSubscription(new Date()), include: { plan: { select: { code: true } } }, orderBy: { startsAt: 'desc' }, take: 1 } },
      }),
    ]);
    return {
      total,
      items: rows.map((u) => ({ ...toPublicUser(u), lastLoginAt: u.lastLoginAt, planCode: u.subscriptions[0]?.plan.code ?? 'FREE' })),
    };
  }

  /** DELETED dahil: anonim alanlarla `status: 'DELETED'` döner. */
  async get(id: string): Promise<AdminUserDetail> {
    const u = await this.prisma.user.findUnique({
      where: { id },
      include: { subscriptions: { where: liveSubscription(new Date()), include: { plan: true }, orderBy: { startsAt: 'desc' }, take: 1 } },
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

  async updateName(actor: AuthUser, ctx: AuditCtx, id: string, name: string): Promise<UserResult> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const { target } = await this.lock(tx, actor, id);
      if (target.name === name) return target;
      const after = await tx.user.update({ where: { id }, data: { name } });
      await this.audit.recordInTx(tx, ctx, { targetType: 'User', targetId: id, before: { name: target.name }, after: { name: after.name } });
      return after;
    });
    return { user: toPublicUser(updated) };
  }

  async suspend(actor: AuthUser, ctx: AuditCtx, id: string): Promise<UserResult> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const { target, activeSupers } = await this.lock(tx, actor, id);
      if (target.id === actor.id) throw conflict('Kendi hesabınızı askıya alamazsınız');
      if (target.status === 'SUSPENDED') return target;
      if (isLastActiveSuperAdmin(target, activeSupers)) {
        throw conflict('Son süper admin askıya alınamaz');
      }
      const after = await tx.user.update({ where: { id }, data: { status: 'SUSPENDED' } });
      await tx.notification.updateMany({ where: { userId: id, status: 'PENDING' }, data: { status: 'FAILED', lastError: 'USER_INACTIVE' } });
      await this.audit.recordInTx(tx, ctx, { targetType: 'User', targetId: id, before: { status: target.status }, after: { status: after.status } });
      return after;
    });
    // Oturum iptali commit sonrası ve no-op yolunda da çalışır (idempotent; başarısız iptal yeniden denenebilir).
    await this.sessions.revokeAllForUser(id).catch((err: unknown) => {
      this.logger.error(`Askıya alınan kullanıcının oturumları iptal edilemedi (${id}): ${err instanceof Error ? err.message : String(err)}`);
    });
    return { user: toPublicUser(updated) };
  }

  async activate(actor: AuthUser, ctx: AuditCtx, id: string): Promise<UserResult> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const { target } = await this.lock(tx, actor, id);
      if (target.status === 'ACTIVE') return target;
      const after = await tx.user.update({ where: { id }, data: { status: 'ACTIVE' } });
      await this.audit.recordInTx(tx, ctx, { targetType: 'User', targetId: id, before: { status: target.status }, after: { status: after.status } });
      return after;
    });
    return { user: toPublicUser(updated) };
  }

  async changeRole(actor: AuthUser, ctx: AuditCtx, id: string, role: Role): Promise<UserResult> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const { target, activeSupers } = await this.lock(tx, actor, id);
      if (target.role === role) return target;
      if (target.id === actor.id) throw conflict('Kendi rolünüzü değiştiremezsiniz');
      if (isLastActiveSuperAdmin(target, activeSupers)) {
        throw conflict('Son süper admin düşürülemez');
      }
      const after = await tx.user.update({ where: { id }, data: { role } });
      await this.audit.recordInTx(tx, ctx, { targetType: 'User', targetId: id, before: { role: target.role }, after: { role: after.role } });
      return after;
    });
    return { user: toPublicUser(updated) };
  }

  async remove(actor: AuthUser, ctx: AuditCtx, id: string): Promise<UserResult> {
    const deleted = await this.prisma.$transaction(async (tx) => {
      const { target, activeSupers } = await this.lock(tx, actor, id);
      if (target.id === actor.id) throw conflict('Kendi hesabınızı silemezsiniz');
      if (isLastActiveSuperAdmin(target, activeSupers)) {
        throw conflict('Son süper admin silinemez');
      }
      await anonymizeUser(tx, id);
      const after = await tx.user.findUniqueOrThrow({ where: { id } });
      await this.audit.recordInTx(tx, ctx, {
        targetType: 'User',
        targetId: id,
        before: { status: target.status, role: target.role },
        after: { status: after.status },
      });
      return after;
    });
    return { user: toPublicUser(deleted) };
  }

  async searchProfiles(id: string) {
    await this.requireUser(id);
    const rows = await this.prisma.searchProfile.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' } });
    return { items: rows.map(toSearchProfileView) };
  }

  async notifications(id: string, page: number, pageSize: number): Promise<{ total: number; items: AdminUserNotification[] }> {
    await this.requireUser(id);
    const where = { userId: id };
    const [total, rows] = await Promise.all([
      this.prisma.notification.count({ where }),
      this.prisma.notification.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return {
      total,
      items: rows.map((n) => ({
        id: n.id, kind: n.kind, channel: n.channel, status: n.status, attempts: n.attempts, lastError: n.lastError,
        payload: n.payload, sentAt: n.sentAt, readAt: n.readAt, latencyMs: n.latencyMs, createdAt: n.createdAt,
      })),
    };
  }

  async usage(id: string) {
    await this.requireUser(id);
    const now = new Date();
    const [searchProfiles, activeProfiles, notificationsToday, matches7d, plan] = await Promise.all([
      this.prisma.searchProfile.count({ where: { userId: id } }),
      this.prisma.searchProfile.count({ where: { userId: id, status: 'ACTIVE' } }),
      // Kota tanımı me/worker ile aynı: USER_INACTIVE ile düşenler sayılmaz
      this.prisma.notification.count({
        where: {
          userId: id, kind: 'MATCH', channel: { not: 'IN_APP' }, status: { not: 'SKIPPED_LIMIT' },
          AND: [COUNTS_TOWARD_QUOTA], createdAt: { gte: startOfIstanbulDay(now) },
        },
      }),
      this.prisma.listingMatch.count({ where: { userId: id, createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } } }),
      resolveUserPlan(this.prisma, id, now),
    ]);
    return {
      searchProfiles, activeProfiles, notificationsToday, matches7d,
      plan: { code: plan.planCode, name: plan.planName, status: plan.status, endsAt: plan.endsAt, limits: plan.limits },
    };
  }

  async changeSubscription(actor: AuthUser, ctx: AuditCtx, id: string, input: AdminSubscription) {
    const endsAt = input.endsAt ? new Date(input.endsAt) : null;
    const now = new Date();
    if (endsAt && endsAt <= now) throw Errors.validation([{ path: ['endsAt'], message: 'Bitiş tarihi gelecekte olmalı' }]);
    const out = await this.prisma.$transaction(async (tx) => {
      const { target } = await this.lock(tx, actor, id);
      if (target.id === actor.id) throw conflict('Kendi aboneliğinizi değiştiremezsiniz');
      // Paket satırı FOR SHARE ile kilitlenir: eşzamanlı pasifleştirme (plans.update, FOR NO KEY UPDATE) ya önce commit
      // edilir ve burada görülür ya da bu işlem bitene kadar bekler.
      await tx.$queryRaw`SELECT id FROM "SubscriptionPlan" WHERE id = ${input.planId} FOR SHARE`;
      const plan = await tx.subscriptionPlan.findUnique({ where: { id: input.planId } });
      if (!plan) throw Errors.validation([{ path: ['planId'], message: 'Paket bulunamadı' }]);
      if (!plan.isActive) throw conflict('Pasif pakete abonelik atanamaz');
      const before = await resolveUserPlan(tx, id, now);
      await tx.userSubscription.updateMany({ where: { userId: id, status: 'ACTIVE' }, data: { status: 'CANCELED' } });
      await tx.userSubscription.create({
        data: { userId: id, planId: plan.id, status: 'ACTIVE', endsAt, limitOverrides: input.limitOverrides ?? undefined },
      });
      const after = await resolveUserPlan(tx, id, now);
      const active = await tx.searchProfile.findMany({
        where: { userId: id, status: 'ACTIVE' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      const cap = maxSearchProfilesFor(after.limits, target.emailVerifiedAt !== null);
      const excess = active.slice(cap);
      let event: UserEvent | null = null;
      if (excess.length > 0) {
        await tx.searchProfile.updateMany({ where: { id: { in: excess.map((p) => p.id) }, status: 'ACTIVE' }, data: { status: 'PAUSED' } });
        const note = await tx.notification.create({
          data: {
            userId: id, kind: 'SYSTEM_ALERT', channel: 'IN_APP', status: 'SENT', sentAt: now,
            payload: {
              type: 'PROFILES_PAUSED', count: excess.length, level: 'WARN',
              message: `Aboneliğiniz değişti; ${after.planName} planı en fazla ${cap} aktif profile izin veriyor. ${excess.length} profil duraklatıldı.`,
            },
          },
        });
        event = {
          type: 'notification',
          notification: { id: note.id, kind: 'SYSTEM_ALERT', channel: 'IN_APP', status: 'SENT', payload: note.payload, createdAt: note.createdAt.toISOString() },
        };
      }
      await this.audit.recordInTx(tx, ctx, {
        targetType: 'User',
        targetId: id,
        before: { planCode: before.planCode, status: before.status, endsAt: before.endsAt },
        after: { planCode: after.planCode, status: after.status, endsAt, limitOverrides: input.limitOverrides, pausedProfiles: excess.length },
      });
      return { event, paused: excess.length, planCode: after.planCode };
    });
    if (out.event) {
      await this.redis.publish(userEventChannel(id), JSON.stringify(out.event)).catch((err: unknown) => {
        this.logger.warn(`Bildirim yayınlanamadı: ${String(err)}`);
      });
    }
    return { planCode: out.planCode, pausedProfiles: out.paused };
  }

  private async requireUser(id: string): Promise<void> {
    const u = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!u) throw Errors.notFound();
  }

  /**
   * Tx içinde kilitler: önce ACTIVE SUPER_ADMIN kümesi (id sırasıyla; deadlock yok), sonra hedef satır.
   * Kilit sonrası okunan durum günceldir (READ COMMITTED), eşzamanlı istekler sıraya girer.
   * DELETED hedef 404; ADMIN bir SUPER_ADMIN'e dokunamaz (403).
   */
  private async lock(tx: Prisma.TransactionClient, actor: AuthUser, id: string): Promise<Locked> {
    const { target, activeSupers } = await lockUserForUpdate(tx, id);
    if (!target || target.status === 'DELETED') throw Errors.notFound();
    if (target.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') throw Errors.forbidden();
    return { target, activeSupers };
  }
}
