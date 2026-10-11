# syntax=docker/dockerfile:1.7
# Oto Fırsat web (Next.js 15, standalone çıktı).
# Derleme: docker build -f docker/web.Dockerfile --build-arg API_ORIGIN=http://api:3001 -t oto/web .
# API_ORIGIN gizli değildir: derleme anında /api/* rewrites hedefine gömülür (sonradan değiştirmek etkisiz).
# Sırlar build argümanı olarak verilmez.

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

# --- deps: yalnız lockfile ile paket deposunu doldur ------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=oto-pnpm-store,target=/pnpm/store pnpm fetch

# --- build ---------------------------------------------------------------------------------------
FROM deps AS build
ARG API_ORIGIN=http://api:3001
COPY . .
RUN --mount=type=cache,id=oto-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile
# Standalone Linux'ta her zaman açık (next.config.ts); NODE_ENV=production derlemesi.
RUN NODE_ENV=production API_ORIGIN="$API_ORIGIN" pnpm --filter "@oto/web..." build
# Standalone kökü: apps/web/server.js + izlenen node_modules. Statik dosyalar ayrıca kopyalanır.
RUN mkdir -p /out \
    && cp -R apps/web/.next/standalone/. /out/ \
    && mkdir -p /out/apps/web/.next \
    && cp -R apps/web/.next/static /out/apps/web/.next/static \
    && if [ -d apps/web/public ]; then cp -R apps/web/public /out/apps/web/public; fi \
    && rm -f /out/apps/web/.env /out/apps/web/.env.* /out/.env /out/.env.*

# --- runtime -----------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG API_ORIGIN=http://api:3001
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    API_ORIGIN=${API_ORIGIN}
WORKDIR /app
# Dosyalar root'a ait kalır (salt okunur); yalnız Next önbelleği node kullanıcısına yazılabilir.
COPY --from=build /out ./
RUN mkdir -p /app/apps/web/.next/cache && chown node:node /app/apps/web/.next/cache
WORKDIR /app/apps/web
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "server.js"]
