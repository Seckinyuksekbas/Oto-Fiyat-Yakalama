import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Role } from '@oto/db';
import type { ClientMeta } from '../../common/client-meta';
import { generateToken, hashToken } from '@oto/server-common';
import { PrismaService } from '../../infra/prisma.service';
import { REFRESH_TTL_MS, ROTATION_GRACE_MS } from './auth.constants';

export type RotateResult =
  | { kind: 'ok'; userId: string; role: Role; familyId: string; refreshToken: string }
  | { kind: 'invalid' }
  | { kind: 'race' }
  | { kind: 'reused'; userId: string; familyId: string };

export interface SessionView {
  id: string;
  ip: string | null;
  userAgent: string | null;
  lastUsedAt: Date;
}

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, meta: ClientMeta): Promise<{ familyId: string; refreshToken: string }> {
    const familyId = randomUUID();
    const refreshToken = generateToken();
    await this.prisma.session.create({
      data: {
        userId,
        familyId,
        refreshTokenHash: hashToken(refreshToken),
        ip: meta.ip,
        userAgent: meta.userAgent,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    return { familyId, refreshToken };
  }

  async rotate(presented: string, meta: ClientMeta): Promise<RotateResult> {
    const row = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hashToken(presented) },
      include: { user: { select: { role: true, status: true } } },
    });
    if (!row) return { kind: 'invalid' };
    if (row.rotatedAt) {
      if (Date.now() - row.rotatedAt.getTime() <= ROTATION_GRACE_MS) return { kind: 'race' };
      await this.revokeFamily(row.familyId);
      return { kind: 'reused', userId: row.userId, familyId: row.familyId };
    }
    if (row.revokedAt || row.expiresAt.getTime() <= Date.now() || row.user.status !== 'ACTIVE') {
      return { kind: 'invalid' };
    }
    const refreshToken = generateToken();
    const now = new Date();
    const rotated = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.session.updateMany({
        where: { id: row.id, rotatedAt: null, revokedAt: null },
        data: { rotatedAt: now, revokedAt: now },
      });
      if (updated.count !== 1) return false;
      await tx.session.create({
        data: {
          userId: row.userId,
          familyId: row.familyId,
          refreshTokenHash: hashToken(refreshToken),
          ip: meta.ip,
          userAgent: meta.userAgent,
          expiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
        },
      });
      return true;
    });
    if (!rotated) return { kind: 'race' };
    return { kind: 'ok', userId: row.userId, role: row.user.role, familyId: row.familyId, refreshToken };
  }

  async revokeByToken(presented: string): Promise<void> {
    const row = await this.prisma.session.findUnique({ where: { refreshTokenHash: hashToken(presented) } });
    if (row) await this.revokeFamily(row.familyId);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async revokeFamilyForUser(userId: string, familyId: string): Promise<boolean> {
    const { count } = await this.prisma.session.updateMany({
      where: { userId, familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count > 0;
  }

  async revokeAllForUser(userId: string, opts: { exceptFamilyId?: string } = {}): Promise<void> {
    await this.prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(opts.exceptFamilyId ? { familyId: { not: opts.exceptFamilyId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
  }

  async listActive(userId: string): Promise<SessionView[]> {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({ id: r.familyId, ip: r.ip, userAgent: r.userAgent, lastUsedAt: r.createdAt }));
  }
}
