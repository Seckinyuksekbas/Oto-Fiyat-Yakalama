import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ACCESS_COOKIE } from '../../modules/auth/auth.constants';
import { TokenService } from '../../modules/auth/token.service';
import { IS_PUBLIC } from '../decorators/public';
import { Errors } from '../errors/app-error';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token: unknown = req.cookies?.[ACCESS_COOKIE];
    if (typeof token === 'string' && token.length > 0) {
      const claims = await this.tokens.verifyAccess(token);
      if (claims) req.user = { id: claims.userId, role: claims.role, sessionId: claims.sessionId };
    }
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (!isPublic && !req.user) throw Errors.unauthenticated();
    return true;
  }
}
