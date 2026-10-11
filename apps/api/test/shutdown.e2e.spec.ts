import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminEventsService } from '../src/modules/admin/admin-events.service';
import { UserEventsService } from '../src/infra/user-events.service';
import { createTestApp, loginCookie, registerUser, resetState, setRole } from './helpers';
import { openSse, type SseClient } from './sse';

let app: NestExpressApplication;
const clients: SseClient[] = [];

beforeAll(async () => {
  app = await createTestApp();
  await resetState(app);
});
afterAll(async () => {
  // Başarısız durumda kapanmayı askıda bırakmamak için istemciler her koşulda kapatılır.
  for (const c of clients.splice(0)) c.close();
});

describe('graceful shutdown with open SSE streams', () => {
  it('app.close() resolves quickly and both streams end cleanly', async () => {
    const user = await registerUser(app);
    const admin = await registerUser(app);
    await setRole(app, admin.user.id, 'ADMIN');

    const userSse = await openSse(app, await loginCookie(app, user.email, user.password));
    clients.push(userSse);
    const adminSse = await openSse(app, await loginCookie(app, admin.email, admin.password), '/api/v1/admin/stream');
    clients.push(adminSse);
    await userSse.waitFor((e) => e.event === 'ready');
    await adminSse.waitFor((e) => e.event === 'ready');
    expect(app.get(UserEventsService).listenerCount()).toBe(1);
    expect(app.get(AdminEventsService).listenerCount()).toBe(1);

    const started = Date.now();
    const outcome = await Promise.race([
      app.close().then(() => 'closed' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
    ]);
    expect(outcome).toBe('closed');
    expect(Date.now() - started).toBeLessThan(5000);

    await Promise.all([userSse.ended, adminSse.ended]);
    expect(userSse.endedCleanly()).toBe(true);
    expect(adminSse.endedCleanly()).toBe(true);
  }, 15_000);
});
