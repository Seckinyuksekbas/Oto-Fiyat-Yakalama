-- Refresh ailesinin mutlak ömrü: ailenin başlangıcı rotasyonda taşınır.
ALTER TABLE "Session" ADD COLUMN "familyStartedAt" TIMESTAMP(3);

-- Mevcut satırlar: ailenin en eski oturumunun createdAt değeri.
UPDATE "Session" s
SET "familyStartedAt" = (SELECT MIN(f."createdAt") FROM "Session" f WHERE f."familyId" = s."familyId");

ALTER TABLE "Session" ALTER COLUMN "familyStartedAt" SET NOT NULL,
ALTER COLUMN "familyStartedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- Favori listesi keyset sayfalaması (WHERE userId ORDER BY id).
CREATE INDEX "Favorite_userId_id_idx" ON "Favorite"("userId", "id");
