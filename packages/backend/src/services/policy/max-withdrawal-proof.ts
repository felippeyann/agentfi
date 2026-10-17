/**
 * A "max" withdrawal outside the outflow count — only on proof (plan §5
 * question 7, owner rule 2026-10-14).
 *
 * D15 / Q9: a withdrawal of `max` (`maxUint256`: "everything I have there")
 * has no amount to price, so while a daily limit applies it is refused
 * (`503 PRICE_UNAVAILABLE`). The owner's rule: it may proceed WITHOUT being
 * counted only when the backend PROVES that it returns the funds to the
 * agent's own wallet and that nothing else leaves or is authorised — no
 * native value, no approve, a single call, every recipient / receiver / owner
 * argument equal to the sender — and only to a trusted protocol contract.
 *
 * The proof reads the transaction the backend BUILT (target, calldata, value)
 * and the address it is SENT from — never the route's intent:
 *   - value exactly 0;
 *   - the target is exactly one of the chain's trusted withdraw contracts
 *     (`resolveTrustedWithdrawTargets`): the Aave V3 Pool that the configured
 *     PoolAddressesProvider (`config/contracts.ts`) reports, or the configured
 *     Compound V3 Comet. Nothing the agent chose (an ERC-4626 vault is never
 *     trusted: arbitrary code called by the agent's wallet can pull any
 *     allowance the wallet ever gave it, or act on `tx.origin`; a calldata
 *     proof says nothing about what that code does);
 *   - the calldata is, byte for byte, the canonical encoding of that
 *     protocol's withdraw (selector, exact length, every padding byte —
 *     checked by re-encoding, as `batch-calldata.ts` does for ERC-20):
 *       Aave V3   `withdraw(address asset, uint256 amount, address to)` with
 *                 `amount = maxUint256` and `to` = the sender. The Pool burns
 *                 the SENDER's aTokens and sends the underlying to `to`;
 *       Comet     `withdraw(address asset, uint256 amount)` with
 *                 `amount = maxUint256`. Comet withdraws from and to
 *                 `msg.sender` (= the sender); for the base asset `max` is the
 *                 supplied balance (never a borrow), for a collateral asset it
 *                 reverts (`safe128`). `withdrawTo` / `withdrawFrom` /
 *                 anything else is refused;
 *   - a single call: no executor routing, no batch (an executor or batch
 *     target is not a trusted withdraw contract, so it never matches).
 * Anything else is "not proven" and keeps D15's refusal. Explicit amounts are
 * not handled here: they are priced and counted as before.
 */
import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddress,
  maxUint256,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { getContracts } from '../../config/contracts.js';
import { createChainPublicClient } from '../../config/chains.js';
import { unknownAmountSpend, type SpendPricing } from './spend-pricing.js';

export type WithdrawProtocol = 'aave-v3' | 'compound-v3';

/** A protocol contract a max withdrawal may target to be proven. */
export interface TrustedWithdrawTarget {
  protocol: WithdrawProtocol;
  address: Address;
}

/** The marker stored on the Transaction (`metadata.volumeExemption`) when the proof holds. */
export interface VolumeExemption {
  rule: 'max-withdrawal-to-own-wallet';
  protocol: WithdrawProtocol;
  /** The trusted contract called. */
  target: Address;
  /** The asset withdrawn (from the calldata). */
  asset: Address;
  /** Where the funds go: always the sender (the agent's own wallet). */
  recipient: Address;
}

export type MaxWithdrawalProof = { proven: true; exemption: VolumeExemption } | { proven: false; reason: string };

const AAVE_V3_WITHDRAW_ABI = [
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const COMET_WITHDRAW_ABI = [
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

export const AAVE_V3_WITHDRAW_SELECTOR = toFunctionSelector('withdraw(address,uint256,address)');
export const COMET_WITHDRAW_SELECTOR = toFunctionSelector('withdraw(address,uint256)');

/** Hex characters of a canonical encoding: "0x" + selector + 32-byte words. */
const canonicalLength = (words: number) => 2 + 8 + 64 * words;

function refuse(reason: string): MaxWithdrawalProof {
  return { proven: false, reason };
}

function isZeroValue(value: bigint | string | number): boolean {
  try {
    return BigInt(value) === 0n;
  } catch {
    return false;
  }
}

/**
 * Proves (or not) that `tx`, sent from `from`, is a max withdrawal from a
 * trusted protocol contract that returns everything to `from` and does nothing
 * else. Pure: the trusted targets are resolved by the caller
 * (`resolveTrustedWithdrawTargets`).
 */
export function proveMaxWithdrawalToSelf(params: {
  /** The address the transaction is signed and sent from (the job's `from`). */
  from: string;
  /** The exact transaction the backend built and enqueues. */
  tx: { to: string; data: string; value: bigint | string | number };
  trusted: readonly TrustedWithdrawTarget[];
}): MaxWithdrawalProof {
  const { from, tx, trusted } = params;
  if (!isAddress(from, { strict: false }) || from.toLowerCase() === zeroAddress) return refuse('the sender is not a valid address');
  const sender = getAddress(from);
  if (!isZeroValue(tx.value)) return refuse('the transaction carries native value');
  if (!isAddress(tx.to, { strict: false })) return refuse('the target is not a valid address');

  const matches = trusted.filter((t) => t.address.toLowerCase() === tx.to.toLowerCase());
  if (matches.length === 0) return refuse(`the target ${getAddress(tx.to)} is not a trusted protocol contract on this chain`);
  if (new Set(matches.map((t) => t.protocol)).size > 1) return refuse(`the target ${getAddress(tx.to)} is configured for more than one protocol`);
  const target = matches[0]!;

  if (typeof tx.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(tx.data)) return refuse('the calldata is not hex');
  // Hex case carries no meaning on-chain; decode the lowercase form.
  const data = tx.data.toLowerCase() as Hex;

  if (target.protocol === 'aave-v3') {
    if (data.slice(0, 10) !== AAVE_V3_WITHDRAW_SELECTOR || data.length !== canonicalLength(3)) {
      return refuse('the calldata is not exactly Aave V3 Pool.withdraw(asset, amount, to)');
    }
    let asset: Address;
    let amount: bigint;
    let to: Address;
    try {
      const decoded = decodeFunctionData({ abi: AAVE_V3_WITHDRAW_ABI, data });
      [asset, amount, to] = decoded.args as readonly [Address, bigint, Address];
      // Byte for byte: dirty address padding (viem reads only the low 20
      // bytes) or any other non-canonical form is refused, not guessed.
      if (encodeFunctionData({ abi: AAVE_V3_WITHDRAW_ABI, functionName: 'withdraw', args: [asset, amount, to] }).toLowerCase() !== data) {
        return refuse('the Aave withdraw calldata is not canonically encoded');
      }
    } catch {
      return refuse('the Aave withdraw calldata does not decode');
    }
    if (amount !== maxUint256) return refuse('the amount is not max');
    if (asset.toLowerCase() === zeroAddress) return refuse('the asset is the zero address');
    if (getAddress(to) !== sender) return refuse(`the withdrawal is sent to ${getAddress(to)}, not to the sender ${sender}`);
    return {
      proven: true,
      exemption: { rule: 'max-withdrawal-to-own-wallet', protocol: 'aave-v3', target: getAddress(target.address), asset: getAddress(asset), recipient: sender },
    };
  }

  // compound-v3: withdraw(asset, amount) — from and to msg.sender, no recipient argument.
  if (data.slice(0, 10) !== COMET_WITHDRAW_SELECTOR || data.length !== canonicalLength(2)) {
    return refuse('the calldata is not exactly Compound V3 Comet.withdraw(asset, amount)');
  }
  let asset: Address;
  let amount: bigint;
  try {
    const decoded = decodeFunctionData({ abi: COMET_WITHDRAW_ABI, data });
    [asset, amount] = decoded.args as readonly [Address, bigint];
    if (encodeFunctionData({ abi: COMET_WITHDRAW_ABI, functionName: 'withdraw', args: [asset, amount] }).toLowerCase() !== data) {
      return refuse('the Comet withdraw calldata is not canonically encoded');
    }
  } catch {
    return refuse('the Comet withdraw calldata does not decode');
  }
  if (amount !== maxUint256) return refuse('the amount is not max');
  if (asset.toLowerCase() === zeroAddress) return refuse('the asset is the zero address');
  return {
    proven: true,
    exemption: { rule: 'max-withdrawal-to-own-wallet', protocol: 'compound-v3', target: getAddress(target.address), asset: getAddress(asset), recipient: sender },
  };
}

const AAVE_PROVIDER_ABI = [
  { name: 'getPool', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;

/** Reads `IPoolAddressesProvider.getPool()`. Injectable for tests. */
export type AavePoolReader = (chainId: number, provider: Address) => Promise<string>;

/** The chain's public client reading `getPool()` — also the allowances route's source of the Pool (S12). */
export const readAavePoolOnChain: AavePoolReader = async (chainId, provider) =>
  createChainPublicClient(chainId).readContract({ address: provider, abi: AAVE_PROVIDER_ABI, functionName: 'getPool' });

/**
 * The chain's trusted withdraw contracts, from `config/contracts.ts` only:
 * the configured Compound V3 Comet, and the Aave V3 Pool as the configured
 * PoolAddressesProvider reports it now. A missing, zero or malformed entry —
 * or a provider that cannot be read — contributes nothing (fail closed: no
 * exemption without a trusted target).
 */
export async function resolveTrustedWithdrawTargets(
  chainId: number,
  readAavePool: AavePoolReader = readAavePoolOnChain,
): Promise<TrustedWithdrawTarget[]> {
  let contracts: ReturnType<typeof getContracts>;
  try {
    contracts = getContracts(chainId);
  } catch {
    return [];
  }
  const trusted: TrustedWithdrawTarget[] = [];
  try {
    const comet = contracts.compoundCometUsdc;
    if (comet && comet.toLowerCase() !== zeroAddress) trusted.push({ protocol: 'compound-v3', address: getAddress(comet) });
  } catch {
    // A malformed configured address (e.g. a bad EIP-55 checksum, plan S7) is not trusted.
  }
  try {
    const provider = contracts.aavePoolAddressProvider;
    if (provider && provider.toLowerCase() !== zeroAddress) {
      const pool = await readAavePool(chainId, getAddress(provider));
      if (isAddress(pool, { strict: false }) && pool.toLowerCase() !== zeroAddress) {
        trusted.push({ protocol: 'aave-v3', address: getAddress(pool) });
      }
    }
  } catch {
    // Provider unreadable or malformed: the Aave pool is not trusted for this decision.
  }
  return trusted;
}

/** Q9's refusal reason for a max withdrawal (shared with the routes). */
export const MAX_AMOUNT_UNPRICED =
  'A "max" withdrawal moves an amount that is only known once it executes, so it cannot be priced in advance; ' +
  'pass an explicit amount';

/**
 * The spend pricing of a max withdrawal the backend built: nothing to count
 * (`zero`) with the exemption marker when the proof holds; otherwise
 * unpriced, which D15 refuses while a daily limit applies.
 *
 * #180 review (P1): the proof is made against the address that SIGNS the
 * transaction — the wallet provider's address for the agent's `walletId`,
 * i.e. the EVM `msg.sender` the protocol pays (Comet) or whose position it
 * burns (Aave) — and only when that address IS the agent's own wallet
 * (`Agent.safeAddress`). In Safe mode `safeAddress` is the Safe while its
 * owner EOA signs, so the funds would land on the EOA: no exemption. A signer
 * that cannot be resolved gets none either (fail closed).
 */
export async function maxWithdrawalPricing(
  params: {
    chainId: number;
    /** The agent's own wallet (`Agent.safeAddress`): where the funds must return. */
    agentWallet: string;
    /** The address that signs and sends the transaction; null when the wallet provider could not resolve it. */
    signer: string | null;
    tx: { to: string; data: string; value: bigint | string | number };
  },
  readAavePool?: AavePoolReader,
): Promise<{ pricing: SpendPricing; exemption: VolumeExemption | null }> {
  const notProven = (reason: string) => ({
    pricing: unknownAmountSpend(`${MAX_AMOUNT_UNPRICED} (it is not proven to return only to the agent's own wallet: ${reason})`),
    exemption: null,
  });
  if (!params.signer || !isAddress(params.signer, { strict: false })) {
    return notProven('the address that signs it could not be resolved from the wallet provider');
  }
  if (!isAddress(params.agentWallet, { strict: false }) || params.signer.toLowerCase() !== params.agentWallet.toLowerCase()) {
    return notProven(
      `it is signed by ${getAddress(params.signer)}, not by the agent's wallet ${params.agentWallet} (Safe mode) — ` +
        'the protocol pays the signer',
    );
  }
  const trusted = await resolveTrustedWithdrawTargets(params.chainId, readAavePool);
  const proof = proveMaxWithdrawalToSelf({ from: params.signer, tx: params.tx, trusted });
  if (proof.proven) return { pricing: { status: 'zero' }, exemption: proof.exemption };
  return notProven(proof.reason);
}
