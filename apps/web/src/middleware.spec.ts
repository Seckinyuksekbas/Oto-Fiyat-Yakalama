import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { config, middleware } from './middleware';

const req = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: cookie ? { cookie } : {} });

function scriptSrc(csp: string | null): string {
  return (csp ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src')) ?? '';
}

describe('middleware', () => {
  it('matches every page (CSP) but skips the /api rewrite and Next static assets', () => {
    const [pattern] = config.matcher;
    const re = new RegExp(`^${pattern}$`);
    for (const p of ['/', '/giris', '/app', '/app/firsatlar', '/admin/kullanicilar']) expect(re.test(p)).toBe(true);
    for (const p of ['/api/v1/me/stream', '/_next/static/chunks/main.js', '/_next/image', '/favicon.ico']) {
      expect(re.test(p)).toBe(false);
    }
  });

  it('does not treat lookalike paths as protected', () => {
    expect(middleware(req('/application')).headers.get('location')).toBeNull();
    expect(middleware(req('/administrator')).headers.get('location')).toBeNull();
  });

  it('redirects /admin without a cookie to login and keeps next', () => {
    const res = middleware(req('/admin/kullanicilar?status=SUSPENDED'));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/giris');
    expect(loc.searchParams.get('next')).toBe('/admin/kullanicilar?status=SUSPENDED');
  });

  it('redirects to login with next and try_refresh when access_token is missing', () => {
    const res = middleware(req('/app/firsatlar?sayfa=2'));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/giris');
    expect(loc.searchParams.get('next')).toBe('/app/firsatlar?sayfa=2');
    expect(loc.searchParams.get('try_refresh')).toBe('1');
  });

  it('passes through when access_token is present', () => {
    const res = middleware(req('/app', 'access_token=abc'));
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('bounds the refresh attempt: with _r=1 and no cookie it drops try_refresh', () => {
    const res = middleware(req('/app/firsatlar?sayfa=2&_r=1'));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/giris');
    expect(loc.searchParams.get('next')).toBe('/app/firsatlar?sayfa=2');
    expect(loc.searchParams.has('try_refresh')).toBe(false);
    expect(loc.searchParams.get('reason')).toBe('failed');
  });

  it('lets _r=1 through when the cookie is present', () => {
    const res = middleware(req('/app?_r=1', 'access_token=abc'));
    expect(res.headers.get('location')).toBeNull();
  });

  it('bounds the refresh attempt: with _r=1 and no cookie it drops try_refresh', () => {
    const res = middleware(req('/app/firsatlar?sayfa=2&_r=1'));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/giris');
    expect(loc.searchParams.get('next')).toBe('/app/firsatlar?sayfa=2');
    expect(loc.searchParams.has('try_refresh')).toBe(false);
    expect(loc.searchParams.get('reason')).toBe('failed');
  });

  it('lets _r=1 through when the cookie is present', () => {
    const res = middleware(req('/app?_r=1', 'access_token=abc'));
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('middleware: CSP nonce', () => {
  it('sets a nonce-bearing CSP on public pages and forwards it to the renderer', () => {
    const res = middleware(req('/giris'));
    const csp = res.headers.get('content-security-policy');
    const nonce = /'nonce-([^']+)'/.exec(scriptSrc(csp))?.[1];
    expect(nonce).toBeTruthy();
    expect(scriptSrc(csp)).not.toContain("'unsafe-inline'");
    // Next, değiştirilmiş istek başlıklarını x-middleware-request-* olarak taşır.
    expect(res.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
  });

  it('uses a different nonce per request', () => {
    const a = middleware(req('/')).headers.get('content-security-policy');
    const b = middleware(req('/')).headers.get('content-security-policy');
    expect(a).not.toBe(b);
  });

  it('still lets an authenticated /app request through with a CSP', () => {
    const res = middleware(req('/app/firsatlar', 'access_token=abc'));
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-security-policy')).toContain("'nonce-");
  });
});
