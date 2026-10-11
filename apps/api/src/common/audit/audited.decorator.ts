import { SetMetadata } from '@nestjs/common';

export const AUDIT_ACTION = 'audit:action';
/**
 * Yalnızca meta veri: mutasyon route'unun denetim aksiyonunu bildirir (kapsama testi + @AuditCtx).
 * Denetim kaydı servis içinde, mutasyonla aynı transaction'da AuditService.recordInTx ile yazılır.
 */
export const Audited = (action: string) => SetMetadata(AUDIT_ACTION, action);
