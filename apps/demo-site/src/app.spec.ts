import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createDemoSite } from './index';

const site = () => createDemoSite({ seed: 7, size: 45, pageSize: 20, currentYear: 2026 });

describe('demo site HTTP', () => {
  it('serves robots.txt that hides control endpoints', async () => {
    const res = await request(site().app).get('/robots.txt');
    expect(res.text).toContain('Disallow: /__');
  });

  it('renders listing pages with the documented markup', async () => {
    const res = await request(site().app).get('/ilanlar?sayfa=1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-has-next="true"');
    expect(res.text.match(/data-listing /g)).toHaveLength(20);
    expect(res.text).toMatch(/class="price">\d{1,3}(\.\d{3})* TL</);
    expect(res.text).toMatch(/class="km">\d{1,3}(\.\d{3})* km</);
    const last = await request(site().app).get('/ilanlar?sayfa=3');
    expect(last.text).toContain('data-has-next="false"');
  });

  it('serves details and 404s removed listings', async () => {
    const s = site();
    const id = s.store.active()[0].id;
    expect((await request(s.app).get(`/ilan/${id}`)).status).toBe(200);
    s.store.patch(id, { status: 'REMOVED' });
    expect((await request(s.app).get(`/ilan/${id}`)).status).toBe(404);
  });

  it('supports control endpoints: inject, patch, tick, reset', async () => {
    const s = site();
    const injected = await request(s.app).post('/__inject').send({ discount: 0.2 });
    expect(injected.status).toBe(201);
    expect((await request(s.app).post(`/__patch/${injected.body.id}`).send({ price: 400000 })).body.price).toBe(400000);
    expect((await request(s.app).post('/__tick')).body.added).toHaveLength(5);
    await request(s.app).post('/__reset').send({ seed: 7, size: 10 });
    expect(s.store.active()).toHaveLength(10);
  });

  it('switches failure modes', async () => {
    const s = site();
    await request(s.app).post('/__mode').send({ mode: 'broken' });
    const broken = await request(s.app).get('/ilanlar?sayfa=1');
    expect(broken.text).toContain('data-listing');
    expect(broken.text).not.toContain('class="price"');
    await request(s.app).post('/__mode').send({ mode: 'captcha' });
    expect((await request(s.app).get('/ilanlar?sayfa=1')).text).toContain('data-demo-blocked');
    await request(s.app).post('/__mode').send({ mode: 'forbidden' });
    expect((await request(s.app).get('/ilanlar?sayfa=1')).status).toBe(403);
    expect((await request(s.app).post('/__mode').send({ mode: 'evil' })).status).toBe(400);
  });

  it('escapes HTML in injected values', async () => {
    const s = site();
    await request(s.app).post('/__inject').send({ city: '<script>x</script>' });
    expect((await request(s.app).get('/ilanlar?sayfa=1')).text).toContain('&lt;script&gt;');
  });

  it('first card carries every documented class and data attribute', async () => {
    const res = await request(site().app).get('/ilanlar?sayfa=1');
    expect(res.text).toContain('<main data-page="1" data-has-next="true">');
    const start = res.text.indexOf('<article');
    const first = res.text.slice(start, res.text.indexOf('</article>', start) + '</article>'.length);
    for (const needle of [
      'data-listing',
      'data-id="D0000',
      'data-tramer="',
      'data-painted="',
      'data-changed="',
      '<a class="link" href="/ilan/',
      'class="title"',
      '<img class="photo" src="/img/',
      'class="make-model"',
      'class="year"',
      'class="km"',
      'class="price"',
      'class="fuel"',
      'class="transmission"',
      'class="city"',
      'class="color"',
      'class="body"',
    ]) {
      expect(first, needle).toContain(needle);
    }
  });

  it('captcha page exposes the recaptcha marker', async () => {
    const s = site();
    await request(s.app).post('/__mode').send({ mode: 'captcha' });
    expect((await request(s.app).get('/ilanlar?sayfa=1')).text).toContain('class="g-recaptcha"');
  });

  it('broken mode keeps id and link attributes on cards', async () => {
    const s = site();
    await request(s.app).post('/__mode').send({ mode: 'broken' });
    const text = (await request(s.app).get('/ilanlar?sayfa=1')).text;
    expect(text).toContain('data-id="D0000');
    expect(text).toContain('class="link"');
  });

  it('rejects unknown or mistyped inject fields with 400', async () => {
    const s = site();
    const unknown = await request(s.app).post('/__inject').send({ id: 'X', status: 'REMOVED' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBeTypeOf('string');
    expect((await request(s.app).post('/__inject').send({ year: '<script>' })).status).toBe(400);
    expect((await request(s.app).post('/__inject').send({ discount: 'x' })).status).toBe(400);
    expect((await request(s.app).post('/__inject').send({ paintedParts: 'Kaput' })).status).toBe(400);
    expect((await request(s.app).post('/__inject').send([1, 2])).status).toBe(400);
  });

  it('rejects invalid patch bodies with 400', async () => {
    const s = site();
    const id = s.store.active()[0].id;
    expect((await request(s.app).post(`/__patch/${id}`).send({ price: 'abc' })).status).toBe(400);
    expect((await request(s.app).post(`/__patch/${id}`).send({ price: -1 })).status).toBe(400);
    expect((await request(s.app).post(`/__patch/${id}`).send({ status: 'SOLD' })).status).toBe(400);
    expect((await request(s.app).post(`/__patch/${id}`).send({ make: 'BMW' })).status).toBe(400);
  });

  it('accepts a discount above 1 but never prices below the floor', async () => {
    const s = site();
    const res = await request(s.app).post('/__inject').send({ discount: 5 });
    expect(res.status).toBe(201);
    expect(res.body.price).toBeGreaterThanOrEqual(50_000);
  });
});

describe('demo site listing images', () => {
  const png = (res: request.Response) => Buffer.from(res.body as Buffer);

  it('serves a deterministic cacheable PNG for a well-formed id', async () => {
    const s = site();
    const id = s.store.active()[0].id;
    const a = await request(s.app).get(`/img/${id}.jpg`).buffer(true);
    expect(a.status).toBe(200);
    expect(a.headers['content-type']).toMatch(/^image\/png/);
    expect(a.headers['cache-control']).toBe('public, max-age=3600');
    expect(png(a).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR: 64x48
    expect(png(a).readUInt32BE(16)).toBe(64);
    expect(png(a).readUInt32BE(20)).toBe(48);
    const again = await request(site().app).get(`/img/${id}.jpg`).buffer(true);
    expect(png(again)).toEqual(png(a));
    const other = await request(s.app).get('/img/D999999.jpg').buffer(true);
    expect(other.status).toBe(200);
    expect(png(other)).not.toEqual(png(a));
  });

  it('rejects malformed ids with 400', async () => {
    const app = site().app;
    // 'D000001xjpg': uzantı noktası birebir eşleşmeli (kaçışsız '.' herhangi bir karakteri kabul ederdi).
    for (const path of ['/img/bad%20id.jpg', '/img/D000001.png', '/img/.jpg', `/img/${'a'.repeat(65)}.jpg`, '/img/a%2Fb.jpg', '/img/D000001xjpg']) {
      expect((await request(app).get(path)).status, path).toBe(400);
    }
  });
});
