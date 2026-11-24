-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "amountMinor" BIGINT;

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "balanceMinor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'user';

-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN     "amountMinor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "journalId" TEXT,
ADD COLUMN     "runningBalanceMinor" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Journal" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "description" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Journal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "rail" TEXT NOT NULL,
    "railRef" TEXT,
    "state" TEXT NOT NULL DEFAULT 'created',
    "openKey" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RailEvent" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "rail" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "providerStatus" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL DEFAULT '',
    "applied" BOOLEAN NOT NULL DEFAULT true,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RailCursor" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RailCursor_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "StockPosition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "units" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PositionEntry" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "units" BIGINT NOT NULL,
    "runningUnits" BIGINT NOT NULL,
    "reference" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PositionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockOrder" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenDecimals" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "cashAmount" DOUBLE PRECISION NOT NULL,
    "cashAmountMinor" BIGINT NOT NULL DEFAULT 0,
    "usdcUnits" BIGINT NOT NULL DEFAULT 0,
    "tokenUnits" BIGINT NOT NULL DEFAULT 0,
    "minTokenUnits" BIGINT NOT NULL DEFAULT 0,
    "minUsdcUnits" BIGINT NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'created',
    "venue" TEXT NOT NULL,
    "txHash" TEXT,
    "failure" TEXT,
    "fx" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockSchedule" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenDecimals" INTEGER NOT NULL,
    "ticker" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cashAmount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "weekday" INTEGER,
    "dayOfMonth" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'active',
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueTrade" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "sellAmount" BIGINT NOT NULL,
    "minBuyAmount" BIGINT NOT NULL,
    "txHash" TEXT,
    "state" TEXT NOT NULL DEFAULT 'submitted',
    "failure" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockSnapshot" (
    "tokenAddress" TEXT NOT NULL,
    "multiplier" DOUBLE PRECISION NOT NULL,
    "navPrice" DOUBLE PRECISION,
    "navUpdatedAt" TEXT,
    "refPrice" DOUBLE PRECISION,
    "refAt" TIMESTAMP(3),
    "lastMoveAlertAt" TIMESTAMP(3),
    "pendingSince" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockSnapshot_pkey" PRIMARY KEY ("tokenAddress")
);

-- CreateTable
CREATE TABLE "StockAlert" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockAlertOptOut" (
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockAlertOptOut_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "StockPricePoint" (
    "id" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockPricePoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTarget" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "percent" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockSweep" (
    "userId" TEXT NOT NULL,
    "percent" DOUBLE PRECISION NOT NULL,
    "tokenAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockSweep_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Journal_idempotencyKey_key" ON "Journal"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Journal_reference_idx" ON "Journal"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_reference_key" ON "PaymentIntent"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_openKey_key" ON "PaymentIntent"("openKey");

-- CreateIndex
CREATE INDEX "PaymentIntent_state_idx" ON "PaymentIntent"("state");

-- CreateIndex
CREATE INDEX "PaymentIntent_userId_idx" ON "PaymentIntent"("userId");

-- CreateIndex
CREATE INDEX "RailEvent_intentId_idx" ON "RailEvent"("intentId");

-- CreateIndex
CREATE UNIQUE INDEX "RailEvent_intentId_type_dedupeKey_key" ON "RailEvent"("intentId", "type", "dedupeKey");

-- CreateIndex
CREATE INDEX "StockPosition_userId_idx" ON "StockPosition"("userId");

-- CreateIndex
CREATE INDEX "StockPosition_tokenAddress_idx" ON "StockPosition"("tokenAddress");

-- CreateIndex
CREATE UNIQUE INDEX "StockPosition_userId_tokenAddress_key" ON "StockPosition"("userId", "tokenAddress");

-- CreateIndex
CREATE UNIQUE INDEX "PositionEntry_idempotencyKey_key" ON "PositionEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PositionEntry_positionId_idx" ON "PositionEntry"("positionId");

-- CreateIndex
CREATE INDEX "PositionEntry_reference_idx" ON "PositionEntry"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "StockOrder_reference_key" ON "StockOrder"("reference");

-- CreateIndex
CREATE INDEX "StockOrder_userId_idx" ON "StockOrder"("userId");

-- CreateIndex
CREATE INDEX "StockOrder_state_idx" ON "StockOrder"("state");

-- CreateIndex
CREATE UNIQUE INDEX "StockSchedule_reference_key" ON "StockSchedule"("reference");

-- CreateIndex
CREATE INDEX "StockSchedule_state_nextRunAt_idx" ON "StockSchedule"("state", "nextRunAt");

-- CreateIndex
CREATE INDEX "StockSchedule_userId_idx" ON "StockSchedule"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VenueTrade_reference_key" ON "VenueTrade"("reference");

-- CreateIndex
CREATE INDEX "VenueTrade_state_idx" ON "VenueTrade"("state");

-- CreateIndex
CREATE UNIQUE INDEX "StockAlert_key_key" ON "StockAlert"("key");

-- CreateIndex
CREATE INDEX "StockAlert_userId_idx" ON "StockAlert"("userId");

-- CreateIndex
CREATE INDEX "StockPricePoint_tokenAddress_observedAt_idx" ON "StockPricePoint"("tokenAddress", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockPricePoint_tokenAddress_observedAt_key" ON "StockPricePoint"("tokenAddress", "observedAt");

-- CreateIndex
CREATE INDEX "StockTarget_userId_idx" ON "StockTarget"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StockTarget_userId_tokenAddress_key" ON "StockTarget"("userId", "tokenAddress");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_idempotencyKey_key" ON "LedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerEntry_journalId_idx" ON "LedgerEntry"("journalId");

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "Journal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RailEvent" ADD CONSTRAINT "RailEvent_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionEntry" ADD CONSTRAINT "PositionEntry_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "StockPosition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

