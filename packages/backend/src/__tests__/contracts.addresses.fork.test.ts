/**
 * S7 — identity of the configured third-party contracts, read from mainnet
 * FORKS (Anvil `--fork-url`, read-only: nothing is sent). Opt-in: skipped
 * unless the fork RPCs are given —
 *
 *   anvil --fork-url https://mainnet.base.org --port 8546
 *   anvil --fork-url https://arb1.arbitrum.io/rpc --port 8547
 *   S7_FORK_RPC_8453=http://127.0.0.1:8546 S7_FORK_RPC_42161=http://127.0.0.1:8547 \
 *     npx vitest run src/__tests__/contracts.addresses.fork.test.ts
 *
 * It reads the addresses the backend actually uses (`getContracts`,
 * `UNISWAP_V3_QUOTER_V2`, `GMX_CONTRACTS`, `GMX_MARKETS`) and checks more than
 * "there is code": each contract answers a view that binds it to its
 * protocol (the Pool's provider is the provider, the quoter's factory is the
 * Uniswap factory, the GMX vault / router belong to GMX's RoleStore and
 * DataStore, the market is registered in the DataStore), and the calls the
 * routes make (getPool, quoteExactInputSingle, the GMX order calldata) are
 * made the same way, through viem's address checks.
 */
import { describe, expect, it } from 'vitest';
import { createPublicClient, getAddress, http, parseAbi, parseUnits, type Address } from 'viem';
import * as contracts from '../config/contracts.js';
import { GMX_CONTRACTS, GMX_MARKETS } from '../services/defi/gmx.service.js';
import { TransactionBuilder } from '../services/transaction/builder.service.js';

const BASE_RPC = process.env['S7_FORK_RPC_8453'];
const ARB_RPC = process.env['S7_FORK_RPC_42161'];

const describeBase = BASE_RPC ? describe : describe.skip;
const describeArb = ARB_RPC ? describe : describe.skip;

// Third-party references the checks compare against (sources: config/contracts.ts).
const BASE_AAVE_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'; // aave-address-book AaveV3Base.POOL
const BASE_UNISWAP_V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'; // docs.uniswap.org Base deployments
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const GMX_ROLE_STORE = '0x3c3d99FD298f679DBC2CEcd132b4eC4d0F5e6e72'; // gmx-synthetics deployments/arbitrum/RoleStore.json
const GMX_DATA_STORE = '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8'; // deployments/arbitrum/DataStore.json
const GMX_READER = '0x470fbC46bcC0f16532691Df360A07d8Bf5ee0789'; // deployments/arbitrum/Reader.json
const WBTC_ARB = '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f';
const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
/** keccak256(abi.encode("ROUTER_PLUGIN")) — gmx-synthetics Role.sol. */
const ROUTER_PLUGIN = '0xc82e6cc76072f8edb32d42796e58e13ab6e145524eb6b36c073be82f20d410f3';

describeBase('S7 on a Base mainnet fork', () => {
  const client = createPublicClient({ transport: http(BASE_RPC) });
  const base = contracts.getContracts(8453);

  it('is a fork of Base (chain 8453)', async () => {
    expect(await client.getChainId()).toBe(8453);
  });

  it('aavePoolAddressProvider: getPool() — the call the deposit / withdraw routes make — is the Aave V3 Base Pool, whose provider is this one', async () => {
    const pool = await client.readContract({
      address: base.aavePoolAddressProvider,
      abi: parseAbi(['function getPool() view returns (address)']),
      functionName: 'getPool',
    });
    expect(pool).toBe(BASE_AAVE_POOL);
    const back = await client.readContract({
      address: pool,
      abi: parseAbi(['function ADDRESSES_PROVIDER() view returns (address)']),
      functionName: 'ADDRESSES_PROVIDER',
    });
    expect(back).toBe(base.aavePoolAddressProvider);
  });

  it('the swap route\'s QuoterV2 and config uniswapV3Quoter: Uniswap V3 Base factory, and a real WETH → USDC quote', async () => {
    const quoters = (contracts as Record<string, unknown>)['UNISWAP_V3_QUOTER_V2'] as Record<number, Address> | undefined;
    const quoter = quoters?.[8453];
    expect(quoter).toBe(base.uniswapV3Quoter);
    const factory = await client.readContract({
      address: quoter as Address,
      abi: parseAbi(['function factory() view returns (address)']),
      functionName: 'factory',
    });
    expect(factory).toBe(BASE_UNISWAP_V3_FACTORY);
    const { result } = await client.simulateContract({
      address: quoter as Address,
      abi: parseAbi([
        'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
      ]),
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: WETH_BASE, tokenOut: USDC_BASE, amountIn: parseUnits('1', 18), fee: 500, sqrtPriceLimitX96: 0n }],
    });
    // A live market quote (any sane ETH price): more than 100 USDC for 1 WETH.
    expect(result[0]).toBeGreaterThan(100_000_000n);
  });
});

describeArb('S7 on an Arbitrum One fork', () => {
  const client = createPublicClient({ transport: http(ARB_RPC) });
  const arb = contracts.getContracts(42161);
  const bank = parseAbi(['function roleStore() view returns (address)', 'function dataStore() view returns (address)']);

  it('is a fork of Arbitrum One (chain 42161)', async () => {
    expect(await client.getChainId()).toBe(42161);
  });

  it('gmxOrderVault belongs to GMX (its RoleStore and DataStore)', async () => {
    expect(await client.readContract({ address: arb.gmxOrderVault!, abi: bank, functionName: 'roleStore' })).toBe(GMX_ROLE_STORE);
    expect(await client.readContract({ address: arb.gmxOrderVault!, abi: bank, functionName: 'dataStore' })).toBe(GMX_DATA_STORE);
  });

  it('gmxRouter belongs to GMX\'s RoleStore, and is the router the configured ExchangeRouter uses', async () => {
    expect(await client.readContract({ address: arb.gmxRouter!, abi: bank, functionName: 'roleStore' })).toBe(GMX_ROLE_STORE);
    const router = await client.readContract({
      address: arb.gmxExchangeRouter!,
      abi: parseAbi(['function router() view returns (address)']),
      functionName: 'router',
    });
    expect(router).toBe(arb.gmxRouter);
  });

  it('every GMX market label resolves to a market registered in GMX\'s DataStore (BTC/USD: WBTC index and long, USDC short)', async () => {
    const reader = parseAbi([
      'function getMarket(address dataStore, address key) view returns ((address marketToken, address indexToken, address longToken, address shortToken))',
    ]);
    for (const [label, { marketToken }] of Object.entries(GMX_MARKETS)) {
      const market = await client.readContract({ address: GMX_READER, abi: reader, functionName: 'getMarket', args: [GMX_DATA_STORE, marketToken] });
      expect(market.marketToken, label).toBe(marketToken);
    }
    const btc = await client.readContract({
      address: GMX_READER, abi: reader, functionName: 'getMarket', args: [GMX_DATA_STORE, GMX_MARKETS['BTC/USD']!.marketToken],
    });
    expect([btc.longToken, btc.shortToken]).toEqual([WBTC_ARB, USDC_ARB]);
  });

  it('the GMX open calldata (the call that threw) now encodes; the configured ExchangeRouter is NOT a GMX router plugin (finding: GMX orders cannot execute)', async () => {
    const builder = new TransactionBuilder();
    const tx = builder.buildGmxCreateOrder({
      exchangeRouter: arb.gmxExchangeRouter!,
      orderVault: arb.gmxOrderVault!,
      market: GMX_MARKETS['ETH/USD']!.marketToken,
      initialCollateralToken: getAddress(USDC_ARB),
      sizeDeltaUsd: 10n ** 31n,
      initialCollateralDeltaAmount: 5_000_000n,
      acceptablePrice: 10n ** 34n,
      executionFee: 10n ** 14n,
      isLong: true,
      orderType: 'MarketIncrease',
      receiver: '0x000000000000000000000000000000000000dEaD',
    });
    expect(tx.to).toBe(arb.gmxExchangeRouter);
    // The 2023 ExchangeRouter in config/contracts.ts no longer holds ROUTER_PLUGIN
    // (nor CONTROLLER): Router.pluginTransfer — sendTokens — reverts for it.
    // GMX stays fail-closed (simulation 422) until the integration is updated;
    // see the PR. This assertion pins that finding so a change is noticed.
    const isPlugin = await client.readContract({
      address: GMX_ROLE_STORE,
      abi: parseAbi(['function hasRole(address account, bytes32 roleKey) view returns (bool)']),
      functionName: 'hasRole',
      args: [arb.gmxExchangeRouter!, ROUTER_PLUGIN],
    });
    expect(isPlugin).toBe(false);
    expect(GMX_CONTRACTS[42161]?.exchangeRouter).toBe(arb.gmxExchangeRouter);
  });
});
