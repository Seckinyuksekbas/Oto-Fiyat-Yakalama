import { Injectable } from '@nestjs/common';
import { maxSearchProfilesFor, Prisma, type SubscriptionPlan } from '@oto/db';
import { ErrorCode, planLimitsSchema, type AdminPlanCreate, type AdminPlanUpdate } from '@oto/shared';
import type { AuditCtx } from '../../common/audit/audit-ctx.decorator';
import { AuditService } from '../../common/audit/audit.service';
import { AppError, Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../infra/prisma.service';

export const FREE_PLAN_CODE = 'FREE';

const conflict = (msg: string) => new AppError(ErrorCode.INVALID_OPERATION, 409, msg);

export interface AdminPlanView {
  id: string;
  code: string;
  name: string;
  priceMonthly: number;
  isActive: boolean;
  limits: Prisma.JsonValue;
  /** Canlı (ACTIVE, süresi dolmamış) abonelik sayısı; aboneliksiz kullanıcıların örtük FREE'si sayılmaz. */
  activeSubscriptions: number;
  createdAt: Date;
  updatedAt: Date;
}

const snapshot = (p: SubscriptionPlan) => ({ code: p.code, name: p.name, priceMonthly: p.priceMonthly, isActive: p.isActive, limits: p.limits });

/** Anahtar sırasından bağımsız JSON eşitliği (no-op tespiti için). */
function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

@Injectable()
export class AdminPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async counts(db: Prisma.TransactionClient, planIds: string[]): Promise<Map<string, number>> {
    const now = new Date();
    const rows = await db.userSubscription.groupBy({
      by: ['planId'],
      where: { planId: { in: planIds }, status: 'ACTIVE', OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.planId, r._count._all]));
  }

  private view(p: SubscriptionPlan, n: number): AdminPlanView {
    return { id: p.id, code: p.code, name: p.name, priceMonthly: p.priceMonthly, isActive: p.isActive, limits: p.limits, activeSubscriptions: n, createdAt: p.createdAt, updatedAt: p.updatedAt };
  }

  async list(): Promise<{ items: AdminPlanView[]; total: number }> {
    const plans = await this.prisma.subscriptionPlan.findMany({ orderBy: [{ priceMonthly: 'asc' }, { createdAt: 'asc' }] });
    const counts = await this.counts(this.prisma, plans.map((p) => p.id));
    return { items: plans.map((p) => this.view(p, counts.get(p.id) ?? 0)), total: plans.length };
  }

  async create(ctx: AuditCtx, body: AdminPlanCreate): Promise<{ plan: AdminPlanView }> {
    try {
      const plan = await this.prisma.$transaction(async (tx) => {
        const p = await tx.subscriptionPlan.create({
          data: { code: body.code, name: body.name, priceMonthly: body.priceMonthly, isActive: body.isActive, limits: body.limits },
        });
        await this.audit.recordInTx(tx, ctx, { targetType: 'SubscriptionPlan', targetId: p.id, after: snapshot(p) });
        return p;
      });
      return { plan: this.view(plan, 0) };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw conflict('Bu paket kodu zaten kullanılıyor');
      throw err;
    }
  }

  /**
   * Kod değiştirilemez (gövde şeması `code` kabul etmez). FREE pasifleştirilemez.
   * Aktif abonesi olan bir paket pasifleştirilebilir: mevcut abonelikler sürer, yeni atama 409 (kullanıcı aboneliği servisi).
   */
  /**
   * Canlı paketi bu olan (FREE için aboneliksiz geri düşüş kullanıcıları dahil) ve ACTIVE profil sayısı paket limitini
   * (doğrulanmamış e-posta kuralıyla, `maxSearchProfilesFor`) aşan kullanıcı sayısı. Limit düşürmek mevcut profilleri
   * duraklatmaz; fazlalık bir sonraki abonelik değişiminde/süpürmede uygulanır — bu sayı yöneticiye etkisini gösterir.
   */
  private async usersOverProfileLimit(plan: SubscriptionPlan): Promise<number> {
    const parsed = planLimitsSchema.safeParse(plan.limits);
    if (!parsed.success) return 0;
    const now = new Date();
    const live: Prisma.UserSubscriptionWhereInput = { status: 'ACTIVE', OR: [{ endsAt: null }, { endsAt: { gt: now } }] };
    const onPlan: Prisma.UserWhereInput =
      plan.code === FREE_PLAN_CODE
        ? { OR: [{ subscriptions: { some: { ...live, planId: plan.id } } }, { subscriptions: { none: live } }] }
        : { subscriptions: { some: { ...live, planId: plan.id } } };
    const floor = maxSearchProfilesFor(parsed.data, false); // her kullanıcı için en düşük olası limit
    const groups = await this.prisma.searchProfile.groupBy({
      by: ['userId'],
      where: { status: 'ACTIVE', user: { status: { not: 'DELETED' }, ...onPlan } },
      _count: { _all: true },
    });
    const candidates = groups.filter((g) => g._count._all > floor);
    if (candidates.length === 0) return 0;
    const users = await this.prisma.user.findMany({
      where: { id: { in: candidates.map((g) => g.userId) } },
      select: { id: true, emailVerifiedAt: true },
    });
    const verified = new Map(users.map((u) => [u.id, u.emailVerifiedAt !== null]));
    return candidates.filter((g) => g._count._all > maxSearchProfilesFor(parsed.data, verified.get(g.userId) ?? false)).length;
  }

  async update(ctx: AuditCtx, id: string, body: AdminPlanUpdate): Promise<{ plan: AdminPlanView & { usersOverProfileLimit: number } }> {
    const plan = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "SubscriptionPlan" WHERE id = ${id} FOR UPDATE`;
      if (locked.length === 0) throw Errors.notFound();
      const before = await tx.subscriptionPlan.findUniqueOrThrow({ where: { id } });
      if (before.code === FREE_PLAN_CODE && body.isActive === false) throw conflict('FREE paketi pasifleştirilemez');
      const data: Prisma.SubscriptionPlanUpdateInput = {};
      if (body.name !== undefined && body.name !== before.name) data.name = body.name;
      if (body.priceMonthly !== undefined && body.priceMonthly !== before.priceMonthly) data.priceMonthly = body.priceMonthly;
      if (body.isActive !== undefined && body.isActive !== before.isActive) data.isActive = body.isActive;
      if (body.limits !== undefined && !sameJson(body.limits, before.limits)) data.limits = body.limits;
      if (Object.keys(data).length === 0) return before;
      const after = await tx.subscriptionPlan.update({ where: { id }, data });
      await this.audit.recordInTx(tx, ctx, { targetType: 'SubscriptionPlan', targetId: id, before: snapshot(before), after: snapshot(after) });
      return after;
    });
    const counts = await this.counts(this.prisma, [plan.id]);
    return { plan: { ...this.view(plan, counts.get(plan.id) ?? 0), usersOverProfileLimit: await this.usersOverProfileLimit(plan) } };
  }
}
