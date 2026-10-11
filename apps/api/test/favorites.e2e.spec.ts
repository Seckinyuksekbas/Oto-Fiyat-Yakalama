import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { createTestApp, registerUser, resetState, seedListing } from './helpers';

let app: NestExpressApplication;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetState(app));

const url = (id: number | string) => `/api/v1/me/favorites/${id}`;

describe('favorites', () => {
  it('PUT adds a favorite shown in the list as a card with note and isFavorite', async () => {
    const A = await registerUser(app);
    const l = await seedListing(app);
    const put = await A.agent.put(url(l.listingId)).send({ note: 'Bak buna' });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ note: 'Bak buna', listing: { id: l.listingId, isFavorite: true, price: '960000' } });
    const list = await A.agent.get('/api/v1/me/favorites');
    expect(list.status).toBe(200);
    expect(list.body.nextCursor).toBeNull();
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      note: 'Bak buna',
      listing: { id: l.listingId, isFavorite: true, analysis: { opportunityScore: 77 } },
    });
    expect(typeof list.body.items[0].createdAt).toBe('string');
  });

  it('PUT again updates the note without duplicating', async () => {
    const A = await registerUser(app);
    const l = await seedListing(app);
    await A.agent.put(url(l.listingId)).send({ note: 'ilk' });
    const second = await A.agent.put(url(l.listingId)).send({ note: 'ikinci' });
    expect(second.status).toBe(200);
    expect(second.body.note).toBe('ikinci');
    const list = await A.agent.get('/api/v1/me/favorites');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].note).toBe('ikinci');
    expect(await app.get(PrismaService).favorite.count({ where: { userId: A.user.id } })).toBe(1);
    // empty body keeps idempotent success
    expect((await A.agent.put(url(l.listingId)).send({})).status).toBe(200);
  });

  it('blank note becomes null; note:null clears; omitted note keeps', async () => {
    const A = await registerUser(app);
    const l = await seedListing(app);
    expect((await A.agent.put(url(l.listingId)).send({ note: '   ' })).body.note).toBeNull();
    expect((await A.agent.put(url(l.listingId)).send({ note: 'x' })).body.note).toBe('x');
    expect((await A.agent.put(url(l.listingId)).send({})).body.note).toBe('x');
    expect((await A.agent.put(url(l.listingId)).send({ note: null })).body.note).toBeNull();
    expect((await A.agent.get('/api/v1/me/favorites')).body.items[0].note).toBeNull();
  });

  it('unknown listing → 404; invalid listingId → 404', async () => {
    const A = await registerUser(app);
    expect((await A.agent.put(url(999_999)).send({})).status).toBe(404);
    for (const id of ['0', '-1', 'abc', '2147483648', '1.5']) {
      expect((await A.agent.put(url(id)).send({})).status, `PUT ${id}`).toBe(404);
      expect((await A.agent.delete(url(id))).status, `DELETE ${id}`).toBe(404);
    }
  });

  it('DELETE → 204 then 404', async () => {
    const A = await registerUser(app);
    const l = await seedListing(app);
    await A.agent.put(url(l.listingId)).send({});
    expect((await A.agent.delete(url(l.listingId))).status).toBe(204);
    expect((await A.agent.delete(url(l.listingId))).status).toBe(404);
    expect((await A.agent.get('/api/v1/me/favorites')).body.items).toEqual([]);
  });

  it('paginates newest first with a cursor and no gaps', async () => {
    const A = await registerUser(app);
    const created: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const l = await seedListing(app);
      await A.agent.put(url(l.listingId)).send({});
      created.push(l.listingId);
    }
    const seen: number[] = [];
    let cursor: number | null = null;
    let pages = 0;
    do {
      const res: { body: { items: { listing: { id: number } }[]; nextCursor: number | null } } = await A.agent.get(
        `/api/v1/me/favorites?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...res.body.items.map((i) => i.listing.id));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...created].reverse());
    for (const c of ['abc', '0', '2147483648', '-1']) {
      expect((await A.agent.get(`/api/v1/me/favorites?cursor=${c}`)).status, c).toBe(400);
    }
  });

  it('REMOVED listing stays a favorite and shows status REMOVED', async () => {
    const A = await registerUser(app);
    const l = await seedListing(app);
    await A.agent.put(url(l.listingId)).send({});
    await app.get(PrismaService).listing.update({ where: { id: l.listingId }, data: { status: 'REMOVED', removedAt: new Date() } });
    const list = await A.agent.get('/api/v1/me/favorites');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].listing.status).toBe('REMOVED');
  });
});
