import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_ACTION } from '../src/common/audit/audited.decorator';
import { ROLES } from '../src/common/decorators/roles';
import { createTestApp } from './helpers';
import { listRoutes } from './routes';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

describe('admin route policy', () => {
  it('every /admin route requires a role', () => {
    const admin = listRoutes(app).filter((r) => r.path.startsWith('/admin'));
    expect(admin.length).toBeGreaterThan(0);
    const missing = admin
      .filter((r) => {
        const roles = Reflect.getMetadata(ROLES, r.handler) ?? Reflect.getMetadata(ROLES, r.controller);
        return !(Array.isArray(roles) && roles.length > 0);
      })
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });

  it('every mutating /admin route is @Audited', () => {
    const mutating = listRoutes(app).filter((r) => r.path.startsWith('/admin') && r.method !== 'GET');
    expect(mutating.length).toBeGreaterThan(0);
    const missing = mutating
      .filter((r) => !Reflect.getMetadata(AUDIT_ACTION, r.handler))
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });
});
