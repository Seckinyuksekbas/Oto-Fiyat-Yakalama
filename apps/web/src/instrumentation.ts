/**
 * Next sunucusu açılırken bir kez çalışır. Geçersiz çalışma zamanı env'inde (ör. API_ORIGIN, CSP_IMG_EXTRA)
 * süreç başlamaz. Not: rewrites hedefi derleme anında sabitlenir; buradaki denetim yanlış yapılandırmayı erken
 * yakalamak içindir. Standalone `server.js` reddedilen hook'u yalnızca loglayıp açık kaldığından süreç burada
 * açıkça `exit(1)` ile durdurulur (`next start` zaten next.config.ts'de aynı doğrulamayla düşer).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { parseWebEnv } = await import('./env');
  try {
    parseWebEnv(process.env);
  } catch (err) {
    // Mesaj yalnız değişken adı ve nedeni içerir, değeri değil (parseWebEnv sözleşmesi).
    console.error(`[web] ${(err as Error).message}`);
    process.exit(1);
    throw err;
  }
}
