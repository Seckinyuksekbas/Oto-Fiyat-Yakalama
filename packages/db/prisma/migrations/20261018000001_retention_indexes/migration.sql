-- Plan 08 Task 3: saklama (retention) temizliği için indeksler (EXPLAIN ile doğrulandı)
-- ListingMatch.analysisId: ListingAnalysis silinirken ON DELETE CASCADE FK kontrolü her satır için
-- ListingMatch'i tarar; indeks olmadan 5000'lik parti ~22 sn, indeksle ~0,4 sn (1M analiz / 100k eşleşme).

-- CreateIndex
CREATE INDEX "ListingMatch_analysisId_idx" ON "ListingMatch"("analysisId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Session_revokedAt_idx" ON "Session"("revokedAt");
