import { NextResponse, type NextRequest } from 'next/server';

/**
 * Not: refresh_token çerezi yalnızca /api/v1/auth yoluna kısıtlı olduğundan /app isteklerinde gelmez.
 * Bu yüzden yalnızca access_token'a bakılır (/app ve /admin); yoksa giriş sayfası try_refresh=1 ile önce
 * istemci tarafında oturumu yenilemeyi dener.
 */
export function middleware(req: NextRequest) {
  if (req.cookies.has('access_token')) return NextResponse.next();
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

/** `/admin` yalnızca oturum varlığına bakar; rol denetimi istemcide (404 görünümü) ve API'de (403) yapılır. */
export const config = { matcher: ['/app/:path*', '/admin/:path*'] };
