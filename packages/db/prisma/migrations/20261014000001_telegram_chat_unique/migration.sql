-- One Telegram chat belongs to at most one user (partial unique; not expressible in Prisma schema).
CREATE UNIQUE INDEX "NotificationChannel_telegram_chat_key" ON "NotificationChannel"("externalIdHash") WHERE "type" = 'TELEGRAM' AND "externalIdHash" IS NOT NULL;
