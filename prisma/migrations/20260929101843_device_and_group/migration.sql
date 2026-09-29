-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FlowRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "productUrl" TEXT NOT NULL,
    "device" TEXT NOT NULL DEFAULT 'desktop',
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
INSERT INTO "new_FlowRun" ("cartTotal", "checkoutUrl", "error", "finishedAt", "id", "productUrl", "quantity", "startedAt", "status", "steps", "storeId") SELECT "cartTotal", "checkoutUrl", "error", "finishedAt", "id", "productUrl", "quantity", "startedAt", "status", "steps", "storeId" FROM "FlowRun";
DROP TABLE "FlowRun";
ALTER TABLE "new_FlowRun" RENAME TO "FlowRun";
CREATE INDEX "FlowRun_storeId_startedAt_idx" ON "FlowRun"("storeId", "startedAt");
CREATE INDEX "FlowRun_groupId_idx" ON "FlowRun"("groupId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
