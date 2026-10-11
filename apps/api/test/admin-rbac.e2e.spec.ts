import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Role } from '@oto/db';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLES } from '../src/common/decorators/roles';
import { createTestApp, registerUser, resetState, setRole } from './helpers';
import { listRoutes, type RouteInfo } from './routes';

let app: NestExpressApplication;
let routes: RouteInfo[];
const xhr = { 'X-Requested-With': 'XMLHttpRequest' };

const rolesOf = (r: RouteInfo): Role[] => {
  const roles = (Reflect.getMetadata(ROLES, r.handler) ?? Reflect.getMetadata(ROLES, r.controller)) as Role[] | undefined;
  return Array.isArray(roles) ? roles : [];
};
const superOnly = (r: RouteInfo) => !rolesOf(r).includes('ADMIN');
const url = (r: RouteInfo) => '/api/v1' + r.path.replace(/:[A-Za-z]+/g, 'x');
const isStream = (r: RouteInfo) => r.path.endsWith('/stream');

beforeAll(async () => {
  app = await createTestApp();
  routes = listRoutes(app).filter((r) => r.path === '/admin' || r.path.startsWith('/admin/'));
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetState(app);
});

async function call(agent: TestAgent, r: RouteInfo) {
  const m = r.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
  const req = agent[m](url(r));
  return m === 'get' || m === 'delete' ? req : req.send({});
}

describe('admin RBAC matrix (auto-derived from controller metadata)', () => {
  it('discovers admin routes and every one declares @Roles with only ADMIN/SUPER_ADMIN', () => {
    expect(routes.length).toBeGreaterThan(0);
    const bad = routes.filter((r) => {
      const roles = rolesOf(r);
      return roles.length === 0 || roles.some((x) => x !== 'ADMIN' && x !== 'SUPER_ADMIN') || !roles.includes('SUPER_ADMIN');
    });
    expect(bad.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it('unauthenticated -> 401 on every admin route', async () => {
    for (const r of routes) {
      const m = r.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
      const res = await request(app.getHttpServer())[m](url(r)).set(xhr).send({});
      expect({ route: `${r.method} ${r.path}`, status: res.status }).toEqual({ route: `${r.method} ${r.path}`, status: 401 });
    }
  });

  it('USER -> 403 on every admin route', async () => {
    const u = await registerUser(app);
    for (const r of routes) {
      const res = await call(u.agent, r);
      expect({ route: `${r.method} ${r.path}`, status: res.status }).toEqual({ route: `${r.method} ${r.path}`, status: 403 });
    }
  });

  it('ADMIN -> 403 on SUPER_ADMIN-only routes, never 403/401 elsewhere', async () => {
    const a = await registerUser(app);
    await setRole(app, a.user.id, 'ADMIN');
    for (const r of routes) {
      const label = `${r.method} ${r.path}`;
      if (superOnly(r)) {
        const res = await call(a.agent, r);
        expect({ route: label, status: res.status }).toEqual({ route: label, status: 403 });
      } else if (!isStream(r)) {
        const res = await call(a.agent, r);
        expect({ route: label, forbidden: res.status === 403 || res.status === 401 }).toEqual({ route: label, forbidden: false });
      }
    }
  });

  it('SUPER_ADMIN is never refused by role on any admin route', async () => {
    const s = await registerUser(app);
    await setRole(app, s.user.id, 'SUPER_ADMIN');
    for (const r of routes.filter((x) => !isStream(x))) {
      const res = await call(s.agent, r);
      expect({ route: `${r.method} ${r.path}`, forbidden: res.status === 403 || res.status === 401 }).toEqual({
        route: `${r.method} ${r.path}`,
        forbidden: false,
      });
    }
  });
});
