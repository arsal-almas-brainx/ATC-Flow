-- CreateTable
CREATE TABLE "FlowRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productUrl" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "error" TEXT,
    "cartTotal" TEXT,
    "checkoutUrl" TEXT,
    "steps" TEXT NOT NULL DEFAULT '[]'
);

-- CreateIndex
CREATE INDEX "FlowRun_shop_startedAt_idx" ON "FlowRun"("shop", "startedAt");
