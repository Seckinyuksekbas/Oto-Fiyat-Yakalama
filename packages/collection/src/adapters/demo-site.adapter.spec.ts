import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAKE_MODEL_ALIAS_SEEDS } from '@oto/db';
import { CATALOG, createDemoSite, type DemoSite } from '@oto/demo-site';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAliasResolver, getAdapter, normalizeListing, type HttpFetcher, type ListPage } from '../index';

let site: DemoSite;
let server: Server;
let baseUrl: string;

const http: HttpFetcher = {
  async getText(url) {
    const res = await fetch(url);
    return { status: res.status, body: await res.text(), url, headers: {} };
  },
};

beforeAll(async () => {
  site = createDemoSite({ seed: 7, size: 45, pageSize: 20, currentYear: 2026 });
  server = createServer(site.app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});
beforeEach(() => {
  site.store.reset(7, 45);
  site.setMode('normal');
});

async function crawl(config: unknown): Promise<ListPage[]> {
  const pages: ListPage[] = [];
  for await (const page of getAdapter('demo-site').listPages({ http, config })) pages.push(page);
  return pages;
}

describe('DemoSiteAdapter', () => {
  it('walks every page and marks the last one', async () => {
    const pages = await crawl({ baseUrl });
    expect(pages.map((p) => p.pageNo)).toEqual([1, 2, 3]);
    expect(pages.map((p) => p.isLast)).toEqual([false, false, true]);
  });

  it('stops at maxPages without claiming completeness', async () => {
    const pages = await crawl({ baseUrl, maxPages: 2 });
    expect(pages).toHaveLength(2);
    expect(pages.at(-1)?.isLast).toBe(false);
  });

  it('parses every card into a listing that normalizes with the seeded aliases', async () => {
    const adapter = getAdapter('demo-site');
    const resolve = createAliasResolver(MAKE_MODEL_ALIAS_SEEDS);
    const pages = await crawl({ baseUrl });
    const listings = pages.flatMap((p) => adapter.parseList(p).listings);
    expect(listings).toHaveLength(45);
    for (const raw of listings) {
      const t = site.store.get(raw.externalId)!;
      expect(raw.year).toBe(String(t.year));
      expect(raw.fuel).toBe(t.fuel);
      expect(raw.transmission).toBe(t.transmission);
      expect(raw.city).toBe(t.city);
      expect(raw.color).toBe(t.color);
      expect(raw.bodyType).toBe(t.bodyType);
      expect(raw.title).toBe(`${t.year} ${t.make} ${t.model} ${t.trim}`);
      expect(raw.imageUrl).toBe(`${baseUrl}/img/${t.id}.jpg`);
      expect(raw.damage?.tramerAmount ?? null).toBe(t.tramerAmount === null ? null : String(t.tramerAmount));
      expect(raw.damage?.paintedParts).toEqual(t.paintedParts);
      expect(raw.damage?.changedParts).toEqual(t.changedParts);
      const r = normalizeListing(raw, resolve, new Date('2026-10-11T00:00:00Z'));
      expect(r.ok, JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(true);
      if (!r.ok) continue;
      const truth = site.store.get(raw.externalId)!;
      expect(r.listing.price).toBe(BigInt(truth.price));
      expect(r.listing.km).toBe(truth.km);
      expect(r.listing.url).toBe(`${baseUrl}/ilan/${truth.id}`);
      expect(r.listing.trim).toBe(truth.trim);
    }
  });

  it('every demo catalog model is covered by the alias seeds', () => {
    const resolve = createAliasResolver(MAKE_MODEL_ALIAS_SEEDS);
    for (const m of CATALOG)
      for (const trim of m.trims)
        expect(resolve(`${m.make} ${m.model} ${trim}`), `${m.make} ${m.model} ${trim}`).toEqual({ make: m.make, model: m.model, trim });
  });

  it('reports a problem per card when the layout changes', async () => {
    site.setMode('broken');
    const adapter = getAdapter('demo-site');
    const [first] = await crawl({ baseUrl, maxPages: 1 });
    const parsed = adapter.parseList(first);
    expect(parsed.listings).toHaveLength(0);
    expect(parsed.problems).toHaveLength(20);
    expect(parsed.problems[0]).toMatchObject({ field: expect.stringContaining('price'), problem: 'kartta zorunlu alan yok' });
    expect(parsed.problems[0].rawSnippet?.length).toBeLessThanOrEqual(300);
  });

  it('flags the demo captcha page', () => {
    expect(getAdapter('demo-site').isBlockedPage?.('<body data-demo-blocked>')).toBe(true);
  });

  it('rejects invalid config and unknown adapters', async () => {
    await expect(crawl({ baseUrl: 'not a url' })).rejects.toThrow();
    expect(() => getAdapter('sahibinden')).toThrow(/Bilinmeyen adapter/);
  });

  it('throws a non-transient FetchError when a list page is not 200', async () => {
    const failing: HttpFetcher = { getText: async (url) => ({ status: 404, body: '', url, headers: {} }) };
    const iterate = async () => {
      for await (const _ of getAdapter('demo-site').listPages({ http: failing, config: { baseUrl } })) void _;
    };
    await expect(iterate()).rejects.toMatchObject({ kind: 'HTTP_4XX', transient: false });
  });

  it('fails closed when the page has no recognisable data-has-next', async () => {
    const odd: HttpFetcher = { getText: async (url) => ({ status: 200, body: '<html><body><p>bakım</p></body></html>', url, headers: {} }) };
    const yielded: ListPage[] = [];
    const iterate = async () => {
      for await (const p of getAdapter('demo-site').listPages({ http: odd, config: { baseUrl } })) yielded.push(p);
    };
    await expect(iterate()).rejects.toThrow(/Sayfa yapısı tanınmadı/);
    expect(yielded).toHaveLength(0);
  });

  it('does not throw on bad URLs: bad href becomes a problem, bad image becomes null', () => {
    const html = `<main data-has-next="false">
<article data-listing data-id="a1" data-tramer="" data-painted="" data-changed=""><a class="link" href="http://"><h2 class="title">T</h2></a><span class="make-model">Fiat Egea</span><span class="price">1 TL</span></article>
<article data-listing data-id="a2" data-tramer="" data-painted="" data-changed=""><a class="link" href="/ilan/a2"><h2 class="title">T</h2></a><img class="photo" src="https://:80"><span class="make-model">Fiat Egea</span><span class="price">1 TL</span></article>
</main>`;
    const parsed = getAdapter('demo-site').parseList({ url: `${baseUrl}/ilanlar?sayfa=1`, pageNo: 1, html, isLast: true });
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]).toMatchObject({ externalId: 'a1', field: 'href', problem: 'geçersiz bağlantı' });
    expect(parsed.listings).toHaveLength(1);
    expect(parsed.listings[0].externalId).toBe('a2');
    expect(parsed.listings[0].imageUrl).toBeNull();
  });

  it('does not resolve inherited object keys as adapters', () => {
    expect(() => getAdapter('constructor')).toThrow(/Bilinmeyen adapter/);
    expect(() => getAdapter('toString')).toThrow(/Bilinmeyen adapter/);
  });
});
