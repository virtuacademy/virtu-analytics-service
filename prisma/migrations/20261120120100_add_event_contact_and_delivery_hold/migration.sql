-- A delivery is not attempted before this time (Google Ads uploads wait for their click to age).
ALTER TABLE "Delivery" ADD COLUMN     "notBefore" TIMESTAMP(3);

-- Contact details and visit link of an event that is not an appointment.
CREATE TABLE "EventContact" (
    "canonicalEventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email" TEXT,
    "phone" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "vaAttrib" TEXT,
    "staffInitiated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "EventContact_pkey" PRIMARY KEY ("canonicalEventId")
);

CREATE INDEX "EventContact_vaAttrib_idx" ON "EventContact"("vaAttrib");

ALTER TABLE "EventContact" ADD CONSTRAINT "EventContact_canonicalEventId_fkey" FOREIGN KEY ("canonicalEventId") REFERENCES "CanonicalEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
