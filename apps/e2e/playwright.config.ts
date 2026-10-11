import { defineConfig, devices } from '@playwright/test';
import { WEB_HOST, WEB_ORIGIN } from './support/env';

/**
 * Derlenmiş yığına karşı uçtan uca testler. Yığın tek ve paylaşımlı olduğundan testler sırayla (1 worker) koşar.
 * Bekleme yalnızca expect.poll / locator zaman aşımlarıyla yapılır.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: WEB_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        // web.oto-e2e.test → 127.0.0.1 (bkz. support/env.ts)
        launchOptions: { args: [`--host-resolver-rules=MAP ${WEB_HOST} 127.0.0.1`] },
      },
    },
  ],
});
