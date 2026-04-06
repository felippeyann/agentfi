/**
 * x402 Payment Required middleware — https://x402.org
 *
 * Implements the x402 protocol: the server responds 402 with a payment challenge
 * (network, asset, amount, payTo, nonce). The agent pays on-chain and re-sends
 * the request with an `X-Payment` header containing base64-encoded proof.
 *
 * Usage (apply to a specific route handler as preHandler):
 *
 *   import { requirePayment } from '../middleware/x402.middleware.js';
 *
 *   fastify.post('/v1/premium/action', { preHandler: requirePayment() }, async (req, reply) => {
 *     // Only reached after valid on-chain payment is verified
 *   });
 *
 * Feature flag: set X402_ENABLED=true to activate on guarded routes.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../db/client.js';
import { parseUnits, decodeEventLog, type Address } from 'viem';
import { randomUUID } from 'crypto';
import { createChainPublicClient } from '../../config/chains.js';

// Fee wallet that receives x402 micro-payments (reuses the protocol fee wallet)
const FEE_WALLET = (process.env['FEE_WALLET_ADDRESS'] ?? '0x0000000000000000000000000000000000000000') as Address;

// Access fee in USDC (human-readable, 2 decimal places)
const X402_FEE_USDC = process.env['X402_FEE_USDC'] ?? '1.00';

// Challenge validity window
const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Network name → chainId
const NETWORK_CHAIN_ID: Record<string, number> = {
  base:     8453,
  ethereum: 1,
  arbitrum: 42161,
  polygon:  137,
};

// USDC contract addresses per chainId (6 decimals)
const USDC_ADDRESS: Record<number, Address> = {
  1:     '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  8453:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  137:   '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
};

const ERC20_TRANSFER_ABI = [{
  type:   'event',
  name:   'Transfer',
  inputs: [
    { name: 'from',  type: 'address', indexed: true  },
    { name: 'to',    type: 'address', indexed: true  },
    { name: 'value', type: 'uint256', indexed: false },
  ],
}] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The 402 response body sent when no payment header is present. */
export interface X402Challenge {
  scheme:    'exact';
  network:   string;
  asset:     'USDC';
  amount:    string;   // human-readable, e.g. "1.00"
  payTo:     Address;
  nonce:     string;   // UUID — must be included in X-Payment proof
  expiresAt: string;   // ISO 8601
}

/** The JSON payload the client base64-encodes into the `X-Payment` header. */
export interface X402PaymentProof {
  nonce:   string;   // must match the nonce from the 402 challenge
  txHash:  string;   // on-chain transaction hash of the payment
  chainId: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Creates a new 402 challenge and persists its nonce to prevent replay.
 */
async function createChallenge(network: string): Promise<X402Challenge> {
  const nonce     = randomUUID();
  const chainId   = NETWORK_CHAIN_ID[network] ?? 8453;
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();

  await db.x402Nonce.create({ data: { nonce, chainId } });

  return {
    scheme:   'exact',
    network,
    asset:    'USDC',
    amount:   X402_FEE_USDC,
    payTo:    FEE_WALLET,
    nonce,
    expiresAt,
  };
}

/**
 * Verifies a payment proof on-chain:
 *   1. Nonce must exist and not be consumed yet.
 *   2. Transaction receipt must be successful.
 *   3. Receipt must contain a USDC Transfer(to=FEE_WALLET, value≥required) log.
 */
async function verifyPayment(
  proof: X402PaymentProof,
): Promise<{ valid: boolean; reason?: string }> {
  // 1. Nonce check
  const nonceRecord = await db.x402Nonce.findUnique({ where: { nonce: proof.nonce } });
  if (!nonceRecord) {
    return { valid: false, reason: 'Unknown nonce — request a new 402 challenge' };
  }
  if (nonceRecord.usedAt) {
    return { valid: false, reason: 'Nonce already consumed — request a new 402 challenge' };
  }

  const usdcAddress = USDC_ADDRESS[proof.chainId];
  if (!usdcAddress) {
    return { valid: false, reason: `Unsupported chainId: ${proof.chainId}` };
  }

  // 2. Fetch receipt
  const client = createChainPublicClient(proof.chainId);

  let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: proof.txHash as `0x${string}` });
  } catch {
    return { valid: false, reason: 'Transaction not found on-chain' };
  }

  if (!receipt || receipt.status !== 'success') {
    return { valid: false, reason: 'Transaction reverted or not yet confirmed' };
  }

  // 3. Find a USDC Transfer log to FEE_WALLET with sufficient amount
  const requiredAmount = parseUnits(X402_FEE_USDC, 6);
  let paid = false;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdcAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi:    ERC20_TRANSFER_ABI,
        data:   log.data,
        topics: log.topics,
      });
      if (
        decoded.eventName === 'Transfer' &&
        (decoded.args as { to?: Address }).to?.toLowerCase() === FEE_WALLET.toLowerCase() &&
        ((decoded.args as { value?: bigint }).value ?? 0n) >= requiredAmount
      ) {
        paid = true;
        break;
      }
    } catch {
      // not a Transfer log — skip
    }
  }

  if (!paid) {
    return {
      valid:  false,
      reason: `No USDC transfer of ≥${X402_FEE_USDC} to fee wallet found in transaction`,
    };
  }

  // Mark nonce as used — prevents replay attacks
  await db.x402Nonce.update({
    where: { nonce: proof.nonce },
    data:  { usedAt: new Date() },
  });

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Exported middleware factory
// ---------------------------------------------------------------------------

/**
 * Returns a Fastify preHandler that enforces x402 payment on the route.
 *
 * When X402_ENABLED env var is not "true", the middleware is a no-op so it
 * can be applied unconditionally and toggled via config.
 *
 * @param network  Payment network ("base" | "ethereum" | "arbitrum" | "polygon")
 */
export function requirePayment(network = 'base') {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Feature flag — disabled by default; set X402_ENABLED=true to activate
    if (process.env['X402_ENABLED'] !== 'true') return;

    const paymentHeader = request.headers['x-payment'];

    // No payment header → issue 402 challenge
    if (!paymentHeader || typeof paymentHeader !== 'string') {
      const challenge = await createChallenge(network);
      reply.code(402).send(challenge);
      return;
    }

    // Parse proof from base64-encoded JSON
    let proof: X402PaymentProof;
    try {
      const decoded = Buffer.from(paymentHeader, 'base64').toString('utf-8');
      proof = JSON.parse(decoded) as X402PaymentProof;
    } catch {
      const challenge = await createChallenge(network);
      reply.code(402).send({ ...challenge, error: 'Invalid X-Payment header: expected base64-encoded JSON' });
      return;
    }

    // Verify on-chain
    const result = await verifyPayment(proof);
    if (!result.valid) {
      const challenge = await createChallenge(network);
      reply.code(402).send({ ...challenge, error: result.reason });
      return;
    }

    // Payment verified — fall through to route handler
  };
}
