import { SetMetadata } from '@nestjs/common';

export const AUDIT_ACTION = 'audit:action';
/** İşaretli handler AuditedResult döndürmelidir; interceptor log yazar ve yalnızca `result`'ı istemciye iletir. */
export const Audited = (action: string) => SetMetadata(AUDIT_ACTION, action);

export interface AuditedResult<T> {
  result: T;
  audit: { targetType: string; targetId: string; before?: unknown; after?: unknown };
}
