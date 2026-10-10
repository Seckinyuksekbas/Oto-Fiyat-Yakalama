import { z } from 'zod';

export const planLimitsSchema = z.object({
  maxSearchProfiles: z.number().int().min(0),
  maxNotificationsPerDay: z.number().int().min(0),
  channels: z.array(z.enum(['IN_APP', 'TELEGRAM', 'EMAIL'])).min(1),
  opportunitiesDelayHours: z.number().int().min(0),
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;

export const limitOverridesSchema = planLimitsSchema.partial();

/** Plan limitlerine kullanıcıya özel geçersiz kılmaları uygular; geçersiz kılma bozuksa plan limitleri aynen döner. */
export function effectiveLimits(limits: PlanLimits, overrides: unknown): PlanLimits {
  if (overrides === null || overrides === undefined) return limits;
  const parsed = limitOverridesSchema.safeParse(overrides);
  if (!parsed.success) return limits;
  return { ...limits, ...Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) };
}
