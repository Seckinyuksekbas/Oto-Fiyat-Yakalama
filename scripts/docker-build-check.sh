#!/usr/bin/env sh
# Production imajlarını (oto/api, oto/worker, oto/web, oto/migrate) derler ve temel güvenlik
# özelliklerini doğrular: non-root, imajda .env yok, NODE_ENV=production, workspace paketleri
# çözülebilir, Prisma istemcisi musl motoruyla üretilmiş, api güvensiz production env'de açılmaz.
#
# Kullanım: sh scripts/docker-build-check.sh            (derle + doğrula)
#           SKIP_BUILD=1 sh scripts/docker-build-check.sh (yalnız doğrula)
#
# Test env değerleri çalışma anında üretilir (gen-keys.mjs / openssl rand); repoda sır yok.
set -eu

# Git Bash (MSYS) "/app/.env" gibi argümanları Windows yoluna çevirmesin.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'
export DOCKER_BUILDKIT=1

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

IMAGES="api worker web migrate"
FAILS=0
BUILD_FAILED=""
NET=oto-check-net-$$
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t oto-docker-check)

# Her çıkışta (başarı, hata, Ctrl-C) geçici konteyner/ağ/dosyalar silinir; her adım bağımsız (|| true).
cleanup() {
  docker rm -f "$NET-pg" >/dev/null 2>&1 || true
  docker rm -f oto-check-unsafe-api >/dev/null 2>&1 || true
  docker rm -f oto-check-web-origin >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP" || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

pass() { printf '  PASS %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAILS=$((FAILS + 1)); }
# İmaj var ve bu çalıştırmada derlemesi başarısız olmadı mı? (eski imajı doğrulamamak için)
available() {
  case " $BUILD_FAILED " in *" $1 "*) return 1 ;; esac
  docker image inspect "oto/$1" >/dev/null 2>&1
}
build_failed() { fail "oto/$1 derlenemedi"; BUILD_FAILED="$BUILD_FAILED $1"; }

# --- 1. Derleme -------------------------------------------------------------------------------
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  for app in $IMAGES; do
    echo "==> docker build oto/$app"
    if [ ! -f "docker/$app.Dockerfile" ]; then
      fail "docker/$app.Dockerfile yok"
      BUILD_FAILED="$BUILD_FAILED $app"
      continue
    fi
    if [ "$app" = "web" ]; then
      docker build -f "docker/$app.Dockerfile" --build-arg API_ORIGIN=http://api:3001 -t "oto/$app" . || build_failed "$app"
    else
      docker build -f "docker/$app.Dockerfile" -t "oto/$app" . || build_failed "$app"
    fi
  done
fi

# --- 2. İmaj başına ortak doğrulamalar ----------------------------------------------------------
for app in $IMAGES; do
  img="oto/$app"
  echo "==> $img"
  if ! available "$app"; then
    fail "$img yok ya da derlenemedi; imaj doğrulamaları atlandı"
    continue
  fi

  uid=$(docker run --rm --entrypoint id "$img" -u 2>/dev/null || echo "?")
  if [ "$uid" = "1000" ]; then pass "(a) uid=1000 (node, non-root)"; else fail "(a) uid=$uid (1000 bekleniyor)"; fi

  if docker run --rm --entrypoint sh "$img" -c 'test ! -e /app/.env && test -z "$(find /app -maxdepth 4 -path "*/node_modules" -prune -o \( -name .env -o -name ".env.*" \) ! -name .env.example -print 2>/dev/null | head -1)"'; then
    pass "(b) imajda .env yok"
  else
    fail "(b) imajda .env bulundu"
  fi

  node_env=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$img" | grep '^NODE_ENV=' || true)
  if [ "$node_env" = "NODE_ENV=production" ]; then pass "(d) NODE_ENV=production"; else fail "(d) NODE_ENV=production değil ('$node_env')"; fi

  user=$(docker inspect --format '{{.Config.User}}' "$img")
  if [ "$user" = "node" ]; then pass "USER node"; else fail "USER '$user' (node bekleniyor)"; fi

  hc=$(docker inspect --format '{{if .Config.Healthcheck}}{{join .Config.Healthcheck.Test " "}}{{end}}' "$img")
  case "$app" in
    migrate) pass "healthcheck gerekmez (tek seferlik iş)" ;;
    *) if [ -n "$hc" ]; then pass "HEALTHCHECK: $hc"; else fail "HEALTHCHECK yok"; fi ;;
  esac
done

# (c) workspace paketleri ve Prisma istemcisi
PRISMA_CHECK='
const path = require("node:path"), fs = require("node:fs");
let db; try { db = require.resolve("@oto/db"); } catch { db = path.join(process.cwd(), "package.json"); } // migrate: /app = @oto/db
const client = require.resolve("@prisma/client", { paths: [path.dirname(db)] });
const gen = path.join(path.dirname(require.resolve(".prisma/client/default", { paths: [path.dirname(client)] })));
const engine = fs.readdirSync(gen).find((f) => f.includes("linux-musl-openssl-3.0.x"));
if (!engine) throw new Error("musl Prisma motoru yok: " + gen);
const { PrismaClient } = require(client);
// Ulaşılamaz adrese $connect: motor yüklenip bağlantı hatası (P1001) dönmeli; motor yüklenemezse başka hata.
const prisma = new PrismaClient({ datasourceUrl: "postgresql://probe:probe@127.0.0.1:1/probe?connect_timeout=2" });
prisma.$connect().then(
  () => { console.error("beklenmedik: bağlantı kuruldu"); process.exit(1); },
  (err) => {
    if (err && err.errorCode === "P1001") { console.log("prisma ok " + engine + " (P1001)"); process.exit(0); }
    console.error("motor/bağlantı hatası beklenmedik: " + (err && (err.errorCode || err.name)) + " " + String(err && err.message).slice(0, 300));
    process.exit(1);
  },
);
'
# @oto/* paketleri yalnız "files" içeriğiyle gelmeli (src/test/spec yok)
PKG_FILES_CHECK='find /app/node_modules/.pnpm -path "*/node_modules/@oto/*" \( -name src -o -name test -o -name "*.spec.ts" -o -name "*.spec.js" \) -print 2>/dev/null | grep -v "/node_modules/@oto/[^/]*/node_modules/" | head -5'
check_pkg_files() { # img
  out=$(docker run --rm --entrypoint sh "$1" -c "$PKG_FILES_CHECK")
  if [ -z "$out" ]; then pass "(c) $1 @oto/* paketlerinde src/test/spec yok"; else fail "(c) $1 @oto/* içinde kaynak/test: $out"; fi
}

check_require() { # img pkg...
  img=$1; shift
  for pkg in "$@"; do
    if docker run --rm --entrypoint node -w /app "$img" -e "require('$pkg')" >/dev/null 2>"$TMP/err"; then
      pass "(c) $img require('$pkg')"
    else
      fail "(c) $img require('$pkg'): $(head -c 300 "$TMP/err")"
    fi
  done
}

if available api; then
  echo "==> oto/api modül çözümü"
  check_require oto/api @oto/shared @oto/db @oto/server-common @oto/telegram
  if docker run --rm --entrypoint node -w /app oto/api -e "$PRISMA_CHECK"; then pass "(c) oto/api Prisma motoru yükleniyor"; else fail "(c) oto/api Prisma istemcisi/motoru"; fi
  check_pkg_files oto/api
fi
if available worker; then
  echo "==> oto/worker modül çözümü"
  check_require oto/worker @oto/shared @oto/db @oto/collection @oto/analysis @oto/telegram ioredis
  if docker run --rm --entrypoint node -w /app oto/worker -e "$PRISMA_CHECK"; then pass "(c) oto/worker Prisma motoru yükleniyor"; else fail "(c) oto/worker Prisma istemcisi/motoru"; fi
  check_pkg_files oto/worker
  # Redis'e ulaşamayan healthcheck hızla başarısız olmalı
  if docker run --rm -e REDIS_URL=redis://127.0.0.1:1 oto/worker node /app/healthcheck-worker.mjs >/dev/null 2>&1; then
    fail "worker healthcheck Redis yokken başarılı döndü"
  else
    pass "worker healthcheck Redis yokken başarısız"
  fi
fi
if available web; then
  echo "==> oto/web standalone"
  if docker run --rm --entrypoint sh oto/web -c 'test -f /app/apps/web/server.js && test -d /app/apps/web/.next/static'; then
    pass "(c) standalone server.js + .next/static"
  else
    fail "(c) standalone düzeni eksik"
  fi
  origin=$(docker run --rm --entrypoint cat oto/web /app/apps/web/.next/build-api-origin 2>/dev/null || true)
  if [ "$origin" = "http://api:3001" ]; then pass "derleme API_ORIGIN kaydı: $origin"; else fail "derleme API_ORIGIN kaydı '$origin'"; fi
  # Çalışma zamanı API_ORIGIN derlemedekinden farklıysa açılış durmalı
  set +e
  timeout 60 docker run --rm --name oto-check-web-origin -e API_ORIGIN=http://other-api:3001 oto/web >"$TMP/web.out" 2>&1
  code=$?
  set -e
  docker rm -f oto-check-web-origin >/dev/null 2>&1 || true
  if [ "$code" -ne 0 ] && [ "$code" -lt 124 ] && grep -q 'API_ORIGIN' "$TMP/web.out"; then
    pass "web farklı çalışma zamanı API_ORIGIN ile açılmadı (kod $code)"
  else
    fail "web API_ORIGIN uyuşmazlığında açıldı (kod $code): $(head -c 300 "$TMP/web.out")"
  fi
fi
if available migrate; then
  echo "==> oto/migrate"
  if docker run --rm --entrypoint sh oto/migrate -c 'test -x node_modules/.bin/prisma && test -d prisma/migrations && test -f prisma/seed.js'; then
    pass "(c) prisma CLI + migrations + seed.js"
  else
    fail "(c) prisma CLI / migrations / seed.js eksik"
  fi
  if docker run --rm --entrypoint node -w /app oto/migrate -e "$PRISMA_CHECK"; then pass "(c) oto/migrate Prisma motoru yükleniyor"; else fail "(c) oto/migrate Prisma istemcisi/motoru"; fi
  # CLI motorları imajda olmalı (çalışma anında indirme yok)
  if docker run --rm --network none --entrypoint prisma oto/migrate -v >"$TMP/prisma.out" 2>&1; then
    pass "prisma CLI ağsız çalışıyor"
  else
    fail "prisma CLI ağsız çalışmadı: $(tail -c 300 "$TMP/prisma.out")"
  fi
  # Gerçek uçtan uca: geçici Postgres'e migrate deploy + seed (production, demo kaynak kapalı)
  PGPASS=$(openssl rand -hex 16 2>/dev/null || node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
  ADMINPASS=$(openssl rand -hex 16 2>/dev/null || node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
  docker network create "$NET" >/dev/null
  docker run -d --rm --name "$NET-pg" --network "$NET" -e POSTGRES_USER=oto -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB=oto postgres:16-alpine >/dev/null
  i=0
  until docker exec "$NET-pg" pg_isready -U oto -d oto >/dev/null 2>&1 || [ $i -ge 60 ]; do i=$((i + 1)); sleep 1; done
  sleep 2
  if docker run --rm --network "$NET" -e DATABASE_URL="postgresql://oto:$PGPASS@$NET-pg:5432/oto" \
       -e SEED_ON_MIGRATE=true -e SEED_DEMO_SOURCE=false -e SEED_ADMIN_EMAIL=admin@example.com -e SEED_ADMIN_PASSWORD="$ADMINPASS" \
       oto/migrate >"$TMP/migrate.out" 2>&1; then
    pass "migrate deploy + seed geçici Postgres'te başarılı"
  else
    fail "migrate/seed başarısız: $(tail -c 500 "$TMP/migrate.out")"
  fi
  if grep -qF -- "$ADMINPASS" "$TMP/migrate.out"; then fail "migrate çıktısı parola içeriyor"; fi
  docker rm -f "$NET-pg" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  # production + SEED_DEMO_SOURCE=true → seed reddeder (veritabanına bağlanmadan)
  if docker run --rm -e NODE_ENV=production -e SEED_DEMO_SOURCE=true --entrypoint node oto/migrate prisma/seed.js >"$TMP/seed.out" 2>&1; then
    fail "seed production + SEED_DEMO_SOURCE=true ile çalıştı"
  elif grep -q 'SEED_DEMO_SOURCE' "$TMP/seed.out"; then
    pass "seed production + SEED_DEMO_SOURCE=true reddedildi"
  else
    fail "seed beklenmeyen hata: $(head -c 300 "$TMP/seed.out")"
  fi
fi

# --- 3. api güvensiz production env'de açılmamalı ------------------------------------------------
if available api; then
  echo "==> oto/api güvensiz production env (COOKIE_SECURE=false)"
  # Değerler dosyaya yazılmaz: süreç env'inde tutulur, `docker run -e AD` (değersiz) ile aktarılır.
  KEYS=$(node scripts/gen-keys.mjs | sed 's/"//g')
  JWT_PRIVATE_KEY=$(printf '%s\n' "$KEYS" | sed -n 's/^JWT_PRIVATE_KEY=//p')
  JWT_PUBLIC_KEY=$(printf '%s\n' "$KEYS" | sed -n 's/^JWT_PUBLIC_KEY=//p')
  DATA_ENCRYPTION_KEY=$(printf '%s\n' "$KEYS" | sed -n 's/^DATA_ENCRYPTION_KEY=//p')
  DBPASS=$(openssl rand -hex 16 2>/dev/null || node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
  start=$(date +%s)
  set +e
  (
    export JWT_PRIVATE_KEY JWT_PUBLIC_KEY DATA_ENCRYPTION_KEY
    export NODE_ENV=production COOKIE_SECURE=false
    export DATABASE_URL="postgresql://oto:$DBPASS@db.invalid:5432/oto" REDIS_URL=redis://redis.invalid:6379
    export PUBLIC_BASE_URL=https://oto.example.com MAIL_TRANSPORT=smtp SMTP_HOST=smtp.example.com SMTP_PORT=587
    export SMTP_FROM='Oto <no-reply@example.com>'
    timeout 60 docker run --rm --name oto-check-unsafe-api \
      -e NODE_ENV -e COOKIE_SECURE -e DATABASE_URL -e REDIS_URL -e JWT_PRIVATE_KEY -e JWT_PUBLIC_KEY \
      -e DATA_ENCRYPTION_KEY -e PUBLIC_BASE_URL -e MAIL_TRANSPORT -e SMTP_HOST -e SMTP_PORT -e SMTP_FROM \
      oto/api
  ) >"$TMP/api.out" 2>&1
  code=$?
  set -e
  elapsed=$(( $(date +%s) - start ))
  docker rm -f oto-check-unsafe-api >/dev/null 2>&1 || true
  # 124: zaman aşımı (süreç açık kaldı); 125-127: docker/komut hatası (doğrulamaya hiç ulaşılmadı)
  if [ "$code" -ne 0 ] && [ "$code" -lt 124 ]; then pass "api çıkış kodu $code (${elapsed}s)"; else fail "api açılışı reddetmedi (kod $code, ${elapsed}s)"; fi
  if grep -q 'COOKIE_SECURE' "$TMP/api.out"; then
    pass "hata değişken adını içeriyor: $(grep -o 'COOKIE_SECURE[^;]*' "$TMP/api.out" | head -1)"
  else
    fail "hata COOKIE_SECURE adını içermiyor: $(head -c 300 "$TMP/api.out")"
  fi
  leaked=0
  for secret in "$DBPASS" "$DATA_ENCRYPTION_KEY"; do
    if grep -qF -- "$secret" "$TMP/api.out"; then leaked=1; fi
  done
  if grep -q 'BEGIN PRIVATE KEY' "$TMP/api.out"; then leaked=1; fi
  if [ "$leaked" -eq 0 ]; then pass "hata çıktısında gizli değer yok"; else fail "hata çıktısı gizli değer içeriyor"; fi
fi

# --- 4. Boyutlar -----------------------------------------------------------------------------
echo "==> İmaj boyutları"
for app in $IMAGES; do
  docker image inspect "oto/$app" >/dev/null 2>&1 && docker image ls "oto/$app" --format '  {{.Repository}}:{{.Tag}}  {{.Size}}'
done

if [ "$FAILS" -gt 0 ]; then
  echo "SONUÇ: FAIL ($FAILS)"
  exit 1
fi
echo "SONUÇ: PASS"
