import { randomBytes } from 'node:crypto';
import { expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { randomChatId, telegram } from './demo';
import { API_URL } from './env';
import { extractLink, latestMessageText } from './mailpit';

export function randomUser(prefix: string): { name: string; email: string; password: string } {
  const id = randomBytes(5).toString('hex');
  return { name: `E2E ${prefix}`, email: `e2e-${prefix}-${id}@example.com`, password: `${randomBytes(12).toString('base64url')}-Aa1` };
}

/** Mailpit'te alıcıya gelen doğrulama bağlantısını bekler ve döndürür. */
export async function waitForVerifyLink(email: string): Promise<string> {
  let link: string | null = null;
  await expect
    .poll(
      async () => {
        const text = await latestMessageText(email);
        link = text ? extractLink(text, '/verify-email') : null;
        return link;
      },
      { message: `doğrulama e-postası (${email})`, timeout: 30_000 },
    )
    .not.toBeNull();
  return link!;
}

export async function loginViaUi(page: Page, email: string, password: string, expectUrl: RegExp = /\/app(\/|$|\?)/): Promise<void> {
  await page.goto('/giris');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill(password);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page).toHaveURL(expectUrl);
}

/**
 * API'ye doğrudan (127.0.0.1:3101) konuşan, çerezli istek bağlamı. Origin başlığı gönderilmez (CSRF guard'ı
 * Origin yokken yalnızca X-Requested-With ister). Yalnızca senaryonun odağı olmayan hazırlık adımları için.
 */
export async function apiContext(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: `${API_URL}/api/v1/`, extraHTTPHeaders: { 'X-Requested-With': 'XMLHttpRequest' } });
}

/** API'ye çağrı; 2xx değilse gövdeyle birlikte hata fırlatır. */
export async function apiCall<T>(ctx: APIRequestContext, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<T> {
  const res = await ctx.fetch(path, { method, data });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export interface LinkedUser {
  id: string;
  email: string;
  password: string;
  chatId: number;
  api: APIRequestContext;
}

/** Hazırlık: kayıt + Mailpit doğrulama + oturum (API üzerinden). */
export async function createVerifiedUser(prefix: string): Promise<{ email: string; password: string; api: APIRequestContext }> {
  const u = randomUser(prefix);
  const api = await apiContext();
  await apiCall(api, 'POST', 'auth/register', { name: u.name, email: u.email, password: u.password, kvkkAccepted: true });
  const link = await waitForVerifyLink(u.email);
  const token = new URL(link).searchParams.get('token');
  await apiCall(api, 'POST', 'auth/verify-email', { token });
  await apiCall(api, 'POST', 'auth/login', { email: u.email, password: u.password });
  return { email: u.email, password: u.password, api };
}

/**
 * Hazırlık: kayıt + Mailpit doğrulama + sahte Telegram'da /start ile bağlama + profil (API üzerinden).
 * Kullanıcı arayüzü akışı user-journey'de ayrıca test edilir.
 */
export async function createLinkedUser(prefix: string, profile: { make: string; model: string }): Promise<LinkedUser> {
  const u = await createVerifiedUser(prefix);
  const api = u.api;

  const { deepLink } = await apiCall<{ deepLink: string }>(api, 'POST', 'me/channels/telegram/link');
  const code = new URL(deepLink).searchParams.get('start')!;
  const chatId = randomChatId();
  await telegram.pushStart(chatId, code);
  await expect
    .poll(
      async () => {
        const r = await apiCall<{ items: Array<{ type: string; isVerified: boolean }> }>(api, 'GET', 'me/channels');
        return r.items.find((c) => c.type === 'TELEGRAM')?.isVerified ?? false;
      },
      { message: 'Telegram bağlantısı', timeout: 30_000 },
    )
    .toBe(true);

  await apiCall(api, 'POST', 'me/search-profiles', {
    name: `${profile.make} ${profile.model} e2e`,
    make: profile.make,
    model: profile.model,
    minDiscountPct: 0.1,
    minConfidence: 'LOW',
    channels: ['IN_APP', 'TELEGRAM'],
  });
  const me = await apiCall<{ user: { id: string } }>(api, 'GET', 'me');
  return { id: me.user.id, email: u.email, password: u.password, chatId, api };
}
