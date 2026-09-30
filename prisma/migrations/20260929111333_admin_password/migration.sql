-- AlterTable
ALTER TABLE "AppSetting" ADD COLUMN "adminPasswordChangedAt" DATETIME;
ALTER TABLE "AppSetting" ADD COLUMN "adminPasswordHash" TEXT;
