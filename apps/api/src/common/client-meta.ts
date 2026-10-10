import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

export const Meta = createParamDecorator((_: unknown, ctx: ExecutionContext): ClientMeta => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return { ip: req.ip ?? null, userAgent: req.headers['user-agent']?.slice(0, 255) ?? null };
});
