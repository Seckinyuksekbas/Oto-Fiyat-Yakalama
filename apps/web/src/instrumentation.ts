/**
 * Next sunucusu açılırken bir kez çalışır. Geçersiz çalışma zamanı env'inde (ör. API_ORIGIN, CSP_IMG_EXTRA)
 * süreç başlamaz. Not: rewrites hedefi derleme anında sabitlenir; buradaki denetim yanlış yapılandırmayı erken
 * yakalamak içindir. Docker imajında derleme anındaki API_ORIGIN kaydı (.next/build-api-origin) varsa çalışma
 * zamanı değeri onunla aynı olmalıdır; değilse istekler yanlış adrese gider, bu yüzden açılış durdurulur.
 * Standalone `server.js` reddedilen hook'u yalnızca loglayıp açık kaldığından süreç burada
 * açıkça `exit(1)` ile durdurulur (`next start` zaten next.config.ts'de aynı doğrulamayla düşer).
 */
export async function register(): Promise<void> {
  // İçe aktarmalar bu `if` bloğunun İÇİNDE kalmalı: Next NEXT_RUNTIME'ı derlemede sabitler ve webpack edge
  // paketinden yalnız bu biçimdeki ölü dalı atar. build-info node:fs kullanır; erken `return` ya da ayrı
  // fonksiyon biçiminde edge derlemesi "node:" şemasında kırılır.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { parseWebEnv } = await import('./env');
    const { readBuildApiOrigin } = await import('./build-info');
    try {
      const env = parseWebEnv(process.env);
      const built = readBuildApiOrigin();
      if (built !== null && built !== env.API_ORIGIN) {
        throw new Error(
          'Invalid environment: API_ORIGIN: derleme anındaki değerle aynı olmalı (rewrites derlemede sabitlenir; ' +
            'imajı yeni API_ORIGIN build arg ile yeniden derleyin)',
        );
      }
    } catch (err) {
      // Mesaj yalnız değişken adı ve nedeni içerir, değeri değil (parseWebEnv sözleşmesi).
      console.error(`[web] ${(err as Error).message}`);
      process.exit(1);
      throw err;
    }
  }
}
