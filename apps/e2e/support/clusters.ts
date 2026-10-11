import type { InjectInput } from './demo';

/**
 * Her senaryo kendi marka/modelini kullanır; böylece bir senaryonun enjekte ettiği fırsat diğerinin profiline düşmez.
 * global-setup her küme için 10 piyasa fiyatlı emsal ekler; senaryo aynı özellikte %25 indirimli hedef ilan enjekte eder.
 */
const year = new Date().getFullYear() - 2;

export const CLUSTERS = {
  user: { make: 'Toyota', model: 'Corolla', trim: '1.8 Hybrid Flame', fuel: 'Hibrit', transmission: 'Otomatik', year, km: 40_000 },
  admin: { make: 'Honda', model: 'Civic', trim: '1.5 VTEC Elegance', fuel: 'Benzin', transmission: 'Otomatik', year, km: 50_000 },
} satisfies Record<string, InjectInput & { km: number }>;

/** Kümenin %25 indirimli, hasarsız hedef ilanı. */
export function dealFor(cluster: keyof typeof CLUSTERS): InjectInput {
  return { ...CLUSTERS[cluster], discount: 0.25, tramerAmount: null, paintedParts: [], changedParts: [] };
}
