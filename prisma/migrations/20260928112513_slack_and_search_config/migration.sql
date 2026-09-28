-- AlterTable
ALTER TABLE "Store" ADD COLUMN "searchQuery" TEXT;
ALTER TABLE "Store" ADD COLUMN "slackChannel" TEXT;

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "pdcSlackChannel" TEXT,
    "deptHeadSlackChannel" TEXT,
    "updatedAt" DATETIME NOT NULL
);
