/** Sıralı dizide doğrusal enterpolasyonlu quantile (R tip 7). */
export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) throw new Error('quantile: boş dizi');
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('quantile: p 0..1 aralığında olmalı');
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values: number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

const THEIL_SEN_MAX_POINTS = 300;

/** Uç değerlere dayanıklı eğim: ikili eğimlerin medyanı. Büyük girdide deterministik örnekleme yapar. */
export function theilSenSlope(points: { x: number; y: number }[]): number | null {
  let pts = points;
  if (pts.length > THEIL_SEN_MAX_POINTS) {
    const step = pts.length / THEIL_SEN_MAX_POINTS;
    pts = Array.from({ length: THEIL_SEN_MAX_POINTS }, (_, i) => points[Math.floor(i * step)]);
  }
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].x - pts[i].x;
      if (dx !== 0) slopes.push((pts[j].y - pts[i].y) / dx);
    }
  }
  return slopes.length === 0 ? null : median(slopes);
}
