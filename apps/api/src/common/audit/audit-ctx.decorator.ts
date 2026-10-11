import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AUDIT_ACTION } from './audited.decorator';
import { Errors } from '../errors/app-error';

export interface AuditCtx {
  actorId: string;
  ip: string | null;
  action: string;
}

/** Handler'ın @Audited aksiyonunu ve req.user/req.ip'yi okur; @Audited yoksa programlama hatası olarak fırlatır. */
export const AuditCtx = createParamDecorator((_: unknown, ctx: ExecutionContext): AuditCtx => {
  const action = Reflect.getMetadata(AUDIT_ACTION, ctx.getHandler()) as string | undefined;
  if (!action) throw new Error('@AuditCtx() yalnızca @Audited(action) olan handler\'larda kullanılabilir');
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.user) throw Errors.unauthenticated();
  return { actorId: req.user.id, ip: req.ip ?? null, action };
});
