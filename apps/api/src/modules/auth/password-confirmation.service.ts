import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@oto/shared';
import { AppError, Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../infra/prisma.service';
import { RedisService } from '../../infra/redis.service';
import { PasswordService } from './password.service';

const MAX_FAILURES = 5;
const WINDOW_SEC = 15 * 60;

/** Hassas /me işlemleri (şifre değişimi, hesap silme) için mevcut şifre onayı; deneme sınırlıdır. */
@Injectable()
export class PasswordConfirmationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly passwords: PasswordService,
  ) {}

  async assert(userId: string, password: string): Promise<void> {
    const key = `auth:confirm-fail:${userId}`;
    // Deneme hakkı doğrulamadan ÖNCE atomik olarak ayrılır; eşzamanlı istekler sınırı aşamaz.
    const res = await this.redis.multi().incr(key).expire(key, WINDOW_SEC, 'NX').exec();
    const n = Number(res?.[0]?.[1] ?? 0);
    if ((await this.redis.ttl(key)) === -1) await this.redis.expire(key, WINDOW_SEC);
    if (n > MAX_FAILURES) {
      throw new AppError(ErrorCode.RATE_LIMITED, 429, 'Çok fazla hatalı deneme. Lütfen 15 dakika sonra tekrar deneyin');
    }
    const u = await this.prisma.user.findFirst({ where: { id: userId, status: { not: 'DELETED' } }, select: { passwordHash: true } });
    if (!u?.passwordHash || !(await this.passwords.verify(u.passwordHash, password))) {
      throw Errors.invalidCredentials(400);
    }
    await this.redis.del(key);
  }
}
