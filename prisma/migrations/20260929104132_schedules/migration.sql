-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FlowRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "productUrl" TEXT NOT NULL,
    "device" TEXT NOT NULL DEFAULT 'desktop',
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "groupId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "error" TEXT,
    "cartTotal" TEXT,
    "checkoutUrl" TEXT,
    "steps" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "FlowRun_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_FlowRun" ("cartTotal", "checkoutUrl", "device", "error", "finishedAt", "groupId", "id", "productUrl", "quantity", "startedAt", "status", "steps", "storeId") SELECT "cartTotal", "checkoutUrl", "device", "error", "finishedAt", "groupId", "id", "productUrl", "quantity", "startedAt", "status", "steps", "storeId" FROM "FlowRun";
DROP TABLE "FlowRun";
ALTER TABLE "new_FlowRun" RENAME TO "FlowRun";
CREATE INDEX "FlowRun_storeId_startedAt_idx" ON "FlowRun"("storeId", "startedAt");
CREATE INDEX "FlowRun_groupId_idx" ON "FlowRun"("groupId");
CREATE TABLE "new_Store" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "productUrls" TEXT NOT NULL DEFAULT '',
    "discountCode" TEXT,
    "searchQuery" TEXT,
    "slackChannel" TEXT,
    "storefrontPassword" TEXT,
    "webBotAuthSignature" TEXT,
    "webBotAuthSignatureInput" TEXT,
    "webBotAuthExpiresAt" DATETIME,
    "scheduleEnabled" BOOLEAN NOT NULL DEFAULT false,
    "schedulePeriod" TEXT NOT NULL DEFAULT 'day',
    "scheduleFrequency" INTEGER NOT NULL DEFAULT 1,
    "scheduleTime" TEXT NOT NULL DEFAULT '09:00',
    "nextRunAt" DATETIME,
    "lastScheduledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Store" ("createdAt", "discountCode", "id", "name", "productUrls", "searchQuery", "slackChannel", "storefrontPassword", "updatedAt", "url", "webBotAuthExpiresAt", "webBotAuthSignature", "webBotAuthSignatureInput") SELECT "createdAt", "discountCode", "id", "name", "productUrls", "searchQuery", "slackChannel", "storefrontPassword", "updatedAt", "url", "webBotAuthExpiresAt", "webBotAuthSignature", "webBotAuthSignatureInput" FROM "Store";
DROP TABLE "Store";
ALTER TABLE "new_Store" RENAME TO "Store";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
