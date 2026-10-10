import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TelegramApiError, TelegramClient } from './client';
import { FakeTelegramApi } from './fake-bot-api';

let fake: FakeTelegramApi;
let client: TelegramClient;
let baseUrl = ''

beforeAll(async () => {
  fake = new FakeTelegramApi();
  const { apiBase, token } = await fake.start();
  baseUrl = apiBase;
  client = new TelegramClient({ token, apiBase, timeoutMs: 2000 });
});
afterAll(async () => fake.close());

describe('TelegramClient', () => {
  it('posts JSON and returns result', async () => {
    await client.sendMessage(42, 'merhaba', { inline_keyboard: [[{ text: 'x', callback_data: 'fav:1' }]] });
    expect(fake.requests.at(-1)).toEqual({ method: 'sendMessage', body: { chat_id: 42, text: 'merhaba', parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: 'fav:1' }]] } } });
  });
  it('maps API errors without leaking the token', async () => {
    fake.respondNext('sendMessage', { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } } });
    const err = await client.sendMessage(42, 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(err).toMatchObject({ status: 429, retryAfterSec: 3, method: 'sendMessage' });
    expect(String((err as Error).message)).not.toContain(fake.token);
  });
  it('getUpdates returns queued updates once', async () => {
    fake.queueUpdates([{ update_id: 5, message: { chat: { id: 9 }, text: '/start abc' } }]);
    expect((await client.getUpdates(0, 0)).map((u) => u.update_id)).toEqual([5]);
    expect(await client.getUpdates(6, 0)).toEqual([]);
  });

  it('sanitizes network errors (no token, no url)', async () => {
    const bad = new TelegramClient({ token: fake.token, apiBase: 'http://[bad', timeoutMs: 500 });
    const err = (await bad.sendMessage(1, 'x').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(fake.token);
    expect(err.message).not.toContain('http://[bad');
  });

  it('fake api: malformed JSON gives 400 and reset clears state', async () => {
    const res = await fetch(`${baseUrl}/bot${fake.token}/sendMessage`, { method: 'POST', body: '{' });
    expect(res.status).toBe(400);
    fake.reset();
    expect(fake.requests).toEqual([]);
  });
});
