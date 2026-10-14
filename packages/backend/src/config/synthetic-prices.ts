/**
 * Synthetic test prices (Q9) — `SYNTHETIC_TEST_PRICES_USD`.
 *
 * Testnet assets have no market price (the oracle has none for Base Sepolia),
 * yet a daily limit must count every spend. On a testnet chain the operator
 * may therefore configure an explicit USD price per asset; anything not
 * configured is UNPRICED, and an unpriced spend is refused while a daily
 * limit applies (`services/policy/spend-pricing.ts`). These are NOT market
 * prices: values counted with them are marked `synthetic` wherever they are
 * stored, they never reach fee events, P&L or revenue (those use
 * `price.service.ts`, which never reads this variable), and production /
 * staging refuse to boot with the variable set at all (`env-guards.ts`).
 *
 * Format — comma-separated entries `chainId:asset=usd`:
 *
 *   SYNTHETIC_TEST_PRICES_USD=84532:native=2500,84532:0x036CbD53842c5426634e7929541eC2318f3dCF7e=1
 *
 *   chainId  a testnet chain (`TESTNET_CHAIN_IDS` in config/chains.ts — today
 *            only 84532, Base Sepolia); a mainnet chain is an error
 *   asset    `native` for the chain's native asset (ETH), or the token's
 *            EIP-55 checksummed address (a lowercase or mis-cased address is
 *            an error: the checksum catches a typo in an operator-typed
 *            address); the zero address is an error (use `native`)
 *   usd      USD per WHOLE unit (1 ETH, 1 USDC), a plain decimal > 0
 *            (`^\d+(\.\d+)?$`, no exponent, no sign)
 *
 * Duplicate entries are an error. Pure module: no env import, no I/O — the
 * boot check (`config/env.ts`) and the pricing module both call the parser.
 */
import { getAddress, zeroAddress } from 'viem';

export const SYNTHETIC_PRICES_ENV = 'SYNTHETIC_TEST_PRICES_USD';

/** The asset key of a chain's native asset (ETH on Base Sepolia). */
export const NATIVE_ASSET = 'native';

/** `chainId:native` or `chainId:<lowercased token address>` → USD per whole unit (plain decimal). */
export type SyntheticPriceTable = ReadonlyMap<string, string>;

export type SyntheticPricesParse = { ok: true; prices: SyntheticPriceTable } | { ok: false; errors: string[] };

const PRICE_PATTERN = /^\d+(\.\d+)?$/;
const ENTRY_PATTERN = /^(\d+):([^=\s]+)=(\S+)$/;

export function syntheticPriceKey(chainId: number, asset: string): string {
  return `${chainId}:${asset === NATIVE_ASSET ? NATIVE_ASSET : asset.toLowerCase()}`;
}

/**
 * Parses and validates the variable. Blank / unset = no synthetic prices.
 * `testnetChainIds` is passed in (config/chains.ts `TESTNET_CHAIN_IDS`) so
 * this module stays free of chain imports.
 */
export function parseSyntheticTestPrices(raw: string | undefined, testnetChainIds: readonly number[]): SyntheticPricesParse {
  const prices = new Map<string, string>();
  if (raw === undefined || raw.trim() === '') return { ok: true, prices };

  const errors: string[] = [];
  const allowed = testnetChainIds.join(', ') || '(none)';
  raw.split(',').forEach((part, index) => {
    const entry = part.trim();
    if (entry === '') {
      errors.push(`entry ${index + 1} is empty`);
      return;
    }
    const match = ENTRY_PATTERN.exec(entry);
    if (!match) {
      errors.push(`"${entry}" is not chainId:asset=usd`);
      return;
    }
    const [, chainText, asset, price] = match as unknown as [string, string, string, string];
    const chainId = Number(chainText);
    if (!testnetChainIds.includes(chainId)) {
      errors.push(`"${entry}": chain ${chainId} is not a testnet chain — synthetic prices are allowed only on ${allowed}`);
      return;
    }
    if (asset !== NATIVE_ASSET) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(asset)) {
        errors.push(`"${entry}": asset must be "${NATIVE_ASSET}" or a 0x token address`);
        return;
      }
      const checksummed = getAddress(asset.toLowerCase());
      if (checksummed === zeroAddress) {
        errors.push(`"${entry}": the zero address is not a token — use "${NATIVE_ASSET}" for the native asset`);
        return;
      }
      if (asset !== checksummed) {
        errors.push(`"${entry}": the address must be EIP-55 checksummed (${checksummed})`);
        return;
      }
    }
    if (!PRICE_PATTERN.test(price) || !/[1-9]/.test(price)) {
      errors.push(`"${entry}": the price must be a plain decimal greater than 0 (USD per whole unit)`);
      return;
    }
    const key = syntheticPriceKey(chainId, asset);
    if (prices.has(key)) {
      errors.push(`"${entry}": duplicate entry for ${key}`);
      return;
    }
    prices.set(key, price);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, prices };
}
