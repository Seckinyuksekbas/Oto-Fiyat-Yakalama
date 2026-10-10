import { Injectable } from '@nestjs/common';
import { Prisma } from '@oto/db';
import { PrismaService } from '../../infra/prisma.service';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

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
