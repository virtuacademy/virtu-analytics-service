-- The address a page's event was reported from, which its daily limit per address counts.
ALTER TABLE "EventContact" ADD COLUMN     "ipAddress" TEXT;

CREATE INDEX "EventContact_ipAddress_idx" ON "EventContact"("ipAddress");
