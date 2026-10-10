import { createDemoSite } from './app';

if (process.env.NODE_ENV === 'production') {
  console.error('Demo ilan sitesi yalnızca geliştirme/test içindir; NODE_ENV=production ile başlatılamaz.');
  process.exit(1);
}

const port = Number(process.env.DEMO_PORT ?? 4000);
const host = process.env.DEMO_HOST ?? '127.0.0.1';
const tickMs = Number(process.env.DEMO_TICK_MS ?? 60_000);
const site = createDemoSite({ seed: Number(process.env.DEMO_SEED ?? 42), size: Number(process.env.DEMO_SIZE ?? 2000) });

site.app.listen(port, host, () => {
  console.log(`Demo ilan sitesi: http://localhost:${port}/ilanlar (tick: ${tickMs > 0 ? `${tickMs} ms` : 'kapalı'})`);
});

if (tickMs > 0) {
  setInterval(() => {
    const s = site.store.tick();
    console.log(`tick: +${s.added.length} yeni, ${s.priceDropped.length} fiyat düşüşü, ${s.removed.length} kaldırma, ${s.relisted.length} geri gelen`);
  }, tickMs);
}
