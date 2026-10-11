import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_ACTION } from '../src/common/audit/audited.decorator';
import { ROLES } from '../src/common/decorators/roles';
import { AppModule } from '../src/app.module';
import { listRoutes } from './routes';

// Yalnızca derlenmiş modül: app.init/listen yok (rota meta verisi için sunucu gerekmez; paralel çalıştırmada port/Redis yarışı olmaz).
let app: TestingModule;
beforeAll(async () => {
  app = await Test.createTestingModule({ imports: [AppModule] }).compile();
});
afterAll(async () => {
  await app.close().catch(() => undefined);
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
