# Plan 02 — Toplama Hattı Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** İzinli kaynaklardan ilanları kibar (robots + hız limiti) biçimde toplayan, normalize edip mükerrersiz kaydeden, fiyat geçmişini ve kaybolan ilanları izleyen, kaynak sağlığını ve alarmları yöneten worker/scheduler süreçleri ile uçtan uca test edilebilir bir demo ilan sitesi.

**Architecture:** Framework'süz `@oto/collection` paketi (tipler, normalizer, `PoliteHttpClient`, adapter registry, demo adapter) + `apps/demo-site` (Express, deterministik sahte ilan sitesi) + `apps/worker` (NestJS application context; `ROLE=worker` BullMQ `scrape` kuyruğunu işler, `ROLE=scheduler` periyodik iş üretir). Ingest, scrape job'u içinde senkron çalışır ve değişen ilanlar için `analyze` kuyruğuna iş bırakır (tüketicisi Plan 03).

**Tech Stack:** Node 22, TypeScript, NestJS 11 (app context), BullMQ 5, ioredis, undici 6, cheerio 1, robots-parser 3, Prisma 6, Express 5 (demo), Vitest + Testcontainers.

**Spec:** `docs/superpowers/specs/2026-10-10-oto-firsat-platformu-design.md` (§1 akış, §2 kaynak/ilan modelleri, §3 scraper katmanı, §6 saklama süreleri, §9 alarmlar). Yol haritası: `docs/superpowers/plans/2026-10-10-00-roadmap.md` (Plan 02 satırı).

## Spec'ten bilinçli sapmalar (bu planın kararları)

| Spec | Bu plan | Gerekçe |
|---|---|---|
| `[scrape] → [ingest]` ayrı kuyruk | Ingest scrape job'u içinde senkron | Job başına doğru sayaçlar (yeni/güncellenen/kaldırılan) ve tutarlı PARTIAL/SUCCEEDED durumu; ingest DB'ye bağlı ve ucuz, ayrı ölçeklemeye ihtiyaç yok. `analyze` kuyruğu ayrı kalır. |
| Playwright `BrowserPool` iskeleti | Ertelendi | Üretimde BROWSER kaynak yok; Chromium indirmesi CI/imajı şişirir. `kind` alanı ve adapter arayüzü hazır; ilk BROWSER kaynakla eklenecek. |
| ETag / If-Modified-Since | Ertelendi | Liste sayfaları her taramada değişir; kazanç düşük. |
| `fetchDetail` | Ertelendi | Demo kaynak tüm alanları liste kartında verir; detay gereken ilk kaynakla eklenecek. |
| İlan kaybolma: `lastSeenAt` eşiği | Tam tarama bittiğinde, o taramada görülmeyen ilanlar `REMOVED` | Kesin ve hızlı; yalnızca tam/sağlıklı taramada uygulanır (Review Focus #1). |
| Yeni externalId ile yeniden yayın sezgisi | Ertelendi (Plan 04) | Eşleştirme/bildirim tarafında anlam kazanıyor. |
| Scheduler: tekrarlayan BullMQ job'ları | Scheduler her `SCHEDULER_TICK_MS`'de DB'ye bakıp zamanı gelen kaynak için iş üretir | Basit, test edilebilir, kaynak ayarı değişince anında uygulanır; tek instance. |
| `maxConcurrency` | Sayfalar sıralı çekilir; kaynak başına aynı anda tek çalışan iş (scheduler garanti eder) | Detay çekimi yokken eşzamanlılık gereksiz; alan Plan 07+ için şemada kalır. |
| Admin kaynak/iş uç noktaları, manuel test taraması | Plan 07 | Yol haritası. Kuyruk sözleşmesi (`scrape` iş verisi) bu planda sabitlenir. |

## Global Constraints

- Plan 01'in tüm Global Constraints maddeleri geçerlidir (TS strict, Türkçe kullanıcı mesajları, İngilizce kod/commit, secret'lar env'den, loglarda maskeleme).
- Yalnızca `isActive=true` VE `permissionVerifiedAt` dolu VE `health != PAUSED` kaynaklar taranır. Sahibinden/Arabam adapter'ı yazılmaz.
- Erişim kontrolü atlatma yok: stealth, parmak izi gizleme, captcha çözme, UA sahteciliği, engele tepki olarak IP/proxy döndürme YASAK. 403 / captcha / robots disallow → `BlockedError` → kaynak `PAUSED`, yeniden deneme yok.
- User-Agent: `OtoFirsatBot/1.0 (+<BOT_CONTACT_URL>)`.
- robots.txt: Redis'te 24 saat önbellek; 4xx → her şey serbest; 5xx/ağ hatası → geçici hata.
- HTTP: bağlantı zaman aşımı 10 sn, başlık/gövde 30 sn; en fazla 3 deneme; bekleme `500ms · 2^(deneme-1)`; `Retry-After` uyulur, en fazla 60 sn; en fazla 3 yönlendirme.
- Hız limiti: kaynak başına `minRequestGapMs`, tüm worker'lar arasında Redis üzerinden global.
- Doğrulama: yıl 1980 … (bu yıl + 1); km 0 … 1.500.000; fiyat 50.000 … 50.000.000 TL (tam sayı). Geçersiz veri ingest edilmez, `ListingIssue` yazılır.
- Kaynak sağlığı: ardışık 3 hata → `DEGRADED`, 6 → `DOWN`; ayrıştırma/doğrulama hata oranı > %20 → `DEGRADED` + alarm.
- Alarm: her seferinde `SystemLog`; aynı anahtar için 30 dk içinde en fazla bir kez aktif ADMIN/SUPER_ADMIN kullanıcılara `Notification(kind=SYSTEM_ALERT, channel=IN_APP, status=SENT)`.
- Kaldırma (`REMOVED`) yalnızca: tarama tamamlandı (son sayfa görüldü) VE en az 1 kart VE hata oranı ≤ %20 VE kaynak `config.fullCrawl !== false`.
- Aynı kaynak için aynı anda en fazla bir `QUEUED`/`RUNNING` `CollectionJob`; 30 dk'dan eski `QUEUED`/`RUNNING` iş `FAILED` (stale) sayılır.
- BullMQ job id'leri `:` içermez. Para DB'de `BigInt`, kuyruk verisinde rakam dizgisi.
- `SystemLog`, `ScrapeError`, `ListingIssue` 30 günden eski kayıtlar günlük temizlenir.
- Proxy URL'leri yalnızca çözülmüş halde bellekte tutulur; loglara/hata mesajlarına yazılmaz.

## Review Focus

1. **Kaynak sayfa yapısını değiştirir (bozuk/boş HTML):** Hiçbir ilan yanlışlıkla `REMOVED` olmamalı, çöp veri kaydedilmemeli; kaynak `DEGRADED` olmalı ve alarm düşmeli. → Task 8 testi.
2. **Tarama sürerken sayfalama kayar (yeni ilan 1. sayfaya girer, bir ilan iki sayfada görünür):** Mükerrer kayıt, ek fiyat geçmişi satırı veya çift "yeni" sayımı olmamalı. → Task 7 testi.
3. **Fiyat/km metin biçimleri** (`"1.250.000 TL"`, `"1.250.000,00 TL"`, `"₺1,250,000"`, `"85.000 km"`): Doğru tam sayıya çevrilmeli; kuruş kısmı sayıyı 100 kat büyütmemeli. → Task 2 testi.
4. **Worker iş ortasında çöker:** `CollectionJob` sonsuza dek `RUNNING` kalıp kaynağı kilitlememeli; scheduler toparlamalı. → Task 9 testi.
5. **Kaynak 429/`Retry-After` döner veya birden çok worker aynı kaynağa istek atar:** İstemci beklemeye uymalı (üst sınırla), hız limiti süreçler arası korunmalı. → Task 3 testi.

## Ön Koşullar

- Docker Desktop çalışır olmalı (`docker info`). Testcontainers ve dev stack için.
- Plan 01 `main`'de. Dev host portları: Postgres 5433, Redis 6380.

## Dosya Haritası

```
packages/server-common/   src/{index,encryptor,tokens,redact}.ts (+ api'den taşınan spec'ler)
packages/testing/         src/index.ts  (startTestInfra, startRedis, truncateAll)
packages/shared/          src/queues.ts (+ spec)
packages/db/              prisma/schema.prisma (CollectionJob.listingsRemoved), migrations/20261011000000_collection_job_removed/
                          src/seed-data.ts (alias + demo kaynak seed'leri), prisma/seed.ts
packages/collection/      src/{index,types,normalize,errors,rate-limiter,robots,http-client,adapter,registry}.ts
                          src/adapters/demo-site.adapter.ts  (+ spec'ler)
apps/demo-site/           src/{index,catalog,generator,store,render,app,main}.ts (+ spec'ler)
apps/worker/              src/main.ts, src/core.module.ts, src/worker-app.module.ts, src/scheduler-app.module.ts
                          src/config/{env,config.module}.ts  src/infra/{prisma.service,redis.service,bull}.ts
                          src/queues/queue-registry.ts  src/common/{alert.service,heartbeat.service}.ts
                          src/collection/{collection.module,alias.service,ingest.service,source-health.service,scrape-runner.service}.ts
                          src/scheduler/{scheduler.module,scheduler.service,scheduler-loop.service}.ts
                          src/processors/scrape-worker.host.ts
                          test/{global-setup,setup-env,helpers}.ts + *.e2e.spec.ts
docs/adding-a-source.md, docs/architecture.md, README.md, .env.example
```

---

### Task 1: Ortak sunucu paketi, test altyapısı paketi, kuyruk sözleşmesi

**Files:**
- Create: `packages/server-common/{package.json,tsconfig.json,tsconfig.build.json}`, `packages/server-common/src/{index,redact}.ts`
- Move (git mv): `apps/api/src/common/crypto/encryptor.ts` → `packages/server-common/src/encryptor.ts`; `encryptor.spec.ts`, `tokens.ts`, `tokens.spec.ts` aynı şekilde
- Create: `packages/testing/{package.json,tsconfig.json,tsconfig.build.json}`, `packages/testing/src/index.ts`
- Create: `packages/shared/src/queues.ts`, `packages/shared/src/queues.spec.ts`; Modify: `packages/shared/src/index.ts`
- Modify: `apps/api/package.json`, `apps/api/src/common/crypto/crypto.module.ts`, `apps/api/src/common/logger.ts`, `apps/api/src/modules/auth/{session.service,email-verification.service,password-reset.service}.ts`, `apps/api/test/global-setup.ts`, `apps/api/test/helpers.ts`, root `package.json`

**Interfaces:**
- Produces: `@oto/server-common`: `Encryptor`, `generateToken`, `hashToken`, `REDACT_PATHS`. `@oto/testing`: `startTestInfra(): Promise<TestInfra>`, `startRedis(): Promise<{ url: string; stop(): Promise<void> }>`, `truncateAll(db: RawSqlClient): Promise<void>`. `@oto/shared`: `QueueName`, `scrapeJobSchema`/`ScrapeJobData`, `analyzeReasonSchema`/`AnalyzeReason`, `analyzeJobSchema`/`AnalyzeJobData`.

- [ ] **Step 1: Kuyruk sözleşmesi için başarısız testi yaz** (`packages/shared/src/queues.spec.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { analyzeJobSchema, QueueName, scrapeJobSchema } from './index';

describe('queue contracts', () => {
  it('names queues without colons (BullMQ restriction)', () => {
    for (const name of Object.values(QueueName)) expect(name).not.toContain(':');
  });

  it('validates scrape job data', () => {
    expect(scrapeJobSchema.parse({ collectionJobId: 3, sourceId: 1 })).toEqual({ collectionJobId: 3, sourceId: 1 });
    expect(scrapeJobSchema.safeParse({ collectionJobId: 0, sourceId: 1 }).success).toBe(false);
  });

  it('carries money as a digit string, never a number', () => {
    expect(analyzeJobSchema.safeParse({ listingId: 1, reason: 'PRICE_CHANGE', previousPrice: '960000' }).success).toBe(true);
    expect(analyzeJobSchema.safeParse({ listingId: 1, reason: 'PRICE_CHANGE', previousPrice: 960000 }).success).toBe(false);
    expect(analyzeJobSchema.safeParse({ listingId: 1, reason: 'NOPE' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu gör**

Run: `pnpm --filter @oto/shared test`
Expected: FAIL — `QueueName` export'u yok.

- [ ] **Step 3: `packages/shared/src/queues.ts` yaz ve export et**

```ts
import { z } from 'zod';

/** BullMQ kuyruk adları. `:` içeremez. */
export const QueueName = {
  SCRAPE: 'scrape',
  ANALYZE: 'analyze',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const scrapeJobSchema = z.object({
  collectionJobId: z.number().int().positive(),
  sourceId: z.number().int().positive(),
});
export type ScrapeJobData = z.infer<typeof scrapeJobSchema>;

export const analyzeReasonSchema = z.enum(['NEW', 'PRICE_CHANGE', 'RELIST', 'UPDATE']);
export type AnalyzeReason = z.infer<typeof analyzeReasonSchema>;

export const analyzeJobSchema = z.object({
  listingId: z.number().int().positive(),
  reason: analyzeReasonSchema,
  /** Önceki fiyat (TL, rakam dizgisi) — yalnızca PRICE_CHANGE'de */
  previousPrice: z.string().regex(/^\d+$/).optional(),
});
export type AnalyzeJobData = z.infer<typeof analyzeJobSchema>;
```

`packages/shared/src/index.ts` sonuna ekle: `export * from './queues';`

Run: `pnpm --filter @oto/shared test` → PASS.

- [ ] **Step 4: `@oto/server-common` paketini oluştur ve kripto dosyalarını taşı**

`packages/server-common/package.json`:
```json
{
  "name": "@oto/server-common",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "devDependencies": { "vitest": "^3.0.5" }
}
```

`packages/server-common/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["node"] },
  "include": ["src"]
}
```

`packages/server-common/tsconfig.build.json`:
```json
{ "extends": "./tsconfig.json", "exclude": ["src/**/*.spec.ts"] }
```

Taşı:
```bash
mkdir -p packages/server-common/src
git mv apps/api/src/common/crypto/encryptor.ts packages/server-common/src/encryptor.ts
git mv apps/api/src/common/crypto/encryptor.spec.ts packages/server-common/src/encryptor.spec.ts
git mv apps/api/src/common/crypto/tokens.ts packages/server-common/src/tokens.ts
git mv apps/api/src/common/crypto/tokens.spec.ts packages/server-common/src/tokens.spec.ts
```
(Spec'ler `./encryptor` / `./tokens`'ı göreli import ettiği için değişmeden çalışır.)

`packages/server-common/src/redact.ts`:
```ts
const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'refreshToken',
  'accessToken',
  'chatId',
  'config',
  'proxyUrl',
  'urlEncrypted',
];

/** pino joker karakterleri tam bir seviyeyi eşler; üst seviye, 1 ve 2 seviye derinlik kapsanır. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]),
];
```

`packages/server-common/src/index.ts`:
```ts
export * from './encryptor';
export * from './tokens';
export * from './redact';
```

- [ ] **Step 5: API'yi yeni pakete bağla**

`apps/api/package.json` `dependencies`'e ekle: `"@oto/server-common": "workspace:*"`. `devDependencies`'ten `@testcontainers/postgresql` ve `@testcontainers/redis`'i kaldır, `"@oto/testing": "workspace:*"` ekle.

`apps/api/src/common/crypto/crypto.module.ts` içinde `import { Encryptor } from './encryptor';` satırını `import { Encryptor } from '@oto/server-common';` yap.

`apps/api/src/modules/auth/session.service.ts`, `email-verification.service.ts`, `password-reset.service.ts` içinde `import { generateToken, hashToken } from '../../common/crypto/tokens';` → `import { generateToken, hashToken } from '@oto/server-common';`.

`apps/api/src/common/logger.ts` içinde `SENSITIVE_KEYS` ve `REDACT_PATHS` tanımlarını sil, yerine:
```ts
import { REDACT_PATHS } from '@oto/server-common';

export { REDACT_PATHS };
```
(`logger.spec.ts` `./logger`'dan `REDACT_PATHS` import etmeye devam eder.)

- [ ] **Step 6: `@oto/testing` paketini oluştur**

`packages/testing/package.json`:
```json
{
  "name": "@oto/testing",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@testcontainers/postgresql": "^10.18.0",
    "@testcontainers/redis": "^10.18.0"
  }
}
```
`tsconfig.json` / `tsconfig.build.json`: `packages/server-common`'dakilerle aynı içerik.

`packages/testing/src/index.ts`:
```ts
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';

export interface TestInfra {
  databaseUrl: string;
  redisUrl: string;
  stop(): Promise<void>;
}

/** Postgres 16 + Redis 7 container'larını başlatır ve tüm Prisma migration'larını uygular. */
export async function startTestInfra(): Promise<TestInfra> {
  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  const stop = async () => {
    await Promise.all([pg.stop(), redis.stop()]);
  };
  try {
    const databaseUrl = pg.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', {
      cwd: resolve(__dirname, '../../db'),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
    return { databaseUrl, redisUrl: redis.getConnectionUrl(), stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

export async function startRedis(): Promise<{ url: string; stop(): Promise<void> }> {
  const redis = await new RedisContainer('redis:7-alpine').start();
  return { url: redis.getConnectionUrl(), stop: async () => void (await redis.stop()) };
}

export interface RawSqlClient {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
  $executeRawUnsafe(query: string): Promise<number>;
}

/** `_prisma_migrations` hariç tüm tabloları boşaltır ve kimlik sayaçlarını sıfırlar. */
export async function truncateAll(db: RawSqlClient): Promise<void> {
  const tables = await db.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (tables.length === 0) return;
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}
```

- [ ] **Step 7: API test altyapısını yeni pakete taşı**

`apps/api/test/global-setup.ts` (tamamı):
```ts
import { startTestInfra } from '@oto/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const infra = await startTestInfra();
  project.provide('databaseUrl', infra.databaseUrl);
  project.provide('redisUrl', infra.redisUrl);
  return infra.stop;
}
```

`apps/api/test/helpers.ts` içinde `resetState`'in tablo sorgusu + TRUNCATE kısmını şu tek satırla değiştir ve `import { truncateAll } from '@oto/testing';` ekle:
```ts
  await truncateAll(prisma);
```

- [ ] **Step 8: Her şeyi çalıştır**

Run: `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`
Expected: Hepsi PASS. `@oto/server-common` testleri (encryptor 9, tokens 2) yeni yerinde çalışır; api unit sayısı 11 azalır; api e2e 60/60.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: extract server-common and testing packages; add queue contracts"
```

---

### Task 2: `@oto/collection` — tipler ve normalizer

**Files:**
- Create: `packages/collection/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts,vitest.e2e.config.ts}`
- Create: `packages/collection/src/{index,types,normalize}.ts`
- Test: `packages/collection/src/normalize.spec.ts`

**Interfaces:**
- Produces: `Fuel`, `Transmission`, `SourceKind`, `RawListing`, `DamageInfo`, `NormalizedListing`, `ListingProblem`; `MakeModel`, `MakeModelResolver`, `AliasRow`, `LIMITS`, `normalizeText(s)`, `parseInteger(input)`, `parseFuel(s)`, `parseTransmission(s)`, `createAliasResolver(rows)`, `contentHash(listing)`, `normalizeListing(raw, resolve, now?) → NormalizeResult`.

- [ ] **Step 1: Paket dosyaları**

`packages/collection/package.json`:
```json
{
  "name": "@oto/collection",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "test:e2e": "vitest run -c vitest.e2e.config.ts"
  },
  "dependencies": { "zod": "^3.24.1" },
  "devDependencies": { "vitest": "^3.0.5" }
}
```

`tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["node"] },
  "include": ["src"]
}
```
`tsconfig.build.json`:
```json
{ "extends": "./tsconfig.json", "exclude": ["src/**/*.spec.ts"] }
```
`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.spec.ts'], exclude: ['src/**/*.e2e.spec.ts', 'node_modules/**'] },
});
```
`vitest.e2e.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.e2e.spec.ts'], testTimeout: 60_000, hookTimeout: 180_000 },
});
```

- [ ] **Step 2: Başarısız testleri yaz** (`packages/collection/src/normalize.spec.ts`)

```ts
import { describe, expect, it } from 'vitest';
import {
  contentHash,
  createAliasResolver,
  normalizeListing,
  parseFuel,
  parseInteger,
  parseTransmission,
  type RawListing,
} from './index';

const resolve = createAliasResolver([
  { rawText: 'BMW 3 Serisi', make: 'BMW', model: '3 Serisi', trim: null },
  { rawText: 'BMW 3 Serisi 320i M Sport', make: 'BMW', model: '3 Serisi', trim: '320i M Sport' },
  { rawText: 'Mercedes-Benz C Serisi', make: 'Mercedes-Benz', model: 'C Serisi', trim: null },
]);

const NOW = new Date('2026-10-11T12:00:00Z');

const raw = (over: Partial<RawListing> = {}): RawListing => ({
  externalId: 'A1',
  url: 'https://demo.example/ilan/A1',
  title: '2019 BMW 3 Serisi 320i',
  makeModelText: 'BMW 3 Serisi 320i',
  year: '2019',
  km: '85.000 km',
  price: '960.000 TL',
  fuel: 'Benzin',
  transmission: 'Otomatik',
  city: 'İstanbul',
  ...over,
});

describe('parseInteger', () => {
  it.each([
    ['1.250.000 TL', 1_250_000],
    ['1.250.000,00 TL', 1_250_000],
    ['1.250.000,5 TL', 1_250_000],
    ['₺1,250,000', 1_250_000],
    ['85.000 km', 85_000],
    ['1250000', 1_250_000],
    [960000, 960_000],
  ])('%s → %d', (input, expected) => {
    expect(parseInteger(input)).toBe(expected);
  });

  it.each(['', 'yok', '12345678901234', 12.5])('rejects %s', (input) => {
    expect(parseInteger(input)).toBeNull();
  });
});

describe('fuel / transmission', () => {
  it('maps Turkish labels case-insensitively (Turkish locale)', () => {
    expect(parseFuel('BENZİN')).toBe('GASOLINE');
    expect(parseFuel('Benzin & LPG')).toBe('LPG');
    expect(parseFuel('Hibrit')).toBe('HYBRID');
    expect(parseFuel('Hidrojen')).toBe('OTHER');
    expect(parseTransmission('OTOMATİK')).toBe('AUTOMATIC');
    expect(parseTransmission('Yarı Otomatik')).toBe('SEMI_AUTOMATIC');
    expect(parseTransmission('Düz')).toBe('MANUAL');
    expect(parseTransmission('CVT?')).toBeNull();
  });
});

describe('createAliasResolver', () => {
  it('uses the longest matching alias and keeps the remainder as trim', () => {
    expect(resolve('BMW 3 Serisi 320i M Sport')).toEqual({ make: 'BMW', model: '3 Serisi', trim: '320i M Sport' });
    expect(resolve('bmw  3 serisi 318i')).toEqual({ make: 'BMW', model: '3 Serisi', trim: '318i' });
    expect(resolve('BMW 3 Serisi')).toEqual({ make: 'BMW', model: '3 Serisi', trim: null });
  });

  it('does not match a prefix in the middle of a word', () => {
    expect(resolve('BMW 3 Serisix 320i')).toBeNull();
    expect(resolve('Tesla Model 3')).toBeNull();
  });
});

describe('normalizeListing', () => {
  it('normalizes a valid listing', () => {
    const r = normalizeListing(raw({ damage: { tramerAmount: '12.500 TL', paintedParts: [' Kaput '], changedParts: [] } }), resolve, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.listing).toMatchObject({
      externalId: 'A1',
      make: 'BMW',
      model: '3 Serisi',
      trim: '320i',
      year: 2019,
      km: 85_000,
      price: 960_000n,
      currency: 'TRY',
      fuel: 'GASOLINE',
      transmission: 'AUTOMATIC',
      city: 'İstanbul',
      damageInfo: { tramerAmount: 12_500, paintedParts: ['Kaput'], changedParts: [] },
    });
    expect(r.listing.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('collects every problem instead of stopping at the first', () => {
    const r = normalizeListing(
      raw({ makeModelText: 'Tesla Model 3', year: '1975', km: '2.000.000 km', price: '10 TL', transmission: '?', url: 'ftp://x' }),
      resolve,
      NOW,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.field).sort()).toEqual(['km', 'makeModel', 'price', 'transmission', 'url', 'year']);
    expect(r.problems.every((p) => p.externalId === 'A1')).toBe(true);
  });

  it('accepts next model year but not the one after', () => {
    expect(normalizeListing(raw({ year: 2027 }), resolve, NOW).ok).toBe(true);
    expect(normalizeListing(raw({ year: 2028 }), resolve, NOW).ok).toBe(false);
  });

  it('drops empty damage info and non-http image URLs', () => {
    const r = normalizeListing(raw({ damage: { tramerAmount: '', paintedParts: [], changedParts: [] }, imageUrl: 'javascript:alert(1)' }), resolve, NOW);
    expect(r.ok && r.listing.damageInfo).toBeNull();
    expect(r.ok && r.listing.imageUrl).toBeNull();
  });
});

describe('contentHash', () => {
  it('is stable and changes when a field changes', () => {
    const a = normalizeListing(raw(), resolve, NOW);
    const b = normalizeListing(raw(), resolve, NOW);
    const c = normalizeListing(raw({ price: '950.000 TL' }), resolve, NOW);
    if (!a.ok || !b.ok || !c.ok) throw new Error('unexpected');
    expect(a.listing.contentHash).toBe(b.listing.contentHash);
    expect(a.listing.contentHash).not.toBe(c.listing.contentHash);
    const { contentHash: _h, ...rest } = a.listing;
    expect(contentHash(rest)).toBe(a.listing.contentHash);
  });
});
```

- [ ] **Step 3: Testin başarısız olduğunu gör**

Run: `pnpm install && pnpm --filter @oto/collection test`
Expected: FAIL — `./index` bulunamıyor.

- [ ] **Step 4: Uygulamayı yaz**

`packages/collection/src/types.ts`:
```ts
export type Fuel = 'GASOLINE' | 'DIESEL' | 'LPG' | 'HYBRID' | 'ELECTRIC' | 'OTHER';
export type Transmission = 'MANUAL' | 'AUTOMATIC' | 'SEMI_AUTOMATIC';
export type SourceKind = 'HTTP' | 'BROWSER' | 'API' | 'FEED';

/** Adapter'ın kaynaktan çıkardığı ham ilan; metin alanları henüz ayrıştırılmamıştır. */
export interface RawListing {
  externalId: string;
  url: string;
  title: string;
  makeModelText: string;
  year: string | number;
  km: string | number;
  price: string | number;
  fuel: string;
  transmission: string;
  city?: string | null;
  imageUrl?: string | null;
  bodyType?: string | null;
  color?: string | null;
  sellerType?: string | null;
  damage?: {
    tramerAmount?: string | number | null;
    paintedParts?: string[];
    changedParts?: string[];
  } | null;
}

export interface DamageInfo {
  tramerAmount: number | null;
  paintedParts: string[];
  changedParts: string[];
}

export interface NormalizedListing {
  externalId: string;
  url: string;
  title: string;
  make: string;
  model: string;
  trim: string | null;
  year: number;
  km: number;
  price: bigint;
  currency: 'TRY';
  fuel: Fuel;
  transmission: Transmission;
  city: string | null;
  imageUrl: string | null;
  bodyType: string | null;
  color: string | null;
  sellerType: string | null;
  damageInfo: DamageInfo | null;
  contentHash: string;
}

/** Ayrıştırılamayan veya doğrulanamayan bir ilan; `ListingIssue` olarak saklanır. */
export interface ListingProblem {
  externalId?: string;
  field: string;
  problem: string;
  rawSnippet?: string;
}
```

`packages/collection/src/normalize.ts`:
```ts
import { createHash } from 'node:crypto';
import type { DamageInfo, Fuel, ListingProblem, NormalizedListing, RawListing, Transmission } from './types';

export interface MakeModel {
  make: string;
  model: string;
  trim: string | null;
}
export type MakeModelResolver = (text: string) => MakeModel | null;
export interface AliasRow {
  rawText: string;
  make: string;
  model: string;
  trim: string | null;
}

export const LIMITS = { minYear: 1980, minKm: 0, maxKm: 1_500_000, minPrice: 50_000, maxPrice: 50_000_000 } as const;

const FUELS: Record<string, Fuel> = {
  benzin: 'GASOLINE',
  dizel: 'DIESEL',
  lpg: 'LPG',
  'benzin & lpg': 'LPG',
  'benzin/lpg': 'LPG',
  hibrit: 'HYBRID',
  hybrid: 'HYBRID',
  elektrik: 'ELECTRIC',
  elektrikli: 'ELECTRIC',
};

const TRANSMISSIONS: Record<string, Transmission> = {
  manuel: 'MANUAL',
  düz: 'MANUAL',
  otomatik: 'AUTOMATIC',
  'yarı otomatik': 'SEMI_AUTOMATIC',
  'yarı-otomatik': 'SEMI_AUTOMATIC',
};

export function normalizeText(s: string): string {
  return s.toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim();
}

/** "1.250.000 TL", "1.250.000,00 TL", "₺1,250,000", "85.000 km" → tam sayı. Kuruş kısmı atılır. */
export function parseInteger(input: string | number): number | null {
  if (typeof input === 'number') return Number.isSafeInteger(input) ? input : null;
  const withoutCents = input.trim().replace(/,\d{1,2}(?=\D*$)/, '');
  const digits = withoutCents.replace(/\D/g, '');
  if (digits.length === 0 || digits.length > 12) return null;
  return Number(digits);
}

export function parseFuel(s: string): Fuel {
  return FUELS[normalizeText(s)] ?? 'OTHER';
}

export function parseTransmission(s: string): Transmission | null {
  return TRANSMISSIONS[normalizeText(s)] ?? null;
}

/** En uzun eşleşen takma ad kazanır; takma adın ötesindeki kelimeler `trim` olur. */
export function createAliasResolver(rows: AliasRow[]): MakeModelResolver {
  const entries = rows
    .map((row) => ({ key: normalizeText(row.rawText), row }))
    .sort((a, b) => b.key.length - a.key.length);
  return (text) => {
    const original = text.replace(/\s+/g, ' ').trim();
    const norm = normalizeText(original);
    for (const { key, row } of entries) {
      if (norm === key || norm.startsWith(`${key} `)) {
        const rest = original.slice(key.length).trim();
        return { make: row.make, model: row.model, trim: row.trim ?? (rest || null) };
      }
    }
    return null;
  };
}

function clean(s: string | null | undefined, max = 120): string | null {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

function httpUrl(s: string | null | undefined): string | null {
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function parseDamage(d: RawListing['damage']): DamageInfo | null {
  if (!d) return null;
  const tramerAmount = d.tramerAmount === null || d.tramerAmount === undefined || d.tramerAmount === '' ? null : parseInteger(d.tramerAmount);
  const paintedParts = (d.paintedParts ?? []).map((p) => p.trim()).filter(Boolean);
  const changedParts = (d.changedParts ?? []).map((p) => p.trim()).filter(Boolean);
  if (tramerAmount === null && paintedParts.length === 0 && changedParts.length === 0) return null;
  return { tramerAmount, paintedParts, changedParts };
}

export function contentHash(listing: Omit<NormalizedListing, 'contentHash'>): string {
  const json = JSON.stringify(listing, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  return createHash('sha256').update(json).digest('hex');
}

export type NormalizeResult = { ok: true; listing: NormalizedListing } | { ok: false; problems: ListingProblem[] };

export function normalizeListing(raw: RawListing, resolve: MakeModelResolver, now: Date = new Date()): NormalizeResult {
  const problems: ListingProblem[] = [];
  const externalId = (raw.externalId ?? '').trim();
  const fail = (field: string, problem: string) => problems.push({ externalId: externalId || undefined, field, problem });

  if (!externalId || externalId.length > 100) fail('externalId', 'boş veya 100 karakterden uzun');
  const title = clean(raw.title, 300);
  if (!title) fail('title', 'boş');
  const url = httpUrl(raw.url);
  if (!url) fail('url', 'geçerli bir http(s) adresi değil');
  const makeModel = resolve(raw.makeModelText ?? '');
  if (!makeModel) fail('makeModel', `bilinmeyen marka/model: ${String(raw.makeModelText ?? '').slice(0, 80)}`);
  const maxYear = now.getUTCFullYear() + 1;
  const year = parseInteger(raw.year);
  if (year === null || year < LIMITS.minYear || year > maxYear) fail('year', `${LIMITS.minYear}-${maxYear} aralığında olmalı`);
  const km = parseInteger(raw.km);
  if (km === null || km < LIMITS.minKm || km > LIMITS.maxKm) fail('km', `${LIMITS.minKm}-${LIMITS.maxKm} aralığında olmalı`);
  const price = parseInteger(raw.price);
  if (price === null || price < LIMITS.minPrice || price > LIMITS.maxPrice) {
    fail('price', `${LIMITS.minPrice}-${LIMITS.maxPrice} TL aralığında olmalı`);
  }
  const transmission = parseTransmission(raw.transmission ?? '');
  if (!transmission) fail('transmission', `bilinmeyen vites: ${String(raw.transmission ?? '').slice(0, 40)}`);

  if (problems.length > 0 || !title || !url || !makeModel || year === null || km === null || price === null || !transmission) {
    return { ok: false, problems };
  }

  const base: Omit<NormalizedListing, 'contentHash'> = {
    externalId,
    url,
    title,
    make: makeModel.make,
    model: makeModel.model,
    trim: makeModel.trim,
    year,
    km,
    price: BigInt(price),
    currency: 'TRY',
    fuel: parseFuel(raw.fuel ?? ''),
    transmission,
    city: clean(raw.city),
    imageUrl: httpUrl(raw.imageUrl),
    bodyType: clean(raw.bodyType),
    color: clean(raw.color),
    sellerType: clean(raw.sellerType),
    damageInfo: parseDamage(raw.damage),
  };
  return { ok: true, listing: { ...base, contentHash: contentHash(base) } };
}
```

`packages/collection/src/index.ts`:
```ts
export * from './types';
export * from './normalize';
```

- [ ] **Step 5: Testleri çalıştır**

Run: `pnpm --filter @oto/collection test && pnpm --filter @oto/collection build && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(collection): add listing types and normalizer"
```

---

### Task 3: `PoliteHttpClient` — robots, hız limiti, yeniden deneme, engel tespiti

**Files:**
- Create: `packages/collection/src/{errors,rate-limiter,robots,http-client}.ts`
- Modify: `packages/collection/package.json`, `packages/collection/src/index.ts`
- Test: `packages/collection/src/http-client.e2e.spec.ts`

**Interfaces:**
- Consumes: `startRedis` (`@oto/testing`, dev).
- Produces: `FetchErrorKind`, `FetchError(kind, message, url, transient)`, `BlockedError(message, url)`, `toFetchError(err, url)`; `SourceRateLimiter(redis, sourceId, gapMs, sleep)`.`acquire()`; `RobotsCache(redis, userAgent, fetcher)`.`isAllowed(url)`; `HttpResult { status; body; url; headers }`, `HttpFetcher { getText(url) }`, `PoliteHttpOptions`, `PoliteHttpClient` (`getText`, `close`, `stats`), `backoff(attempt)`, `retryAfterMs(header, now?)`, `defaultSleep`.

- [ ] **Step 1: Bağımlılıkları ekle**

`packages/collection/package.json`:
- `dependencies`: `"ioredis": "^5.4.2"`, `"robots-parser": "^3.0.1"`, `"undici": "^6.21.1"`
- `devDependencies`: `"@oto/testing": "workspace:*"`

Run: `pnpm install`

- [ ] **Step 2: Başarısız testi yaz** (`packages/collection/src/http-client.e2e.spec.ts`)

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startRedis } from '@oto/testing';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BlockedError, FetchError, PoliteHttpClient, retryAfterMs, type PoliteHttpOptions } from './index';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const routes = new Map<string, Handler>();
const hits: { path: string; at: number; ua: string | undefined }[] = [];
let server: Server;
let base: string;
let redis: Redis;
let stopRedis: () => Promise<void>;

beforeAll(async () => {
  const r = await startRedis();
  stopRedis = r.stop;
  redis = new Redis(r.url);
  server = createServer((req, res) => {
    hits.push({ path: req.url ?? '', at: Date.now(), ua: req.headers['user-agent'] });
    const h = routes.get(req.url ?? '') ?? ((_q, s) => s.writeHead(404).end('not found'));
    h(req, res);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections(); // zaman aşımı testindeki askıda bağlantılar
  await new Promise<void>((done) => server.close(() => done()));
  await redis.quit();
  await stopRedis();
});

let sourceSeq = 0;
beforeEach(async () => {
  routes.clear();
  hits.length = 0;
  await redis.flushdb();
  sourceSeq += 1;
});

const sleeps: number[] = [];
function client(over: Partial<PoliteHttpOptions> = {}) {
  sleeps.length = 0;
  return new PoliteHttpClient({
    sourceId: sourceSeq,
    minRequestGapMs: 0,
    userAgent: 'OtoFirsatBot/1.0 (+http://localhost/bot)',
    redis,
    sleep: async (ms) => void sleeps.push(ms),
    ...over,
  });
}
const html = (body: string): Handler => (_q, s) => s.writeHead(200, { 'content-type': 'text/html' }).end(body);
const pageHits = () => hits.filter((h) => h.path !== '/robots.txt');

describe('PoliteHttpClient', () => {
  it('sends the honest user agent and returns the body', async () => {
    routes.set('/p', html('<p>ok</p>'));
    const res = await client().getText(`${base}/p`);
    expect(res).toMatchObject({ status: 200, body: '<p>ok</p>' });
    expect(pageHits()[0].ua).toBe('OtoFirsatBot/1.0 (+http://localhost/bot)');
  });

  it('refuses paths disallowed by robots.txt without requesting them', async () => {
    routes.set('/robots.txt', (_q, s) => s.writeHead(200).end('User-agent: *\nDisallow: /secret\n'));
    routes.set('/secret', html('x'));
    await expect(client().getText(`${base}/secret`)).rejects.toBeInstanceOf(BlockedError);
    expect(pageHits()).toHaveLength(0);
  });

  it('caches robots.txt per origin', async () => {
    routes.set('/a', html('a'));
    routes.set('/b', html('b'));
    const c = client();
    await c.getText(`${base}/a`);
    await c.getText(`${base}/b`);
    expect(hits.filter((h) => h.path === '/robots.txt')).toHaveLength(1);
  });

  it('treats a 5xx robots.txt as a transient failure', async () => {
    routes.set('/robots.txt', (_q, s) => s.writeHead(503).end());
    await expect(client().getText(`${base}/p`)).rejects.toMatchObject({ kind: 'HTTP_5XX', transient: true });
  });

  it('retries 5xx with exponential backoff and then succeeds', async () => {
    let n = 0;
    routes.set('/flaky', (_q, s) => (++n < 3 ? s.writeHead(503).end() : s.writeHead(200).end('ok')));
    const res = await client().getText(`${base}/flaky`);
    expect(res.body).toBe('ok');
    expect(sleeps).toEqual([500, 1000]);
  });

  it('gives up after 3 attempts with a transient HTTP_5XX error', async () => {
    routes.set('/down', (_q, s) => s.writeHead(502).end());
    const err = await client().getText(`${base}/down`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err).toMatchObject({ kind: 'HTTP_5XX', transient: true });
    expect(pageHits()).toHaveLength(3);
  });

  it('honours Retry-After and caps it at 60 seconds', async () => {
    let n = 0;
    routes.set('/limited', (_q, s) => (++n === 1 ? s.writeHead(429, { 'retry-after': '2' }).end() : s.writeHead(200).end('ok')));
    await client().getText(`${base}/limited`);
    expect(sleeps).toEqual([2000]);
    expect(retryAfterMs('3600')).toBe(60_000);
    expect(retryAfterMs(new Date(Date.now() + 5_000).toUTCString())).toBeLessThanOrEqual(5_000);
    expect(retryAfterMs('soon')).toBeNull();
  });

  it('treats 403 as blocked and never retries it', async () => {
    routes.set('/forbidden', (_q, s) => s.writeHead(403).end());
    await expect(client().getText(`${base}/forbidden`)).rejects.toMatchObject({ kind: 'BLOCKED', transient: false });
    expect(pageHits()).toHaveLength(1);
  });

  it('detects captcha pages generically and via the adapter hook', async () => {
    routes.set('/captcha', html('<div class="g-recaptcha"></div>'));
    routes.set('/custom', html('<body data-demo-blocked></body>'));
    await expect(client().getText(`${base}/captcha`)).rejects.toBeInstanceOf(BlockedError);
    const c = client({ isBlockedPage: (h) => h.includes('data-demo-blocked') });
    await expect(c.getText(`${base}/custom`)).rejects.toBeInstanceOf(BlockedError);
  });

  it('returns 404 to the caller instead of throwing', async () => {
    expect((await client().getText(`${base}/missing`)).status).toBe(404);
  });

  it('follows redirects', async () => {
    routes.set('/old', (_q, s) => s.writeHead(301, { location: '/new' }).end());
    routes.set('/new', html('moved'));
    expect((await client().getText(`${base}/old`)).body).toBe('moved');
  });

  it('classifies a refused connection as a transient NETWORK error', async () => {
    const dead = createServer();
    await new Promise<void>((done) => dead.listen(0, '127.0.0.1', done));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((done) => dead.close(() => done()));
    await expect(client().getText(`http://127.0.0.1:${port}/x`)).rejects.toMatchObject({ kind: 'NETWORK', transient: true });
  });

  it('classifies a hanging server as a TIMEOUT', async () => {
    routes.set('/hang', () => undefined);
    await expect(client({ timeoutMs: 300 }).getText(`${base}/hang`)).rejects.toMatchObject({ kind: 'TIMEOUT', transient: true });
  });

  it('enforces the per-source gap across separate clients (shared Redis)', async () => {
    routes.set('/g', html('g'));
    const opts = { minRequestGapMs: 250, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
    const a = client(opts);
    const b = client(opts);
    await a.getText(`${base}/g`); // robots + ilk istek
    hits.length = 0;
    await Promise.all([a.getText(`${base}/g`), b.getText(`${base}/g`), a.getText(`${base}/g`), b.getText(`${base}/g`)]);
    const times = pageHits().map((h) => h.at).sort((x, y) => x - y);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(230);
  });

  it('tracks request stats', async () => {
    routes.set('/s', html('s'));
    const c = client();
    await c.getText(`${base}/s`);
    expect(c.stats.requests).toBe(2); // robots + sayfa
    await c.close();
  });
});
```

- [ ] **Step 3: Testin başarısız olduğunu gör**

Run: `pnpm --filter @oto/testing build && pnpm --filter @oto/collection test:e2e`
Expected: FAIL — `PoliteHttpClient` export'u yok.

- [ ] **Step 4: Uygulamayı yaz**

`packages/collection/src/errors.ts`:
```ts
export type FetchErrorKind = 'NETWORK' | 'TIMEOUT' | 'HTTP_4XX' | 'HTTP_5XX' | 'BLOCKED';

export class FetchError extends Error {
  constructor(
    readonly kind: FetchErrorKind,
    message: string,
    readonly url: string | null,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

/** Kaynak bizi engelledi (403, captcha, robots). Asla yeniden denenmez; kaynak duraklatılır. */
export class BlockedError extends FetchError {
  constructor(message: string, url: string | null) {
    super('BLOCKED', message, url, false);
    this.name = 'BlockedError';
  }
}

const TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

export function toFetchError(err: unknown, url: string): FetchError {
  if (err instanceof FetchError) return err;
  const code = (err as { code?: string } | null)?.code ?? '';
  if (TIMEOUT_CODES.has(code)) return new FetchError('TIMEOUT', `Zaman aşımı (${code}): ${url}`, url, true);
  const detail = code || (err instanceof Error ? err.message : String(err));
  return new FetchError('NETWORK', `Ağ hatası (${detail}): ${url}`, url, true);
}
```

`packages/collection/src/rate-limiter.ts`:
```ts
import type Redis from 'ioredis';

// Sıradaki boş zaman dilimini atomik olarak ayırır ve beklenmesi gereken ms'yi döner.
const RESERVE_SLOT = `
local nextAt = tonumber(redis.call('GET', KEYS[1]) or '0')
local now = tonumber(ARGV[1])
local gap = tonumber(ARGV[2])
local start = math.max(now, nextAt)
redis.call('SET', KEYS[1], start + gap, 'PX', start - now + gap + 60000)
return start - now
`;

/** Kaynak başına istekler arası asgari boşluk; tüm süreçler arasında Redis ile paylaşılır. */
export class SourceRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly sourceId: number,
    private readonly gapMs: number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async acquire(): Promise<void> {
    if (this.gapMs <= 0) return;
    const wait = Number(await this.redis.eval(RESERVE_SLOT, 1, `ratelimit:source:${this.sourceId}`, Date.now(), this.gapMs));
    if (wait > 0) await this.sleep(wait);
  }
}
```

`packages/collection/src/robots.ts`:
```ts
import type Redis from 'ioredis';
import robotsParser from 'robots-parser';
import { FetchError, toFetchError } from './errors';
import type { HttpResult } from './http-client';

const TTL_SEC = 24 * 60 * 60;

export class RobotsCache {
  constructor(
    private readonly redis: Redis,
    private readonly userAgent: string,
    private readonly fetcher: (url: string) => Promise<HttpResult>,
  ) {}

  async isAllowed(url: string): Promise<boolean> {
    const robotsUrl = new URL('/robots.txt', url).toString();
    const key = `robots:${new URL(url).origin}`;
    let body = await this.redis.get(key);
    if (body === null) {
      body = await this.load(robotsUrl);
      await this.redis.set(key, body, 'EX', TTL_SEC);
    }
    return robotsParser(robotsUrl, body).isAllowed(url, this.userAgent) !== false;
  }

  private async load(robotsUrl: string): Promise<string> {
    let res: HttpResult;
    try {
      res = await this.fetcher(robotsUrl);
    } catch (err) {
      throw toFetchError(err, robotsUrl);
    }
    if (res.status >= 200 && res.status < 300) return res.body;
    // robots.txt yoksa (4xx) her şey serbesttir.
    if (res.status >= 400 && res.status < 500) return '';
    throw new FetchError('HTTP_5XX', `robots.txt alınamadı (HTTP ${res.status})`, robotsUrl, true);
  }
}
```

`packages/collection/src/http-client.ts`:
```ts
import type Redis from 'ioredis';
import { Agent, ProxyAgent, request, type Dispatcher } from 'undici';
import { BlockedError, FetchError, toFetchError } from './errors';
import { SourceRateLimiter } from './rate-limiter';
import { RobotsCache } from './robots';

export interface HttpResult {
  status: number;
  body: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface HttpFetcher {
  getText(url: string): Promise<HttpResult>;
}

export interface PoliteHttpOptions {
  sourceId: number;
  minRequestGapMs: number;
  userAgent: string;
  redis: Redis;
  /** Sabit çıkış proxy'si (ör. partnerin IP beyaz listesi). Engellere tepki olarak döndürülmez. */
  proxyUrl?: string | null;
  maxAttempts?: number;
  timeoutMs?: number;
  isBlockedPage?: (html: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const GENERIC_BLOCK_MARKERS = /captcha|cf-chl-|challenge-platform|attention required/i;
const MAX_RETRY_AFTER_MS = 60_000;

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function backoff(attempt: number): number {
  return 500 * 2 ** (attempt - 1);
}

export function retryAfterMs(header: string | string[] | undefined, now = Date.now()): number | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
}

/**
 * Bir kaynağa yapılan TÜM ağ erişiminin tek giriş noktası: robots.txt, hız limiti,
 * zaman aşımları, geçici hatalarda yeniden deneme ve engel tespiti burada uygulanır.
 */
export class PoliteHttpClient implements HttpFetcher {
  readonly stats = { requests: 0, totalMs: 0 };
  private readonly dispatcher: Dispatcher;
  private readonly limiter: SourceRateLimiter;
  private readonly robots: RobotsCache;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;

  constructor(private readonly opts: PoliteHttpOptions) {
    const timeout = opts.timeoutMs ?? 30_000;
    const agentOptions = { connect: { timeout: 10_000 }, headersTimeout: timeout, bodyTimeout: timeout };
    this.dispatcher = opts.proxyUrl ? new ProxyAgent({ uri: opts.proxyUrl, ...agentOptions }) : new Agent(agentOptions);
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.limiter = new SourceRateLimiter(opts.redis, opts.sourceId, opts.minRequestGapMs, this.sleep);
    this.robots = new RobotsCache(opts.redis, opts.userAgent, (url) => this.fetchOnce(url));
  }

  async getText(url: string): Promise<HttpResult> {
    if (!(await this.robots.isAllowed(url))) {
      throw new BlockedError(`robots.txt bu adrese izin vermiyor: ${url}`, url);
    }
    const res = await this.fetchWithRetry(url);
    if (res.status === 403) throw new BlockedError(`Kaynak erişimi reddetti (HTTP 403): ${url}`, url);
    if (res.status === 200 && (GENERIC_BLOCK_MARKERS.test(res.body) || this.opts.isBlockedPage?.(res.body))) {
      throw new BlockedError(`Bot doğrulama sayfası algılandı: ${url}`, url);
    }
    return res;
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  private async fetchWithRetry(url: string): Promise<HttpResult> {
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= this.maxAttempts;
      let res: HttpResult;
      try {
        res = await this.fetchOnce(url);
      } catch (err) {
        const fe = toFetchError(err, url);
        if (last || !fe.transient) throw fe;
        await this.sleep(backoff(attempt));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (last) throw new FetchError(res.status === 429 ? 'HTTP_4XX' : 'HTTP_5XX', `HTTP ${res.status}: ${url}`, url, true);
        await this.sleep(retryAfterMs(res.headers['retry-after']) ?? backoff(attempt));
        continue;
      }
      return res;
    }
  }

  private async fetchOnce(url: string): Promise<HttpResult> {
    await this.limiter.acquire();
    const started = Date.now();
    const res = await request(url, {
      method: 'GET',
      dispatcher: this.dispatcher,
      maxRedirections: 3,
      headers: { 'user-agent': this.opts.userAgent, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' },
    });
    const body = await res.body.text();
    this.stats.requests += 1;
    this.stats.totalMs += Date.now() - started;
    return { status: res.statusCode, body, url, headers: res.headers };
  }
}
```

`packages/collection/src/index.ts` sonuna ekle:
```ts
export * from './errors';
export * from './rate-limiter';
export * from './robots';
export * from './http-client';
```

- [ ] **Step 5: Testleri çalıştır**

Run: `pnpm --filter @oto/collection test:e2e && pnpm --filter @oto/collection test && pnpm lint && pnpm typecheck`
Expected: PASS. (Gerçek bekleme kullanan hız limiti testi ~1 sn sürer.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(collection): add PoliteHttpClient with robots, shared rate limit, retries and block detection"
```

---

### Task 4: `apps/demo-site` — deterministik demo ilan sitesi

**Files:**
- Create: `apps/demo-site/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts}`
- Create: `apps/demo-site/src/{index,catalog,generator,store,render,app,main}.ts`
- Test: `apps/demo-site/src/app.spec.ts`, `apps/demo-site/src/store.spec.ts`

**Interfaces:**
- Produces: `CATALOG: CatalogModel[]`, `CatalogModel { make; model; trims; basePrice; fuels; bodyType }`; `mulberry32(seed)`, `fairPrice(model, year, km, currentYear)`, `DemoListing`; `DemoStore` (`reset(seed,size)`, `active()`, `page(n,size)`, `get(id)`, `inject(overrides)`, `patch(id, {price?, status?})`, `tick()`); `DemoMode = 'normal'|'broken'|'captcha'|'forbidden'`; `createDemoSite(opts) → { app, store, setMode }`.
- HTML sözleşmesi (adapter Task 5'te buna göre yazılır): `<main data-page="N" data-has-next="true|false">`, her ilan `<article data-listing data-id data-tramer data-painted data-changed>` içinde `a.link[href]`, `.title`, `img.photo[src]`, `.make-model`, `.year`, `.km`, `.price`, `.fuel`, `.transmission`, `.city`, `.color`, `.body`. Captcha sayfası `data-demo-blocked` ve `g-recaptcha` içerir.

- [ ] **Step 1: Paket dosyaları**

`apps/demo-site/package.json`:
```json
{
  "name": "@oto/demo-site",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/main.js",
    "dev": "tsx watch src/main.ts",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": { "express": "^5.0.1" },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/supertest": "^6.0.2",
    "supertest": "^7.0.0",
    "tsx": "^4.19.2",
    "vitest": "^3.0.5"
  }
}
```
`tsconfig.json` / `tsconfig.build.json`: `packages/collection`'dakilerle aynı. `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['src/**/*.spec.ts'] } });
```

Kök `package.json` `scripts.build:packages` değerini şu yap (collection ve worker testleri demo-site'ın derlenmiş halini kullanır):
```json
"build:packages": "pnpm -r --filter \"./packages/*\" --filter @oto/demo-site build",
```

- [ ] **Step 2: Başarısız testleri yaz**

`apps/demo-site/src/store.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CATALOG, DemoStore, fairPrice } from './index';

const make = (size = 50) => new DemoStore({ seed: 7, size, currentYear: 2026, now: () => 1_000_000 });

describe('DemoStore', () => {
  it('is deterministic for the same seed', () => {
    expect(make().active().map((l) => [l.id, l.price])).toEqual(make().active().map((l) => [l.id, l.price]));
  });

  it('paginates newest first and reports hasNext', () => {
    const s = make(45);
    expect(s.page(1, 20).items).toHaveLength(20);
    expect(s.page(3, 20)).toMatchObject({ hasNext: false });
    expect(s.page(3, 20).items).toHaveLength(5);
    expect(s.page(9, 20).items).toHaveLength(0);
    expect(s.page(1, 20).items[0].id).toBe('D000045');
  });

  it('generates realistic, valid values', () => {
    for (const l of make(200).active()) {
      expect(l.year).toBeGreaterThanOrEqual(2015);
      expect(l.year).toBeLessThanOrEqual(2026);
      expect(l.km).toBeGreaterThanOrEqual(0);
      expect(l.km).toBeLessThan(400_000);
      expect(l.price).toBeGreaterThanOrEqual(50_000);
      expect(l.price % 1000).toBe(0);
    }
  });

  it('injects a discounted listing priced below fair value', () => {
    const s = make();
    const l = s.inject({ make: 'BMW', model: '3 Serisi', trim: '320i', year: 2020, km: 60_000, discount: 0.25 });
    const m = CATALOG.find((c) => c.make === 'BMW')!;
    expect(l.price).toBe(Math.round((fairPrice(m, 2020, 60_000, 2026) * 0.75) / 1000) * 1000);
    expect(l.isOpportunity).toBe(true);
    expect(s.page(1, 20).items[0].id).toBe(l.id);
  });

  it('patches price/status and tick() mutates the market', () => {
    const s = make(300);
    const first = s.active()[0];
    s.patch(first.id, { price: 500_000 });
    expect(s.get(first.id)?.price).toBe(500_000);
    s.patch(first.id, { status: 'REMOVED' });
    expect(s.active().some((l) => l.id === first.id)).toBe(false);
    const before = s.active().length;
    const summary = s.tick();
    expect(summary.added).toHaveLength(5);
    expect(s.active().length).toBe(before + 5 - summary.removed.length + summary.relisted.length);
  });
});
```

`apps/demo-site/src/app.spec.ts`:
```ts
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
```

- [ ] **Step 3: Testlerin başarısız olduğunu gör**

Run: `pnpm install && pnpm --filter @oto/demo-site test`
Expected: FAIL — `./index` yok.

- [ ] **Step 4: Uygulamayı yaz**

`apps/demo-site/src/catalog.ts`:
```ts
export interface CatalogModel {
  make: string;
  model: string;
  trims: string[];
  /** Sıfır km, bu yılın modeli için yaklaşık liste fiyatı (TL) */
  basePrice: number;
  fuels: string[];
  bodyType: string;
}

export const CATALOG: CatalogModel[] = [
  { make: 'Renault', model: 'Clio', trims: ['1.0 TCe Joy', '1.5 dCi Touch'], basePrice: 1_150_000, fuels: ['Benzin', 'Dizel'], bodyType: 'Hatchback' },
  { make: 'Fiat', model: 'Egea', trims: ['1.4 Fire Easy', '1.3 Multijet Urban'], basePrice: 1_050_000, fuels: ['Benzin', 'Dizel', 'Benzin & LPG'], bodyType: 'Sedan' },
  { make: 'Toyota', model: 'Corolla', trims: ['1.5 Vision', '1.8 Hybrid Flame'], basePrice: 1_650_000, fuels: ['Benzin', 'Hibrit'], bodyType: 'Sedan' },
  { make: 'Volkswagen', model: 'Golf', trims: ['1.0 eTSI Life', '1.5 eTSI Style'], basePrice: 1_900_000, fuels: ['Benzin'], bodyType: 'Hatchback' },
  { make: 'Volkswagen', model: 'Passat', trims: ['1.5 TSI Business', '2.0 TDI Elegance'], basePrice: 2_400_000, fuels: ['Benzin', 'Dizel'], bodyType: 'Sedan' },
  { make: 'BMW', model: '3 Serisi', trims: ['320i', '318i', '320d'], basePrice: 3_200_000, fuels: ['Benzin', 'Dizel'], bodyType: 'Sedan' },
  { make: 'Mercedes-Benz', model: 'C Serisi', trims: ['C 200', 'C 180'], basePrice: 3_500_000, fuels: ['Benzin', 'Dizel'], bodyType: 'Sedan' },
  { make: 'Honda', model: 'Civic', trims: ['1.5 VTEC Elegance', '1.6 i-DTEC Executive'], basePrice: 1_750_000, fuels: ['Benzin', 'Dizel'], bodyType: 'Sedan' },
  { make: 'Hyundai', model: 'i20', trims: ['1.4 MPI Jump', '1.0 T-GDI Style'], basePrice: 950_000, fuels: ['Benzin'], bodyType: 'Hatchback' },
  { make: 'Ford', model: 'Focus', trims: ['1.5 TDCi Trend X', '1.0 EcoBoost Titanium'], basePrice: 1_350_000, fuels: ['Benzin', 'Dizel'], bodyType: 'Hatchback' },
  { make: 'Peugeot', model: '3008', trims: ['1.5 BlueHDi Active', '1.2 PureTech GT'], basePrice: 2_100_000, fuels: ['Benzin', 'Dizel'], bodyType: 'SUV' },
  { make: 'Dacia', model: 'Duster', trims: ['1.3 TCe Prestige', '1.5 Blue dCi Comfort'], basePrice: 1_200_000, fuels: ['Benzin', 'Dizel', 'Benzin & LPG'], bodyType: 'SUV' },
];

export const CITIES = ['İstanbul', 'Ankara', 'İzmir', 'Bursa', 'Antalya', 'Kocaeli', 'Konya', 'Adana'];
export const TRANSMISSIONS = ['Manuel', 'Otomatik', 'Yarı Otomatik'];
export const COLORS = ['Beyaz', 'Siyah', 'Gri', 'Kırmızı', 'Mavi'];
export const PARTS = ['Kaput', 'Sol ön çamurluk', 'Sağ ön kapı', 'Sol arka kapı', 'Bagaj kapağı', 'Tavan'];
```

`apps/demo-site/src/generator.ts`:
```ts
import { CATALOG, CITIES, COLORS, PARTS, TRANSMISSIONS, type CatalogModel } from './catalog';

export type Rng = () => number;

/** Küçük, deterministik PRNG (mulberry32). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)];

export interface DemoListing {
  id: string;
  make: string;
  model: string;
  trim: string;
  year: number;
  km: number;
  price: number;
  fuel: string;
  transmission: string;
  city: string;
  color: string;
  bodyType: string;
  tramerAmount: number | null;
  paintedParts: string[];
  changedParts: string[];
  status: 'ACTIVE' | 'REMOVED';
  createdAt: number;
  isOpportunity: boolean;
}

/** Piyasa değeri: yılda %10 değer kaybı, km başına en fazla %30 düşüş. */
export function fairPrice(m: CatalogModel, year: number, km: number, currentYear: number): number {
  const age = Math.max(0, currentYear - year);
  return m.basePrice * 0.9 ** age * (1 - Math.min(km / 1_000_000, 0.3));
}

export const roundPrice = (n: number) => Math.round(n / 1000) * 1000;

export function generateListing(rng: Rng, id: string, createdAt: number, currentYear: number, discount?: number): DemoListing {
  const m = pick(rng, CATALOG);
  const year = currentYear - Math.floor(rng() * 12);
  const age = currentYear - year;
  const km = age === 0 ? Math.round(rng() * 5000) : Math.round(age * 15_000 * (0.6 + rng() * 0.8));
  const fair = fairPrice(m, year, km, currentYear);
  const factor = discount !== undefined ? 1 - discount : 0.92 + rng() * 0.16;
  const damaged = rng() < 0.2;
  return {
    id,
    make: m.make,
    model: m.model,
    trim: pick(rng, m.trims),
    year,
    km,
    price: roundPrice(fair * factor),
    fuel: pick(rng, m.fuels),
    transmission: pick(rng, TRANSMISSIONS),
    city: pick(rng, CITIES),
    color: pick(rng, COLORS),
    bodyType: m.bodyType,
    tramerAmount: damaged ? Math.round(rng() * 80) * 1000 + 5000 : null,
    paintedParts: damaged ? [pick(rng, PARTS)] : [],
    changedParts: damaged && rng() < 0.3 ? [pick(rng, PARTS)] : [],
    status: 'ACTIVE',
    createdAt,
    isOpportunity: discount !== undefined,
  };
}
```

`apps/demo-site/src/store.ts`:
```ts
import { CATALOG } from './catalog';
import { fairPrice, generateListing, mulberry32, roundPrice, type DemoListing, type Rng } from './generator';

export interface StoreOptions {
  seed: number;
  size: number;
  currentYear?: number;
  now?: () => number;
}

export type InjectInput = Partial<Omit<DemoListing, 'id' | 'createdAt' | 'status' | 'isOpportunity'>> & { discount?: number };

export interface TickSummary {
  added: string[];
  priceDropped: string[];
  removed: string[];
  relisted: string[];
}

export class DemoStore {
  private rng: Rng = mulberry32(0);
  private readonly listings = new Map<string, DemoListing>();
  private seq = 0;
  private readonly currentYear: number;
  private readonly now: () => number;

  constructor(opts: StoreOptions) {
    this.currentYear = opts.currentYear ?? new Date().getFullYear();
    this.now = opts.now ?? Date.now;
    this.reset(opts.seed, opts.size);
  }

  reset(seed: number, size: number): void {
    this.rng = mulberry32(seed);
    this.listings.clear();
    this.seq = 0;
    const base = this.now();
    for (let i = 0; i < size; i++) this.add(base - (size - i) * 1000);
  }

  active(): DemoListing[] {
    return [...this.listings.values()]
      .filter((l) => l.status === 'ACTIVE')
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }

  page(n: number, size = 20): { items: DemoListing[]; hasNext: boolean } {
    const all = this.active();
    const start = (n - 1) * size;
    return { items: all.slice(start, start + size), hasNext: start + size < all.length };
  }

  get(id: string): DemoListing | undefined {
    return this.listings.get(id);
  }

  inject(input: InjectInput): DemoListing {
    const { discount, ...overrides } = input;
    const listing = this.add(this.now(), discount);
    Object.assign(listing, overrides);
    if (discount !== undefined && overrides.price === undefined) {
      const model = CATALOG.find((c) => c.make === listing.make && c.model === listing.model);
      if (model) listing.price = roundPrice(fairPrice(model, listing.year, listing.km, this.currentYear) * (1 - discount));
    }
    return listing;
  }

  patch(id: string, change: { price?: number; status?: 'ACTIVE' | 'REMOVED' }): DemoListing | undefined {
    const listing = this.listings.get(id);
    if (!listing) return undefined;
    if (change.price !== undefined) listing.price = change.price;
    if (change.status !== undefined) listing.status = change.status;
    return listing;
  }

  /** Piyasayı bir adım ilerletir: %1 kaldırma, %2 fiyat düşüşü, kaldırılanların %10'u geri gelir, 5 yeni ilan (%3 fırsat). */
  tick(): TickSummary {
    const now = this.now();
    const summary: TickSummary = { added: [], priceDropped: [], removed: [], relisted: [] };
    const removedBefore = [...this.listings.values()].filter((l) => l.status === 'REMOVED');
    for (const l of this.active()) {
      const r = this.rng();
      if (r < 0.01) {
        l.status = 'REMOVED';
        summary.removed.push(l.id);
      } else if (r < 0.03) {
        l.price = roundPrice(l.price * (0.9 + this.rng() * 0.07));
        summary.priceDropped.push(l.id);
      }
    }
    for (const l of removedBefore) {
      if (this.rng() < 0.1) {
        l.status = 'ACTIVE';
        summary.relisted.push(l.id);
      }
    }
    for (let i = 0; i < 5; i++) {
      const opportunity = this.rng() < 0.03;
      summary.added.push(this.add(now + i, opportunity ? 0.15 + this.rng() * 0.15 : undefined).id);
    }
    return summary;
  }

  private add(createdAt: number, discount?: number): DemoListing {
    this.seq += 1;
    const id = `D${String(this.seq).padStart(6, '0')}`;
    const listing = generateListing(this.rng, id, createdAt, this.currentYear, discount);
    this.listings.set(id, listing);
    return listing;
  }
}
```

`apps/demo-site/src/render.ts`:
```ts
import type { DemoListing } from './generator';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]);

const tl = (n: number) => `${n.toLocaleString('tr-TR')} TL`;
const km = (n: number) => `${n.toLocaleString('tr-TR')} km`;
export const listingTitle = (l: DemoListing) => `${l.year} ${l.make} ${l.model} ${l.trim}`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

function card(l: DemoListing, broken: boolean): string {
  const id = escapeHtml(l.id);
  const attrs = `data-listing data-id="${id}" data-tramer="${l.tramerAmount ?? ''}" data-painted="${escapeHtml(l.paintedParts.join(','))}" data-changed="${escapeHtml(l.changedParts.join(','))}"`;
  if (broken) {
    // Sayfa yapısı değişmiş gibi: fiyat ve marka/model alanları yeni sınıf adlarıyla.
    return `<article class="listing-v2" ${attrs}><a class="link" href="/ilan/${id}"><h2 class="title">${escapeHtml(listingTitle(l))}</h2></a><span class="tutar">${tl(l.price)}</span></article>`;
  }
  return `<article class="listing" ${attrs}>
<a class="link" href="/ilan/${id}"><h2 class="title">${escapeHtml(listingTitle(l))}</h2></a>
<img class="photo" src="/img/${id}.jpg" alt="">
<span class="make-model">${escapeHtml(`${l.make} ${l.model} ${l.trim}`)}</span>
<span class="year">${l.year}</span><span class="km">${km(l.km)}</span><span class="price">${tl(l.price)}</span>
<span class="fuel">${escapeHtml(l.fuel)}</span><span class="transmission">${escapeHtml(l.transmission)}</span>
<span class="city">${escapeHtml(l.city)}</span><span class="color">${escapeHtml(l.color)}</span><span class="body">${escapeHtml(l.bodyType)}</span>
</article>`;
}

export function renderListPage(items: DemoListing[], page: number, hasNext: boolean, broken = false): string {
  const next = hasNext ? `<a rel="next" href="/ilanlar?sayfa=${page + 1}">Sonraki</a>` : '';
  return layout(`İlanlar - Sayfa ${page}`, `<main data-page="${page}" data-has-next="${hasNext}">${items.map((l) => card(l, broken)).join('\n')}</main>${next}`);
}

export function renderDetail(l: DemoListing): string {
  return layout(listingTitle(l), `<main class="detail" data-id="${escapeHtml(l.id)}"><h1>${escapeHtml(listingTitle(l))}</h1><p class="price">${tl(l.price)}</p><p class="km">${km(l.km)}</p></main>`);
}

export function renderCaptchaPage(): string {
  return `<!doctype html><html lang="tr"><body data-demo-blocked><h1>Güvenlik doğrulaması</h1><div class="g-recaptcha"></div></body></html>`;
}
```

`apps/demo-site/src/app.ts`:
```ts
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
```

`apps/demo-site/src/index.ts`:
```ts
export * from './catalog';
export * from './generator';
export * from './store';
export * from './render';
export * from './app';
```

`apps/demo-site/src/main.ts`:
```ts
import { createDemoSite } from './app';

const port = Number(process.env.DEMO_PORT ?? 4000);
const tickMs = Number(process.env.DEMO_TICK_MS ?? 60_000);
const site = createDemoSite({ seed: Number(process.env.DEMO_SEED ?? 42), size: Number(process.env.DEMO_SIZE ?? 2000) });

site.app.listen(port, () => {
  console.log(`Demo ilan sitesi: http://localhost:${port}/ilanlar (tick: ${tickMs > 0 ? `${tickMs} ms` : 'kapalı'})`);
});

if (tickMs > 0) {
  setInterval(() => {
    const s = site.store.tick();
    console.log(`tick: +${s.added.length} yeni, ${s.priceDropped.length} fiyat düşüşü, ${s.removed.length} kaldırma, ${s.relisted.length} geri gelen`);
  }, tickMs);
}
```

- [ ] **Step 5: Testleri çalıştır**

Run: `pnpm --filter @oto/demo-site test && pnpm --filter @oto/demo-site build && pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(demo-site): add deterministic demo listing site with simulator and failure modes"
```

---

### Task 5: Adapter sözleşmesi, registry, demo adapter ve takma ad seed'leri

**Files:**
- Create: `packages/collection/src/{adapter,registry}.ts`, `packages/collection/src/adapters/demo-site.adapter.ts`
- Modify: `packages/collection/package.json`, `packages/collection/src/index.ts`
- Modify: `packages/db/src/seed-data.ts`, `packages/db/prisma/seed.ts`, `packages/db/test/schema.spec.ts`
- Test: `packages/collection/src/adapters/demo-site.adapter.spec.ts`

**Interfaces:**
- Consumes: `HttpFetcher`, `FetchError`, `RawListing`, `ListingProblem`, `normalizeListing`, `createAliasResolver` (Task 2–3); `createDemoSite`, `CATALOG` (Task 4).
- Produces: `ListPage { url; pageNo; html; isLast }`, `ParseResult { listings; problems }`, `AdapterContext { http; config }`, `SourceAdapter { key; kind; listPages(ctx); parseList(page); isBlockedPage?(html) }`; `getAdapter(key)`, `ADAPTER_KEYS`; `DemoSiteAdapter`. `@oto/db`: `MAKE_MODEL_ALIAS_SEEDS`, `seedMakeModelAliases(prisma)`.

- [ ] **Step 1: Bağımlılıklar**

`packages/collection/package.json`: `dependencies`'e `"cheerio": "^1.0.0"`; `devDependencies`'e `"@oto/db": "workspace:*"`, `"@oto/demo-site": "workspace:*"`. Run: `pnpm install`.

- [ ] **Step 2: Takma ad seed'lerini ekle (`packages/db`)**

`packages/db/src/seed-data.ts` sonuna ekle:
```ts
/** Marka/model eşleme tablosu başlangıç verisi. Gerçek marka/model adlarıdır; demo katalog da bunları kullanır. */
export const MAKE_MODEL_ALIAS_SEEDS: { rawText: string; make: string; model: string; trim: string | null }[] = [
  { rawText: 'Renault Clio', make: 'Renault', model: 'Clio', trim: null },
  { rawText: 'Fiat Egea', make: 'Fiat', model: 'Egea', trim: null },
  { rawText: 'Toyota Corolla', make: 'Toyota', model: 'Corolla', trim: null },
  { rawText: 'Volkswagen Golf', make: 'Volkswagen', model: 'Golf', trim: null },
  { rawText: 'Volkswagen Passat', make: 'Volkswagen', model: 'Passat', trim: null },
  { rawText: 'VW Golf', make: 'Volkswagen', model: 'Golf', trim: null },
  { rawText: 'VW Passat', make: 'Volkswagen', model: 'Passat', trim: null },
  { rawText: 'BMW 3 Serisi', make: 'BMW', model: '3 Serisi', trim: null },
  { rawText: 'Mercedes-Benz C Serisi', make: 'Mercedes-Benz', model: 'C Serisi', trim: null },
  { rawText: 'Mercedes C Serisi', make: 'Mercedes-Benz', model: 'C Serisi', trim: null },
  { rawText: 'Honda Civic', make: 'Honda', model: 'Civic', trim: null },
  { rawText: 'Hyundai i20', make: 'Hyundai', model: 'i20', trim: null },
  { rawText: 'Ford Focus', make: 'Ford', model: 'Focus', trim: null },
  { rawText: 'Peugeot 3008', make: 'Peugeot', model: '3008', trim: null },
  { rawText: 'Dacia Duster', make: 'Dacia', model: 'Duster', trim: null },
];

export async function seedMakeModelAliases(prisma: PrismaClient): Promise<void> {
  for (const alias of MAKE_MODEL_ALIAS_SEEDS) {
    await prisma.makeModelAlias.upsert({ where: { rawText: alias.rawText }, update: {}, create: alias });
  }
}
```

`packages/db/prisma/seed.ts` içinde `await seedPlans(prisma);` satırından sonra `await seedMakeModelAliases(prisma);` ekle (import'a `seedMakeModelAliases` ekle).

`packages/db/test/schema.spec.ts` sonuna (describe içine) ekle ve import'a `seedMakeModelAliases` ekle:
```ts
  it('seedMakeModelAliases is idempotent', async () => {
    await seedMakeModelAliases(prisma);
    await seedMakeModelAliases(prisma);
    expect(await prisma.makeModelAlias.count()).toBeGreaterThanOrEqual(12);
  });
```

- [ ] **Step 3: Başarısız adapter testini yaz** (`packages/collection/src/adapters/demo-site.adapter.spec.ts`)

```ts
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
      const r = normalizeListing(raw, resolve, new Date('2026-10-11T00:00:00Z'));
      expect(r.ok, JSON.stringify(r)).toBe(true);
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
    for (const m of CATALOG) expect(resolve(`${m.make} ${m.model} ${m.trims[0]}`), `${m.make} ${m.model}`).not.toBeNull();
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
});
```

- [ ] **Step 4: Testin başarısız olduğunu gör**

Run: `pnpm build:packages && pnpm --filter @oto/collection test`
Expected: FAIL — `getAdapter` export'u yok.

- [ ] **Step 5: Uygulamayı yaz**

`packages/collection/src/adapter.ts`:
```ts
import type { HttpFetcher } from './http-client';
import type { ListingProblem, RawListing, SourceKind } from './types';

export interface ListPage {
  url: string;
  pageNo: number;
  html: string;
  /** Kaynağın son sayfası mı? Yalnızca tam taramada kaybolan ilanlar REMOVED yapılır. */
  isLast: boolean;
}

export interface ParseResult {
  listings: RawListing[];
  problems: ListingProblem[];
}

export interface AdapterContext {
  http: HttpFetcher;
  /** DataSource.config (JSON) — adapter kendi şemasıyla doğrular. */
  config: unknown;
}

/** Yeni kaynak = bu arayüzü uygulayan yeni bir sınıf + registry'de bir satır. */
export interface SourceAdapter {
  readonly key: string;
  readonly kind: SourceKind;
  listPages(ctx: AdapterContext): AsyncIterable<ListPage>;
  parseList(page: ListPage): ParseResult;
  isBlockedPage?(html: string): boolean;
}
```

`packages/collection/src/adapters/demo-site.adapter.ts`:
```ts
import * as cheerio from 'cheerio';
import { z } from 'zod';
import type { AdapterContext, ListPage, ParseResult, SourceAdapter } from '../adapter';
import { FetchError } from '../errors';
import type { ListingProblem, RawListing } from '../types';

const configSchema = z.object({
  baseUrl: z.string().url(),
  maxPages: z.number().int().min(1).max(1000).default(200),
});

const csv = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

/** Yerel demo ilan sitesi (apps/demo-site). İzin türü: TEST. */
export class DemoSiteAdapter implements SourceAdapter {
  readonly key = 'demo-site';
  readonly kind = 'HTTP' as const;

  async *listPages(ctx: AdapterContext): AsyncIterable<ListPage> {
    const cfg = configSchema.parse(ctx.config);
    for (let pageNo = 1; pageNo <= cfg.maxPages; pageNo++) {
      const url = new URL(`/ilanlar?sayfa=${pageNo}`, cfg.baseUrl).toString();
      const res = await ctx.http.getText(url);
      if (res.status !== 200) {
        throw new FetchError(res.status >= 500 ? 'HTTP_5XX' : 'HTTP_4XX', `Liste sayfası alınamadı (HTTP ${res.status}): ${url}`, url, false);
      }
      const isLast = cheerio.load(res.body)('main').attr('data-has-next') !== 'true';
      yield { url, pageNo, html: res.body, isLast };
      if (isLast) return;
    }
  }

  parseList(page: ListPage): ParseResult {
    const $ = cheerio.load(page.html);
    const listings: RawListing[] = [];
    const problems: ListingProblem[] = [];
    $('[data-listing]').each((_i, el) => {
      const card = $(el);
      const text = (selector: string) => card.find(selector).first().text().trim();
      const externalId = card.attr('data-id')?.trim() ?? '';
      const href = card.find('a.link').attr('href') ?? '';
      const required = { externalId, href, title: text('.title'), price: text('.price'), makeModel: text('.make-model') };
      const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length > 0) {
        problems.push({
          externalId: externalId || undefined,
          field: missing.join(','),
          problem: 'kartta zorunlu alan yok',
          rawSnippet: ($.html(el) ?? '').slice(0, 300),
        });
        return;
      }
      const image = card.find('img.photo').attr('src');
      listings.push({
        externalId,
        url: new URL(href, page.url).toString(),
        title: required.title,
        makeModelText: required.makeModel,
        year: text('.year'),
        km: text('.km'),
        price: required.price,
        fuel: text('.fuel'),
        transmission: text('.transmission'),
        city: text('.city') || null,
        color: text('.color') || null,
        bodyType: text('.body') || null,
        sellerType: null,
        imageUrl: image ? new URL(image, page.url).toString() : null,
        damage: {
          tramerAmount: card.attr('data-tramer') || null,
          paintedParts: csv(card.attr('data-painted')),
          changedParts: csv(card.attr('data-changed')),
        },
      });
    });
    return { listings, problems };
  }

  isBlockedPage(html: string): boolean {
    return html.includes('data-demo-blocked');
  }
}
```

`packages/collection/src/registry.ts`:
```ts
import type { SourceAdapter } from './adapter';
import { DemoSiteAdapter } from './adapters/demo-site.adapter';

/**
 * adapterKey → adapter. Yeni kaynak eklerken yalnızca buraya bir satır eklenir.
 * İzin/lisans doğrulanmamış hiçbir site için adapter eklenmez (docs/adding-a-source.md).
 */
const FACTORIES: Record<string, () => SourceAdapter> = {
  'demo-site': () => new DemoSiteAdapter(),
};

export const ADAPTER_KEYS = Object.keys(FACTORIES);

export function getAdapter(key: string): SourceAdapter {
  const factory = FACTORIES[key];
  if (!factory) throw new Error(`Bilinmeyen adapter: ${key}`);
  return factory();
}
```

`packages/collection/src/index.ts` sonuna ekle:
```ts
export * from './adapter';
export * from './registry';
export * from './adapters/demo-site.adapter';
```

- [ ] **Step 6: Testleri çalıştır**

Run: `pnpm build:packages && pnpm --filter @oto/collection test && pnpm --filter @oto/db test:e2e && pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(collection): add adapter contract, registry, demo-site adapter and alias seeds"
```

---

### Task 6: `apps/worker` iskeleti — config, altyapı, kuyruklar, alarm, heartbeat

**Files:**
- Create: `apps/worker/{package.json,tsconfig.json,tsconfig.build.json,nest-cli.json,vitest.config.ts,vitest.e2e.config.ts}`
- Create: `apps/worker/src/{main,core.module,worker-app.module}.ts`, `src/config/{env,config.module}.ts`, `src/infra/{prisma.service,redis.service,bull}.ts`, `src/queues/queue-registry.ts`, `src/common/{alert.service,heartbeat.service}.ts`
- Create: `apps/worker/test/{global-setup,setup-env,helpers}.ts`
- Test: `apps/worker/src/infra/bull.spec.ts`, `apps/worker/src/config/env.spec.ts`, `apps/worker/test/core.e2e.spec.ts`

**Interfaces:**
- Consumes: `REDACT_PATHS`, `Encryptor` (`@oto/server-common`); `QueueName`, `ScrapeJobData`, `AnalyzeJobData` (`@oto/shared`); `startTestInfra`, `truncateAll` (`@oto/testing`).
- Produces: `ENV` token, `Env`, `parseEnv`; `PrismaService`, `RedisService`; `bullConnection(redisUrl)`; `QueueRegistry { scrape; analyze }`; `AlertService.raise(alert: Alert): Promise<void>` (`Alert { key; level: 'WARN'|'ERROR'; component; message; context? }`), `ALERT_SUPPRESS_SEC = 1800`; `HeartbeatService` (Redis anahtarı `worker:heartbeat:<hostname>:<pid>`); `CoreModule` (global: Config, Logger, Prisma, Redis, QueueRegistry, AlertService, Encryptor). Test: `createContext(imports)`, `resetState(ref)`.

- [ ] **Step 1: Paket dosyaları**

`apps/worker/package.json`:
```json
{
  "name": "@oto/worker",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "nest build",
    "dev": "nest start --watch",
    "dev:scheduler": "nest start --watch -- --role=scheduler",
    "start": "node dist/main.js",
    "start:scheduler": "node dist/main.js --role=scheduler",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "test:e2e": "vitest run -c vitest.e2e.config.ts"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.5",
    "@nestjs/core": "^11.0.5",
    "@oto/collection": "workspace:*",
    "@oto/db": "workspace:*",
    "@oto/server-common": "workspace:*",
    "@oto/shared": "workspace:*",
    "bullmq": "^5.34.0",
    "ioredis": "^5.4.2",
    "nestjs-pino": "^4.3.0",
    "pino": "^9.6.0",
    "pino-http": "^10.4.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.2",
    "@nestjs/testing": "^11.0.5",
    "@oto/demo-site": "workspace:*",
    "@oto/testing": "workspace:*",
    "@swc/core": "^1.10.7",
    "pino-pretty": "^13.0.0",
    "unplugin-swc": "^1.5.1",
    "vitest": "^3.0.5"
  }
}
```

`tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `vitest.config.ts`, `vitest.e2e.config.ts`: `apps/api`'deki dosyalarla birebir aynı içerik (unit config'te `include: ['src/**/*.spec.ts']`).

Run: `pnpm install`. (pnpm `msgpackr-extract` derleme betiğini atlayabilir; BullMQ saf JS'e düşer, sorun değildir.)

- [ ] **Step 2: Başarısız unit testleri yaz**

`apps/worker/src/infra/bull.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { bullConnection } from './bull';

describe('bullConnection', () => {
  it('parses a redis URL into BullMQ connection options', () => {
    expect(bullConnection('redis://:s%40cret@redis.local:6380/2')).toEqual({
      host: 'redis.local',
      port: 6380,
      username: undefined,
      password: 's@cret',
      db: 2,
      maxRetriesPerRequest: null,
    });
    expect(bullConnection('redis://localhost')).toMatchObject({ port: 6379, db: 0, password: undefined });
  });
});
```

`apps/worker/src/config/env.spec.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5433/db',
  REDIS_URL: 'redis://localhost:6380',
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
};

describe('worker env', () => {
  it('applies defaults', () => {
    expect(parseEnv(base)).toMatchObject({ ROLE: 'worker', SCHEDULER_TICK_MS: 15_000, SCRAPE_CONCURRENCY: 2, BOT_CONTACT_URL: 'http://localhost:3000/bot' });
  });

  it('rejects an unknown role and missing variables', () => {
    expect(() => parseEnv({ ...base, ROLE: 'boss' })).toThrow(/ROLE/);
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });
});
```

Run: `pnpm --filter @oto/worker test` → FAIL (modüller yok).

- [ ] **Step 3: Config ve altyapı**

`apps/worker/src/config/env.ts`:
```ts
import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ROLE: z.enum(['worker', 'scheduler']).default('worker'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  DATA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'base64 kodlu 32 bayt olmalı'),
  /** Bot User-Agent'ında yayınlanan iletişim adresi (kaynak sahipleri bize ulaşabilsin). */
  BOT_CONTACT_URL: z.string().url().default('http://localhost:3000/bot'),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(1000).default(15_000),
  SCRAPE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
});
export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  return result.data;
}
```

`apps/worker/src/config/config.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { parseEnv } from './env';

export const ENV = Symbol('ENV');

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => parseEnv(process.env) }],
  exports: [ENV],
})
export class ConfigModule {}
```

`apps/worker/src/infra/prisma.service.ts` ve `redis.service.ts`: `apps/api/src/infra/` altındaki aynı adlı dosyalarla birebir aynı (import yolları `../config/config.module` ve `../config/env`).

`apps/worker/src/infra/bull.ts`:
```ts
import type { ConnectionOptions } from 'bullmq';

/** BullMQ worker'ları engelleyici komut kullandığından maxRetriesPerRequest null olmalıdır. */
export function bullConnection(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
  };
}
```

`apps/worker/src/queues/queue-registry.ts`:
```ts
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { QueueName, type AnalyzeJobData, type ScrapeJobData } from '@oto/shared';
import { Queue } from 'bullmq';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { bullConnection } from '../infra/bull';

@Injectable()
export class QueueRegistry implements OnModuleDestroy {
  readonly scrape: Queue<ScrapeJobData>;
  readonly analyze: Queue<AnalyzeJobData>;

  constructor(@Inject(ENV) env: Env) {
    const connection = bullConnection(env.REDIS_URL);
    this.scrape = new Queue<ScrapeJobData>(QueueName.SCRAPE, { connection });
    this.analyze = new Queue<AnalyzeJobData>(QueueName.ANALYZE, { connection });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.scrape.close(), this.analyze.close()]);
  }
}
```

- [ ] **Step 4: Alarm ve heartbeat**

`apps/worker/src/common/alert.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@oto/db';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';

export const ALERT_SUPPRESS_SEC = 30 * 60;

export interface Alert {
  /** Susturma anahtarı, ör. `source:3:blocked` */
  key: string;
  level: 'WARN' | 'ERROR';
  component: string;
  message: string;
  context?: Record<string, unknown>;
}

/** Her alarmı SystemLog'a yazar; aynı anahtar için 30 dk'da en fazla bir kez adminlere panel bildirimi gönderir. */
@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async raise(alert: Alert): Promise<void> {
    await this.prisma.systemLog.create({
      data: {
        level: alert.level,
        component: alert.component,
        message: alert.message,
        context: (alert.context ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    const fresh = await this.redis.set(`alert:${alert.key}`, '1', 'EX', ALERT_SUPPRESS_SEC, 'NX');
    if (fresh !== 'OK') return;
    const admins = await this.prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
      select: { id: true },
    });
    if (admins.length === 0) return;
    await this.prisma.notification.createMany({
      data: admins.map((a) => ({
        userId: a.id,
        kind: 'SYSTEM_ALERT' as const,
        channel: 'IN_APP' as const,
        status: 'SENT' as const,
        sentAt: new Date(),
        payload: { type: 'SYSTEM_ALERT', key: alert.key, level: alert.level, message: alert.message },
      })),
    });
    this.logger.warn(`Alarm (${alert.level}) ${alert.key}: ${alert.message}`);
  }
}
```

`apps/worker/src/common/heartbeat.service.ts`:
```ts
import { hostname } from 'node:os';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { RedisService } from '../infra/redis.service';

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TTL_SEC = 45;

/** Admin panelinin canlı/ölü worker listesini Redis'teki bu anahtarlardan üretir (Plan 07). */
@Injectable()
export class HeartbeatService implements OnModuleInit, OnModuleDestroy {
  readonly key = `worker:heartbeat:${hostname()}:${process.pid}`;
  private timer?: NodeJS.Timeout;
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.beat();
    this.timer = setInterval(() => void this.beat().catch(() => undefined), HEARTBEAT_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.redis.del(this.key);
  }

  private async beat(): Promise<void> {
    const value = JSON.stringify({ role: this.env.ROLE, pid: process.pid, host: hostname(), startedAt: this.startedAt, at: new Date().toISOString() });
    await this.redis.set(this.key, value, 'EX', HEARTBEAT_TTL_SEC);
  }
}
```

- [ ] **Step 5: Modüller ve giriş noktası**

`apps/worker/src/core.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { Encryptor, REDACT_PATHS } from '@oto/server-common';
import { LoggerModule } from 'nestjs-pino';
import { AlertService } from './common/alert.service';
import { ConfigModule, ENV } from './config/config.module';
import type { Env } from './config/env';
import { PrismaService } from './infra/prisma.service';
import { RedisService } from './infra/redis.service';
import { QueueRegistry } from './queues/queue-registry';

@Global()
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          redact: { paths: REDACT_PATHS, censor: '[redacted]' },
          transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
        },
      }),
    }),
  ],
  providers: [
    PrismaService,
    RedisService,
    QueueRegistry,
    AlertService,
    { provide: Encryptor, inject: [ENV], useFactory: (env: Env) => new Encryptor(env.DATA_ENCRYPTION_KEY) },
  ],
  exports: [PrismaService, RedisService, QueueRegistry, AlertService, Encryptor],
})
export class CoreModule {}
```

`apps/worker/src/worker-app.module.ts` (Task 9'da işlemci eklenecek):
```ts
import { Module } from '@nestjs/common';
import { HeartbeatService } from './common/heartbeat.service';
import { CoreModule } from './core.module';

@Module({ imports: [CoreModule], providers: [HeartbeatService] })
export class WorkerAppModule {}
```

`apps/worker/src/main.ts`:
```ts
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

const rootEnv = resolve(__dirname, '../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
if (process.argv.includes('--role=scheduler')) process.env.ROLE = 'scheduler';

async function main(): Promise<void> {
  const scheduler = process.env.ROLE === 'scheduler';
  const root = scheduler
    ? (await import('./scheduler-app.module')).SchedulerAppModule
    : (await import('./worker-app.module')).WorkerAppModule;
  const app = await NestFactory.createApplicationContext(root, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.get(Logger).log(`Oto Fırsat ${scheduler ? 'scheduler' : 'worker'} başladı`);
}

void main();
```

`apps/worker/src/scheduler-app.module.ts` (Task 9'da doldurulacak; derlenmesi için şimdilik):
```ts
import { Module } from '@nestjs/common';
import { HeartbeatService } from './common/heartbeat.service';
import { CoreModule } from './core.module';

@Module({ imports: [CoreModule], providers: [HeartbeatService] })
export class SchedulerAppModule {}
```

- [ ] **Step 6: E2E test altyapısı ve başarısız test**

`apps/worker/test/global-setup.ts`: `apps/api/test/global-setup.ts` ile birebir aynı (Task 1'deki `startTestInfra` sürümü).

`apps/worker/test/setup-env.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { inject } from 'vitest';

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  ROLE: 'worker',
  DATABASE_URL: inject('databaseUrl'),
  REDIS_URL: inject('redisUrl'),
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  BOT_CONTACT_URL: 'http://localhost:3000/bot',
});
```

`apps/worker/test/helpers.ts`:
```ts
import type { DynamicModule, Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { seedMakeModelAliases } from '@oto/db';
import { truncateAll } from '@oto/testing';
import { CoreModule } from '../src/core.module';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';

export async function createContext(imports: (Type<unknown> | DynamicModule)[] = []): Promise<TestingModule> {
  const ref = await Test.createTestingModule({ imports: [CoreModule, ...imports] }).compile();
  await ref.init();
  return ref;
}

export async function resetState(ref: TestingModule): Promise<void> {
  const prisma = ref.get(PrismaService);
  await truncateAll(prisma);
  await ref.get(RedisService).flushdb();
  await seedMakeModelAliases(prisma);
}

export async function createAdmin(ref: TestingModule, status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  return ref.get(PrismaService).user.create({
    data: { email: `admin-${Math.random().toString(36).slice(2)}@test.com`, name: 'Admin', passwordHash: 'x', role: 'ADMIN', status },
  });
}
```

`apps/worker/test/core.e2e.spec.ts`:
```ts
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AlertService } from '../src/common/alert.service';
import { HeartbeatService, HEARTBEAT_TTL_SEC } from '../src/common/heartbeat.service';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';
import { QueueRegistry } from '../src/queues/queue-registry';
import { createAdmin, createContext, resetState } from './helpers';

let ref: TestingModule;
beforeAll(async () => {
  ref = await createContext();
});
afterAll(async () => {
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
});

describe('AlertService', () => {
  it('always logs, but notifies active admins once per key within 30 minutes', async () => {
    const admin = await createAdmin(ref);
    await createAdmin(ref, 'SUSPENDED');
    const alerts = ref.get(AlertService);
    const alert = { key: 'source:1:blocked', level: 'ERROR' as const, component: 'collection', message: 'Demo erişimi engelledi' };
    await alerts.raise(alert);
    await alerts.raise(alert);
    const prisma = ref.get(PrismaService);
    expect(await prisma.systemLog.count({ where: { level: 'ERROR', component: 'collection' } })).toBe(2);
    const notes = await prisma.notification.findMany();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ userId: admin.id, kind: 'SYSTEM_ALERT', channel: 'IN_APP', status: 'SENT' });
    expect(notes[0].payload).toMatchObject({ key: 'source:1:blocked', message: 'Demo erişimi engelledi' });
    const ttl = await ref.get(RedisService).ttl('alert:source:1:blocked');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1800);
  });
});

describe('HeartbeatService', () => {
  it('publishes a heartbeat with TTL and removes it on shutdown', async () => {
    const hb = new HeartbeatService(ref.get(RedisService), { ROLE: 'worker' } as never);
    await hb.onModuleInit();
    const redis = ref.get(RedisService);
    expect(JSON.parse((await redis.get(hb.key))!)).toMatchObject({ role: 'worker', pid: process.pid });
    expect(await redis.ttl(hb.key)).toBeLessThanOrEqual(HEARTBEAT_TTL_SEC);
    await hb.onModuleDestroy();
    expect(await redis.get(hb.key)).toBeNull();
  });
});

describe('QueueRegistry', () => {
  it('exposes the scrape and analyze queues', () => {
    const q = ref.get(QueueRegistry);
    expect([q.scrape.name, q.analyze.name]).toEqual(['scrape', 'analyze']);
  });
});
```

- [ ] **Step 7: Testleri çalıştır**

Run: `pnpm build:packages && pnpm --filter @oto/worker test && pnpm --filter @oto/worker test:e2e && pnpm --filter @oto/worker build && pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(worker): scaffold worker app with config, queues, alerts and heartbeat"
```

---

### Task 7: Ingest — mükerrersiz kayıt, fiyat geçmişi, sorunlu kayıtlar, analiz kuyruğu

**Files:**
- Create: `apps/worker/src/collection/{collection.module,alias.service,ingest.service}.ts`
- Test: `apps/worker/test/ingest.e2e.spec.ts`

**Interfaces:**
- Consumes: `NormalizedListing`, `ListingProblem`, `createAliasResolver`, `MakeModelResolver` (`@oto/collection`); `QueueRegistry`, `PrismaService`.
- Produces: `AliasService.resolver(now?)`, `.invalidate()`; `IngestOutcome = 'NEW'|'PRICE_CHANGED'|'UPDATED'|'RELISTED'|'UNCHANGED'`; `IngestService.ingest(sourceId, listing, seenAt) → { outcome; listingId }`, `.recordProblems(sourceId, problems)`, `.markRemoved(sourceId, notSeenSince) → number`; `analyzeJobId(listingId, reason, contentHash)`; `CollectionModule` (exports AliasService, IngestService).

- [ ] **Step 1: Başarısız testi yaz** (`apps/worker/test/ingest.e2e.spec.ts`)

```ts
import type { TestingModule } from '@nestjs/testing';
import type { NormalizedListing } from '@oto/collection';
import { contentHash } from '@oto/collection';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AliasService } from '../src/collection/alias.service';
import { CollectionModule } from '../src/collection/collection.module';
import { analyzeJobId, IngestService } from '../src/collection/ingest.service';
import { PrismaService } from '../src/infra/prisma.service';
import { QueueRegistry } from '../src/queues/queue-registry';
import { createContext, resetState } from './helpers';

let ref: TestingModule;
let ingest: IngestService;
let prisma: PrismaService;
let sourceId: number;

beforeAll(async () => {
  ref = await createContext([CollectionModule]);
  ingest = ref.get(IngestService);
  prisma = ref.get(PrismaService);
});
afterAll(async () => {
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
  sourceId = (await prisma.dataSource.create({ data: { code: 'demo', name: 'Demo', adapterKey: 'demo-site', kind: 'HTTP', permissionType: 'TEST' } })).id;
});

function listing(over: Partial<NormalizedListing> = {}): NormalizedListing {
  const base: Omit<NormalizedListing, 'contentHash'> = {
    externalId: 'D000001', url: 'http://demo/ilan/D000001', title: '2019 BMW 3 Serisi 320i',
    make: 'BMW', model: '3 Serisi', trim: '320i', year: 2019, km: 85_000, price: 960_000n, currency: 'TRY',
    fuel: 'GASOLINE', transmission: 'AUTOMATIC', city: 'İstanbul', imageUrl: null, bodyType: 'Sedan', color: 'Beyaz',
    sellerType: null, damageInfo: null, ...over,
  };
  return { ...base, contentHash: contentHash(base) };
}

const t = (n: number) => new Date(Date.UTC(2026, 9, 11, 10, n));

describe('IngestService.ingest', () => {
  it('creates a NEW listing with first price history and an analyze job', async () => {
    const l = listing();
    const r = await ingest.ingest(sourceId, l, t(0));
    expect(r.outcome).toBe('NEW');
    const row = await prisma.listing.findUniqueOrThrow({ where: { id: r.listingId }, include: { priceHistory: true } });
    expect(row).toMatchObject({ status: 'ACTIVE', price: 960_000n, firstSeenAt: t(0), lastSeenAt: t(0), contentHash: l.contentHash });
    expect(row.priceHistory).toHaveLength(1);
    const job = await ref.get(QueueRegistry).analyze.getJob(analyzeJobId(r.listingId, 'NEW', l.contentHash));
    expect(job?.data).toEqual({ listingId: r.listingId, reason: 'NEW' });
  });

  it('is idempotent: the same listing twice (e.g. pagination shift) is UNCHANGED and adds no history', async () => {
    const l = listing();
    const first = await ingest.ingest(sourceId, l, t(0));
    const second = await ingest.ingest(sourceId, l, t(1));
    expect(second).toEqual({ outcome: 'UNCHANGED', listingId: first.listingId });
    expect(await prisma.listing.count()).toBe(1);
    expect(await prisma.listingPriceHistory.count()).toBe(1);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: first.listingId } })).lastSeenAt).toEqual(t(1));
  });

  it('records a PRICE_CHANGED with history and previousPrice in the analyze job', async () => {
    const { listingId } = await ingest.ingest(sourceId, listing(), t(0));
    const cheaper = listing({ price: 900_000n });
    const r = await ingest.ingest(sourceId, cheaper, t(5));
    expect(r.outcome).toBe('PRICE_CHANGED');
    const history = await prisma.listingPriceHistory.findMany({ where: { listingId }, orderBy: { observedAt: 'asc' } });
    expect(history.map((h) => h.price)).toEqual([960_000n, 900_000n]);
    const job = await ref.get(QueueRegistry).analyze.getJob(analyzeJobId(listingId, 'PRICE_CHANGE', cheaper.contentHash));
    expect(job?.data).toEqual({ listingId, reason: 'PRICE_CHANGE', previousPrice: '960000' });
  });

  it('records km changes in history but non-price edits as UPDATED without history', async () => {
    const { listingId } = await ingest.ingest(sourceId, listing(), t(0));
    expect((await ingest.ingest(sourceId, listing({ title: 'Yeni başlık' }), t(1))).outcome).toBe('UPDATED');
    expect(await prisma.listingPriceHistory.count({ where: { listingId } })).toBe(1);
    expect((await ingest.ingest(sourceId, listing({ title: 'Yeni başlık', km: 86_000 }), t(2))).outcome).toBe('UPDATED');
    expect(await prisma.listingPriceHistory.count({ where: { listingId } })).toBe(2);
  });

  it('marks unseen listings REMOVED and brings them back as RELISTED', async () => {
    const a = await ingest.ingest(sourceId, listing(), t(0));
    await ingest.ingest(sourceId, listing({ externalId: 'D000002', url: 'http://demo/ilan/D000002' }), t(10));
    expect(await ingest.markRemoved(sourceId, t(10))).toBe(1);
    const removed = await prisma.listing.findUniqueOrThrow({ where: { id: a.listingId } });
    expect(removed.status).toBe('REMOVED');
    expect(removed.removedAt).not.toBeNull();
    const back = await ingest.ingest(sourceId, listing(), t(20));
    expect(back.outcome).toBe('RELISTED');
    expect(await prisma.listing.findUniqueOrThrow({ where: { id: a.listingId } })).toMatchObject({ status: 'ACTIVE', removedAt: null, relistedAt: t(20) });
    const job = await ref.get(QueueRegistry).analyze.getJob(analyzeJobId(a.listingId, 'RELIST', listing().contentHash));
    expect(job?.data.reason).toBe('RELIST');
  });

  it('keeps listings of different sources apart', async () => {
    const other = await prisma.dataSource.create({ data: { code: 'other', name: 'Other', adapterKey: 'demo-site', kind: 'HTTP', permissionType: 'TEST' } });
    await ingest.ingest(sourceId, listing(), t(0));
    expect((await ingest.ingest(other.id, listing(), t(0))).outcome).toBe('NEW');
    expect(await ingest.markRemoved(other.id, t(5))).toBe(1);
    expect(await prisma.listing.count({ where: { status: 'ACTIVE' } })).toBe(1);
  });
});

describe('IngestService.recordProblems', () => {
  it('stores problems as ListingIssue rows with bounded lengths', async () => {
    await ingest.recordProblems(sourceId, [
      { externalId: 'X1', field: 'price', problem: 'p'.repeat(800), rawSnippet: 's'.repeat(2000) },
      { field: 'externalId', problem: 'boş' },
    ]);
    const rows = await prisma.listingIssue.findMany({ orderBy: { id: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sourceId, externalId: 'X1', field: 'price' });
    expect(rows[0].problem.length).toBe(500);
    expect(rows[0].rawSnippet?.length).toBe(1000);
    expect(rows[1].externalId).toBeNull();
  });
});

describe('AliasService', () => {
  it('resolves from the seeded alias table and caches', async () => {
    const aliases = ref.get(AliasService);
    const resolve = await aliases.resolver();
    expect(resolve('BMW 3 Serisi 320i')).toEqual({ make: 'BMW', model: '3 Serisi', trim: '320i' });
    await prisma.makeModelAlias.create({ data: { rawText: 'Tesla Model 3', make: 'Tesla', model: 'Model 3' } });
    expect((await aliases.resolver())('Tesla Model 3')).toBeNull();
    aliases.invalidate();
    expect((await aliases.resolver())('Tesla Model 3')).toMatchObject({ make: 'Tesla' });
  });
});
```

- [ ] **Step 2: Testin başarısız olduğunu gör**

Run: `pnpm --filter @oto/worker test:e2e`
Expected: FAIL — `../src/collection/...` yok.

- [ ] **Step 3: Uygulamayı yaz**

`apps/worker/src/collection/alias.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { createAliasResolver, type MakeModelResolver } from '@oto/collection';
import { PrismaService } from '../infra/prisma.service';

const CACHE_MS = 5 * 60 * 1000;

@Injectable()
export class AliasService {
  private cache?: { at: number; resolver: MakeModelResolver };

  constructor(private readonly prisma: PrismaService) {}

  async resolver(now = Date.now()): Promise<MakeModelResolver> {
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.resolver;
    const rows = await this.prisma.makeModelAlias.findMany();
    const resolver = createAliasResolver(rows);
    this.cache = { at: now, resolver };
    return resolver;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
```

`apps/worker/src/collection/ingest.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { ListingProblem, NormalizedListing } from '@oto/collection';
import { Prisma } from '@oto/db';
import type { AnalyzeJobData, AnalyzeReason } from '@oto/shared';
import { PrismaService } from '../infra/prisma.service';
import { QueueRegistry } from '../queues/queue-registry';

export type IngestOutcome = 'NEW' | 'PRICE_CHANGED' | 'UPDATED' | 'RELISTED' | 'UNCHANGED';

export interface IngestResult {
  outcome: IngestOutcome;
  listingId: number;
}

export function analyzeJobId(listingId: number, reason: AnalyzeReason, contentHash: string): string {
  return `analyze-${listingId}-${reason}-${contentHash.slice(0, 16)}`;
}

function listingData(l: NormalizedListing) {
  return {
    url: l.url,
    title: l.title,
    imageUrl: l.imageUrl,
    make: l.make,
    model: l.model,
    trim: l.trim,
    year: l.year,
    km: l.km,
    fuel: l.fuel,
    transmission: l.transmission,
    bodyType: l.bodyType,
    color: l.color,
    city: l.city,
    sellerType: l.sellerType,
    damageInfo: l.damageInfo ? (l.damageInfo as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    price: l.price,
    currency: l.currency,
    contentHash: l.contentHash,
  };
}

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

@Injectable()
export class IngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
  ) {}

  async ingest(sourceId: number, l: NormalizedListing, seenAt: Date): Promise<IngestResult> {
    const existing = await this.prisma.listing.findUnique({
      where: { sourceId_externalId: { sourceId, externalId: l.externalId } },
    });

    if (!existing) {
      try {
        const created = await this.prisma.listing.create({
          data: {
            sourceId,
            externalId: l.externalId,
            ...listingData(l),
            firstSeenAt: seenAt,
            lastSeenAt: seenAt,
            priceHistory: { create: { price: l.price, km: l.km, observedAt: seenAt } },
          },
        });
        await this.enqueueAnalyze(created.id, 'NEW', l.contentHash);
        return { outcome: 'NEW', listingId: created.id };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        return this.ingest(sourceId, l, seenAt);
      }
    }

    const relisted = existing.status === 'REMOVED';
    if (!relisted && existing.contentHash === l.contentHash) {
      await this.prisma.listing.update({ where: { id: existing.id }, data: { lastSeenAt: seenAt } });
      return { outcome: 'UNCHANGED', listingId: existing.id };
    }

    const priceChanged = existing.price !== l.price;
    const kmChanged = existing.km !== l.km;
    await this.prisma.$transaction([
      this.prisma.listing.update({
        where: { id: existing.id },
        data: {
          ...listingData(l),
          lastSeenAt: seenAt,
          ...(relisted ? { status: 'ACTIVE' as const, removedAt: null, relistedAt: seenAt } : {}),
        },
      }),
      ...(priceChanged || kmChanged
        ? [this.prisma.listingPriceHistory.create({ data: { listingId: existing.id, price: l.price, km: l.km, observedAt: seenAt } })]
        : []),
    ]);

    const outcome: IngestOutcome = relisted ? 'RELISTED' : priceChanged ? 'PRICE_CHANGED' : 'UPDATED';
    const reason: AnalyzeReason = relisted ? 'RELIST' : priceChanged ? 'PRICE_CHANGE' : 'UPDATE';
    await this.enqueueAnalyze(existing.id, reason, l.contentHash, priceChanged ? existing.price : undefined);
    return { outcome, listingId: existing.id };
  }

  async recordProblems(sourceId: number, problems: ListingProblem[]): Promise<void> {
    if (problems.length === 0) return;
    await this.prisma.listingIssue.createMany({
      data: problems.map((p) => ({
        sourceId,
        externalId: p.externalId?.slice(0, 100) ?? null,
        field: p.field.slice(0, 100),
        problem: p.problem.slice(0, 500),
        rawSnippet: p.rawSnippet?.slice(0, 1000) ?? null,
      })),
    });
  }

  /** Belirtilen andan beri görülmeyen aktif ilanları REMOVED yapar; yalnızca tam ve sağlıklı taramadan sonra çağrılmalıdır. */
  async markRemoved(sourceId: number, notSeenSince: Date): Promise<number> {
    const { count } = await this.prisma.listing.updateMany({
      where: { sourceId, status: 'ACTIVE', lastSeenAt: { lt: notSeenSince } },
      data: { status: 'REMOVED', removedAt: new Date() },
    });
    return count;
  }

  private async enqueueAnalyze(listingId: number, reason: AnalyzeReason, contentHash: string, previousPrice?: bigint): Promise<void> {
    const data: AnalyzeJobData = { listingId, reason, ...(previousPrice !== undefined ? { previousPrice: previousPrice.toString() } : {}) };
    await this.queues.analyze.add('analyze', data, {
      jobId: analyzeJobId(listingId, reason, contentHash),
      removeOnComplete: { age: 24 * 60 * 60 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
  }
}
```

`apps/worker/src/collection/collection.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AliasService } from './alias.service';
import { IngestService } from './ingest.service';

@Module({ providers: [AliasService, IngestService], exports: [AliasService, IngestService] })
export class CollectionModule {}
```

- [ ] **Step 4: Testleri çalıştır**

Run: `pnpm --filter @oto/worker test:e2e && pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(worker): add idempotent listing ingest with price history and analyze queue"
```

---

### Task 8: Tarama çalıştırıcısı ve kaynak sağlığı

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (CollectionJob.listingsRemoved), Create: `packages/db/prisma/migrations/20261011000000_collection_job_removed/migration.sql`
- Create: `apps/worker/src/collection/{source-health.service,scrape-runner.service}.ts`
- Modify: `apps/worker/src/collection/collection.module.ts`, `apps/worker/test/helpers.ts`
- Test: `apps/worker/test/scrape-runner.e2e.spec.ts`

**Interfaces:**
- Consumes: `getAdapter`, `normalizeListing`, `PoliteHttpClient`, `FetchError` (`@oto/collection`); `IngestService`, `AliasService`, `AlertService`, `Encryptor`.
- Produces: `PARSE_ISSUE_THRESHOLD = 0.2`, `DEGRADED_AFTER = 3`, `DOWN_AFTER = 6`; `SourceHealthService.recordSuccess(sourceId, issueRate)`, `.recordFailure(sourceId, err)`; `ScrapeRunner.run(collectionJobId) → RunSummary | null` (`RunSummary { status; pages; cards; created; updated; removed; failed }`). Test yardımcıları: `startDemo(opts?)`, `createSource(ref, baseUrl, over?)`, `createQueuedJob(ref, sourceId)`.

- [ ] **Step 1: Şemayı ve migration'ı ekle**

`packages/db/prisma/schema.prisma` → `model CollectionJob` içinde `listingsUpdated` satırından sonra:
```prisma
  listingsRemoved Int           @default(0)
```

Migration'ı üret (eski şemayı geçici dosyaya alarak):
```bash
git show HEAD:packages/db/prisma/schema.prisma > /tmp/schema-before.prisma
mkdir -p packages/db/prisma/migrations/20261011000000_collection_job_removed
pnpm --filter @oto/db exec prisma migrate diff --from-schema-datamodel /tmp/schema-before.prisma --to-schema-datamodel prisma/schema.prisma --script -o prisma/migrations/20261011000000_collection_job_removed/migration.sql
```
Expected `migration.sql`: `ALTER TABLE "CollectionJob" ADD COLUMN "listingsRemoved" INTEGER NOT NULL DEFAULT 0;` (yalnızca bu değişiklik). Run: `pnpm build:packages`.

- [ ] **Step 2: Test yardımcılarını ekle** (`apps/worker/test/helpers.ts` sonuna)

```ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDemoSite, type DemoSite } from '@oto/demo-site';

export async function startDemo(opts: { size?: number; pageSize?: number } = {}) {
  const site: DemoSite = createDemoSite({ seed: 7, size: opts.size ?? 45, pageSize: opts.pageSize ?? 20 });
  const server = createServer(site.app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { site, baseUrl, close: () => new Promise<void>((done) => server.close(() => done())) };
}

export async function createSource(ref: TestingModule, baseUrl: string, over: Record<string, unknown> = {}) {
  return ref.get(PrismaService).dataSource.create({
    data: {
      code: `demo-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Demo',
      adapterKey: 'demo-site',
      kind: 'HTTP',
      permissionType: 'TEST',
      permissionVerifiedAt: new Date(),
      isActive: true,
      intervalSec: 60,
      minRequestGapMs: 0,
      config: { baseUrl },
      ...over,
    },
  });
}

export async function createQueuedJob(ref: TestingModule, sourceId: number) {
  return ref.get(PrismaService).collectionJob.create({ data: { sourceId, trigger: 'SCHEDULED' } });
}
```
(Import'ları dosyanın en üstüne taşı.)

- [ ] **Step 3: Başarısız testi yaz** (`apps/worker/test/scrape-runner.e2e.spec.ts`)

```ts
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CollectionModule } from '../src/collection/collection.module';
import { ScrapeRunner } from '../src/collection/scrape-runner.service';
import { PrismaService } from '../src/infra/prisma.service';
import { createAdmin, createContext, createQueuedJob, createSource, resetState, startDemo } from './helpers';

let ref: TestingModule;
let prisma: PrismaService;
let runner: ScrapeRunner;
let demo: Awaited<ReturnType<typeof startDemo>>;

beforeAll(async () => {
  ref = await createContext([CollectionModule]);
  prisma = ref.get(PrismaService);
  runner = ref.get(ScrapeRunner);
  demo = await startDemo();
});
afterAll(async () => {
  await demo.close();
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
  demo.site.store.reset(7, 45);
  demo.site.setMode('normal');
});

async function runOnce(sourceId: number) {
  const job = await createQueuedJob(ref, sourceId);
  await runner.run(job.id);
  return prisma.collectionJob.findUniqueOrThrow({ where: { id: job.id } });
}

describe('ScrapeRunner', () => {
  it('crawls every page and ingests all listings on the first run', async () => {
    const source = await createSource(ref, demo.baseUrl);
    const job = await runOnce(source.id);
    expect(job).toMatchObject({ status: 'SUCCEEDED', pagesFetched: 3, listingsSeen: 45, listingsNew: 45, listingsUpdated: 0, listingsRemoved: 0, errorsCount: 0 });
    expect(job.startedAt).not.toBeNull();
    expect(job.finishedAt).not.toBeNull();
    expect(job.avgResponseMs).not.toBeNull();
    expect(await prisma.listing.count({ where: { sourceId: source.id, status: 'ACTIVE' } })).toBe(45);
    expect(await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ health: 'HEALTHY', consecutiveFailures: 0 });
  });

  it('tracks price changes, removals and new listings on the next run', async () => {
    const source = await createSource(ref, demo.baseUrl);
    await runOnce(source.id);
    const [cheap, gone] = demo.site.store.active();
    demo.site.store.patch(cheap.id, { price: cheap.price - 50_000 });
    demo.site.store.patch(gone.id, { status: 'REMOVED' });
    const fresh = demo.site.store.inject({ discount: 0.25 });
    const job = await runOnce(source.id);
    expect(job).toMatchObject({ status: 'SUCCEEDED', listingsNew: 1, listingsUpdated: 1, listingsRemoved: 1 });
    const byExt = async (externalId: string) => prisma.listing.findUniqueOrThrow({ where: { sourceId_externalId: { sourceId: source.id, externalId } }, include: { priceHistory: true } });
    expect((await byExt(cheap.id)).priceHistory).toHaveLength(2);
    expect((await byExt(gone.id)).status).toBe('REMOVED');
    expect((await byExt(fresh.id)).status).toBe('ACTIVE');
  });

  it('never removes listings or ingests garbage when the layout breaks (Review Focus #1)', async () => {
    await createAdmin(ref);
    const source = await createSource(ref, demo.baseUrl);
    await runOnce(source.id);
    demo.site.setMode('broken');
    const job = await runOnce(source.id);
    expect(job).toMatchObject({ status: 'PARTIAL', listingsSeen: 45, listingsNew: 0, listingsRemoved: 0, errorsCount: 45 });
    expect(await prisma.listing.count({ where: { sourceId: source.id, status: 'ACTIVE' } })).toBe(45);
    expect(await prisma.listingIssue.count({ where: { sourceId: source.id } })).toBe(45);
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).health).toBe('DEGRADED');
    expect(await prisma.systemLog.count({ where: { level: 'WARN' } })).toBe(1);
    expect(await prisma.notification.count({ where: { kind: 'SYSTEM_ALERT' } })).toBe(1);
  });

  it.each(['captcha', 'forbidden'] as const)('pauses the source when blocked (%s) and alerts admins', async (mode) => {
    await createAdmin(ref);
    const source = await createSource(ref, demo.baseUrl);
    demo.site.setMode(mode);
    const job = await runOnce(source.id);
    expect(job.status).toBe('FAILED');
    expect(await prisma.scrapeError.findFirst({ where: { jobId: job.id } })).toMatchObject({ kind: 'BLOCKED', transient: false });
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).health).toBe('PAUSED');
    expect(await prisma.systemLog.count({ where: { level: 'ERROR' } })).toBe(1);
    expect(await prisma.notification.count({ where: { kind: 'SYSTEM_ALERT' } })).toBe(1);
  });

  it('counts consecutive network failures and degrades after 3', async () => {
    const source = await createSource(ref, 'http://127.0.0.1:1');
    for (let i = 0; i < 2; i++) expect((await runOnce(source.id)).status).toBe('FAILED');
    expect(await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ health: 'HEALTHY', consecutiveFailures: 2 });
    await runOnce(source.id);
    expect(await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ health: 'DEGRADED', consecutiveFailures: 3 });
    expect(await prisma.scrapeError.findFirst()).toMatchObject({ kind: 'NETWORK', transient: true });
  });

  it('does not remove anything after an incomplete crawl (maxPages)', async () => {
    const source = await createSource(ref, demo.baseUrl);
    await runOnce(source.id);
    await prisma.dataSource.update({ where: { id: source.id }, data: { config: { baseUrl: demo.baseUrl, maxPages: 1 } } });
    const job = await runOnce(source.id);
    expect(job).toMatchObject({ status: 'SUCCEEDED', pagesFetched: 1, listingsRemoved: 0 });
    expect(await prisma.listing.count({ where: { sourceId: source.id, status: 'ACTIVE' } })).toBe(45);
  });

  it('skips jobs that are not QUEUED and fails jobs of paused sources', async () => {
    const source = await createSource(ref, demo.baseUrl);
    const done = await prisma.collectionJob.create({ data: { sourceId: source.id, trigger: 'SCHEDULED', status: 'SUCCEEDED' } });
    expect(await runner.run(done.id)).toBeNull();
    expect(await runner.run(999_999)).toBeNull();
    await prisma.dataSource.update({ where: { id: source.id }, data: { health: 'PAUSED' } });
    const job = await runOnce(source.id);
    expect(job).toMatchObject({ status: 'FAILED', pagesFetched: 0 });
    expect(await prisma.listing.count()).toBe(0);
    const unknown = await createSource(ref, demo.baseUrl, { adapterKey: 'nope' });
    const failed = await runOnce(unknown.id);
    expect(failed).toMatchObject({ status: 'FAILED', errorSummary: expect.stringContaining('Bilinmeyen adapter') });
  });

  it('a recovered source becomes HEALTHY again', async () => {
    const source = await createSource(ref, demo.baseUrl, { health: 'DEGRADED', consecutiveFailures: 4 });
    await runOnce(source.id);
    expect(await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ health: 'HEALTHY', consecutiveFailures: 0 });
  });
});
```

- [ ] **Step 4: Testin başarısız olduğunu gör**

Run: `pnpm --filter @oto/worker test:e2e`
Expected: FAIL — `scrape-runner.service` yok.

- [ ] **Step 5: Uygulamayı yaz**

`apps/worker/src/collection/source-health.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { FetchError } from '@oto/collection';
import type { SourceHealth } from '@oto/db';
import { AlertService } from '../common/alert.service';
import { PrismaService } from '../infra/prisma.service';

export const PARSE_ISSUE_THRESHOLD = 0.2;
export const DEGRADED_AFTER = 3;
export const DOWN_AFTER = 6;

@Injectable()
export class SourceHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertService,
  ) {}

  async recordSuccess(sourceId: number, issueRate: number): Promise<void> {
    const source = await this.prisma.dataSource.findUniqueOrThrow({ where: { id: sourceId } });
    const degraded = issueRate > PARSE_ISSUE_THRESHOLD;
    const health: SourceHealth = source.health === 'PAUSED' ? 'PAUSED' : degraded ? 'DEGRADED' : 'HEALTHY';
    await this.prisma.dataSource.update({
      where: { id: sourceId },
      data: { consecutiveFailures: 0, lastSuccessAt: new Date(), health },
    });
    if (degraded) {
      await this.alerts.raise({
        key: `source:${sourceId}:parse`,
        level: 'WARN',
        component: 'collection',
        message: `${source.name}: ilanların %${Math.round(issueRate * 100)}'i ayrıştırılamadı veya doğrulanamadı; sayfa yapısı değişmiş olabilir.`,
        context: { sourceId, issueRate },
      });
    }
  }

  async recordFailure(sourceId: number, err: Error): Promise<void> {
    const source = await this.prisma.dataSource.findUniqueOrThrow({ where: { id: sourceId } });
    const failures = source.consecutiveFailures + 1;
    const blocked = err instanceof FetchError && err.kind === 'BLOCKED';
    let health: SourceHealth = source.health;
    if (blocked || source.health === 'PAUSED') health = 'PAUSED';
    else if (failures >= DOWN_AFTER) health = 'DOWN';
    else if (failures >= DEGRADED_AFTER) health = 'DEGRADED';
    await this.prisma.dataSource.update({
      where: { id: sourceId },
      data: { consecutiveFailures: failures, lastErrorAt: new Date(), health },
    });

    const context = { sourceId, failures, error: err.message.slice(0, 300) };
    if (blocked) {
      await this.alerts.raise({
        key: `source:${sourceId}:blocked`,
        level: 'ERROR',
        component: 'collection',
        message: `${source.name} erişimimizi engelledi; kaynak duraklatıldı ve yeniden denenmeyecek. Kaynağın kullanım koşullarını ve iznini kontrol edin.`,
        context,
      });
    } else if (health === 'DOWN' && source.health !== 'DOWN') {
      await this.alerts.raise({ key: `source:${sourceId}:down`, level: 'ERROR', component: 'collection', message: `${source.name} ${failures} kez üst üste başarısız oldu; kaynak DOWN.`, context });
    } else if (health === 'DEGRADED' && source.health !== 'DEGRADED') {
      await this.alerts.raise({ key: `source:${sourceId}:degraded`, level: 'WARN', component: 'collection', message: `${source.name} ${failures} kez üst üste başarısız oldu.`, context });
    }
  }
}
```

`apps/worker/src/collection/scrape-runner.service.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { FetchError, getAdapter, normalizeListing, PoliteHttpClient, type ListingProblem, type SourceAdapter } from '@oto/collection';
import type { JobStatus } from '@oto/db';
import { Encryptor } from '@oto/server-common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { AliasService } from './alias.service';
import { IngestService } from './ingest.service';
import { PARSE_ISSUE_THRESHOLD, SourceHealthService } from './source-health.service';

export interface RunSummary {
  status: JobStatus;
  pages: number;
  cards: number;
  created: number;
  updated: number;
  removed: number;
  failed: number;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

@Injectable()
export class ScrapeRunner {
  private readonly logger = new Logger(ScrapeRunner.name);
  private readonly userAgent: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly encryptor: Encryptor,
    private readonly aliases: AliasService,
    private readonly ingest: IngestService,
    private readonly health: SourceHealthService,
    @Inject(ENV) env: Env,
  ) {
    this.userAgent = `OtoFirsatBot/1.0 (+${env.BOT_CONTACT_URL})`;
  }

  /** Bir CollectionJob'u uçtan uca yürütür. Yalnızca QUEUED işleri çalıştırır (yeniden teslimde güvenli). */
  async run(collectionJobId: number): Promise<RunSummary | null> {
    const job = await this.prisma.collectionJob.findUnique({
      where: { id: collectionJobId },
      include: { source: { include: { proxyConfig: true } } },
    });
    if (!job || job.status !== 'QUEUED') return null;
    const { source } = job;

    const refuse = async (reason: string) => {
      await this.prisma.collectionJob.update({ where: { id: job.id }, data: { status: 'FAILED', finishedAt: new Date(), errorSummary: reason } });
      return null;
    };
    if (!source.isActive || !source.permissionVerifiedAt || source.health === 'PAUSED') {
      return refuse('Kaynak pasif, izinsiz veya duraklatılmış');
    }
    let adapter: SourceAdapter;
    try {
      adapter = getAdapter(source.adapterKey);
    } catch (err) {
      return refuse(message(err));
    }

    const startedAt = new Date();
    await this.prisma.collectionJob.update({ where: { id: job.id }, data: { status: 'RUNNING', startedAt } });

    const http = new PoliteHttpClient({
      sourceId: source.id,
      minRequestGapMs: source.minRequestGapMs,
      userAgent: this.userAgent,
      redis: this.redis,
      proxyUrl: source.proxyConfig?.isEnabled ? this.encryptor.decrypt(source.proxyConfig.urlEncrypted) : null,
      isBlockedPage: adapter.isBlockedPage ? (html) => adapter.isBlockedPage!(html) : undefined,
    });
    const resolve = await this.aliases.resolver();
    const c = { pages: 0, cards: 0, created: 0, updated: 0, removed: 0, failed: 0, complete: false };
    let fatal: unknown = null;

    try {
      for await (const page of adapter.listPages({ http, config: source.config })) {
        c.pages += 1;
        const parsed = adapter.parseList(page);
        const problems: ListingProblem[] = [...parsed.problems];
        c.cards += parsed.listings.length + parsed.problems.length;
        c.failed += parsed.problems.length;
        for (const raw of parsed.listings) {
          const normalized = normalizeListing(raw, resolve);
          if (!normalized.ok) {
            c.failed += 1;
            problems.push(...normalized.problems);
            continue;
          }
          const { outcome } = await this.ingest.ingest(source.id, normalized.listing, startedAt);
          if (outcome === 'NEW') c.created += 1;
          else if (outcome !== 'UNCHANGED') c.updated += 1;
        }
        await this.ingest.recordProblems(source.id, problems);
        if (page.isLast) c.complete = true;
      }
    } catch (err) {
      fatal = err;
    } finally {
      await http.close();
    }

    const issueRate = c.cards === 0 ? (c.pages > 0 ? 1 : 0) : c.failed / c.cards;
    let status: JobStatus;
    if (fatal) {
      const fe = fatal instanceof FetchError ? fatal : null;
      await this.prisma.scrapeError.create({
        data: { jobId: job.id, sourceId: source.id, kind: fe?.kind ?? 'PARSE', url: fe?.url ?? null, message: message(fatal).slice(0, 1000), transient: fe?.transient ?? false },
      });
      await this.health.recordFailure(source.id, fatal instanceof Error ? fatal : new Error(message(fatal)));
      status = c.pages > 0 && fe?.kind !== 'BLOCKED' ? 'PARTIAL' : 'FAILED';
      this.logger.warn(`Kaynak ${source.code} taraması başarısız: ${message(fatal)}`);
    } else {
      const fullCrawl = (source.config as { fullCrawl?: boolean } | null)?.fullCrawl !== false;
      if (fullCrawl && c.complete && c.cards > 0 && issueRate <= PARSE_ISSUE_THRESHOLD) {
        c.removed = await this.ingest.markRemoved(source.id, startedAt);
      }
      await this.health.recordSuccess(source.id, issueRate);
      status = c.failed > 0 ? 'PARTIAL' : 'SUCCEEDED';
    }

    await this.prisma.collectionJob.update({
      where: { id: job.id },
      data: {
        status,
        finishedAt: new Date(),
        pagesFetched: c.pages,
        listingsSeen: c.cards,
        listingsNew: c.created,
        listingsUpdated: c.updated,
        listingsRemoved: c.removed,
        errorsCount: c.failed + (fatal ? 1 : 0),
        avgResponseMs: http.stats.requests > 0 ? Math.round(http.stats.totalMs / http.stats.requests) : null,
        errorSummary: fatal ? message(fatal).slice(0, 500) : c.failed > 0 ? `${c.failed} ilan ayrıştırılamadı veya doğrulanamadı` : null,
      },
    });
    return { status, pages: c.pages, cards: c.cards, created: c.created, updated: c.updated, removed: c.removed, failed: c.failed };
  }
}
```

`apps/worker/src/collection/collection.module.ts` (tamamı):
```ts
import { Module } from '@nestjs/common';
import { AliasService } from './alias.service';
import { IngestService } from './ingest.service';
import { ScrapeRunner } from './scrape-runner.service';
import { SourceHealthService } from './source-health.service';

@Module({
  providers: [AliasService, IngestService, SourceHealthService, ScrapeRunner],
  exports: [AliasService, IngestService, SourceHealthService, ScrapeRunner],
})
export class CollectionModule {}
```

- [ ] **Step 6: Testleri çalıştır**

Run: `pnpm --filter @oto/worker test:e2e && pnpm --filter @oto/db test:e2e && pnpm lint && pnpm typecheck`
Expected: PASS. (Ağ hatası testi 3 çalıştırma × robots denemesi; birkaç saniye sürer.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(worker): add scrape runner with source health, removal detection and alerts"
```

---

### Task 9: Scheduler, scrape kuyruk işlemcisi, temizlik ve demo kaynak seed'i

**Files:**
- Create: `apps/worker/src/scheduler/{scheduler.module,scheduler.service,scheduler-loop.service}.ts`, `apps/worker/src/processors/scrape-worker.host.ts`
- Modify: `apps/worker/src/{worker-app.module,scheduler-app.module}.ts`
- Modify: `packages/db/src/seed-data.ts`, `packages/db/prisma/seed.ts`, `packages/db/test/schema.spec.ts`
- Test: `apps/worker/test/scheduler.e2e.spec.ts`

**Interfaces:**
- Consumes: `QueueRegistry`, `ScrapeRunner`, `scrapeJobSchema`, `bullConnection`.
- Produces: `STALE_AFTER_MS`, `RETENTION_DAYS = 30`; `SchedulerService.tick(now?) → number`, `.failStaleJobs(now)`, `.cleanup(now?) → { systemLogs; scrapeErrors; listingIssues }`; `scrapeQueueJobId(collectionJobId)`; `SchedulerLoop`; `ScrapeWorkerHost`; `@oto/db`: `seedDemoSource(prisma, baseUrl) → DataSource`.

- [ ] **Step 1: Demo kaynak seed'i (`packages/db`)**

`packages/db/src/seed-data.ts` sonuna ekle:
```ts
/** Yalnızca geliştirme: yerel demo ilan sitesini (apps/demo-site) izinli TEST kaynağı olarak kaydeder. */
export async function seedDemoSource(prisma: PrismaClient, baseUrl: string) {
  return prisma.dataSource.upsert({
    where: { code: 'demo-site' },
    update: { config: { baseUrl } },
    create: {
      code: 'demo-site',
      name: 'Demo İlan Sitesi',
      adapterKey: 'demo-site',
      kind: 'HTTP',
      permissionType: 'TEST',
      permissionNote: 'Yerel sahte ilan sitesi (apps/demo-site); gerçek veri içermez.',
      permissionVerifiedAt: new Date(),
      isActive: true,
      intervalSec: 120,
      minRequestGapMs: 200,
      maxConcurrency: 1,
      config: { baseUrl },
    },
  });
}
```

`packages/db/prisma/seed.ts` içinde alias seed'inden sonra ekle (import'a `seedDemoSource` ekle):
```ts
    if (process.env.SEED_DEMO_SOURCE === 'true') {
      const url = process.env.DEMO_SITE_URL ?? 'http://localhost:4000';
      await seedDemoSource(prisma, url);
      console.log(`Demo kaynak hazır: ${url}`);
    }
```

`packages/db/test/schema.spec.ts` describe içine ekle (import'a `seedDemoSource`):
```ts
  it('seedDemoSource creates an active, permission-verified TEST source idempotently', async () => {
    await seedDemoSource(prisma, 'http://localhost:4000');
    const s = await seedDemoSource(prisma, 'http://localhost:4001');
    expect(s).toMatchObject({ code: 'demo-site', isActive: true, permissionType: 'TEST', config: { baseUrl: 'http://localhost:4001' } });
    expect(s.permissionVerifiedAt).not.toBeNull();
    expect(await prisma.dataSource.count({ where: { code: 'demo-site' } })).toBe(1);
  });
```

- [ ] **Step 2: Başarısız testi yaz** (`apps/worker/test/scheduler.e2e.spec.ts`)

```ts
import { Module } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CollectionModule } from '../src/collection/collection.module';
import { PrismaService } from '../src/infra/prisma.service';
import { SCRAPE_WORKER_AUTOSTART, ScrapeWorkerHost } from '../src/processors/scrape-worker.host';
import { QueueRegistry } from '../src/queues/queue-registry';
import { SchedulerModule } from '../src/scheduler/scheduler.module';
import { scrapeQueueJobId, SchedulerService } from '../src/scheduler/scheduler.service';
import { createContext, createSource, resetState, startDemo } from './helpers';

/** ScrapeWorkerHost'u test içinde elle başlatıp durdurmak için otomatik başlatma kapalı. */
@Module({
  imports: [CollectionModule],
  providers: [ScrapeWorkerHost, { provide: SCRAPE_WORKER_AUTOSTART, useValue: false }],
  exports: [ScrapeWorkerHost],
})
class ProcessorTestModule {}

let ref: TestingModule;
let prisma: PrismaService;
let scheduler: SchedulerService;
let demo: Awaited<ReturnType<typeof startDemo>>;

beforeAll(async () => {
  ref = await createContext([CollectionModule, SchedulerModule, ProcessorTestModule]);
  prisma = ref.get(PrismaService);
  scheduler = ref.get(SchedulerService);
  demo = await startDemo();
});
afterAll(async () => {
  await demo.close();
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
  demo.site.store.reset(7, 45);
});

const T0 = new Date('2026-10-11T10:00:00Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

describe('SchedulerService.tick', () => {
  it('enqueues a due source once and waits for its interval', async () => {
    const source = await createSource(ref, demo.baseUrl, { intervalSec: 60 });
    expect(await scheduler.tick(T0)).toBe(1);
    const [job] = await prisma.collectionJob.findMany({ where: { sourceId: source.id } });
    expect(job).toMatchObject({ status: 'QUEUED', trigger: 'SCHEDULED' });
    expect((await ref.get(QueueRegistry).scrape.getJob(scrapeQueueJobId(job.id)))?.data).toEqual({ collectionJobId: job.id, sourceId: source.id });
    expect(await scheduler.tick(T0)).toBe(0); // hâlâ QUEUED
    await prisma.collectionJob.update({ where: { id: job.id }, data: { status: 'SUCCEEDED', createdAt: T0 } });
    expect(await scheduler.tick(plus(59_000))).toBe(0);
    expect(await scheduler.tick(plus(60_000))).toBe(1);
  });

  it('ignores inactive and paused sources', async () => {
    await createSource(ref, demo.baseUrl, { isActive: false });
    await createSource(ref, demo.baseUrl, { health: 'PAUSED' });
    expect(await scheduler.tick(T0)).toBe(0);
  });

  it('recovers from a crashed worker: stale RUNNING jobs fail and the source is rescheduled (Review Focus #4)', async () => {
    const source = await createSource(ref, demo.baseUrl);
    const stuck = await prisma.collectionJob.create({ data: { sourceId: source.id, trigger: 'SCHEDULED', status: 'RUNNING', createdAt: plus(-31 * 60_000) } });
    expect(await scheduler.tick(T0)).toBe(1);
    expect(await prisma.collectionJob.findUniqueOrThrow({ where: { id: stuck.id } })).toMatchObject({ status: 'FAILED', errorSummary: expect.stringContaining('zaman aşımı') });
  });

  it('keeps a recent RUNNING job alone', async () => {
    const source = await createSource(ref, demo.baseUrl);
    await prisma.collectionJob.create({ data: { sourceId: source.id, trigger: 'SCHEDULED', status: 'RUNNING', createdAt: plus(-5 * 60_000) } });
    expect(await scheduler.tick(T0)).toBe(0);
  });
});

describe('SchedulerService.cleanup', () => {
  it('deletes logs, scrape errors and listing issues older than 30 days', async () => {
    const source = await createSource(ref, demo.baseUrl);
    const old = plus(-31 * 24 * 3600_000);
    await prisma.systemLog.createMany({ data: [{ level: 'WARN', component: 'x', message: 'old', createdAt: old }, { level: 'WARN', component: 'x', message: 'new' }] });
    await prisma.scrapeError.createMany({ data: [{ sourceId: source.id, kind: 'NETWORK', message: 'old', transient: true, createdAt: old }, { sourceId: source.id, kind: 'NETWORK', message: 'new', transient: true }] });
    await prisma.listingIssue.createMany({ data: [{ sourceId: source.id, field: 'price', problem: 'old', createdAt: old }, { sourceId: source.id, field: 'price', problem: 'new' }] });
    expect(await scheduler.cleanup(new Date())).toEqual({ systemLogs: 1, scrapeErrors: 1, listingIssues: 1 });
    expect(await prisma.systemLog.count()).toBe(1);
  });
});

describe('ScrapeWorkerHost', () => {
  it('processes scheduled scrape jobs from the queue end to end', async () => {
    const host = ref.get(ScrapeWorkerHost);
    host.start();
    try {
      const source = await createSource(ref, demo.baseUrl);
      await scheduler.tick(new Date());
      const deadline = Date.now() + 30_000;
      let status = 'QUEUED';
      while (Date.now() < deadline && status !== 'SUCCEEDED') {
        await new Promise((r) => setTimeout(r, 200));
        status = (await prisma.collectionJob.findFirstOrThrow({ where: { sourceId: source.id } })).status;
      }
      expect(status).toBe('SUCCEEDED');
      expect(await prisma.listing.count({ where: { sourceId: source.id } })).toBe(45);
    } finally {
      await host.onModuleDestroy();
    }
  });
});
```

- [ ] **Step 3: Testin başarısız olduğunu gör**

Run: `pnpm build:packages && pnpm --filter @oto/worker test:e2e`
Expected: FAIL — `scheduler.service` yok.

- [ ] **Step 4: Uygulamayı yaz**

`apps/worker/src/scheduler/scheduler.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { QueueRegistry } from '../queues/queue-registry';

export const STALE_AFTER_MS = 30 * 60 * 1000;
export const RETENTION_DAYS = 30;

export function scrapeQueueJobId(collectionJobId: number): string {
  return `scrape-${collectionJobId}`;
}

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
  ) {}

  /** Zamanı gelen her kaynak için bir CollectionJob + scrape işi üretir. Dönen değer: kuyruğa eklenen iş sayısı. */
  async tick(now: Date = new Date()): Promise<number> {
    await this.failStaleJobs(now);
    const sources = await this.prisma.dataSource.findMany({
      where: { isActive: true, permissionVerifiedAt: { not: null }, health: { not: 'PAUSED' } },
      include: { jobs: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    let enqueued = 0;
    for (const source of sources) {
      const last = source.jobs[0];
      if (last && (last.status === 'QUEUED' || last.status === 'RUNNING')) continue;
      if (last && now.getTime() - last.createdAt.getTime() < source.intervalSec * 1000) continue;
      const job = await this.prisma.collectionJob.create({ data: { sourceId: source.id, trigger: 'SCHEDULED', createdAt: now } });
      await this.queues.scrape.add(
        'scrape',
        { collectionJobId: job.id, sourceId: source.id },
        { jobId: scrapeQueueJobId(job.id), removeOnComplete: { age: 24 * 60 * 60 }, removeOnFail: { age: 7 * 24 * 60 * 60 } },
      );
      enqueued += 1;
    }
    return enqueued;
  }

  /** Çöken bir worker'ın bıraktığı işleri kapatır; aksi halde kaynak sonsuza dek "meşgul" görünür. */
  async failStaleJobs(now: Date): Promise<number> {
    const { count } = await this.prisma.collectionJob.updateMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] }, createdAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) } },
      data: { status: 'FAILED', finishedAt: now, errorSummary: 'İş zaman aşımına uğradı (worker çökmüş olabilir)' },
    });
    if (count > 0) this.logger.warn(`${count} eski tarama işi FAILED olarak kapatıldı`);
    return count;
  }

  async cleanup(now: Date = new Date()): Promise<{ systemLogs: number; scrapeErrors: number; listingIssues: number }> {
    const before = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const [systemLogs, scrapeErrors, listingIssues] = await Promise.all([
      this.prisma.systemLog.deleteMany({ where: { createdAt: { lt: before } } }),
      this.prisma.scrapeError.deleteMany({ where: { createdAt: { lt: before } } }),
      this.prisma.listingIssue.deleteMany({ where: { createdAt: { lt: before } } }),
    ]);
    return { systemLogs: systemLogs.count, scrapeErrors: scrapeErrors.count, listingIssues: listingIssues.count };
  }
}
```

Not: `tick` yeni işin `createdAt`'ını `now` ile yazar; böylece aralık hesabı test edilebilir zamanla tutarlıdır.

`apps/worker/src/scheduler/scheduler.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';

@Module({ providers: [SchedulerService], exports: [SchedulerService] })
export class SchedulerModule {}
```

`apps/worker/src/scheduler/scheduler-loop.service.ts`:
```ts
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { SchedulerService } from './scheduler.service';

const CLEANUP_EVERY_MS = 24 * 60 * 60 * 1000;

/** Yalnızca ROLE=scheduler süreçlerinde yüklenir; tek instance çalışmalıdır. */
@Injectable()
export class SchedulerLoop implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerLoop.name);
  private tickTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly scheduler: SchedulerService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    void this.safeTick();
    void this.safeCleanup();
    this.tickTimer = setInterval(() => void this.safeTick(), this.env.SCHEDULER_TICK_MS);
    this.cleanupTimer = setInterval(() => void this.safeCleanup(), CLEANUP_EVERY_MS);
  }

  onModuleDestroy(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  private async safeTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const n = await this.scheduler.tick();
      if (n > 0) this.logger.log(`${n} tarama işi kuyruğa eklendi`);
    } catch (err) {
      this.logger.error(`Scheduler tick başarısız: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async safeCleanup(): Promise<void> {
    try {
      const r = await this.scheduler.cleanup();
      this.logger.log(`Temizlik: ${r.systemLogs} log, ${r.scrapeErrors} tarama hatası, ${r.listingIssues} ilan sorunu silindi`);
    } catch (err) {
      this.logger.error(`Temizlik başarısız: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
```

`apps/worker/src/processors/scrape-worker.host.ts`:
```ts
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { QueueName, scrapeJobSchema, type ScrapeJobData } from '@oto/shared';
import { Worker } from 'bullmq';
import { ScrapeRunner } from '../collection/scrape-runner.service';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { bullConnection } from '../infra/bull';

export const SCRAPE_WORKER_AUTOSTART = Symbol('SCRAPE_WORKER_AUTOSTART');

@Injectable()
export class ScrapeWorkerHost implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScrapeWorkerHost.name);
  private worker?: Worker<ScrapeJobData>;

  constructor(
    private readonly runner: ScrapeRunner,
    @Inject(ENV) private readonly env: Env,
    @Optional() @Inject(SCRAPE_WORKER_AUTOSTART) private readonly autostart: boolean = true,
  ) {}

  onModuleInit(): void {
    if (this.autostart) this.start();
  }

  start(): void {
    if (this.worker) return;
    this.worker = new Worker<ScrapeJobData>(
      QueueName.SCRAPE,
      async (job) => {
        const data = scrapeJobSchema.parse(job.data);
        await this.runner.run(data.collectionJobId);
      },
      { connection: bullConnection(this.env.REDIS_URL), concurrency: this.env.SCRAPE_CONCURRENCY },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`Scrape işi ${job?.id} başarısız: ${err.message}`));
  }

  /** Graceful shutdown: aktif işler bitene kadar bekler. */
  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    this.worker = undefined;
  }
}
```

`apps/worker/src/worker-app.module.ts` (tamamı):
```ts
import { Module } from '@nestjs/common';
import { CollectionModule } from './collection/collection.module';
import { HeartbeatService } from './common/heartbeat.service';
import { CoreModule } from './core.module';
import { ScrapeWorkerHost } from './processors/scrape-worker.host';

@Module({ imports: [CoreModule, CollectionModule], providers: [HeartbeatService, ScrapeWorkerHost] })
export class WorkerAppModule {}
```

`apps/worker/src/scheduler-app.module.ts` (tamamı):
```ts
import { Module } from '@nestjs/common';
import { HeartbeatService } from './common/heartbeat.service';
import { CoreModule } from './core.module';
import { SchedulerLoop } from './scheduler/scheduler-loop.service';
import { SchedulerModule } from './scheduler/scheduler.module';

@Module({ imports: [CoreModule, SchedulerModule], providers: [HeartbeatService, SchedulerLoop] })
export class SchedulerAppModule {}
```

- [ ] **Step 5: Testleri çalıştır**

Run: `pnpm build:packages && pnpm --filter @oto/worker test:e2e && pnpm --filter @oto/db test:e2e && pnpm --filter @oto/worker build && pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(worker): add scheduler with stale-job recovery, scrape queue processor and cleanup"
```

---

### Task 10: Uçtan uca hat testi, geliştirici komutları ve dokümantasyon

**Files:**
- Test: `apps/worker/test/pipeline.e2e.spec.ts`
- Modify: root `package.json` (scripts), `.env.example`, `README.md`, `docs/architecture.md`, `docs/superpowers/plans/2026-10-10-00-roadmap.md`
- Create: `docs/adding-a-source.md`

**Interfaces:**
- Consumes: tüm önceki task'lar.

- [ ] **Step 1: Uçtan uca testi yaz** (`apps/worker/test/pipeline.e2e.spec.ts`)

```ts
import { Module } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { seedDemoSource } from '@oto/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CollectionModule } from '../src/collection/collection.module';
import { analyzeJobId } from '../src/collection/ingest.service';
import { PrismaService } from '../src/infra/prisma.service';
import { SCRAPE_WORKER_AUTOSTART, ScrapeWorkerHost } from '../src/processors/scrape-worker.host';
import { QueueRegistry } from '../src/queues/queue-registry';
import { SchedulerModule } from '../src/scheduler/scheduler.module';
import { SchedulerService } from '../src/scheduler/scheduler.service';
import { createAdmin, createContext, resetState, startDemo } from './helpers';

@Module({
  imports: [CollectionModule],
  providers: [ScrapeWorkerHost, { provide: SCRAPE_WORKER_AUTOSTART, useValue: false }],
  exports: [ScrapeWorkerHost],
})
class ProcessorTestModule {}

let ref: TestingModule;
let prisma: PrismaService;
let scheduler: SchedulerService;
let demo: Awaited<ReturnType<typeof startDemo>>;

beforeAll(async () => {
  ref = await createContext([CollectionModule, SchedulerModule, ProcessorTestModule]);
  prisma = ref.get(PrismaService);
  scheduler = ref.get(SchedulerService);
  demo = await startDemo({ size: 60 });
  ref.get(ScrapeWorkerHost).start();
});
afterAll(async () => {
  await ref.get(ScrapeWorkerHost).onModuleDestroy();
  await demo.close();
  await ref.close();
});
beforeEach(async () => {
  await resetState(ref);
});

async function cycle(at: Date): Promise<void> {
  expect(await scheduler.tick(at)).toBe(1);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pending = await prisma.collectionJob.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } });
    if (pending === 0) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('scrape cycle timed out');
}

describe('collection pipeline (scheduler → queue → worker → DB → analyze queue)', () => {
  it('follows the demo market through new, price drop, removal, relist and block', async () => {
    await createAdmin(ref);
    const source = await seedDemoSource(prisma, demo.baseUrl);
    await prisma.dataSource.update({ where: { id: source.id }, data: { minRequestGapMs: 0, intervalSec: 60 } });
    const t0 = new Date();
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    const byExt = (externalId: string) =>
      prisma.listing.findUniqueOrThrow({ where: { sourceId_externalId: { sourceId: source.id, externalId } }, include: { priceHistory: true } });
    const analyze = ref.get(QueueRegistry).analyze;

    // 1) İlk tarama: 60 ilan, her biri için NEW analiz işi
    await cycle(at(0));
    expect(await prisma.listing.count({ where: { status: 'ACTIVE' } })).toBe(60);
    expect(await analyze.count()).toBe(60);

    // 2) Fiyat düşüşü + kaldırma + fırsat ilanı
    const [drop, gone] = demo.site.store.active();
    demo.site.store.patch(drop.id, { price: drop.price - 100_000 });
    demo.site.store.patch(gone.id, { status: 'REMOVED' });
    const deal = demo.site.store.inject({ make: 'BMW', model: '3 Serisi', trim: '320i', year: 2021, km: 40_000, discount: 0.25 });
    await cycle(at(1));
    const dropped = await byExt(drop.id);
    expect(dropped.priceHistory.map((h) => Number(h.price))).toEqual([drop.price + 100_000, drop.price]);
    expect((await analyze.getJob(analyzeJobId(dropped.id, 'PRICE_CHANGE', dropped.contentHash)))?.data.previousPrice).toBe(String(drop.price + 100_000));
    expect((await byExt(gone.id)).status).toBe('REMOVED');
    const dealRow = await byExt(deal.id);
    expect(dealRow).toMatchObject({ make: 'BMW', model: '3 Serisi', trim: '320i', year: 2021, km: 40_000 });
    expect(await analyze.getJob(analyzeJobId(dealRow.id, 'NEW', dealRow.contentHash))).toBeTruthy();

    // 3) Geri gelen ilan
    demo.site.store.patch(gone.id, { status: 'ACTIVE' });
    await cycle(at(2));
    const back = await byExt(gone.id);
    expect(back.status).toBe('ACTIVE');
    expect(back.relistedAt).not.toBeNull();

    // 4) Kaynak engeller → duraklatılır, admin uyarılır, artık iş üretilmez
    demo.site.setMode('captcha');
    await cycle(at(3));
    expect((await prisma.dataSource.findUniqueOrThrow({ where: { id: source.id } })).health).toBe('PAUSED');
    expect(await prisma.notification.count({ where: { kind: 'SYSTEM_ALERT' } })).toBe(1);
    expect(await scheduler.tick(at(10))).toBe(0);
    expect(await prisma.listing.count({ where: { status: 'ACTIVE' } })).toBe(61);
    demo.site.setMode('normal');
  });
});
```

- [ ] **Step 2: Testi çalıştır**

Run: `pnpm build:packages && pnpm --filter @oto/worker test:e2e`
Expected: PASS. Bir adım başarısız olursa önceki task'lardaki ilgili birimi düzelt (bu test yeni üretim kodu gerektirmez).

- [ ] **Step 3: Geliştirici komutları ve env**

Kök `package.json` `scripts`'e ekle:
```json
"dev:demo": "pnpm --filter @oto/demo-site dev",
"dev:worker": "pnpm --filter @oto/worker dev",
"dev:scheduler": "pnpm --filter @oto/worker dev:scheduler",
```

`.env.example` sonuna ekle:
```dotenv

# --- Toplama hattı (apps/worker) ---
# Bot User-Agent'ında yayınlanan iletişim adresi: "OtoFirsatBot/1.0 (+<adres>)"
BOT_CONTACT_URL=http://localhost:3000/bot
SCHEDULER_TICK_MS=15000
SCRAPE_CONCURRENCY=2

# --- Demo ilan sitesi (yalnızca geliştirme) ---
DEMO_PORT=4000
DEMO_SEED=42
DEMO_SIZE=2000
DEMO_TICK_MS=60000
# `pnpm db:seed` demo kaynağı da kaydetsin:
SEED_DEMO_SOURCE=true
DEMO_SITE_URL=http://localhost:4000
```

- [ ] **Step 4: Dokümantasyon**

`docs/adding-a-source.md`:
```markdown
# Yeni veri kaynağı ekleme

## 1. Önce izin (zorunlu)
Kod yazmadan önce aşağıdakilerin **hepsi** yazılı olarak doğrulanmalıdır:

- [ ] Kaynağın kullanım koşulları otomatik erişime izin veriyor **veya** yazılı lisans/partner anlaşması var.
- [ ] İzin verilen istek sıklığı ve erişim yöntemi (API, feed, HTML) belli.
- [ ] Verinin platformda gösterilmesine/ticari kullanımına izin var.
- [ ] Kaynağın engelleme veya bot doğrulaması (captcha) kullanıp kullanmadığı biliniyor. Kullanıyorsa ve izin yoksa **kaynak eklenmez**.

İzin belgesinin özeti `DataSource.permissionNote`'a, doğrulama tarihi `permissionVerifiedAt`'a yazılır. Bu alan boşken kaynak aktif edilemez (DB kısıtı).

**Yasak olanlar:** stealth eklentileri, tarayıcı parmak izi gizleme, captcha çözme servisleri, sahte User-Agent, engellendikçe IP/proxy değiştirme. Sistem 403/captcha/robots engelinde kaynağı otomatik **PAUSED** yapar ve yeniden denemez.

## 2. Adapter
1. `packages/collection/src/adapters/<kaynak>.adapter.ts` oluştur ve `SourceAdapter`'ı uygula:
   - `listPages(ctx)`: sayfaları sırayla `ctx.http.getText(url)` ile çek; her sayfa için `{ url, pageNo, html, isLast }` üret. Ağ erişimi **yalnızca** `ctx.http` üzerinden (robots, hız limiti, yeniden deneme orada).
   - `parseList(page)`: her ilanı `RawListing`'e çevir; zorunlu alanı eksik kartı `problems`'a ekle (atla, uydurma).
   - `isBlockedPage(html)` (opsiyonel): kaynağa özgü engel sayfası işareti.
   - Config'i kendi zod şemanla doğrula (`baseUrl`, `maxPages` vb.).
2. `packages/collection/src/registry.ts`'deki `FACTORIES`'e bir satır ekle.
3. Kaynağın HTML örneklerinden fixture'lı test yaz (`demo-site.adapter.spec.ts` örneği).
4. Yeni marka/model yazımları için `MakeModelAlias` kayıtları ekle.

## 3. Kayıt
`DataSource` satırı: `adapterKey`, `kind`, `permissionType`, `permissionNote`, `permissionVerifiedAt`, `intervalSec`, `minRequestGapMs` (kaynağın izin verdiği sıklığa göre), `config`. Admin paneli Plan 07'de gelir; o zamana kadar seed veya SQL ile.

## 4. İzleme
- `CollectionJob`: her taramanın sayaçları ve durumu.
- `ScrapeError`: ağ/engel hataları. `ListingIssue`: ayrıştırılamayan/doğrulanamayan ilanlar.
- `SystemLog` + admin panel bildirimi: engellenme, ardışık hata, %20 üzeri ayrıştırma hatası.
- Duraklatılmış kaynağı yeniden açmak (Plan 07'ye kadar): `UPDATE "DataSource" SET health='HEALTHY', "consecutiveFailures"=0 WHERE code='<kod>';` — önce engelin nedenini ve izni kontrol edin.
```

`docs/architecture.md` sonuna ekle:
```markdown
## Toplama hattı (Plan 02)
- **Paketler:** `@oto/collection` (framework'süz: normalizer, `PoliteHttpClient`, adapter'lar), `apps/demo-site` (geliştirme/test için sahte ilan sitesi), `apps/worker` (NestJS app context).
- **Süreçler:** `ROLE=scheduler` (tek instance) her `SCHEDULER_TICK_MS`'de zamanı gelen kaynak için `CollectionJob(QUEUED)` + `scrape` kuyruğu işi üretir, 30 dk'dan eski işleri kapatır, günlük 30 gün saklama temizliği yapar. `ROLE=worker` `scrape` işlerini `SCRAPE_CONCURRENCY` paralellikle yürütür; yatay ölçeklenir.
- **Tarama:** adapter sayfaları `PoliteHttpClient` ile çeker (robots, Redis'te paylaşılan hız limiti, 3 deneme, Retry-After, engel tespiti) → `normalizeListing` → `IngestService` (mükerrersiz upsert, fiyat/km geçmişi, REMOVED/RELISTED) → değişen ilanlar için `analyze` kuyruğu (tüketicisi Plan 03).
- **Güvenlik ağı:** tam ve sağlıklı (hata ≤ %20) taramalar dışında hiçbir ilan REMOVED yapılmaz; engellenen kaynak PAUSED olur ve yeniden denenmez.
- **Sağlık:** 3 ardışık hata DEGRADED, 6 DOWN; alarmlar `SystemLog` + adminlere panel bildirimi (anahtar başına 30 dk susturma). Worker'lar `worker:heartbeat:*` Redis anahtarlarıyla canlılık bildirir.
```

`README.md`'ye "Testler" bölümünden önce ekle:
```markdown
## Toplama hattını çalıştırma (geliştirme)
```bash
pnpm db:up && pnpm build:packages && pnpm db:migrate
pnpm db:seed                   # SEED_DEMO_SOURCE=true ise demo kaynağı da kaydeder
pnpm dev:demo                  # http://localhost:4000/ilanlar — sahte ilan sitesi
pnpm dev:scheduler             # zamanı gelen kaynak için tarama işi üretir
pnpm dev:worker                # tarama işlerini yürütür
```
Demo sitesinin kontrol uç noktaları: `POST /__tick` (piyasayı ilerlet), `POST /__inject` (ilan ekle, ör. `{"discount":0.25}`), `POST /__patch/:id`, `POST /__mode` (`normal|broken|captcha|forbidden`), `POST /__reset`.
```

`docs/superpowers/plans/2026-10-10-00-roadmap.md` → "Plan 01 sonrası taşınan maddeler" bölümünün altına ekle:
```markdown

## Plan 02 sonrası taşınan maddeler
- **Plan 03:** `analyze` kuyruğunun tüketicisi (Plan 02 yalnızca üretir; işler kuyrukta bekler).
- **Plan 04:** Yeni externalId ile yeniden yayın sezgisi (aynı kaynak + başlık + km + yıl, 7 gün).
- **Plan 07:** Kaynak/iş/proxy admin uç noktaları ve manuel (dry-run) test taraması; proxy sağlık kontrolü; worker heartbeat ekranı; PAUSED kaynağı yeniden açma.
- **İlk BROWSER/detay gerektiren kaynakla:** Playwright `BrowserPool`, `fetchDetail`, ETag/If-Modified-Since, `maxConcurrency` ile paralel detay çekimi.
```

- [ ] **Step 5: Canlı smoke test**

```bash
pnpm db:up && pnpm build:packages && pnpm db:migrate && pnpm db:seed
DEMO_SIZE=200 DEMO_TICK_MS=0 node apps/demo-site/dist/main.js &
pnpm --filter @oto/worker build
SCHEDULER_TICK_MS=2000 node apps/worker/dist/main.js --role=scheduler &
node apps/worker/dist/main.js &
```
~30 sn bekle, sonra kontrol et (Prisma Studio veya psql, `postgresql://oto:oto@localhost:5433/oto`):
- `SELECT status, "listingsNew" FROM "CollectionJob" ORDER BY id DESC LIMIT 1;` → `SUCCEEDED`, 200
- `SELECT count(*) FROM "Listing";` → 200
Süreçleri durdur. Sonucu raporla.

- [ ] **Step 6: Tüm doğrulama**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`
Expected: Hepsi PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test(worker): add end-to-end collection pipeline test; document sources and dev workflow"
```

---

## Plan Sonu Kontrol Listesi (Spec karşılığı)

| Spec maddesi | Task |
|---|---|
| §1 Ayrı süreçler (worker ×N, scheduler tek), kuyruk tabanlı, idempotent aşamalar | 6, 7, 9 |
| §1 Kaynak izolasyonu (kaynak bazlı hız limiti; bir kaynağın hatası diğerini etkilemez) | 3, 8 |
| §1 Worker heartbeat | 6 |
| §2 DataSource izin kuralı, CollectionJob/ScrapeError/ListingIssue/ListingPriceHistory | 2 (Plan 01), 7, 8 |
| §3 Adapter sözleşmesi + registry; yeni kaynak mevcut kodu bozmaz | 5 |
| §3 PoliteHttpClient: robots, token-bucket, dürüst UA, zaman aşımları, sabit proxy | 3, 8 |
| §3 Hata sınıflandırması, BLOCKED → PAUSED, parse oranı > %20 alarmı, sağlık geçişleri | 3, 8 |
| §3 Normalizer (eşleme tablosu, metin ayrıştırma, aralık doğrulama, contentHash) | 2, 5 |
| §3 Demo site (sayfalama, simülatör, fırsat ilanları, bozuk mod) | 4 |
| §1 İlan kaybolma tespiti, yeniden yayın | 7, 8 |
| §6 SystemLog/ScrapeError 30 gün saklama | 9 |
| §9 Alarmlar (SystemLog + admin panel bildirimi, 30 dk susturma) | 6, 8 |
| §11 Geliştirici komutları, `.env.example`, `docs/adding-a-source.md` | 10 |

**Bu planın kapsamı dışında:** `analyze` tüketicisi (03), eşleştirme/bildirim (04–05), web (06), kaynak/iş admin uç noktaları ve manuel tarama (07), prod compose (08), Playwright/fetchDetail/ETag (ilk ihtiyaç duyan kaynakla).
