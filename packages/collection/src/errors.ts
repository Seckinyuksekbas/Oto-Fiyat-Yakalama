export type FetchErrorKind = 'NETWORK' | 'TIMEOUT' | 'HTTP_4XX' | 'HTTP_5XX' | 'BLOCKED';

export class FetchError extends Error {
  constructor(
    readonly kind: FetchErrorKind,
    message: string,
    readonly url: string | null,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

/** Kaynak bizi engelledi (403, captcha, robots). Asla yeniden denenmez; kaynak duraklatılır. */
export class BlockedError extends FetchError {
  constructor(message: string, url: string | null) {
    super('BLOCKED', message, url, false);
    this.name = 'BlockedError';
  }
}

/** guardedLookup'ın işaretlediği hata kodu: iç ağ adresi, yeniden denenmez. */
export const PRIVATE_ADDRESS_CODE = 'OTO_PRIVATE_ADDRESS';

const TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

export function toFetchError(err: unknown, url: string): FetchError {
  if (err instanceof FetchError) return err;
  const code = (err as { code?: string } | null)?.code ?? '';
  if (code === PRIVATE_ADDRESS_CODE) return new FetchError('NETWORK', `İç ağ adresine bağlanılamaz: ${url}`, url, false);
  if (TIMEOUT_CODES.has(code)) return new FetchError('TIMEOUT', `Zaman aşımı (${code}): ${url}`, url, true);
  const detail = code || (err instanceof Error ? err.message : String(err));
  return new FetchError('NETWORK', `Ağ hatası (${detail}): ${url}`, url, true);
}

/** Sayfa yapısı tanınmadı (beklenen işaretçi yok). Yeniden denemekle düzelmez; kaynak hemen DEGRADED sayılır. */
export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutError';
  }
}
