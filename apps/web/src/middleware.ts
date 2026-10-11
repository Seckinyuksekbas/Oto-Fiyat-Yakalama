import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, generateNonce, parseCspOrigins } from '@/lib/csp';

const PROTECTED = ['/app', '/admin'];

let imgExtraCache: { raw: string | undefined; origins: string[] } | undefined;

/**
 * `CSP_IMG_EXTRA` çalışma zamanında okunur (derlemeye gömülmez; `next start` ve standalone `server.js`
 * middleware'e süreç env'ini verir). Geçersiz değer açılışta `instrumentation.ts` tarafından reddedilir;
 * burada yine de istek düşürülmez, ek origin eklenmez.
 */
function imgExtra(): string[] {
  const raw = process.env.CSP_IMG_EXTRA;
  if (!imgExtraCache || imgExtraCache.raw !== raw) {
    let origins: string[] = [];
    try {
      origins = parseCspOrigins(raw);
    } catch {
      origins = [];
    }
    imgExtraCache = { raw, origins };
  }
  return imgExtraCache.origins;
}

function isProtected(pathname: string): boolean {
  return PROTECTED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Not: refresh_token çerezi yalnızca /api/v1/auth yoluna kısıtlı olduğundan /app isteklerinde gelmez.
 * Bu yüzden yalnızca access_token'a bakılır (/app ve /admin); yoksa giriş sayfası try_refresh=1 ile önce
 * istemci tarafında oturumu yenilemeyi dener.
 */
function authRedirect(req: NextRequest): NextResponse {
  const url = req.nextUrl.clone();
  // `_r=1`: giriş sayfası zaten bir kez yenileme yaptı ama çerez oturmadı → döngüyü kır.
  const retried = req.nextUrl.searchParams.has('_r');
  const back = req.nextUrl.clone();
  back.searchParams.delete('_r');
  const next = back.pathname + back.search;
  url.pathname = '/giris';
  url.search = '';
  url.searchParams.set('next', next);
  if (retried) url.searchParams.set('reason', 'failed');
  else url.searchParams.set('try_refresh', '1');
  return NextResponse.redirect(url, 307);
}

/**
 * 1) /app ve /admin: oturum (access_token) yoksa girişe yönlendir. `/admin` yalnızca oturum varlığına bakar;
 *    rol denetimi istemcide (404 görünümü) ve API'de (403) yapılır.
 * 2) Tüm sayfalar: istek başına nonce'lu CSP. Next, istek başlığındaki CSP'den nonce'u okuyup kendi satır içi
 *    betiklerine (`self.__next_f.push`) uygular; kök layout `x-nonce` ile tema betiğine verir. Sonuç: sayfalar
 *    statik değil dinamik render edilir (nonce her istekte farklı) — bilinçli karar, bkz. docs/web.md.
 */
export function middleware(req: NextRequest) {
  if (isProtected(req.nextUrl.pathname) && !req.cookies.has('access_token')) return authRedirect(req);

  const nonce = generateNonce();
  const csp = buildCsp({ dev: process.env.NODE_ENV !== 'production', nonce, imgExtra: imgExtra() });
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set('content-security-policy', csp);
  return res;
}

/**
 * `/api` (aynı kökenli rewrite, SSE dahil) ve Next statik varlıkları hariç her yol. Prefetch (RSC) istekleri
 * de eşleşir ve CSP alır: zararsız (RSC yükü betik çalıştırmaz), ayrı `missing` kuralı bilinçli olarak eklenmedi.
 */
export const config = { matcher: ['/((?!api/|_next/static|_next/image|favicon.ico).*)'] };
