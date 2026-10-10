# Plan 01 — Temel Altyapı + Kimlik Doğrulama Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Çalışan bir pnpm monorepo, tam veritabanı şeması ve güvenli çok kullanıcılı kimlik doğrulama sunan NestJS API'si (kayıt, giriş, refresh rotasyonu, e-posta doğrulama, şifre sıfırlama, `/me`, RBAC'li admin kullanıcı yönetimi, audit, kullanıcılar arası izolasyon testi).

**Architecture:** pnpm workspaces: `packages/shared` (zod şemaları, hata kodları), `packages/db` (Prisma şeması, migration, seed), `apps/api` (NestJS 11, Express 5). Global guard zinciri: CSRF → JWT (cookie) → Roles (DB'den canlı doğrulama) → Throttler (Redis). Testler: Vitest birim + Testcontainers (Postgres 16, Redis 7) ile e2e.

**Tech Stack:** Node 22, TypeScript 5.6, pnpm 10, NestJS 11, Prisma 6, PostgreSQL 16 (citext), Redis 7 + ioredis, zod 3, jose 5 (EdDSA), argon2, nestjs-pino, @nestjs/throttler 6, nodemailer, Vitest 3 + unplugin-swc, Supertest, Testcontainers.

**Spec:** `docs/superpowers/specs/2026-10-10-oto-firsat-platformu-design.md` (bu plan §1, §2, §6, §7-Auth/Me/Admin-users, §9, §10, §11'in ilgili kısımlarını uygular). Yol haritası: `docs/superpowers/plans/2026-10-10-00-roadmap.md`.

## Global Constraints

- Node `>=22`; paket yöneticisi `pnpm@10.30.3`; tüm kod TypeScript `strict`.
- Monorepo düzeni: `apps/api`, `packages/shared`, `packages/db` (ileride `apps/worker`, `apps/web`, `apps/demo-site`, `packages/analysis`).
- API base path `/api/v1`; JSON camelCase; tarihler ISO-8601 UTC; para tam sayı TL ve JSON'da string.
- Hata gövdesi daima `{ "error": { "code", "message", "details"? } }`; kodlar `packages/shared/src/errors.ts`'te; stack trace istemciye gitmez.
- Uç noktalar varsayılan kapalı; anonim erişim yalnızca `@Public()` ile.
- Şifre: argon2id, memoryCost 65536 KiB, timeCost 3, parallelism 1; uzunluk 10–128.
- Access JWT EdDSA, 15 dk, cookie `access_token` (path `/`); refresh 32 bayt rastgele, 30 gün, cookie `refresh_token` (path `/api/v1/auth`); ikisi de httpOnly + `SameSite=Lax` + `Secure` (`COOKIE_SECURE`).
- Refresh rotasyonu + yeniden kullanım tespiti; 10 sn yarış toleransı.
- Mutasyonlarda `X-Requested-With` başlığı zorunlu; `Origin` varsa `PUBLIC_BASE_URL` ile aynı olmalı.
- Rate limit: genel 120/dk (kullanıcı, yoksa IP); `/auth/*` 10/dk/IP. Giriş kilidi: IP+e-posta başına 15 dk'da 5 hatalı deneme.
- Şifre sıfırlama tokenı 30 dk, e-posta doğrulama tokenı 24 saat; tek kullanımlık, DB'de yalnızca SHA-256 hash.
- Başka kullanıcıya ait kaynak → **404**. `apps/api/src/modules/me/**` altında doğrudan Prisma erişimi yasak (yalnızca `*.repository.ts`).
- Secret'lar yalnızca env'den; açılışta zod ile doğrulanır. Loglarda `password`, `token`, `cookie`, `authorization`, `chatId`, `config`, `proxy*` alanları maskelenir.
- Kullanıcıya dönen mesajlar Türkçe; kod, commit ve tanımlayıcılar İngilizce.
- Her admin mutasyonu `AuditLog`'a yazılır.

## Review Focus

1. **Büyük/küçük harf ve boşluklu e-posta** (`"  User@Example.COM "`): aynı hesap sayılmalı; ikinci kayıt 409 vermeli. → Task 6 testi.
2. **İki sekmenin aynı anda refresh yapması**: kullanıcı oturumdan atılmamalı; ikinci istek 401 `REFRESH_RACE` alır, oturum ailesi iptal edilmez. → Task 5 eşzamanlılık testi + Task 6 e2e.
3. **Askıya alınmış veya rolü düşürülmüş admin elinde hâlâ geçerli access token**: admin uç noktalarına erişememeli (401/403). → Task 9 testleri.
4. **Bozuk, süresi dolmuş ya da sahte cookie**: 500 değil 401 dönmeli. → Task 6 testi.
5. **Bozuk JSON, aşırı büyük gövde, 10.000 karakterlik isim, 1 MB şifre**: 400/413 dönmeli; argon2 asla 128 karakterden uzun girdiyle çalışmamalı. → Task 3 + Task 6 testleri.

## Ön Koşullar

- Docker Desktop çalışır durumda olmalı (Testcontainers ve dev DB için). Kontrol: `docker info` hata vermemeli.
- `corepack enable` çalıştırılmış olmalı.

## Dosya Haritası

```
package.json · pnpm-workspace.yaml · tsconfig.base.json · eslint.config.mjs · .prettierrc
.env.example · docker-compose.dev.yml · scripts/gen-keys.mjs · .github/workflows/ci.yml
packages/shared/  src/{index,errors,enums,plan,time}.ts  src/schemas/{auth,me,admin}.ts  src/*.spec.ts
packages/db/      prisma/schema.prisma  prisma/migrations/20261010000000_init/  prisma/seed.ts
                  src/{index,seed-data,argon2}.ts  test/schema.spec.ts
apps/api/src/
  main.ts  app.module.ts  bootstrap.ts  types/express.d.ts
  config/{env,config.module}.ts
  infra/{prisma.service,redis.service,infra.module}.ts
  common/errors/{app-error,all-exceptions.filter}.ts
  common/{zod.pipe,json-body,client-meta,logger}.ts
  common/decorators/{public,roles,current-user,skip-csrf}.ts
  common/guards/{csrf.guard,jwt-auth.guard,roles.guard,throttler.guard}.ts
  common/crypto/{encryptor,tokens,crypto.module}.ts
  common/audit/{audit.service,audit.interceptor,audited.decorator,audit.module}.ts
  modules/health/{health.controller,health.module}.ts
  modules/mail/{mail.service,templates,mail.module}.ts
  modules/auth/{auth.constants,auth-user,cookies,public-user,password.service,token.service,
                session.service,login-attempt.service,email-verification.service,
                password-reset.service,auth.service,auth.controller,auth.module}.ts
  modules/me/{me.repository,me.service,me.controller,me.module}.ts
  modules/admin/{admin-users.service,admin-users.controller,admin.module}.ts
apps/api/test/
  global-setup.ts  setup-env.ts  helpers.ts  routes.ts
  health.e2e.spec.ts  session.e2e.spec.ts  auth.e2e.spec.ts  email-flows.e2e.spec.ts
  me.e2e.spec.ts  admin-users.e2e.spec.ts  isolation.e2e.spec.ts  audit-coverage.e2e.spec.ts
  lint/me-prisma-rule.spec.ts
```

---

### Task 1: Monorepo iskeleti, araçlar ve `@oto/shared`

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc`, `.editorconfig`, `.env.example`, `docker-compose.dev.yml`, `scripts/gen-keys.mjs`, `.github/workflows/ci.yml`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/tsconfig.build.json`, `packages/shared/src/index.ts`, `packages/shared/src/errors.ts`, `packages/shared/src/enums.ts`, `packages/shared/src/plan.ts`, `packages/shared/src/time.ts`, `packages/shared/src/schemas/auth.ts`, `packages/shared/src/schemas/me.ts`, `packages/shared/src/schemas/admin.ts`
- Test: `packages/shared/src/schemas.spec.ts`, `packages/shared/src/time.spec.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `ErrorCode` (const object + type), `ApiErrorBody`; `Role`, `UserStatus`, `ChannelType` const objects; `planLimitsSchema`, `PlanLimits`; `startOfIstanbulDay(d: Date): Date`; zod şemaları ve çıkarım tipleri: `registerSchema/RegisterInput`, `loginSchema/LoginInput`, `verifyEmailSchema`, `forgotPasswordSchema`, `resetPasswordSchema/ResetPasswordInput`, `updateMeSchema/UpdateMeInput`, `changePasswordSchema/ChangePasswordInput`, `deleteMeSchema/DeleteMeInput`, `adminUsersQuerySchema/AdminUsersQuery`.

- [ ] **Step 1: Kök dosyaları oluştur**

`package.json`:
```json
{
  "name": "oto-fiyat-yakalama",
  "private": true,
  "packageManager": "pnpm@10.30.3",
  "engines": { "node": ">=22" },
  "scripts": {
    "build:packages": "pnpm -r --filter \"./packages/*\" build",
    "build": "pnpm -r build",
    "lint": "eslint .",
    "typecheck": "pnpm build:packages && pnpm -r typecheck",
    "test": "pnpm build:packages && pnpm -r test",
    "test:e2e": "pnpm build:packages && pnpm -r test:e2e",
    "db:up": "docker compose -f docker-compose.dev.yml up -d",
    "db:down": "docker compose -f docker-compose.dev.yml down",
    "db:migrate": "pnpm --filter @oto/db migrate:deploy",
    "db:seed": "pnpm --filter @oto/db seed",
    "keys:gen": "node scripts/gen-keys.mjs",
    "dev:api": "pnpm --filter @oto/api dev"
  },
  "devDependencies": {
    "@eslint/js": "^9.17.0",
    "eslint": "^9.17.0",
    "globals": "^15.14.0",
    "prettier": "^3.4.2",
    "typescript": "^5.6.3",
    "typescript-eslint": "^8.18.0"
  }
}
```

`pnpm-workspace.yaml` (pnpm 10 bağımlılık build script'lerini varsayılan olarak çalıştırmaz; native modüller için izin listesi şart):
```yaml
packages:
  - "apps/*"
  - "packages/*"
onlyBuiltDependencies:
  - argon2
  - prisma
  - "@prisma/client"
  - "@prisma/engines"
  - "@swc/core"
  - esbuild
  - cpu-features
  - ssh2
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2023"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "noImplicitOverride": true
  }
}
```

`eslint.config.mjs`:
```js
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', '**/coverage/**', 'packages/db/prisma/migrations/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
```

`.prettierrc`:
```json
{ "singleQuote": true, "trailingComma": "all", "printWidth": 110 }
```

`.editorconfig`:
```ini
root = true
[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
```

`docker-compose.dev.yml`:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: oto
      POSTGRES_PASSWORD: oto
      POSTGRES_DB: oto
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U oto"]
      interval: 5s
      retries: 10
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
  mailpit:
    image: axllent/mailpit:v1.21
    ports: ["1025:1025", "8025:8025"]
volumes:
  pgdata:
```

`scripts/gen-keys.mjs`:
```js
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const oneLine = (pem) => pem.trim().replace(/\n/g, '\\n');
console.log(`JWT_PRIVATE_KEY="${oneLine(privateKey.export({ type: 'pkcs8', format: 'pem' }))}"`);
console.log(`JWT_PUBLIC_KEY="${oneLine(publicKey.export({ type: 'spki', format: 'pem' }))}"`);
console.log(`DATA_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
```

`.env.example`:
```dotenv
# --- Çalışma ortamı ---
NODE_ENV=development
PORT=3001
LOG_LEVEL=info
# Tarayıcının uygulamaya eriştiği adres (cookie/Origin kontrolü ve e-posta linkleri için)
PUBLIC_BASE_URL=http://localhost:3000
# Yerelde HTTP kullanıldığı için false; production'da true olmalı
COOKIE_SECURE=false

# --- Veritabanı / Redis (docker-compose.dev.yml ile uyumlu) ---
DATABASE_URL=postgresql://oto:oto@localhost:5432/oto
REDIS_URL=redis://localhost:6379

# --- Gizli anahtarlar: `pnpm keys:gen >> .env` ile üretin ---
# JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
# JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
# DATA_ENCRYPTION_KEY=<base64, 32 bayt>

# --- E-posta (dev: Mailpit, arayüz http://localhost:8025) ---
MAIL_TRANSPORT=smtp
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_FROM="Oto Fırsat <no-reply@localhost>"

# --- Güvenlik ---
# Şifreleri HaveIBeenPwned k-anonymity API'siyle kontrol et (dış erişim gerekir)
HIBP_ENABLED=false

# --- Seed: ilk süper admin ---
SEED_ADMIN_EMAIL=admin@example.com
SEED_ADMIN_PASSWORD=change-me-please-123
```

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build:packages
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm test:e2e
```

`.gitignore` dosyasına ekle (mevcut satırları koru):
```
*.tsbuildinfo
```

- [ ] **Step 2: `@oto/shared` paket dosyalarını oluştur**

`packages/shared/package.json`:
```json
{
  "name": "@oto/shared",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^3.24.1" },
  "devDependencies": { "vitest": "^3.0.5" }
}
```

`packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["node"] },
  "include": ["src"]
}
```

`packages/shared/tsconfig.build.json`:
```json
{ "extends": "./tsconfig.json", "exclude": ["src/**/*.spec.ts"] }
```

Kökte `pnpm add -D -w @types/node@^22` çalıştır (tüm paketler `types: ["node"]` kullanıyor).

- [ ] **Step 3: Başarısız testleri yaz**

`packages/shared/src/schemas.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { adminUsersQuerySchema, loginSchema, registerSchema, updateMeSchema } from './index';

describe('registerSchema', () => {
  const valid = { email: 'user@example.com', password: 'a-strong-pass', name: 'Ali', kvkkAccepted: true };

  it('trims and lowercases the email', () => {
    const r = registerSchema.parse({ ...valid, email: '  User@Example.COM ' });
    expect(r.email).toBe('user@example.com');
  });

  it('requires kvkkAccepted to be exactly true', () => {
    expect(registerSchema.safeParse({ ...valid, kvkkAccepted: false }).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(registerSchema.safeParse({ ...valid, role: 'SUPER_ADMIN' }).success).toBe(false);
  });

  it('enforces password length 10..128', () => {
    expect(registerSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, password: 'x'.repeat(129) }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, password: 'x'.repeat(128) }).success).toBe(true);
  });

  it('rejects names longer than 80 chars', () => {
    expect(registerSchema.safeParse({ ...valid, name: 'a'.repeat(10_000) }).success).toBe(false);
  });
});

describe('loginSchema', () => {
  it('caps password at 128 chars so argon2 never sees huge input', () => {
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'x'.repeat(129) }).success).toBe(false);
  });
});

describe('updateMeSchema', () => {
  it('trims the name and rejects blank', () => {
    expect(updateMeSchema.parse({ name: '  Ayşe  ' }).name).toBe('Ayşe');
    expect(updateMeSchema.safeParse({ name: '   ' }).success).toBe(false);
  });
});

describe('adminUsersQuerySchema', () => {
  it('coerces paging and applies defaults', () => {
    expect(adminUsersQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(adminUsersQuerySchema.parse({ page: '2', pageSize: '50' })).toEqual({ page: 2, pageSize: 50 });
  });

  it('rejects pageSize above 100', () => {
    expect(adminUsersQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
  });
});
```

`packages/shared/src/time.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { startOfIstanbulDay } from './time';

describe('startOfIstanbulDay', () => {
  it('returns 21:00Z of previous UTC day for late Istanbul evening', () => {
    expect(startOfIstanbulDay(new Date('2026-10-10T20:59:59Z')).toISOString()).toBe('2026-10-09T21:00:00.000Z');
  });

  it('rolls over exactly at Istanbul midnight', () => {
    expect(startOfIstanbulDay(new Date('2026-10-10T21:00:00Z')).toISOString()).toBe('2026-10-10T21:00:00.000Z');
  });
});
```

- [ ] **Step 4: Bağımlılıkları kur ve testlerin başarısız olduğunu gör**

Run: `pnpm install && pnpm --filter @oto/shared test`
Expected: FAIL — `Cannot find module './index'` / `./time`.

- [ ] **Step 5: Kaynak dosyaları yaz**

`packages/shared/src/errors.ts`:
```ts
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  CSRF_REJECTED: 'CSRF_REJECTED',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  LOGIN_LOCKED: 'LOGIN_LOCKED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  REFRESH_REUSED: 'REFRESH_REUSED',
  REFRESH_RACE: 'REFRESH_RACE',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  INVALID_OPERATION: 'INVALID_OPERATION',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}
```

`packages/shared/src/enums.ts`:
```ts
export const Role = { USER: 'USER', ADMIN: 'ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' } as const;
export type Role = (typeof Role)[keyof typeof Role];

export const UserStatus = { ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED', DELETED: 'DELETED' } as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const ChannelType = { IN_APP: 'IN_APP', TELEGRAM: 'TELEGRAM', EMAIL: 'EMAIL' } as const;
export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType];
```

`packages/shared/src/plan.ts`:
```ts
import { z } from 'zod';

export const planLimitsSchema = z.object({
  maxSearchProfiles: z.number().int().min(0),
  maxNotificationsPerDay: z.number().int().min(0),
  channels: z.array(z.enum(['IN_APP', 'TELEGRAM', 'EMAIL'])).min(1),
  opportunitiesDelayHours: z.number().int().min(0),
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;
```

`packages/shared/src/time.ts`:
```ts
const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000; // Türkiye UTC+3, yaz saati yok
const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfIstanbulDay(d: Date): Date {
  return new Date(Math.floor((d.getTime() + ISTANBUL_OFFSET_MS) / DAY_MS) * DAY_MS - ISTANBUL_OFFSET_MS);
}
```

`packages/shared/src/schemas/auth.ts`:
```ts
import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const newPasswordSchema = z.string().min(10).max(128);
const anyPasswordSchema = z.string().min(1).max(128);
const tokenSchema = z.string().min(20).max(200);

export const registerSchema = z
  .object({
    email: emailSchema,
    password: newPasswordSchema,
    name: z.string().trim().min(1).max(80),
    kvkkAccepted: z.literal(true),
  })
  .strict();
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({ email: emailSchema, password: anyPasswordSchema }).strict();
export type LoginInput = z.infer<typeof loginSchema>;

export const verifyEmailSchema = z.object({ token: tokenSchema }).strict();
export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();
export const resetPasswordSchema = z.object({ token: tokenSchema, newPassword: newPasswordSchema }).strict();
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export { anyPasswordSchema };
```

`packages/shared/src/schemas/me.ts`:
```ts
import { z } from 'zod';
import { anyPasswordSchema, newPasswordSchema } from './auth';

export const updateMeSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export type UpdateMeInput = z.infer<typeof updateMeSchema>;

export const changePasswordSchema = z
  .object({ currentPassword: anyPasswordSchema, newPassword: newPasswordSchema })
  .strict();
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const deleteMeSchema = z.object({ password: anyPasswordSchema }).strict();
export type DeleteMeInput = z.infer<typeof deleteMeSchema>;
```

`packages/shared/src/schemas/admin.ts`:
```ts
import { z } from 'zod';

export const adminUsersQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']).optional(),
    role: z.enum(['USER', 'ADMIN', 'SUPER_ADMIN']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;
```

`packages/shared/src/index.ts`:
```ts
export * from './errors';
export * from './enums';
export * from './plan';
export * from './time';
export * from './schemas/auth';
export * from './schemas/me';
export * from './schemas/admin';
```

- [ ] **Step 6: Testleri, lint'i ve build'i çalıştır**

Run: `pnpm --filter @oto/shared test && pnpm --filter @oto/shared build && pnpm lint`
Expected: Tüm testler PASS; `packages/shared/dist/index.js` oluşur; lint hatasız.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo, tooling, CI and @oto/shared"
```

---

### Task 2: `@oto/db` — Prisma şeması, ilk migration, seed

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/tsconfig.build.json`, `packages/db/vitest.config.ts`, `packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/migration_lock.toml`, `packages/db/prisma/migrations/20261010000000_init/migration.sql` (üretilir + elle ek), `packages/db/prisma/seed.ts`, `packages/db/src/index.ts`, `packages/db/src/argon2.ts`, `packages/db/src/seed-data.ts`
- Test: `packages/db/test/schema.spec.ts`

**Interfaces:**
- Consumes: `PlanLimits` (`@oto/shared`).
- Produces: `@oto/db` paketi; `@prisma/client`'ın tüm export'ları (`PrismaClient`, `Prisma`, enum'lar `Role`, `UserStatus`, `ChannelType` vb.), `ARGON2_OPTIONS`, `PLAN_SEEDS`, `seedPlans(prisma: PrismaClient): Promise<void>`, `seedSuperAdmin(prisma: PrismaClient, input: { email: string; password: string; name: string }): Promise<User>`.

- [ ] **Step 1: Paket dosyalarını oluştur**

`packages/db/package.json`:
```json
{
  "name": "@oto/db",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "generate": "prisma generate",
    "build": "prisma generate && tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "migrate:deploy": "dotenv -e ../../.env -- prisma migrate deploy",
    "migrate:dev": "dotenv -e ../../.env -- prisma migrate dev",
    "seed": "dotenv -e ../../.env -- tsx prisma/seed.ts",
    "test:e2e": "vitest run"
  },
  "dependencies": {
    "@oto/shared": "workspace:*",
    "@prisma/client": "^6.5.0",
    "argon2": "^0.41.1"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "^10.18.0",
    "dotenv-cli": "^8.0.0",
    "prisma": "^6.5.0",
    "tsx": "^4.19.2",
    "vitest": "^3.0.5"
  }
}
```

`packages/db/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": ".", "types": ["node"] },
  "include": ["src", "prisma/seed.ts", "test"]
}
```

`packages/db/tsconfig.build.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["node"] },
  "include": ["src"]
}
```

`packages/db/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.spec.ts'], testTimeout: 60_000, hookTimeout: 180_000 },
});
```

- [ ] **Step 2: Prisma şemasını yaz** (`packages/db/prisma/schema.prisma`)

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [citext]
}

enum Role { USER ADMIN SUPER_ADMIN }
enum UserStatus { ACTIVE SUSPENDED DELETED }
enum SubscriptionStatus { ACTIVE CANCELED EXPIRED }
enum ChannelType { IN_APP TELEGRAM EMAIL }
enum SourceKind { HTTP BROWSER API FEED }
enum PermissionType { LICENSED_API PARTNER_FEED TOS_PERMITTED TEST }
enum SourceHealth { HEALTHY DEGRADED DOWN PAUSED }
enum JobTrigger { SCHEDULED MANUAL }
enum JobStatus { QUEUED RUNNING SUCCEEDED FAILED PARTIAL }
enum ScrapeErrorKind { NETWORK TIMEOUT HTTP_4XX HTTP_5XX BLOCKED PARSE VALIDATION }
enum Fuel { GASOLINE DIESEL LPG HYBRID ELECTRIC OTHER }
enum Transmission { MANUAL AUTOMATIC SEMI_AUTOMATIC }
enum ListingStatus { ACTIVE REMOVED }
enum Confidence { HIGH MEDIUM LOW INSUFFICIENT }
enum AnalysisFlag { DAMAGED SUSPICIOUS_LOW HIGH_DISPERSION }
enum ProfileStatus { ACTIVE PAUSED }
enum MatchReason { NEW PRICE_DROP RELIST }
enum NotificationKind { MATCH SYSTEM_ALERT SECURITY }
enum NotificationStatus { PENDING SENT FAILED SKIPPED_LIMIT }
enum LogLevel { WARN ERROR }

// ---------- Kimlik ve abonelik ----------

model User {
  id                      String                   @id @default(cuid())
  email                   String                   @unique @db.Citext
  passwordHash            String
  name                    String
  role                    Role                     @default(USER)
  status                  UserStatus               @default(ACTIVE)
  emailVerifiedAt         DateTime?
  kvkkAcceptedAt          DateTime?
  lastLoginAt             DateTime?
  createdAt               DateTime                 @default(now())
  updatedAt               DateTime                 @updatedAt
  sessions                Session[]
  emailVerificationTokens EmailVerificationToken[]
  passwordResetTokens     PasswordResetToken[]
  subscriptions           UserSubscription[]
  channels                NotificationChannel[]
  telegramLinkTokens      TelegramLinkToken[]
  searchProfiles          SearchProfile[]
  matches                 ListingMatch[]
  notifications           Notification[]
  favorites               Favorite[]
  auditLogs               AuditLog[]               @relation("AuditActor")

  @@index([status, role])
}

model Session {
  id               String    @id @default(cuid())
  userId           String
  user             User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  familyId         String
  refreshTokenHash String    @unique
  userAgent        String?
  ip               String?
  expiresAt        DateTime
  revokedAt        DateTime?
  rotatedAt        DateTime?
  createdAt        DateTime  @default(now())

  @@index([userId])
  @@index([familyId])
}

model EmailVerificationToken {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash String    @unique
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())
}

model PasswordResetToken {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash String    @unique
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())
}

model SubscriptionPlan {
  id            String             @id @default(cuid())
  code          String             @unique
  name          String
  priceMonthly  Int                @default(0)
  isActive      Boolean            @default(true)
  limits        Json
  createdAt     DateTime           @default(now())
  updatedAt     DateTime           @updatedAt
  subscriptions UserSubscription[]
}

model UserSubscription {
  id             String             @id @default(cuid())
  userId         String
  user           User               @relation(fields: [userId], references: [id], onDelete: Cascade)
  planId         String
  plan           SubscriptionPlan   @relation(fields: [planId], references: [id])
  status         SubscriptionStatus @default(ACTIVE)
  startsAt       DateTime           @default(now())
  endsAt         DateTime?
  limitOverrides Json?
  createdAt      DateTime           @default(now())
  updatedAt      DateTime           @updatedAt

  @@index([userId, status])
}

// ---------- Bildirim kanalları ----------

model NotificationChannel {
  id         String      @id @default(cuid())
  userId     String
  user       User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  type       ChannelType
  config     String? // AES-256-GCM "v1:iv:tag:ct"
  isVerified Boolean     @default(false)
  isEnabled  Boolean     @default(true)
  createdAt  DateTime    @default(now())
  updatedAt  DateTime    @updatedAt

  @@unique([userId, type])
}

model TelegramLinkToken {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  codeHash  String    @unique
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())
}

// ---------- Kaynak ve toplama ----------

model DataSource {
  id                   Int             @id @default(autoincrement())
  code                 String          @unique
  name                 String
  adapterKey           String
  kind                 SourceKind
  permissionType       PermissionType
  permissionNote       String?
  permissionVerifiedAt DateTime?
  isActive             Boolean         @default(false)
  intervalSec          Int             @default(300)
  maxConcurrency       Int             @default(1)
  minRequestGapMs      Int             @default(2000)
  config               Json            @default("{}")
  proxyConfigId        Int?
  proxyConfig          ProxyConfig?    @relation(fields: [proxyConfigId], references: [id], onDelete: SetNull)
  health               SourceHealth    @default(HEALTHY)
  lastSuccessAt        DateTime?
  lastErrorAt          DateTime?
  consecutiveFailures  Int             @default(0)
  createdAt            DateTime        @default(now())
  updatedAt            DateTime        @updatedAt
  listings             Listing[]
  jobs                 CollectionJob[]
  errors               ScrapeError[]
  issues               ListingIssue[]
}

model ProxyConfig {
  id            Int          @id @default(autoincrement())
  name          String
  urlEncrypted  String
  isEnabled     Boolean      @default(true)
  lastCheckAt   DateTime?
  lastLatencyMs Int?
  lastError     String?
  createdAt     DateTime     @default(now())
  updatedAt     DateTime     @updatedAt
  sources       DataSource[]
}

model CollectionJob {
  id              Int           @id @default(autoincrement())
  sourceId        Int
  source          DataSource    @relation(fields: [sourceId], references: [id], onDelete: Cascade)
  trigger         JobTrigger
  dryRun          Boolean       @default(false)
  status          JobStatus     @default(QUEUED)
  startedAt       DateTime?
  finishedAt      DateTime?
  pagesFetched    Int           @default(0)
  listingsSeen    Int           @default(0)
  listingsNew     Int           @default(0)
  listingsUpdated Int           @default(0)
  errorsCount     Int           @default(0)
  avgResponseMs   Int?
  errorSummary    String?
  createdAt       DateTime      @default(now())
  errors          ScrapeError[]

  @@index([sourceId, createdAt])
  @@index([status])
}

model ScrapeError {
  id        Int             @id @default(autoincrement())
  jobId     Int?
  job       CollectionJob?  @relation(fields: [jobId], references: [id], onDelete: Cascade)
  sourceId  Int
  source    DataSource      @relation(fields: [sourceId], references: [id], onDelete: Cascade)
  kind      ScrapeErrorKind
  url       String?
  message   String
  transient Boolean
  createdAt DateTime        @default(now())

  @@index([sourceId, createdAt])
}

// ---------- İlan ----------

model Listing {
  id               Int                   @id @default(autoincrement())
  sourceId         Int
  source           DataSource            @relation(fields: [sourceId], references: [id], onDelete: Cascade)
  externalId       String
  url              String
  title            String
  imageUrl         String?
  make             String
  model            String
  trim             String?
  year             Int
  km               Int
  fuel             Fuel
  transmission     Transmission
  bodyType         String?
  color            String?
  city             String?
  sellerType       String?
  damageInfo       Json?
  price            BigInt
  currency         String                @default("TRY")
  contentHash      String
  status           ListingStatus         @default(ACTIVE)
  firstSeenAt      DateTime              @default(now())
  lastSeenAt       DateTime              @default(now())
  removedAt        DateTime?
  relistedAt       DateTime?
  latestAnalysisId Int?                  @unique
  latestAnalysis   ListingAnalysis?      @relation("LatestAnalysis", fields: [latestAnalysisId], references: [id], onDelete: SetNull)
  analyses         ListingAnalysis[]     @relation("ListingAnalyses")
  priceHistory     ListingPriceHistory[]
  issues           ListingIssue[]
  matches          ListingMatch[]
  favorites        Favorite[]
  createdAt        DateTime              @default(now())
  updatedAt        DateTime              @updatedAt

  @@unique([sourceId, externalId])
  @@index([make, model, year])
  @@index([status, firstSeenAt])
  @@index([make, model, fuel, transmission, year, km])
}

model ListingPriceHistory {
  id         Int      @id @default(autoincrement())
  listingId  Int
  listing    Listing  @relation(fields: [listingId], references: [id], onDelete: Cascade)
  price      BigInt
  km         Int
  observedAt DateTime @default(now())

  @@index([listingId, observedAt])
}

model ListingIssue {
  id         Int        @id @default(autoincrement())
  sourceId   Int
  source     DataSource @relation(fields: [sourceId], references: [id], onDelete: Cascade)
  listingId  Int?
  listing    Listing?   @relation(fields: [listingId], references: [id], onDelete: SetNull)
  externalId String?
  field      String
  problem    String
  rawSnippet String?
  createdAt  DateTime   @default(now())

  @@index([sourceId, createdAt])
}

model ListingAnalysis {
  id               Int            @id @default(autoincrement())
  listingId        Int
  listing          Listing        @relation("ListingAnalyses", fields: [listingId], references: [id], onDelete: Cascade)
  latestFor        Listing?       @relation("LatestAnalysis")
  engineVersion    String
  estimatedPrice   BigInt?
  priceDiff        BigInt?
  discountPct      Decimal?       @db.Decimal(6, 4)
  opportunityScore Int
  comparableCount  Int
  confidence       Confidence
  expansionLevel   Int?
  flags            AnalysisFlag[]
  explanation      Json
  comparableIds    Int[]
  createdAt        DateTime       @default(now())
  matches          ListingMatch[]

  @@index([listingId, createdAt])
  @@index([confidence, opportunityScore])
}

// ---------- Kullanıcı tarafı ----------

model SearchProfile {
  id                String         @id @default(cuid())
  userId            String
  user              User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  name              String
  status            ProfileStatus  @default(ACTIVE)
  make              String?
  model             String?
  yearMin           Int?
  yearMax           Int?
  priceMin          BigInt?
  priceMax          BigInt?
  kmMax             Int?
  fuels             Fuel[]
  transmissions     Transmission[]
  cities            String[]
  minDiscountPct    Decimal        @default(0) @db.Decimal(5, 4)
  minConfidence     Confidence     @default(MEDIUM)
  excludeDamaged    Boolean        @default(false)
  notifyOnPriceDrop Boolean        @default(true)
  priceDropPct      Decimal        @default(0.05) @db.Decimal(5, 4)
  notifyOnRelist    Boolean        @default(false)
  channels          ChannelType[]
  createdAt         DateTime       @default(now())
  updatedAt         DateTime       @updatedAt
  matches           ListingMatch[]

  @@index([status, make, model])
  @@index([userId])
}

model ListingMatch {
  id              Int             @id @default(autoincrement())
  userId          String
  user            User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  searchProfileId String
  searchProfile   SearchProfile   @relation(fields: [searchProfileId], references: [id], onDelete: Cascade)
  listingId       Int
  listing         Listing         @relation(fields: [listingId], references: [id], onDelete: Cascade)
  analysisId      Int
  analysis        ListingAnalysis @relation(fields: [analysisId], references: [id], onDelete: Cascade)
  reason          MatchReason
  matchedPrice    BigInt
  createdAt       DateTime        @default(now())
  notifications   Notification[]

  @@unique([searchProfileId, listingId, reason, matchedPrice])
  @@index([userId, createdAt])
}

model Notification {
  id        Int                @id @default(autoincrement())
  userId    String
  user      User               @relation(fields: [userId], references: [id], onDelete: Cascade)
  matchId   Int?
  match     ListingMatch?      @relation(fields: [matchId], references: [id], onDelete: Cascade)
  kind      NotificationKind   @default(MATCH)
  channel   ChannelType
  status    NotificationStatus @default(PENDING)
  attempts  Int                @default(0)
  lastError String?
  payload   Json
  sentAt    DateTime?
  readAt    DateTime?
  latencyMs Int?
  createdAt DateTime           @default(now())

  @@unique([matchId, channel])
  @@index([userId, createdAt])
  @@index([status, channel])
}

model Favorite {
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  listingId Int
  listing   Listing  @relation(fields: [listingId], references: [id], onDelete: Cascade)
  note      String?
  createdAt DateTime @default(now())

  @@id([userId, listingId])
}

// ---------- Sistem ----------

model AuditLog {
  id         Int      @id @default(autoincrement())
  actorId    String?
  actor      User?    @relation("AuditActor", fields: [actorId], references: [id], onDelete: SetNull)
  action     String
  targetType String?
  targetId   String?
  before     Json?
  after      Json?
  ip         String?
  createdAt  DateTime @default(now())

  @@index([createdAt])
  @@index([actorId, createdAt])
  @@index([action])
}

model SystemLog {
  id        Int      @id @default(autoincrement())
  level     LogLevel
  component String
  message   String
  context   Json?
  createdAt DateTime @default(now())

  @@index([createdAt])
  @@index([level, createdAt])
}

model SystemSetting {
  key       String   @id
  value     Json
  updatedAt DateTime @updatedAt
}

model MakeModelAlias {
  id      Int     @id @default(autoincrement())
  rawText String  @unique
  make    String
  model   String
  trim    String?
}
```

- [ ] **Step 3: İlk migration'ı üret ve check constraint ekle**

Run:
```bash
pnpm install
mkdir -p packages/db/prisma/migrations/20261010000000_init
pnpm --filter @oto/db exec prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script -o prisma/migrations/20261010000000_init/migration.sql
```
Expected: `migration.sql` oluşur ve `CREATE EXTENSION IF NOT EXISTS "citext";` içerir.

`packages/db/prisma/migrations/20261010000000_init/migration.sql` dosyasının **sonuna** ekle:
```sql
-- Spec §2: izin doğrulanmadan kaynak aktif edilemez
ALTER TABLE "DataSource"
  ADD CONSTRAINT "DataSource_active_requires_permission"
  CHECK (NOT "isActive" OR "permissionVerifiedAt" IS NOT NULL);
```

`packages/db/prisma/migrations/migration_lock.toml`:
```toml
provider = "postgresql"
```

- [ ] **Step 4: Başarısız testi yaz** (`packages/db/test/schema.spec.ts`)

```ts
import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Prisma, PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedPlans, seedSuperAdmin } from '../src/seed-data';

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

describe('schema', () => {
  it('seedPlans is idempotent and creates FREE/PRO/BUSINESS', async () => {
    await seedPlans(prisma);
    await seedPlans(prisma);
    const plans = await prisma.subscriptionPlan.findMany({ orderBy: { code: 'asc' } });
    expect(plans.map((p) => p.code)).toEqual(['BUSINESS', 'FREE', 'PRO']);
    const free = plans.find((p) => p.code === 'FREE')!;
    expect(free.limits).toMatchObject({ maxSearchProfiles: 2, maxNotificationsPerDay: 20 });
  });

  it('refuses to activate a data source without verified permission', async () => {
    await expect(
      prisma.dataSource.create({
        data: { code: 'x', name: 'X', adapterKey: 'x', kind: 'HTTP', permissionType: 'TEST', isActive: true },
      }),
    ).rejects.toThrow(/DataSource_active_requires_permission/);
  });

  it('enforces one listing per (source, externalId)', async () => {
    const src = await prisma.dataSource.create({
      data: { code: 'demo', name: 'Demo', adapterKey: 'demo-site', kind: 'HTTP', permissionType: 'TEST' },
    });
    const data = {
      sourceId: src.id, externalId: 'A1', url: 'http://x/1', title: 't', make: 'BMW', model: '3 Serisi',
      year: 2019, km: 85000, fuel: 'GASOLINE' as const, transmission: 'AUTOMATIC' as const,
      price: 960000n, contentHash: 'h',
    };
    await prisma.listing.create({ data });
    await expect(prisma.listing.create({ data })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('treats emails case-insensitively', async () => {
    await prisma.user.create({ data: { email: 'Case@Test.com', name: 'a', passwordHash: 'x' } });
    await expect(
      prisma.user.create({ data: { email: 'case@test.com', name: 'b', passwordHash: 'x' } }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('seedSuperAdmin is idempotent and never overwrites the password', async () => {
    const first = await seedSuperAdmin(prisma, { email: ' Boss@Example.com ', password: 'first-password-1', name: 'Boss' });
    const second = await seedSuperAdmin(prisma, { email: 'boss@example.com', password: 'other-password-2', name: 'Boss' });
    expect(second.id).toBe(first.id);
    expect(second.role).toBe('SUPER_ADMIN');
    expect(await argon2.verify(second.passwordHash, 'first-password-1')).toBe(true);
    const subs = await prisma.userSubscription.count({ where: { userId: first.id } });
    expect(subs).toBe(1);
  });
});
```

- [ ] **Step 5: Testin başarısız olduğunu gör**

Run: `pnpm --filter @oto/db exec prisma generate && pnpm --filter @oto/db test:e2e`
Expected: FAIL — `Cannot find module '../src/seed-data'`.

- [ ] **Step 6: Kaynak dosyaları yaz**

`packages/db/src/argon2.ts`:
```ts
import argon2 from 'argon2';

export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;
```

`packages/db/src/seed-data.ts`:
```ts
import type { PrismaClient, User } from '@prisma/client';
import type { PlanLimits } from '@oto/shared';
import argon2 from 'argon2';
import { ARGON2_OPTIONS } from './argon2';

// Fiyatlar Aşama 3'te (ödeme entegrasyonu) admin panelinden belirlenir; şimdilik 0.
export const PLAN_SEEDS: { code: string; name: string; priceMonthly: number; limits: PlanLimits }[] = [
  {
    code: 'FREE',
    name: 'Ücretsiz',
    priceMonthly: 0,
    limits: { maxSearchProfiles: 2, maxNotificationsPerDay: 20, channels: ['IN_APP', 'TELEGRAM'], opportunitiesDelayHours: 0 },
  },
  {
    code: 'PRO',
    name: 'Pro',
    priceMonthly: 0,
    limits: { maxSearchProfiles: 10, maxNotificationsPerDay: 200, channels: ['IN_APP', 'TELEGRAM', 'EMAIL'], opportunitiesDelayHours: 0 },
  },
  {
    code: 'BUSINESS',
    name: 'Business',
    priceMonthly: 0,
    limits: { maxSearchProfiles: 50, maxNotificationsPerDay: 2000, channels: ['IN_APP', 'TELEGRAM', 'EMAIL'], opportunitiesDelayHours: 0 },
  },
];

export async function seedPlans(prisma: PrismaClient): Promise<void> {
  for (const plan of PLAN_SEEDS) {
    // update: {} — admin'in sonradan yaptığı limit değişikliklerini ezmez
    await prisma.subscriptionPlan.upsert({ where: { code: plan.code }, update: {}, create: plan });
  }
}

export async function seedSuperAdmin(
  prisma: PrismaClient,
  input: { email: string; password: string; name: string },
): Promise<User> {
  const email = input.email.trim().toLowerCase();
  if (input.password.length < 10) throw new Error('SEED_ADMIN_PASSWORD en az 10 karakter olmalı');
  const free = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'FREE' } });
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return prisma.user.update({ where: { id: existing.id }, data: { role: 'SUPER_ADMIN', status: 'ACTIVE' } });
  }
  const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);
  const now = new Date();
  return prisma.user.create({
    data: {
      email,
      name: input.name,
      passwordHash,
      role: 'SUPER_ADMIN',
      emailVerifiedAt: now,
      kvkkAcceptedAt: now,
      subscriptions: { create: { planId: free.id } },
      channels: { create: { type: 'IN_APP', isVerified: true } },
    },
  });
}
```

`packages/db/src/index.ts`:
```ts
export * from '@prisma/client';
export * from './argon2';
export * from './seed-data';
```

`packages/db/prisma/seed.ts`:
```ts
import { PrismaClient } from '@prisma/client';
import { seedPlans, seedSuperAdmin } from '../src/seed-data';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await seedPlans(prisma);
    const email = process.env.SEED_ADMIN_EMAIL;
    const password = process.env.SEED_ADMIN_PASSWORD;
    if (email && password) {
      await seedSuperAdmin(prisma, { email, password, name: 'Süper Admin' });
      console.log(`Süper admin hazır: ${email}`);
    } else {
      console.warn('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD tanımlı değil; süper admin oluşturulmadı.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 7: Testleri çalıştır**

Run: `pnpm --filter @oto/db test:e2e && pnpm --filter @oto/db build && pnpm lint`
Expected: 5 test PASS; `packages/db/dist/index.js` oluşur.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(db): add full Prisma schema, init migration and seed data"
```

---

### Task 3: API iskeleti — env, hata formatı, loglama, health, test altyapısı

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/tsconfig.build.json`, `apps/api/nest-cli.json`, `apps/api/vitest.config.ts`, `apps/api/vitest.e2e.config.ts`
- Create: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/src/bootstrap.ts`, `apps/api/src/types/express.d.ts`, `apps/api/src/config/env.ts`, `apps/api/src/config/config.module.ts`, `apps/api/src/infra/prisma.service.ts`, `apps/api/src/infra/redis.service.ts`, `apps/api/src/infra/infra.module.ts`, `apps/api/src/common/errors/app-error.ts`, `apps/api/src/common/errors/all-exceptions.filter.ts`, `apps/api/src/common/zod.pipe.ts`, `apps/api/src/common/json-body.ts`, `apps/api/src/common/client-meta.ts`, `apps/api/src/common/logger.ts`, `apps/api/src/common/decorators/public.ts`, `apps/api/src/common/decorators/roles.ts`, `apps/api/src/common/decorators/skip-csrf.ts`, `apps/api/src/modules/health/health.controller.ts`, `apps/api/src/modules/health/health.module.ts`
- Create: `apps/api/test/global-setup.ts`, `apps/api/test/setup-env.ts`, `apps/api/test/helpers.ts`
- Test: `apps/api/src/config/env.spec.ts`, `apps/api/src/common/logger.spec.ts`, `apps/api/test/health.e2e.spec.ts`

**Interfaces:**
- Consumes: `ErrorCode` (`@oto/shared`), `seedPlans`, `PrismaClient`, `Role` (`@oto/db`).
- Produces:
  - `ENV` injection token, `Env` tipi, `parseEnv(source): Env`.
  - `PrismaService` (extends `PrismaClient`), `RedisService` (extends ioredis `Redis`), ikisi de `InfraModule` (global) ile.
  - `AppError(code, status, message, details?)` ve `Errors` fabrikası: `validation(details)`, `unauthenticated()`, `forbidden()`, `notFound()`, `invalidCredentials()`.
  - `ZodPipe<T>` (`new ZodPipe(schema)`), `jsonBody(limit)`, `ClientMeta { ip: string | null; userAgent: string | null }`, `@Meta()` param dekoratörü, `loggerOptions(env)`, `REDACT_PATHS`.
  - Dekoratörler: `Public()` + `IS_PUBLIC`, `Roles(...roles: Role[])` + `ROLES`, `SkipCsrf()` + `SKIP_CSRF`.
  - `configureApp(app: NestExpressApplication): void`.
  - Test yardımcıları: `createTestApp(): Promise<NestExpressApplication>`, `resetState(app): Promise<void>`.

- [ ] **Step 1: Paket dosyalarını oluştur**

`apps/api/package.json`:
```json
{
  "name": "@oto/api",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "nest build",
    "dev": "nest start --watch",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "test:e2e": "vitest run -c vitest.e2e.config.ts"
  },
  "dependencies": {
    "@nest-lab/throttler-storage-redis": "^1.1.0",
    "@nestjs/common": "^11.0.5",
    "@nestjs/core": "^11.0.5",
    "@nestjs/platform-express": "^11.0.5",
    "@nestjs/throttler": "^6.4.0",
    "@oto/db": "workspace:*",
    "@oto/shared": "workspace:*",
    "argon2": "^0.41.1",
    "cookie-parser": "^1.4.7",
    "express": "^5.0.1",
    "helmet": "^8.0.0",
    "ioredis": "^5.4.2",
    "jose": "^5.9.6",
    "nestjs-pino": "^4.3.0",
    "nodemailer": "^6.10.0",
    "pino": "^9.6.0",
    "pino-http": "^10.4.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.2",
    "@nestjs/testing": "^11.0.5",
    "@swc/core": "^1.10.7",
    "@testcontainers/postgresql": "^10.18.0",
    "@testcontainers/redis": "^10.18.0",
    "@types/cookie-parser": "^1.4.8",
    "@types/express": "^5.0.0",
    "@types/nodemailer": "^6.4.17",
    "@types/supertest": "^6.0.2",
    "pino-pretty": "^13.0.0",
    "supertest": "^7.0.0",
    "unplugin-swc": "^1.5.1",
    "vitest": "^3.0.5"
  }
}
```

`apps/api/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "types": ["node"] },
  "include": ["src", "test"]
}
```

`apps/api/tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src" },
  "include": ["src"],
  "exclude": ["src/**/*.spec.ts"]
}
```

`apps/api/nest-cli.json`:
```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "sourceRoot": "src",
  "compilerOptions": { "deleteOutDir": true, "tsConfigPath": "tsconfig.build.json" }
}
```

`apps/api/vitest.config.ts`:
```ts
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: { include: ['src/**/*.spec.ts', 'test/lint/**/*.spec.ts'], root: './' },
});
```

`apps/api/vitest.e2e.config.ts`:
```ts
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    root: './',
    include: ['test/**/*.e2e.spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-env.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
```

Run: `pnpm install`

- [ ] **Step 2: Başarısız birim testlerini yaz**

`apps/api/src/config/env.spec.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
  JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\\nabc\\n-----END PUBLIC KEY-----',
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
};

describe('parseEnv', () => {
  it('applies defaults and unescapes PEM newlines', () => {
    const env = parseEnv(base);
    expect(env.PORT).toBe(3001);
    expect(env.COOKIE_SECURE).toBe(true);
    expect(env.HIBP_ENABLED).toBe(false);
    expect(env.JWT_PRIVATE_KEY).toContain('\nabc\n');
  });

  it('fails fast listing every missing variable', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL.*REDIS_URL/s);
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() => parseEnv({ ...base, DATA_ENCRYPTION_KEY: randomBytes(16).toString('base64') })).toThrow(
      /DATA_ENCRYPTION_KEY/,
    );
  });
});
```

`apps/api/src/common/logger.spec.ts`:
```ts
import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from './logger';

describe('log redaction', () => {
  it('masks secrets anywhere one level deep and in request headers', () => {
    let out = '';
    const sink = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink);
    log.info({
      body: { password: 'hunter2hunter2', token: 'abc', chatId: '42' },
      req: { headers: { cookie: 'access_token=x', authorization: 'Bearer y' } },
    });
    expect(out).not.toMatch(/hunter2|access_token=x|Bearer y|"abc"|"42"/);
    expect(out).toContain('[redacted]');
  });
});
```

- [ ] **Step 3: Testlerin başarısız olduğunu gör**

Run: `pnpm --filter @oto/api test`
Expected: FAIL — `Cannot find module './env'` ve `./logger`.

- [ ] **Step 4: Config, logger ve ortak parçaları yaz**

`apps/api/src/config/env.ts`:
```ts
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const pem = z
  .string()
  .min(1)
  .transform((v) => v.replace(/\\n/g, '\n'));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_PRIVATE_KEY: pem,
  JWT_PUBLIC_KEY: pem,
  DATA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'base64 kodlu 32 bayt olmalı'),
  PUBLIC_BASE_URL: z.string().url(),
  COOKIE_SECURE: bool.default('true'),
  MAIL_TRANSPORT: z.enum(['smtp', 'json']).default('smtp'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_FROM: z.string().default('Oto Fırsat <no-reply@localhost>'),
  HIBP_ENABLED: bool.default('false'),
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

`apps/api/src/config/config.module.ts`:
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

`apps/api/src/common/logger.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import type { Env } from '../config/env';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.chatId',
  '*.config',
  '*.proxyUrl',
  '*.urlEncrypted',
];

export function loggerOptions(env: Env): Params {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      autoLogging: env.NODE_ENV !== 'test',
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      genReqId: (req, res) => {
        const header = req.headers['x-request-id'];
        const id = typeof header === 'string' && /^[\w-]{8,64}$/.test(header) ? header : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
    },
  };
}
```

`apps/api/src/common/errors/app-error.ts`:
```ts
import { ErrorCode } from '@oto/shared';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const Errors = {
  validation: (details: unknown) => new AppError(ErrorCode.VALIDATION_FAILED, 400, 'Geçersiz istek', details),
  unauthenticated: () => new AppError(ErrorCode.UNAUTHENTICATED, 401, 'Oturum açmanız gerekiyor'),
  forbidden: () => new AppError(ErrorCode.FORBIDDEN, 403, 'Bu işlem için yetkiniz yok'),
  notFound: () => new AppError(ErrorCode.NOT_FOUND, 404, 'Kayıt bulunamadı'),
  invalidCredentials: (status = 401) =>
    new AppError(ErrorCode.INVALID_CREDENTIALS, status, 'E-posta veya şifre hatalı'),
};
```

`apps/api/src/common/errors/all-exceptions.filter.ts`:
```ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ErrorCode, type ApiErrorBody } from '@oto/shared';
import type { Request, Response } from 'express';
import { AppError } from './app-error';

const HTTP_CODE: Record<number, ErrorCode> = {
  400: ErrorCode.VALIDATION_FAILED,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  429: ErrorCode.RATE_LIMITED,
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request & { id?: unknown }>();
    const { status, body } = this.toBody(exception, String(req.id ?? ''));
    res.status(status).json(body);
  }

  private toBody(exception: unknown, requestId: string): { status: number; body: ApiErrorBody } {
    if (exception instanceof AppError) {
      const error: ApiErrorBody['error'] = { code: exception.code, message: exception.message };
      if (exception.details !== undefined) error.details = exception.details;
      return { status: exception.status, body: { error } };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = HTTP_CODE[status] ?? (status >= 500 ? ErrorCode.INTERNAL : ErrorCode.VALIDATION_FAILED);
      const message = status === 404 ? 'Kayıt bulunamadı' : exception.message;
      return { status, body: { error: { code, message } } };
    }
    this.logger.error({ err: exception, requestId }, 'Unhandled exception');
    return {
      status: 500,
      body: { error: { code: ErrorCode.INTERNAL, message: 'Beklenmeyen bir hata oluştu', details: { requestId } } },
    };
  }
}
```

`apps/api/src/common/zod.pipe.ts`:
```ts
import { PipeTransform } from '@nestjs/common';
import type { z, ZodTypeAny } from 'zod';
import { Errors } from './errors/app-error';

export class ZodPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw Errors.validation(result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    return result.data;
  }
}
```

`apps/api/src/common/json-body.ts`:
```ts
import express, { type RequestHandler } from 'express';
import { ErrorCode } from '@oto/shared';

/** express.json hatalarını standart hata gövdesine çevirir (Nest filtrelerine ulaşmazlar). */
export function jsonBody(limit: string): RequestHandler {
  const parser = express.json({ limit });
  return (req, res, next) => {
    parser(req, res, (err?: unknown) => {
      if (!err) return next();
      const tooLarge = (err as { status?: number }).status === 413;
      res.status(tooLarge ? 413 : 400).json({
        error: { code: ErrorCode.VALIDATION_FAILED, message: tooLarge ? 'İstek gövdesi çok büyük' : 'Geçersiz JSON' },
      });
    });
  };
}
```

`apps/api/src/common/client-meta.ts`:
```ts
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

export const Meta = createParamDecorator((_: unknown, ctx: ExecutionContext): ClientMeta => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return { ip: req.ip ?? null, userAgent: req.headers['user-agent']?.slice(0, 255) ?? null };
});
```

`apps/api/src/common/decorators/public.ts`:
```ts
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:public';
export const Public = () => SetMetadata(IS_PUBLIC, true);
```

`apps/api/src/common/decorators/roles.ts`:
```ts
import { SetMetadata } from '@nestjs/common';
import type { Role } from '@oto/db';

export const ROLES = 'auth:roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);
```

`apps/api/src/common/decorators/skip-csrf.ts`:
```ts
import { SetMetadata } from '@nestjs/common';

export const SKIP_CSRF = 'auth:skip-csrf';
/** Yalnızca kendi imza doğrulaması olan uç noktalar için (ör. Telegram webhook). */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);
```

`apps/api/src/types/express.d.ts`:
```ts
import type { AuthUser } from '../modules/auth/auth-user';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
```

`apps/api/src/modules/auth/auth-user.ts` (Task 6'da kullanılacak tip; derleme için şimdi oluştur):
```ts
import type { Role } from '@oto/db';

export interface AuthUser {
  id: string;
  role: Role;
  /** Oturum ailesinin kimliği (Session.familyId) */
  sessionId: string;
}
```

- [ ] **Step 5: Birim testlerini çalıştır**

Run: `pnpm --filter @oto/api test`
Expected: PASS (env 3 test, logger 1 test).

- [ ] **Step 6: Altyapı, health ve uygulama girişini yaz**

`apps/api/src/infra/prisma.service.ts`:
```ts
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@oto/db';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({ datasources: { db: { url: env.DATABASE_URL } } });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

`apps/api/src/infra/redis.service.ts`:
```ts
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  }

  async onModuleDestroy(): Promise<void> {
    await this.quit();
  }
}
```

`apps/api/src/infra/infra.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';

@Global()
@Module({ providers: [PrismaService, RedisService], exports: [PrismaService, RedisService] })
export class InfraModule {}
```

`apps/api/src/modules/health/health.controller.ts`:
```ts
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public';
import { PrismaService } from '../../infra/prisma.service';
import { RedisService } from '../../infra/redis.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks = { db: false, redis: false, migrations: false };
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.db = true;
      const [row] = await this.prisma.$queryRaw<{ pending: bigint }[]>`
        SELECT count(*) AS pending FROM "_prisma_migrations"
        WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`;
      checks.migrations = Number(row.pending) === 0;
    } catch {
      // checks zaten false
    }
    try {
      checks.redis = (await this.redis.ping()) === 'PONG';
    } catch {
      // checks.redis zaten false
    }
    const ok = Object.values(checks).every(Boolean);
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', checks };
  }
}
```

`apps/api/src/modules/health/health.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({ controllers: [HealthController] })
export class HealthModule {}
```

`apps/api/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { loggerOptions } from './common/logger';
import { ConfigModule, ENV } from './config/config.module';
import type { Env } from './config/env';
import { InfraModule } from './infra/infra.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({ inject: [ENV], useFactory: (env: Env) => loggerOptions(env) }),
    InfraModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
```

`apps/api/src/bootstrap.ts`:
```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { jsonBody } from './common/json-body';

/** main.ts ve testler aynı yapılandırmayı kullanır. App `bodyParser: false` ile oluşturulmalıdır. */
export function configureApp(app: NestExpressApplication): void {
  app.useLogger(app.get(Logger));
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cookieParser());
  app.use(jsonBody('100kb'));
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
}
```

`apps/api/src/main.ts`:
```ts
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

const rootEnv = resolve(__dirname, '../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

async function main(): Promise<void> {
  // AppModule env yüklendikten sonra import edilir (ConfigModule process.env'i okur)
  const { AppModule } = await import('./app.module');
  const { configureApp } = await import('./bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false });
  configureApp(app);
  await app.listen(Number(process.env.PORT ?? 3001));
}

void main();
```

- [ ] **Step 7: E2E test altyapısını yaz**

`apps/api/test/global-setup.ts`:
```ts
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  const databaseUrl = pg.getConnectionUri();
  execSync('pnpm exec prisma migrate deploy', {
    cwd: resolve(process.cwd(), '../../packages/db'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', redis.getConnectionUrl());
  return async () => {
    await Promise.all([pg.stop(), redis.stop()]);
  };
}
```

`apps/api/test/setup-env.ts`:
```ts
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { inject } from 'vitest';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: inject('databaseUrl'),
  REDIS_URL: inject('redisUrl'),
  JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  COOKIE_SECURE: 'false',
  MAIL_TRANSPORT: 'json',
  HIBP_ENABLED: 'false',
});
```

`apps/api/test/helpers.ts`:
```ts
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { seedPlans } from '@oto/db';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';

export async function createTestApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app);
  await app.init();
  return app;
}

export async function resetState(app: NestExpressApplication): Promise<void> {
  const prisma = app.get(PrismaService);
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
  await app.get(RedisService).flushdb();
  await seedPlans(prisma);
}
```

- [ ] **Step 8: Başarısız e2e testini yaz** (`apps/api/test/health.e2e.spec.ts`)

```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

describe('health & error format', () => {
  it('GET /api/v1/health/live → 200', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('GET /api/v1/health/ready → 200 with all checks true', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ db: true, redis: true, migrations: true });
  });

  it('unknown route → 404 in standard error format', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Kayıt bulunamadı' } });
  });

  it('malformed JSON → 400 VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/health/live')
      .set('Content-Type', 'application/json')
      .send('{"a":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('body over 100kb → 413', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/health/live')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
```

- [ ] **Step 9: E2E testlerini çalıştır**

Run: `pnpm --filter @oto/api test:e2e`
Expected: 5 test PASS. (İlk çalıştırmada Docker imajları indirilir.)

- [ ] **Step 10: Manuel doğrulama**

Run:
```bash
cp .env.example .env && pnpm keys:gen >> .env
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm --filter @oto/api build && pnpm --filter @oto/api start &
curl -s localhost:3001/api/v1/health/ready
```
Expected: `{"status":"ok","checks":{"db":true,"redis":true,"migrations":true}}`. Sonra süreci durdur.

- [ ] **Step 11: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck`
```bash
git add -A
git commit -m "feat(api): bootstrap NestJS app with env validation, error format, logging and health checks"
```

---

### Task 4: Şifreleme ve token yardımcıları

**Files:**
- Create: `apps/api/src/common/crypto/encryptor.ts`, `apps/api/src/common/crypto/tokens.ts`, `apps/api/src/common/crypto/crypto.module.ts`
- Modify: `apps/api/src/app.module.ts` (CryptoModule import)
- Test: `apps/api/src/common/crypto/encryptor.spec.ts`, `apps/api/src/common/crypto/tokens.spec.ts`

**Interfaces:**
- Consumes: `ENV`, `Env`.
- Produces: `Encryptor` sınıfı (`encrypt(plain: string): string`, `decrypt(payload: string): string`, `encryptJson(v: unknown): string`, `decryptJson<T>(payload: string): T`), `CryptoModule` (global, `Encryptor` sağlar); `generateToken(bytes = 32): string`, `hashToken(token: string): string`.

- [ ] **Step 1: Başarısız testleri yaz**

`apps/api/src/common/crypto/encryptor.spec.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Encryptor } from './encryptor';

const key = () => randomBytes(32).toString('base64');

describe('Encryptor', () => {
  it('round-trips unicode text in v1 format', () => {
    const enc = new Encryptor(key());
    const ct = enc.encrypt('İstanbul — şifreli ✓');
    expect(ct.startsWith('v1:')).toBe(true);
    expect(ct.split(':')).toHaveLength(4);
    expect(enc.decrypt(ct)).toBe('İstanbul — şifreli ✓');
  });

  it('round-trips the empty string and JSON', () => {
    const enc = new Encryptor(key());
    expect(enc.decrypt(enc.encrypt(''))).toBe('');
    expect(enc.decryptJson<{ chatId: number }>(enc.encryptJson({ chatId: 42 }))).toEqual({ chatId: 42 });
  });

  it('uses a fresh IV each time', () => {
    const enc = new Encryptor(key());
    expect(enc.encrypt('same')).not.toBe(enc.encrypt('same'));
  });

  it('detects tampering', () => {
    const enc = new Encryptor(key());
    const [v, iv, tag, ct] = enc.encrypt('secret').split(':');
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] ^= 0xff;
    expect(() => enc.decrypt([v, iv, tag, flipped.toString('base64url')].join(':'))).toThrow();
  });

  it('fails with a different key', () => {
    const ct = new Encryptor(key()).encrypt('secret');
    expect(() => new Encryptor(key()).decrypt(ct)).toThrow();
  });

  it('rejects unknown formats and wrong key sizes', () => {
    const enc = new Encryptor(key());
    expect(() => enc.decrypt('v2:a:b:c')).toThrow(/format/);
    expect(() => new Encryptor(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
```

`apps/api/src/common/crypto/tokens.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { generateToken, hashToken } from './tokens';

describe('tokens', () => {
  it('generates 43-char base64url tokens for 32 bytes, all unique', () => {
    const set = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(set.size).toBe(100);
    for (const t of set) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically to 64 hex chars', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});
```

- [ ] **Step 2: Testlerin başarısız olduğunu gör**

Run: `pnpm --filter @oto/api test`
Expected: FAIL — `Cannot find module './encryptor'`, `./tokens`.

- [ ] **Step 3: Uygulamayı yaz**

`apps/api/src/common/crypto/encryptor.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM; çıktı "v1:<iv>:<tag>:<ciphertext>" (base64url). Sürüm öneki anahtar rotasyonuna izin verir. */
export class Encryptor {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes');
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
  }

  decrypt(payload: string): string {
    const parts = payload.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unsupported ciphertext format');
    const [, iv, tag, ct] = parts;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T>(payload: string): T {
    return JSON.parse(this.decrypt(payload)) as T;
  }
}
```

`apps/api/src/common/crypto/tokens.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Yüksek entropili tokenlar için SHA-256 yeterlidir (şifre değildir). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
```

`apps/api/src/common/crypto/crypto.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { Encryptor } from './encryptor';

@Global()
@Module({
  providers: [{ provide: Encryptor, inject: [ENV], useFactory: (env: Env) => new Encryptor(env.DATA_ENCRYPTION_KEY) }],
  exports: [Encryptor],
})
export class CryptoModule {}
```

`apps/api/src/app.module.ts` — `imports` dizisine `InfraModule`'den sonra `CryptoModule` ekle:
```ts
import { CryptoModule } from './common/crypto/crypto.module';
// ...
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({ inject: [ENV], useFactory: (env: Env) => loggerOptions(env) }),
    InfraModule,
    CryptoModule,
    HealthModule,
  ],
```

- [ ] **Step 4: Testleri çalıştır**

Run: `pnpm --filter @oto/api test && pnpm --filter @oto/api test:e2e`
Expected: Tüm testler PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): add AES-256-GCM encryptor and token helpers"
```

---

### Task 5: Auth çekirdeği — şifre, JWT, oturum servisleri

**Files:**
- Create: `apps/api/src/modules/auth/auth.constants.ts`, `apps/api/src/modules/auth/password.service.ts`, `apps/api/src/modules/auth/token.service.ts`, `apps/api/src/modules/auth/session.service.ts`, `apps/api/src/modules/auth/auth.module.ts`
- Modify: `apps/api/src/app.module.ts` (AuthModule import)
- Test: `apps/api/src/modules/auth/password.service.spec.ts`, `apps/api/src/modules/auth/token.service.spec.ts`, `apps/api/test/session.e2e.spec.ts`

**Interfaces:**
- Consumes: `ENV/Env`, `PrismaService`, `generateToken`, `hashToken`, `ARGON2_OPTIONS`, `Role`, `ClientMeta`, `AppError`, `ErrorCode`.
- Produces:
  - Sabitler: `ACCESS_TTL_SEC = 900`, `REFRESH_TTL_MS = 30 gün`, `ROTATION_GRACE_MS = 10_000`, `ACCESS_COOKIE = 'access_token'`, `REFRESH_COOKIE = 'refresh_token'`, `REFRESH_PATH = '/api/v1/auth'`, `VERIFY_TTL_MS = 24 saat`, `RESET_TTL_MS = 30 dk`.
  - `PasswordService`: `hash(p): Promise<string>`, `verify(hash, p): Promise<boolean>`, `dummyVerify(p): Promise<false>`, `assertNotBreached(p): Promise<void>` (WEAK_PASSWORD fırlatır).
  - `TokenService`: `signAccess(c: AccessClaims): Promise<string>`, `verifyAccess(token): Promise<AccessClaims | null>`; `AccessClaims { userId: string; role: Role; sessionId: string }`.
  - `SessionService`: `create(userId, meta): Promise<{ familyId: string; refreshToken: string }>`, `rotate(presented, meta): Promise<RotateResult>`, `revokeByToken(presented): Promise<void>`, `revokeFamily(familyId): Promise<void>`, `revokeFamilyForUser(userId, familyId): Promise<boolean>`, `revokeAllForUser(userId, opts?: { exceptFamilyId?: string }): Promise<void>`, `listActive(userId): Promise<SessionView[]>`.
  - `RotateResult = { kind: 'ok'; userId; role; familyId; refreshToken } | { kind: 'invalid' } | { kind: 'race' } | { kind: 'reused'; userId; familyId }`.
  - `SessionView { id: string /* familyId */; ip: string | null; userAgent: string | null; lastUsedAt: Date }`.
  - `AuthModule` bu servisleri export eder.

- [ ] **Step 1: Başarısız birim testlerini yaz**

`apps/api/src/modules/auth/password.service.spec.ts`:
```ts
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env';
import { PasswordService } from './password.service';

const svc = (hibp: boolean) => new PasswordService({ HIBP_ENABLED: hibp } as Env);

afterEach(() => vi.unstubAllGlobals());

describe('PasswordService', () => {
  it('hashes with argon2id and verifies', async () => {
    const s = svc(false);
    const hash = await s.hash('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await s.verify(hash, 'correct horse battery')).toBe(true);
    expect(await s.verify(hash, 'wrong password!!')).toBe(false);
  });

  it('verify returns false (not throw) for a malformed hash', async () => {
    expect(await svc(false).verify('not-a-hash', 'whatever123')).toBe(false);
  });

  it('dummyVerify always resolves false', async () => {
    expect(await svc(false).dummyVerify('anything-at-all')).toBe(false);
  });

  it('rejects a password found in HIBP', async () => {
    const sha = createHash('sha1').update('correct horse battery').digest('hex').toUpperCase();
    const fetchMock = vi.fn(async () => new Response(`0000000000000000000000000000000000A:1\r\n${sha.slice(5)}:42`));
    vi.stubGlobal('fetch', fetchMock);
    await expect(svc(true).assertNotBreached('correct horse battery')).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    expect(fetchMock).toHaveBeenCalledWith(`https://api.pwnedpasswords.com/range/${sha.slice(0, 5)}`, expect.anything());
  });

  it('allows the password when HIBP is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(svc(true).assertNotBreached('correct horse battery')).resolves.toBeUndefined();
  });

  it('does not call HIBP when disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await svc(false).assertNotBreached('correct horse battery');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

`apps/api/src/modules/auth/token.service.spec.ts`:
```ts
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env';
import { TokenService } from './token.service';

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

async function make(k = keys()) {
  const svc = new TokenService(k as Env);
  await svc.onModuleInit();
  return svc;
}

afterEach(() => vi.useRealTimers());

describe('TokenService', () => {
  const claims = { userId: 'u1', role: 'ADMIN' as const, sessionId: 'fam1' };

  it('signs and verifies access tokens', async () => {
    const svc = await make();
    expect(await svc.verifyAccess(await svc.signAccess(claims))).toEqual(claims);
  });

  it('rejects tokens from another key pair', async () => {
    const a = await make();
    const b = await make();
    expect(await b.verifyAccess(await a.signAccess(claims))).toBeNull();
  });

  it('rejects expired tokens (15 min TTL)', async () => {
    const svc = await make();
    const token = await svc.signAccess(claims);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    expect(await svc.verifyAccess(token)).toBeNull();
  });

  it('rejects garbage and HS256 tokens', async () => {
    const svc = await make();
    expect(await svc.verifyAccess('garbage')).toBeNull();
    const hs = await new SignJWT({ role: 'SUPER_ADMIN', sid: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .sign(new TextEncoder().encode('k'.repeat(32)));
    expect(await svc.verifyAccess(hs)).toBeNull();
  });
});
```

- [ ] **Step 2: Testlerin başarısız olduğunu gör**

Run: `pnpm --filter @oto/api test`
Expected: FAIL — `Cannot find module './password.service'`, `./token.service`.

- [ ] **Step 3: Sabitleri, PasswordService ve TokenService'i yaz**

`apps/api/src/modules/auth/auth.constants.ts`:
```ts
export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ROTATION_GRACE_MS = 10_000;
export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 30 * 60 * 1000;
export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
export const REFRESH_PATH = '/api/v1/auth';
export const JWT_ISSUER = 'oto-api';
export const JWT_AUDIENCE = 'oto-web';
```

`apps/api/src/modules/auth/password.service.ts`:
```ts
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ARGON2_OPTIONS } from '@oto/db';
import { ErrorCode } from '@oto/shared';
import argon2 from 'argon2';
import { AppError } from '../../common/errors/app-error';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);
  private dummyHash?: Promise<string>;

  constructor(@Inject(ENV) private readonly env: Env) {}

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /** Kullanıcı bulunamadığında da aynı süreyi harcayarak e-posta tahminini zorlaştırır. */
  async dummyVerify(password: string): Promise<false> {
    this.dummyHash ??= this.hash('timing-equalizer-password');
    await this.verify(await this.dummyHash, password);
    return false;
  }

  async assertNotBreached(password: string): Promise<void> {
    if (!this.env.HIBP_ENABLED) return;
    const sha = createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha.slice(0, 5);
    const suffix = sha.slice(5);
    let body: string;
    try {
      const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { 'Add-Padding': 'true' },
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return;
      body = await res.text();
    } catch (err) {
      this.logger.warn({ err }, 'HIBP check skipped');
      return;
    }
    const breached = body.split(/\r?\n/).some((line) => {
      const [s, count] = line.split(':');
      return s === suffix && Number(count) > 0;
    });
    if (breached) {
      throw new AppError(
        ErrorCode.WEAK_PASSWORD,
        400,
        'Bu şifre daha önce sızdırılmış şifreler arasında. Lütfen farklı bir şifre seçin.',
      );
    }
  }
}
```

`apps/api/src/modules/auth/token.service.ts`:
```ts
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Role } from '@oto/db';
import { importPKCS8, importSPKI, jwtVerify, SignJWT, type KeyLike } from 'jose';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { ACCESS_TTL_SEC, JWT_AUDIENCE, JWT_ISSUER } from './auth.constants';

export interface AccessClaims {
  userId: string;
  role: Role;
  sessionId: string;
}

const ROLES: readonly string[] = ['USER', 'ADMIN', 'SUPER_ADMIN'];

@Injectable()
export class TokenService implements OnModuleInit {
  private privateKey!: KeyLike;
  private publicKey!: KeyLike;

  constructor(@Inject(ENV) private readonly env: Env) {}

  async onModuleInit(): Promise<void> {
    this.privateKey = await importPKCS8(this.env.JWT_PRIVATE_KEY, 'EdDSA');
    this.publicKey = await importSPKI(this.env.JWT_PUBLIC_KEY, 'EdDSA');
  }

  signAccess(c: AccessClaims): Promise<string> {
    return new SignJWT({ role: c.role, sid: c.sessionId })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(c.userId)
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SEC}s`)
      .sign(this.privateKey);
  }

  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithms: ['EdDSA'],
      });
      const { sub, sid, role } = payload;
      if (typeof sub !== 'string' || typeof sid !== 'string' || typeof role !== 'string' || !ROLES.includes(role)) {
        return null;
      }
      return { userId: sub, role: role as Role, sessionId: sid };
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Birim testlerini çalıştır**

Run: `pnpm --filter @oto/api test`
Expected: PASS.

- [ ] **Step 5: SessionService için başarısız e2e testini yaz** (`apps/api/test/session.e2e.spec.ts`)

```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { SessionService } from '../src/modules/auth/session.service';
import { createTestApp, resetState } from './helpers';

let app: NestExpressApplication;
let sessions: SessionService;
let prisma: PrismaService;
let userId: string;
const meta = { ip: '127.0.0.1', userAgent: 'vitest' };

beforeAll(async () => {
  app = await createTestApp();
  sessions = app.get(SessionService);
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetState(app);
  userId = (await prisma.user.create({ data: { email: 's@test.com', name: 'S', passwordHash: 'x' } })).id;
});

describe('SessionService', () => {
  it('rotates a refresh token within the same family', async () => {
    const { familyId, refreshToken } = await sessions.create(userId, meta);
    const r = await sessions.rotate(refreshToken, meta);
    expect(r).toMatchObject({ kind: 'ok', userId, familyId, role: 'USER' });
    if (r.kind !== 'ok') throw new Error('unreachable');
    expect(r.refreshToken).not.toBe(refreshToken);
    expect((await sessions.rotate(r.refreshToken, meta)).kind).toBe('ok');
  });

  it('treats an old token inside the grace window as a race and keeps the family alive', async () => {
    const { refreshToken } = await sessions.create(userId, meta);
    const first = await sessions.rotate(refreshToken, meta);
    expect((await sessions.rotate(refreshToken, meta)).kind).toBe('race');
    if (first.kind !== 'ok') throw new Error('unreachable');
    expect((await sessions.rotate(first.refreshToken, meta)).kind).toBe('ok');
  });

  it('detects reuse after the grace window and revokes the whole family', async () => {
    const { familyId, refreshToken } = await sessions.create(userId, meta);
    const first = await sessions.rotate(refreshToken, meta);
    if (first.kind !== 'ok') throw new Error('unreachable');
    await prisma.session.updateMany({ where: { familyId, rotatedAt: { not: null } }, data: { rotatedAt: new Date(Date.now() - 60_000) } });
    expect(await sessions.rotate(refreshToken, meta)).toEqual({ kind: 'reused', userId, familyId });
    expect((await sessions.rotate(first.refreshToken, meta)).kind).toBe('invalid');
  });

  it('only one of two concurrent rotations wins', async () => {
    const { refreshToken } = await sessions.create(userId, meta);
    const results = await Promise.all([sessions.rotate(refreshToken, meta), sessions.rotate(refreshToken, meta)]);
    expect(results.map((r) => r.kind).sort()).toEqual(['ok', 'race']);
  });

  it('rejects unknown, expired and suspended-user tokens', async () => {
    expect((await sessions.rotate('nope', meta)).kind).toBe('invalid');
    const a = await sessions.create(userId, meta);
    await prisma.session.updateMany({ where: { familyId: a.familyId }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await sessions.rotate(a.refreshToken, meta)).kind).toBe('invalid');
    const b = await sessions.create(userId, meta);
    await prisma.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' } });
    expect((await sessions.rotate(b.refreshToken, meta)).kind).toBe('invalid');
  });

  it('lists active families and revokes all except one', async () => {
    const a = await sessions.create(userId, meta);
    const b = await sessions.create(userId, { ip: '10.0.0.1', userAgent: 'other' });
    expect((await sessions.listActive(userId)).map((s) => s.id).sort()).toEqual([a.familyId, b.familyId].sort());
    await sessions.revokeAllForUser(userId, { exceptFamilyId: a.familyId });
    expect((await sessions.listActive(userId)).map((s) => s.id)).toEqual([a.familyId]);
  });

  it('revokeFamilyForUser refuses another user\'s family', async () => {
    const other = await prisma.user.create({ data: { email: 'o@test.com', name: 'O', passwordHash: 'x' } });
    const theirs = await sessions.create(other.id, meta);
    expect(await sessions.revokeFamilyForUser(userId, theirs.familyId)).toBe(false);
    expect((await sessions.rotate(theirs.refreshToken, meta)).kind).toBe('ok');
  });
});
```

- [ ] **Step 6: Testin başarısız olduğunu gör**

Run: `pnpm --filter @oto/api test:e2e -- session`
Expected: FAIL — `Cannot find module '../src/modules/auth/session.service'`.

- [ ] **Step 7: SessionService ve AuthModule'ü yaz**

`apps/api/src/modules/auth/session.service.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Role } from '@oto/db';
import type { ClientMeta } from '../../common/client-meta';
import { generateToken, hashToken } from '../../common/crypto/tokens';
import { PrismaService } from '../../infra/prisma.service';
import { REFRESH_TTL_MS, ROTATION_GRACE_MS } from './auth.constants';

export type RotateResult =
  | { kind: 'ok'; userId: string; role: Role; familyId: string; refreshToken: string }
  | { kind: 'invalid' }
  | { kind: 'race' }
  | { kind: 'reused'; userId: string; familyId: string };

export interface SessionView {
  id: string;
  ip: string | null;
  userAgent: string | null;
  lastUsedAt: Date;
}

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, meta: ClientMeta): Promise<{ familyId: string; refreshToken: string }> {
    const familyId = randomUUID();
    const refreshToken = generateToken();
    await this.prisma.session.create({
      data: {
        userId,
        familyId,
        refreshTokenHash: hashToken(refreshToken),
        ip: meta.ip,
        userAgent: meta.userAgent,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    return { familyId, refreshToken };
  }

  async rotate(presented: string, meta: ClientMeta): Promise<RotateResult> {
    const row = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hashToken(presented) },
      include: { user: { select: { role: true, status: true } } },
    });
    if (!row) return { kind: 'invalid' };
    if (row.rotatedAt) {
      if (Date.now() - row.rotatedAt.getTime() <= ROTATION_GRACE_MS) return { kind: 'race' };
      await this.revokeFamily(row.familyId);
      return { kind: 'reused', userId: row.userId, familyId: row.familyId };
    }
    if (row.revokedAt || row.expiresAt.getTime() <= Date.now() || row.user.status !== 'ACTIVE') {
      return { kind: 'invalid' };
    }
    const refreshToken = generateToken();
    const now = new Date();
    const rotated = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.session.updateMany({
        where: { id: row.id, rotatedAt: null, revokedAt: null },
        data: { rotatedAt: now, revokedAt: now },
      });
      if (updated.count !== 1) return false;
      await tx.session.create({
        data: {
          userId: row.userId,
          familyId: row.familyId,
          refreshTokenHash: hashToken(refreshToken),
          ip: meta.ip,
          userAgent: meta.userAgent,
          expiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
        },
      });
      return true;
    });
    if (!rotated) return { kind: 'race' };
    return { kind: 'ok', userId: row.userId, role: row.user.role, familyId: row.familyId, refreshToken };
  }

  async revokeByToken(presented: string): Promise<void> {
    const row = await this.prisma.session.findUnique({ where: { refreshTokenHash: hashToken(presented) } });
    if (row) await this.revokeFamily(row.familyId);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async revokeFamilyForUser(userId: string, familyId: string): Promise<boolean> {
    const { count } = await this.prisma.session.updateMany({
      where: { userId, familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count > 0;
  }

  async revokeAllForUser(userId: string, opts: { exceptFamilyId?: string } = {}): Promise<void> {
    await this.prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(opts.exceptFamilyId ? { familyId: { not: opts.exceptFamilyId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
  }

  async listActive(userId: string): Promise<SessionView[]> {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({ id: r.familyId, ip: r.ip, userAgent: r.userAgent, lastUsedAt: r.createdAt }));
  }
}
```

`apps/api/src/modules/auth/auth.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

@Module({
  providers: [PasswordService, TokenService, SessionService],
  exports: [PasswordService, TokenService, SessionService],
})
export class AuthModule {}
```

`apps/api/src/app.module.ts` — `imports`'a `HealthModule`'den sonra `AuthModule` ekle:
```ts
import { AuthModule } from './modules/auth/auth.module';
// imports: [..., HealthModule, AuthModule],
```

- [ ] **Step 8: Testleri çalıştır**

Run: `pnpm --filter @oto/api test && pnpm --filter @oto/api test:e2e`
Expected: Tüm testler PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(auth): add password hashing, EdDSA access tokens and rotating refresh sessions"
```

---

### Task 6: Auth uç noktaları, global guard'lar, audit servisi ve `GET /me`

**Files:**
- Create: `apps/api/src/common/decorators/current-user.ts`, `apps/api/src/common/guards/csrf.guard.ts`, `apps/api/src/common/guards/jwt-auth.guard.ts`, `apps/api/src/common/guards/throttler.guard.ts`, `apps/api/src/common/audit/audit.service.ts`, `apps/api/src/common/audit/audit.module.ts`, `apps/api/src/modules/auth/cookies.ts`, `apps/api/src/modules/auth/public-user.ts`, `apps/api/src/modules/auth/login-attempt.service.ts`, `apps/api/src/modules/auth/auth.service.ts`, `apps/api/src/modules/auth/auth.controller.ts`, `apps/api/src/modules/me/me.repository.ts`, `apps/api/src/modules/me/me.service.ts`, `apps/api/src/modules/me/me.controller.ts`, `apps/api/src/modules/me/me.module.ts`
- Modify: `apps/api/src/modules/auth/auth.module.ts`, `apps/api/src/app.module.ts`, `apps/api/test/helpers.ts`
- Test: `apps/api/test/auth.e2e.spec.ts`

**Interfaces:**
- Consumes: Task 3–5'teki her şey.
- Produces:
  - `CurrentUser()` param dekoratörü → `AuthUser`.
  - `CsrfGuard`, `JwtAuthGuard`, `AppThrottlerGuard` (APP_GUARD olarak bu sırayla).
  - `AuditService.record(entry: AuditEntry): Promise<void>`; `AuditEntry { actorId: string | null; action: string; targetType?: string | null; targetId?: string | null; before?: unknown; after?: unknown; ip?: string | null }`; `AuditModule` (global).
  - `setAuthCookies(res, env, access, refresh)`, `clearAuthCookies(res, env)`.
  - `PublicUser { id; email; name; role; status; emailVerifiedAt: Date | null; createdAt: Date }`, `toPublicUser(u: User): PublicUser`.
  - `LoginAttemptService` (`isLocked`, `recordFailure`, `clear`; `LOCK_THRESHOLD = 5`).
  - `AuthService`: `register(input, meta)`, `login(input, meta)` → `AuthResult { user: PublicUser; accessToken: string; refreshToken: string }`; `refresh(presented | undefined, meta)` → `{ kind: 'ok'; accessToken; refreshToken } | { kind: 'invalid' } | { kind: 'race' } | { kind: 'reused' }`; `logout(presented | undefined)`.
  - `MeRepository`: `findUser(userId)`, `findActiveSubscription(userId)`, `countSearchProfiles(userId)`, `countExternalNotificationsSince(userId, since)`.
  - `MeService.getProfile(userId): Promise<MeProfile>`; `MeProfile { user: PublicUser; subscription: { planCode; planName; limits; status; endsAt } | null; usage: { searchProfiles: number; notificationsToday: number } }`.
  - Test yardımcıları: `newAgent(app)`, `registerUser(app, overrides?)` → `{ agent, user, email, password }`, `cookieFrom(res, name)`.

- [ ] **Step 1: Test yardımcılarını genişlet** — `apps/api/test/helpers.ts` sonuna ekle:

```ts
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';

export function newAgent(app: NestExpressApplication): TestAgent {
  return request.agent(app.getHttpServer()).set('X-Requested-With', 'XMLHttpRequest');
}

let userSeq = 0;
export async function registerUser(
  app: NestExpressApplication,
  overrides: Partial<{ email: string; password: string; name: string }> = {},
) {
  userSeq += 1;
  const email = overrides.email ?? `user${userSeq}@test.com`;
  const password = overrides.password ?? 'a-very-strong-pass';
  const agent = newAgent(app);
  const res = await agent
    .post('/api/v1/auth/register')
    .send({ email, password, name: overrides.name ?? `Kullanıcı ${userSeq}`, kvkkAccepted: true });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, user: res.body.user as { id: string; email: string; role: string }, email, password };
}

export function cookieFrom(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const hit = raw?.find((c) => c.startsWith(`${name}=`));
  const value = hit?.split(';')[0].slice(name.length + 1);
  return value ? value : undefined;
}
```
(Dosya başındaki import'lar tekilleştirilmeli; `request` import'u en üste taşınır.)

- [ ] **Step 2: Başarısız e2e testini yaz** (`apps/api/test/auth.e2e.spec.ts`)

```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { cookieFrom, createTestApp, newAgent, registerUser, resetState } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
const http = () => request(app.getHttpServer());
const xhr = { 'X-Requested-With': 'XMLHttpRequest' };

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetState(app);
});

describe('register', () => {
  it('creates a USER with FREE plan + IN_APP channel and logs in', async () => {
    const { agent, user } = await registerUser(app, { email: 'new@test.com' });
    expect(user).toMatchObject({ email: 'new@test.com', role: 'USER' });
    const me = await agent.get('/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);
    expect(me.body.subscription.planCode).toBe('FREE');
    expect(me.body.usage).toEqual({ searchProfiles: 0, notificationsToday: 0 });
    const channels = await prisma.notificationChannel.findMany({ where: { userId: user.id } });
    expect(channels.map((c) => c.type)).toEqual(['IN_APP']);
  });

  it('normalizes email case/whitespace and rejects case-insensitive duplicates', async () => {
    await registerUser(app, { email: '  Mixed@Example.COM ' });
    const dup = await http().post('/api/v1/auth/register').set(xhr)
      .send({ email: 'mixed@example.com', password: 'a-very-strong-pass', name: 'X', kvkkAccepted: true });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
    const login = await http().post('/api/v1/auth/login').set(xhr)
      .send({ email: 'MIXED@example.com', password: 'a-very-strong-pass' });
    expect(login.status).toBe(200);
  });

  it('rejects missing KVKK consent, unknown fields, huge names and huge passwords', async () => {
    const base = { email: 'v@test.com', password: 'a-very-strong-pass', name: 'V', kvkkAccepted: true };
    for (const body of [
      { ...base, kvkkAccepted: false },
      { ...base, role: 'SUPER_ADMIN' },
      { ...base, name: 'a'.repeat(10_000) },
      { ...base, password: 'x'.repeat(129) },
    ]) {
      const res = await http().post('/api/v1/auth/register').set(xhr).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('login', () => {
  it('returns the same error for wrong password and unknown email', async () => {
    await registerUser(app, { email: 'l@test.com' });
    const wrong = await http().post('/api/v1/auth/login').set(xhr).send({ email: 'l@test.com', password: 'nope-nope-nope' });
    const unknown = await http().post('/api/v1/auth/login').set(xhr).send({ email: 'x@test.com', password: 'nope-nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('locks after 5 failures for 15 minutes, even with the right password, and audits it', async () => {
    await registerUser(app, { email: 'lock@test.com' });
    for (let i = 0; i < 5; i++) {
      await http().post('/api/v1/auth/login').set(xhr).send({ email: 'lock@test.com', password: 'wrong-wrong-1' });
    }
    const res = await http().post('/api/v1/auth/login').set(xhr).send({ email: 'lock@test.com', password: 'a-very-strong-pass' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('LOGIN_LOCKED');
    expect(await prisma.auditLog.count({ where: { action: 'auth.login_locked' } })).toBe(1);
  });

  it('refuses suspended accounts after a correct password', async () => {
    const { user } = await registerUser(app, { email: 'sus@test.com' });
    await prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
    const res = await http().post('/api/v1/auth/login').set(xhr).send({ email: 'sus@test.com', password: 'a-very-strong-pass' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('sets httpOnly SameSite=Lax cookies with the right paths', async () => {
    await registerUser(app, { email: 'c@test.com' });
    const res = await http().post('/api/v1/auth/login').set(xhr).send({ email: 'c@test.com', password: 'a-very-strong-pass' });
    const cookies = (res.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(cookies).toMatch(/access_token=[^;]+;.*Path=\/;.*HttpOnly;.*SameSite=Lax/);
    expect(cookies).toMatch(/refresh_token=[^;]+;.*Path=\/api\/v1\/auth;.*HttpOnly;.*SameSite=Lax/);
  });

  it('rate limits /auth to 10 requests per minute per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await http().post('/api/v1/auth/login').set(xhr).send({ email: `rl${i}@test.com`, password: 'whatever-123' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('guards', () => {
  it('requires X-Requested-With on mutations', async () => {
    const res = await http().post('/api/v1/auth/login').send({ email: 'a@test.com', password: 'whatever-123' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('rejects a foreign Origin', async () => {
    const res = await http().post('/api/v1/auth/login').set(xhr).set('Origin', 'https://evil.example')
      .send({ email: 'a@test.com', password: 'whatever-123' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('returns 401 (not 500) without a cookie or with a garbage cookie', async () => {
    expect((await http().get('/api/v1/me')).status).toBe(401);
    const res = await http().get('/api/v1/me').set('Cookie', 'access_token=garbage.token.value');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('refresh & logout', () => {
  it('rotates cookies; an old token after the grace window kills the family', async () => {
    const { agent, user } = await registerUser(app, { email: 'r@test.com' });
    const login = await http().post('/api/v1/auth/login').set(xhr).send({ email: 'r@test.com', password: 'a-very-strong-pass' });
    const oldRefresh = cookieFrom(login, 'refresh_token')!;

    const rotated = await http().post('/api/v1/auth/refresh').set(xhr).set('Cookie', `refresh_token=${oldRefresh}`);
    expect(rotated.status).toBe(204);
    const newRefresh = cookieFrom(rotated, 'refresh_token')!;
    expect(newRefresh).not.toBe(oldRefresh);

    const race = await http().post('/api/v1/auth/refresh').set(xhr).set('Cookie', `refresh_token=${oldRefresh}`);
    expect(race.status).toBe(401);
    expect(race.body.error.code).toBe('REFRESH_RACE');

    await prisma.session.updateMany({ where: { userId: user.id, rotatedAt: { not: null } }, data: { rotatedAt: new Date(Date.now() - 60_000) } });
    const reused = await http().post('/api/v1/auth/refresh').set(xhr).set('Cookie', `refresh_token=${oldRefresh}`);
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe('REFRESH_REUSED');
    const after = await http().post('/api/v1/auth/refresh').set(xhr).set('Cookie', `refresh_token=${newRefresh}`);
    expect(after.status).toBe(401);
    expect(await prisma.notification.count({ where: { userId: user.id, kind: 'SECURITY' } })).toBe(1);

    // registerUser'ın açtığı ayrı oturum ailesi etkilenmez
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(204);
  });

  it('logout revokes the session and clears cookies', async () => {
    const { agent } = await registerUser(app);
    const out = await agent.post('/api/v1/auth/logout');
    expect(out.status).toBe(204);
    expect(cookieFrom(out, 'access_token')).toBeUndefined();
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(401);
  });

  it('refresh without a cookie → 401 TOKEN_INVALID', async () => {
    const res = await newAgent(app).post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });
});
```

- [ ] **Step 3: Testin başarısız olduğunu gör**

Run: `pnpm --filter @oto/api test:e2e -- auth.e2e`
Expected: FAIL — `/api/v1/auth/register` 404.

- [ ] **Step 4: Ortak parçaları yaz (dekoratör, guard'lar, audit)**

`apps/api/src/common/decorators/current-user.ts`:
```ts
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../../modules/auth/auth-user';
import { Errors } from '../errors/app-error';

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.user) throw Errors.unauthenticated();
  return req.user;
});
```

`apps/api/src/common/guards/csrf.guard.ts`:
```ts
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@oto/shared';
import type { Request } from 'express';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { SKIP_CSRF } from '../decorators/skip-csrf';
import { AppError } from '../errors/app-error';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowedOrigin: string;

  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) env: Env,
  ) {
    this.allowedOrigin = new URL(env.PUBLIC_BASE_URL).origin;
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (SAFE.has(req.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, [ctx.getHandler(), ctx.getClass()])) return true;
    const origin = req.headers.origin;
    const originOk = origin === undefined || safeOrigin(origin) === this.allowedOrigin;
    if (!req.headers['x-requested-with'] || !originOk) {
      throw new AppError(ErrorCode.CSRF_REJECTED, 403, 'İstek doğrulanamadı');
    }
    return true;
  }
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
```

`apps/api/src/common/guards/jwt-auth.guard.ts`:
```ts
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ACCESS_COOKIE } from '../../modules/auth/auth.constants';
import { TokenService } from '../../modules/auth/token.service';
import { IS_PUBLIC } from '../decorators/public';
import { Errors } from '../errors/app-error';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token: unknown = req.cookies?.[ACCESS_COOKIE];
    if (typeof token === 'string' && token.length > 0) {
      const claims = await this.tokens.verifyAccess(token);
      if (claims) req.user = { id: claims.userId, role: claims.role, sessionId: claims.sessionId };
    }
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (!isPublic && !req.user) throw Errors.unauthenticated();
    return true;
  }
}
```

`apps/api/src/common/guards/throttler.guard.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ErrorCode } from '@oto/shared';
import { AppError } from '../errors/app-error';

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { id?: string } | undefined;
    return user?.id ? `u:${user.id}` : `ip:${String(req.ip)}`;
  }

  protected override async throwThrottlingException(): Promise<void> {
    throw new AppError(ErrorCode.RATE_LIMITED, 429, 'Çok fazla istek. Lütfen biraz bekleyin.');
  }
}
```

`apps/api/src/common/audit/audit.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@oto/db';
import { PrismaService } from '../../infra/prisma.service';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(e: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorId: e.actorId,
        action: e.action,
        targetType: e.targetType ?? null,
        targetId: e.targetId ?? null,
        before: toJson(e.before),
        after: toJson(e.after),
        ip: e.ip ?? null,
      },
    });
  }
}
```

`apps/api/src/common/audit/audit.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
```

- [ ] **Step 5: Auth servis katmanını yaz**

`apps/api/src/modules/auth/cookies.ts`:
```ts
import type { CookieOptions, Response } from 'express';
import type { Env } from '../../config/env';
import { ACCESS_COOKIE, ACCESS_TTL_SEC, REFRESH_COOKIE, REFRESH_PATH, REFRESH_TTL_MS } from './auth.constants';

function base(env: Env): CookieOptions {
  return { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax' };
}

export function setAuthCookies(res: Response, env: Env, access: string, refresh: string): void {
  res.cookie(ACCESS_COOKIE, access, { ...base(env), path: '/', maxAge: ACCESS_TTL_SEC * 1000 });
  res.cookie(REFRESH_COOKIE, refresh, { ...base(env), path: REFRESH_PATH, maxAge: REFRESH_TTL_MS });
}

export function clearAuthCookies(res: Response, env: Env): void {
  res.clearCookie(ACCESS_COOKIE, { ...base(env), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base(env), path: REFRESH_PATH });
}
```

`apps/api/src/modules/auth/public-user.ts`:
```ts
import type { Role, User, UserStatus } from '@oto/db';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  createdAt: Date;
}

export function toPublicUser(u: User): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    emailVerifiedAt: u.emailVerifiedAt,
    createdAt: u.createdAt,
  };
}
```

`apps/api/src/modules/auth/login-attempt.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { RedisService } from '../../infra/redis.service';

export const LOCK_THRESHOLD = 5;
const WINDOW_SEC = 15 * 60;

export interface AttemptKey {
  ip: string;
  email: string;
}

@Injectable()
export class LoginAttemptService {
  constructor(private readonly redis: RedisService) {}

  private key(k: AttemptKey): string {
    return `auth:fail:${k.ip}:${k.email}`;
  }

  async isLocked(k: AttemptKey): Promise<boolean> {
    return Number((await this.redis.get(this.key(k))) ?? 0) >= LOCK_THRESHOLD;
  }

  /** Pencere ilk hatada başlar; yeni hatalar süreyi uzatmaz. */
  async recordFailure(k: AttemptKey): Promise<number> {
    const key = this.key(k);
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, WINDOW_SEC);
    return count;
  }

  async clear(k: AttemptKey): Promise<void> {
    await this.redis.del(this.key(k));
  }
}
```

`apps/api/src/modules/auth/auth.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Prisma, type User } from '@oto/db';
import { ErrorCode, type LoginInput, type RegisterInput } from '@oto/shared';
import { AuditService } from '../../common/audit/audit.service';
import type { ClientMeta } from '../../common/client-meta';
import { AppError, Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../infra/prisma.service';
import { LOCK_THRESHOLD, LoginAttemptService } from './login-attempt.service';
import { PasswordService } from './password.service';
import { toPublicUser, type PublicUser } from './public-user';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

export type RefreshOutcome =
  | { kind: 'ok'; accessToken: string; refreshToken: string }
  | { kind: 'invalid' }
  | { kind: 'race' }
  | { kind: 'reused' };

const emailTaken = () => new AppError(ErrorCode.EMAIL_TAKEN, 409, 'Bu e-posta adresi zaten kayıtlı');

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly attempts: LoginAttemptService,
    private readonly audit: AuditService,
  ) {}

  async register(input: RegisterInput, meta: ClientMeta): Promise<AuthResult> {
    await this.passwords.assertNotBreached(input.password);
    if (await this.prisma.user.findUnique({ where: { email: input.email } })) throw emailTaken();
    const free = await this.prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'FREE' } });
    const passwordHash = await this.passwords.hash(input.password);
    let user: User;
    try {
      user = await this.prisma.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash,
          kvkkAcceptedAt: new Date(),
          subscriptions: { create: { planId: free.id } },
          channels: { create: { type: 'IN_APP', isVerified: true } },
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw emailTaken();
      throw err;
    }
    return this.startSession(user, meta);
  }

  async login(input: LoginInput, meta: ClientMeta): Promise<AuthResult> {
    const key = { ip: meta.ip ?? 'unknown', email: input.email };
    if (await this.attempts.isLocked(key)) {
      throw new AppError(ErrorCode.LOGIN_LOCKED, 429, 'Çok fazla hatalı deneme. 15 dakika sonra tekrar deneyin.');
    }
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    const usable = user !== null && user.status !== 'DELETED';
    const ok = usable
      ? await this.passwords.verify(user.passwordHash, input.password)
      : await this.passwords.dummyVerify(input.password);
    if (!usable || !ok) {
      const count = await this.attempts.recordFailure(key);
      if (count === LOCK_THRESHOLD) {
        await this.audit.record({
          actorId: null,
          action: 'auth.login_locked',
          targetType: 'User',
          targetId: user?.id ?? null,
          after: { email: input.email },
          ip: meta.ip,
        });
      }
      throw Errors.invalidCredentials();
    }
    if (user.status === 'SUSPENDED') {
      throw new AppError(ErrorCode.ACCOUNT_SUSPENDED, 403, 'Hesabınız askıya alınmış');
    }
    await this.attempts.clear(key);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.startSession(user, meta);
  }

  async refresh(presented: string | undefined, meta: ClientMeta): Promise<RefreshOutcome> {
    if (!presented) return { kind: 'invalid' };
    const r = await this.sessions.rotate(presented, meta);
    if (r.kind === 'reused') {
      await this.audit.record({
        actorId: r.userId,
        action: 'auth.refresh_reused',
        targetType: 'Session',
        targetId: r.familyId,
        ip: meta.ip,
      });
      await this.prisma.notification.create({
        data: {
          userId: r.userId,
          kind: 'SECURITY',
          channel: 'IN_APP',
          status: 'SENT',
          sentAt: new Date(),
          payload: { type: 'REFRESH_REUSED', familyId: r.familyId },
        },
      });
      return { kind: 'reused' };
    }
    if (r.kind !== 'ok') return { kind: r.kind };
    const accessToken = await this.tokens.signAccess({ userId: r.userId, role: r.role, sessionId: r.familyId });
    return { kind: 'ok', accessToken, refreshToken: r.refreshToken };
  }

  async logout(presented: string | undefined): Promise<void> {
    if (presented) await this.sessions.revokeByToken(presented);
  }

  private async startSession(user: User, meta: ClientMeta): Promise<AuthResult> {
    const { familyId, refreshToken } = await this.sessions.create(user.id, meta);
    const accessToken = await this.tokens.signAccess({ userId: user.id, role: user.role, sessionId: familyId });
    return { user: toPublicUser(user), accessToken, refreshToken };
  }
}
```

`apps/api/src/modules/auth/auth.controller.ts`:
```ts
import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ErrorCode, loginSchema, registerSchema, type LoginInput, type RegisterInput } from '@oto/shared';
import type { Request, Response } from 'express';
import { Meta, type ClientMeta } from '../../common/client-meta';
import { Public } from '../../common/decorators/public';
import { AppError } from '../../common/errors/app-error';
import { ZodPipe } from '../../common/zod.pipe';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { REFRESH_COOKIE } from './auth.constants';
import { AuthService } from './auth.service';
import { clearAuthCookies, setAuthCookies } from './cookies';

function refreshCookie(req: Request): string | undefined {
  const v: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

@Public()
@Throttle({ default: { limit: 10, ttl: 60_000 } })
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('register')
  async register(
    @Body(new ZodPipe(registerSchema)) body: RegisterInput,
    @Meta() meta: ClientMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.auth.register(body, meta);
    setAuthCookies(res, this.env, r.accessToken, r.refreshToken);
    return { user: r.user };
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(loginSchema)) body: LoginInput,
    @Meta() meta: ClientMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.auth.login(body, meta);
    setAuthCookies(res, this.env, r.accessToken, r.refreshToken);
    return { user: r.user };
  }

  @Post('refresh')
  @HttpCode(204)
  async refresh(@Req() req: Request, @Meta() meta: ClientMeta, @Res({ passthrough: true }) res: Response) {
    const out = await this.auth.refresh(refreshCookie(req), meta);
    if (out.kind === 'ok') {
      setAuthCookies(res, this.env, out.accessToken, out.refreshToken);
      return;
    }
    if (out.kind === 'race') {
      throw new AppError(ErrorCode.REFRESH_RACE, 401, 'Oturum yenileniyor, lütfen tekrar deneyin');
    }
    clearAuthCookies(res, this.env);
    if (out.kind === 'reused') {
      throw new AppError(ErrorCode.REFRESH_REUSED, 401, 'Oturumunuz güvenlik nedeniyle sonlandırıldı');
    }
    throw new AppError(ErrorCode.TOKEN_INVALID, 401, 'Oturum süresi doldu, lütfen tekrar giriş yapın');
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(refreshCookie(req));
    clearAuthCookies(res, this.env);
  }
}
```

`apps/api/src/modules/auth/auth.module.ts` (tamamı):
```ts
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginAttemptService } from './login-attempt.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController],
  providers: [PasswordService, TokenService, SessionService, LoginAttemptService, AuthService],
  exports: [PasswordService, TokenService, SessionService],
})
export class AuthModule {}
```

- [ ] **Step 6: `/me` modülünü yaz**

`apps/api/src/modules/me/me.repository.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma.service';

/** /me altındaki TEK veri erişim noktası. Her sorgu userId ile kapsamlanır. */
@Injectable()
export class MeRepository {
  constructor(private readonly prisma: PrismaService) {}

  findUser(userId: string) {
    return this.prisma.user.findFirst({ where: { id: userId, status: { not: 'DELETED' } } });
  }

  findActiveSubscription(userId: string) {
    return this.prisma.userSubscription.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: { plan: true },
      orderBy: { startsAt: 'desc' },
    });
  }

  countSearchProfiles(userId: string) {
    return this.prisma.searchProfile.count({ where: { userId } });
  }

  countExternalNotificationsSince(userId: string, since: Date) {
    return this.prisma.notification.count({
      where: { userId, kind: 'MATCH', channel: { not: 'IN_APP' }, status: { not: 'SKIPPED_LIMIT' }, createdAt: { gte: since } },
    });
  }
}
```

`apps/api/src/modules/me/me.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { planLimitsSchema, startOfIstanbulDay, type PlanLimits } from '@oto/shared';
import { Errors } from '../../common/errors/app-error';
import { toPublicUser, type PublicUser } from '../auth/public-user';
import { MeRepository } from './me.repository';

export interface MeProfile {
  user: PublicUser;
  subscription: { planCode: string; planName: string; limits: PlanLimits; status: string; endsAt: Date | null } | null;
  usage: { searchProfiles: number; notificationsToday: number };
}

@Injectable()
export class MeService {
  constructor(private readonly repo: MeRepository) {}

  async getProfile(userId: string): Promise<MeProfile> {
    const user = await this.repo.findUser(userId);
    if (!user) throw Errors.unauthenticated();
    const [sub, searchProfiles, notificationsToday] = await Promise.all([
      this.repo.findActiveSubscription(userId),
      this.repo.countSearchProfiles(userId),
      this.repo.countExternalNotificationsSince(userId, startOfIstanbulDay(new Date())),
    ]);
    return {
      user: toPublicUser(user),
      subscription: sub
        ? {
            planCode: sub.plan.code,
            planName: sub.plan.name,
            limits: planLimitsSchema.parse(sub.plan.limits),
            status: sub.status,
            endsAt: sub.endsAt,
          }
        : null,
      usage: { searchProfiles, notificationsToday },
    };
  }
}
```

`apps/api/src/modules/me/me.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user';
import type { AuthUser } from '../auth/auth-user';
import { MeService } from './me.service';

@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.me.getProfile(user.id);
  }
}
```

`apps/api/src/modules/me/me.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MeController } from './me.controller';
import { MeRepository } from './me.repository';
import { MeService } from './me.service';

@Module({ imports: [AuthModule], controllers: [MeController], providers: [MeRepository, MeService] })
export class MeModule {}
```

- [ ] **Step 7: `AppModule`'ü güncelle** (`apps/api/src/app.module.ts` tamamı)

```ts
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './common/audit/audit.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { CsrfGuard } from './common/guards/csrf.guard';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { AppThrottlerGuard } from './common/guards/throttler.guard';
import { loggerOptions } from './common/logger';
import { ConfigModule, ENV } from './config/config.module';
import type { Env } from './config/env';
import { InfraModule } from './infra/infra.module';
import { RedisService } from './infra/redis.service';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { MeModule } from './modules/me/me.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({ inject: [ENV], useFactory: (env: Env) => loggerOptions(env) }),
    InfraModule,
    CryptoModule,
    AuditModule,
    ThrottlerModule.forRootAsync({
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
        storage: new ThrottlerStorageRedisService(redis),
      }),
    }),
    HealthModule,
    AuthModule,
    MeModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Sıra önemlidir: CSRF → kimlik → (Task 9: roller) → hız limiti
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
  ],
})
export class AppModule {}
```

- [ ] **Step 8: Testleri çalıştır**

Run: `pnpm --filter @oto/api test:e2e`
Expected: Tüm testler PASS (health, session, auth).

- [ ] **Step 9: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck`
```bash
git add -A
git commit -m "feat(auth): add register/login/refresh/logout endpoints with CSRF, JWT and rate-limit guards"
```

---

### Task 7: E-posta doğrulama ve şifre sıfırlama

**Files:**
- Create: `apps/api/src/modules/mail/mail.service.ts`, `apps/api/src/modules/mail/templates.ts`, `apps/api/src/modules/mail/mail.module.ts`, `apps/api/src/modules/auth/email-verification.service.ts`, `apps/api/src/modules/auth/password-reset.service.ts`
- Modify: `apps/api/src/modules/auth/auth.service.ts` (register doğrulama e-postası gönderir), `apps/api/src/modules/auth/auth.controller.ts` (3 uç nokta), `apps/api/src/modules/auth/auth.module.ts`, `apps/api/src/app.module.ts`, `apps/api/test/helpers.ts`
- Test: `apps/api/test/email-flows.e2e.spec.ts`

**Interfaces:**
- Consumes: `generateToken`, `hashToken`, `VERIFY_TTL_MS`, `RESET_TTL_MS`, `PasswordService`, `SessionService`, `AuditService`.
- Produces:
  - `MailService.send(mail: OutgoingMail): Promise<void>`; `OutgoingMail { to: string; subject: string; text: string }`; `MailService.outbox: OutgoingMail[]` (yalnızca `MAIL_TRANSPORT=json`'da dolar); `MailModule` (global).
  - `verifyEmailMail(name, link)`, `resetPasswordMail(name, link)` → `{ subject, text }`.
  - `EmailVerificationService.sendFor(user: User): Promise<void>`, `.verify(token): Promise<boolean>`.
  - `PasswordResetService.request(email): Promise<void>`, `.reset(input: ResetPasswordInput, meta): Promise<boolean>`.
  - API: `POST /auth/verify-email` (204 / 400 TOKEN_INVALID), `POST /auth/forgot-password` (her zaman 204), `POST /auth/reset-password` (204 / 400 TOKEN_INVALID).

- [ ] **Step 1: Test yardımcısını güncelle** — `apps/api/test/helpers.ts` içinde `resetState`'in sonuna ekle:

```ts
import { MailService } from '../src/modules/mail/mail.service';
// resetState içinde, seedPlans'tan sonra:
  app.get(MailService).outbox.length = 0;
```
Dosya sonuna ekle:
```ts
export function tokenFromMail(text: string): string {
  const m = text.match(/token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`no token in mail: ${text}`);
  return m[1];
}
```

- [ ] **Step 2: Başarısız e2e testini yaz** (`apps/api/test/email-flows.e2e.spec.ts`)

```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { MailService } from '../src/modules/mail/mail.service';
import { createTestApp, registerUser, resetState, tokenFromMail } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
let mail: MailService;
const http = () => request(app.getHttpServer());
const xhr = { 'X-Requested-With': 'XMLHttpRequest' };

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
  mail = app.get(MailService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetState(app);
});

describe('email verification', () => {
  it('register sends a link; verifying marks the user and the token is single-use', async () => {
    const { user } = await registerUser(app, { email: 'verify@test.com' });
    expect(mail.outbox).toHaveLength(1);
    expect(mail.outbox[0].to).toBe('verify@test.com');
    expect(mail.outbox[0].text).toContain('http://localhost:3000/verify-email?token=');
    const token = tokenFromMail(mail.outbox[0].text);

    expect((await http().post('/api/v1/auth/verify-email').set(xhr).send({ token })).status).toBe(204);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).not.toBeNull();

    const again = await http().post('/api/v1/auth/verify-email').set(xhr).send({ token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects an expired verification token', async () => {
    await registerUser(app, { email: 'exp@test.com' });
    await prisma.emailVerificationToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    const res = await http().post('/api/v1/auth/verify-email').set(xhr).send({ token: tokenFromMail(mail.outbox[0].text) });
    expect(res.status).toBe(400);
  });
});

describe('password reset', () => {
  it('always answers 204 and sends nothing for unknown emails', async () => {
    const res = await http().post('/api/v1/auth/forgot-password').set(xhr).send({ email: 'ghost@test.com' });
    expect(res.status).toBe(204);
    expect(mail.outbox).toHaveLength(0);
  });

  it('resets the password, revokes every session and audits', async () => {
    const { agent, user } = await registerUser(app, { email: 'reset@test.com' });
    mail.outbox.length = 0;
    expect((await http().post('/api/v1/auth/forgot-password').set(xhr).send({ email: 'RESET@test.com' })).status).toBe(204);
    expect(mail.outbox).toHaveLength(1);
    const token = tokenFromMail(mail.outbox[0].text);

    const weak = await http().post('/api/v1/auth/reset-password').set(xhr).send({ token, newPassword: 'short' });
    expect(weak.status).toBe(400);

    expect((await http().post('/api/v1/auth/reset-password').set(xhr).send({ token, newPassword: 'brand-new-password' })).status).toBe(204);
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(401);
    const oldLogin = await http().post('/api/v1/auth/login').set(xhr).send({ email: 'reset@test.com', password: 'a-very-strong-pass' });
    expect(oldLogin.status).toBe(401);
    const newLogin = await http().post('/api/v1/auth/login').set(xhr).send({ email: 'reset@test.com', password: 'brand-new-password' });
    expect(newLogin.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'auth.password_reset', targetId: user.id } })).toBe(1);

    const reuse = await http().post('/api/v1/auth/reset-password').set(xhr).send({ token, newPassword: 'another-password-9' });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects an expired reset token', async () => {
    await registerUser(app, { email: 'old@test.com' });
    mail.outbox.length = 0;
    await http().post('/api/v1/auth/forgot-password').set(xhr).send({ email: 'old@test.com' });
    await prisma.passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    const res = await http().post('/api/v1/auth/reset-password').set(xhr)
      .send({ token: tokenFromMail(mail.outbox[0].text), newPassword: 'brand-new-password' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Testin başarısız olduğunu gör**

Run: `pnpm --filter @oto/api test:e2e -- email-flows`
Expected: FAIL — `Cannot find module '../src/modules/mail/mail.service'`.

- [ ] **Step 4: Mail modülünü yaz**

`apps/api/src/modules/mail/mail.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

@Injectable()
export class MailService {
  /** Yalnızca MAIL_TRANSPORT=json (test) modunda doldurulur. */
  readonly outbox: OutgoingMail[] = [];
  private readonly transporter: Transporter;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.transporter =
      env.MAIL_TRANSPORT === 'json'
        ? createTransport({ jsonTransport: true })
        : createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: false });
  }

  async send(mail: OutgoingMail): Promise<void> {
    await this.transporter.sendMail({ from: this.env.SMTP_FROM, ...mail });
    if (this.env.MAIL_TRANSPORT === 'json') this.outbox.push(mail);
  }
}
```

`apps/api/src/modules/mail/templates.ts`:
```ts
export function verifyEmailMail(name: string, link: string) {
  return {
    subject: 'E-posta adresinizi doğrulayın',
    text: `Merhaba ${name},\n\nHesabınızı etkinleştirmek için bağlantıya tıklayın (24 saat geçerli):\n${link}\n\nBu işlemi siz yapmadıysanız bu e-postayı yok sayabilirsiniz.\n\nOto Fırsat`,
  };
}

export function resetPasswordMail(name: string, link: string) {
  return {
    subject: 'Şifre sıfırlama isteği',
    text: `Merhaba ${name},\n\nŞifrenizi sıfırlamak için bağlantıya tıklayın (30 dakika geçerli):\n${link}\n\nBu isteği siz yapmadıysanız şifreniz değişmez; bu e-postayı yok sayabilirsiniz.\n\nOto Fırsat`,
  };
}
```

`apps/api/src/modules/mail/mail.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}
```

- [ ] **Step 5: Doğrulama ve sıfırlama servislerini yaz**

`apps/api/src/modules/auth/email-verification.service.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { User } from '@oto/db';
import { generateToken, hashToken } from '../../common/crypto/tokens';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infra/prisma.service';
import { MailService } from '../mail/mail.service';
import { verifyEmailMail } from '../mail/templates';
import { VERIFY_TTL_MS } from './auth.constants';

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** E-posta gönderilemezse kayıt başarısız olmaz; hata loglanır. */
  async sendFor(user: User): Promise<void> {
    const token = generateToken();
    await this.prisma.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) },
    });
    const link = `${this.env.PUBLIC_BASE_URL}/verify-email?token=${token}`;
    try {
      await this.mail.send({ to: user.email, ...verifyEmailMail(user.name, link) });
    } catch (err) {
      this.logger.warn({ err, userId: user.id }, 'Verification mail failed');
    }
  }

  async verify(token: string): Promise<boolean> {
    const row = await this.prisma.emailVerificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) return false;
    const now = new Date();
    const used = await this.prisma.emailVerificationToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    if (used.count !== 1) return false;
    await this.prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: now } });
    return true;
  }
}
```

`apps/api/src/modules/auth/password-reset.service.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ResetPasswordInput } from '@oto/shared';
import { AuditService } from '../../common/audit/audit.service';
import type { ClientMeta } from '../../common/client-meta';
import { generateToken, hashToken } from '../../common/crypto/tokens';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { PrismaService } from '../../infra/prisma.service';
import { MailService } from '../mail/mail.service';
import { resetPasswordMail } from '../mail/templates';
import { RESET_TTL_MS } from './auth.constants';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Kullanıcının var olup olmadığını dışarı sızdırmaz. */
  async request(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE') return;
    const token = generateToken();
    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    });
    const link = `${this.env.PUBLIC_BASE_URL}/reset-password?token=${token}`;
    try {
      await this.mail.send({ to: user.email, ...resetPasswordMail(user.name, link) });
    } catch (err) {
      this.logger.warn({ err, userId: user.id }, 'Reset mail failed');
    }
  }

  async reset(input: ResetPasswordInput, meta: ClientMeta): Promise<boolean> {
    const row = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(input.token) } });
    if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) return false;
    await this.passwords.assertNotBreached(input.newPassword);
    const used = await this.prisma.passwordResetToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (used.count !== 1) return false;
    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.prisma.user.update({ where: { id: row.userId }, data: { passwordHash } });
    await this.sessions.revokeAllForUser(row.userId);
    await this.audit.record({
      actorId: row.userId,
      action: 'auth.password_reset',
      targetType: 'User',
      targetId: row.userId,
      ip: meta.ip,
    });
    return true;
  }
}
```

- [ ] **Step 6: Mevcut dosyaları değiştir**

`apps/api/src/modules/auth/auth.service.ts`:
- Constructor'a `private readonly verification: EmailVerificationService,` ekle (import: `import { EmailVerificationService } from './email-verification.service';`).
- `register` içinde `return this.startSession(user, meta);` satırını şununla değiştir:
```ts
    await this.verification.sendFor(user);
    return this.startSession(user, meta);
```

`apps/api/src/modules/auth/auth.controller.ts` — import'lara `forgotPasswordSchema, resetPasswordSchema, verifyEmailSchema, type ResetPasswordInput` (`@oto/shared`), `EmailVerificationService`, `PasswordResetService` ekle; constructor'a iki servisi ekle:
```ts
  constructor(
    private readonly auth: AuthService,
    private readonly verification: EmailVerificationService,
    private readonly resets: PasswordResetService,
    @Inject(ENV) private readonly env: Env,
  ) {}
```
Sınıfın sonuna ekle:
```ts
  @Post('verify-email')
  @HttpCode(204)
  async verifyEmail(@Body(new ZodPipe(verifyEmailSchema)) body: { token: string }) {
    if (!(await this.verification.verify(body.token))) {
      throw new AppError(ErrorCode.TOKEN_INVALID, 400, 'Bağlantı geçersiz veya süresi dolmuş');
    }
  }

  @Post('forgot-password')
  @HttpCode(204)
  async forgotPassword(@Body(new ZodPipe(forgotPasswordSchema)) body: { email: string }) {
    await this.resets.request(body.email);
  }

  @Post('reset-password')
  @HttpCode(204)
  async resetPassword(@Body(new ZodPipe(resetPasswordSchema)) body: ResetPasswordInput, @Meta() meta: ClientMeta) {
    if (!(await this.resets.reset(body, meta))) {
      throw new AppError(ErrorCode.TOKEN_INVALID, 400, 'Bağlantı geçersiz veya süresi dolmuş');
    }
  }
```

`apps/api/src/modules/auth/auth.module.ts` — `providers` dizisine `EmailVerificationService, PasswordResetService` ekle (import'larıyla).

`apps/api/src/app.module.ts` — `imports`'a `AuditModule`'den sonra `MailModule` ekle (`import { MailModule } from './modules/mail/mail.module';`).

- [ ] **Step 7: Testleri çalıştır**

Run: `pnpm --filter @oto/api test:e2e`
Expected: Tüm testler PASS. `auth.e2e` içindeki register testleri de geçer (doğrulama e-postası outbox'a düşer).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(auth): add email verification and password reset flows"
```

---

### Task 8: `/me` — profil, şifre değişimi, oturumlar, hesap silme, lint kuralı

**Files:**
- Modify: `apps/api/src/modules/me/me.repository.ts`, `apps/api/src/modules/me/me.service.ts`, `apps/api/src/modules/me/me.controller.ts`, `eslint.config.mjs`
- Test: `apps/api/test/me.e2e.spec.ts`, `apps/api/test/lint/me-prisma-rule.spec.ts`

**Interfaces:**
- Consumes: `MeRepository`, `PasswordService`, `SessionService`, `clearAuthCookies`, şemalar `updateMeSchema`, `changePasswordSchema`, `deleteMeSchema`.
- Produces:
  - `MeRepository`: `updateName(userId, name)`, `findPasswordHash(userId): Promise<string | null>`, `updatePasswordHash(userId, hash)`, `anonymizeAndDelete(userId): Promise<void>`.
  - `MeService`: `updateName(userId, input): Promise<{ user: PublicUser }>`, `changePassword(user: AuthUser, input): Promise<void>`, `listSessions(user: AuthUser): Promise<{ items: (SessionView & { current: boolean })[] }>`, `revokeSession(userId, familyId): Promise<void>` (404), `deleteAccount(userId, input): Promise<void>`.
  - API: `PATCH /me`, `POST /me/change-password` (204), `GET /me/sessions`, `DELETE /me/sessions/:id` (204/404), `DELETE /me` (204).

- [ ] **Step 1: Başarısız e2e testini yaz** (`apps/api/test/me.e2e.spec.ts`)

```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { createTestApp, newAgent, registerUser, resetState } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
const xhr = { 'X-Requested-With': 'XMLHttpRequest' };

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetState(app);
});

async function loginAgain(email: string, password: string) {
  const agent = newAgent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return agent;
}

describe('/me', () => {
  it('PATCH /me trims the name and validates length', async () => {
    const { agent } = await registerUser(app);
    const ok = await agent.patch('/api/v1/me').send({ name: '  Yeni İsim  ' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.name).toBe('Yeni İsim');
    expect((await agent.patch('/api/v1/me').send({ name: 'x'.repeat(81) })).status).toBe(400);
  });

  it('change-password keeps the current session and kills the others', async () => {
    const { agent, email, password } = await registerUser(app);
    const other = await loginAgain(email, password);
    const wrong = await agent.post('/api/v1/me/change-password').send({ currentPassword: 'not-it-at-all', newPassword: 'another-strong-pw' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    const res = await agent.post('/api/v1/me/change-password').send({ currentPassword: password, newPassword: 'another-strong-pw' });
    expect(res.status).toBe(204);
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(204);
    expect((await other.post('/api/v1/auth/refresh')).status).toBe(401);
  });

  it('lists sessions with a current flag and revokes one by id', async () => {
    const { agent, email, password } = await registerUser(app);
    const other = await loginAgain(email, password);
    const list = await agent.get('/api/v1/me/sessions');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    const current = list.body.items.filter((s: { current: boolean }) => s.current);
    expect(current).toHaveLength(1);
    const otherId = list.body.items.find((s: { current: boolean }) => !s.current).id;
    expect((await agent.delete(`/api/v1/me/sessions/${otherId}`)).status).toBe(204);
    expect((await other.post('/api/v1/auth/refresh')).status).toBe(401);
    expect((await agent.delete(`/api/v1/me/sessions/${otherId}`)).status).toBe(404);
  });

  it('DELETE /me requires the password, anonymizes and frees the email', async () => {
    const { agent, user, email, password } = await registerUser(app, { email: 'bye@test.com' });
    expect((await agent.delete('/api/v1/me').send({ password: 'not-it-at-all' })).status).toBe(400);
    const res = await agent.delete('/api/v1/me').send({ password });
    expect(res.status).toBe(204);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.status).toBe('DELETED');
    expect(row.email).toBe(`deleted+${user.id}@invalid.local`);
    expect(await prisma.notificationChannel.count({ where: { userId: user.id } })).toBe(0);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(xhr).send({ email, password });
    expect(login.status).toBe(401);
    await registerUser(app, { email: 'bye@test.com' });
  });
});
```

`apps/api/test/lint/me-prisma-rule.spec.ts`:
```ts
import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd(), '../..');
const source = `export class X { constructor(private readonly prisma: { user: { findMany(): void } }) {} run() { return this.prisma.user.findMany(); } }\n`;

describe('me/ prisma lint rule', () => {
  it('forbids direct prisma access in /me services', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const [result] = await eslint.lintText(source, { filePath: resolve(repoRoot, 'apps/api/src/modules/me/bad.service.ts') });
    expect(result.messages.some((m) => m.ruleId === 'no-restricted-syntax')).toBe(true);
  });

  it('allows it inside *.repository.ts', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const [result] = await eslint.lintText(source, { filePath: resolve(repoRoot, 'apps/api/src/modules/me/ok.repository.ts') });
    expect(result.messages.filter((m) => m.ruleId === 'no-restricted-syntax')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Testlerin başarısız olduğunu gör**

Run: `pnpm --filter @oto/api test && pnpm --filter @oto/api test:e2e -- me.e2e`
Expected: Lint testi FAIL (kural yok); me e2e FAIL (`PATCH /me` 404).

- [ ] **Step 3: ESLint kuralını ekle** — `eslint.config.mjs`'de `tseslint.config(` çağrısının son argümanı olarak ekle:

```js
  {
    files: ['apps/api/src/modules/me/**/*.ts'],
    ignores: ['apps/api/src/modules/me/**/*.repository.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='prisma']",
          message: '/me modüllerinde veri erişimi yalnızca userId ile kapsamlanmış *.repository.ts üzerinden yapılır.',
        },
        {
          selector: "Identifier[name='PrismaService']",
          message: '/me modüllerinde PrismaService yerine *.repository.ts kullanın.',
        },
      ],
    },
  },
```

- [ ] **Step 4: Repository, servis ve controller'ı genişlet**

`apps/api/src/modules/me/me.repository.ts` — sınıfa ekle:
```ts
  updateName(userId: string, name: string) {
    return this.prisma.user.update({ where: { id: userId }, data: { name } });
  }

  async findPasswordHash(userId: string): Promise<string | null> {
    const u = await this.prisma.user.findFirst({ where: { id: userId, status: { not: 'DELETED' } }, select: { passwordHash: true } });
    return u?.passwordHash ?? null;
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  }

  /** KVKK: kişisel alanlar anonimleştirilir; profiller, kanallar, favoriler silinir. Bildirimler saklama süresi sonunda temizlenir. */
  async anonymizeAndDelete(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.searchProfile.deleteMany({ where: { userId } }),
      this.prisma.notificationChannel.deleteMany({ where: { userId } }),
      this.prisma.favorite.deleteMany({ where: { userId } }),
      this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          status: 'DELETED',
          email: `deleted+${userId}@invalid.local`,
          name: 'Silinmiş kullanıcı',
          passwordHash: '',
          emailVerifiedAt: null,
        },
      }),
    ]);
  }
```

`apps/api/src/modules/me/me.service.ts` — import'ları ve constructor'ı güncelle, metotları ekle:
```ts
import { Injectable } from '@nestjs/common';
import {
  planLimitsSchema,
  startOfIstanbulDay,
  type ChangePasswordInput,
  type DeleteMeInput,
  type PlanLimits,
  type UpdateMeInput,
} from '@oto/shared';
import { Errors } from '../../common/errors/app-error';
import type { AuthUser } from '../auth/auth-user';
import { PasswordService } from '../auth/password.service';
import { toPublicUser, type PublicUser } from '../auth/public-user';
import { SessionService, type SessionView } from '../auth/session.service';
import { MeRepository } from './me.repository';

// MeProfile arayüzü değişmeden kalır.

@Injectable()
export class MeService {
  constructor(
    private readonly repo: MeRepository,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
  ) {}

  // getProfile değişmeden kalır.

  async updateName(userId: string, input: UpdateMeInput): Promise<{ user: PublicUser }> {
    return { user: toPublicUser(await this.repo.updateName(userId, input.name)) };
  }

  async changePassword(user: AuthUser, input: ChangePasswordInput): Promise<void> {
    await this.assertPassword(user.id, input.currentPassword);
    await this.passwords.assertNotBreached(input.newPassword);
    await this.repo.updatePasswordHash(user.id, await this.passwords.hash(input.newPassword));
    await this.sessions.revokeAllForUser(user.id, { exceptFamilyId: user.sessionId });
  }

  async listSessions(user: AuthUser): Promise<{ items: (SessionView & { current: boolean })[] }> {
    const items = await this.sessions.listActive(user.id);
    return { items: items.map((s) => ({ ...s, current: s.id === user.sessionId })) };
  }

  async revokeSession(userId: string, familyId: string): Promise<void> {
    if (!(await this.sessions.revokeFamilyForUser(userId, familyId))) throw Errors.notFound();
  }

  async deleteAccount(userId: string, input: DeleteMeInput): Promise<void> {
    await this.assertPassword(userId, input.password);
    await this.repo.anonymizeAndDelete(userId);
  }

  private async assertPassword(userId: string, password: string): Promise<void> {
    const hash = await this.repo.findPasswordHash(userId);
    if (!hash || !(await this.passwords.verify(hash, password))) throw Errors.invalidCredentials(400);
  }
}
```

`apps/api/src/modules/me/me.controller.ts` (tamamı):
```ts
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import {
  changePasswordSchema,
  deleteMeSchema,
  updateMeSchema,
  type ChangePasswordInput,
  type DeleteMeInput,
  type UpdateMeInput,
} from '@oto/shared';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user';
import { ZodPipe } from '../../common/zod.pipe';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import type { AuthUser } from '../auth/auth-user';
import { clearAuthCookies } from '../auth/cookies';
import { MeService } from './me.service';

@Controller('me')
export class MeController {
  constructor(
    private readonly me: MeService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.me.getProfile(user.id);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body(new ZodPipe(updateMeSchema)) body: UpdateMeInput) {
    return this.me.updateName(user.id, body);
  }

  @Post('change-password')
  @HttpCode(204)
  async changePassword(@CurrentUser() user: AuthUser, @Body(new ZodPipe(changePasswordSchema)) body: ChangePasswordInput) {
    await this.me.changePassword(user, body);
  }

  @Get('sessions')
  sessions(@CurrentUser() user: AuthUser) {
    return this.me.listSessions(user);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.me.revokeSession(user.id, id);
  }

  @Delete()
  @HttpCode(204)
  async deleteAccount(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(deleteMeSchema)) body: DeleteMeInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.me.deleteAccount(user.id, body);
    clearAuthCookies(res, this.env);
  }
}
```

- [ ] **Step 5: Testleri çalıştır**

Run: `pnpm --filter @oto/api test && pnpm --filter @oto/api test:e2e && pnpm lint`
Expected: Tüm testler PASS; lint hatasız.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(me): add profile update, password change, session management and account deletion"
```

---

### Task 9: RBAC, admin kullanıcı yönetimi ve audit interceptor

**Files:**
- Create: `apps/api/src/common/guards/roles.guard.ts`, `apps/api/src/common/audit/audited.decorator.ts`, `apps/api/src/common/audit/audit.interceptor.ts`, `apps/api/src/modules/admin/admin-users.service.ts`, `apps/api/src/modules/admin/admin-users.controller.ts`, `apps/api/src/modules/admin/admin.module.ts`
- Modify: `apps/api/src/common/audit/audit.module.ts`, `apps/api/src/app.module.ts`, `apps/api/test/helpers.ts`
- Test: `apps/api/test/admin-users.e2e.spec.ts`

**Interfaces:**
- Consumes: `ROLES`, `Roles`, `PrismaService`, `SessionService`, `AuditService`, `adminUsersQuerySchema`, `toPublicUser`.
- Produces:
  - `RolesGuard` (APP_GUARD; JWT'den sonra, throttler'dan önce): oturum ailesini ve kullanıcıyı DB'den canlı doğrular, rolü DB'den alır.
  - `AUDIT_ACTION`, `Audited(action: string)`, `AuditedResult<T> { result: T; audit: { targetType: string; targetId: string; before?: unknown; after?: unknown } }`, `AuditInterceptor` (APP_INTERCEPTOR).
  - `AdminUsersService`: `list(q: AdminUsersQuery)`, `get(id)`, `suspend(actor: AuthUser, id)`, `activate(actor: AuthUser, id)`.
  - API: `GET /admin/users`, `GET /admin/users/:id`, `POST /admin/users/:id/suspend`, `POST /admin/users/:id/activate`.
  - Test yardımcısı: `setRole(app, userId, role)`.

- [ ] **Step 1: Test yardımcısını ekle** — `apps/api/test/helpers.ts` sonuna:

```ts
import type { Role } from '@oto/db';

export async function setRole(app: NestExpressApplication, userId: string, role: Role): Promise<void> {
  await app.get(PrismaService).user.update({ where: { id: userId }, data: { role } });
}
```

- [ ] **Step 2: Başarısız e2e testini yaz** (`apps/api/test/admin-users.e2e.spec.ts`)

```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infra/prisma.service';
import { createTestApp, registerUser, resetState, setRole } from './helpers';

let app: NestExpressApplication;
let prisma: PrismaService;
const xhr = { 'X-Requested-With': 'XMLHttpRequest' };

beforeAll(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetState(app);
});

describe('RBAC', () => {
  it('USER gets 403, ADMIN gets 200 without re-login (role read from DB)', async () => {
    const u = await registerUser(app);
    expect((await u.agent.get('/api/v1/admin/users')).status).toBe(403);
    await setRole(app, u.user.id, 'ADMIN');
    const res = await u.agent.get('/api/v1/admin/users');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, items: [expect.objectContaining({ id: u.user.id, planCode: 'FREE' })] });
  });

  it('a demoted admin with a still-valid ADMIN token is refused', async () => {
    const a = await registerUser(app);
    await setRole(app, a.user.id, 'ADMIN');
    const relog = await a.agent.post('/api/v1/auth/login').send({ email: a.email, password: a.password });
    expect(relog.status).toBe(200);
    await setRole(app, a.user.id, 'USER');
    expect((await a.agent.get('/api/v1/admin/users')).status).toBe(403);
  });

  it('a suspended admin with a still-valid token gets 401 on admin routes', async () => {
    const a = await registerUser(app);
    await setRole(app, a.user.id, 'ADMIN');
    await prisma.user.update({ where: { id: a.user.id }, data: { status: 'SUSPENDED' } });
    expect((await a.agent.get('/api/v1/admin/users')).status).toBe(401);
  });
});

describe('admin users', () => {
  it('searches by email/name case-insensitively and validates paging', async () => {
    const admin = await registerUser(app, { name: 'Yönetici' });
    await setRole(app, admin.user.id, 'ADMIN');
    await registerUser(app, { email: 'zeynep@test.com', name: 'Zeynep' });
    const res = await admin.agent.get('/api/v1/admin/users').query({ q: 'ZEYN' });
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].email).toBe('zeynep@test.com');
    expect((await admin.agent.get('/api/v1/admin/users').query({ pageSize: 101 })).status).toBe(400);
  });

  it('suspends a user: login blocked, refresh dead, audit written with before/after', async () => {
    const admin = await registerUser(app);
    await setRole(app, admin.user.id, 'ADMIN');
    const victim = await registerUser(app, { email: 'victim@test.com' });

    const res = await admin.agent.post(`/api/v1/admin/users/${victim.user.id}/suspend`);
    expect(res.status).toBe(201);
    expect(res.body.user.status).toBe('SUSPENDED');

    expect((await victim.agent.post('/api/v1/auth/refresh')).status).toBe(401);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set(xhr)
      .send({ email: 'victim@test.com', password: victim.password });
    expect(login.status).toBe(403);

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'user.suspend' } });
    expect(log).toMatchObject({
      actorId: admin.user.id,
      targetType: 'User',
      targetId: victim.user.id,
      before: { status: 'ACTIVE' },
      after: { status: 'SUSPENDED' },
    });

    expect((await admin.agent.post(`/api/v1/admin/users/${victim.user.id}/activate`)).body.user.status).toBe('ACTIVE');
    expect(await prisma.auditLog.count({ where: { action: 'user.activate' } })).toBe(1);
  });

  it('ADMIN cannot suspend a SUPER_ADMIN; nobody can suspend themselves', async () => {
    const admin = await registerUser(app);
    await setRole(app, admin.user.id, 'ADMIN');
    const boss = await registerUser(app);
    await setRole(app, boss.user.id, 'SUPER_ADMIN');
    expect((await admin.agent.post(`/api/v1/admin/users/${boss.user.id}/suspend`)).status).toBe(403);
    const self = await boss.agent.post(`/api/v1/admin/users/${boss.user.id}/suspend`);
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('INVALID_OPERATION');
  });

  it('unknown user id → 404', async () => {
    const admin = await registerUser(app);
    await setRole(app, admin.user.id, 'ADMIN');
    expect((await admin.agent.get('/api/v1/admin/users/does-not-exist')).status).toBe(404);
    expect((await admin.agent.post('/api/v1/admin/users/does-not-exist/suspend')).status).toBe(404);
  });
});
```

- [ ] **Step 3: Testin başarısız olduğunu gör**

Run: `pnpm --filter @oto/api test:e2e -- admin-users`
Expected: FAIL — `/api/v1/admin/users` 404.

- [ ] **Step 4: Guard, dekoratör ve interceptor'ı yaz**

`apps/api/src/common/guards/roles.guard.ts`:
```ts
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@oto/db';
import type { Request } from 'express';
import { PrismaService } from '../../infra/prisma.service';
import { ROLES } from '../decorators/roles';
import { Errors } from '../errors/app-error';

/** @Roles olan uç noktalarda token'a güvenmez: oturum ailesi, kullanıcı durumu ve rol DB'den okunur. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (!roles?.length) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const user = req.user;
    if (!user) throw Errors.unauthenticated();
    const session = await this.prisma.session.findFirst({
      where: { familyId: user.sessionId, userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { user: { select: { role: true, status: true } } },
    });
    if (!session || session.user.status !== 'ACTIVE') throw Errors.unauthenticated();
    if (!roles.includes(session.user.role)) throw Errors.forbidden();
    req.user = { ...user, role: session.user.role };
    return true;
  }
}
```

`apps/api/src/common/audit/audited.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';

export const AUDIT_ACTION = 'audit:action';
/** İşaretli handler AuditedResult döndürmelidir; interceptor log yazar ve yalnızca `result`'ı istemciye iletir. */
export const Audited = (action: string) => SetMetadata(AUDIT_ACTION, action);

export interface AuditedResult<T> {
  result: T;
  audit: { targetType: string; targetId: string; before?: unknown; after?: unknown };
}
```

`apps/api/src/common/audit/audit.interceptor.ts`:
```ts
import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { mergeMap, type Observable } from 'rxjs';
import { AUDIT_ACTION, type AuditedResult } from './audited.decorator';
import { AuditService } from './audit.service';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const action = this.reflector.get<string | undefined>(AUDIT_ACTION, ctx.getHandler());
    if (!action) return next.handle();
    const req = ctx.switchToHttp().getRequest<Request>();
    return next.handle().pipe(
      mergeMap(async (value: AuditedResult<unknown>) => {
        await this.audit.record({
          actorId: req.user?.id ?? null,
          action,
          targetType: value.audit.targetType,
          targetId: value.audit.targetId,
          before: value.audit.before,
          after: value.audit.after,
          ip: req.ip ?? null,
        });
        return value.result;
      }),
    );
  }
}
```

`apps/api/src/common/audit/audit.module.ts` (tamamı):
```ts
import { Global, Module } from '@nestjs/common';
import { AuditInterceptor } from './audit.interceptor';
import { AuditService } from './audit.service';

@Global()
@Module({ providers: [AuditService, AuditInterceptor], exports: [AuditService, AuditInterceptor] })
export class AuditModule {}
```

- [ ] **Step 5: Admin kullanıcı modülünü yaz**

`apps/api/src/modules/admin/admin-users.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { Prisma, User } from '@oto/db';
import { ErrorCode, type AdminUsersQuery } from '@oto/shared';
import type { AuditedResult } from '../../common/audit/audited.decorator';
import { AppError, Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../infra/prisma.service';
import type { AuthUser } from '../auth/auth-user';
import { toPublicUser, type PublicUser } from '../auth/public-user';
import { SessionService } from '../auth/session.service';

type UserResult = AuditedResult<{ user: PublicUser }>;

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {}

  async list(q: AdminUsersQuery) {
    const where: Prisma.UserWhereInput = {
      status: q.status ?? { not: 'DELETED' },
      ...(q.role ? { role: q.role } : {}),
      ...(q.q
        ? { OR: [{ email: { contains: q.q, mode: 'insensitive' } }, { name: { contains: q.q, mode: 'insensitive' } }] }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { subscriptions: { where: { status: 'ACTIVE' }, include: { plan: { select: { code: true } } }, take: 1 } },
      }),
    ]);
    return {
      total,
      items: rows.map((u) => ({ ...toPublicUser(u), lastLoginAt: u.lastLoginAt, planCode: u.subscriptions[0]?.plan.code ?? null })),
    };
  }

  async get(id: string) {
    const u = await this.prisma.user.findUnique({
      where: { id },
      include: { subscriptions: { where: { status: 'ACTIVE' }, include: { plan: true }, take: 1 } },
    });
    if (!u) throw Errors.notFound();
    const [searchProfiles, activeSessions] = await Promise.all([
      this.prisma.searchProfile.count({ where: { userId: id } }),
      this.sessions.listActive(id).then((s) => s.length),
    ]);
    const sub = u.subscriptions[0];
    return {
      user: { ...toPublicUser(u), lastLoginAt: u.lastLoginAt },
      subscription: sub ? { planCode: sub.plan.code, planName: sub.plan.name, status: sub.status, endsAt: sub.endsAt, limitOverrides: sub.limitOverrides } : null,
      counts: { searchProfiles, activeSessions },
    };
  }

  async suspend(actor: AuthUser, id: string): Promise<UserResult> {
    const target = await this.loadManageable(actor, id);
    if (target.id === actor.id) {
      throw new AppError(ErrorCode.INVALID_OPERATION, 409, 'Kendi hesabınızı askıya alamazsınız');
    }
    const updated =
      target.status === 'SUSPENDED'
        ? target
        : await this.prisma.user.update({ where: { id }, data: { status: 'SUSPENDED' } });
    await this.sessions.revokeAllForUser(id);
    return this.result(target, updated);
  }

  async activate(actor: AuthUser, id: string): Promise<UserResult> {
    const target = await this.loadManageable(actor, id);
    const updated =
      target.status === 'ACTIVE' ? target : await this.prisma.user.update({ where: { id }, data: { status: 'ACTIVE' } });
    return this.result(target, updated);
  }

  private async loadManageable(actor: AuthUser, id: string): Promise<User> {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target || target.status === 'DELETED') throw Errors.notFound();
    if (target.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') throw Errors.forbidden();
    return target;
  }

  private result(before: User, after: User): UserResult {
    return {
      result: { user: toPublicUser(after) },
      audit: { targetType: 'User', targetId: after.id, before: { status: before.status }, after: { status: after.status } },
    };
  }
}
```

`apps/api/src/modules/admin/admin-users.controller.ts`:
```ts
import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { adminUsersQuerySchema, type AdminUsersQuery } from '@oto/shared';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentUser } from '../../common/decorators/current-user';
import { Roles } from '../../common/decorators/roles';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth-user';
import { AdminUsersService } from './admin-users.service';

@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  list(@Query(new ZodPipe(adminUsersQuerySchema)) q: AdminUsersQuery) {
    return this.users.list(q);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.users.get(id);
  }

  @Post(':id/suspend')
  @Audited('user.suspend')
  suspend(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.users.suspend(actor, id);
  }

  @Post(':id/activate')
  @Audited('user.activate')
  activate(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.users.activate(actor, id);
  }
}
```

`apps/api/src/modules/admin/admin.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

@Module({ imports: [AuthModule], controllers: [AdminUsersController], providers: [AdminUsersService] })
export class AdminModule {}
```

- [ ] **Step 6: `AppModule`'ü güncelle**

`apps/api/src/app.module.ts`:
- Import'lar: `APP_INTERCEPTOR` (`@nestjs/core`), `AuditInterceptor`, `RolesGuard`, `AdminModule`.
- `imports` dizisinin sonuna `AdminModule` ekle.
- `providers` dizisini şu hale getir:
```ts
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Sıra önemlidir: CSRF → kimlik → roller (DB) → hız limiti
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_INTERCEPTOR, useExisting: AuditInterceptor },
  ],
```

- [ ] **Step 7: Testleri çalıştır**

Run: `pnpm --filter @oto/api test:e2e`
Expected: Tüm testler PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(admin): add RBAC with live DB checks, admin user management and audit interceptor"
```

---

### Task 10: İzolasyon matrisi, audit kapsama testi ve dokümantasyon

**Files:**
- Create: `apps/api/test/routes.ts`, `docs/architecture.md`
- Modify: `README.md`
- Test: `apps/api/test/isolation.e2e.spec.ts`, `apps/api/test/audit-coverage.e2e.spec.ts`

**Interfaces:**
- Consumes: Tüm `/me` ve `/admin` uç noktaları, `registerUser`, `newAgent`, `setRole`.
- Produces: `listRoutes(app): RouteInfo[]`; `RouteInfo { method: string; path: string; handler: Function; controller: Function }`. Sonraki planlar her yeni `/me/*` route'u için izolasyon matrisine bir case, her admin mutasyonu için `@Audited` eklemek zorundadır (testler bunu zorlar).

- [ ] **Step 1: Route listeleyiciyi yaz** (`apps/api/test/routes.ts`)

```ts
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

export interface RouteInfo {
  method: string;
  path: string;
  /** Reflect metadata hedefi olarak kullanılır */
  handler: object;
  controller: object;
}

const clean = (p: string | undefined) => (p ?? '').replace(/^\/+|\/+$/g, '');

export function listRoutes(app: NestExpressApplication): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const controller = wrapper.metatype as unknown as { prototype: Record<string, unknown> } | null;
      if (!controller?.prototype) continue;
      const base = clean(Reflect.getMetadata(PATH_METADATA, controller));
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = controller.prototype[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;
        // handler burada `Function` olarak daraltılır; RouteInfo'ya object olarak yazılır
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const sub = clean(Reflect.getMetadata(PATH_METADATA, handler));
        routes.push({
          method: RequestMethod[method],
          path: '/' + [base, sub].filter(Boolean).join('/'),
          handler,
          controller,
        });
      }
    }
  }
  return routes;
}
```

- [ ] **Step 2: İzolasyon matrisini yaz** (`apps/api/test/isolation.e2e.spec.ts`)

```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, newAgent, registerUser, resetState } from './helpers';
import { listRoutes } from './routes';

type Actor = Awaited<ReturnType<typeof registerUser>>;
type Case = (ctx: { A: Actor; B: Actor }) => Promise<void>;

let app: NestExpressApplication;

async function aStillLogsIn(A: Actor) {
  const res = await newAgent(app).post('/api/v1/auth/login').send({ email: A.email, password: A.password });
  expect(res.status).toBe(200);
}

/**
 * Her /me route'u için B'nin A'nın verisine ulaşamadığını kanıtlayan senaryo.
 * Yeni bir /me route'u eklendiğinde buraya case eklenmezse "coverage" testi düşer.
 */
const CASES: Record<string, Case> = {
  'GET /me': async ({ A, B }) => {
    const res = await B.agent.get('/api/v1/me');
    expect(res.body.user.id).toBe(B.user.id);
    expect(JSON.stringify(res.body)).not.toContain(A.email);
  },
  'PATCH /me': async ({ A, B }) => {
    await B.agent.patch('/api/v1/me').send({ name: 'B değişti' });
    expect((await A.agent.get('/api/v1/me')).body.user.name).not.toBe('B değişti');
  },
  'POST /me/change-password': async ({ A, B }) => {
    await B.agent.post('/api/v1/me/change-password').send({ currentPassword: B.password, newPassword: 'b-new-password-1' });
    await aStillLogsIn(A);
  },
  'GET /me/sessions': async ({ A, B }) => {
    const aIds = (await A.agent.get('/api/v1/me/sessions')).body.items.map((s: { id: string }) => s.id);
    const bIds = (await B.agent.get('/api/v1/me/sessions')).body.items.map((s: { id: string }) => s.id);
    expect(bIds.some((id: string) => aIds.includes(id))).toBe(false);
  },
  'DELETE /me/sessions/:id': async ({ A, B }) => {
    const [aSession] = (await A.agent.get('/api/v1/me/sessions')).body.items;
    expect((await B.agent.delete(`/api/v1/me/sessions/${aSession.id}`)).status).toBe(404);
    expect((await A.agent.post('/api/v1/auth/refresh')).status).toBe(204);
  },
  'DELETE /me': async ({ A, B }) => {
    expect((await B.agent.delete('/api/v1/me').send({ password: B.password })).status).toBe(204);
    await aStillLogsIn(A);
  },
};

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetState(app);
});

describe('user isolation matrix', () => {
  it('covers every /me route', () => {
    const meRoutes = listRoutes(app)
      .filter((r) => r.path === '/me' || r.path.startsWith('/me/'))
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(meRoutes).toEqual(Object.keys(CASES).sort());
  });

  for (const [route, run] of Object.entries(CASES)) {
    it(`B cannot read or modify A's data via ${route}`, async () => {
      const A = await registerUser(app);
      const B = await registerUser(app);
      await run({ A, B });
    });
  }
});
```

- [ ] **Step 3: Audit kapsama testini yaz** (`apps/api/test/audit-coverage.e2e.spec.ts`)

```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_ACTION } from '../src/common/audit/audited.decorator';
import { ROLES } from '../src/common/decorators/roles';
import { createTestApp } from './helpers';
import { listRoutes } from './routes';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

describe('admin route policy', () => {
  it('every /admin route requires a role', () => {
    const missing = listRoutes(app)
      .filter((r) => r.path.startsWith('/admin'))
      .filter((r) => !(Reflect.getMetadata(ROLES, r.handler) ?? Reflect.getMetadata(ROLES, r.controller)))
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });

  it('every mutating /admin route is @Audited', () => {
    const missing = listRoutes(app)
      .filter((r) => r.path.startsWith('/admin') && r.method !== 'GET')
      .filter((r) => !Reflect.getMetadata(AUDIT_ACTION, r.handler))
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });
});
```

- [ ] **Step 4: Testleri çalıştır**

Run: `pnpm --filter @oto/api test:e2e`
Expected: Tüm testler PASS (coverage testi 6 route'u eşler; 6 izolasyon case'i geçer; admin politikası boş liste döner).

Doğrulama — kuralın gerçekten çalıştığını gör: `CASES` içinden `'DELETE /me'` satırını geçici olarak sil → `covers every /me route` FAIL olmalı. Geri ekle → PASS.

- [ ] **Step 5: Dokümantasyonu yaz**

`docs/architecture.md`:
```markdown
# Mimari (Plan 01 sonrası durum)

Ayrıntılı tasarım: `docs/superpowers/specs/2026-10-10-oto-firsat-platformu-design.md`.

## Paketler
- `packages/shared` — zod şemaları (API sözleşmesi), hata kodları, plan limit tipi, zaman yardımcıları. Frontend de aynı şemaları kullanır.
- `packages/db` — Prisma şeması (tüm platform modelleri), migration'lar, seed (`FREE/PRO/BUSINESS` planları, ilk süper admin).
- `apps/api` — NestJS 11 REST API, `/api/v1`.

## İstek yaşam döngüsü (apps/api)
1. `helmet` → `cookie-parser` → JSON gövde (100 kb, hatalar standart formatta) → pino-http (`x-request-id`).
2. Global guard sırası: **CsrfGuard** (mutasyonlarda `X-Requested-With` + Origin) → **JwtAuthGuard** (`access_token` cookie; `@Public()` yoksa zorunlu) → **RolesGuard** (`@Roles` varsa oturum/kullanıcı/rol DB'den canlı) → **AppThrottlerGuard** (Redis; 120/dk, `/auth` 10/dk).
3. Handler → (`@Audited` ise) **AuditInterceptor** `AuditLog` yazar → **AllExceptionsFilter** tüm hataları `{ error: { code, message, details? } }` biçimine çevirir.

## Kimlik doğrulama
- Access: EdDSA JWT, 15 dk. Refresh: opak token, 30 gün, DB'de SHA-256; her kullanımda döner. Eski token 10 sn içinde gelirse `REFRESH_RACE` (aile korunur), sonra gelirse `REFRESH_REUSED` (aile iptal + güvenlik bildirimi + audit).
- Giriş kilidi: IP+e-posta başına 15 dk'da 5 hata (Redis).
- Askıya alma / şifre değişimi / sıfırlama oturumları iptal eder. Admin uç noktaları ayrıca DB'den canlı doğrular.

## İzolasyon
- `/me` altındaki veri erişimi yalnızca `*.repository.ts` üzerinden ve `userId` ile yapılır (ESLint kuralı).
- `test/isolation.e2e.spec.ts`: her `/me` route'u için A/B senaryosu; eksik senaryo testi düşürür.
- `test/audit-coverage.e2e.spec.ts`: her `/admin` route'u rol ister, her admin mutasyonu `@Audited`'dır.
```

`README.md` (tamamı):
```markdown
# Oto-Fiyat-Yakalama

Otomobil ilanlarını merkezi olarak toplayan, kural tabanlı ve açıklanabilir fiyat analiziyle piyasa altı fırsatları tespit eden, kullanıcıların arama profillerine göre panel içi ve Telegram bildirimleri gönderen çok kullanıcılı platform.

- Tasarım: [`docs/superpowers/specs/2026-10-10-oto-firsat-platformu-design.md`](docs/superpowers/specs/2026-10-10-oto-firsat-platformu-design.md)
- Yol haritası: [`docs/superpowers/plans/2026-10-10-00-roadmap.md`](docs/superpowers/plans/2026-10-10-00-roadmap.md)
- Mimari: [`docs/architecture.md`](docs/architecture.md)

## Gereksinimler
Node 22+, Docker Desktop (çalışır durumda), `corepack enable`.

## Hızlı başlangıç
```bash
pnpm install
cp .env.example .env
pnpm keys:gen >> .env          # JWT anahtarları + veri şifreleme anahtarı
pnpm db:up                     # Postgres, Redis, Mailpit
pnpm build:packages
pnpm db:migrate && pnpm db:seed
pnpm dev:api                   # http://localhost:3001/api/v1/health/ready
```
Mailpit arayüzü: http://localhost:8025

## Testler
```bash
pnpm lint && pnpm typecheck
pnpm test        # birim testleri
pnpm test:e2e    # Testcontainers ile Postgres + Redis (Docker gerekir)
```
```

- [ ] **Step 6: Tüm doğrulamayı çalıştır**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`
Expected: Hepsi hatasız; e2e'de 8 test dosyası PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test: add user isolation matrix and admin route policy tests; document architecture"
```

---

## Plan Sonu Kontrol Listesi (Spec karşılığı)

| Spec maddesi | Task |
|---|---|
| §1 Monorepo, ayrı süreçler (api) | 1, 3 |
| §2 Tam şema, unique'ler, DataSource izin kısıtı, citext | 2 |
| §6 Oturum, rotasyon, yeniden kullanım tespiti, CSRF, cookie'ler | 5, 6 |
| §6 argon2id, HIBP, doğrulama, sıfırlama, enumeration yok, giriş kilidi | 5, 6, 7 |
| §6 RBAC, varsayılan kapalı, canlı DB doğrulaması | 6, 9 |
| §6 İzolasyon: repository + lint + e2e matris | 6, 8, 10 |
| §6 Rate limit (Redis) | 6 |
| §6 Secret'lar env + zod, AES-GCM, log redaction | 3, 4 |
| §6 Audit (admin mutasyonları + güvenlik olayları) | 6, 7, 9, 10 |
| §6 KVKK: hesap silme + anonimleştirme, aydınlatma onayı | 6, 8 |
| §7 Auth + `/me` (profil, oturumlar, silme) + admin kullanıcı uç noktaları (list/get/suspend/activate) | 6–9 |
| §9 Standart hata formatı, requestId, health live/ready | 3 |
| §10 Birim + Testcontainers e2e + izolasyon matrisi | tümü |
| §11 Dev compose, seed, CI, README | 1, 2, 3, 10 |

**Bu planın kapsamı dışında kalan (sonraki planlar):** worker/scheduler/BullMQ (02), analiz (03), arama profilleri ve plan limiti uygulaması (04), bildirim kanalları ve `/me/notifications`, `/me/channels` (05), web (06), diğer admin uç noktaları ve rol değiştirme/silme + son süper admin koruması (07), prod compose ve yedekleme (08).
