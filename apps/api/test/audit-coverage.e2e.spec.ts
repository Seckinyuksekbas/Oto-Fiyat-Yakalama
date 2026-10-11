import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditCtxFactory } from '../src/common/audit/audit-ctx.decorator';
import { AUDIT_ACTION } from '../src/common/audit/audited.decorator';
import { ROLES } from '../src/common/decorators/roles';
import { AppModule } from '../src/app.module';
import { listRoutes } from './routes';

// Yalnızca derlenmiş modül (HTTP dinleme yok; rota meta verisi için sunucu gerekmez). Derleme Prisma/Redis bağlantılarını açar,
// AdminQueues kuyrukları ise ilk kullanımda oluşturulduğundan burada ek Redis bağlantısı açılmaz.
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

  const hasAuditCtxParam = (r: { handler: object; controller: object }): boolean => {
    const proto = (r.controller as { prototype: Record<string, unknown> }).prototype;
    const name = Object.getOwnPropertyNames(proto).find((n) => proto[n] === r.handler);
    if (!name) return false;
    const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, r.controller, name) ?? {}) as Record<string, { factory?: unknown }>;
    return Object.values(args).some((a) => a.factory === auditCtxFactory);
  };

  it('every @Audited handler takes an @AuditCtx() parameter, and @AuditCtx() is never used without @Audited', () => {
    const all = listRoutes(app);
    const noCtx = all.filter((r) => Reflect.getMetadata(AUDIT_ACTION, r.handler) && !hasAuditCtxParam(r)).map((r) => `${r.method} ${r.path}`);
    const noAudited = all.filter((r) => !Reflect.getMetadata(AUDIT_ACTION, r.handler) && hasAuditCtxParam(r)).map((r) => `${r.method} ${r.path}`);
    expect({ noCtx, noAudited }).toEqual({ noCtx: [], noAudited: [] });
    expect(all.filter((r) => Reflect.getMetadata(AUDIT_ACTION, r.handler)).length).toBeGreaterThan(0);
  });
});
