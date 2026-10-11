-- Refresh ailesinin mutlak ömrü: ailenin başlangıcı rotasyonda taşınır.
ALTER TABLE "Session" ADD COLUMN "familyStartedAt" TIMESTAMP(3);

-- Mevcut satırlar: ailenin en eski oturumunun createdAt değeri (küme tabanlı, aile başına tek MIN).
UPDATE "Session" s
SET "familyStartedAt" = f."startedAt"
FROM (SELECT "familyId", MIN("createdAt") AS "startedAt" FROM "Session" GROUP BY 1) f
WHERE s."familyId" = f."familyId";

ALTER TABLE "Session" ALTER COLUMN "familyStartedAt" SET NOT NULL,
ALTER COLUMN "familyStartedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- Favori listesi keyset sayfalaması (WHERE userId ORDER BY id).
CREATE INDEX "Favorite_userId_id_idx" ON "Favorite"("userId", "id");
