/** Mailpit (dev compose, :8025) üzerinden alıcıya giden son e-postayı bulur ve bağlantı çıkarır. */
export const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';

interface MailpitSummary {
  ID: string;
  Created: string;
}

/** Alıcıya giden en yeni mesajın düz metni; yoksa null. */
export async function latestMessageText(to: string): Promise<string | null> {
  const query = encodeURIComponent(`to:"${to}"`);
  const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}&limit=5`);
  if (!res.ok) throw new Error(`Mailpit arama başarısız: ${res.status}`);
  const { messages } = (await res.json()) as { messages: MailpitSummary[] };
  if (!messages?.length) return null;
  const newest = [...messages].sort((a, b) => b.Created.localeCompare(a.Created))[0]!;
  const msg = await fetch(`${MAILPIT_URL}/api/v1/message/${newest.ID}`);
  if (!msg.ok) throw new Error(`Mailpit mesaj okunamadı: ${msg.status}`);
  const body = (await msg.json()) as { Text?: string; HTML?: string };
  return `${body.Text ?? ''}\n${body.HTML ?? ''}`;
}

/** Metindeki `<path>?token=...` bağlantısını döndürür (ör. /verify-email). */
export function extractLink(text: string, path: string): string | null {
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    const raw = m[0].replace(/&amp;/g, '&');
    if (!URL.canParse(raw)) continue;
    const url = new URL(raw);
    if (url.pathname === path && url.searchParams.get('token')) return url.toString();
  }
  return null;
}
