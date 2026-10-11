#!/usr/bin/env sh
# api/worker dağıtımından prisma CLI'yi ve yalnız onun çektiği paketleri siler (~145 MB).
# Neden: lockfile @prisma/client'ı `prisma` eş bağımlılığıyla (autoInstallPeers) çözdüğünden
# `pnpm deploy --prod` CLI'yi de getirir; çalışma zamanında yalnız üretilmiş istemci + motor gerekir.
# Silinen kümeyi üretim grafiğinde başka paket kullanmaz (lockfile ile doğrulandı); yine de budamadan
# sonra silinen küme DIŞINI gösteren kırık bağ kalırsa betik hata verir.
# migrate imajı bunu ÇAĞIRMAZ (CLI orada gerekli).
# Kullanım: sh docker/prune-prisma-cli.sh <deploy-dizini>
set -eu
OUT=$(cd "$1" && pwd)
PRUNED="prisma@ @prisma+engines@ @prisma+fetch-engine@ @prisma+get-platform@ @prisma+config@ effect@ fast-check@ typescript@ jiti@ c12@ deepmerge-ts@ empathic@"
cd "$OUT/node_modules/.pnpm"
for prefix in $PRUNED; do
  rm -rf "$prefix"*
done
# Kırık sembolik bağlar: hedefi silinen kümedeyse kaldır, değilse dur (beklenmeyen bir bağımlılık kırıldı).
find "$OUT/node_modules" -type l ! -exec test -e {} \; -print | while IFS= read -r link; do
  target=$(readlink "$link")
  ok=0
  for prefix in $PRUNED; do
    case "/$target" in
      */"$prefix"*) ok=1 ;;
    esac
  done
  if [ "$ok" -ne 1 ]; then
    echo "prune-prisma-cli: budanan küme dışında kırık bağ: $link -> $target" >&2
    exit 1
  fi
  rm -f "$link"
done
