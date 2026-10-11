import { Injectable } from '@nestjs/common';
import { Prisma } from '@oto/db';
import { PrismaService } from '../../infra/prisma.service';
import type { AuditCtx } from './audit-ctx.decorator';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

export interface AuditTarget {
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Mutasyonla aynı transaction'da denetim kaydı yazar (admin mutasyonları için zorunlu yol). */
  async recordInTx(tx: Prisma.TransactionClient, ctx: AuditCtx, e: AuditTarget): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: ctx.actorId,
        action: ctx.action,
        targetType: e.targetType,
        targetId: e.targetId,
        before: toJson(e.before),
        after: toJson(e.after),
        ip: ctx.ip,
      },
    });
  }

  /** Tx dışı kayıt: yalnızca kimlik doğrulama olayları (mutasyon yok) için. */
  async record(e: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorId: e.actorId,
        action: e.action,
        targetType: e.targetType ?? null,
        targetId: e.targetId ?? null,
        before: toJson(e.before),
        after: toJson(e.after),
        ip: e.ip ?? null,
      },
    });
  }
}
