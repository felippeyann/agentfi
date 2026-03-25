/**
 * Uniswap Routing Service
 *
 * Uses Uniswap's hosted Routing API v2 instead of @uniswap/smart-order-router.
 * Same result (optimal route, calldata), zero SDK dependency weight.
 *
 * API docs: https://docs.uniswap.org/api/routing-api/overview
 */

const ROUTING_API = 'https://api.uniswap.org/v2/quote';

// SwapRouter02 addresses per chain
const SWAP_ROUTER: Record<number, string> = {
  1: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',      // Ethereum
  8453: '0x2626664c2603336E57B271c5C0b26F421741e481',   // Base
  42161: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',  // Arbitrum
  137: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',    // Polygon
};

export interface QuoteResult {
  amountOut: string;           // human-readable output amount
  amountOutRaw: string;        // raw output in token base units
  priceImpact: string;         // e.g. "0.12"
  gasEstimate: string;
  calldata: string;
  routerAddress: string;
  value: string;               // ETH value to send (for ETH-in swaps)
}

export class UniswapService {
  /**
   * Gets a swap quote from Uniswap Routing API.
   * Returns the best route and calldata ready for submission.
   */
  async getQuote(params: {
    fromToken: string;    // address or "ETH"
    toToken: string;      // address or "ETH"
    amountIn: string;     // in human-readable units e.g. "1.5"
    fromDecimals: number;
    toDecimals: number;
    chainId: number;
    slippageTolerance?: number;  // percentage, default 0.5
    recipient: string;
  }): Promise<QuoteResult> {
    const slippage = (params.slippageTolerance ?? 0.5).toString();
    const amountInRaw = this.toRawAmount(params.amountIn, params.fromDecimals);

    const body = {
      tokenInChainId: params.chainId,
      tokenOutChainId: params.chainId,
      tokenIn: params.fromToken,
      tokenOut: params.toToken,
      amount: amountInRaw,
      type: 'EXACT_INPUT',
      recipient: params.recipient,
      slippageTolerance: slippage,
      deadline: Math.floor(Date.now() / 1000 + 1800).toString(),
      configs: [
        {
          routingType: 'CLASSIC',
          recipient: params.recipient,
          slippageTolerance: slippage,
          deadline: Math.floor(Date.now() / 1000 + 1800),
          enableUniversalRouter: true,
        },
      ],
    };

    const res = await fetch(ROUTING_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Uniswap Routing API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      quote: {
        quoteDecimals: string;
        quoteGasAdjustedDecimals: string;
        priceImpact: string;
        gasUseEstimate: string;
        methodParameters?: {
          calldata: string;
          value: string;
          to: string;
        };
      };
    };

    const q = data.quote;
    const routerAddress = q.methodParameters?.to ?? SWAP_ROUTER[params.chainId] ?? SWAP_ROUTER[1]!;

    return {
      amountOut: q.quoteDecimals,
      amountOutRaw: this.toRawAmount(q.quoteDecimals, params.toDecimals),
      priceImpact: q.priceImpact,
      gasEstimate: q.gasUseEstimate,
      calldata: q.methodParameters?.calldata ?? '',
      routerAddress,
      value: q.methodParameters?.value ?? '0x0',
    };
  }

  /**
   * Converts human-readable amount to raw integer string (no decimals).
   * e.g. "1.5" with 18 decimals → "1500000000000000000"
   */
  private toRawAmount(amount: string, decimals: number): string {
    const [integer, fraction = ''] = amount.split('.');
    const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
    const raw = BigInt(integer + paddedFraction);
    return raw.toString();
  }
}

export const uniswapService = new UniswapService();
