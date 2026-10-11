import { maskUrlQuery } from '@oto/shared';

/** Herhangi bir şemadaki URL'nin sorgu dizisini/parçasını `?…` ile maskeler (http(s) için paylaşılan yardımcı). */
function maskAnyUrl(url: string): string {
  if (/^https?:/i.test(url)) return maskUrlQuery(url);
  const q = url.search(/[?#]/);
  return q === -1 ? url : `${url.slice(0, q)}?…`;
}

/**
 * Serbest metindeki her şemanın (postgres://, redis://, http://…) kimlik bilgisini `***@` yapar ve
 * URL sorgu dizilerini `?…` ile maskeler.
 */
export function maskUrlsInText<T extends string | null | undefined>(text: T): T {
  if (!text) return text;
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, (u) => maskAnyUrl(u)) as T;
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
