#!/usr/bin/env sh
# Derleme aşamasında (`prisma generate`, binaryTargets: native + linux-musl-openssl-3.0.x) üretilen
# Prisma istemcisini (`node_modules/.prisma/client`) `pnpm deploy` çıktısındaki @prisma/client'ın
# yanına kopyalar. Dağıtımda prisma CLI olmadığından orada generate çalıştırılamaz.
# Kullanım: sh docker/copy-prisma-client.sh <deploy-dizini>   (çalışma dizini: repo kökü)
set -eu
OUT=$1
# @prisma/client'ın gerçek dizini → kardeş `.prisma` (pnpm sanal deposu: .../node_modules/{@prisma/client,.prisma})
prisma_dir() { # $1: @oto/db'yi çözebilen dizin ya da @oto/db dağıtımının kendisi
  node -e '
    const path = require("node:path"), fs = require("node:fs");
    const out = path.resolve(process.argv[1]);
    const self = JSON.parse(fs.readFileSync(path.join(out, "package.json"), "utf8")).name === "@oto/db";
    const db = self ? path.join(out, "package.json") : require.resolve("@oto/db", { paths: [out] });
    const client = fs.realpathSync(path.dirname(require.resolve("@prisma/client/package.json", { paths: [path.dirname(db)] })));
    console.log(path.join(client, "..", "..", ".prisma"));
  ' "$1"
}
SRC=$(cd packages/db && node -e '
  const path = require("node:path"), fs = require("node:fs");
  const client = fs.realpathSync(path.dirname(require.resolve("@prisma/client/package.json")));
  console.log(path.join(client, "..", "..", ".prisma"));
')
DST=$(prisma_dir "$OUT")
test -f "$SRC/client/default.js" || { echo "üretilmiş Prisma istemcisi yok: $SRC" >&2; exit 1; }
ls "$SRC/client" | grep -q 'linux-musl-openssl-3.0.x' || { echo "musl Prisma motoru yok: $SRC/client" >&2; exit 1; }
rm -rf "$DST"
mkdir -p "$DST"
cp -R "$SRC/client" "$DST/client"
echo "Prisma istemcisi kopyalandı: $DST/client"
