# syntax=docker/dockerfile:1.7
# Oto Fırsat worker + scheduler (NestJS, aynı imaj). Derleme: docker build -f docker/worker.Dockerfile -t oto/worker .
# Worker: node dist/main.js · Scheduler: node dist/main.js --role=scheduler
# Sırlar imaja girmez: tüm yapılandırma çalışma zamanı env'inden okunur (bkz. .env.example).

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

# --- build: derle + üretim bağımlılıklarıyla /out'a dağıt -----------------------------------------
FROM deps AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter "@oto/worker..." build
# pnpm deploy kararı: lockfile tabanlı (legacy olmayan) deploy; inject-workspace-packages yalnız bu komutta
# --config ile açılır (pnpm-workspace.yaml ve lockfile değişmez). --offline: çözümleme ortak lockfile'dan,
# paketler deps katmanındaki depodan gelir, ağa çıkılmaz. `--legacy` KULLANILMAZ: workspace
# bağımlılıklarını registry metadata'sıyla yeniden çözer (ağ gerekir; --offline ile ERR_PNPM_NO_OFFLINE_META).
# @oto/* paketleri package.json "files" alanına göre kopyalanır (yalnız dist; db: dist + prisma).
RUN pnpm --config.inject-workspace-packages=true --filter @oto/worker deploy --prod --offline /out
# Üretilmiş Prisma istemcisi (musl motoru dahil) dağıtımdaki @prisma/client'ın yanına kopyalanır.
RUN sh docker/copy-prisma-client.sh /out && sh docker/prune-prisma-cli.sh /out
# Çalışma zamanında gerekmeyenler
RUN cd /out && rm -rf pnpm-lock.yaml src test tsconfig*.json nest-cli.json vitest*.config.ts .env* \
    && find dist -name '*.map' -delete

# --- runtime -----------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache openssl
ENV NODE_ENV=production
WORKDIR /app
# Dosyalar root'a ait kalır (salt okunur); süreç node kullanıcısıyla çalışır.
COPY --from=build /out ./
COPY docker/healthcheck-worker.mjs /app/healthcheck-worker.mjs
USER node
# Bu konteynerin (hostname) Redis heartbeat anahtarı canlı mı (TTL 45 sn, 15 sn'de bir yazılır)
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "/app/healthcheck-worker.mjs"]
CMD ["node", "dist/main.js"]
