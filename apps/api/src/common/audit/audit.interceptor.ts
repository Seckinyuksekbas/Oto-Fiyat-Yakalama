import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { mergeMap, type Observable } from 'rxjs';
import { AUDIT_ACTION, type AuditedResult } from './audited.decorator';
import { AuditService } from './audit.service';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const action = this.reflector.get<string | undefined>(AUDIT_ACTION, ctx.getHandler());
    if (!action) return next.handle();
    const req = ctx.switchToHttp().getRequest<Request>();
    return next.handle().pipe(
      mergeMap(async (value: AuditedResult<unknown>) => {
        await this.audit.record({
          actorId: req.user?.id ?? null,
          action,
          targetType: value.audit.targetType,
          targetId: value.audit.targetId,
          before: value.audit.before,
          after: value.audit.after,
          ip: req.ip ?? null,
        });
        return value.result;
      }),
    );
  }
}
