import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { createTestApp, registerUser, resetState, setRole } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
let target: Server;
const api = '/api/v1/admin';
const port = (s: Server) => (s.address() as AddressInfo).port;

beforeAll(async () => {
  target = createServer((_q, res) => res.writeHead(204).end());
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  process.env.PROXY_CHECK_URL = `http://127.0.0.1:${port(target)}/generate_204`;
  app = await createTestApp();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
  target.closeAllConnections();
  await new Promise<void>((r) => target.close(() => r()));
});
beforeEach(async () => {
  await resetState(app);
});

async function admin() {
  const a = await registerUser(app);
  await setRole(app, a.user.id, 'ADMIN');
  return a;
}

let seq = 0;
const body = (over: Record<string, unknown> = {}) => ({
  code: `h-${++seq}`, name: 'Kaynak', adapterKey: 'demo-site', kind: 'HTTP', permissionType: 'TEST', permissionNote: 'n',
  permissionVerified: true, intervalSec: 300, maxConcurrency: 1, minRequestGapMs: 1000, config: { baseUrl: 'http://127.0.0.1:4010' },
  proxyConfigId: null, ...over,
});
const audits = (action: string) => prisma.auditLog.findMany({ where: { action } });

describe('test scrape on PAUSED sources', () => {
  it('returns 409 INVALID_OPERATION before taking the throttle key', async () => {
    const { agent } = await admin();
    const s = (await agent.post(`${api}/sources`).send(body())).body.source as { id: number };
    await prisma.dataSource.update({ where: { id: s.id }, data: { health: 'PAUSED', isActive: false } });
    const res = await agent.post(`${api}/sources/${s.id}/test-scrape`).send({ dryRun: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_OPERATION');
    expect(await prisma.collectionJob.count()).toBe(0);
    // aktive edince throttle tüketilmemiş olmalı
    expect((await agent.post(`${api}/sources/${s.id}/activate`)).status).toBe(200);
    expect((await agent.post(`${api}/sources/${s.id}/test-scrape`).send({ dryRun: true })).status).toBe(202);
  });
});

describe('source config', () => {
  it('rejects baseUrl carrying credentials', async () => {
    const { agent } = await admin();
    const res = await agent.post(`${api}/sources`).send(body({ config: { baseUrl: 'http://user:pw@93.184.216.34/' } }));
    expect(res.status).toBe(400);
    expect(await prisma.dataSource.count()).toBe(0);
  });

  it('masks the query of config.baseUrl in responses and audit', async () => {
    const { agent } = await admin();
    const res = await agent.post(`${api}/sources`).send(body({ config: { baseUrl: 'http://127.0.0.1:4010/?token=gizli' } }));
    expect(res.status).toBe(201);
    expect(res.body.source.config.baseUrl).toBe('http://127.0.0.1:4010/?…');
    await agent.patch(`${api}/sources/${res.body.source.id}`).send({ config: { baseUrl: 'http://127.0.0.1:4010/?token=baska' } });
    const list = await agent.get(`${api}/sources`);
    const dump = JSON.stringify([list.body, await prisma.auditLog.findMany()]);
    expect(dump).not.toContain('gizli');
    expect(dump).not.toContain('baska');
    expect(await audits('source.update')).toHaveLength(1);
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: res.body.source.id } })).config).toEqual({
      baseUrl: 'http://127.0.0.1:4010/?token=baska',
    });
  });
});

describe('proxy hardening', () => {
  it('throttles checks per proxy (429), other proxies unaffected', async () => {
    const { agent } = await admin();
    const mk = async (name: string) =>
      (await agent.post(`${api}/proxies`).send({ name, url: 'http://127.0.0.1:9', isEnabled: true })).body.proxy.id as number;
    const a = await mk('A');
    const b = await mk('B');
    expect((await agent.post(`${api}/proxies/${a}/check`)).status).toBe(200);
    const again = await agent.post(`${api}/proxies/${a}/check`);
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('RATE_LIMITED');
    expect((await agent.post(`${api}/proxies/${b}/check`)).status).toBe(200);
    expect(await audits('proxy.check')).toHaveLength(2);
  });

  it('shows a placeholder when a stored proxy URL cannot be decrypted', async () => {
    const { agent } = await admin();
    await prisma.proxyConfig.create({ data: { name: 'Bozuk', urlEncrypted: 'bozuk-veri', isEnabled: true } });
    const res = await agent.get(`${api}/proxies`);
    expect(res.status).toBe(200);
    expect(res.body.items[0].url).toBe('[çözülemedi]');
  });
});

describe('dry-run result masking', () => {
  it('masks *Url fields and URLs inside problem snippets', async () => {
    const { agent } = await admin();
    const s = (await agent.post(`${api}/sources`).send(body())).body.source as { id: number };
    const job = await prisma.collectionJob.create({
      data: {
        sourceId: s.id, trigger: 'MANUAL', dryRun: true, status: 'SUCCEEDED',
        dryRunResult: {
          pages: 1, durationMs: 1,
          items: [{ externalId: 'A', url: 'http://x.test/a?k=1', imageUrl: 'http://img.test/i.jpg?sig=gizli', price: '1' }],
          problems: [{ field: 'price', problem: 'bad', rawSnippet: '<a href="http://x.test/b?token=gizli">x</a>' }],
        },
      },
    });
    const res = await agent.get(`${api}/jobs/${job.id}`);
    expect(JSON.stringify(res.body)).not.toContain('gizli');
    expect(res.body.job.dryRunResult.items[0]).toMatchObject({ url: 'http://x.test/a?…', imageUrl: 'http://img.test/i.jpg?…' });
  });
});
