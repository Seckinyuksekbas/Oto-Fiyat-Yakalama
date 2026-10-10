UPDATE "SearchProfile" SET "fuels" = '{}' WHERE "fuels" IS NULL;
UPDATE "SearchProfile" SET "transmissions" = '{}' WHERE "transmissions" IS NULL;
UPDATE "SearchProfile" SET "cities" = '{}' WHERE "cities" IS NULL;
ALTER TABLE "SearchProfile" ALTER COLUMN "fuels" SET DEFAULT '{}', ALTER COLUMN "fuels" SET NOT NULL;
ALTER TABLE "SearchProfile" ALTER COLUMN "transmissions" SET DEFAULT '{}', ALTER COLUMN "transmissions" SET NOT NULL;
ALTER TABLE "SearchProfile" ALTER COLUMN "cities" SET DEFAULT '{}', ALTER COLUMN "cities" SET NOT NULL;
