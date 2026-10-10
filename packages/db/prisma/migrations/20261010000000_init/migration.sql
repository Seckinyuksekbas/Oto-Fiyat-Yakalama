-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('IN_APP', 'TELEGRAM', 'EMAIL');

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('HTTP', 'BROWSER', 'API', 'FEED');

-- CreateEnum
CREATE TYPE "PermissionType" AS ENUM ('LICENSED_API', 'PARTNER_FEED', 'TOS_PERMITTED', 'TEST');

-- CreateEnum
CREATE TYPE "SourceHealth" AS ENUM ('HEALTHY', 'DEGRADED', 'DOWN', 'PAUSED');

-- CreateEnum
CREATE TYPE "JobTrigger" AS ENUM ('SCHEDULED', 'MANUAL');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "ScrapeErrorKind" AS ENUM ('NETWORK', 'TIMEOUT', 'HTTP_4XX', 'HTTP_5XX', 'BLOCKED', 'PARSE', 'VALIDATION');

-- CreateEnum
CREATE TYPE "Fuel" AS ENUM ('GASOLINE', 'DIESEL', 'LPG', 'HYBRID', 'ELECTRIC', 'OTHER');

-- CreateEnum
CREATE TYPE "Transmission" AS ENUM ('MANUAL', 'AUTOMATIC', 'SEMI_AUTOMATIC');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "Confidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT');

-- CreateEnum
CREATE TYPE "AnalysisFlag" AS ENUM ('DAMAGED', 'SUSPICIOUS_LOW', 'HIGH_DISPERSION');

-- CreateEnum
CREATE TYPE "ProfileStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "MatchReason" AS ENUM ('NEW', 'PRICE_DROP', 'RELIST');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('MATCH', 'SYSTEM_ALERT', 'SECURITY');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED_LIMIT');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('WARN', 'ERROR');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "emailVerifiedAt" TIMESTAMP(3),
    "kvkkAcceptedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailVerificationToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceMonthly" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "limits" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "limitOverrides" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ChannelType" NOT NULL,
    "config" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramLinkToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramLinkToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSource" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "adapterKey" TEXT NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "permissionType" "PermissionType" NOT NULL,
    "permissionNote" TEXT,
    "permissionVerifiedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "intervalSec" INTEGER NOT NULL DEFAULT 300,
    "maxConcurrency" INTEGER NOT NULL DEFAULT 1,
    "minRequestGapMs" INTEGER NOT NULL DEFAULT 2000,
    "config" JSONB NOT NULL DEFAULT '{}',
    "proxyConfigId" INTEGER,
    "health" "SourceHealth" NOT NULL DEFAULT 'HEALTHY',
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProxyConfig" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "urlEncrypted" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckAt" TIMESTAMP(3),
    "lastLatencyMs" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProxyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionJob" (
    "id" SERIAL NOT NULL,
    "sourceId" INTEGER NOT NULL,
    "trigger" "JobTrigger" NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "listingsSeen" INTEGER NOT NULL DEFAULT 0,
    "listingsNew" INTEGER NOT NULL DEFAULT 0,
    "listingsUpdated" INTEGER NOT NULL DEFAULT 0,
    "errorsCount" INTEGER NOT NULL DEFAULT 0,
    "avgResponseMs" INTEGER,
    "errorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScrapeError" (
    "id" SERIAL NOT NULL,
    "jobId" INTEGER,
    "sourceId" INTEGER NOT NULL,
    "kind" "ScrapeErrorKind" NOT NULL,
    "url" TEXT,
    "message" TEXT NOT NULL,
    "transient" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScrapeError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" SERIAL NOT NULL,
    "sourceId" INTEGER NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "trim" TEXT,
    "year" INTEGER NOT NULL,
    "km" INTEGER NOT NULL,
    "fuel" "Fuel" NOT NULL,
    "transmission" "Transmission" NOT NULL,
    "bodyType" TEXT,
    "color" TEXT,
    "city" TEXT,
    "sellerType" TEXT,
    "damageInfo" JSONB,
    "price" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "contentHash" TEXT NOT NULL,
    "status" "ListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "relistedAt" TIMESTAMP(3),
    "latestAnalysisId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingPriceHistory" (
    "id" SERIAL NOT NULL,
    "listingId" INTEGER NOT NULL,
    "price" BIGINT NOT NULL,
    "km" INTEGER NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingPriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingIssue" (
    "id" SERIAL NOT NULL,
    "sourceId" INTEGER NOT NULL,
    "listingId" INTEGER,
    "externalId" TEXT,
    "field" TEXT NOT NULL,
    "problem" TEXT NOT NULL,
    "rawSnippet" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingAnalysis" (
    "id" SERIAL NOT NULL,
    "listingId" INTEGER NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "estimatedPrice" BIGINT,
    "priceDiff" BIGINT,
    "discountPct" DECIMAL(6,4),
    "opportunityScore" INTEGER NOT NULL,
    "comparableCount" INTEGER NOT NULL,
    "confidence" "Confidence" NOT NULL,
    "expansionLevel" INTEGER,
    "flags" "AnalysisFlag"[],
    "explanation" JSONB NOT NULL,
    "comparableIds" INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ProfileStatus" NOT NULL DEFAULT 'ACTIVE',
    "make" TEXT,
    "model" TEXT,
    "yearMin" INTEGER,
    "yearMax" INTEGER,
    "priceMin" BIGINT,
    "priceMax" BIGINT,
    "kmMax" INTEGER,
    "fuels" "Fuel"[],
    "transmissions" "Transmission"[],
    "cities" TEXT[],
    "minDiscountPct" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "minConfidence" "Confidence" NOT NULL DEFAULT 'MEDIUM',
    "excludeDamaged" BOOLEAN NOT NULL DEFAULT false,
    "notifyOnPriceDrop" BOOLEAN NOT NULL DEFAULT true,
    "priceDropPct" DECIMAL(5,4) NOT NULL DEFAULT 0.05,
    "notifyOnRelist" BOOLEAN NOT NULL DEFAULT false,
    "channels" "ChannelType"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingMatch" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "searchProfileId" TEXT NOT NULL,
    "listingId" INTEGER NOT NULL,
    "analysisId" INTEGER NOT NULL,
    "reason" "MatchReason" NOT NULL,
    "matchedPrice" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "matchId" INTEGER,
    "kind" "NotificationKind" NOT NULL DEFAULT 'MATCH',
    "channel" "ChannelType" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "payload" JSONB NOT NULL,
    "sentAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Favorite" (
    "userId" TEXT NOT NULL,
    "listingId" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Favorite_pkey" PRIMARY KEY ("userId","listingId")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" SERIAL NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemLog" (
    "id" SERIAL NOT NULL,
    "level" "LogLevel" NOT NULL,
    "component" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "MakeModelAlias" (
    "id" SERIAL NOT NULL,
    "rawText" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "trim" TEXT,

    CONSTRAINT "MakeModelAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_status_role_idx" ON "User"("status", "role");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_familyId_idx" ON "Session"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlan_code_key" ON "SubscriptionPlan"("code");

-- CreateIndex
CREATE INDEX "UserSubscription_userId_status_idx" ON "UserSubscription"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationChannel_userId_type_key" ON "NotificationChannel"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramLinkToken_codeHash_key" ON "TelegramLinkToken"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "DataSource_code_key" ON "DataSource"("code");

-- CreateIndex
CREATE INDEX "CollectionJob_sourceId_createdAt_idx" ON "CollectionJob"("sourceId", "createdAt");

-- CreateIndex
CREATE INDEX "CollectionJob_status_idx" ON "CollectionJob"("status");

-- CreateIndex
CREATE INDEX "ScrapeError_sourceId_createdAt_idx" ON "ScrapeError"("sourceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_latestAnalysisId_key" ON "Listing"("latestAnalysisId");

-- CreateIndex
CREATE INDEX "Listing_make_model_year_idx" ON "Listing"("make", "model", "year");

-- CreateIndex
CREATE INDEX "Listing_status_firstSeenAt_idx" ON "Listing"("status", "firstSeenAt");

-- CreateIndex
CREATE INDEX "Listing_make_model_fuel_transmission_year_km_idx" ON "Listing"("make", "model", "fuel", "transmission", "year", "km");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_sourceId_externalId_key" ON "Listing"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "ListingPriceHistory_listingId_observedAt_idx" ON "ListingPriceHistory"("listingId", "observedAt");

-- CreateIndex
CREATE INDEX "ListingIssue_sourceId_createdAt_idx" ON "ListingIssue"("sourceId", "createdAt");

-- CreateIndex
CREATE INDEX "ListingAnalysis_listingId_createdAt_idx" ON "ListingAnalysis"("listingId", "createdAt");

-- CreateIndex
CREATE INDEX "ListingAnalysis_confidence_opportunityScore_idx" ON "ListingAnalysis"("confidence", "opportunityScore");

-- CreateIndex
CREATE INDEX "SearchProfile_status_make_model_idx" ON "SearchProfile"("status", "make", "model");

-- CreateIndex
CREATE INDEX "SearchProfile_userId_idx" ON "SearchProfile"("userId");

-- CreateIndex
CREATE INDEX "ListingMatch_userId_createdAt_idx" ON "ListingMatch"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ListingMatch_searchProfileId_listingId_reason_matchedPrice_key" ON "ListingMatch"("searchProfileId", "listingId", "reason", "matchedPrice");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_status_channel_idx" ON "Notification"("status", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_matchId_channel_key" ON "Notification"("matchId", "channel");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "SystemLog_createdAt_idx" ON "SystemLog"("createdAt");

-- CreateIndex
CREATE INDEX "SystemLog_level_createdAt_idx" ON "SystemLog"("level", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MakeModelAlias_rawText_key" ON "MakeModelAlias"("rawText");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationChannel" ADD CONSTRAINT "NotificationChannel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramLinkToken" ADD CONSTRAINT "TelegramLinkToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSource" ADD CONSTRAINT "DataSource_proxyConfigId_fkey" FOREIGN KEY ("proxyConfigId") REFERENCES "ProxyConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionJob" ADD CONSTRAINT "CollectionJob_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DataSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScrapeError" ADD CONSTRAINT "ScrapeError_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CollectionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScrapeError" ADD CONSTRAINT "ScrapeError_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DataSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DataSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_latestAnalysisId_fkey" FOREIGN KEY ("latestAnalysisId") REFERENCES "ListingAnalysis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingPriceHistory" ADD CONSTRAINT "ListingPriceHistory_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingIssue" ADD CONSTRAINT "ListingIssue_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DataSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingIssue" ADD CONSTRAINT "ListingIssue_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingAnalysis" ADD CONSTRAINT "ListingAnalysis_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchProfile" ADD CONSTRAINT "SearchProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingMatch" ADD CONSTRAINT "ListingMatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingMatch" ADD CONSTRAINT "ListingMatch_searchProfileId_fkey" FOREIGN KEY ("searchProfileId") REFERENCES "SearchProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingMatch" ADD CONSTRAINT "ListingMatch_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingMatch" ADD CONSTRAINT "ListingMatch_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "ListingAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "ListingMatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Spec §2: izin doğrulanmadan kaynak aktif edilemez
ALTER TABLE "DataSource"
  ADD CONSTRAINT "DataSource_active_requires_permission"
  CHECK (NOT "isActive" OR "permissionVerifiedAt" IS NOT NULL);
