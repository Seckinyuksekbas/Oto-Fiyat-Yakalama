import { z } from 'zod';

export const planLimitsSchema = z.object({
  maxSearchProfiles: z.number().int().min(0),
  maxNotificationsPerDay: z.number().int().min(0),
  channels: z.array(z.enum(['IN_APP', 'TELEGRAM', 'EMAIL'])).min(1),
  opportunitiesDelayHours: z.number().int().min(0),
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;

export const limitOverridesSchema = planLimitsSchema.partial();

/**
 * Paket ve kullanıcıya özel limitlerin makul üst sınırları: yanlış girişin (ör. fazladan sıfır) limit sistemini fiilen
 * kapatmasını önler. API (paket ve abonelik gövdeleri) ve web formları aynı değerleri kullanır.
 */
export const PLAN_MAXIMA = {
  priceMonthly: 10_000_000,
  maxSearchProfiles: 1000,
  maxNotificationsPerDay: 100_000,
  opportunitiesDelayHours: 720,
} as const;

export const PLAN_LIMIT_MAX_KEYS = ['maxSearchProfiles', 'maxNotificationsPerDay', 'opportunitiesDelayHours'] as const;

/** `limits` (tam ya da kısmi) için üst sınır ve kanal tekrarı denetimi; sorun yolları `prefix` altında. */
export function checkLimitMaxima(l: Partial<PlanLimits> | null | undefined, ctx: z.RefinementCtx, prefix: (string | number)[] = []): void {
  if (!l) return;
  for (const k of PLAN_LIMIT_MAX_KEYS) {
    const v = l[k];
    if (v !== undefined && v > PLAN_MAXIMA[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...prefix, k], message: `En fazla ${PLAN_MAXIMA[k]}` });
  }
  if (l.channels && new Set(l.channels).size !== l.channels.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...prefix, 'channels'], message: 'Kanallar tekrarlanamaz' });
  }
}

/** Paket gövdesi (oluşturma/güncelleme) için: fiyat tam sayı ve üst sınır, limit üst sınırları. */
export function checkPlanMaxima(p: { priceMonthly?: number; limits?: PlanLimits }, ctx: z.RefinementCtx): void {
  if (p.priceMonthly !== undefined) {
    if (!Number.isInteger(p.priceMonthly)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['priceMonthly'], message: 'Fiyat tam sayı olmalı' });
    if (p.priceMonthly > PLAN_MAXIMA.priceMonthly) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['priceMonthly'], message: `En fazla ${PLAN_MAXIMA.priceMonthly}` });
  }
  checkLimitMaxima(p.limits, ctx, ['limits']);
}

/** Plan limitlerine kullanıcıya özel geçersiz kılmaları uygular; geçersiz kılma bozuksa plan limitleri aynen döner. */
export function effectiveLimits(limits: PlanLimits, overrides: unknown): PlanLimits {
  if (overrides === null || overrides === undefined) return limits;
  const parsed = limitOverridesSchema.safeParse(overrides);
  if (!parsed.success) return limits;
  return { ...limits, ...Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) };
}
