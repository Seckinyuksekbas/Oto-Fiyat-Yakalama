import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ARGON2_OPTIONS } from '@oto/db';
import { ErrorCode } from '@oto/shared';
import argon2 from 'argon2';
import { AppError } from '../../common/errors/app-error';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);
  private dummyHash?: Promise<string>;

  constructor(@Inject(ENV) private readonly env: Env) {}

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /** Kullanıcı bulunamadığında da aynı süreyi harcayarak e-posta tahminini zorlaştırır. */
  async dummyVerify(password: string): Promise<false> {
    this.dummyHash ??= this.hash('timing-equalizer-password');
    await this.verify(await this.dummyHash, password);
    return false;
  }

  async assertNotBreached(password: string): Promise<void> {
    if (!this.env.HIBP_ENABLED) return;
    const sha = createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha.slice(0, 5);
    const suffix = sha.slice(5);
    let body: string;
    try {
      const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { 'Add-Padding': 'true' },
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return;
      body = await res.text();
    } catch (err) {
      this.logger.warn({ err }, 'HIBP check skipped');
      return;
    }
    const breached = body.split(/\r?\n/).some((line) => {
      const [s, count] = line.split(':');
      return s === suffix && Number(count) > 0;
    });
    if (breached) {
      throw new AppError(
        ErrorCode.WEAK_PASSWORD,
        400,
        'Bu şifre daha önce sızdırılmış şifreler arasında. Lütfen farklı bir şifre seçin.',
      );
    }
  }
}
