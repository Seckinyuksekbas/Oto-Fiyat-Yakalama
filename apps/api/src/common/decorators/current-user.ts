import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../../modules/auth/auth-user';
import { Errors } from '../errors/app-error';

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.user) throw Errors.unauthenticated();
  return req.user;
});
