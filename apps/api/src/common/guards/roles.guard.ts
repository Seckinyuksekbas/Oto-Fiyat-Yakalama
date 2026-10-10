import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@oto/db';
import type { Request } from 'express';
import { PrismaService } from '../../infra/prisma.service';
import { ROLES } from '../decorators/roles';
import { Errors } from '../errors/app-error';

/** @Roles olan uç noktalarda token'a güvenmez: oturum ailesi, kullanıcı durumu ve rol DB'den okunur. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (!roles?.length) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const user = req.user;
    if (!user) throw Errors.unauthenticated();
    const session = await this.prisma.session.findFirst({
      where: { familyId: user.sessionId, userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { user: { select: { role: true, status: true } } },
    });
    if (!session || session.user.status !== 'ACTIVE') throw Errors.unauthenticated();
    if (!roles.includes(session.user.role)) throw Errors.forbidden();
    req.user = { ...user, role: session.user.role };
    return true;
  }
}
