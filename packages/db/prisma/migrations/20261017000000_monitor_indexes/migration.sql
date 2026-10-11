-- Plan 07 Task 9: izleme (MonitorService) ve admin genel bakış sorguları için indeksler

-- CreateIndex
CREATE INDEX "CollectionJob_finishedAt_idx" ON "CollectionJob"("finishedAt");

-- CreateIndex
CREATE INDEX "ScrapeError_jobId_idx" ON "ScrapeError"("jobId");

-- CreateIndex
CREATE INDEX "ScrapeError_createdAt_idx" ON "ScrapeError"("createdAt");

-- CreateIndex
CREATE INDEX "Notification_status_createdAt_idx" ON "Notification"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_status_sentAt_idx" ON "Notification"("status", "sentAt");
