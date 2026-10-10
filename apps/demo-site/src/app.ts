import express, { type Express } from 'express';
import { renderCaptchaPage, renderDetail, renderListPage } from './render';
import { DemoStore, type StoreOptions } from './store';

export type DemoMode = 'normal' | 'broken' | 'captcha' | 'forbidden';
const MODES: DemoMode[] = ['normal', 'broken', 'captcha', 'forbidden'];

export interface DemoSite {
  app: Express;
  store: DemoStore;
  setMode(mode: DemoMode): void;
}

/** Yalnızca geliştirme/test içindir. Kontrol uç noktaları (/__*) kimlik doğrulamasızdır. */
export function createDemoSite(opts: StoreOptions & { pageSize?: number }): DemoSite {
  const store = new DemoStore(opts);
  const pageSize = opts.pageSize ?? 20;
  let mode: DemoMode = 'normal';
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /__\nAllow: /\n');
  });

  app.get('/ilanlar', (req, res) => {
    if (mode === 'forbidden') return void res.status(403).type('html').send('<h1>Erişim engellendi</h1>');
    if (mode === 'captcha') return void res.status(200).type('html').send(renderCaptchaPage());
    const page = Math.max(1, Number.parseInt(String(req.query.sayfa ?? '1'), 10) || 1);
    const { items, hasNext } = store.page(page, pageSize);
    res.type('html').send(renderListPage(items, page, hasNext, mode === 'broken'));
  });

  app.get('/ilan/:id', (req, res) => {
    const listing = store.get(req.params.id);
    if (!listing || listing.status !== 'ACTIVE') return void res.status(404).type('html').send('<h1>İlan bulunamadı</h1>');
    res.type('html').send(renderDetail(listing));
  });

  app.post('/__tick', (_req, res) => void res.json(store.tick()));
  app.post('/__inject', (req, res) => void res.status(201).json(store.inject(req.body ?? {})));
  app.post('/__patch/:id', (req, res) => {
    const listing = store.patch(req.params.id, req.body ?? {});
    if (!listing) return void res.status(404).json({ error: 'not found' });
    res.json(listing);
  });
  app.post('/__mode', (req, res) => {
    const next = (req.body ?? {}).mode as DemoMode;
    if (!MODES.includes(next)) return void res.status(400).json({ error: `mode one of ${MODES.join(', ')}` });
    mode = next;
    res.json({ mode });
  });
  app.post('/__reset', (req, res) => {
    const body = req.body ?? {};
    store.reset(Number(body.seed ?? opts.seed), Number(body.size ?? opts.size));
    mode = 'normal';
    res.json({ ok: true });
  });

  return { app, store, setMode: (m) => void (mode = m) };
}
