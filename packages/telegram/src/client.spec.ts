import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TelegramApiError, TelegramClient } from './client';
import { FakeTelegramApi } from './fake-bot-api';

let fake: FakeTelegramApi;
let client: TelegramClient;

beforeAll(async () => {
  fake = new FakeTelegramApi();
  const { apiBase, token } = await fake.start();
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
});
