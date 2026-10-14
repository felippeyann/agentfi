/**
 * Batch calldata classification (Q9, owner decision "only authorised
 * contracts", 2026-10-14).
 *
 * `POST /v1/transactions/batch` forwards raw calldata. While the agent's
 * policy has a daily limit, every action carrying calldata must be one the
 * backend can account for, or one the operator explicitly authorised:
 *
 *   policy-sync      the target is the agent chain's own `AgentPolicyModule`
 *                    (the admin SyncPolicyButton's on-chain policy sync):
 *                    allowed, nothing counted;
 *   erc20-transfer   the calldata is EXACTLY `transfer(to, amount)` or
 *                    `transferFrom(from, to, amount)` — selector plus a strict
 *                    canonical ABI encoding (length and every padding byte
 *                    checked by re-encoding) — so the token is the action's
 *                    target, the amount is priced like any other spend and
 *                    counted, `to` is checked against `allowedRecipients` and
 *                    the token against `allowedTokens`;
 *   other            anything else, `approve` and unknown selectors included:
 *                    allowed only when `allowedContracts` is non-empty AND
 *                    lists the target (the operator authorised that contract;
 *                    its calldata stays uncounted by design — authorisation
 *                    replaces accounting), otherwise refused
 *                    (`UNACCOUNTED_CALL`).
 *
 * Without a daily limit none of this applies (nothing to count) and the batch
 * behaves as before. Native value keeps A6's rule in the route.
 */
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, toFunctionSelector, type Address, type Hex } from 'viem';

export type BatchCalldataClass =
  | { kind: 'none' }
  | { kind: 'policy-sync' }
  | { kind: 'erc20-transfer'; fn: 'transfer' | 'transferFrom'; token: Address; to: Address; amount: bigint; from?: Address }
  | { kind: 'other'; selector: Hex };

export const ERC20_TRANSFER_SELECTOR = toFunctionSelector('transfer(address,uint256)');
export const ERC20_TRANSFER_FROM_SELECTOR = toFunctionSelector('transferFrom(address,address,uint256)');

/** `transfer` / `transferFrom` calldata in its one canonical encoding, or null. */
export function decodeStrictErc20Transfer(
  data: Hex,
): { fn: 'transfer'; to: Address; amount: bigint } | { fn: 'transferFrom'; from: Address; to: Address; amount: bigint } | null {
  const selector = data.slice(0, 10).toLowerCase();
  const expectedLength = selector === ERC20_TRANSFER_SELECTOR ? 2 + 8 + 64 * 2 : selector === ERC20_TRANSFER_FROM_SELECTOR ? 2 + 8 + 64 * 3 : -1;
  if (expectedLength < 0 || data.length !== expectedLength) return null;
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data });
    if (decoded.functionName !== 'transfer' && decoded.functionName !== 'transferFrom') return null;
    // Re-encoding must give the input back byte for byte: dirty address
    // padding (viem reads the low 20 bytes only) or any other non-canonical
    // form is refused rather than guessed.
    const reencoded = encodeFunctionData({ abi: erc20Abi, functionName: decoded.functionName, args: decoded.args as never });
    if (reencoded.toLowerCase() !== data.toLowerCase()) return null;
    if (decoded.functionName === 'transfer') {
      const [to, amount] = decoded.args as readonly [Address, bigint];
      return { fn: 'transfer', to: getAddress(to), amount };
    }
    const [from, to, amount] = decoded.args as readonly [Address, Address, bigint];
    return { fn: 'transferFrom', from: getAddress(from), to: getAddress(to), amount };
  } catch {
    return null;
  }
}

export function classifyBatchCalldata(
  action: { to: string; data: string },
  ctx: { policyModule?: string | undefined },
): BatchCalldataClass {
  const data = action.data as Hex;
  if (data.length <= 2) return { kind: 'none' };
  if (ctx.policyModule && action.to.toLowerCase() === ctx.policyModule.toLowerCase()) return { kind: 'policy-sync' };
  const transfer = decodeStrictErc20Transfer(data);
  if (transfer) {
    return transfer.fn === 'transfer'
      ? { kind: 'erc20-transfer', fn: 'transfer', token: getAddress(action.to), to: transfer.to, amount: transfer.amount }
      : { kind: 'erc20-transfer', fn: 'transferFrom', token: getAddress(action.to), to: transfer.to, amount: transfer.amount, from: transfer.from };
  }
  return { kind: 'other', selector: data.slice(0, 10).toLowerCase() as Hex };
}
