import type { CookieOptions, Response } from 'express';
import type { Env } from '../../config/env';
import { ACCESS_COOKIE, ACCESS_TTL_SEC, REFRESH_COOKIE, REFRESH_PATH, REFRESH_TTL_MS } from './auth.constants';

function base(env: Env): CookieOptions {
  return { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax' };
}

export function setAuthCookies(res: Response, env: Env, access: string, refresh: string): void {
  res.cookie(ACCESS_COOKIE, access, { ...base(env), path: '/', maxAge: ACCESS_TTL_SEC * 1000 });
  res.cookie(REFRESH_COOKIE, refresh, { ...base(env), path: REFRESH_PATH, maxAge: REFRESH_TTL_MS });
}

export function clearAuthCookies(res: Response, env: Env): void {
  res.clearCookie(ACCESS_COOKIE, { ...base(env), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base(env), path: REFRESH_PATH });
}
