import { z } from 'zod';

/**
 * Web sürecinin (Next.js sunucu tarafı) ortam değişkenleri. Tek doğruluk kaynağı:
 * next.config.ts (derleme) ve src/instrumentation.ts (sunucu açılışı) bunu kullanır.
 */
const webEnvSchema = z.object({
  API_ORIGIN: z
    .string()
    .url()
    .refine((v) => URL.canParse(v) && ['http:', 'https:'].includes(new URL(v).protocol), 'http(s) adresi olmalı')
    .transform((v) => v.replace(/\/+$/, ''))
    .default('http://localhost:3001'),
});
export type WebEnv = z.infer<typeof webEnvSchema>;

export function parseWebEnv(source: Record<string, string | undefined>): WebEnv {
  const result = webEnvSchema.safeParse(source);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  return result.data;
}
