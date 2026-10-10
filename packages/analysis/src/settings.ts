import { z } from 'zod';

export const analysisSettingsSchema = z
  .object({
    minComparables: z.number().int().min(2).max(50).default(5),
    yearAdjPct: z.number().min(0).max(0.3).default(0.07),
    kmAdjPer10k: z.number().min(0).max(0.2).default(0.02),
    maxAdjPct: z.number().min(0).max(0.5).default(0.2),
    theilSenMinPool: z.number().int().min(3).max(200).default(8),
    smallPoolMax: z.number().int().min(0).max(50).default(7),
    dispersionThreshold: z.number().min(0).max(2).default(0.25),
    suspiciousDiscount: z.number().min(0).max(1).default(0.45),
    poolWindowDays: z.number().int().min(7).max(365).default(60),
    refreshMinChangePct: z.number().min(0).max(1).default(0.02),
  })
  .strict();

export type AnalysisSettings = z.infer<typeof analysisSettingsSchema>;

export const DEFAULT_SETTINGS: AnalysisSettings = analysisSettingsSchema.parse({});
