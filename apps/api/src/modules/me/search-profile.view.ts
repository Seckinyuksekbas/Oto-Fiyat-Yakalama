import type { SearchProfile } from '@oto/db';

export interface SearchProfileView {
  id: string;
  name: string;
  status: string;
  make: string | null;
  model: string | null;
  yearMin: number | null;
  yearMax: number | null;
  priceMin: string | null;
  priceMax: string | null;
  kmMax: number | null;
  fuels: string[];
  transmissions: string[];
  cities: string[];
  minDiscountPct: number;
  minConfidence: string;
  excludeDamaged: boolean;
  notifyOnPriceDrop: boolean;
  priceDropPct: number;
  notifyOnRelist: boolean;
  channels: string[];
  createdAt: Date;
  updatedAt: Date;
}

export function toSearchProfileView(p: SearchProfile): SearchProfileView {
  return {
    id: p.id, name: p.name, status: p.status, make: p.make, model: p.model, yearMin: p.yearMin, yearMax: p.yearMax,
    priceMin: p.priceMin?.toString() ?? null, priceMax: p.priceMax?.toString() ?? null, kmMax: p.kmMax,
    fuels: p.fuels, transmissions: p.transmissions, cities: p.cities, minDiscountPct: Number(p.minDiscountPct),
    minConfidence: p.minConfidence, excludeDamaged: p.excludeDamaged, notifyOnPriceDrop: p.notifyOnPriceDrop,
    priceDropPct: Number(p.priceDropPct), notifyOnRelist: p.notifyOnRelist, channels: p.channels,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}
