#!/usr/bin/env sh
# api/worker dağıtımından prisma CLI'yi ve yalnız onun çektiği paketleri siler (~145 MB).
# Neden: lockfile @prisma/client'ı `prisma` eş bağımlılığıyla (autoInstallPeers) çözdüğünden
# `pnpm deploy --prod` CLI'yi de getirir; çalışma zamanında yalnız üretilmiş istemci + motor gerekir.
# migrate imajı bunu ÇAĞIRMAZ (CLI orada gerekli).
# Kullanım: sh docker/prune-prisma-cli.sh <deploy-dizini>
set -eu
OUT=$(cd "$1" && pwd)
cd "$OUT/node_modules/.pnpm"
rm -rf prisma@* @prisma+engines@* @prisma+fetch-engine@* @prisma+get-platform@* @prisma+config@* \
  effect@* fast-check@* typescript@* jiti@* c12@* deepmerge-ts@* empathic@*
# Silinen paketlere işaret eden kırık sembolik bağlar
find "$OUT/node_modules" -type l ! -exec test -e {} \; -delete
