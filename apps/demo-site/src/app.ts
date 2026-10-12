import express, { type Express } from 'express';
import { renderCaptchaPage, renderDetail, renderListPage } from './render';
import { IMAGE_ID_PATTERN, listingImagePng } from './image';
import { DemoStore, type StoreOptions } from './store';

export type DemoMode = 'normal' | 'broken' | 'captcha' | 'forbidden';
const MODES: DemoMode[] = ['normal', 'broken', 'captcha', 'forbidden'];

const INJECT_TEXT = ['make', 'model', 'trim', 'fuel', 'transmission', 'city', 'color', 'bodyType'];
const INJECT_INT = ['year', 'km', 'price'];
const INJECT_PARTS = ['paintedParts', 'changedParts'];
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** /__inject gövdesini beyaz listeye göre doğrular; geçersizse hata metnini döndürür. */
export function validateInject(body: unknown): string | null {
  if (!isPlainObject(body)) return 'body must be a JSON object';
  for (const [key, value] of Object.entries(body)) {
    const ok =
      (INJECT_TEXT.includes(key) && typeof value === 'string') ||
      (INJECT_INT.includes(key) && isInt(value)) ||
      (key === 'tramerAmount' && (value === null || isInt(value))) ||
      (INJECT_PARTS.includes(key) && isStrArr(value)) ||
      (key === 'discount' && typeof value === 'number' && Number.isFinite(value));
    if (!ok) return `invalid field: ${key}`;
  }
  return null;
}

/** /__patch gövdesini doğrular: yalnızca price (tamsayı >= 0) ve status. */
export function validatePatch(body: unknown): string | null {
  if (!isPlainObject(body)) return 'body must be a JSON object';
  for (const [key, value] of Object.entries(body)) {
    if (key === 'price' && isInt(value) && value >= 0) continue;
    if (key === 'status' && (value === 'ACTIVE' || value === 'REMOVED')) continue;
    return `invalid field: ${key}`;
  }
  return null;
}

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

  // İlan görseli: kimlikten türetilen deterministik küçük PNG. URL (`/img/<id>.jpg`) adapter ve kayıtlı imageUrl'lerle
  // uyumlu kalsın diye .jpg uzantılıdır; içerik türü dürüstçe image/png'dir. Bilinmeyen ama biçimi geçerli kimlik de
  // görsel alır (sade ve deterministik); biçimsiz kimlik 400.
  app.get('/img/:file', (req, res) => {
    const m = /^(.+)\.jpg$/.exec(req.params.file);
    if (!m || !IMAGE_ID_PATTERN.test(m[1]!)) return void res.status(400).type('text/plain').send('invalid image id');
    res.set('Cache-Control', 'public, max-age=3600').type('image/png').send(listingImagePng(m[1]!));
  });

  app.post('/__tick', (_req, res) => void res.json(store.tick()));
  app.post('/__inject', (req, res) => {
    const body = req.body ?? {};
    const error = validateInject(body);
    if (error) return void res.status(400).json({ error });
    res.status(201).json(store.inject(body));
  });
  app.post('/__patch/:id', (req, res) => {
    const body = req.body ?? {};
    const error = validatePatch(body);
    if (error) return void res.status(400).json({ error });
    const listing = store.patch(req.params.id, body);
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
