-- AlterTable
ALTER TABLE "CollectionJob" ADD COLUMN     "dryRunResult" JSONB;

-- AlterTable
ALTER TABLE "ListingAnalysis" ADD COLUMN     "matchDispatchAttempts" INTEGER NOT NULL DEFAULT 0;

