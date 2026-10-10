-- AlterTable
ALTER TABLE "ListingAnalysis" ADD COLUMN     "listingContentHash" TEXT,
ADD COLUMN     "listingPrice" BIGINT,
ADD COLUMN     "matchEvent" "MatchReason",
ADD COLUMN     "matchPreviousPrice" BIGINT,
ADD COLUMN     "matchQueuedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ListingAnalysis_matchEvent_matchQueuedAt_idx" ON "ListingAnalysis"("matchEvent", "matchQueuedAt");
