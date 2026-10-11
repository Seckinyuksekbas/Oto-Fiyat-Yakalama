# syntax=docker/dockerfile:1.7
# Oto Fırsat API (NestJS). Derleme: docker build -f docker/api.Dockerfile -t oto/api .
# Sırlar imaja girmez: tüm yapılandırma çalışma zamanı env'inden okunur (bkz. .env.example).

ARG NODE_IMAGE=node:22-alpine

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

# --- deps: yalnız lockfile ile paket deposunu doldur (kaynak değişince yeniden indirmez) ---------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=oto-pnpm-store,target=/pnpm/store pnpm fetch

# --- build: derle + üretim bağımlılıklarıyla /out'a dağıt -----------------------------------------
FROM deps AS build
COPY . .
RUN --mount=type=cache,id=oto-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile
RUN pnpm --filter "@oto/api..." build
RUN --mount=type=cache,id=oto-pnpm-store,target=/pnpm/store \
    pnpm --filter @oto/api deploy --prod --legacy /out
# Üretilmiş Prisma istemcisi (musl motoru dahil) dağıtımdaki @prisma/client'ın yanına kopyalanır.
RUN sh docker/copy-prisma-client.sh /out && sh docker/prune-prisma-cli.sh /out
# Çalışma zamanında gerekmeyenler
RUN cd /out && rm -rf src test tsconfig*.json nest-cli.json vitest*.config.ts .env* \
    && find dist -name '*.map' -delete

# --- runtime -----------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache openssl
ENV NODE_ENV=production \
    PORT=3001
WORKDIR /app
# Dosyalar root'a ait kalır (salt okunur); süreç node kullanıcısıyla çalışır.
COPY --from=build /out ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/v1/health/ready >/dev/null || exit 1
CMD ["node", "dist/main.js"]
