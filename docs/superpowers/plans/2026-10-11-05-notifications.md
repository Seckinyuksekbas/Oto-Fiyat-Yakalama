# Plan 05 — Bildirimler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Her yeni `ListingMatch` için kaybolmayan, limitli ve yeniden denenen bildirimler üretmek; bunları uygulama içinde (kayıt + canlı SSE) ve Telegram'da (bağlama akışı, şablonlu mesaj, inline butonlar) teslim etmek; kullanıcıya `/me/notifications` ve `/me/channels` uç noktalarını sunmak.

**Architecture:** `Notification(PENDING)` satırları eşleşmeyle AYNI transaction'da `NotificationPlanner` tarafından yazılır (kanallar = profil kanalları ∩ geçerli plan kanalları ∩ doğrulanmış/etkin kanallar; günlük harici bildirim limiti kullanıcı başına advisory kilit altında DB sayımıyla verilir). Commit sonrası `NotificationDispatcher` her bildirimi kanalına göre `notify` (IN_APP) veya `notify-telegram` kuyruğuna `jobId = notify-<id>` ile ekler; kuyruğa giremeyenleri scheduler süpürmesi yeniden ekler. `NotifyWorkerHost` gönderimi kanal adapter'larına (`InAppAdapter`: Redis pub/sub `user:<id>`; `TelegramAdapter`: Bot API) yaptırır, sonucu `SENT | RETRYABLE | PERMANENT` olarak sınıflar. API, Redis aboneliğini SSE akışına çevirir; Telegram güncellemelerini (webhook veya polling) `TelegramUpdateHandler` ile işler (bağlama kodu, "Favorile" butonu, bot engelleme). Telegram istemcisi, mesaj şablonu, hata sınıflandırması ve test için sahte Bot API yeni `@oto/telegram` paketindedir.

**Tech Stack:** TypeScript, zod, NestJS 11 (api: Express 5 + `@Sse`; worker: app context), Prisma 6, BullMQ 5 (özel backoff, limiter, `DelayedError`), ioredis pub/sub, Node 22 `fetch`, Vitest + Testcontainers + Supertest.

**Spec:** `docs/superpowers/specs/2026-10-10-oto-firsat-platformu-design.md` §2 (Bildirim kanalları, Notification), §5.3–5.7, §6 (Gizli veriler, doğrulanmamış hesap Telegram bağlayamaz), §7 (`/me/notifications`, `/me/channels`). Yol haritası: `docs/superpowers/plans/2026-10-10-00-roadmap.md` ("Plan 04 sonrası taşınan maddeler" → Plan 05). Eşleştirme: `docs/matching.md`.

## Bu planın kararları (spec'i netleştiren)

| Konu | Karar | Gerekçe |
|---|---|---|
| Bildirim kaydı ne zaman | `ListingMatch` ile aynı transaction'da, `NotificationPlanner.plan(tx, …)`; `INSERT … ON CONFLICT ("matchId","channel") DO NOTHING` | Worker commit sonrası çökerse bildirim kaybolmaz (Plan 04 notu) |
| Kuyruk | İki kuyruk: `notify` (IN_APP) ve `notify-telegram` (limiter 25/sn). `jobId = notify-<notificationId>`; `Notification.queuedAt` kuyruğa ekleme anını tutar; scheduler 60 sn'den eski `PENDING AND queuedAt IS NULL` satırları yeniden ekler | Telegram hız limiti IN_APP'i yavaşlatmaz; kayıp `notify` işi telafi edilir |
| Kanal seçimi | `kanallar = ({IN_APP} ∪ profil.channels) ∩ ({IN_APP} ∪ plan.channels) ∩ ({IN_APP} ∪ doğrulanmış+etkin kanallar)`; EMAIL hiçbir zaman | Spec §2, §5.4; plan düşürülünce kayıtlı TELEGRAM kanalı gönderilmez (Plan 04 final inceleme) |
| Günlük limit | Harici (IN_APP dışı) `MATCH` bildirimleri; sayım = bugün (İstanbul) oluşturulan, `SKIPPED_LIMIT` olmayan harici bildirimler. Karar transaction içinde, kullanıcı id'leri SIRALI alınan `pg_advisory_xact_lock(4243, hashtext(userId))` altında. Aşılırsa harici satır `SKIPPED_LIMIT`, IN_APP satırı `PENDING` + `payload.limitExceeded = true` | Spec §5.3; Redis `INCR` commit öncesi yapılmaz (Plan 04 notu); sıralı kilit kilitlenmeyi (deadlock) önler; `/me` kullanım sayacıyla aynı tanım |
| Gönderim anında yeniden kontrol | TELEGRAM: kullanıcı ACTIVE, kanal doğrulanmış+etkin, geçerli plan TELEGRAM içeriyor; değilse `FAILED` (`CHANNEL_UNAVAILABLE`), yeniden deneme yok. IN_APP: kullanıcı ACTIVE | Planlama ile gönderim arasında durum değişebilir |
| Yeniden deneme | 5 deneme; denemeler arası bekleme 10 sn → 30 sn → 2 dk → 10 dk (spec dizisinin ilk dördü; 5. denemeden sonra `FAILED`). 429'da bekleme = max(`retry_after`, takvim) | Spec §5.6 "5 deneme" |
| Sohbet başına 1 msj/sn | Redis `SET tg:chat:<hash> 1 PX 1100 NX`; alınamazsa iş `moveToDelayed(+1100ms)` + `DelayedError` (deneme hakkı yemez) | Spec §5.4; BullMQ grup limiti Pro'dadır |
| Kalıcı Telegram hataları | 403 (bot engellendi/kullanıcı devre dışı) ve 400 "chat not found" → `FAILED` + kanal `isEnabled=false` + kullanıcıya IN_APP `SECURITY` bildirimi (`TELEGRAM_DISABLED`). Diğer 400 → `FAILED`. 401 (geçersiz token) → `FAILED` + error log | Spec §5.4 |
| Fotoğraf | `imageUrl` varsa `sendPhoto` (caption); 400 ve açıklama "wrong file"/"failed to get HTTP URL content"/"wrong type" içerirse bir kez `sendMessage`'a düşülür | Bozuk görsel bildirimi engellemesin |
| URL butonları | "İlana git" (`listing.url`) ve "Analizi gör" (`PUBLIC_BASE_URL/ilan/<id>`) yalnızca URL http(s) ve host localhost/127.0.0.1/::1 değilse eklenir; "Favorile" her zaman (callback `fav:<listingId>`) | Telegram yerel URL'leri reddeder |
| Mesaj başlığı | `NEW`: indirim > 0 ve güven ≠ INSUFFICIENT ise "🔥 Fırsat", değilse "🆕 Yeni ilan"; `PRICE_DROP`: "📉 Fiyat düştü: <önceki> → <yeni> TL"; `RELIST`: "🔁 Yeniden yayında". Hepsine " · Skor N · Güven: X" eklenir | Spec §5.5; indirim yokken "Fırsat" demek yanıltıcı |
| chatId arama | `NotificationChannel.config` = şifreli `{ chatId }`; ek sütun `externalIdHash = sha256(chatId)` (indeksli) callback/engelleme aramaları için | Spec §2 şifreleme; şifreli alanla arama yapılamaz |
| Bağlama | Kod: `generateToken(16)` (base64url, ≤64 karakter), hash'i saklanır, 10 dk, tek kullanımlık; yeni kod üretmek eskileri geçersiz kılar. Önkoşullar: e-posta doğrulanmış (yoksa 403 `EMAIL_NOT_VERIFIED`), Telegram yapılandırılmış (yoksa 503 `FEATURE_DISABLED`), plan TELEGRAM içeriyor (yoksa 403 `LIMIT_REACHED`) | Spec §5.7, §6 |
| Bağlama onayı | Bot "✅ Hesabınız bağlandı" yanıtı + panelde IN_APP `SECURITY` bildirimi (`TELEGRAM_LINKED`) + SSE | Spec §5.7 "Telegram'da ve panelde onay" |
| Güncelleme alma | `TELEGRAM_MODE=webhook`: `POST /api/v1/telegram/webhook`, `X-Telegram-Bot-Api-Secret-Token` sabit-zamanlı karşılaştırma; `polling`: API içinde `getUpdates` döngüsü (yalnızca token varsa; testte kapalı) | Spec §5.7 |
| Telegram kapalıyken | `TELEGRAM_BOT_TOKEN` yoksa bağlama 503; TELEGRAM bildirimi planlanmaz (doğrulanmış kanal olamaz) | Dev ortamı token'sız çalışır |
| SSE | `GET /me/notifications/stream` (`@Sse`): ilk olay `ready {unreadCount}`, sonra `notification` olayları, 25 sn'de bir `ping`; akış 15 dk sonra kapanır (istemci yeniden bağlanır; erişim token'ı süresiyle uyumlu) | Spec §5.4 |
| Okunmamış | `unreadCount` = IN_APP ve `readAt IS NULL`; `POST /me/notifications/read` yalnızca kullanıcının IN_APP bildirimlerini işaretler | Zil sayacı uygulama içi bildirimleri sayar |
| `latencyMs` | `sentAt − listing.firstSeenAt` (payload'daki ISO tarih), tüm kanallarda | Spec §5.6 |
| Teslim garantisi | En az bir kez: gönderim başarılı olup DB güncellemesi başarısız olursa yeniden gönderilebilir | Belgelenir |

## Global Constraints

- Plan 01–04 Global Constraints maddeleri geçerlidir.
- Para JSON'da rakam dizgisi; tarihler ISO-8601 UTC; Telegram mesajında tarihler Europe/Istanbul, sayılar `tr-TR` biçiminde (960.000).
- Şifreli alanlar AES-256-GCM `v1:iv:tag:ct` (`Encryptor`); API yanıtları kanal `config`'ini, chatId'yi veya bot token'ını asla döndürmez; hata mesajları ve loglar bot token'ı içermez (istemci URL'yi hata mesajına koymaz).
- `/me/**` veri erişimi yalnızca `*.repository.ts`; her yeni `/me` route'u izolasyon matrisine (`apps/api/test/isolation.e2e.spec.ts`) eklenir.
- Spec §5.5 mesaj şablonu ve "Fiyat analizi tahminidir; aracın durumunu garanti etmez." uyarısı her Telegram eşleşme mesajında bulunur.
- Spec §5.4 limitleri: Telegram global 25 msj/sn, sohbet başına 1 msj/sn.
- BullMQ job id'leri `:` içermez; bozuk payload `UnrecoverableError`.
- Kaynak etiği: hiçbir değişiklik scraping kısıtlarını aşma davranışı eklemez.

## Review Focus

1. **Telegram 429 / ağ hatası / 5xx:** Bildirim kaybolmaz; yeniden denenir, 5. denemeden sonra `FAILED` + `lastError`. → Task 5 testi.
2. **Kullanıcı botu engeller (403):** Kanal kapanır, kullanıcı panelde uyarı görür, bekleyen diğer Telegram bildirimleri `FAILED (CHANNEL_UNAVAILABLE)` olur, yeniden denenmez. → Task 5 testi.
3. **Aynı kullanıcıya eşzamanlı eşleşme patlaması limit sınırında:** Tam `maxNotificationsPerDay` kadar harici bildirim `PENDING`, fazlası `SKIPPED_LIMIT`; IN_APP satırları yine oluşur ve `limitExceeded` taşır. → Task 4 testi.
4. **Bağlama kodu kötüye kullanımı (süresi geçmiş, kullanılmış, doğrulanmamış hesap, yanlış biçim):** Bağlanmaz, bot açıklayıcı yanıt verir. → Task 7 testi.
5. **SSE izolasyonu:** B'nin akışı A'nın olaylarını asla almaz; akış 15 dk sonra kapanır. → Task 6 testi.

## Dosya Haritası

```
packages/shared/src/        notifications.ts (+ spec), queues.ts (NOTIFY*, notifyJobSchema), errors.ts, schemas/channels.ts, index.ts
packages/db/                prisma/schema.prisma, migrations/20261014000000_notifications_delivery/, src/limits.ts, src/matching.ts (channels), test/limits.spec.ts
packages/telegram/          (yeni) src/{index,client,classify,render,format,fake-bot-api}.ts + spec'ler
apps/worker/src/notifications/  {notifications.module,notification-planner,payload,notification-dispatcher,notify.service,in-app.adapter,telegram.adapter,backoff}.ts
apps/worker/src/matching/match.service.ts (planner kancası + commit sonrası dispatch)
apps/worker/src/processors/notify-worker.host.ts
apps/worker/src/scheduler/{notification-sweep.service,scheduler-loop.service,scheduler.module}.ts
apps/worker/src/{config/env.ts, worker-app.module.ts, queues/queue-registry.ts}
apps/api/src/infra/user-events.service.ts
apps/api/src/modules/me/{notifications.repository,notifications.controller,channels.repository,channels.service,channels.controller,limits.service}.ts
apps/api/src/modules/telegram/{telegram.module,telegram.config,telegram-update.handler,telegram-webhook.controller,telegram-polling.service}.ts
apps/api/src/config/env.ts, app.module.ts, modules/auth/auth.service.ts (SECURITY bildirimi yayını)
apps/api/test/  notifications.e2e.spec.ts, channels.e2e.spec.ts, telegram.e2e.spec.ts, isolation.e2e.spec.ts, helpers.ts
apps/worker/test/ notification-planner.e2e.spec.ts, notify.e2e.spec.ts, notification-sweep.e2e.spec.ts, pipeline.e2e.spec.ts
docs/notifications.md (yeni), architecture.md, README.md, .env.example, superpowers/plans/2026-10-10-00-roadmap.md
```

---

### Task 1: Paylaşılan sözleşmeler (bildirim payload'ı, kuyruklar, olaylar, API şemaları)

**Files:**
- Create: `packages/shared/src/notifications.ts`, `packages/shared/src/notifications.spec.ts`, `packages/shared/src/schemas/channels.ts`
- Modify: `packages/shared/src/queues.ts`, `packages/shared/src/queues.spec.ts`, `packages/shared/src/errors.ts`, `packages/shared/src/index.ts`

**Interfaces:**
- Produces:
  - `QueueName.NOTIFY = 'notify'`, `QueueName.NOTIFY_TELEGRAM = 'notify-telegram'`; `notifyJobSchema = z.object({ notificationId: z.number().int().positive() })`, `NotifyJobData`; `notifyJobId(id: number): string` → `notify-<id>`.
  - `matchNotificationPayloadSchema` / `MatchNotificationPayload`:
    `{ type: 'MATCH'; reason: 'NEW'|'PRICE_DROP'|'RELIST'; profile: { id; name }; listing: { id: number; title; make; model; trim: string|null; year; km; fuel; transmission; city: string|null; price: string; imageUrl: string|null; url; firstSeenAt: string }; analysis: { opportunityScore: number; confidence; estimatedPrice: string|null; priceDiff: string|null; discountPct: number|null; comparableCount: number }; previousPrice: string|null; limitExceeded: boolean }`
  - `securityNotificationPayloadSchema` / `SecurityNotificationPayload`: `{ type: 'TELEGRAM_LINKED' | 'TELEGRAM_DISABLED' | 'REFRESH_REUSED'; reason?: string; familyId?: string }`
  - `userEventChannel(userId: string): string` → `user:<userId>`; `userEventSchema` / `UserEvent`: `{ type: 'notification'; notification: { id: number; kind: 'MATCH'|'SECURITY'|'SYSTEM_ALERT'; channel: 'IN_APP'; status: string; payload: unknown; createdAt: string } }`
  - `listNotificationsQuerySchema` (`status?`, `channel?`, `unread?: 'true'|'false'` → boolean, `cursor?` 1..2147483647, `limit` 1..100 varsayılan 20, strict), `markNotificationsReadSchema` (`{ ids: number[] (1..100, positive int) } | { all: true }`, strict), `patchChannelSchema` (`{ isEnabled: boolean }` strict), `channelTypeParamSchema = z.enum(['IN_APP','TELEGRAM'])`.
  - `ErrorCode.EMAIL_NOT_VERIFIED`, `ErrorCode.FEATURE_DISABLED`.

- [ ] **Step 1: Başarısız testleri yaz**

`packages/shared/src/notifications.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  listNotificationsQuerySchema,
  markNotificationsReadSchema,
  matchNotificationPayloadSchema,
  notifyJobId,
  notifyJobSchema,
  patchChannelSchema,
  userEventChannel,
  userEventSchema,
} from './index';

const payload = {
  type: 'MATCH', reason: 'NEW', profile: { id: 'p1', name: 'BMW' },
  listing: { id: 1, title: 'Temiz 320i', make: 'BMW', model: '3 Serisi', trim: '320i', year: 2019, km: 85000, fuel: 'GASOLINE',
    transmission: 'AUTOMATIC', city: 'İstanbul', price: '960000', imageUrl: null, url: 'https://ornek.com/ilan/1', firstSeenAt: '2026-10-10T11:32:00.000Z' },
  analysis: { opportunityScore: 77, confidence: 'HIGH', estimatedPrice: '1200000', priceDiff: '240000', discountPct: 0.2, comparableCount: 14 },
  previousPrice: null, limitExceeded: false,
};

describe('notification contracts', () => {
  it('match payload round-trips and rejects numeric money', () => {
    expect(matchNotificationPayloadSchema.parse(payload)).toEqual(payload);
    expect(matchNotificationPayloadSchema.safeParse({ ...payload, listing: { ...payload.listing, price: 960000 } }).success).toBe(false);
  });
  it('notify job id and schema', () => {
    expect(notifyJobId(42)).toBe('notify-42');
    expect(notifyJobSchema.safeParse({ notificationId: 0 }).success).toBe(false);
  });
  it('user event channel and schema', () => {
    expect(userEventChannel('abc')).toBe('user:abc');
    expect(userEventSchema.safeParse({ type: 'notification', notification: { id: 1, kind: 'MATCH', channel: 'IN_APP', status: 'SENT', payload, createdAt: '2026-10-10T11:32:00.000Z' } }).success).toBe(true);
  });
  it('list query coerces unread and bounds cursor/limit', () => {
    expect(listNotificationsQuerySchema.parse({ unread: 'true', limit: '5' })).toMatchObject({ unread: true, limit: 5 });
    expect(listNotificationsQuerySchema.safeParse({ cursor: '3000000000' }).success).toBe(false);
    expect(listNotificationsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listNotificationsQuerySchema.safeParse({ foo: '1' }).success).toBe(false);
  });
  it('mark read accepts ids or all', () => {
    expect(markNotificationsReadSchema.safeParse({ ids: [1, 2] }).success).toBe(true);
    expect(markNotificationsReadSchema.safeParse({ all: true }).success).toBe(true);
    expect(markNotificationsReadSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(markNotificationsReadSchema.safeParse({ all: false }).success).toBe(false);
    expect(markNotificationsReadSchema.safeParse({}).success).toBe(false);
  });
  it('patch channel is strict', () => {
    expect(patchChannelSchema.safeParse({ isEnabled: true }).success).toBe(true);
    expect(patchChannelSchema.safeParse({ isEnabled: true, config: 'x' }).success).toBe(false);
  });
});
```

`queues.spec.ts` → `QueueName.NOTIFY`/`NOTIFY_TELEGRAM` değerlerinin `:` içermediğini mevcut "no colon" testine dahil et (test tüm `QueueName` değerlerini dolaşıyorsa ek gerekmez; dolaşmıyorsa ekle).

Run: `pnpm --filter @oto/shared test` → FAIL.

- [ ] **Step 2: Uygula**

`errors.ts` → `LIMIT_REACHED`'ın altına `EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED', FEATURE_DISABLED: 'FEATURE_DISABLED',`.

`queues.ts` → `QueueName`'e `NOTIFY: 'notify', NOTIFY_TELEGRAM: 'notify-telegram',`; dosya sonuna:

```ts
export const notifyJobSchema = z.object({ notificationId: z.number().int().positive() });
export type NotifyJobData = z.infer<typeof notifyJobSchema>;
export function notifyJobId(notificationId: number): string {
  return `notify-${notificationId}`;
}
```

`notifications.ts`:

```ts
import { z } from 'zod';

const money = z.string().regex(/^-?\d+$/);
const iso = z.string().datetime();

export const matchNotificationPayloadSchema = z.object({
  type: z.literal('MATCH'),
  reason: z.enum(['NEW', 'PRICE_DROP', 'RELIST']),
  profile: z.object({ id: z.string(), name: z.string() }),
  listing: z.object({
    id: z.number().int(), title: z.string(), make: z.string(), model: z.string(), trim: z.string().nullable(),
    year: z.number().int(), km: z.number().int(), fuel: z.string(), transmission: z.string(), city: z.string().nullable(),
    price: money, imageUrl: z.string().nullable(), url: z.string(), firstSeenAt: iso,
  }),
  analysis: z.object({
    opportunityScore: z.number().int(), confidence: z.enum(['INSUFFICIENT', 'LOW', 'MEDIUM', 'HIGH']),
    estimatedPrice: money.nullable(), priceDiff: money.nullable(), discountPct: z.number().nullable(), comparableCount: z.number().int(),
  }),
  previousPrice: money.nullable(),
  limitExceeded: z.boolean(),
});
export type MatchNotificationPayload = z.infer<typeof matchNotificationPayloadSchema>;

export const securityNotificationPayloadSchema = z.object({
  type: z.enum(['TELEGRAM_LINKED', 'TELEGRAM_DISABLED', 'REFRESH_REUSED']),
  reason: z.string().optional(),
  familyId: z.string().optional(),
});
export type SecurityNotificationPayload = z.infer<typeof securityNotificationPayloadSchema>;

/** Redis pub/sub kanalı: API SSE akışı buna abone olur. */
export function userEventChannel(userId: string): string {
  return `user:${userId}`;
}

export const userEventSchema = z.object({
  type: z.literal('notification'),
  notification: z.object({
    id: z.number().int(),
    kind: z.enum(['MATCH', 'SECURITY', 'SYSTEM_ALERT']),
    channel: z.literal('IN_APP'),
    status: z.string(),
    payload: z.unknown(),
    createdAt: iso,
  }),
});
export type UserEvent = z.infer<typeof userEventSchema>;
```

`schemas/channels.ts`:

```ts
import { z } from 'zod';

export const listNotificationsQuerySchema = z
  .object({
    status: z.enum(['PENDING', 'SENT', 'FAILED', 'SKIPPED_LIMIT']).optional(),
    channel: z.enum(['IN_APP', 'TELEGRAM', 'EMAIL']).optional(),
    unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    cursor: z.coerce.number().int().positive().max(2_147_483_647).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const markNotificationsReadSchema = z.union([
  z.object({ ids: z.array(z.number().int().positive().max(2_147_483_647)).min(1).max(100) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema>;

export const patchChannelSchema = z.object({ isEnabled: z.boolean() }).strict();
export type PatchChannelInput = z.infer<typeof patchChannelSchema>;

export const channelTypeParamSchema = z.enum(['IN_APP', 'TELEGRAM']);
```

`index.ts` → `export * from './notifications'; export * from './schemas/channels';`

- [ ] **Step 3: Test + build**

Run: `pnpm --filter @oto/shared test && pnpm --filter @oto/shared build && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add notification payload, notify queues, user events and channel schemas"
```

---

### Task 2: DB — teslim sütunları, eşleşmede kanal, ortak limit çözümleme

**Files:**
- Create: `packages/db/prisma/migrations/20261014000000_notifications_delivery/migration.sql`, `packages/db/src/limits.ts`, `packages/db/test/limits.spec.ts`
- Modify: `packages/db/prisma/schema.prisma`, `packages/db/src/matching.ts`, `packages/db/src/index.ts`, `packages/db/test/matching.spec.ts`, `apps/api/src/modules/me/limits.service.ts`

**Interfaces:**
- Produces:
  - Prisma: `Notification.queuedAt DateTime?` + `@@index([status, queuedAt])`; `NotificationChannel.externalIdHash String?` + `@@index([type, externalIdHash])`.
  - `MatchingProfileRow.channels: string[]` (`sp."channels"::text[]`) ve `MatchingProfileRow.name: string` (`sp."name"`).
  - `type LimitsDb = Pick<Prisma.TransactionClient, 'userSubscription' | 'subscriptionPlan'>`
  - `interface ResolvedPlan { planCode: string; planName: string; status: 'ACTIVE' | 'FALLBACK' | string; endsAt: Date | null; limits: PlanLimits }`
  - `resolveUserPlan(db: LimitsDb, userId: string, now?: Date): Promise<ResolvedPlan>` — canlı (ACTIVE ve `endsAt` boş/gelecekte) en yeni abonelik; yoksa FREE planı `status: 'FALLBACK'`, `endsAt: null`; limitler `effectiveLimits(plan.limits, sub.limitOverrides)`.

- [ ] **Step 1: Başarısız testleri yaz**

`packages/db/test/limits.spec.ts` (matching.spec.ts ile aynı container desenini kullan):

```ts
import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveUserPlan } from '../src/limits';
import { seedPlans } from '../src/seed-data';

let pg: StartedPostgreSqlContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  const url = pg.getConnectionUri();
  execSync('pnpm exec prisma migrate deploy', { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
  prisma = new PrismaClient({ datasources: { db: { url } } });
});
afterAll(async () => {
  await prisma?.$disconnect();
  await pg?.stop();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "UserSubscription","User","SubscriptionPlan" RESTART IDENTITY CASCADE');
  await seedPlans(prisma);
});

async function user() {
  return prisma.user.create({ data: { email: `u${Math.random()}@t.com`, passwordHash: 'x', name: 'U' } });
}

describe('resolveUserPlan', () => {
  it('falls back to FREE when there is no subscription', async () => {
    const u = await user();
    const r = await resolveUserPlan(prisma, u.id);
    expect(r).toMatchObject({ planCode: 'FREE', status: 'FALLBACK', endsAt: null, limits: { maxSearchProfiles: 2, maxNotificationsPerDay: 20 } });
  });
  it('uses the live subscription with overrides, ignoring expired ones', async () => {
    const u = await user();
    const pro = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'PRO' } });
    await prisma.userSubscription.create({ data: { userId: u.id, planId: pro.id, endsAt: new Date(Date.now() - 1000) } });
    expect((await resolveUserPlan(prisma, u.id)).planCode).toBe('FREE');
    await prisma.userSubscription.create({ data: { userId: u.id, planId: pro.id, limitOverrides: { maxNotificationsPerDay: 7 } } });
    expect(await resolveUserPlan(prisma, u.id)).toMatchObject({ planCode: 'PRO', status: 'ACTIVE', limits: { maxNotificationsPerDay: 7, maxSearchProfiles: 10 } });
  });
});
```

`matching.spec.ts` → "excludes paused profiles and inactive users; returns lastMatchedPrice" testine: `expect(rows[0].channels).toEqual(['IN_APP']);`

Run: `pnpm --filter @oto/db test:e2e` → FAIL.

- [ ] **Step 2: Uygula**

`schema.prisma` → `Notification`'a `queuedAt DateTime?` ve `@@index([status, queuedAt])`; `NotificationChannel`'a `externalIdHash String?` ve `@@index([type, externalIdHash])`. Migration SQL'i `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <geçici db> --script` ile üret (Plan 04'teki geçici shadow DB yöntemi: `docker exec oto-scraper-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE oto_shadow_p5"'`, iş bitince DROP) ve `20261014000000_notifications_delivery/migration.sql` olarak kaydet; ardından aynı komutu `--exit-code` ile çalıştırıp fark olmadığını doğrula.

`matching.ts` → `findMatchingProfiles` SELECT listesine `sp."name", sp."channels"::text[] AS "channels",` ekle; `MatchingProfileRow`'a `name: string; channels: string[];`. `matching.spec.ts` testine `expect(rows[0].name).toBe('p')` de ekle.

`packages/db/src/limits.ts`:

```ts
import type { Prisma } from '@prisma/client';
import { effectiveLimits, planLimitsSchema, type PlanLimits } from '@oto/shared';

export type LimitsDb = Pick<Prisma.TransactionClient, 'userSubscription' | 'subscriptionPlan'>;

export interface ResolvedPlan {
  planCode: string;
  planName: string;
  /** Canlı abonelikte abonelik durumu; canlı abonelik yoksa 'FALLBACK' (FREE planı uygulanır) */
  status: string;
  endsAt: Date | null;
  limits: PlanLimits;
}

/** API ve worker için TEK limit çözümleme noktası. */
export async function resolveUserPlan(db: LimitsDb, userId: string, now = new Date()): Promise<ResolvedPlan> {
  const sub = await db.userSubscription.findFirst({
    where: { userId, status: 'ACTIVE', OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    include: { plan: true },
    orderBy: { startsAt: 'desc' },
  });
  if (sub) {
    return {
      planCode: sub.plan.code, planName: sub.plan.name, status: sub.status, endsAt: sub.endsAt,
      limits: effectiveLimits(planLimitsSchema.parse(sub.plan.limits), sub.limitOverrides ?? null),
    };
  }
  const free = await db.subscriptionPlan.findUnique({ where: { code: 'FREE' } });
  if (!free) throw new Error('FREE planı tanımlı değil (seedPlans çalıştırılmalı)');
  return { planCode: free.code, planName: free.name, status: 'FALLBACK', endsAt: null, limits: planLimitsSchema.parse(free.limits) };
}
```

`index.ts` → `export * from './limits';`

`apps/api/src/modules/me/limits.service.ts` → abonelik/plan çözümlemesini `resolveUserPlan(prisma-erişimi, userId, now)` ile değiştir. Lint kuralı gereği Prisma erişimi `me.repository.ts` üzerinden olmalı: `MeRepository`'ye `resolvePlan(userId: string, now: Date) { return resolveUserPlan(this.prisma, userId, now); }` ekle ve `LimitsService` onu çağırsın. Dönüş tipi ve `/me` davranışı değişmemeli (mevcut `limits.service`/`me` e2e testleri aynen geçmeli); artık kullanılmayan repository metotlarını (`findActiveSubscription`, `findPlanByCode`) başka yerde kullanılmıyorsa sil.

- [ ] **Step 3: Test**

Run: `pnpm --filter @oto/db test:e2e && pnpm --filter @oto/db build && pnpm --filter @oto/api exec vitest run -c vitest.e2e.config.ts test/search-profiles.e2e.spec.ts test/me.e2e.spec.ts && pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/db apps/api/src/modules/me
git commit -m "feat(db): add notification delivery columns, profile channels in matching and shared plan resolution"
```

---

### Task 3: `@oto/telegram` paketi (istemci, hata sınıflandırma, şablon, sahte Bot API)

**Files:**
- Create: `packages/telegram/package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `src/index.ts`, `src/client.ts`, `src/classify.ts`, `src/format.ts`, `src/render.ts`, `src/fake-bot-api.ts`, `src/client.spec.ts`, `src/classify.spec.ts`, `src/render.spec.ts`

**Interfaces:**
- Consumes: `MatchNotificationPayload` (`@oto/shared`).
- Produces:
  - `class TelegramApiError extends Error { status: number; errorCode: number; description: string; retryAfterSec: number | null; method: string }` (mesaj token içermez: `Telegram <method> başarısız (<status>): <description>`)
  - `class TelegramClient { constructor(opts: { token: string; apiBase?: string; timeoutMs?: number }); call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T>; sendMessage(chatId: number|string, text: string, replyMarkup?: InlineKeyboard): Promise<unknown>; sendPhoto(chatId, photo: string, caption: string, replyMarkup?): Promise<unknown>; answerCallbackQuery(id: string, text: string): Promise<unknown>; getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]> }`
  - `type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>> }`; `TelegramUpdate` (minimal: `update_id`, `message?: { chat: { id: number }; text?: string }`, `callback_query?: { id: string; data?: string; message?: { chat: { id: number } } }`, `my_chat_member?: { chat: { id: number }; new_chat_member: { status: string } }`).
  - `classifyTelegramError(err: unknown): { kind: 'RETRYABLE'; retryAfterMs?: number; error: string } | { kind: 'PERMANENT'; disableChannel: boolean; error: string }`
  - `isPhotoFallbackError(err: unknown): boolean`
  - `renderMatchMessage(p: MatchNotificationPayload, opts: { publicBaseUrl: string }): { text: string; photoUrl: string | null; replyMarkup: InlineKeyboard }`
  - `formatTl(v: string | bigint): string` ("960.000"), `formatIstanbulDateTime(iso: string): string` ("10.10.2026 14:32"), `escapeHtml(s: string): string`, `isPublicHttpUrl(u: string): boolean`
  - `class FakeTelegramApi { start(): Promise<{ apiBase: string; token: string }>; requests: Array<{ method: string; body: any }>; respondNext(method: string, r: { status: number; body: unknown }): void; queueUpdates(u: TelegramUpdate[]): void; close(): Promise<void> }` — varsayılan yanıt `{ ok: true, result: { message_id: <n> } }`; `getUpdates` sıradaki güncellemeleri bir kez döndürür, yoksa `[]`.

- [ ] **Step 1: Paket iskeleti**

`packages/telegram/package.json` (`packages/analysis` ile aynı desen):

```json
{
  "name": "@oto/telegram",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": { "@oto/shared": "workspace:*" },
  "devDependencies": { "vitest": "^3.0.5" }
}
```

`tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts` → `packages/analysis`'tekilerin aynısı. `pnpm install` çalıştır.

- [ ] **Step 2: Başarısız testleri yaz**

`src/render.spec.ts`:

```ts
import type { MatchNotificationPayload } from '@oto/shared';
import { describe, expect, it } from 'vitest';
import { formatIstanbulDateTime, formatTl, isPublicHttpUrl } from './format';
import { renderMatchMessage } from './render';

const base: MatchNotificationPayload = {
  type: 'MATCH', reason: 'NEW', profile: { id: 'p1', name: 'BMW' },
  listing: { id: 7, title: 'Temiz <320i>', make: 'BMW', model: '3 Serisi', trim: '320i', year: 2019, km: 85000, fuel: 'GASOLINE',
    transmission: 'AUTOMATIC', city: 'İstanbul', price: '960000', imageUrl: null, url: 'https://ornek.com/ilan/7', firstSeenAt: '2026-10-10T11:32:00.000Z' },
  analysis: { opportunityScore: 77, confidence: 'HIGH', estimatedPrice: '1200000', priceDiff: '240000', discountPct: 0.2, comparableCount: 14 },
  previousPrice: null, limitExceeded: false,
};
const opts = { publicBaseUrl: 'https://otofirsat.example' };

describe('format', () => {
  it('formats money, Istanbul time and public urls', () => {
    expect(formatTl('960000')).toBe('960.000');
    expect(formatTl(1_010_000n)).toBe('1.010.000');
    expect(formatIstanbulDateTime('2026-10-10T11:32:00.000Z')).toBe('10.10.2026 14:32');
    expect(isPublicHttpUrl('https://ornek.com/x')).toBe(true);
    expect(isPublicHttpUrl('http://127.0.0.1:4000/x')).toBe(false);
    expect(isPublicHttpUrl('http://localhost:3000/x')).toBe(false);
    expect(isPublicHttpUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('renderMatchMessage', () => {
  it('renders the spec reference message (§5.5)', () => {
    const m = renderMatchMessage(base, opts);
    expect(m.text).toBe(
      [
        '🔥 <b>Fırsat</b> · Skor 77 · Güven: Yüksek',
        '<b>BMW 3 Serisi 320i · 2019</b>',
        '💰 960.000 TL   (Piyasa ≈ 1.200.000 TL)',
        '📉 240.000 TL altında · %20',
        '🛣 85.000 km · Benzin · Otomatik · İstanbul',
        '📊 14 benzer ilan ile karşılaştırıldı',
        '🕒 İlk görülme: 10.10.2026 14:32',
        '',
        '<i>Fiyat analizi tahminidir; aracın durumunu garanti etmez.</i>',
      ].join('\n'),
    );
    expect(m.photoUrl).toBeNull();
    expect(m.replyMarkup).toEqual({
      inline_keyboard: [[
        { text: 'İlana git', url: 'https://ornek.com/ilan/7' },
        { text: 'Favorile', callback_data: 'fav:7' },
        { text: 'Analizi gör', url: 'https://otofirsat.example/ilan/7' },
      ]],
    });
  });

  it('price drop and relist headers', () => {
    expect(renderMatchMessage({ ...base, reason: 'PRICE_DROP', previousPrice: '1010000' }, opts).text.split('\n')[0])
      .toBe('📉 <b>Fiyat düştü: 1.010.000 → 960.000 TL</b> · Skor 77 · Güven: Yüksek');
    expect(renderMatchMessage({ ...base, reason: 'RELIST' }, opts).text.split('\n')[0]).toBe('🔁 <b>Yeniden yayında</b> · Skor 77 · Güven: Yüksek');
  });

  it('weak analysis: "Yeni ilan" header, no discount/market lines', () => {
    const m = renderMatchMessage({ ...base, analysis: { opportunityScore: 12, confidence: 'INSUFFICIENT', estimatedPrice: null, priceDiff: null, discountPct: null, comparableCount: 2 } }, opts);
    const lines = m.text.split('\n');
    expect(lines[0]).toBe('🆕 <b>Yeni ilan</b> · Skor 12 · Güven: Yetersiz');
    expect(lines[2]).toBe('💰 960.000 TL');
    expect(m.text).not.toContain('altında');
    expect(m.text).toContain('📊 2 benzer ilan ile karşılaştırıldı');
  });

  it('escapes HTML, omits null city, local urls and uses photo when present', () => {
    const m = renderMatchMessage({ ...base, listing: { ...base.listing, trim: null, city: null, url: 'http://127.0.0.1:4000/ilan/7', imageUrl: 'https://img.example/7.jpg', title: '<b>x</b>' } }, { publicBaseUrl: 'http://localhost:3000' });
    expect(m.text).toContain('<b>BMW 3 Serisi · 2019</b>');
    expect(m.text).toContain('🛣 85.000 km · Benzin · Otomatik\n');
    expect(m.photoUrl).toBe('https://img.example/7.jpg');
    expect(m.replyMarkup).toEqual({ inline_keyboard: [[{ text: 'Favorile', callback_data: 'fav:7' }]] });
  });
});
```

(Not: başlık/model satırında ilan **başlığı** değil `make model trim · year` kullanılır; `title` HTML'e girmez. Kaçış testi için `make`'e `<` içeren bir değerle ek bir `expect(renderMatchMessage({...base, listing:{...base.listing, make:'A<B'}}, opts).text).toContain('A&lt;B')` ekle.)

`src/classify.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TelegramApiError } from './client';
import { classifyTelegramError, isPhotoFallbackError } from './classify';

const api = (status: number, description: string, retryAfterSec: number | null = null) =>
  new TelegramApiError('sendMessage', status, status, description, retryAfterSec);

describe('classifyTelegramError', () => {
  it('429 is retryable with retry_after', () => {
    expect(classifyTelegramError(api(429, 'Too Many Requests: retry after 7', 7))).toMatchObject({ kind: 'RETRYABLE', retryAfterMs: 7000 });
  });
  it('5xx and network errors are retryable', () => {
    expect(classifyTelegramError(api(502, 'Bad Gateway')).kind).toBe('RETRYABLE');
    expect(classifyTelegramError(new TypeError('fetch failed')).kind).toBe('RETRYABLE');
    expect(classifyTelegramError(Object.assign(new Error('timeout'), { name: 'TimeoutError' })).kind).toBe('RETRYABLE');
  });
  it('blocked bot / chat not found are permanent and disable the channel', () => {
    expect(classifyTelegramError(api(403, 'Forbidden: bot was blocked by the user'))).toMatchObject({ kind: 'PERMANENT', disableChannel: true });
    expect(classifyTelegramError(api(403, 'Forbidden: user is deactivated'))).toMatchObject({ kind: 'PERMANENT', disableChannel: true });
    expect(classifyTelegramError(api(400, 'Bad Request: chat not found'))).toMatchObject({ kind: 'PERMANENT', disableChannel: true });
  });
  it('other 4xx are permanent without disabling', () => {
    expect(classifyTelegramError(api(400, "Bad Request: can't parse entities"))).toMatchObject({ kind: 'PERMANENT', disableChannel: false });
    expect(classifyTelegramError(api(401, 'Unauthorized'))).toMatchObject({ kind: 'PERMANENT', disableChannel: false });
  });
  it('photo fallback detection', () => {
    expect(isPhotoFallbackError(new TelegramApiError('sendPhoto', 400, 400, 'Bad Request: wrong file identifier/HTTP URL specified', null))).toBe(true);
    expect(isPhotoFallbackError(new TelegramApiError('sendPhoto', 400, 400, 'Bad Request: failed to get HTTP URL content', null))).toBe(true);
    expect(isPhotoFallbackError(api(400, 'Bad Request: chat not found'))).toBe(false);
  });
});
```

`src/client.spec.ts` (sahte Bot API ile gerçek HTTP):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TelegramApiError, TelegramClient } from './client';
import { FakeTelegramApi } from './fake-bot-api';

let fake: FakeTelegramApi;
let client: TelegramClient;

beforeAll(async () => {
  fake = new FakeTelegramApi();
  const { apiBase, token } = await fake.start();
  client = new TelegramClient({ token, apiBase, timeoutMs: 2000 });
});
afterAll(async () => fake.close());

describe('TelegramClient', () => {
  it('posts JSON and returns result', async () => {
    await client.sendMessage(42, 'merhaba', { inline_keyboard: [[{ text: 'x', callback_data: 'fav:1' }]] });
    expect(fake.requests.at(-1)).toEqual({ method: 'sendMessage', body: { chat_id: 42, text: 'merhaba', parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: 'fav:1' }]] } } });
  });
  it('maps API errors without leaking the token', async () => {
    fake.respondNext('sendMessage', { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } } });
    const err = await client.sendMessage(42, 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(err).toMatchObject({ status: 429, retryAfterSec: 3, method: 'sendMessage' });
    expect(String((err as Error).message)).not.toContain(fake.token);
  });
  it('getUpdates returns queued updates once', async () => {
    fake.queueUpdates([{ update_id: 5, message: { chat: { id: 9 }, text: '/start abc' } }]);
    expect((await client.getUpdates(0, 0)).map((u) => u.update_id)).toEqual([5]);
    expect(await client.getUpdates(6, 0)).toEqual([]);
  });
});
```

Run: `pnpm --filter @oto/telegram test` → FAIL.

- [ ] **Step 3: Uygula**

`src/client.ts`:

```ts
export type InlineButton = { text: string; url?: string; callback_data?: string };
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };

export interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
  my_chat_member?: { chat: { id: number }; new_chat_member: { status: string } };
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly errorCode: number,
    readonly description: string,
    readonly retryAfterSec: number | null,
  ) {
    super(`Telegram ${method} başarısız (${status}): ${description}`);
    this.name = 'TelegramApiError';
  }
}

interface ApiEnvelope<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramClient {
  private readonly apiBase: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: { token: string; apiBase?: string; timeoutMs?: number }) {
    this.apiBase = (opts.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** Hata mesajları URL'yi (dolayısıyla token'ı) içermez. */
  async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await fetch(`${this.apiBase}/bot${this.opts.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const json = (await res.json().catch(() => ({ ok: false, description: 'Geçersiz JSON yanıtı' }))) as ApiEnvelope<T>;
    if (!res.ok || !json.ok) {
      throw new TelegramApiError(method, res.status, json.error_code ?? res.status, json.description ?? 'Bilinmeyen hata', json.parameters?.retry_after ?? null);
    }
    return json.result as T;
  }

  sendMessage(chatId: number | string, text: string, replyMarkup?: InlineKeyboard) {
    return this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }

  sendPhoto(chatId: number | string, photo: string, caption: string, replyMarkup?: InlineKeyboard) {
    return this.call('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }

  answerCallbackQuery(id: string, text: string) {
    return this.call('answerCallbackQuery', { callback_query_id: id, text });
  }

  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query', 'my_chat_member'] }, signal);
  }
}
```

(`getUpdates` için istemci zaman aşımı `timeoutSec*1000 + 10_000` olmalı: `call`'a isteğe bağlı `timeoutMs` parametresi ekleyerek uygula; uzun yoklama varsayılan 10 sn ile kesilmesin.)

`src/classify.ts`:

```ts
import { TelegramApiError } from './client';

export type TelegramErrorClass =
  | { kind: 'RETRYABLE'; retryAfterMs?: number; error: string }
  | { kind: 'PERMANENT'; disableChannel: boolean; error: string };

const DISABLE_PATTERNS = [/bot was blocked/i, /user is deactivated/i, /chat not found/i, /bot was kicked/i];

export function classifyTelegramError(err: unknown): TelegramErrorClass {
  if (err instanceof TelegramApiError) {
    const error = err.message;
    if (err.status === 429) return { kind: 'RETRYABLE', retryAfterMs: (err.retryAfterSec ?? 1) * 1000, error };
    if (err.status >= 500) return { kind: 'RETRYABLE', error };
    const disable = (err.status === 403 || err.status === 400) && DISABLE_PATTERNS.some((p) => p.test(err.description));
    return { kind: 'PERMANENT', disableChannel: disable, error };
  }
  // Ağ hatası, zaman aşımı, DNS: geçici
  return { kind: 'RETRYABLE', error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
}

const PHOTO_FALLBACK = [/wrong file identifier/i, /failed to get HTTP URL content/i, /wrong type of the web page content/i, /IMAGE_PROCESS_FAILED/i];

export function isPhotoFallbackError(err: unknown): boolean {
  return err instanceof TelegramApiError && err.status === 400 && PHOTO_FALLBACK.some((p) => p.test(err.description));
}
```

`src/format.ts`:

```ts
const TL = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
const DT = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

export function formatTl(v: string | bigint): string {
  return TL.format(typeof v === 'bigint' ? v : BigInt(v));
}

export function formatIstanbulDateTime(iso: string): string {
  const parts = Object.fromEntries(DT.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** Telegram URL butonları yalnızca herkese açık http(s) adresleri kabul eder. */
export function isPublicHttpUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
```

(`Intl.NumberFormat.format(bigint)` Node 22'de desteklenir. `tr-TR` binlik ayırıcı nokta üretir; test bunu doğrular.)

`src/render.ts`:

```ts
import type { MatchNotificationPayload } from '@oto/shared';
import type { InlineButton, InlineKeyboard } from './client';
import { escapeHtml, formatIstanbulDateTime, formatTl, isPublicHttpUrl } from './format';

const CONFIDENCE: Record<string, string> = { HIGH: 'Yüksek', MEDIUM: 'Orta', LOW: 'Düşük', INSUFFICIENT: 'Yetersiz' };
const FUEL: Record<string, string> = { GASOLINE: 'Benzin', DIESEL: 'Dizel', LPG: 'LPG', HYBRID: 'Hibrit', ELECTRIC: 'Elektrik', OTHER: 'Diğer' };
const GEAR: Record<string, string> = { MANUAL: 'Manuel', AUTOMATIC: 'Otomatik', SEMI_AUTOMATIC: 'Yarı otomatik' };
export const DISCLAIMER = 'Fiyat analizi tahminidir; aracın durumunu garanti etmez.';

export function renderMatchMessage(p: MatchNotificationPayload, opts: { publicBaseUrl: string }) {
  const { listing: l, analysis: a } = p;
  const isDeal = a.confidence !== 'INSUFFICIENT' && a.discountPct !== null && a.discountPct > 0;
  const tail = ` · Skor ${a.opportunityScore} · Güven: ${CONFIDENCE[a.confidence] ?? a.confidence}`;
  const head =
    p.reason === 'PRICE_DROP' && p.previousPrice
      ? `📉 <b>Fiyat düştü: ${formatTl(p.previousPrice)} → ${formatTl(l.price)} TL</b>`
      : p.reason === 'RELIST'
        ? '🔁 <b>Yeniden yayında</b>'
        : isDeal
          ? '🔥 <b>Fırsat</b>'
          : '🆕 <b>Yeni ilan</b>';
  const name = [l.make, l.model, l.trim].filter(Boolean).map((s) => escapeHtml(String(s))).join(' ');
  const lines = [
    head + tail,
    `<b>${name} · ${l.year}</b>`,
    `💰 ${formatTl(l.price)} TL` + (a.estimatedPrice && isDeal ? `   (Piyasa ≈ ${formatTl(a.estimatedPrice)} TL)` : ''),
  ];
  if (isDeal && a.priceDiff && BigInt(a.priceDiff) > 0n) lines.push(`📉 ${formatTl(a.priceDiff)} TL altında · %${Math.round((a.discountPct ?? 0) * 100)}`);
  lines.push(
    [`🛣 ${formatTl(BigInt(l.km))} km`, FUEL[l.fuel] ?? l.fuel, GEAR[l.transmission] ?? l.transmission, l.city ? escapeHtml(l.city) : null]
      .filter(Boolean)
      .join(' · '),
  );
  if (a.comparableCount > 0) lines.push(`📊 ${a.comparableCount} benzer ilan ile karşılaştırıldı`);
  lines.push(`🕒 İlk görülme: ${formatIstanbulDateTime(l.firstSeenAt)}`, '', `<i>${DISCLAIMER}</i>`);

  const row: InlineButton[] = [];
  if (isPublicHttpUrl(l.url)) row.push({ text: 'İlana git', url: l.url });
  row.push({ text: 'Favorile', callback_data: `fav:${l.id}` });
  const analysisUrl = `${opts.publicBaseUrl.replace(/\/+$/, '')}/ilan/${l.id}`;
  if (isPublicHttpUrl(analysisUrl)) row.push({ text: 'Analizi gör', url: analysisUrl });
  const replyMarkup: InlineKeyboard = { inline_keyboard: [row] };
  return { text: lines.join('\n'), photoUrl: l.imageUrl && isPublicHttpUrl(l.imageUrl) ? l.imageUrl : null, replyMarkup };
}
```

(Spec örneğinde "Piyasa ≈" yalnızca fırsat mesajında anlamlıdır; zayıf analizde gösterilmez — test bunu sabitler.)

`src/fake-bot-api.ts`:

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TelegramUpdate } from './client';

/** Testler için sahte Telegram Bot API (yalnızca 127.0.0.1). */
export class FakeTelegramApi {
  readonly token = 'test-token-123:ABC';
  readonly requests: Array<{ method: string; body: any }> = [];
  private server?: Server;
  private readonly scripted = new Map<string, Array<{ status: number; body: unknown }>>();
  private updates: TelegramUpdate[] = [];
  private messageId = 0;

  respondNext(method: string, r: { status: number; body: unknown }): void {
    const q = this.scripted.get(method) ?? [];
    q.push(r);
    this.scripted.set(method, q);
  }

  queueUpdates(u: TelegramUpdate[]): void {
    this.updates.push(...u);
  }

  async start(): Promise<{ apiBase: string; token: string }> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (!m || m[1] !== this.token) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
        const method = m[2];
        const body = raw ? JSON.parse(raw) : {};
        this.requests.push({ method, body });
        const next = this.scripted.get(method)?.shift();
        if (next) return send(next.status, next.body);
        if (method === 'getUpdates') {
          const offset = Number(body.offset ?? 0);
          const out = this.updates.filter((u) => u.update_id >= offset);
          this.updates = [];
          return send(200, { ok: true, result: out });
        }
        this.messageId += 1;
        return send(200, { ok: true, result: { message_id: this.messageId } });
      });
    });
    await new Promise<void>((done) => this.server!.listen(0, '127.0.0.1', done));
    return { apiBase: `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`, token: this.token };
  }

  async close(): Promise<void> {
    await new Promise<void>((done) => (this.server ? this.server.close(() => done()) : done()));
  }
}
```

`src/index.ts` → `export * from './client'; export * from './classify'; export * from './format'; export * from './render'; export * from './fake-bot-api';`

- [ ] **Step 3: Test + build**

Run: `pnpm --filter @oto/telegram test && pnpm --filter @oto/telegram build && pnpm lint && pnpm typecheck`
Expected: PASS. (`Intl` çıktısında Node sürümüne bağlı farklı boşluk karakteri çıkarsa testi değil `format.ts`'i düzelt; beklenen biçim sabittir.)

- [ ] **Step 4: Commit**

```bash
git add packages/telegram pnpm-lock.yaml
git commit -m "feat(telegram): add bot API client, error classification, match message template and fake Bot API"
```

---

### Task 4: Worker — eşleşmeyle aynı transaction'da bildirim planlama + kuyruğa alma + süpürme

**Files:**
- Create: `apps/worker/src/notifications/notifications.module.ts`, `notification-planner.ts`, `payload.ts`, `notification-dispatcher.ts`, `apps/worker/src/scheduler/notification-sweep.service.ts`, `apps/worker/test/notification-planner.e2e.spec.ts`, `apps/worker/test/notification-sweep.e2e.spec.ts`
- Modify: `apps/worker/src/matching/match.service.ts`, `apps/worker/src/matching/matching.module.ts`, `apps/worker/src/queues/queue-registry.ts`, `apps/worker/src/queues/job-options.ts`, `apps/worker/src/scheduler/scheduler-loop.service.ts`, `apps/worker/src/scheduler/scheduler.module.ts`, `apps/worker/test/helpers.ts`, `apps/worker/test/match.e2e.spec.ts`

**Interfaces:**
- Consumes: `resolveUserPlan`, `MatchingProfileRow.channels` (Task 2), `MatchNotificationPayload`, `notifyJobId`, `QueueName.NOTIFY*` (Task 1), `startOfIstanbulDay` (`@oto/shared`).
- Produces:
  - `NOTIFY_JOB_OPTS: JobsOptions = { attempts: 5, backoff: { type: 'custom' }, removeOnComplete: true, removeOnFail: { age: 86400 } }`
  - `QueueRegistry.notify: Queue<NotifyJobData>`, `QueueRegistry.notifyTelegram: Queue<NotifyJobData>`
  - `buildMatchPayload(input: { listing: Listing; analysis: ListingAnalysis; reason: MatchEvent; previousPrice: bigint | null; profile: { id: string; name: string }; limitExceeded: boolean }): MatchNotificationPayload`
  - `interface PlannedMatch { matchId: number; userId: string; profile: { id: string; name: string; channels: string[] }; reason: MatchEvent; previousPrice: bigint | null }`
  - `interface PlannedNotification { id: number; userId: string; channel: 'IN_APP' | 'TELEGRAM'; status: 'PENDING' | 'SKIPPED_LIMIT' }`
  - `planNotifications(tx: Prisma.TransactionClient, input: { listing: Listing; analysis: ListingAnalysis; matches: PlannedMatch[]; now: Date }): Promise<PlannedNotification[]>`
  - `NotificationDispatcher.enqueue(items: Array<{ id: number; channel: string }>): Promise<number>` — yalnızca IN_APP/TELEGRAM; kuyruğa ekler ve `queuedAt` yazar.
  - `MatchOutcome` (MATCHED) ek alanı: `notifications: PlannedNotification[]`
  - `NotificationSweepService.requeuePending(now?: Date): Promise<number>`; `NOTIFY_REQUEUE_AFTER_MS = 60_000`
  - Test helper: `createChannel(ref, userId, over?)` (TELEGRAM, doğrulanmış, etkin, `config` şifreli `{chatId}`, `externalIdHash`).

- [ ] **Step 1: Başarısız testleri yaz**

`apps/worker/test/helpers.ts` sonuna:

```ts
export async function createChannel(ref: TestingModule, userId: string, over: Record<string, unknown> = {}) {
  const chatId = (over.chatId as number | undefined) ?? 1000 + Math.floor(Math.random() * 1e6);
  const { chatId: _omit, ...rest } = over;
  return ref.get(PrismaService).notificationChannel.create({
    data: {
      userId, type: 'TELEGRAM', isVerified: true, isEnabled: true,
      config: ref.get(Encryptor).encryptJson({ chatId }), externalIdHash: hashToken(String(chatId)), ...rest,
    },
  });
}
```
(`Encryptor`, `hashToken` → `@oto/server-common`. Dönüş tipi `Promise<NotificationChannel>` olarak açık yazılmalı — TS2742.)

`apps/worker/test/notification-planner.e2e.spec.ts`:

```ts
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { MatchingModule } from '../src/matching/matching.module';
import { MatchService } from '../src/matching/match.service';
import { QueueRegistry } from '../src/queues/queue-registry';
import { createAnalysis, createChannel, createContext, createListing, createProfile, createSource, createUser, resetState } from './helpers';

let ref: TestingModule;
let prisma: PrismaService;
let svc: MatchService;
let sourceId: number;

beforeAll(async () => {
  ref = await createContext([MatchingModule]);
  prisma = ref.get(PrismaService);
  svc = ref.get(MatchService);
});
afterAll(async () => ref.close());
beforeEach(async () => {
  await resetState(ref);
  await seedPlans(prisma);
  sourceId = (await createSource(ref, 'http://demo.invalid')).id;
});

async function deal(price = 960_000n) {
  const l = await createListing(ref, sourceId, { price });
  const a = await createAnalysis(ref, l.id);
  return { l, a };
}

describe('notification planning inside the match transaction', () => {
  it('creates IN_APP + TELEGRAM PENDING rows with a snapshot payload and enqueues them', async () => {
    const u = await createUser(ref);
    await createChannel(ref, u.id);
    const p = await createProfile(ref, u.id, { name: 'BMW', channels: ['IN_APP', 'TELEGRAM'] });
    const { l, a } = await deal();
    const out = await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' });
    expect(out.status).toBe('MATCHED');
    const rows = await prisma.notification.findMany({ orderBy: { channel: 'asc' } });
    expect(rows.map((r) => [r.channel, r.status])).toEqual([['IN_APP', 'PENDING'], ['TELEGRAM', 'PENDING']]);
    expect(rows[0].payload).toMatchObject({
      type: 'MATCH', reason: 'NEW', profile: { id: p.id, name: 'BMW' }, previousPrice: null, limitExceeded: false,
      listing: { id: l.id, price: '960000' }, analysis: { confidence: 'HIGH', estimatedPrice: '1200000', discountPct: 0.2 },
    });
    expect(rows.every((r) => r.queuedAt !== null)).toBe(true);
    expect(await ref.get(QueueRegistry).notify.getJob(`notify-${rows[0].id}`)).toBeTruthy();
    expect(await ref.get(QueueRegistry).notifyTelegram.getJob(`notify-${rows[1].id}`)).toBeTruthy();
  });

  it('drops TELEGRAM when the channel is unverified/disabled or the plan lacks it', async () => {
    const u1 = await createUser(ref);
    await createChannel(ref, u1.id, { isEnabled: false });
    await createProfile(ref, u1.id, { channels: ['IN_APP', 'TELEGRAM'] });
    const u2 = await createUser(ref);
    await createChannel(ref, u2.id);
    await createProfile(ref, u2.id, { channels: ['IN_APP', 'TELEGRAM'] });
    const free = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'FREE' } });
    await prisma.userSubscription.create({ data: { userId: u2.id, planId: free.id, limitOverrides: { channels: ['IN_APP'] } } });
    const { l, a } = await deal();
    await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' });
    expect((await prisma.notification.findMany()).map((r) => r.channel)).toEqual(['IN_APP', 'IN_APP']);
  });

  it('daily limit under a concurrent burst: exactly the limit is PENDING, rest SKIPPED_LIMIT, IN_APP flagged', async () => {
    const u = await createUser(ref);
    await createChannel(ref, u.id);
    await createProfile(ref, u.id, { channels: ['IN_APP', 'TELEGRAM'] });
    const free = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'FREE' } });
    await prisma.userSubscription.create({ data: { userId: u.id, planId: free.id, limitOverrides: { maxNotificationsPerDay: 3 } } });
    const jobs = [];
    for (let i = 0; i < 6; i++) {
      const { l, a } = await deal(900_000n + BigInt(i));
      jobs.push({ listingId: l.id, analysisId: a.id, event: 'NEW' as const });
    }
    await Promise.all(jobs.map((j) => svc.process(j)));
    const tg = await prisma.notification.findMany({ where: { channel: 'TELEGRAM' } });
    expect(tg.filter((n) => n.status === 'PENDING')).toHaveLength(3);
    expect(tg.filter((n) => n.status === 'SKIPPED_LIMIT')).toHaveLength(3);
    const inApp = await prisma.notification.findMany({ where: { channel: 'IN_APP' } });
    expect(inApp).toHaveLength(6);
    expect(inApp.filter((n) => (n.payload as { limitExceeded: boolean }).limitExceeded)).toHaveLength(3);
    expect(await ref.get(QueueRegistry).notifyTelegram.count()).toBe(3);
  });

  it('PRICE_DROP payload carries the previous matched price', async () => {
    const u = await createUser(ref);
    await createProfile(ref, u.id, { priceDropPct: 0.05 });
    const { l, a } = await deal(1_000_000n);
    await svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' });
    const drop = await createAnalysis(ref, l.id, { listingPrice: 900_000n });
    await svc.process({ listingId: l.id, analysisId: drop.id, event: 'PRICE_DROP', previousPrice: '1000000' });
    const n = await prisma.notification.findFirstOrThrow({ where: { payload: { path: ['reason'], equals: 'PRICE_DROP' } } });
    expect(n.payload).toMatchObject({ previousPrice: '1000000', listing: { price: '900000' } });
  });

  it('match and notifications commit atomically: a failing planner rolls back the match', async () => {
    const u = await createUser(ref);
    await createProfile(ref, u.id);
    const { l, a } = await deal();
    await prisma.subscriptionPlan.deleteMany({ where: { code: 'FREE' } }); // resolveUserPlan atar
    await expect(svc.process({ listingId: l.id, analysisId: a.id, event: 'NEW' })).rejects.toThrow(/FREE/);
    expect(await prisma.listingMatch.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });
});
```
(`seedPlans` → `@oto/db`. Eşleşme üreten HER worker testi artık plan çözümlemesine (FREE yedeği) ihtiyaç duyar: `apps/worker/test/helpers.ts` içindeki `resetState`'e `await seedPlans(prisma);` ekle; yukarıdaki `beforeEach`'teki ayrı `seedPlans` çağrısını o zaman kaldır.)

`apps/worker/test/notification-sweep.e2e.spec.ts`:

```ts
// Kurulum match/planner testleriyle aynı: createContext([MatchingModule, SchedulerModule]); SchedulerLoop autostart'ı kapalı olmalı (mevcut scheduler testlerinin yöntemini kullan).
describe('NotificationSweepService', () => {
  it('requeues PENDING notifications whose enqueue was lost, only once and only when older than 60s', async () => {
    // 1) Eşleşme üret (svc.process) → bildirimler kuyrukta. 2) Kuyrukları boşalt (obliterate) ve queuedAt'i null yap.
    // 3) requeuePending(now) → 0 (henüz 60 sn geçmedi). 4) requeuePending(now + 61 sn) → 2; queuedAt dolu; işler kuyrukta.
    // 5) Tekrar çağır → 0. 6) SENT/SKIPPED_LIMIT satırlar asla yeniden kuyruğa alınmaz (bir satırı SENT yapıp queuedAt=null ile doğrula).
  });
});
```
Bu iskeleti gerçek kodla doldur: `ref.get(QueueRegistry).notify.obliterate({ force: true })`, `prisma.notification.updateMany({ data: { queuedAt: null } })`, `ref.get(NotificationSweepService).requeuePending(new Date(Date.now() + 61_000))`, `expect(await queue.getJob(\`notify-${id}\`)).toBeTruthy()`.

`match.e2e.spec.ts`, `match-worker.e2e.spec.ts`, `pipeline.e2e.spec.ts` → `resetState` artık planları seed ettiği için değişiklik gerekmez; mevcut beklentiler (ListingMatch) aynen kalmalı.

Run: `pnpm --filter @oto/worker exec vitest run --config vitest.e2e.config.ts test/notification-planner.e2e.spec.ts test/notification-sweep.e2e.spec.ts` → FAIL.

- [ ] **Step 2: Uygula**

`job-options.ts` → ekle:

```ts
/** Bildirim işleri: 5 deneme; bekleme süreleri notifyBackoffMs (özel strateji) ile belirlenir. */
export const NOTIFY_JOB_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'custom' },
  removeOnComplete: true,
  removeOnFail: { age: 24 * 60 * 60 },
};
```

`queue-registry.ts` → `notify` (`QueueName.NOTIFY`) ve `notifyTelegram` (`QueueName.NOTIFY_TELEGRAM`) kuyrukları, `error` dinleyicileri, `onModuleDestroy`'da kapatma.

`apps/worker/src/notifications/payload.ts`:

```ts
import type { Listing, ListingAnalysis } from '@oto/db';
import type { MatchEvent, MatchNotificationPayload } from '@oto/shared';

export function buildMatchPayload(i: {
  listing: Listing;
  analysis: ListingAnalysis;
  reason: MatchEvent;
  previousPrice: bigint | null;
  profile: { id: string; name: string };
  limitExceeded: boolean;
}): MatchNotificationPayload {
  const { listing: l, analysis: a } = i;
  return {
    type: 'MATCH',
    reason: i.reason,
    profile: i.profile,
    listing: {
      id: l.id, title: l.title, make: l.make, model: l.model, trim: l.trim, year: l.year, km: l.km, fuel: l.fuel,
      transmission: l.transmission, city: l.city, price: (a.listingPrice ?? l.price).toString(), imageUrl: l.imageUrl, url: l.url,
      firstSeenAt: l.firstSeenAt.toISOString(),
    },
    analysis: {
      opportunityScore: a.opportunityScore, confidence: a.confidence, estimatedPrice: a.estimatedPrice?.toString() ?? null,
      priceDiff: a.priceDiff?.toString() ?? null, discountPct: a.discountPct === null ? null : Number(a.discountPct),
      comparableCount: a.comparableCount,
    },
    previousPrice: i.previousPrice?.toString() ?? null,
    limitExceeded: i.limitExceeded,
  };
}
```

`apps/worker/src/notifications/notification-planner.ts`:

```ts
import { Prisma, resolveUserPlan, type Listing, type ListingAnalysis } from '@oto/db';
import { startOfIstanbulDay, type MatchEvent } from '@oto/shared';
import { buildMatchPayload } from './payload';

/** pg_advisory_xact_lock(4243, hashtext(userId)): kullanıcı başına günlük limit kararı. 4242 = ilan eşleştirme. */
const USER_LOCK_NAMESPACE = 4243;
const DELIVERABLE = new Set(['IN_APP', 'TELEGRAM']);

export interface PlannedMatch {
  matchId: number;
  userId: string;
  profile: { id: string; name: string; channels: string[] };
  reason: MatchEvent;
  previousPrice: bigint | null;
}

export interface PlannedNotification {
  id: number;
  userId: string;
  channel: 'IN_APP' | 'TELEGRAM';
  status: 'PENDING' | 'SKIPPED_LIMIT';
}

/**
 * Eşleşmeyle AYNI transaction'da çalışır (çağıran açar). Kullanıcı kilitleri id sırasıyla alınır:
 * aynı kullanıcıları kapsayan iki eşzamanlı eşleştirme birbirini kilitlemez (deadlock yok).
 */
export async function planNotifications(
  tx: Prisma.TransactionClient,
  input: { listing: Listing; analysis: ListingAnalysis; matches: PlannedMatch[]; now: Date },
): Promise<PlannedNotification[]> {
  const out: PlannedNotification[] = [];
  const byUser = new Map<string, PlannedMatch[]>();
  for (const m of input.matches) byUser.set(m.userId, [...(byUser.get(m.userId) ?? []), m]);
  const userIds = [...byUser.keys()].sort();
  for (const userId of userIds) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USER_LOCK_NAMESPACE}::int, hashtext(${userId}))`;
  }
  const dayStart = startOfIstanbulDay(input.now);
  for (const userId of userIds) {
    const plan = await resolveUserPlan(tx, userId, input.now);
    const verified = await tx.notificationChannel.findMany({ where: { userId, isEnabled: true, isVerified: true }, select: { type: true } });
    const open = new Set(['IN_APP', ...verified.map((c) => c.type)]);
    const allowed = new Set(['IN_APP', ...plan.limits.channels]);
    let usedToday = await tx.notification.count({
      where: { userId, kind: 'MATCH', channel: { not: 'IN_APP' }, status: { not: 'SKIPPED_LIMIT' }, createdAt: { gte: dayStart } },
    });
    for (const m of byUser.get(userId)!) {
      const channels = [...new Set(['IN_APP', ...m.profile.channels])].filter((c) => DELIVERABLE.has(c) && allowed.has(c) && open.has(c)) as Array<'IN_APP' | 'TELEGRAM'>;
      const external = channels.filter((c) => c !== 'IN_APP');
      const statuses = new Map<string, 'PENDING' | 'SKIPPED_LIMIT'>();
      for (const c of external) {
        if (usedToday < plan.limits.maxNotificationsPerDay) {
          statuses.set(c, 'PENDING');
          usedToday += 1;
        } else statuses.set(c, 'SKIPPED_LIMIT');
      }
      const limitExceeded = [...statuses.values()].includes('SKIPPED_LIMIT');
      const payload = buildMatchPayload({
        listing: input.listing, analysis: input.analysis, reason: m.reason, previousPrice: m.previousPrice,
        profile: { id: m.profile.id, name: m.profile.name }, limitExceeded,
      });
      for (const c of channels) {
        const status = c === 'IN_APP' ? 'PENDING' : statuses.get(c)!;
        const rows = await tx.$queryRaw<{ id: number }[]>`
          INSERT INTO "Notification" ("userId", "matchId", "kind", "channel", "status", "payload")
          VALUES (${userId}, ${m.matchId}::int, 'MATCH'::"NotificationKind", ${c}::"ChannelType", ${status}::"NotificationStatus", ${JSON.stringify(payload)}::jsonb)
          ON CONFLICT ("matchId", "channel") DO NOTHING
          RETURNING "id"`;
        if (rows[0]) out.push({ id: rows[0].id, userId, channel: c, status });
      }
    }
  }
  return out;
}
```

`match.service.ts`:
- `findMatchingProfiles` artık `name` ve `channels` döndürür (Task 2).
- Döngüde oluşturulan her eşleşme için `PlannedMatch` topla (`previousPrice: c.lastMatchedPrice` yalnızca `reason === 'PRICE_DROP'` iken, aksi halde `null`).
- Transaction içinde, döngüden sonra: `const notifications = created.length ? await planNotifications(tx, { listing, analysis: effective, matches: planned, now: new Date() }) : [];` ve dönüşe `notifications` ekle (SKIPPED dallarında `notifications: []`).
- Commit SONRASI: `PENDING` olanları `NotificationDispatcher.enqueue(...)` ile kuyruğa al; hata olursa `warn` logla ve devam et (süpürme telafi eder). `MatchService` constructor'ına `NotificationDispatcher` eklenir; `MatchingModule` `NotificationsModule`'ü import eder.

`apps/worker/src/notifications/notification-dispatcher.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { notifyJobId, type NotifyJobData } from '@oto/shared';
import type { Queue } from 'bullmq';
import { PrismaService } from '../infra/prisma.service';
import { NOTIFY_JOB_OPTS } from '../queues/job-options';
import { QueueRegistry } from '../queues/queue-registry';

@Injectable()
export class NotificationDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
  ) {}

  /** jobId = notify-<id>: aynı bildirim iki kez kuyrukta beklemez. Kuyruğa eklenenlerin queuedAt'i yazılır. */
  async enqueue(items: Array<{ id: number; channel: string }>): Promise<number> {
    const groups: Array<[Queue<NotifyJobData>, number[]]> = [
      [this.queues.notify, items.filter((i) => i.channel === 'IN_APP').map((i) => i.id)],
      [this.queues.notifyTelegram, items.filter((i) => i.channel === 'TELEGRAM').map((i) => i.id)],
    ];
    let n = 0;
    for (const [queue, ids] of groups) {
      if (ids.length === 0) continue;
      await queue.addBulk(ids.map((id) => ({ name: 'notify', data: { notificationId: id }, opts: { jobId: notifyJobId(id), ...NOTIFY_JOB_OPTS } })));
      await this.prisma.notification.updateMany({ where: { id: { in: ids } }, data: { queuedAt: new Date() } });
      n += ids.length;
    }
    return n;
  }
}
```

`notifications.module.ts` → `providers: [NotificationDispatcher]`, `exports: [NotificationDispatcher]` (Task 5 bu modüle `NotifyService` ve adapter'ları ekler).

`apps/worker/src/scheduler/notification-sweep.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';

export const NOTIFY_REQUEUE_AFTER_MS = 60_000;

@Injectable()
export class NotificationSweepService {
  private readonly logger = new Logger(NotificationSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  /** Commit sonrası kuyruğa eklenemeyen PENDING bildirimleri yeniden ekler (en eskiler önce, 500'lük sayfa). */
  async requeuePending(now: Date = new Date()): Promise<number> {
    const rows = await this.prisma.notification.findMany({
      where: { status: 'PENDING', queuedAt: null, channel: { in: ['IN_APP', 'TELEGRAM'] }, createdAt: { lt: new Date(now.getTime() - NOTIFY_REQUEUE_AFTER_MS) } },
      orderBy: { id: 'asc' },
      take: 500,
      select: { id: true, channel: true },
    });
    if (rows.length === 0) return 0;
    const n = await this.dispatcher.enqueue(rows);
    this.logger.warn(`${n} bildirim yeniden kuyruğa alındı`);
    return n;
  }
}
```

`scheduler.module.ts` → `imports`'a `NotificationsModule`, `providers`/`exports`'a `NotificationSweepService`. `scheduler-loop.service.ts` → mevcut `step` deseniyle `await this.step('Bildirim yeniden gönderimi', () => this.notifySweep.requeuePending());`.

- [ ] **Step 3: Testler**

Run: `pnpm --filter @oto/db build && pnpm --filter @oto/worker test && pnpm --filter @oto/worker exec vitest run --config vitest.e2e.config.ts && pnpm lint && pnpm typecheck`
Expected: PASS (mevcut match/pipeline testleri dahil).

- [ ] **Step 4: Commit**

```bash
git add apps/worker packages/db
git commit -m "feat(worker): plan notifications in the match transaction with daily limits, enqueue after commit and sweep"
```

---

### Task 5: Worker — gönderim (IN_APP, Telegram), yeniden deneme, kanal kapatma

**Files:**
- Create: `apps/worker/src/notifications/backoff.ts`, `backoff.spec.ts`, `in-app.adapter.ts`, `telegram.adapter.ts`, `notify.service.ts`, `apps/worker/src/processors/notify-worker.host.ts`, `apps/worker/test/notify.e2e.spec.ts`
- Modify: `apps/worker/src/notifications/notifications.module.ts`, `apps/worker/src/config/env.ts`, `env.spec.ts`, `apps/worker/src/worker-app.module.ts`, `apps/worker/package.json` (`@oto/telegram`)

**Interfaces:**
- Consumes: `TelegramClient`, `classifyTelegramError`, `isPhotoFallbackError`, `renderMatchMessage` (Task 3); `resolveUserPlan` (Task 2); `userEventChannel`, `UserEvent`, `notifyJobSchema` (Task 1); `Encryptor`, `hashToken` (`@oto/server-common`).
- Produces:
  - env: `TELEGRAM_BOT_TOKEN?: string`, `TELEGRAM_API_BASE` (varsayılan `https://api.telegram.org`), `PUBLIC_BASE_URL` (varsayılan `http://localhost:3000`), `NOTIFY_CONCURRENCY` (1–32, varsayılan 8).
  - `TELEGRAM_CLIENT` token: `TelegramClient | null` (token yoksa null).
  - `notifyBackoffMs(attemptsMade: number, err?: unknown): number` — `[10_000, 30_000, 120_000, 600_000, 1_800_000][attemptsMade-1]` (taşarsa son değer); `err.retryAfterMs` varsa `max(retryAfterMs, takvim)`.
  - `class RetryableNotifyError extends Error { retryAfterMs?: number }`
  - `type SendResult = { kind: 'SENT' } | { kind: 'RETRYABLE'; error: string; retryAfterMs?: number } | { kind: 'PERMANENT'; error: string; disableChannel?: boolean } | { kind: 'THROTTLED'; retryAfterMs: number }`
  - `InAppAdapter.send(n: Notification): Promise<SendResult>` (Redis `PUBLISH user:<id>` `UserEvent`)
  - `TelegramAdapter.send(n: Notification, channelConfig: string): Promise<SendResult>` (`channelConfig` = şifreli kanal config'i)
  - `type NotifyResult = { kind: 'DONE'; status: 'SENT' | 'FAILED' | 'SKIPPED' } | { kind: 'RETRY'; error: string; retryAfterMs?: number } | { kind: 'THROTTLED'; retryAfterMs: number }`
  - `NotifyService.process(notificationId: number, attempt: { attemptsMade: number; maxAttempts: number }): Promise<NotifyResult>`
  - `NotifyWorkerHost` (`NOTIFY_WORKER_AUTOSTART`), iki `Worker`: `notify` (concurrency `NOTIFY_CONCURRENCY`) ve `notify-telegram` (concurrency 5, `limiter: { max: 25, duration: 1000 }`), `settings.backoffStrategy = (attemptsMade, _type, err) => notifyBackoffMs(attemptsMade, err)`.

- [ ] **Step 1: Başarısız testleri yaz**

`backoff.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { notifyBackoffMs, RetryableNotifyError } from './backoff';

describe('notifyBackoffMs', () => {
  it('follows the spec schedule', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => notifyBackoffMs(n))).toEqual([10_000, 30_000, 120_000, 600_000, 1_800_000, 1_800_000]);
  });
  it('honours retry_after when larger', () => {
    expect(notifyBackoffMs(1, new RetryableNotifyError('429', 45_000))).toBe(45_000);
    expect(notifyBackoffMs(3, new RetryableNotifyError('429', 1_000))).toBe(120_000);
  });
});
```

`apps/worker/test/notify.e2e.spec.ts` (`FakeTelegramApi` başlatılır; `process.env.TELEGRAM_BOT_TOKEN = fake.token; process.env.TELEGRAM_API_BASE = apiBase; process.env.PUBLIC_BASE_URL = 'https://otofirsat.example'` **createContext'ten önce** ayarlanır; `NotificationsModule` + `MatchingModule` yüklenir; `NOTIFY_WORKER_AUTOSTART=false`, testler `NotifyService.process`'i doğrudan çağırır, son test host'u başlatıp uçtan uca doğrular). Senaryolar (her biri gerçek kodla):

```ts
describe('NotifyService', () => {
  it('IN_APP: publishes a UserEvent on user:<id> and marks SENT with latencyMs', async () => {
    // Redis duplicate() ile `user:<id>` kanalına abone ol; eşleşme üret; IN_APP bildirimi için process(id, {attemptsMade:0,maxAttempts:5}).
    // Beklenen: { kind:'DONE', status:'SENT' }; mesaj userEventSchema'ya uyar ve notification.id eşleşir; DB: SENT, sentAt dolu, attempts 1,
    // latencyMs = sentAt - listing.firstSeenAt (±1000 ms).
  });
  it('TELEGRAM: sends the rendered message with buttons to the decrypted chatId', async () => {
    // fake.requests son istek: method 'sendMessage', body.chat_id === kanalın chatId'si, body.text spec şablonunun ilk satırını içerir,
    // reply_markup 'Favorile' callback'i 'fav:<listingId>' içerir; DB SENT.
  });
  it('TELEGRAM: photo with bad URL falls back to sendMessage once', async () => {
    // listing.imageUrl = 'https://img.example/x.jpg'; fake.respondNext('sendPhoto', 400 'wrong file identifier/HTTP URL specified');
    // Beklenen istekler: sendPhoto sonra sendMessage; SENT.
  });
  it('TELEGRAM 429: returns RETRY with retryAfterMs, increments attempts; last attempt marks FAILED', async () => {
    // respondNext 429 retry_after 7 → { kind:'RETRY', retryAfterMs: 7000 }, DB PENDING attempts 1 lastError içerir '429'.
    // Aynı bildirim için process(id, {attemptsMade:4, maxAttempts:5}) + 502 → { kind:'DONE', status:'FAILED' }, DB FAILED.
  });
  it('TELEGRAM 403 blocked: FAILED, channel disabled, SECURITY in-app warning published; other pending TELEGRAM fail as CHANNEL_UNAVAILABLE', async () => {
    // İki eşleşme → iki TELEGRAM PENDING. İlki 403 'Forbidden: bot was blocked by the user' → DONE FAILED;
    // kanal isEnabled=false; kullanıcıya kind SECURITY, channel IN_APP, status SENT, payload.type 'TELEGRAM_DISABLED' bildirimi + Redis yayını.
    // İkinci bildirim process → DONE FAILED, lastError 'CHANNEL_UNAVAILABLE', fake'e yeni sendMessage isteği GİTMEZ.
  });
  it('per-chat throttle returns THROTTLED without consuming an attempt', async () => {
    // Aynı chat'e art arda iki gönderim: ikincisi { kind:'THROTTLED', retryAfterMs > 0 }, DB attempts değişmez.
  });
  it('re-checks plan channels at send time', async () => {
    // Planlamadan sonra kullanıcıya limitOverrides { channels:['IN_APP'] } ver → TELEGRAM process → DONE FAILED 'CHANNEL_UNAVAILABLE'.
  });
  it('is idempotent: non-PENDING notifications are skipped', async () => {
    // SENT bir bildirim için process → { kind:'DONE', status:'SKIPPED' }, fake'e istek yok.
  });
  it('host end-to-end: queued TELEGRAM job is sent by the worker', async () => {
    // NotifyWorkerHost.start(); eşleşme üret → fake.requests'te sendMessage görünene kadar bekle (waitFor ≤20 sn); DB SENT.
  });
});
```

`env.spec.ts` → `NOTIFY_CONCURRENCY` varsayılan 8 ve sınırlar (0 ve 33 reddedilir); `TELEGRAM_BOT_TOKEN` yokken geçerli; `PUBLIC_BASE_URL` varsayılanı.

Run: `pnpm --filter @oto/worker test && pnpm --filter @oto/worker exec vitest run --config vitest.e2e.config.ts test/notify.e2e.spec.ts` → FAIL.

- [ ] **Step 2: Uygula**

`backoff.ts`:

```ts
const SCHEDULE = [10_000, 30_000, 120_000, 600_000, 1_800_000];

export class RetryableNotifyError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'RetryableNotifyError';
  }
}

/** BullMQ özel backoff stratejisi: attemptsMade = şimdiye kadar başarısız deneme sayısı (≥1). */
export function notifyBackoffMs(attemptsMade: number, err?: unknown): number {
  const base = SCHEDULE[Math.min(Math.max(attemptsMade, 1), SCHEDULE.length) - 1];
  const hint = err instanceof RetryableNotifyError ? (err.retryAfterMs ?? 0) : 0;
  return Math.max(base, hint);
}
```

`in-app.adapter.ts`:

```ts
import { Injectable } from '@nestjs/common';
import type { Notification } from '@oto/db';
import { userEventChannel, type UserEvent } from '@oto/shared';
import { RedisService } from '../infra/redis.service';
import type { SendResult } from './notify.service';

@Injectable()
export class InAppAdapter {
  constructor(private readonly redis: RedisService) {}

  /** Kayıt zaten DB'de; "gönderim" = canlı panellere yayın. Çevrimdışı kullanıcı kaydı sonradan görür. */
  async send(n: Notification): Promise<SendResult> {
    const event: UserEvent = {
      type: 'notification',
      notification: { id: n.id, kind: n.kind, channel: 'IN_APP', status: 'SENT', payload: n.payload, createdAt: n.createdAt.toISOString() },
    };
    try {
      await this.redis.publish(userEventChannel(n.userId), JSON.stringify(event));
      return { kind: 'SENT' };
    } catch (err) {
      return { kind: 'RETRYABLE', error: err instanceof Error ? err.message : String(err) };
    }
  }
}
```

`telegram.adapter.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Notification } from '@oto/db';
import { matchNotificationPayloadSchema } from '@oto/shared';
import { Encryptor, hashToken } from '@oto/server-common';
import { classifyTelegramError, isPhotoFallbackError, renderMatchMessage, type TelegramClient } from '@oto/telegram';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { RedisService } from '../infra/redis.service';
import type { SendResult } from './notify.service';

export const TELEGRAM_CLIENT = Symbol('TELEGRAM_CLIENT');
const CHAT_GAP_MS = 1100;

@Injectable()
export class TelegramAdapter {
  constructor(
    @Inject(TELEGRAM_CLIENT) private readonly client: TelegramClient | null,
    private readonly encryptor: Encryptor,
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async send(n: Notification, channelConfig: string): Promise<SendResult> {
    if (!this.client) return { kind: 'PERMANENT', error: 'TELEGRAM_DISABLED' };
    const { chatId } = this.encryptor.decryptJson<{ chatId: number }>(channelConfig);
    // Sohbet başına 1 msj/sn (spec §5.4); kilit alınamazsa deneme hakkı yemeden ertele.
    const gate = await this.redis.set(`tg:chat:${hashToken(String(chatId))}`, '1', 'PX', CHAT_GAP_MS, 'NX');
    if (gate !== 'OK') return { kind: 'THROTTLED', retryAfterMs: CHAT_GAP_MS };
    const parsed = matchNotificationPayloadSchema.safeParse(n.payload);
    if (!parsed.success) return { kind: 'PERMANENT', error: 'INVALID_PAYLOAD' };
    const msg = renderMatchMessage(parsed.data, { publicBaseUrl: this.env.PUBLIC_BASE_URL });
    try {
      if (msg.photoUrl) {
        try {
          await this.client.sendPhoto(chatId, msg.photoUrl, msg.text, msg.replyMarkup);
          return { kind: 'SENT' };
        } catch (err) {
          if (!isPhotoFallbackError(err)) throw err;
        }
      }
      await this.client.sendMessage(chatId, msg.text, msg.replyMarkup);
      return { kind: 'SENT' };
    } catch (err) {
      const c = classifyTelegramError(err);
      return c.kind === 'RETRYABLE'
        ? { kind: 'RETRYABLE', error: c.error, retryAfterMs: c.retryAfterMs }
        : { kind: 'PERMANENT', error: c.error, disableChannel: c.disableChannel };
    }
  }
}
```

`notify.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { resolveUserPlan } from '@oto/db';
import { userEventChannel, type UserEvent } from '@oto/shared';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { InAppAdapter } from './in-app.adapter';
import { TelegramAdapter } from './telegram.adapter';

export type SendResult =
  | { kind: 'SENT' }
  | { kind: 'RETRYABLE'; error: string; retryAfterMs?: number }
  | { kind: 'PERMANENT'; error: string; disableChannel?: boolean }
  | { kind: 'THROTTLED'; retryAfterMs: number };

export type NotifyResult =
  | { kind: 'DONE'; status: 'SENT' | 'FAILED' | 'SKIPPED' }
  | { kind: 'RETRY'; error: string; retryAfterMs?: number }
  | { kind: 'THROTTLED'; retryAfterMs: number };

const short = (s: string) => s.slice(0, 500);

@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly inApp: InAppAdapter,
    private readonly telegram: TelegramAdapter,
  ) {}

  async process(notificationId: number, attempt: { attemptsMade: number; maxAttempts: number }): Promise<NotifyResult> {
    const n = await this.prisma.notification.findUnique({ where: { id: notificationId }, include: { user: { select: { id: true, status: true } } } });
    if (!n || n.status !== 'PENDING') return { kind: 'DONE', status: 'SKIPPED' };
    if (n.user.status !== 'ACTIVE') return this.fail(n.id, 'USER_INACTIVE');

    let result: SendResult;
    if (n.channel === 'IN_APP') {
      result = await this.inApp.send(n);
    } else if (n.channel === 'TELEGRAM') {
      const channel = await this.prisma.notificationChannel.findUnique({ where: { userId_type: { userId: n.userId, type: 'TELEGRAM' } } });
      const plan = await resolveUserPlan(this.prisma, n.userId);
      if (!channel?.config || !channel.isEnabled || !channel.isVerified || !plan.limits.channels.includes('TELEGRAM')) {
        return this.fail(n.id, 'CHANNEL_UNAVAILABLE');
      }
      result = await this.telegram.send(n, channel.config);
    } else {
      return this.fail(n.id, 'UNSUPPORTED_CHANNEL');
    }

    if (result.kind === 'THROTTLED') return result;
    if (result.kind === 'SENT') {
      const sentAt = new Date();
      const firstSeen = Date.parse((n.payload as { listing?: { firstSeenAt?: string } })?.listing?.firstSeenAt ?? '');
      await this.prisma.notification.updateMany({
        where: { id: n.id, status: 'PENDING' },
        data: { status: 'SENT', sentAt, attempts: { increment: 1 }, lastError: null, latencyMs: Number.isFinite(firstSeen) ? sentAt.getTime() - firstSeen : null },
      });
      return { kind: 'DONE', status: 'SENT' };
    }
    if (result.kind === 'PERMANENT') {
      if (result.disableChannel) await this.disableTelegram(n.userId, result.error);
      return this.fail(n.id, result.error);
    }
    // RETRYABLE
    const last = attempt.attemptsMade + 1 >= attempt.maxAttempts;
    if (last) return this.fail(n.id, result.error);
    await this.prisma.notification.update({ where: { id: n.id }, data: { attempts: { increment: 1 }, lastError: short(result.error) } });
    return { kind: 'RETRY', error: result.error, retryAfterMs: result.retryAfterMs };
  }

  private async fail(id: number, error: string): Promise<NotifyResult> {
    await this.prisma.notification.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'FAILED', attempts: { increment: 1 }, lastError: short(error) } });
    return { kind: 'DONE', status: 'FAILED' };
  }

  /** Bot engellendi / sohbet yok: kanal kapatılır, kullanıcı panelde uyarılır (spec §5.4). */
  private async disableTelegram(userId: string, reason: string): Promise<void> {
    const res = await this.prisma.notificationChannel.updateMany({ where: { userId, type: 'TELEGRAM', isEnabled: true }, data: { isEnabled: false } });
    if (res.count === 0) return;
    const warn = await this.prisma.notification.create({
      data: { userId, kind: 'SECURITY', channel: 'IN_APP', status: 'SENT', sentAt: new Date(), payload: { type: 'TELEGRAM_DISABLED', reason: short(reason) } },
    });
    const event: UserEvent = {
      type: 'notification',
      notification: { id: warn.id, kind: 'SECURITY', channel: 'IN_APP', status: 'SENT', payload: warn.payload, createdAt: warn.createdAt.toISOString() },
    };
    await this.redis.publish(userEventChannel(userId), JSON.stringify(event)).catch((err: unknown) => this.logger.warn(`Uyarı yayınlanamadı: ${String(err)}`));
    this.logger.warn(`Kullanıcı ${userId} Telegram kanalı kapatıldı: ${reason}`);
  }
}
```

(401 `Unauthorized` sınıflandırması `PERMANENT, disableChannel:false` döner; `NotifyService` bunu `FAILED` yapar — ek olarak `error.includes('(401)')` ise `logger.error('Telegram bot token geçersiz')` yaz.)

`notify-worker.host.ts`:

```ts
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { notifyJobSchema, QueueName, type NotifyJobData } from '@oto/shared';
import { DelayedError, UnrecoverableError, Worker, type Job } from 'bullmq';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { bullConnection } from '../infra/bull';
import { notifyBackoffMs, RetryableNotifyError } from '../notifications/backoff';
import { NotifyService } from '../notifications/notify.service';

export const NOTIFY_WORKER_AUTOSTART = Symbol('NOTIFY_WORKER_AUTOSTART');

@Injectable()
export class NotifyWorkerHost implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotifyWorkerHost.name);
  private workers: Worker<NotifyJobData>[] = [];

  constructor(
    private readonly notify: NotifyService,
    @Inject(ENV) private readonly env: Env,
    @Optional() @Inject(NOTIFY_WORKER_AUTOSTART) private readonly autostart: boolean = true,
  ) {}

  onModuleInit(): void {
    if (this.autostart) this.start();
  }

  start(): void {
    if (this.workers.length) return;
    const processor = async (job: Job<NotifyJobData>, token?: string) => {
      const parsed = notifyJobSchema.safeParse(job.data);
      if (!parsed.success) throw new UnrecoverableError(`Geçersiz bildirim işi: ${parsed.error.message}`);
      const r = await this.notify.process(parsed.data.notificationId, { attemptsMade: job.attemptsMade, maxAttempts: job.opts.attempts ?? 1 });
      if (r.kind === 'THROTTLED') {
        await job.moveToDelayed(Date.now() + r.retryAfterMs, token);
        throw new DelayedError();
      }
      if (r.kind === 'RETRY') throw new RetryableNotifyError(r.error, r.retryAfterMs);
    };
    const common = {
      connection: bullConnection(this.env.REDIS_URL),
      settings: { backoffStrategy: (attemptsMade: number, _type?: string, err?: Error) => notifyBackoffMs(attemptsMade, err) },
    };
    this.workers = [
      new Worker<NotifyJobData>(QueueName.NOTIFY, processor, { ...common, concurrency: this.env.NOTIFY_CONCURRENCY }),
      new Worker<NotifyJobData>(QueueName.NOTIFY_TELEGRAM, processor, { ...common, concurrency: 5, limiter: { max: 25, duration: 1000 } }),
    ];
    for (const w of this.workers) {
      w.on('error', (err) => this.logger.error(`Bildirim worker hatası: ${err.message}`));
      w.on('failed', (job, err) => this.logger.warn(`Bildirim işi ${job?.id} başarısız (deneme ${job?.attemptsMade}): ${err.message}`));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    this.workers = [];
  }
}
```

`notifications.module.ts` → `providers: [NotificationDispatcher, InAppAdapter, TelegramAdapter, NotifyService, { provide: TELEGRAM_CLIENT, inject: [ENV], useFactory: (env: Env) => (env.TELEGRAM_BOT_TOKEN ? new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN, apiBase: env.TELEGRAM_API_BASE }) : null) }]`, `exports: [NotificationDispatcher, NotifyService]`. `worker-app.module.ts` → `NotificationsModule` import + `NotifyWorkerHost`. `env.ts` → yeni alanlar (`TELEGRAM_BOT_TOKEN: z.string().min(1).optional()`, `TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org')`, `PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000')`, `NOTIFY_CONCURRENCY`). `.env.example`'a `NOTIFY_CONCURRENCY=8` ekle; `@oto/telegram`'ı worker bağımlılığına ekle (`pnpm --filter @oto/worker add @oto/telegram@workspace:*`).

- [ ] **Step 3: Testler**

Run: `pnpm --filter @oto/telegram build && pnpm --filter @oto/worker test && pnpm --filter @oto/worker exec vitest run --config vitest.e2e.config.ts && pnpm lint && pnpm typecheck && pnpm --filter @oto/worker build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/worker .env.example pnpm-lock.yaml
git commit -m "feat(worker): deliver notifications via in-app pub/sub and Telegram with retries, throttling and channel disabling"
```

---

### Task 6: API — kullanıcı olayları (pub/sub), `/me/notifications` ve SSE akışı

**Files:**
- Create: `apps/api/src/infra/user-events.service.ts`, `apps/api/src/modules/me/notifications.repository.ts`, `apps/api/src/modules/me/notifications.controller.ts`, `apps/api/test/notifications.e2e.spec.ts`, `apps/api/test/sse.ts`
- Modify: `apps/api/src/infra/infra.module.ts`, `apps/api/src/modules/me/me.module.ts`, `apps/api/src/modules/auth/auth.service.ts` (SECURITY bildirimini yayınla), `apps/api/test/isolation.e2e.spec.ts`, `apps/api/test/helpers.ts`

**Interfaces:**
- Consumes: `userEventChannel`, `userEventSchema`, `UserEvent`, `listNotificationsQuerySchema`, `markNotificationsReadSchema` (Task 1).
- Produces:
  - `UserEventsService.publish(userId: string, event: UserEvent): Promise<void>`; `UserEventsService.stream(userId: string): Observable<UserEvent>` — tek paylaşılan abone bağlantısı (`redis.duplicate()`), `psubscribe('user:*')`, kullanıcı başına yerel abone kümesi; modül kapanırken bağlantı kapanır.
  - `GET /me/notifications` → `{ items: NotificationView[], nextCursor: number | null, unreadCount: number }`; `NotificationView { id, kind, channel, status, attempts, lastError: string|null, payload, sentAt, readAt, createdAt }`
  - `POST /me/notifications/read` → `{ updated: number }` (yalnızca kullanıcının IN_APP ve okunmamış bildirimleri)
  - `GET /me/notifications/stream` (SSE): olaylar `ready` (`{ unreadCount }`), `notification` (`UserEvent.notification`), `ping` (25 sn); 15 dk sonra akış tamamlanır.
  - Test helpers: `loginCookie(app, email, password): Promise<string>`, `seedNotification(app, userId, over?)`; `apps/api/test/sse.ts` → `openSse(app, cookie): Promise<{ events: Array<{ event: string; data: any }>; waitFor(pred, ms?): Promise<...>; close(): void }>` (Node `http.request` ile `app.listen(0)` sunucusuna bağlanır, `text/event-stream` gövdesini ayrıştırır).

- [ ] **Step 1: Başarısız testleri yaz**

`apps/api/test/notifications.e2e.spec.ts`:

```ts
describe('/me/notifications', () => {
  it('lists own notifications newest first with unreadCount and cursor pagination', async () => {
    // A için 3 IN_APP (1 okunmuş) + 1 TELEGRAM FAILED (lastError 'CHANNEL_UNAVAILABLE') seed et; B için 1.
    // GET → items id azalan, unreadCount 2, B'ninki yok; ?limit=2 → nextCursor; ikinci sayfa kalan 2, nextCursor null.
    // ?channel=TELEGRAM&status=FAILED → yalnızca o; ?unread=true → 2 IN_APP; ?cursor=3000000000 → 400.
  });
  it('marks read by ids (ignoring foreign/other-channel ids) and all', async () => {
    // A'nın iki IN_APP id'si + B'nin bir id'si + A'nın TELEGRAM id'si → { updated: 2 }; B'ninki readAt null kalır.
    // { all: true } → kalan IN_APP okunmamışlar; unreadCount 0. {} → 400.
  });
  it('SSE: sends ready, then live notifications for the owner only, and pings', async () => {
    // openSse(A) ve openSse(B); ilk olay 'ready' { unreadCount }; UserEventsService.publish(A.id, event) →
    // A 'notification' alır (id eşleşir), B 500 ms içinde hiçbir 'notification' almaz. Akışları kapat.
  });
  it('refresh-token reuse SECURITY notification is published live', async () => {
    // A için SSE aç; A'nın eski refresh cookie'si ile yeniden kullanım tetikle (session.e2e'deki yöntem) → A 'notification' (kind SECURITY, payload.type REFRESH_REUSED) alır.
  });
});
```
(Bunları gerçek kodla yaz; `seedNotification` doğrudan `PrismaService.notification.create` kullanır. SSE ping'i test etmek için `UserEventsService`/controller'daki ping aralığını `SSE_PING_MS` sabitinden okut ve testte bekleme yapma — ping'i yalnızca birim düzeyinde, aralık sabitinin 25_000 olduğunu doğrulayarak test et.)

`isolation.e2e.spec.ts` `CASES` → `'GET /me/notifications'`, `'POST /me/notifications/read'`, `'GET /me/notifications/stream'` (B'nin akışı A'ya yayınlanan olayı almaz; pozitif kontrol: A'nın akışı alır).

Run: `pnpm --filter @oto/api exec vitest run -c vitest.e2e.config.ts test/notifications.e2e.spec.ts test/isolation.e2e.spec.ts` → FAIL.

- [ ] **Step 2: Uygula**

`apps/api/src/infra/user-events.service.ts`:

```ts
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { userEventChannel, userEventSchema, type UserEvent } from '@oto/shared';
import type Redis from 'ioredis';
import { Observable } from 'rxjs';
import { RedisService } from './redis.service';

type Listener = (e: UserEvent) => void;

@Injectable()
export class UserEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(UserEventsService.name);
  private sub?: Redis;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly redis: RedisService) {}

  async publish(userId: string, event: UserEvent): Promise<void> {
    await this.redis.publish(userEventChannel(userId), JSON.stringify(event));
  }

  stream(userId: string): Observable<UserEvent> {
    return new Observable<UserEvent>((subscriber) => {
      this.ensureSubscribed();
      const fn: Listener = (e) => subscriber.next(e);
      const set = this.listeners.get(userId) ?? new Set<Listener>();
      set.add(fn);
      this.listeners.set(userId, set);
      return () => {
        set.delete(fn);
        if (set.size === 0) this.listeners.delete(userId);
      };
    });
  }

  private ensureSubscribed(): void {
    if (this.sub) return;
    this.sub = this.redis.duplicate();
    void this.sub.psubscribe(userEventChannel('*')).catch((err: unknown) => this.logger.error(`Abonelik başarısız: ${String(err)}`));
    this.sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
      const userId = channel.slice(userEventChannel('').length);
      const set = this.listeners.get(userId);
      if (!set?.size) return;
      let parsed: UserEvent;
      try {
        parsed = userEventSchema.parse(JSON.parse(message));
      } catch {
        this.logger.warn(`Geçersiz kullanıcı olayı yok sayıldı (${channel})`);
        return;
      }
      for (const fn of set) fn(parsed);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.sub?.quit().catch(() => undefined);
  }
}
```

`InfraModule` → `UserEventsService`'i sağla ve dışa aktar.

`notifications.repository.ts` (yalnızca userId kapsamlı sorgular):

```ts
@Injectable()
export class NotificationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string, q: ListNotificationsQuery) {
    return this.prisma.notification.findMany({
      where: {
        userId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.channel ? { channel: q.channel } : {}),
        ...(q.unread !== undefined ? (q.unread ? { channel: 'IN_APP', readAt: null } : { readAt: { not: null } }) : {}),
        ...(q.cursor ? { id: { lt: q.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
    });
  }

  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, channel: 'IN_APP', readAt: null } });
  }

  async markRead(userId: string, input: MarkNotificationsReadInput): Promise<number> {
    const res = await this.prisma.notification.updateMany({
      where: { userId, channel: 'IN_APP', readAt: null, ...('ids' in input ? { id: { in: input.ids } } : {}) },
      data: { readAt: new Date() },
    });
    return res.count;
  }
}
```
(`?unread=false` ve `?channel=TELEGRAM` birlikte verilirse spread sırası `channel`'ı ezebilir — `unread` filtresini `AND` dizisiyle birleştir ki iki filtre birlikte uygulanırsın; test `?unread=true` ile `channel` vermeden çalışır.)

`notifications.controller.ts`:

```ts
export const SSE_PING_MS = 25_000;
export const SSE_MAX_LIFETIME_MS = 15 * 60_000;

@Controller('me/notifications')
export class NotificationsController {
  constructor(
    private readonly repo: NotificationsRepository,
    private readonly events: UserEventsService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query(new ZodPipe(listNotificationsQuerySchema)) q: ListNotificationsQuery) {
    const [rows, unreadCount] = await Promise.all([this.repo.list(user.id, q), this.repo.unreadCount(user.id)]);
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((n) => ({
        id: n.id, kind: n.kind, channel: n.channel, status: n.status, attempts: n.attempts, lastError: n.lastError,
        payload: n.payload, sentAt: n.sentAt, readAt: n.readAt, createdAt: n.createdAt,
      })),
      nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
      unreadCount,
    };
  }

  @Post('read')
  @HttpCode(200)
  async read(@CurrentUser() user: AuthUser, @Body(new ZodPipe(markNotificationsReadSchema)) body: MarkNotificationsReadInput) {
    return { updated: await this.repo.markRead(user.id, body) };
  }

  @Sse('stream')
  stream(@CurrentUser() user: AuthUser): Observable<MessageEvent> {
    const ready$ = defer(() => from(this.repo.unreadCount(user.id))).pipe(map((unreadCount) => ({ type: 'ready', data: { unreadCount } }) as MessageEvent));
    const live$ = this.events.stream(user.id).pipe(map((e) => ({ type: 'notification', data: e.notification }) as MessageEvent));
    const ping$ = interval(SSE_PING_MS).pipe(map(() => ({ type: 'ping', data: {} }) as MessageEvent));
    return concat(ready$, merge(live$, ping$)).pipe(takeUntil(timer(SSE_MAX_LIFETIME_MS)));
  }
}
```
(`MessageEvent` → `@nestjs/common`; rxjs operatörleri `defer, from, map, concat, merge, interval, takeUntil, timer`.)

`me.module.ts` → controller ve repository kaydı. `auth.service.ts` → `REFRESH_REUSED` bildirimi oluşturulduktan sonra `UserEventsService.publish(...)` (hata loglanır, akışı bozmaz).

- [ ] **Step 3: Testler**

Run: `pnpm --filter @oto/api exec vitest run -c vitest.e2e.config.ts && pnpm --filter @oto/api test && pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(api): add /me/notifications list, read and live SSE stream over Redis pub/sub"
```

---

### Task 7: API — Telegram bağlama, güncelleme işleyici (webhook/polling) ve `/me/channels`

**Files:**
- Create: `apps/api/src/modules/telegram/{telegram.module,telegram.config,telegram-update.handler,telegram-webhook.controller,telegram-polling.service}.ts`, `apps/api/src/modules/me/{channels.repository,channels.service,channels.controller}.ts`, `apps/api/test/channels.e2e.spec.ts`, `apps/api/test/telegram.e2e.spec.ts`
- Modify: `apps/api/src/config/env.ts`, `env.spec.ts`, `apps/api/src/app.module.ts`, `apps/api/src/modules/me/me.module.ts`, `apps/api/package.json` (`@oto/telegram`), `apps/api/test/isolation.e2e.spec.ts`, `.env.example`

**Interfaces:**
- Consumes: `TelegramClient`, `TelegramUpdate`, `FakeTelegramApi` (Task 3); `UserEventsService` (Task 6); `generateToken`, `hashToken`, `Encryptor`; `LimitsService.forUser` (emailVerified, limits).
- Produces:
  - env: `TELEGRAM_BOT_TOKEN?`, `TELEGRAM_BOT_USERNAME?` (token varsa zorunlu), `TELEGRAM_MODE: 'polling'|'webhook'` (varsayılan polling), `TELEGRAM_WEBHOOK_SECRET?` (webhook + token ise zorunlu, `^[A-Za-z0-9_-]{32,256}$`), `TELEGRAM_API_BASE` (varsayılan `https://api.telegram.org`).
  - `TELEGRAM_API` token: `TelegramClient | null`; `TELEGRAM_POLLING_AUTOSTART` token (varsayılan true; testte false).
  - `TelegramUpdateHandler.handle(update: TelegramUpdate): Promise<void>`
  - `POST /api/v1/telegram/webhook` (`@Public`, `@SkipCsrf`, `@SkipThrottle`): yalnızca `TELEGRAM_MODE=webhook` ve token varken; başlık eşleşmezse 401; her zaman hızlı 200 (`{ ok: true }`), işleyici hatası loglanır.
  - `GET /me/channels` → `{ items: [{ type: 'IN_APP', isVerified: true, isEnabled: true }, { type: 'TELEGRAM', linked: boolean, isVerified, isEnabled }], telegramAvailable: boolean }` (config/chatId asla)
  - `POST /me/channels/telegram/link` → `{ deepLink: 'https://t.me/<bot>?start=<code>', expiresAt }`; 403 `EMAIL_NOT_VERIFIED`, 403 `LIMIT_REACHED {channel:'TELEGRAM'}`, 503 `FEATURE_DISABLED`; `@Throttle 5/dk`.
  - `PATCH /me/channels/:type` `{isEnabled}` → TELEGRAM için güncel görünüm; IN_APP → 400 `INVALID_OPERATION`; bağlı değilse 404; etkinleştirme plan TELEGRAM içermiyorsa 403 `LIMIT_REACHED`.
  - `DELETE /me/channels/telegram` → 204 / 404.

- [ ] **Step 1: Başarısız testleri yaz**

`apps/api/test/telegram.e2e.spec.ts` (`FakeTelegramApi` başlat; **createTestApp'ten önce** `process.env.TELEGRAM_BOT_TOKEN = fake.token`, `TELEGRAM_BOT_USERNAME='otofirsat_test_bot'`, `TELEGRAM_MODE='webhook'`, `TELEGRAM_WEBHOOK_SECRET='s'.repeat(40)`, `TELEGRAM_API_BASE=apiBase`; dosya sonunda bu env'leri sil):

```ts
const hook = (body: unknown, secret = 's'.repeat(40)) =>
  newAgent(app).post('/api/v1/telegram/webhook').set('X-Telegram-Bot-Api-Secret-Token', secret).send(body);

describe('Telegram link flow', () => {
  it('verified user links via deep link code; bot confirms; panel gets SECURITY notification', async () => {
    // A doğrula (verifyEmail); POST /me/channels/telegram/link → deepLink 't.me/otofirsat_test_bot?start=<code>' ve expiresAt ~10 dk.
    // hook({ update_id: 1, message: { chat: { id: 555 }, text: `/start ${code}` } }) → 200.
    // DB: TELEGRAM kanalı isVerified/isEnabled true; config şifreli (chatId '555' düz metin olarak config'te YOK); externalIdHash = hashToken('555').
    // fake.requests: sendMessage chat_id 555, metin '✅' içerir. A'nın bildirimlerinde kind SECURITY payload.type TELEGRAM_LINKED.
    // GET /me/channels → TELEGRAM linked true; yanıt '555' içermez.
  });
  it('rejects bad, expired, reused codes and unverified accounts with a bot reply', async () => {
    // Kod iki kez kullanılırsa ikinci bağlamaz; expiresAt geçmişe çekilen kod bağlamaz; rastgele kod bağlamaz;
    // kod üretildikten sonra kullanıcının emailVerifiedAt'i null yapılırsa bağlamaz. Her durumda bot 'geçersiz' içeren yanıt gönderir, kanal oluşmaz.
  });
  it('new link code invalidates the previous one', async () => {});
  it('Favorile callback adds a favorite for the linked user and answers the callback', async () => {
    // Bağla; seedListing; hook({ update_id: 9, callback_query: { id: 'cb1', data: `fav:${listingId}`, message: { chat: { id: 555 } } } })
    // → Favorite(userId, listingId) var; answerCallbackQuery 'Favorilere eklendi'. Tekrarlanırsa tek kayıt. Bilinmeyen ilan → 'İlan bulunamadı'.
  });
  it('my_chat_member kicked disables the channel', async () => {});
  it('webhook rejects a wrong secret with 401 and does nothing', async () => {});
});
```

`apps/api/test/channels.e2e.spec.ts` (Telegram env'i ayarlanmadan — kapalı durum + PATCH/DELETE):

```ts
describe('/me/channels', () => {
  it('lists IN_APP and TELEGRAM (not linked) and reports telegramAvailable=false when unconfigured', async () => {});
  it('link without configuration → 503 FEATURE_DISABLED; unverified → 403 EMAIL_NOT_VERIFIED', async () => {
    // Doğrulanmamış kullanıcı önce EMAIL_NOT_VERIFIED almalı mı yoksa FEATURE_DISABLED mı? Sıra: FEATURE_DISABLED (503) önce kontrol edilir. Testi buna göre yaz.
  });
  it('PATCH TELEGRAM toggles a linked channel; IN_APP → 400; unlinked → 404; DELETE unlinks', async () => {
    // Kanalı doğrudan DB'ye (Encryptor ile) ekleyerek bağlı durumu kur.
  });
});
```
(Hepsini gerçek kodla yaz.)

`isolation.e2e.spec.ts` `CASES` → `'GET /me/channels'`, `'POST /me/channels/telegram/link'`, `'PATCH /me/channels/:type'`, `'DELETE /me/channels/telegram'` (B, A'nın kanalını değiştiremez/göremez; A'nın kanalı DB'de doğrudan kurulur; pozitif kontroller).

`env.spec.ts` → token varken kullanıcı adı zorunlu; webhook + token iken gizli anahtar zorunlu ve ≥32; polling varsayılan.

Run: `pnpm --filter @oto/api exec vitest run -c vitest.e2e.config.ts test/telegram.e2e.spec.ts test/channels.e2e.spec.ts test/isolation.e2e.spec.ts && pnpm --filter @oto/api test` → FAIL.

- [ ] **Step 2: Uygula**

`env.ts` → yeni alanlar + `superRefine` (mevcut `z.object`'i `.superRefine` ile genişlet; `Env` tipi korunur):

```ts
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    TELEGRAM_BOT_USERNAME: z.string().regex(/^[A-Za-z0-9_]{5,32}$/).optional(),
    TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),
    TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/).optional(),
    TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org'),
```
superRefine: token varsa `TELEGRAM_BOT_USERNAME` zorunlu; `TELEGRAM_MODE==='webhook'` ve token varsa `TELEGRAM_WEBHOOK_SECRET` zorunlu.

`telegram.module.ts` → providers: `{ provide: TELEGRAM_API, inject: [ENV], useFactory: env => env.TELEGRAM_BOT_TOKEN ? new TelegramClient({ token, apiBase }) : null }`, `TelegramUpdateHandler`, `TelegramPollingService`; controller `TelegramWebhookController`; exports `TELEGRAM_API`, `TelegramUpdateHandler`. `AppModule`'e eklenir. `MeModule` `TelegramModule`'ü import eder (link deep link için bot kullanıcı adı `ENV`'den okunur).

`telegram-update.handler.ts`:

```ts
@Injectable()
export class TelegramUpdateHandler {
  private readonly logger = new Logger(TelegramUpdateHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptor: Encryptor,
    private readonly events: UserEventsService,
    @Inject(TELEGRAM_API) private readonly bot: TelegramClient | null,
  ) {}

  async handle(u: TelegramUpdate): Promise<void> {
    if (!this.bot) return;
    if (u.message?.text?.startsWith('/start')) return this.onStart(u.message.chat.id, u.message.text.slice('/start'.length).trim());
    if (u.callback_query) return this.onCallback(u.callback_query);
    if (u.my_chat_member && ['kicked', 'left'].includes(u.my_chat_member.new_chat_member.status)) {
      await this.prisma.notificationChannel.updateMany({
        where: { type: 'TELEGRAM', externalIdHash: hashToken(String(u.my_chat_member.chat.id)) },
        data: { isEnabled: false },
      });
    }
  }

  private async onStart(chatId: number, code: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) {
      await this.reply(chatId, 'Merhaba! Hesabınızı bağlamak için panelde Ayarlar → "Telegram\'ı bağla" adımını kullanın.');
      return;
    }
    const now = new Date();
    const linked = await this.prisma.$transaction(async (tx) => {
      const token = await tx.telegramLinkToken.findUnique({ where: { codeHash: hashToken(code) }, include: { user: true } });
      if (!token || token.usedAt || token.expiresAt <= now) return null;
      if (token.user.status !== 'ACTIVE' || !token.user.emailVerifiedAt) return null;
      const used = await tx.telegramLinkToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: now } });
      if (used.count !== 1) return null;
      const data = { config: this.encryptor.encryptJson({ chatId }), externalIdHash: hashToken(String(chatId)), isVerified: true, isEnabled: true };
      await tx.notificationChannel.upsert({
        where: { userId_type: { userId: token.userId, type: 'TELEGRAM' } },
        update: data,
        create: { userId: token.userId, type: 'TELEGRAM', ...data },
      });
      return tx.notification.create({
        data: { userId: token.userId, kind: 'SECURITY', channel: 'IN_APP', status: 'SENT', sentAt: now, payload: { type: 'TELEGRAM_LINKED' } },
      });
    });
    if (!linked) {
      await this.reply(chatId, 'Bağlantı kodu geçersiz veya süresi dolmuş. Panelden yeni bir kod oluşturun.');
      return;
    }
    await this.events
      .publish(linked.userId, { type: 'notification', notification: { id: linked.id, kind: 'SECURITY', channel: 'IN_APP', status: 'SENT', payload: linked.payload, createdAt: linked.createdAt.toISOString() } })
      .catch((err: unknown) => this.logger.warn(`Bağlama olayı yayınlanamadı: ${String(err)}`));
    await this.reply(chatId, '✅ Hesabınız bağlandı. Eşleşen fırsatlar artık buraya gelecek.');
  }

  private async onCallback(cb: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const m = /^fav:(\d{1,10})$/.exec(cb.data ?? '');
    const chatId = cb.message?.chat.id;
    if (!m || chatId === undefined) return void (await this.answer(cb.id, 'Geçersiz işlem'));
    const listingId = Number(m[1]);
    const channels = await this.prisma.notificationChannel.findMany({
      where: { type: 'TELEGRAM', isVerified: true, externalIdHash: hashToken(String(chatId)), user: { status: 'ACTIVE' } },
      select: { userId: true },
    });
    if (channels.length === 0) return void (await this.answer(cb.id, 'Hesap bağlı değil'));
    const listing = await this.prisma.listing.findUnique({ where: { id: listingId }, select: { id: true } });
    if (!listing) return void (await this.answer(cb.id, 'İlan bulunamadı'));
    for (const c of channels) {
      await this.prisma.favorite.upsert({ where: { userId_listingId: { userId: c.userId, listingId } }, update: {}, create: { userId: c.userId, listingId } });
    }
    await this.answer(cb.id, 'Favorilere eklendi ⭐');
  }

  private async reply(chatId: number, text: string) {
    await this.bot?.sendMessage(chatId, text).catch((err: unknown) => this.logger.warn(`Bot yanıtı gönderilemedi: ${String(err)}`));
  }

  private async answer(id: string, text: string) {
    await this.bot?.answerCallbackQuery(id, text).catch((err: unknown) => this.logger.warn(`Callback yanıtlanamadı: ${String(err)}`));
  }
}
```

`telegram-webhook.controller.ts`:

```ts
@Public()
@SkipCsrf()
@SkipThrottle()
@Controller('telegram')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  constructor(
    private readonly handler: TelegramUpdateHandler,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(@Headers('x-telegram-bot-api-secret-token') secret: string | undefined, @Body() body: unknown) {
    const expected = this.env.TELEGRAM_WEBHOOK_SECRET;
    if (this.env.TELEGRAM_MODE !== 'webhook' || !this.env.TELEGRAM_BOT_TOKEN || !expected || !secret || !safeEqual(secret, expected)) {
      throw Errors.unauthenticated();
    }
    if (body && typeof body === 'object' && typeof (body as { update_id?: unknown }).update_id === 'number') {
      await this.handler.handle(body as TelegramUpdate).catch((err: unknown) => this.logger.error(`Telegram güncellemesi işlenemedi: ${String(err)}`));
    }
    return { ok: true };
  }
}
```
(`safeEqual` → `crypto.timingSafeEqual` ile eşit uzunluk kontrollü yardımcı. `@Body()` için global ZodPipe yoksa ham gövde kullanılır; JSON gövde boyutu mevcut `json-body.ts` sınırına tabidir.)

`telegram-polling.service.ts` → `OnApplicationBootstrap`: `TELEGRAM_MODE==='polling'`, `bot` mevcut ve `TELEGRAM_POLLING_AUTOSTART` true ise döngü: `getUpdates(offset, 25, abort.signal)` → her güncelleme `handler.handle` (hata loglanır) → `offset = update_id + 1`; hata olursa 5 sn bekle; `onModuleDestroy`'da `abort()` ve döngünün bitmesini bekle. `TELEGRAM_POLLING_AUTOSTART` sağlayıcısı varsayılan `process.env.NODE_ENV !== 'test'`.

`channels.repository.ts` (userId kapsamlı): `list(userId)`, `findTelegram(userId)`, `setTelegramEnabled(userId, isEnabled)` (updateMany, count), `deleteTelegram(userId)` (deleteMany, count), `createLinkCode(userId, codeHash, expiresAt)` (transaction: kullanıcının kullanılmamış kodlarını `usedAt=now` yap, yenisini oluştur).

`channels.service.ts`:

```ts
const LINK_TTL_MS = 10 * 60_000;

@Injectable()
export class ChannelsService {
  constructor(
    private readonly repo: ChannelsRepository,
    private readonly limits: LimitsService,
    @Inject(TELEGRAM_API) private readonly bot: TelegramClient | null,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async list(userId: string) {
    const tg = await this.repo.findTelegram(userId);
    return {
      items: [
        { type: 'IN_APP', isVerified: true, isEnabled: true },
        { type: 'TELEGRAM', linked: !!tg?.isVerified, isVerified: tg?.isVerified ?? false, isEnabled: tg?.isEnabled ?? false },
      ],
      telegramAvailable: !!this.bot,
    };
  }

  async createLink(userId: string) {
    if (!this.bot || !this.env.TELEGRAM_BOT_USERNAME) throw new AppError(ErrorCode.FEATURE_DISABLED, 503, 'Telegram bildirimleri şu anda kullanılamıyor');
    const lim = await this.limits.forUser(userId);
    if (!lim.emailVerified) throw new AppError(ErrorCode.EMAIL_NOT_VERIFIED, 403, "Telegram'ı bağlamak için önce e-postanızı doğrulayın");
    if (!lim.limits.channels.includes('TELEGRAM')) throw new AppError(ErrorCode.LIMIT_REACHED, 403, 'Planınız Telegram bildirimlerini içermiyor', { channel: 'TELEGRAM' });
    const code = generateToken(16);
    const expiresAt = new Date(Date.now() + LINK_TTL_MS);
    await this.repo.createLinkCode(userId, hashToken(code), expiresAt);
    return { deepLink: `https://t.me/${this.env.TELEGRAM_BOT_USERNAME}?start=${code}`, expiresAt };
  }

  async patch(userId: string, type: 'IN_APP' | 'TELEGRAM', isEnabled: boolean) {
    if (type === 'IN_APP') throw new AppError(ErrorCode.INVALID_OPERATION, 400, 'Uygulama içi bildirimler kapatılamaz');
    const tg = await this.repo.findTelegram(userId);
    if (!tg?.isVerified) throw Errors.notFound();
    if (isEnabled) {
      const lim = await this.limits.forUser(userId);
      if (!lim.limits.channels.includes('TELEGRAM')) throw new AppError(ErrorCode.LIMIT_REACHED, 403, 'Planınız Telegram bildirimlerini içermiyor', { channel: 'TELEGRAM' });
    }
    await this.repo.setTelegramEnabled(userId, isEnabled);
    return { type: 'TELEGRAM', linked: true, isVerified: true, isEnabled };
  }

  async unlink(userId: string): Promise<void> {
    if ((await this.repo.deleteTelegram(userId)) === 0) throw Errors.notFound();
  }
}
```
(`generateToken(16)` base64url ~22 karakter üretir; Telegram `start` parametresi ≤64 karakter `[A-Za-z0-9_-]`. `generateToken` farklı kodlama üretiyorsa `randomBytes(16).toString('base64url')` kullan.)

`channels.controller.ts` → `@Controller('me/channels')`: `GET`, `POST telegram/link` (`@Throttle({ default: { limit: 5, ttl: 60_000 } })`, `@HttpCode(201)`), `PATCH :type` (`ZodPipe(channelTypeParamSchema)` param + `patchChannelSchema` gövde), `DELETE telegram` (`@HttpCode(204)`).

`.env.example` → `TELEGRAM_MODE=polling`, `# TELEGRAM_BOT_TOKEN=`, `# TELEGRAM_BOT_USERNAME=`, `# TELEGRAM_WEBHOOK_SECRET=` (açıklamalı). `@oto/telegram` API bağımlılığına eklenir.

- [ ] **Step 3: Testler**

Run: `pnpm --filter @oto/api test && pnpm --filter @oto/api exec vitest run -c vitest.e2e.config.ts && pnpm lint && pnpm typecheck && pnpm --filter @oto/api build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api .env.example pnpm-lock.yaml
git commit -m "feat(api): add Telegram linking, webhook/polling update handling, favorite callback and /me/channels"
```

---

### Task 8: Uçtan uca hat (fırsat → eşleşme → IN_APP + Telegram), dokümantasyon, smoke test

**Files:**
- Modify: `apps/worker/test/pipeline.e2e.spec.ts`, `README.md`, `docs/architecture.md`, `docs/superpowers/plans/2026-10-10-00-roadmap.md`, `.env.example`
- Create: `docs/notifications.md`

- [ ] **Step 1: Pipeline testini genişlet**

`pipeline.e2e.spec.ts`: `FakeTelegramApi` başlat ve env'i (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_BASE`, `PUBLIC_BASE_URL='https://otofirsat.example'`) createContext'ten önce ayarla; `ProcessorTestModule`'e `NotificationsModule` + `NotifyWorkerHost` (autostart false) ekle ve analiz/eşleştirme worker'larının başlatıldığı yerde başlat. Mevcut "injected deal" testinde kullanıcıya `createChannel` ile doğrulanmış Telegram kanalı ver, profilin `channels: ['IN_APP','TELEGRAM']` olsun. Sonda:

```ts
    const sent = await waitFor(async () => {
      const rows = await prisma.notification.findMany({ where: { userId: user.id, matchId: match.id } });
      return rows.length === 2 && rows.every((r) => r.status === 'SENT') ? rows : null;
    }, 30_000);
    expect(sent.map((r) => r.channel).sort()).toEqual(['IN_APP', 'TELEGRAM']);
    expect(sent.every((r) => (r.latencyMs ?? -1) >= 0)).toBe(true);
    const tg = fake.requests.find((r) => r.method === 'sendMessage' || r.method === 'sendPhoto');
    expect(tg?.body.chat_id).toBe(<kanal chatId>);
    expect(String(tg?.body.text ?? tg?.body.caption)).toContain('Fiyat analizi tahminidir');
```
3 kez çalıştırıp kararlılığı doğrula; kararsızsa kök nedeni bul.

- [ ] **Step 2: Dokümantasyon**

`docs/notifications.md` (Türkçe): akış şeması (eşleşme tx → Notification PENDING → dispatcher → `notify`/`notify-telegram` → adapter → SENT/FAILED), kanal seçimi formülü, günlük limit ve kilitler, yeniden deneme takvimi ve `retry_after`, sohbet başına kısıt, kalıcı hatalar ve kanal kapatma, süpürme, SSE olay sözleşmesi (`ready`/`notification`/`ping`, 15 dk), `/me/notifications` ve `/me/channels`, Telegram kurulumu (BotFather, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, dev'de polling, prod'da `setWebhook` + `secret_token` komutu örneği: `curl -X POST https://api.telegram.org/bot<TOKEN>/setWebhook -d url=https://<alan>/api/v1/telegram/webhook -d secret_token=<SECRET>`), bağlama akışı, en-az-bir-kez teslim notu, mesaj şablonu örneği.

`docs/architecture.md`, `README.md` (env tablosu: `NOTIFY_CONCURRENCY`, `TELEGRAM_*`, worker `PUBLIC_BASE_URL`), `.env.example`'ı güncelle.

Yol haritasına `## Plan 05 sonrası taşınan maddeler` ekle (en az): **Plan 06:** zil sayacı + toast + opsiyonel ses SSE `ready`/`notification` olaylarıyla; bildirim listesinde `limitExceeded` için "Limit aşıldı" etiketi; Ayarlar'da Telegram bağlama (deepLink, 10 dk geri sayım, `telegramAvailable=false` durumu); `SECURITY` bildirim türleri için metinler. **Plan 07:** admin bildirim ekranı (tekli/toplu yeniden kuyruğa alma + audit, spec §5.6), `latencyMs` p50/p95; Telegram kapalı/token geçersiz alarmı. **Plan 08:** prod'da webhook kurulumu ve gizli anahtar rotasyonu; 90 gün bildirim temizliği (KVKK); `notify` kuyruk metrikleri. **Borç:** en-az-bir-kez teslim (gönderim sonrası DB yazımı başarısızsa yineleme olabilir); `notify` işi kuyrukta beklerken plan/kanal değişirse gönderim anında yeniden kontrol edilir (bilinçli). Plan 04 sonrası Plan 05 maddelerini "TAMAMLANDI" olarak işaretle.

- [ ] **Step 3: Tüm doğrulama**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm --filter @oto/worker build && pnpm --filter @oto/api build`
Expected: PASS.

- [ ] **Step 4: Canlı smoke test**

Dev compose açık; `pnpm -r build`, migrate + seed. Gerçek Telegram token'ı yoksa API ve worker'ı `FakeTelegramApi` ile çalıştır: küçük bir script (`node -e` veya scratchpad'de `.mjs`) `FakeTelegramApi`'yi başlatıp `apiBase`'i yazdırır; API (`TELEGRAM_MODE=polling` değil `webhook`, gizli anahtarla) ve worker bu `TELEGRAM_API_BASE` ile başlatılır. Kullanıcı kaydı → e-posta doğrulama (DB) → `POST /me/channels/telegram/link` → webhook'a `/start <kod>` gönder → profil (`channels: ['IN_APP','TELEGRAM']`, `minDiscountPct: 0`) → DEMO_SIZE=2000 tarama → SSE akışını curl ile dinle (`curl -N`), `GET /me/notifications` ve sahte API istek sayısını raporla. Tüm başlatılan süreçleri durdur.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/test/pipeline.e2e.spec.ts docs README.md .env.example
git commit -m "test(worker): extend pipeline through notification delivery; document notifications"
```
