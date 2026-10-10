import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@oto/shared';
import type { Request } from 'express';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { SKIP_CSRF } from '../decorators/skip-csrf';
import { AppError } from '../errors/app-error';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowedOrigin: string;

  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) env: Env,
  ) {
    this.allowedOrigin = new URL(env.PUBLIC_BASE_URL).origin;
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (SAFE.has(req.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, [ctx.getHandler(), ctx.getClass()])) return true;
    const origin = req.headers.origin;
    const originOk = origin === undefined || safeOrigin(origin) === this.allowedOrigin;
    if (!req.headers['x-requested-with'] || !originOk) {
      throw new AppError(ErrorCode.CSRF_REJECTED, 403, 'İstek doğrulanamadı');
    }
    return true;
  }
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
