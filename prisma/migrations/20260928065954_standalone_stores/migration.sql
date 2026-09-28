/*
  Warnings:

  - You are about to drop the `Session` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ShopSetting` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `shop` on the `FlowRun` table. All the data in the column will be lost.
  - Added the required column `storeId` to the `FlowRun` table without a default value. This is not possible if the table is not empty.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Session";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "ShopSetting";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "productUrls" TEXT NOT NULL DEFAULT '',
    "discountCode" TEXT,
    "storefrontPassword" TEXT,
    "webBotAuthSignature" TEXT,
    "webBotAuthSignatureInput" TEXT,
    "webBotAuthExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FlowRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "productUrl" TEXT NOT NULL,
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
-- Existing runs belonged to Shopify-installed shops that no longer exist as
-- a concept, so they are not carried over.
DROP TABLE "FlowRun";
ALTER TABLE "new_FlowRun" RENAME TO "FlowRun";
CREATE INDEX "FlowRun_storeId_startedAt_idx" ON "FlowRun"("storeId", "startedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
