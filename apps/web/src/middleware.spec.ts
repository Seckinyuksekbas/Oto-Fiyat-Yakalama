import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { config, middleware } from './middleware';

const req = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: cookie ? { cookie } : {} });

describe('middleware', () => {
  it('matches /app only', () => {
    expect(config.matcher).toEqual(['/app/:path*']);
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
