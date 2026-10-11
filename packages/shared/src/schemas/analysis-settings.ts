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

export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = analysisSettingsSchema.parse({});

/**
 * Admin PATCH için: kısmi geçersiz kılma, varsayılanlarla birleştirildiğinde çapraz alan kurallarını sağlamalı.
 * (Motor kayıtlı ayarları kendi şemasıyla ayrıştırır; bu kurallar yalnızca yönetici girişini denetler.)
 */
export const analysisSettingsPatchSchema = analysisSettingsSchema
  .partial()
  .strict()
  .superRefine((patch, ctx) => {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const merged = { ...DEFAULT_ANALYSIS_SETTINGS, ...defined };
    if (merged.smallPoolMax < merged.minComparables) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['smallPoolMax'],
        message: 'smallPoolMax, minComparables değerinden küçük olamaz',
      });
    }
    if (merged.theilSenMinPool < merged.minComparables) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['theilSenMinPool'],
        message: 'theilSenMinPool, minComparables değerinden küçük olamaz',
      });
    }
  });
