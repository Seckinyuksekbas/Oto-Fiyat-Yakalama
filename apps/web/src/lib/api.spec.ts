import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/server';
import { ApiError, apiFetch, setSessionExpiredHandler } from './api';

afterEach(() => setSessionExpiredHandler(null));

const unauth = () =>
  HttpResponse.json({ error: { code: 'UNAUTHENTICATED', message: '' } }, { status: 401 });

describe('apiFetch', () => {
  it('sends credentials, X-Requested-With on mutations and JSON body', async () => {
    let seen: Request | undefined;
    server.use(
      http.post('/api/v1/me/search-profiles', ({ request }) => {
        seen = request;
        return HttpResponse.json({ id: 'p1' }, { status: 201 });
      }),
    );
    await apiFetch('/me/search-profiles', { method: 'POST', json: { name: 'x' } });
    expect(seen?.headers.get('x-requested-with')).toBe('XMLHttpRequest');
    expect(await seen?.json()).toEqual({ name: 'x' });
  });

  it('does not send X-Requested-With on GET and serialises query', async () => {
    let seen: Request | undefined;
    server.use(
      http.get('/api/v1/catalog/makes', ({ request }) => {
        seen = request;
        return HttpResponse.json([]);
      }),
    );
    await apiFetch('/catalog/makes', { query: { q: 'a b', limit: 5, skip: undefined } });
    expect(seen?.headers.get('x-requested-with')).toBeNull();
    expect(new URL(seen!.url).search).toBe('?q=a+b&limit=5');
  });

  it('returns undefined on 204', async () => {
    server.use(http.post('/api/v1/auth/logout', () => new HttpResponse(null, { status: 204 })));
    await expect(apiFetch('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('maps error bodies to ApiError', async () => {
    server.use(
      http.get('/api/v1/me', () =>
        HttpResponse.json({ error: { code: 'LIMIT_REACHED', message: 'Sınır', details: { limit: 2 } } }, { status: 403 }),
      ),
    );
    await expect(apiFetch('/me')).rejects.toMatchObject({ status: 403, code: 'LIMIT_REACHED', details: { limit: 2 } });
  });

  it('on 401 refreshes once (single flight) and retries', async () => {
    let refreshes = 0;
    let calls = 0;
    server.use(
      http.get('/api/v1/me', () => (++calls === 1 ? unauth() : HttpResponse.json({ ok: true }))),
      http.get('/api/v1/me/dashboard', () => (calls < 2 ? unauth() : HttpResponse.json({ ok: 2 }))),
      http.post('/api/v1/auth/refresh', () => {
        refreshes += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await Promise.all([apiFetch('/me'), apiFetch('/me/dashboard')]);
    expect(refreshes).toBe(1);
  });

  it('retries refresh once after 300 ms on REFRESH_RACE', async () => {
    let refreshes = 0;
    let calls = 0;
    server.use(
      http.get('/api/v1/me', () => (++calls === 1 ? unauth() : HttpResponse.json({ ok: true }))),
      http.post('/api/v1/auth/refresh', () => {
        refreshes += 1;
        return refreshes === 1
          ? HttpResponse.json({ error: { code: 'REFRESH_RACE', message: '' } }, { status: 401 })
          : new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(apiFetch('/me')).resolves.toEqual({ ok: true });
    expect(refreshes).toBe(2);
  });

  it('redirects to login with next when refresh fails, without looping', async () => {
    const onExpired = vi.fn();
    setSessionExpiredHandler(onExpired);
    let meCalls = 0;
    server.use(
      http.get('/api/v1/me', () => {
        meCalls += 1;
        return unauth();
      }),
      http.post('/api/v1/auth/refresh', () =>
        HttpResponse.json({ error: { code: 'TOKEN_INVALID', message: '' } }, { status: 401 }),
      ),
    );
    await expect(apiFetch('/me')).rejects.toBeInstanceOf(ApiError);
    expect(onExpired).toHaveBeenCalledOnce();
    expect(meCalls).toBe(1);
  });

  it('retries only once when the retried request is still 401', async () => {
    const onExpired = vi.fn();
    setSessionExpiredHandler(onExpired);
    let calls = 0;
    server.use(
      http.get('/api/v1/me', () => {
        calls += 1;
        return unauth();
      }),
      http.post('/api/v1/auth/refresh', () => new HttpResponse(null, { status: 204 })),
    );
    await expect(apiFetch('/me')).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(2);
    expect(onExpired).toHaveBeenCalledOnce();
  });
});
