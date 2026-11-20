-- The up-front hold on Google Ads uploads was removed before it shipped: uploads go at once and
-- only a rejected one is retried later, using the existing Delivery columns. This takes back
-- the column an earlier, unshipped step of this change added, so Delivery ends as it began.
ALTER TABLE "Delivery" DROP COLUMN "notBefore";
