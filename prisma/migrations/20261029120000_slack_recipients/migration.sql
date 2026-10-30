-- PDC/QA moves from global settings to each store; existing value is copied to every store.
ALTER TABLE "Store" ADD COLUMN "pdcSlackRecipients" TEXT;
UPDATE "Store" SET "pdcSlackRecipients" = (SELECT "pdcSlackChannel" FROM "AppSetting" WHERE "id" = 1);

-- Department heads now hold a list of channel and/or member IDs.
ALTER TABLE "AppSetting" RENAME COLUMN "deptHeadSlackChannel" TO "deptHeadSlackRecipients";
ALTER TABLE "AppSetting" DROP COLUMN "pdcSlackChannel";
