import { z } from 'zod';

export const planLimitsSchema = z.object({
  maxSearchProfiles: z.number().int().min(0),
  maxNotificationsPerDay: z.number().int().min(0),
  channels: z.array(z.enum(['IN_APP', 'TELEGRAM', 'EMAIL'])).min(1),
  opportunitiesDelayHours: z.number().int().min(0),
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;
