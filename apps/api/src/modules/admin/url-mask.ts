import { maskUrlQuery } from '@oto/shared';

/** Serbest metindeki http(s) URL'lerinin sorgu dizisini `?…` ile maskeler. */
export function maskUrlsInText<T extends string | null | undefined>(text: T): T {
  if (!text) return text;
  return text.replace(/https?:\/\/[^\s"'<>)]+/gi, (u) => maskUrlQuery(u)) as T;
}

/** Proxy URL'sini kimlik bilgisi içermeyecek biçimde `http://***@host:port` olarak maskeler. */
export function maskProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//***@${u.host}`;
  } catch {
    return '[geçersiz URL]';
  }
}
