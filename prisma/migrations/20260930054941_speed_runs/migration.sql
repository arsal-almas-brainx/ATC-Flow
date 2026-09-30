-- AlterTable
ALTER TABLE "AppSetting" ADD COLUMN "pageSpeedApiKey" TEXT;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN "speedCollectionUrl" TEXT;

-- CreateTable
CREATE TABLE "SpeedRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "results" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "SpeedRun_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SlackDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT,
    "speedRunId" TEXT,
    "audience" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,
    "ts" TEXT,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SlackDelivery_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FlowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SlackDelivery_speedRunId_fkey" FOREIGN KEY ("speedRunId") REFERENCES "SpeedRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SlackDelivery" ("audience", "channel", "error", "id", "ok", "runId", "sentAt", "ts") SELECT "audience", "channel", "error", "id", "ok", "runId", "sentAt", "ts" FROM "SlackDelivery";
DROP TABLE "SlackDelivery";
ALTER TABLE "new_SlackDelivery" RENAME TO "SlackDelivery";
CREATE INDEX "SlackDelivery_runId_idx" ON "SlackDelivery"("runId");
CREATE INDEX "SlackDelivery_speedRunId_idx" ON "SlackDelivery"("speedRunId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "SpeedRun_storeId_startedAt_idx" ON "SpeedRun"("storeId", "startedAt");
