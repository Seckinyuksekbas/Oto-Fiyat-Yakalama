/**
 * Next sunucusu açılırken bir kez çalışır. Geçersiz çalışma zamanı env'inde (ör. API_ORIGIN) süreç başlamaz.
 * Not: rewrites hedefi derleme anında sabitlenir; buradaki denetim yanlış yapılandırmayı erken yakalamak içindir.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { parseWebEnv } = await import('./env');
  parseWebEnv(process.env);
}
