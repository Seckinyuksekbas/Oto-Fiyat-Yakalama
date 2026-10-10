import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ErrorCode } from '@oto/shared';
import { AppError } from '../errors/app-error';

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { id?: string } | undefined;
    return user?.id ? `u:${user.id}` : `ip:${String(req.ip)}`;
  }

  protected override async throwThrottlingException(): Promise<void> {
    throw new AppError(ErrorCode.RATE_LIMITED, 429, 'Çok fazla istek. Lütfen biraz bekleyin.');
  }
}
