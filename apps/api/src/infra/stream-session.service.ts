import { Inject, Injectable } from '@nestjs/common';
import type { Role } from '@oto/db';
import type { AuthUser } from '../modules/auth/auth-user';
import { PrismaService } from './prisma.service';

/** Uzun ömürlü SSE akışlarında oturum/rol yeniden kontrolü (ve admin KPI) aralığı; testler küçültebilir. */
export const SSE_RECHECK_MS = Symbol('SSE_RECHECK_MS');
export const DEFAULT_SSE_RECHECK_MS = 30_000;

/**
 * SSE bağlantısı açıkken oturumun hâlâ geçerli olduğunu doğrular: RolesGuard ile aynı sorgu (oturum ailesi iptal edilmemiş
 * ve süresi dolmamış, kullanıcı ACTIVE) + istenirse rol. Geçersizse akış kapatılır (çıkış/askıya alma/rol düşürme sonrası
 * 15 dk boyunca olay sızmaz).
 */
@Injectable()
export class StreamSessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SSE_RECHECK_MS) readonly recheckMs: number,
  ) {}

  async isValid(user: AuthUser, roles?: readonly Role[]): Promise<boolean> {
    const session = await this.prisma.session.findFirst({
      where: { familyId: user.sessionId, userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { user: { select: { role: true, status: true } } },
    });
    if (!session || session.user.status !== 'ACTIVE') return false;
    return !roles || roles.includes(session.user.role);
  }
}
