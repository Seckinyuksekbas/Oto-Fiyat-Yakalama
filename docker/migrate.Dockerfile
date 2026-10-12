# syntax=docker/dockerfile:1.7
# Oto Fırsat migrate (tek seferlik iş): `prisma migrate deploy`, ardından SEED_ON_MIGRATE=true ise seed.
# Derleme: docker build -f docker/migrate.Dockerfile -t oto/migrate .
# Seed production'da SEED_DEMO_SOURCE=true ile çalışmayı reddeder (prisma/seed-env.ts → assertSeedEnv).

# Sabitlenmiş taban (yeniden üretilebilir derleme); güncellerken dört Dockerfile birlikte değişir.
ARG NODE_IMAGE=node:22.23.3-alpine3.24

# --- base: node + pnpm (corepack) ------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
RUN apk add --no-cache openssl
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_store_dir=/pnpm/store \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /repo

# --- deps: pnpm deposu yalnız lockfile ile bu KATMANDA doldurulur (cache mount yok): sonraki adımlar
# (install/deploy --offline) ağa ve builder'ın cache mount'una bağlı değil; katman lockfile değişince yenilenir.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# --- build ---------------------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter "@oto/db..." build
# Seed (TS) → CommonJS: prisma/seed.js + bağımlı src/*.js (seed.ts `../src/seed-data`'yı içe aktarır)
RUN cd packages/db && /repo/node_modules/.bin/tsc --outDir /seed --rootDir . \
      --module commonjs --moduleResolution node --target ES2022 --lib ES2023 --types node \
      --strict --esModuleInterop --skipLibCheck --resolveJsonModule \
      prisma/seed.ts prisma/seed-env.ts
# --prod: prisma CLI, lockfile'da @prisma/client'ın eş bağımlılığı (autoInstallPeers) olarak zaten gelir;
# test araçları (testcontainers, vitest, tsx) gelmez. CLI doğrudan bağımlılık olmadığından bin bağı elle kurulur.
# pnpm deploy kararı api.Dockerfile ile aynı: lockfile tabanlı deploy, inject-workspace-packages yalnız bu
# komutta (--config), --offline. --legacy registry metadata'sı ister (ağ), kullanılmaz.
RUN pnpm --config.inject-workspace-packages=true --filter @oto/db deploy --prod --offline /out
RUN sh docker/copy-prisma-client.sh /out \
    && cd /out \
    && CLI=$(node -p "const p=require('node:path'),fs=require('node:fs');const c=fs.realpathSync(p.dirname(require.resolve('@prisma/client/package.json')));p.relative('/out/node_modules/.bin',p.join(p.dirname(require.resolve('prisma/package.json',{paths:[c]})),'build','index.js'))") \
    && mkdir -p node_modules/.bin \
    && printf '#!/bin/sh\nexec node "$(dirname "$0")/%s" "$@"\n' "$CLI" > node_modules/.bin/prisma \
    && chmod 755 node_modules/.bin/prisma \
    && node_modules/.bin/prisma -v >/dev/null
RUN cd /out && rm -rf pnpm-lock.yaml test src prisma/*.ts vitest*.config.ts tsconfig*.json .env* \
    && mkdir -p src && cp /seed/src/*.js src/ && cp /seed/prisma/*.js prisma/ \
    && find dist -name '*.map' -delete

# --- runtime -----------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache openssl
ENV NODE_ENV=production \
    PATH=/app/node_modules/.bin:$PATH \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
WORKDIR /app
COPY --from=build /out ./
USER node
# Tek seferlik iş: sağlık denetimi yok (compose'da `service_completed_successfully` ile beklenir).
HEALTHCHECK NONE
# SEED_ON_MIGRATE=true YALNIZ İLK kurulumda kullanılmalı: seed, SEED_ADMIN_EMAIL kullanıcısını her çalışmada
# yeniden SUPER_ADMIN/ACTIVE yapar (sonradan düşürülen/askıya alınan hesabı geri yükseltir). Seed `exec` ile
# PID 1 olur (sinyaller doğrudan Node'a gider).
CMD ["sh", "-c", "prisma migrate deploy && if [ \"$SEED_ON_MIGRATE\" = \"true\" ]; then exec node prisma/seed.js; fi"]
