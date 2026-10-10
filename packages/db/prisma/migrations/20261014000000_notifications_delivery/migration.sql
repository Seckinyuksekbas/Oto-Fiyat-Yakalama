-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "queuedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "NotificationChannel" ADD COLUMN     "externalIdHash" TEXT;

-- CreateIndex
CREATE INDEX "Notification_status_queuedAt_idx" ON "Notification"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "NotificationChannel_type_externalIdHash_idx" ON "NotificationChannel"("type", "externalIdHash");

