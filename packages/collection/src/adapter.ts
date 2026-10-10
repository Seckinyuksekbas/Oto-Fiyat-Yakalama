import type { HttpFetcher } from './http-client';
import type { ListingProblem, RawListing, SourceKind } from './types';

export interface ListPage {
  url: string;
  pageNo: number;
  html: string;
  /** Kaynağın son sayfası mı? Yalnızca tam taramada kaybolan ilanlar REMOVED yapılır. */
  isLast: boolean;
}

export interface ParseResult {
  listings: RawListing[];
  problems: ListingProblem[];
}

export interface AdapterContext {
  http: HttpFetcher;
  /** DataSource.config (JSON) — adapter kendi şemasıyla doğrular. */
  config: unknown;
}

/** Yeni kaynak = bu arayüzü uygulayan yeni bir sınıf + registry'de bir satır. */
export interface SourceAdapter {
  readonly key: string;
  readonly kind: SourceKind;
  listPages(ctx: AdapterContext): AsyncIterable<ListPage>;
  parseList(page: ListPage): ParseResult;
  isBlockedPage?(html: string): boolean;
}
