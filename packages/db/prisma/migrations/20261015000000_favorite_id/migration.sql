-- Stable keyset cursor for favorites (newest first); composite PK stays.
ALTER TABLE "Favorite" ADD COLUMN "id" SERIAL NOT NULL;
CREATE UNIQUE INDEX "Favorite_id_key" ON "Favorite"("id");
