-- Migration: 0026_c3g_evaluator_transactions
-- Purpose (plan task C3g, option A1; spec 2026-10-21-spec-c3g-a1.md §2.3 + R2):
--   every transaction signed with the evaluator key becomes a row, written as
--   SIGNED before its first byte is sent, in the same database transaction as
--   the job stamp. The chain (receipts, nonce consumed by consensus of the RPC
--   nodes) decides which candidate of a nonce mined; nothing is closed by
--   time. Recovery incidents carry the script's durable budget; the chain
--   state row carries the persisted alert clocks (alertedAt written only after
--   delivery), the proof-tag head tracking and per-node failure counters.
--   Only additive: no existing column changes, no backfill in SQL (the legacy
--   backfill needs the RPC and runs in the worker).
--   ON DELETE RESTRICT to Job and to the incident: a row that may have moved
--   money never disappears with them (test cleanups delete these tables
--   first).
--   Invariants that Prisma 5 cannot declare are CHECK constraints and a
--   partial unique index here; `prisma migrate diff` does not compare them.

-- CreateTable
CREATE TABLE "EvaluatorRecoveryIncident" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "evaluator" TEXT NOT NULL,
    "headNonce" INTEGER NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedBy" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,

    CONSTRAINT "EvaluatorRecoveryIncident_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EvaluatorRecoveryIncident_evaluator_check" CHECK ("evaluator" ~ '^0x[0-9a-fA-F]{40}$'),
    CONSTRAINT "EvaluatorRecoveryIncident_headNonce_check" CHECK ("headNonce" >= 0),
    CONSTRAINT "EvaluatorRecoveryIncident_close_check" CHECK (("closedAt" IS NULL) = ("closeReason" IS NULL))
);

-- CreateTable
CREATE TABLE "EvaluatorTransaction" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "evaluator" TEXT NOT NULL,
    "nonce" INTEGER,
    "jobId" TEXT,
    "kind" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "decision" TEXT,
    "reasonHex" TEXT,
    "replacesId" TEXT,
    "toAddress" TEXT,
    "valueWei" TEXT NOT NULL,
    "calldata" TEXT,
    "calldataHash" TEXT,
    "gasLimit" TEXT,
    "maxFeePerGas" TEXT,
    "maxPriorityFeePerGas" TEXT,
    "txHash" TEXT NOT NULL,
    "rawTx" TEXT,
    "origin" TEXT NOT NULL,
    "operator" TEXT,
    "note" TEXT,
    "incidentId" TEXT,
    "status" TEXT NOT NULL,
    "proofLevel" TEXT,
    "sendError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "broadcastAt" TIMESTAMP(3),
    "lastBroadcastAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "minedBlockNumber" TEXT,
    "minedBlockHash" TEXT,

    CONSTRAINT "EvaluatorTransaction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EvaluatorTransaction_status_check" CHECK ("status" IN ('SIGNED', 'SENT', 'SEND_UNCONFIRMED', 'MINED_SUCCESS', 'MINED_REVERTED', 'DEAD')),
    CONSTRAINT "EvaluatorTransaction_kind_check" CHECK ("kind" IN ('ORIGINAL', 'SPEED_UP', 'CANCEL', 'EXTERNAL', 'LEGACY')),
    CONSTRAINT "EvaluatorTransaction_action_check" CHECK ("action" IN ('COMPLETE', 'REJECT', 'CLAIM_REFUND', 'CANCEL_NOOP', 'UNKNOWN')),
    CONSTRAINT "EvaluatorTransaction_origin_check" CHECK ("origin" IN ('WORKER', 'SCRIPT', 'BACKFILL', 'RECONCILE')),
    -- R2-P2-2: a proof level exactly on MINED_* / DEAD; a mined row names its block.
    CONSTRAINT "EvaluatorTransaction_proofLevel_check" CHECK (
        ("proofLevel" IS NULL OR "proofLevel" IN ('latest', 'proof'))
        AND (("status" IN ('MINED_SUCCESS', 'MINED_REVERTED', 'DEAD')) = ("proofLevel" IS NOT NULL))
        AND ("status" NOT IN ('MINED_SUCCESS', 'MINED_REVERTED') OR ("minedBlockNumber" IS NOT NULL AND "minedBlockHash" IS NOT NULL))
    ),
    -- §10-2: only a backfilled LEGACY row may lack the nonce (and then the tx data).
    CONSTRAINT "EvaluatorTransaction_nonce_check" CHECK (
        ("nonce" IS NULL OR "nonce" >= 0)
        AND ("nonce" IS NOT NULL OR "kind" = 'LEGACY')
        AND ("nonce" IS NULL OR ("toAddress" IS NOT NULL AND "calldata" IS NOT NULL AND "calldataHash" IS NOT NULL
                                 AND "gasLimit" IS NOT NULL AND "maxFeePerGas" IS NOT NULL AND "maxPriorityFeePerGas" IS NOT NULL))
    ),
    CONSTRAINT "EvaluatorTransaction_format_check" CHECK (
        "evaluator" ~ '^0x[0-9a-fA-F]{40}$'
        AND "txHash" ~ '^0x[0-9a-f]{64}$'
        AND ("calldataHash" IS NULL OR "calldataHash" ~ '^0x[0-9a-f]{64}$')
        AND ("minedBlockHash" IS NULL OR "minedBlockHash" ~ '^0x[0-9a-f]{64}$')
        AND ("toAddress" IS NULL OR "toAddress" ~ '^0x[0-9a-fA-F]{40}$')
        AND "valueWei" ~ '^[0-9]+$'
        AND ("gasLimit" IS NULL OR "gasLimit" ~ '^[0-9]+$')
        AND ("maxFeePerGas" IS NULL OR "maxFeePerGas" ~ '^[0-9]+$')
        AND ("maxPriorityFeePerGas" IS NULL OR "maxPriorityFeePerGas" ~ '^[0-9]+$')
        AND ("minedBlockNumber" IS NULL OR "minedBlockNumber" ~ '^[0-9]+$')
    ),
    -- §3.2: a cancel is a 0-value self-transfer of 21 000 gas with no data; it never settles anything.
    CONSTRAINT "EvaluatorTransaction_cancel_check" CHECK (
        ("kind" <> 'CANCEL' OR ("action" = 'CANCEL_NOOP' AND "calldata" = '0x' AND "valueWei" = '0'
                                AND "gasLimit" = '21000' AND lower("toAddress") = lower("evaluator")))
        AND ("action" <> 'CANCEL_NOOP' OR "kind" = 'CANCEL')
    ),
    -- §3.1: a speed-up names the candidate it replaces.
    CONSTRAINT "EvaluatorTransaction_speedup_check" CHECK ("kind" <> 'SPEED_UP' OR "replacesId" IS NOT NULL),
    -- §8.4: a script row names its operator and the incident whose budget it spends.
    CONSTRAINT "EvaluatorTransaction_script_check" CHECK ("origin" <> 'SCRIPT' OR ("operator" IS NOT NULL AND "incidentId" IS NOT NULL))
);

-- CreateTable
CREATE TABLE "EvaluatorChainState" (
    "chainId" INTEGER NOT NULL,
    "evaluator" TEXT NOT NULL,
    "stuckSince" TIMESTAMP(3),
    "stuckNonce" INTEGER,
    "sendLostSince" TIMESTAMP(3),
    "sendLostNonce" INTEGER,
    "lastAlertAt" JSONB NOT NULL DEFAULT '{}',
    "safeHeadBlock" TEXT,
    "safeHeadSeenAt" TIMESTAMP(3),
    "rpcFailures" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluatorChainState_pkey" PRIMARY KEY ("chainId","evaluator"),
    CONSTRAINT "EvaluatorChainState_check" CHECK (
        "evaluator" ~ '^0x[0-9a-fA-F]{40}$'
        AND ("stuckNonce" IS NULL OR "stuckNonce" >= 0)
        AND ("sendLostNonce" IS NULL OR "sendLostNonce" >= 0)
        AND ("safeHeadBlock" IS NULL OR "safeHeadBlock" ~ '^[0-9]+$')
        AND jsonb_typeof("lastAlertAt") = 'object'
        AND jsonb_typeof("rpcFailures") = 'object'
    )
);

-- CreateIndex
CREATE INDEX "EvaluatorRecoveryIncident_chainId_evaluator_openedAt_idx" ON "EvaluatorRecoveryIncident"("chainId", "evaluator", "openedAt");

-- At most one open incident per evaluator key (partial; SQL only).
CREATE UNIQUE INDEX "EvaluatorRecoveryIncident_open_key" ON "EvaluatorRecoveryIncident"("chainId", "evaluator") WHERE "closedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "EvaluatorTransaction_chainId_txHash_key" ON "EvaluatorTransaction"("chainId", "txHash");

-- CreateIndex
CREATE INDEX "EvaluatorTransaction_chainId_evaluator_nonce_idx" ON "EvaluatorTransaction"("chainId", "evaluator", "nonce");

-- CreateIndex
CREATE INDEX "EvaluatorTransaction_jobId_status_idx" ON "EvaluatorTransaction"("jobId", "status");

-- CreateIndex
CREATE INDEX "EvaluatorTransaction_chainId_evaluator_origin_createdAt_idx" ON "EvaluatorTransaction"("chainId", "evaluator", "origin", "createdAt");

-- CreateIndex
CREATE INDEX "EvaluatorTransaction_incidentId_idx" ON "EvaluatorTransaction"("incidentId");

-- AddForeignKey
ALTER TABLE "EvaluatorTransaction" ADD CONSTRAINT "EvaluatorTransaction_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluatorTransaction" ADD CONSTRAINT "EvaluatorTransaction_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "EvaluatorRecoveryIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
