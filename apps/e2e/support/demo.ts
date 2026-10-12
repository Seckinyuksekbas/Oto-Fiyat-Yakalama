import { DEMO_URL, TELEGRAM_URL } from './env';

/** Demo-site kontrol uçları (/__inject, /__mode). E2E yalnızca bu yerel sahte siteye karşı çalışır. */
export interface InjectInput {
  make: string;
  model: string;
  trim?: string;
  fuel?: string;
  transmission?: string;
  year?: number;
  km?: number;
  price?: number;
  city?: string;
  discount?: number;
  tramerAmount?: number | null;
  paintedParts?: string[];
  changedParts?: string[];
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const demo = {
  inject: (input: InjectInput) => post<{ id: string; price: number; make: string; model: string; year: number }>(`${DEMO_URL}/__inject`, input),
  mode: (mode: 'normal' | 'captcha' | 'broken' | 'forbidden') => post<{ mode: string }>(`${DEMO_URL}/__mode`, { mode }),
};

/**
 * Hasarsız, aynı yakıt/vites/yıl ve yakın km'li N adet piyasa fiyatında emsal ekler. Böylece hedef ilanın analizi
 * rastgele katalog dağılımına bağlı kalmadan yeterli emsalle (L1) güvenilir sonuç verir.
 */
export async function injectComparables(base: Omit<InjectInput, 'discount' | 'km'> & { km: number }, count = 10): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const l = await demo.inject({ ...base, km: base.km + (i - count / 2) * 1500, discount: 0, tramerAmount: null, paintedParts: [], changedParts: [] });
    ids.push(l.id);
  }
  return ids;
}

export interface TgMessage {
  method: string;
  chatId: string;
  text: string;
  replyMarkup?: { inline_keyboard?: Array<Array<{ text: string; url?: string; callback_data?: string }>> };
}

export const telegram = {
  async messages(chatId?: string | number): Promise<TgMessage[]> {
    const res = await fetch(`${TELEGRAM_URL}/__messages${chatId === undefined ? '' : `?chatId=${chatId}`}`);
    return (await res.json()) as TgMessage[];
  },
  pushStart: (chatId: number, code: string) => post(`${TELEGRAM_URL}/__pushUpdate`, { chatId, text: `/start ${code}` }),
  fail: (rule: { method: string; chatId?: number; status: number; description: string }) => post(`${TELEGRAM_URL}/__fail`, rule),
  clearFail: (chatId?: number) => post(`${TELEGRAM_URL}/__clearFail`, chatId === undefined ? {} : { chatId }),
};

/** Rastgele, çakışmayan Telegram sohbet kimliği. */
export function randomChatId(): number {
  return 100_000_000 + Math.floor(Math.random() * 800_000_000);
}
