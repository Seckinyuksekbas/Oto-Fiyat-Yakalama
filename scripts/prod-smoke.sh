#!/usr/bin/env sh
# Production compose yığınının yerel, prod-benzeri smoke testi (Caddy tek origin, healthcheck'ler, Redis AOF).
#
#   sh scripts/prod-smoke.sh               (imajları derler: up --build)
#   SMOKE_BUILD=0 sh scripts/prod-smoke.sh  (mevcut oto/* imajlarıyla)
#
# docker-compose.yml + docker-compose.smoke.override.yml, ayrı compose projesi (oto-smoke) olarak ayağa kalkar.
# Site adresi https://oto.localtest.me:8443 (Caddy `tls internal`): production env kuralları localhost/loopback
# PUBLIC_BASE_URL'yi reddettiği için loopback olmayan bir ad kullanılır; curl --resolve ile 127.0.0.1'e bağlanır
# (DNS'e bağımlılık yok). SMTP: smoke ağındaki Mailpit 2525'te dinler (1025 production'da reddedilir); kimlik
# doğrulama yok, dolayısıyla SMTP_REQUIRE_TLS=false production kuralına uygundur (yalnız SMTP_USER varken TLS zorunlu).
#
# Gizli değerler (.env.prod.smoke) çalışma anında üretilir (gen-keys.mjs, openssl rand) ve çıkışta silinir;
# yığın `down -v` ile tamamen kaldırılır.
set -eu

# Git Bash (MSYS) "/api/..." gibi argümanları Windows yoluna çevirmesin.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

PROJECT=${SMOKE_PROJECT:-oto-smoke}
ENVF=.env.prod.smoke
HOST=oto.localtest.me
PORT=8443
HTTP_PORT=8080
BASE="https://$HOST:$PORT"
FAILS=0
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t oto-prod-smoke)
# Git Bash: curl/docker yerel Windows ikilileridir; MSYS yol dönüşümü kapalıyken /tmp/... yollarını çözemezler.
command -v cygpath >/dev/null 2>&1 && TMP=$(cygpath -m "$TMP")
DISCARD="$TMP/discard"

pass() { printf '  PASS %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAILS=$((FAILS + 1)); }
rand_hex() { openssl rand -hex "$1" 2>/dev/null || node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }
dc() { docker compose -p "$PROJECT" -f docker-compose.yml -f docker-compose.smoke.override.yml --env-file "$ENVF" "$@"; }
# -k: Caddy'nin iç CA'sı (tls internal) host'ta güvenilir değil. --resolve: DNS olmadan 127.0.0.1.
c() { curl -sS -k --resolve "$HOST:$PORT:127.0.0.1" --resolve "$HOST:$HTTP_PORT:127.0.0.1" "$@"; }

cleanup() {
  code=$?
  trap - EXIT INT TERM
  if [ -f "$ENVF" ]; then
    if [ "$code" -ne 0 ] || [ "$FAILS" -gt 0 ]; then
      echo "==> Hata ayıklama: servis durumu ve son loglar"
      dc ps -a 2>/dev/null || true
      dc logs --no-color --tail 40 2>/dev/null | grep -v -e 'PRIVATE KEY' || true
    fi
    echo "==> Kapanış: docker compose down -v"
    dc down -v --remove-orphans --timeout 60 >/dev/null 2>&1 || true
  fi
  rm -f "$ENVF"
  rm -rf "$TMP"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

for f in docker-compose.yml docker-compose.smoke.override.yml docker/Caddyfile; do
  if [ ! -f "$f" ]; then
    echo "FAIL $f yok"
    exit 1
  fi
done

# --- 1. Geçici prod env (repoya girmez; .env.* gitignore'lu ve çıkışta silinir) ---------------------
echo "==> .env.prod.smoke üretiliyor"
ADMIN_EMAIL=smoke-admin@example.com
ADMIN_PASSWORD="Sm0ke-$(rand_hex 12)"
umask 077
{
  echo "# prod-smoke.sh tarafından üretildi; çıkışta silinir"
  node scripts/gen-keys.mjs
  echo "POSTGRES_USER=oto"
  echo "POSTGRES_DB=oto"
  echo "POSTGRES_PASSWORD=$(rand_hex 16)"
  echo "REDIS_PASSWORD=$(rand_hex 16)"
  echo "SITE_ADDRESS=$HOST:$PORT"
  echo "ACME_EMAIL=ops@example.com"
  echo "PUBLIC_BASE_URL=$BASE"
  echo "BOT_CONTACT_URL=$BASE/bot"
  echo "LOG_LEVEL=info"
  echo "SMTP_HOST=mailpit"
  echo "SMTP_PORT=2525"
  echo "SMTP_SECURE=false"
  echo "SMTP_REQUIRE_TLS=false"
  echo "SMTP_FROM=\"Oto Fırsat <no-reply@example.com>\""
  echo "HIBP_ENABLED=false"
  echo "SEED_ON_MIGRATE=true"
  echo "SEED_ADMIN_EMAIL=$ADMIN_EMAIL"
  echo "SEED_ADMIN_PASSWORD=$ADMIN_PASSWORD"
  echo "WORKER_REPLICAS=2"
  echo "SCHEDULER_TICK_MS=5000"
} >"$ENVF"
umask 022

# --- 2. Ayağa kaldırma --------------------------------------------------------------------------
BUILD_FLAG=--build
[ "${SMOKE_BUILD:-1}" = "0" ] && BUILD_FLAG=
echo "==> docker compose up -d $BUILD_FLAG --wait (proje: $PROJECT)"
start=$(date +%s)
# shellcheck disable=SC2086
if dc up -d $BUILD_FLAG --wait --wait-timeout 300; then
  pass "yığın sağlıklı ($(( $(date +%s) - start ))s)"
else
  fail "docker compose up --wait başarısız"
  exit 1
fi

# --- 3. Servis durumu ----------------------------------------------------------------------------
echo "==> Servis durumu"
dc ps -a --format '  {{.Service}}  {{.State}}  {{.Health}}  {{.Status}}'
for svc in caddy web api worker scheduler postgres redis; do
  states=$(dc ps -a --format '{{.Health}}' "$svc" 2>/dev/null | sort -u | tr '\n' ' ')
  if [ "$states" = "healthy " ]; then pass "$svc healthy"; else fail "$svc sağlık durumu: '$states'"; fi
done
workers=$(dc ps --format '{{.Name}}' worker | wc -l | tr -d ' ')
if [ "$workers" -eq 2 ]; then pass "worker replika sayısı 2"; else fail "worker replika sayısı $workers (2 bekleniyor)"; fi
schedulers=$(dc ps --format '{{.Name}}' scheduler | wc -l | tr -d ' ')
if [ "$schedulers" -eq 1 ]; then pass "scheduler tek örnek"; else fail "scheduler örnek sayısı $schedulers"; fi
migrate=$(dc ps -a --format '{{.State}} {{.Status}}' migrate)
case "$migrate" in
  *"Exited (0)"*) pass "migrate tamamlandı ($migrate)" ;;
  *) fail "migrate durumu: $migrate" ;;
esac
if dc logs scheduler 2>/dev/null | grep -q 'scheduler leader acquired'; then
  pass "scheduler log: 'scheduler leader acquired'"
else
  fail "scheduler log'unda 'scheduler leader acquired' yok"
fi
published=$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Label "com.docker.compose.service"}} {{.Ports}}' | grep -e '->' | awk '{print $1}' | sort -u | tr '\n' ' ')
if [ "$published" = "caddy " ]; then pass "yalnız caddy port yayınlıyor"; else fail "port yayınlayan servisler: '$published'"; fi
aof=$(dc exec -T redis sh -c 'redis-cli --no-auth-warning CONFIG GET appendonly' 2>/dev/null | tr '\n' ' ')
case "$aof" in
  *"appendonly yes"*) pass "Redis AOF açık" ;;
  *) fail "Redis appendonly: '$aof'" ;;
esac
# Parola süreç argv'sinde olmamalı (yapılandırma dosyasından okunur) ve redis-server root çalışmamalı.
REDIS_PASSWORD=$(sed -n 's/^REDIS_PASSWORD=//p' "$ENVF")
dc exec -T redis sh -c 'tr "\0" " " < /proc/1/cmdline; echo; stat -c %U /proc/1' >"$TMP/redis.proc" 2>/dev/null || true
if [ -s "$TMP/redis.proc" ] && ! grep -qF -- "$REDIS_PASSWORD" "$TMP/redis.proc"; then
  pass "Redis parolası argv'de yok ($(head -1 "$TMP/redis.proc" | cut -c1-60)...)"
else
  fail "Redis argv parola içeriyor ya da okunamadı"
fi
if [ "$(sed -n 2p "$TMP/redis.proc" | tr -d '\r')" = "redis" ]; then pass "redis-server kullanıcısı: redis"; else fail "redis-server kullanıcısı: $(sed -n 2p "$TMP/redis.proc")"; fi
code=$(dc exec -T redis sh -c 'env -u REDISCLI_AUTH redis-cli ping' 2>/dev/null | tr -d '\r\n' || true)
case "$code" in
  *NOAUTH*) pass "Redis parolasız erişimi reddediyor" ;;
  *) fail "Redis parolasız ping: '$code'" ;;
esac
maxconn=$(dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SHOW max_connections"' 2>/dev/null | tr -d '\r\n' || true)
if [ "$maxconn" = "150" ]; then pass "Postgres max_connections=150"; else fail "Postgres max_connections='$maxconn'"; fi

# --- 4. HTTP kontrolleri (Caddy üzerinden) ---------------------------------------------------------
echo "==> HTTP ($BASE)"
code=$(c -o "$DISCARD" -w '%{http_code}' "$BASE/api/v1/health/ready" || true)
if [ "$code" = "200" ]; then pass "/api/v1/health/ready 200"; else fail "/api/v1/health/ready $code"; fi

: >"$TMP/root.h"
c -D "$TMP/root.h" -o "$DISCARD" "$BASE/" || true
if [ -s "$TMP/root.h" ]; then
  code=$(sed -n '1s/^HTTP\/[0-9.]* \([0-9]*\).*/\1/p' "$TMP/root.h")
  if [ "$code" = "200" ]; then pass "/ 200"; else fail "/ $code"; fi
  if grep -qiE '^content-security-policy: ' "$TMP/root.h"; then pass "/ CSP header var"; else fail "/ CSP header yok"; fi
  if grep -qiE '^strict-transport-security: max-age=31536000; includeSubDomains' "$TMP/root.h"; then pass "HSTS var"; else fail "HSTS yok"; fi
  if grep -qiE '^server:' "$TMP/root.h"; then fail "Server header var: $(grep -iE '^server:' "$TMP/root.h")"; else pass "Server header yok"; fi
else
  fail "/ yanıt başlıkları alınamadı"
fi
: >"$TMP/api.h"
c -D "$TMP/api.h" -o "$DISCARD" "$BASE/api/v1/health/ready" || true
if [ ! -s "$TMP/api.h" ]; then
  fail "api yanıt başlıkları alınamadı"
elif grep -qiE '^(server|x-powered-by):' "$TMP/api.h"; then
  fail "api yanıtında Server/X-Powered-By var"
else
  pass "api yanıtında Server/X-Powered-By yok"
fi
# Kenar gövde sınırı: 1 MB üstü /api/* gövdesi upstream'e ulaşmadan 413
head -c 1100000 /dev/zero | tr '\0' 'a' >"$TMP/big.body"
code=$(c -o "$DISCARD" -w '%{http_code}' -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
  -H 'X-Requested-With: XMLHttpRequest' -H "Origin: $BASE" --data-binary "@$TMP/big.body" || true)
if [ "$code" = "413" ]; then pass "1 MB üstü /api gövdesi 413"; else fail "1 MB üstü /api gövdesi $code"; fi

: >"$TMP/redir.h"
c -D "$TMP/redir.h" -o "$DISCARD" "http://$HOST:$HTTP_PORT/giris" || true
loc=$(grep -iE '^location:' "$TMP/redir.h" | tr -d '\r' | sed -E 's/^[Ll]ocation: *//')
if [ "$loc" = "$BASE/giris" ]; then pass "HTTP → HTTPS yönlendirme ($loc)"; else fail "HTTP yönlendirme Location: '$loc'"; fi

# --- 5. Giriş + SSE (Caddy akışı tamponlamamalı) ----------------------------------------------------
echo "==> Giriş + SSE"
JAR="$TMP/cookies"
code=$(c -c "$JAR" -o "$TMP/login.json" -w '%{http_code}' -X POST "$BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: XMLHttpRequest' -H "Origin: $BASE" \
  --data "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" || true)
if [ "$code" = "200" ]; then pass "seed admin girişi 200"; else fail "giriş $code: $(head -c 200 "$TMP/login.json")"; fi
code=$(c -X POST -o "$DISCARD" -w '%{http_code}' "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
  -H 'X-Requested-With: XMLHttpRequest' -H 'Origin: https://evil.example' --data '{"email":"x@example.com","password":"x"}' || true)
if [ "$code" = "403" ]; then pass "yabancı Origin ile POST 403 (CSRF)"; else fail "yabancı Origin ile POST $code"; fi

code=$(c -b "$JAR" -o "$TMP/overview.json" -w '%{http_code}' "$BASE/api/v1/admin/overview" || true)
if [ "$code" = "200" ]; then pass "/api/v1/admin/overview 200"; else fail "/api/v1/admin/overview $code"; fi

for stream in /api/v1/me/notifications/stream /api/v1/admin/stream; do
  # 5 sn içinde `event: ready` gelmeli; curl -m 5 ile kesilir (çıkış 28 beklenir). Tarayıcı gibi sıkıştırma
  # teklif edilir: SSE yolu encode'dan muaf olmalı (sıkıştırma akışı tamponlar) → Content-Encoding yok.
  : >"$TMP/sse.out"
  : >"$TMP/sse.h"
  c -N -m 5 -b "$JAR" -H 'Accept: text/event-stream' -H 'Accept-Encoding: gzip, zstd' -D "$TMP/sse.h" -o "$TMP/sse.out" \
    -w '%{time_starttransfer}' "$BASE$stream" >"$TMP/sse.t" 2>/dev/null || true
  if grep -qE '^event: ready' "$TMP/sse.out"; then
    pass "$stream: 'ready' 5 sn içinde (ilk bayt $(cat "$TMP/sse.t")s)"
  else
    fail "$stream: 5 sn içinde 'ready' gelmedi ($(head -c 200 "$TMP/sse.out"))"
  fi
  if [ ! -s "$TMP/sse.h" ]; then
    fail "$stream: yanıt başlıkları alınamadı"
  elif grep -qiE '^content-encoding:' "$TMP/sse.h"; then
    fail "$stream: sıkıştırılmış ($(grep -iE '^content-encoding:' "$TMP/sse.h" | tr -d '\r'))"
  else
    pass "$stream: Content-Encoding yok (gzip, zstd teklif edildi)"
  fi
done

# --- 6. SMTP: production kurallarıyla Mailpit'e teslim ----------------------------------------------
echo "==> SMTP (Mailpit, smoke ağı)"
code=$(c -o "$DISCARD" -w '%{http_code}' -X POST "$BASE/api/v1/auth/forgot-password" -H 'Content-Type: application/json' \
  -H 'X-Requested-With: XMLHttpRequest' -H "Origin: $BASE" --data "{\"email\":\"$ADMIN_EMAIL\"}" || true)
if [ "$code" = "204" ]; then pass "forgot-password 204"; else fail "forgot-password $code"; fi
i=0
got=0
while [ $i -lt 15 ]; do
  if dc exec -T api wget -qO- http://mailpit:8025/api/v1/messages 2>/dev/null | grep -q "$ADMIN_EMAIL"; then got=1; break; fi
  i=$((i + 1))
  sleep 1
done
if [ "$got" -eq 1 ]; then pass "parola sıfırlama e-postası Mailpit'e ulaştı"; else fail "Mailpit'te e-posta yok"; fi

# --- 7. api güvensiz production env'de açılmaz (compose içinde) ---------------------------------------
echo "==> api güvensiz env (COOKIE_SECURE=false)"
set +e
timeout 90 docker compose -p "$PROJECT" -f docker-compose.yml -f docker-compose.smoke.override.yml --env-file "$ENVF" \
  run --rm --no-deps -T -e COOKIE_SECURE=false api >"$TMP/unsafe.out" 2>&1
code=$?
set -e
if [ "$code" -ne 0 ] && [ "$code" -lt 124 ] && grep -q 'COOKIE_SECURE' "$TMP/unsafe.out"; then
  pass "api açılmadı (kod $code): $(grep -o 'COOKIE_SECURE[^;"]*' "$TMP/unsafe.out" | head -1)"
else
  fail "api güvensiz env ile açıldı ya da beklenmeyen hata (kod $code): $(tail -c 300 "$TMP/unsafe.out")"
fi

# --- 8. Graceful shutdown: worker SIGTERM ile 45 sn içinde temiz kapanır ------------------------------
echo "==> worker graceful stop"
# Worker hostname'i = kısa konteyner kimliği; heartbeat anahtarları `worker:{heartbeat,seen}:<host>:<pid>`.
hosts=$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter 'label=com.docker.compose.service=worker' --format '{{.ID}}' | cut -c1-12)
for h in $hosts; do
  n=$(dc exec -T redis sh -c "redis-cli --no-auth-warning --scan --pattern 'worker:heartbeat:$h:*' | wc -l" 2>/dev/null | tr -d '\r ' || true)
  if [ "${n:-0}" -ge 1 ]; then pass "worker $h heartbeat anahtarı var (kapanış öncesi)"; else fail "worker $h heartbeat anahtarı yok (kapanış öncesi)"; fi
done
start=$(date +%s)
dc stop worker >/dev/null 2>&1 || true
elapsed=$(( $(date +%s) - start ))
codes=$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --filter 'label=com.docker.compose.service=worker' --format '{{.Status}}' | sort -u | tr '\n' ' ')
# 143 = SIGTERM'i Nest kapanış kancalarından sonra yeniden yükseltir (temiz); 137 = SIGKILL (grace aşıldı)
case "$codes" in
  *"Exited (137)"*) fail "worker SIGKILL ile öldürüldü: $codes (${elapsed}s)" ;;
  *"Exited (0)"*|*"Exited (143)"*) if [ "$elapsed" -lt 45 ]; then pass "worker SIGTERM ile kapandı (${elapsed}s: $codes)"; else fail "worker ${elapsed}s'de kapandı"; fi ;;
  *) fail "worker çıkış durumu: $codes (${elapsed}s)" ;;
esac
# Kapanış kancaları çalıştı mı: HeartbeatService.onModuleDestroy iki anahtarı da siler (SIGKILL'de kalırlar).
for h in $hosts; do
  n=$(dc exec -T redis sh -c "redis-cli --no-auth-warning --scan --pattern 'worker:*:$h:*' | wc -l" 2>/dev/null | tr -d '\r ' || true)
  if [ "$n" = "0" ]; then pass "worker $h kapanış kancaları çalıştı (heartbeat/seen anahtarları silindi)"; else fail "worker $h anahtarları kaldı ($n)"; fi
done
dc logs --no-color worker >"$TMP/worker.log" 2>&1 || true
if grep -qE 'zorla kapat|başlatılamadı|"level":(50|60)' "$TMP/worker.log"; then
  fail "worker log'unda zorla kapatma/hata satırı: $(grep -E 'zorla kapat|başlatılamadı|"level":(50|60)' "$TMP/worker.log" | head -1 | cut -c1-200)"
else
  pass "worker log'unda zorla kapatma/hata satırı yok (zarif kapanış)"
fi

if [ "$FAILS" -gt 0 ]; then
  echo "SONUÇ: FAIL ($FAILS)"
  exit 1
fi
echo "SONUÇ: PASS"
