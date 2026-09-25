-- AlterTable
ALTER TABLE "ShopSetting" ADD COLUMN "webBotAuthExpiresAt" DATETIME;
ALTER TABLE "ShopSetting" ADD COLUMN "webBotAuthSignature" TEXT;
ALTER TABLE "ShopSetting" ADD COLUMN "webBotAuthSignatureInput" TEXT;
