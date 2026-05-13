-- Escrow v3: on-chain escrow transaction types
ALTER TYPE "TxType" ADD VALUE 'ESCROW_LOCK';
ALTER TYPE "TxType" ADD VALUE 'ESCROW_RELEASE';
ALTER TYPE "TxType" ADD VALUE 'ESCROW_REFUND';
