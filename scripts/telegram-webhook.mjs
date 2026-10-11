#!/usr/bin/env node
// Telegram webhook kurulumu: node scripts/telegram-webhook.mjs set|info|delete
//
// Env:
//   TELEGRAM_BOT_TOKEN       (zorunlu)
//   TELEGRAM_WEBHOOK_SECRET  (set için zorunlu; 1–256 karakter, A-Z a-z 0-9 _ -)
//   PUBLIC_BASE_URL          (set için zorunlu; https)
//   TELEGRAM_API_BASE        (opsiyonel; varsayılan https://api.telegram.org)
//
// Token ve secret hiçbir çıktıda görünmez. Eksik env ya da başarısız API yanıtında çıkış kodu 1'dir.

const WEBHOOK_PATH = '/api/v1/telegram/webhook';
const USAGE = 'Kullanım: node scripts/telegram-webhook.mjs set|info|delete';

const env = process.env;
const secrets = [env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET].filter((v) => typeof v === 'string' && v.length > 0);

function mask(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('***');
  // Biçimi bilinen her bot token'ı da maskelenir (ör. API hata açıklamasında farklı bir token).
  return out.replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, '***');
}

function fail(message) {
  console.error(`HATA: ${mask(message)}`);
  process.exit(1);
}

function requireEnv(name) {
  const v = env[name];
  if (!v || !v.trim()) fail(`${name} tanımlı değil`);
  return v.trim();
}

async function call(token, method, body) {
  const base = (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${base}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // Hata mesajı URL'yi (dolayısıyla token'ı) içerebilir; yalnızca neden yazılır.
    const cause = err && typeof err === 'object' && 'cause' in err && err.cause ? err.cause : err;
    fail(`${method} isteği gönderilemedi: ${cause && cause.code ? cause.code : err instanceof Error ? err.name : 'bilinmeyen hata'}`);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.ok !== true) {
    const desc = json && typeof json.description === 'string' ? json.description : 'geçersiz yanıt';
    fail(`${method} başarısız (HTTP ${res.status}): ${desc}`);
  }
  return json.result;
}

async function main() {
  const cmd = process.argv[2];
  if (!['set', 'info', 'delete'].includes(cmd)) fail(USAGE);
  const token = requireEnv('TELEGRAM_BOT_TOKEN');

  if (cmd === 'set') {
    const secret = requireEnv('TELEGRAM_WEBHOOK_SECRET');
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) fail('TELEGRAM_WEBHOOK_SECRET yalnızca A-Z a-z 0-9 _ - içermeli ve en fazla 256 karakter olmalı');
    const baseUrl = requireEnv('PUBLIC_BASE_URL');
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      fail('PUBLIC_BASE_URL geçerli bir URL değil');
    }
    if (parsed.protocol !== 'https:') fail('PUBLIC_BASE_URL https olmalı (Telegram webhook yalnızca https kabul eder)');
    const url = baseUrl.replace(/\/+$/, '') + WEBHOOK_PATH;
    // my_chat_member: kullanıcı botu engellediğinde kanal devre dışı bırakılır (TelegramUpdateHandler.onBlocked).
    await call(token, 'setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
      drop_pending_updates: false,
    });
    console.log(mask(`Webhook ayarlandı: ${url}`));
    return;
  }

  if (cmd === 'info') {
    const info = await call(token, 'getWebhookInfo', {});
    console.log(mask(JSON.stringify(info, null, 2)));
    return;
  }

  await call(token, 'deleteWebhook', { drop_pending_updates: false });
  console.log('Webhook kaldırıldı (bekleyen güncellemeler korunur).');
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
