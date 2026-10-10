export type Fuel = 'GASOLINE' | 'DIESEL' | 'LPG' | 'HYBRID' | 'ELECTRIC' | 'OTHER';
export type Transmission = 'MANUAL' | 'AUTOMATIC' | 'SEMI_AUTOMATIC';
export type SourceKind = 'HTTP' | 'BROWSER' | 'API' | 'FEED';

/** Adapter'ın kaynaktan çıkardığı ham ilan; metin alanları henüz ayrıştırılmamıştır. */
export interface RawListing {
  externalId: string;
  url: string;
  title: string;
  makeModelText: string;
  year: string | number;
  km: string | number;
  price: string | number;
  fuel: string;
  transmission: string;
  city?: string | null;
  imageUrl?: string | null;
  bodyType?: string | null;
  color?: string | null;
  sellerType?: string | null;
  damage?: {
    tramerAmount?: string | number | null;
    paintedParts?: string[];
    changedParts?: string[];
  } | null;
}

export interface DamageInfo {
  tramerAmount: number | null;
  paintedParts: string[];
  changedParts: string[];
}

export interface NormalizedListing {
  externalId: string;
  url: string;
  title: string;
  make: string;
  model: string;
  trim: string | null;
  year: number;
  km: number;
  price: bigint;
  currency: 'TRY';
  fuel: Fuel;
  transmission: Transmission;
  city: string | null;
  imageUrl: string | null;
  bodyType: string | null;
  color: string | null;
  sellerType: string | null;
  damageInfo: DamageInfo | null;
  contentHash: string;
}

/** Ayrıştırılamayan veya doğrulanamayan bir ilan; `ListingIssue` olarak saklanır. */
export interface ListingProblem {
  externalId?: string;
  field: string;
  problem: string;
  rawSnippet?: string;
}
