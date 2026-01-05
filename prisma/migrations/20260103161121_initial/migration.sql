-- CreateEnum
CREATE TYPE "CanonicalEventName" AS ENUM ('TRIAL_BOOKED', 'TRIAL_RESCHEDULED', 'TRIAL_CANCELED', 'APPOINTMENT_UPDATED');

-- CreateEnum
CREATE TYPE "DeliveryPlatform" AS ENUM ('META', 'GOOGLE_ADS', 'TIKTOK', 'HUBSPOT');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "Visitor" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Visitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "ipFirst" TEXT,
    "uaFirst" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attribution" (
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstTouchAt" TIMESTAMP(3) NOT NULL,
    "lastTouchAt" TIMESTAMP(3) NOT NULL,
    "firstUrl" TEXT,
    "lastUrl" TEXT,
    "firstReferrer" TEXT,
    "lastReferrer" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmTerm" TEXT,
    "utmContent" TEXT,
    "gclid" TEXT,
    "gbraid" TEXT,
    "wbraid" TEXT,
    "dclid" TEXT,
    "fbclid" TEXT,
    "fbp" TEXT,
    "fbc" TEXT,
    "ttclid" TEXT,
    "msclkid" TEXT,
    "hubspotutk" TEXT,
    "visitorId" TEXT,
    "sessionId" TEXT,

    CONSTRAINT "Attribution_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "InboundWebhook" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "bodyRaw" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,

    CONSTRAINT "InboundWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "appointmentTypeId" TEXT,
    "calendarId" TEXT,
    "status" TEXT,
    "datetime" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "vaAttrib" TEXT,
    "gclid" TEXT,
    "ttclid" TEXT,
    "fbp" TEXT,
    "fbc" TEXT,
    "rawJson" TEXT,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CanonicalEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" "CanonicalEventName" NOT NULL,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "appointmentId" TEXT,
    "attributionTok" TEXT,
    "value" DOUBLE PRECISION,
    "currency" TEXT,
    "eventId" TEXT NOT NULL,

    CONSTRAINT "CanonicalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "canonicalEventId" TEXT NOT NULL,
    "platform" "DeliveryPlatform" NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "responseCode" INTEGER,
    "responseBody" TEXT,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_visitorId_idx" ON "Session"("visitorId");

-- CreateIndex
CREATE INDEX "Attribution_gclid_idx" ON "Attribution"("gclid");

-- CreateIndex
CREATE INDEX "Attribution_fbclid_idx" ON "Attribution"("fbclid");

-- CreateIndex
CREATE INDEX "Attribution_ttclid_idx" ON "Attribution"("ttclid");

-- CreateIndex
CREATE INDEX "InboundWebhook_externalId_idx" ON "InboundWebhook"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundWebhook_source_action_externalId_bodyHash_key" ON "InboundWebhook"("source", "action", "externalId", "bodyHash");

-- CreateIndex
CREATE INDEX "Appointment_vaAttrib_idx" ON "Appointment"("vaAttrib");

-- CreateIndex
CREATE INDEX "Appointment_appointmentTypeId_idx" ON "Appointment"("appointmentTypeId");

-- CreateIndex
CREATE INDEX "CanonicalEvent_appointmentId_idx" ON "CanonicalEvent"("appointmentId");

-- CreateIndex
CREATE INDEX "CanonicalEvent_attributionTok_idx" ON "CanonicalEvent"("attributionTok");

-- CreateIndex
CREATE INDEX "CanonicalEvent_name_eventTime_idx" ON "CanonicalEvent"("name", "eventTime");

-- CreateIndex
CREATE INDEX "Delivery_platform_status_idx" ON "Delivery"("platform", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_canonicalEventId_platform_key" ON "Delivery"("canonicalEventId", "platform");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_visitorId_fkey" FOREIGN KEY ("visitorId") REFERENCES "Visitor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_canonicalEventId_fkey" FOREIGN KEY ("canonicalEventId") REFERENCES "CanonicalEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
