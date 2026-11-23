/**
 * When may the operator trust a receipt? A payment is `confirmed` only when its block satisfies the
 * chain's confirmation rule AND is still canonical; until then the answer stays `pending` with the
 * transaction hash and the block it was seen in, and can be asked again at any time.
 *
 * Rules:
 *   inclusion   one block includes it. Only on a local Anvil chain (31337): the local demo's behaviour.
 *   finalized   its block number is ≤ the node's `finalized` block (`eth_getBlockByNumber("finalized")`).
 *               On QDay Aevum Testnet (cdk-erigon, a validium) the `finalized` block is the last block
 *               whose batch was verified on L1 (it equals the last `zkevm_isBlockConsolidated` block;
 *               read on 2026-11-19: about 3,700 blocks ≈ 62 minutes behind the head, 1 s blocks).
 *               Default on every chain except 31337.
 *   depth:N     an operational choice, not a protocol guarantee: confirmations = head − inclusion block + 1
 *               (the block that includes the payment counts as 1; head = `eth_blockNumber` at the time
 *               of the check) and the payment is confirmed when confirmations ≥ N.
 *
 * Canonical check, on every rule: the receipt is read again by transaction hash (a node only returns
 * receipts of canonical blocks) and the block at that height must have the receipt's block hash. A
 * payment whose block left the canonical chain is not confirmed; the reconciliation then finds the
 * transaction again (mempool or re-mined) or rebroadcasts the SAME signed bytes, never new ones.
 */
import type { Hex, TransactionReceipt } from 'viem';
import { publicClientFor, type ChainConfig } from './chain.js';

export type ConfirmRule = { kind: 'inclusion' } | { kind: 'finalized' } | { kind: 'depth'; blocks: number };

export const LOCAL_ANVIL_CHAIN_ID = 31337;

export function parseConfirmRule(s: string): ConfirmRule {
  const v = s.trim();
  if (v === 'inclusion') return { kind: 'inclusion' };
  if (v === 'finalized') return { kind: 'finalized' };
  const m = /^depth:(\d{1,6})$/.exec(v);
  if (m && Number(m[1]) >= 1) return { kind: 'depth', blocks: Number(m[1]) };
  throw new Error(`INVOICE_CONFIRMATION must be "finalized", "depth:N" (N ≥ 1) or "inclusion" (local Anvil only); got "${s}"`);
}

/** The rule in force for a chain: explicit, or `inclusion` on local Anvil and `finalized` everywhere else. */
export function ruleFor(cfg: ChainConfig): ConfirmRule {
  return cfg.confirm ?? (cfg.chainId === LOCAL_ANVIL_CHAIN_ID ? { kind: 'inclusion' } : { kind: 'finalized' });
}

export function describeRule(rule: ConfirmRule): string {
  switch (rule.kind) {
    case 'inclusion':
      return 'inclusion (one block; local Anvil only)';
    case 'finalized':
      return 'finalized (the block is at or below the node\'s "finalized" block)';
    case 'depth':
      return `depth:${rule.blocks} (head − inclusion block + 1 ≥ ${rule.blocks}; an operational choice)`;
  }
}

export interface Finality {
  final: boolean;
  /** Is the receipt's block still the canonical block at that height? */
  canonical: boolean;
  blockNumber: bigint;
  blockHash: Hex;
  head: bigint;
  /** head − blockNumber + 1 */
  confirmations: bigint;
  /** The node's finalized block, under the `finalized` rule. */
  finalizedBlock?: bigint;
  /** Plain-language state, for answers and the operator. */
  detail: string;
}

/** Judges a receipt (already read by hash) against the rule. RPC errors are thrown, never read as "final" or "not final". */
export async function judgeFinality(cfg: ChainConfig, receipt: TransactionReceipt): Promise<Finality> {
  const rule = ruleFor(cfg);
  const client = publicClientFor(cfg);
  const [atHeight, head] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlockNumber({ cacheTime: 0 })]);
  const canonical = atHeight.hash === receipt.blockHash;
  const confirmations = head - receipt.blockNumber + 1n;
  const base = { canonical, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, head, confirmations };
  if (!canonical) {
    return { ...base, final: false, detail: `block ${receipt.blockNumber} changed (the receipt says ${receipt.blockHash}, the chain now has ${atHeight.hash}): not final, checked again` };
  }
  switch (rule.kind) {
    case 'inclusion':
      return { ...base, final: true, detail: `included in block ${receipt.blockNumber} (rule: inclusion, local Anvil)` };
    case 'depth': {
      const final = confirmations >= BigInt(rule.blocks);
      return { ...base, final, detail: `included in block ${receipt.blockNumber}; ${confirmations} of ${rule.blocks} confirmations (head ${head})` };
    }
    case 'finalized': {
      const fin = await client.getBlock({ blockTag: 'finalized' });
      const final = receipt.blockNumber <= fin.number;
      return {
        ...base,
        final,
        finalizedBlock: fin.number,
        detail: final
          ? `included in block ${receipt.blockNumber}, at or below the finalized block ${fin.number}`
          : `included in block ${receipt.blockNumber}, not finalized yet: the node's finalized block is ${fin.number} (${receipt.blockNumber - fin.number} blocks to go; head ${head})`,
      };
    }
  }
}

export function explorerTx(cfg: ChainConfig, hash: string): string | undefined {
  return cfg.explorerUrl ? `${cfg.explorerUrl.replace(/\/$/, '')}/tx/${hash}` : undefined;
}
