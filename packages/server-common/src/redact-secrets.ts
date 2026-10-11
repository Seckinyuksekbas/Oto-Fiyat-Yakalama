/** Telegram bot token: `bot<id>:<gizli>` biçimi (her uzunlukta) ya da çıplak `<id>:<30+ karakter>`. */
const BOT_TOKEN_RE = /(?<![A-Za-z0-9])(?:bot\d+:[A-Za-z0-9_-]+|\d{5,}:[A-Za-z0-9_-]{30,})/g;
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;

/**
 * Kalıcılaştırılan / admin'e gösterilen serbest metinlerden gizli bilgiyi ayıklar: bot token'ları, URL kullanıcı
 * bilgisi (`user:pass@`) ve URL sorgu dizileri (`?…`). Hata mesajları (`lastError`) gibi metinler için.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(BOT_TOKEN_RE, (m) => (m.startsWith('bot') ? 'bot[redacted]' : '[redacted]'))
    .replace(URL_RE, (u) => u.replace(/^(https?:\/\/)[^/?#\s@]+@/i, '$1***@').replace(/\?.*$/, '?…'));
}
