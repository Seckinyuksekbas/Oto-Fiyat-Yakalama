/** Yığının portları ve tarayıcı origin'i. Testler ve global-setup aynı değerleri kullanır. */
export const PORTS = { web: 3100, api: 3101, demo: 4100, telegram: 4200 } as const;

/**
 * Tarayıcının web'e eriştiği ad. `.test` (RFC 2606) asla gerçekte çözülmez; Chromium'da --host-resolver-rules ile
 * 127.0.0.1'e eşlenir. Loopback olmayan bir ad gerekir: worker Telegram "Analizi gör" düğmesini yalnızca herkese açık
 * görünen PUBLIC_BASE_URL için ekler (isPublicHttpUrl).
 */
export const WEB_HOST = 'web.oto-e2e.test';
export const WEB_ORIGIN = `http://${WEB_HOST}:${PORTS.web}`;
export const API_URL = `http://127.0.0.1:${PORTS.api}`;
export const DEMO_URL = `http://127.0.0.1:${PORTS.demo}`;
export const TELEGRAM_URL = `http://127.0.0.1:${PORTS.telegram}`;
export const DB_NAME = 'oto_e2e';
export const DATABASE_URL = process.env.E2E_DATABASE_URL ?? `postgresql://oto:oto@127.0.0.1:5433/${DB_NAME}?connection_limit=30`;
export const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6380/14';

/** global-setup'ın çalışma anında ürettiği seed admin kimlik bilgileri (env ile taşınır). */
export function adminCredentials(): { email: string; password: string } {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD global-setup tarafından ayarlanmadı');
  return { email, password };
}
