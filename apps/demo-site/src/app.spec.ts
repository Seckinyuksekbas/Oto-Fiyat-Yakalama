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
});
