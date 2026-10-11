import { NextResponse, type NextRequest } from 'next/server';

/**
 * Not: refresh_token çerezi yalnızca /api/v1/auth yoluna kısıtlı olduğundan /app isteklerinde gelmez.
 * Bu yüzden yalnızca access_token'a bakılır; yoksa giriş sayfası try_refresh=1 ile önce
 * istemci tarafında oturumu yenilemeyi dener.
 */
export function middleware(req: NextRequest) {
  if (req.cookies.has('access_token')) return NextResponse.next();
  const url = req.nextUrl.clone();
  const next = req.nextUrl.pathname + req.nextUrl.search;
  url.pathname = '/giris';
  url.search = '';
  url.searchParams.set('next', next);
  url.searchParams.set('try_refresh', '1');
  return NextResponse.redirect(url, 307);
}

export const config = { matcher: ['/app/:path*'] };
