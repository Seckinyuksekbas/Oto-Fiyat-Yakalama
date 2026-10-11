import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { AdminQueues } from '../src/infra/admin-queues.service';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { ALLOW_PRIVATE_URLS } from '../src/modules/admin/admin.tokens';
import { createTestApp, newAgent, registerUser, resetState, setRole } from './helpers';
import { Encryptor } from '@oto/server-common';

let app: NestExpressApplication;
let prisma: PrismaService;
const api = '/api/v1/admin';

// Yerel hedef (generate_204 yerine) + sahte HTTP proxy (CONNECT tüneli)
let target: Server;
let fakeProxy: Server;
const connectLog: { host: string; auth: string | undefined }[] = [];
const port = (s: Server) => (s.address() as AddressInfo).port;

beforeAll(async () => {
  target = createServer((_q, res) => res.writeHead(204).end());
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  fakeProxy = createServer((_q, res) => res.writeHead(405).end());
  fakeProxy.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    connectLog.push({ host: req.url ?? '', auth: req.headers['proxy-authorization'] as string | undefined });
    const [host, p] = (req.url ?? '').split(':');
    const upstream = connect(Number(p), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((r) => fakeProxy.listen(0, '127.0.0.1', r));
  process.env.PROXY_CHECK_URL = `http://127.0.0.1:${port(target)}/generate_204`;
  app = await createTestApp();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
  fakeProxy.closeAllConnections();
  target.closeAllConnections();
  await Promise.all([fakeProxy, target].map((s) => new Promise<void>((r) => s.close(() => r()))));
});
beforeEach(async () => {
  await resetState(app);
  connectLog.length = 0;
});

async function actor(role: 'ADMIN' | 'SUPER_ADMIN' | 'USER' = 'ADMIN') {
  const a = await registerUser(app);
  if (role !== 'USER') await setRole(app, a.user.id, role);
  return a;
}

let codeSeq = 0;
const sourceBody = (over: Record<string, unknown> = {}) => ({
  code: `kaynak-${++codeSeq}`,
  name: 'Demo Kaynak',
  adapterKey: 'demo-site',
  kind: 'HTTP',
  permissionType: 'TEST',
  permissionNote: 'Test izni',
  permissionVerified: true,
  intervalSec: 300,
  maxConcurrency: 1,
  minRequestGapMs: 1000,
  config: { baseUrl: 'http://127.0.0.1:4010' },
  proxyConfigId: null,
  ...over,
});

async function createSource(agent: ReturnType<typeof newAgent>, over: Record<string, unknown> = {}) {
  const res = await agent.post(`${api}/sources`).send(sourceBody(over));
  expect(res.status).toBe(201);
  return res.body.source as { id: number; code: string };
}

const audits = (action: string) => prisma.auditLog.findMany({ where: { action }, orderBy: { id: 'asc' } });

describe('sources CRUD and lifecycle', () => {
  it('creates inactive sources, audits atomically and rejects duplicates / unknown adapters', async () => {
    const { agent, user } = await actor();
    const res = await agent.post(`${api}/sources`).send(sourceBody({ code: 'oto-a' }));
    expect(res.status).toBe(201);
    expect(res.body.source).toMatchObject({ code: 'oto-a', isActive: false, health: 'HEALTHY', consecutiveFailures: 0 });
    expect(res.body.source.permissionVerifiedAt).not.toBeNull();
    const [row] = await audits('source.create');
    expect(row).toMatchObject({ actorId: user.id, targetType: 'DataSource', targetId: String(res.body.source.id) });

    const dup = await agent.post(`${api}/sources`).send(sourceBody({ code: 'oto-a' }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('INVALID_OPERATION');
    const bad = await agent.post(`${api}/sources`).send(sourceBody({ adapterKey: 'nope' }));
    expect(bad.status).toBe(400);
    expect(await prisma.dataSource.count()).toBe(1);
    expect(await audits('source.create')).toHaveLength(1);
  });

  it('without permissionVerified the source has no permissionVerifiedAt, and activation is refused (409) until verified', async () => {
    const { agent } = await actor();
    const s = await createSource(agent, { permissionVerified: false });
    const refused = await agent.post(`${api}/sources/${s.id}/activate`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('INVALID_OPERATION');
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: s.id } })).isActive).toBe(false);
    expect(await audits('source.activate')).toHaveLength(0);

    const patched = await agent.patch(`${api}/sources/${s.id}`).send({ permissionVerified: true });
    expect(patched.status).toBe(200);
    expect(patched.body.source.permissionVerifiedAt).not.toBeNull();
    const ok = await agent.post(`${api}/sources/${s.id}/activate`);
    expect(ok.status).toBe(200);
    expect(ok.body.source.isActive).toBe(true);
  });

  it('activation of a PAUSED source resets health and failures; repeated activate/pause are audited once', async () => {
    const { agent } = await actor();
    const s = await createSource(agent);
    await prisma.dataSource.update({ where: { id: s.id }, data: { health: 'PAUSED', consecutiveFailures: 5, isActive: false } });

    const a1 = await agent.post(`${api}/sources/${s.id}/activate`);
    expect(a1.status).toBe(200);
    expect(a1.body.source).toMatchObject({ isActive: true, health: 'HEALTHY', consecutiveFailures: 0 });
    const a2 = await agent.post(`${api}/sources/${s.id}/activate`);
    expect(a2.status).toBe(200);
    expect(await audits('source.activate')).toHaveLength(1);

    const p1 = await agent.post(`${api}/sources/${s.id}/pause`);
    expect(p1.status).toBe(200);
    expect(p1.body.source).toMatchObject({ isActive: false, health: 'PAUSED' });
    await agent.post(`${api}/sources/${s.id}/pause`);
    expect(await audits('source.pause')).toHaveLength(1);
    expect((await audits('source.pause'))[0]?.before).toMatchObject({ isActive: true, health: 'HEALTHY' });
  });

  it('PATCH changes fields with before/after audit, no-op writes nothing, revoking permission deactivates', async () => {
    const { agent } = await actor();
    const s = await createSource(agent);
    await agent.post(`${api}/sources/${s.id}/activate`);

    const r = await agent.patch(`${api}/sources/${s.id}`).send({ name: 'Yeni Ad', intervalSec: 600 });
    expect(r.status).toBe(200);
    expect(r.body.source).toMatchObject({ name: 'Yeni Ad', intervalSec: 600 });
    const [row] = await audits('source.update');
    expect(row?.before).toEqual({ name: 'Demo Kaynak', intervalSec: 300 });
    expect(row?.after).toEqual({ name: 'Yeni Ad', intervalSec: 600 });

    await agent.patch(`${api}/sources/${s.id}`).send({ name: 'Yeni Ad' });
    expect(await audits('source.update')).toHaveLength(1);

    const revoked = await agent.patch(`${api}/sources/${s.id}`).send({ permissionVerified: false });
    expect(revoked.body.source).toMatchObject({ permissionVerifiedAt: null, isActive: false });

    expect((await agent.patch(`${api}/sources/${s.id}`).send({ code: 'x-y' })).status).toBe(400);
    expect((await agent.patch(`${api}/sources/${s.id}`).send({ proxyConfigId: 9999 })).status).toBe(400);
    expect((await agent.patch(`${api}/sources/999999`).send({ name: 'x' })).status).toBe(404);
  });

  it('lists sources with health, failures and last-24h job/listing counts', async () => {
    const { agent } = await actor();
    const s = await createSource(agent);
    await prisma.dataSource.update({ where: { id: s.id }, data: { health: 'DEGRADED', consecutiveFailures: 2, lastErrorAt: new Date() } });
    await prisma.collectionJob.createMany({
      data: [
        { sourceId: s.id, trigger: 'SCHEDULED', status: 'SUCCEEDED', listingsNew: 5, listingsUpdated: 2, listingsRemoved: 1 },
        { sourceId: s.id, trigger: 'SCHEDULED', status: 'FAILED' },
        { sourceId: s.id, trigger: 'SCHEDULED', status: 'SUCCEEDED', listingsNew: 3, createdAt: new Date(Date.now() - 3 * 86_400_000) },
        { sourceId: s.id, trigger: 'MANUAL', status: 'SUCCEEDED', dryRun: true, listingsNew: 99 },
      ],
    });
    const res = await agent.get(`${api}/sources`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      id: s.id, health: 'DEGRADED', consecutiveFailures: 2,
      last24h: { jobs: { total: 2, succeeded: 1, failed: 1, partial: 0 }, listings: { new: 5, updated: 2, removed: 1 } },
    });
    expect(res.body.items[0].lastErrorAt).not.toBeNull();
  });

  it('computes stats per range', async () => {
    const { agent } = await actor();
    const s = await createSource(agent);
    const day = (n: number) => new Date(Date.now() - n * 86_400_000);
    await prisma.collectionJob.createMany({
      data: [
        { sourceId: s.id, trigger: 'SCHEDULED', status: 'SUCCEEDED', listingsNew: 4, listingsUpdated: 1, avgResponseMs: 100 },
        { sourceId: s.id, trigger: 'SCHEDULED', status: 'PARTIAL', listingsNew: 1, avgResponseMs: 300 },
        { sourceId: s.id, trigger: 'SCHEDULED', status: 'FAILED', createdAt: day(2) },
        { sourceId: s.id, trigger: 'SCHEDULED', status: 'SUCCEEDED', listingsRemoved: 2, createdAt: day(10), avgResponseMs: 50 },
      ],
    });
    await prisma.scrapeError.createMany({
      data: [
        { sourceId: s.id, kind: 'NETWORK', message: 'x', transient: true },
        { sourceId: s.id, kind: 'NETWORK', message: 'x', transient: true },
        { sourceId: s.id, kind: 'PARSE', message: 'y', transient: false },
      ],
    });
    const r24 = await agent.get(`${api}/sources/${s.id}/stats`);
    expect(r24.status).toBe(200);
    expect(r24.body).toMatchObject({ jobs: { total: 2, succeeded: 1, failed: 0, partial: 1 }, errorRate: 0.5, avgResponseMs: 200, errorsByKind: { NETWORK: 2, PARSE: 1 } });
    expect(r24.body.listingsPerDay).toHaveLength(1);
    expect(r24.body.listingsPerDay[0]).toMatchObject({ new: 5, updated: 1, removed: 0 });
    const r7 = await agent.get(`${api}/sources/${s.id}/stats?range=7d`);
    expect(r7.body.jobs).toEqual({ total: 3, succeeded: 1, failed: 1, partial: 1 });
    const r30 = await agent.get(`${api}/sources/${s.id}/stats?range=30d`);
    expect(r30.body.jobs.total).toBe(4);
    expect(r30.body.listingsPerDay.length).toBeGreaterThanOrEqual(2);
    expect((await agent.get(`${api}/sources/${s.id}/stats?range=1y`)).status).toBe(400);
    expect((await agent.get(`${api}/sources/999999/stats`)).status).toBe(404);
  });
});

describe('test scrape', () => {
  it('queues a MANUAL dry-run job (202), audits once, and throttles the second request per source (429)', async () => {
    const { agent } = await actor();
    const s = await createSource(agent);
    const res = await agent.post(`${api}/sources/${s.id}/test-scrape`).send({ dryRun: true });
    expect(res.status).toBe(202);
    const job = await prisma.collectionJob.findUniqueOrThrow({ where: { id: res.body.jobId } });
    expect(job).toMatchObject({ sourceId: s.id, trigger: 'MANUAL', dryRun: true, status: 'QUEUED' });
    const queued = await app.get(AdminQueues).scrape.getJob(`scrape-${job.id}`);
    expect(queued?.data).toEqual({ collectionJobId: job.id, sourceId: s.id });
    expect(await app.get(RedisService).ttl(`test-scrape:${s.id}`)).toBeGreaterThan(0);

    const again = await agent.post(`${api}/sources/${s.id}/test-scrape`).send({ dryRun: true });
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('RATE_LIMITED');
    expect(await prisma.collectionJob.count()).toBe(1);
    expect(await audits('source.test-scrape')).toHaveLength(1);

    // başka kaynak etkilenmez
    const other = await createSource(agent);
    expect((await agent.post(`${api}/sources/${other.id}/test-scrape`).send({ dryRun: true })).status).toBe(202);
  });

  it('requires permission verification (409) without consuming the throttle, and validates the body', async () => {
    const { agent } = await actor();
    const s = await createSource(agent, { permissionVerified: false });
    const refused = await agent.post(`${api}/sources/${s.id}/test-scrape`).send({ dryRun: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('INVALID_OPERATION');
    expect(await app.get(RedisService).exists(`test-scrape:${s.id}`)).toBe(0);
    expect((await agent.post(`${api}/sources/${s.id}/test-scrape`).send({})).status).toBe(400);
    expect((await agent.post(`${api}/sources/999999/test-scrape`).send({ dryRun: true })).status).toBe(404);
    expect(await prisma.collectionJob.count()).toBe(0);
  });

  it('works for inactive sources, but refuses while another job is pending and frees the throttle', async () => {
    const { agent } = await actor();
    const s = await createSource(agent);
    await prisma.collectionJob.create({ data: { sourceId: s.id, trigger: 'SCHEDULED', status: 'RUNNING' } });
    const busy = await agent.post(`${api}/sources/${s.id}/test-scrape`).send({ dryRun: true });
    expect(busy.status).toBe(409);
    expect(await app.get(RedisService).exists(`test-scrape:${s.id}`)).toBe(0);
    expect(await audits('source.test-scrape')).toHaveLength(0);
  });
});

describe('SSRF (production mode)', () => {
  let prodApp: NestExpressApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ALLOW_PRIVATE_URLS).useValue(false).compile();
    prodApp = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(prodApp);
    await prodApp.init();
  });
  afterAll(async () => {
    await prodApp.close();
  });

  const internal = ['http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/', 'http://127.0.0.1:4010', 'http://localhost:3000/', 'http://[::1]/', 'http://192.168.1.10/'];

  it.each(internal)('rejects internal source baseUrl %s on create and update', async (baseUrl) => {
    const a = await registerUser(prodApp);
    await setRole(prodApp, a.user.id, 'ADMIN');
    const created = await a.agent.post(`${api}/sources`).send(sourceBody({ config: { baseUrl } }));
    expect(created.status).toBe(400);
    expect(created.body.error.code).toBe('VALIDATION_FAILED');
    const ok = await a.agent.post(`${api}/sources`).send(sourceBody({ config: { baseUrl: 'http://93.184.216.34/' } }));
    expect(ok.status).toBe(201);
    const patched = await a.agent.patch(`${api}/sources/${ok.body.source.id}`).send({ config: { baseUrl } });
    expect(patched.status).toBe(400);
    expect((await prodApp.get(PrismaService).dataSource.findUniqueOrThrow({ where: { id: ok.body.source.id } })).config).toEqual({ baseUrl: 'http://93.184.216.34/' });
  });

  it('rejects internal proxy URLs on create and update, and refuses to check a stored internal proxy', async () => {
    const a = await registerUser(prodApp);
    await setRole(prodApp, a.user.id, 'ADMIN');
    for (const url of ['http://169.254.169.254:3128', 'http://10.1.2.3:8080', 'http://localhost:3128']) {
      const r = await a.agent.post(`${api}/proxies`).send({ name: 'p', url, isEnabled: true });
      expect(r.status).toBe(400);
    }
    const ok = await a.agent.post(`${api}/proxies`).send({ name: 'p', url: 'http://93.184.216.34:3128', isEnabled: true });
    expect(ok.status).toBe(201);
    expect((await a.agent.patch(`${api}/proxies/${ok.body.proxy.id}`).send({ url: 'http://10.0.0.1:3128' })).status).toBe(400);
    const prisma2 = prodApp.get(PrismaService);
    await prisma2.proxyConfig.update({ where: { id: ok.body.proxy.id }, data: { urlEncrypted: prodApp.get(Encryptor).encrypt('http://10.0.0.1:3128') } });
    const checked = await a.agent.post(`${api}/proxies/${ok.body.proxy.id}/check`);
    expect(checked.status).toBe(200);
    expect(checked.body.proxy.lastError).toBeTruthy();
    expect(checked.body.proxy.lastLatencyMs).toBeNull();
  });
});

describe('jobs', () => {
  it('lists with filters/pagination and masks URL query strings in details', async () => {
    const { agent } = await actor();
    const s1 = await createSource(agent);
    const s2 = await createSource(agent);
    const failed = await prisma.collectionJob.create({
      data: {
        sourceId: s1.id, trigger: 'SCHEDULED', status: 'FAILED', errorsCount: 1,
        errorSummary: 'Liste sayfası alınamadı (HTTP 500): http://127.0.0.1:4010/ilanlar?sayfa=2&token=gizli',
      },
    });
    await prisma.scrapeError.create({
      data: {
        jobId: failed.id, sourceId: s1.id, kind: 'HTTP_5XX', transient: false,
        url: 'http://127.0.0.1:4010/ilanlar?sayfa=2&token=gizli',
        message: 'Liste sayfası alınamadı (HTTP 500): http://127.0.0.1:4010/ilanlar?sayfa=2&token=gizli',
      },
    });
    const dry = await prisma.collectionJob.create({
      data: {
        sourceId: s2.id, trigger: 'MANUAL', dryRun: true, status: 'SUCCEEDED',
        dryRunResult: { pages: 1, items: [{ externalId: 'A1', url: 'http://x.test/ilan/1?ref=abc', price: '1200000' }], problems: [], durationMs: 12 },
      },
    });
    for (let i = 0; i < 3; i++) await prisma.collectionJob.create({ data: { sourceId: s2.id, trigger: 'SCHEDULED', status: 'SUCCEEDED' } });

    const all = await agent.get(`${api}/jobs?pageSize=2&page=1`);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(5);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.items[0].id).toBeGreaterThan(all.body.items[1].id);
    expect((await agent.get(`${api}/jobs?source=${s1.id}`)).body.total).toBe(1);
    expect((await agent.get(`${api}/jobs?status=FAILED`)).body.items[0]).toMatchObject({ id: failed.id, sourceCode: s1.code });
    expect((await agent.get(`${api}/jobs?trigger=MANUAL`)).body.total).toBe(1);
    expect((await agent.get(`${api}/jobs?pageSize=101`)).status).toBe(400);

    const list = await agent.get(`${api}/jobs?status=FAILED`);
    expect(JSON.stringify(list.body)).not.toContain('gizli');
    expect(list.body.items[0].errorSummary).toContain('http://127.0.0.1:4010/ilanlar?…');

    const detail = await agent.get(`${api}/jobs/${failed.id}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain('gizli');
    expect(detail.body.job.errors[0]).toMatchObject({ kind: 'HTTP_5XX', url: 'http://127.0.0.1:4010/ilanlar?…' });
    expect(detail.body.job.errors[0].message).toContain('?…');

    const dryDetail = await agent.get(`${api}/jobs/${dry.id}`);
    expect(dryDetail.body.job.dryRun).toBe(true);
    expect(dryDetail.body.job.dryRunResult).toMatchObject({ pages: 1, durationMs: 12, items: [{ externalId: 'A1', url: 'http://x.test/ilan/1?…', price: '1200000' }] });
    expect((await agent.get(`${api}/jobs/999999`)).status).toBe(404);
  });
});

describe('proxies', () => {
  const proxyUrl = () => `http://kullanici:s3cret@127.0.0.1:${port(fakeProxy)}`;

  it('stores URLs encrypted, never returns credentials, audits with masked URL', async () => {
    const { agent } = await actor();
    const res = await agent.post(`${api}/proxies`).send({ name: 'P1', url: proxyUrl(), isEnabled: true });
    expect(res.status).toBe(201);
    expect(res.body.proxy.url).toBe(`http://***@127.0.0.1:${port(fakeProxy)}`);
    const row = await prisma.proxyConfig.findUniqueOrThrow({ where: { id: res.body.proxy.id } });
    expect(row.urlEncrypted).not.toContain('s3cret');
    expect(app.get(Encryptor).decrypt(row.urlEncrypted)).toBe(proxyUrl());

    await createSource(agent, { proxyConfigId: row.id });
    const list = await agent.get(`${api}/proxies`);
    expect(list.body.items[0]).toMatchObject({ id: row.id, name: 'P1', isEnabled: true, sourceCount: 1, url: `http://***@127.0.0.1:${port(fakeProxy)}` });

    const upd = await agent.patch(`${api}/proxies/${row.id}`).send({ name: 'P1b', isEnabled: false });
    expect(upd.body.proxy).toMatchObject({ name: 'P1b', isEnabled: false });
    await agent.patch(`${api}/proxies/${row.id}`).send({ name: 'P1b' });
    expect(await audits('proxy.update')).toHaveLength(1);

    const dump = JSON.stringify([res.body, list.body, upd.body, await prisma.auditLog.findMany()]);
    expect(dump).not.toContain('s3cret');
    expect(dump).not.toContain('kullanici');
    expect((await agent.patch(`${api}/proxies/999999`).send({ name: 'x' })).status).toBe(404);
    expect((await agent.post(`${api}/proxies`).send({ name: 'x', url: 'ftp://h/', isEnabled: true })).status).toBe(400);
  });

  it('checks a working proxy through a CONNECT tunnel and records latency', async () => {
    const { agent } = await actor();
    const created = await agent.post(`${api}/proxies`).send({ name: 'P', url: proxyUrl(), isEnabled: true });
    const res = await agent.post(`${api}/proxies/${created.body.proxy.id}/check`);
    expect(res.status).toBe(200);
    expect(res.body.proxy.lastError).toBeNull();
    expect(res.body.proxy.lastLatencyMs).toBeGreaterThanOrEqual(0);
    expect(res.body.proxy.lastCheckAt).not.toBeNull();
    expect(connectLog).toHaveLength(1);
    expect(connectLog[0]?.host).toBe(`127.0.0.1:${port(target)}`);
    expect(connectLog[0]?.auth).toBe(`Basic ${Buffer.from('kullanici:s3cret').toString('base64')}`);
    expect(await audits('proxy.check')).toHaveLength(1);
  });

  it('records an error (without credentials) when the proxy port is closed', async () => {
    const { agent } = await actor();
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const deadPort = port(closed);
    await new Promise<void>((r) => closed.close(() => r()));
    const created = await agent.post(`${api}/proxies`).send({ name: 'Ölü', url: `http://kullanici:s3cret@127.0.0.1:${deadPort}`, isEnabled: true });
    const res = await agent.post(`${api}/proxies/${created.body.proxy.id}/check`);
    expect(res.status).toBe(200);
    expect(res.body.proxy.lastError).toBeTruthy();
    expect(res.body.proxy.lastLatencyMs).toBeNull();
    expect(res.body.proxy.lastCheckAt).not.toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('s3cret');
    expect((await agent.post(`${api}/proxies/999999/check`)).status).toBe(404);
  });
});

describe('access control', () => {
  it('USER gets 403 on source/job/proxy endpoints, anonymous 401', async () => {
    const u = await actor('USER');
    expect((await u.agent.get(`${api}/sources`)).status).toBe(403);
    expect((await u.agent.get(`${api}/jobs`)).status).toBe(403);
    expect((await u.agent.post(`${api}/proxies`).send({})).status).toBe(403);
    expect((await newAgent(app).get(`${api}/sources`)).status).toBe(401);
  });

  it('ADMIN (not only SUPER_ADMIN) can manage sources', async () => {
    const { agent } = await actor('ADMIN');
    expect((await agent.post(`${api}/sources`).send(sourceBody())).status).toBe(201);
  });
});
