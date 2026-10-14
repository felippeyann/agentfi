import { z } from 'zod';
import { api, ApiError } from '../api-client.js';
import type { components } from '../api.generated.js';
import { pathIdSchema } from '../path-ids.js';
import { paymentTokenSymbols, resolvePaymentToken } from './token-map.js';

type Agent = components['schemas']['Agent'];
type TransferRequest = components['schemas']['TransferRequest'];
type TransactionAccepted = components['schemas']['TransactionAccepted'];
type PnLBreakdown = components['schemas']['PnLBreakdown'];
type PayResourceResponse = components['schemas']['PayResourceResponse'];
type Job = components['schemas']['Job'];
type CreateJobRequest = components['schemas']['CreateJobRequest'];

/** New paid jobs are USDC-only (decision D8); the backend has no default token. */
export const DEFAULT_REWARD_TOKEN = 'USDC';

/** A job id as it goes into a URL path (X3a; see path-ids.ts). */
const jobIdSchema = (description: string) => pathIdSchema('job', description);

/** An agent id as it goes into a URL path (S6; same rule as job ids). */
const agentIdSchema = (description: string) => pathIdSchema('agent', description);

/**
 * An input error found by a handler (a rule across fields), reported exactly
 * like a schema error: `code: INVALID_INPUT` with the issue path, before
 * anything reaches the backend.
 */
function invalidInput(path: string, message: string): z.ZodError {
  return new z.ZodError([{ code: z.ZodIssueCode.custom, path: [path], message }]);
}

/**
 * Backend refusals of `pay_for_resource` that carry structured data an agent
 * can act on (price vs. remaining budget, an unknown outcome to reconcile,
 * a refusal reason). Returned as tool output instead of thrown, so the
 * details are not flattened into an error string.
 */
const PAY_RESOURCE_STRUCTURED_CODES = new Set([
  'BUDGET_EXCEEDED',
  'PAYMENT_REFUSED',
  'PAYMENT_OUTCOME_UNKNOWN',
  'UNSUPPORTED_ASSET',
  'UNSUPPORTED_BUDGET_TOKEN',
  'PAYMENT_IN_PROGRESS',
  'OUTSTANDING_AUTHORIZATION',
  'POLICY_VIOLATION',
]);

export const agentTools = [
  {
    name: 'get_my_agent_profile',
    description:
      'Fetches this AgentFi agent profile using the configured API key. ' +
      'Use this to confirm the active identity, wallet, supported chains, tier, policy, and billing usage.',
    inputSchema: z.object({}),
    handler: async () => {
      const result = await api.get<Agent>('/v1/agents/me');
      return result;
    },
  },

  {
    name: 'get_my_pnl',
    description:
      'Fetches this agent\'s profit and loss breakdown. ' +
      'Use this to inspect A2A earnings, rewards paid, protocol fees, gas costs, net P&L, and breakeven status.',
    inputSchema: z.object({
      since: z
        .string()
        .datetime()
        .optional()
        .describe('Optional ISO timestamp for the beginning of the P&L period.'),
    }),
    handler: async (input: { since?: string }) => {
      const result = await api.get<PnLBreakdown>(
        '/v1/agents/me/pnl',
        input.since ? { since: input.since } : undefined,
      );
      return result;
    },
  },

  {
    name: 'search_agents',
    description:
      'Finds other agents by name or wallet address. Use this to discover potential agent-to-agent (A2A) partners ' +
      'for collaboration or payment. Returns a list of agents with their safeAddress and active chains.',
    inputSchema: z.object({
      query: z.string().min(2).describe('Search query (name or address)'),
    }),
    handler: async (input: { query: string }) => {
      const result = await api.get<{ agents: any[] }>(`/v1/agents/search?q=${encodeURIComponent(input.query)}`);
      return result;
    },
  },

  {
    name: 'pay_agent',
    description:
      'Pays another agent directly from your wallet (outside the job queue): a transfer of native ETH or of a known ' +
      'ERC-20 to the recipient\'s address (its safeAddress from search_agents), sent as POST /v1/transactions/transfer. ' +
      'Name the chain and the token: there is no default for either. token_symbol is "ETH" (native) or a symbol from ' +
      'the token registry of that chain (e.g. USDC on Base 8453 or Base Sepolia 84532); an unknown symbol is refused ' +
      'before anything is sent — to pay in any other ERC-20 use transfer_token with its contract address. Your ' +
      'operator policy applies like any transfer: the recipient must be in allowed_recipients and the call target ' +
      '(the recipient for ETH, the token contract for an ERC-20) in allowed_contracts when those lists are set, the ' +
      'token in allowed_tokens, native ETH under max_value_per_tx_eth, plus the daily volume limit and the cooldown; ' +
      'a refusal is a 403 with the reason, a high-value payment may wait for operator approval (status ' +
      'PENDING_APPROVAL). Pass an idempotency_key and reuse it when you retry, or a retry pays twice. `reason` is not ' +
      'sent to the backend (the transfer API has no such field): it is only echoed in this tool\'s result. Track the ' +
      'payment with get_transaction_status.',
    inputSchema: z.object({
      recipient_address: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte hex address')
        .describe('The address that receives the payment: the recipient agent\'s safeAddress (search_agents).'),
      amount: z
        .string()
        .regex(/^\d+(\.\d+)?$/, 'must be a plain decimal amount such as "1.5"')
        .describe('Amount in whole-token units as a plain decimal (e.g. "1.5" USDC, "0.01" ETH).'),
      token_symbol: z
        .string()
        .min(1)
        .describe(
          '"ETH" for native ETH, or a token symbol known on chain_id (e.g. "USDC"). Symbols only — not an address.',
        ),
      chain_id: z
        .number()
        .int()
        .positive()
        .describe('Chain the payment is made on (e.g. 84532 Base Sepolia, 8453 Base). No default.'),
      reason: z
        .string()
        .min(1)
        .max(500)
        .describe('Why you pay (max 500 characters). Echoed in the result only; not sent to or stored by the backend.'),
      idempotency_key: z
        .string()
        .regex(/^[A-Za-z0-9_-]{16,128}$/, 'must be 16-128 chars of [A-Za-z0-9_-]')
        .optional()
        .describe(
          'Idempotency key (16-128 chars of [A-Za-z0-9_-]). A retry with the same key returns the first payment ' +
            'instead of paying again.',
        ),
    }),
    handler: async (input: {
      recipient_address: string;
      amount: string;
      token_symbol: string;
      chain_id: number;
      reason: string;
      idempotency_key?: string;
    }) => {
      // X5: the route takes `to` and a token ADDRESS (or "ETH"); a symbol is
      // resolved here, from the registry only, never guessed.
      const token = resolvePaymentToken(input.token_symbol, input.chain_id);
      if (token === undefined) {
        throw invalidInput(
          'token_symbol',
          `unknown token symbol "${input.token_symbol}" on chain ${input.chain_id}: known symbols there are ` +
            `${paymentTokenSymbols(input.chain_id).join(', ')}. To pay in another ERC-20, use transfer_token with ` +
            'its contract address.',
        );
      }
      const body: TransferRequest = {
        to: input.recipient_address,
        token,
        amount: input.amount,
        chainId: input.chain_id,
        ...(input.idempotency_key !== undefined ? { idempotencyKey: input.idempotency_key } : {}),
      };
      const result = await api.post<TransactionAccepted>('/v1/transactions/transfer', body);

      return {
        ...result,
        payment: {
          to: input.recipient_address,
          amount: input.amount,
          token_symbol: input.token_symbol.trim().toUpperCase(),
          token,
          chain_id: input.chain_id,
        },
        reason: input.reason,
        next: 'Call get_transaction_status to track confirmation (PENDING_APPROVAL waits for the operator).',
      };
    },
  },

  {
    name: 'update_policy',
    description:
      'TIGHTENS the agent\'s own operational policy (lower per-transaction caps, narrower token/contract/recipient whitelists). ' +
      'The change applies IMMEDIATELY — there is no operator approval step. ' +
      'Units: max_value_per_tx_eth caps native ETH on ordinary transactions; max_value_per_tx_usd caps each USDC ' +
      'payment (pay_for_resource) and each escrowed job budget (post_job); max_outflow_per_tx_usd caps, in USD, each ' +
      'ordinary outflow (transfer, swap input, deposit, GMX collateral, batch, A2A payment). While your ' +
      'max_outflow_per_tx_usd is not configured (null), those outflows are refused with USD_CAP_NOT_CONFIGURED: only ' +
      'the operator can configure it. Lists: allowed_contracts are the contracts ' +
      'your transactions may call; allowed_recipients are the addresses that may RECEIVE value from you (transfer ' +
      'recipient, x402 payee, escrow provider). The USD caps and the recipient list are enforced by the backend only ' +
      '(not synced on-chain). ' +
      'This tool can ONLY tighten: the backend rejects any change that loosens the policy with 403 ' +
      '(raising max_value_per_tx_eth, max_value_per_tx_usd or max_outflow_per_tx_usd, or setting max_outflow_per_tx_usd ' +
      'while it is not configured; adding an address that is not already whitelisted, or clearing a whitelist). ' +
      'Loosening requires the operator credential (API_SECRET) — if you need higher limits or new whitelisted ' +
      'tokens/contracts/recipients to complete a mission, ask the operator instead of retrying. ' +
      'Provide a `reason` for audit — the backend writes it to its policy audit log line (it is not stored ' +
      'and does not gate the change).',
    inputSchema: z.object({
      max_value_per_tx_eth: z
        .string()
        // Same strict pattern as the backend (`POLICY_DECIMAL_PATTERN`): plain
        // decimal only — no "", "1e3", "0x10", " 5" or words; those are 400.
        .regex(/^\d+(\.\d+)?$/, 'must be a plain decimal string such as "0.5"')
        .optional()
        .describe('New max ETH per transaction as a plain decimal string (e.g. "0.5"). Must be <= the current limit.'),
      max_value_per_tx_usd: z
        .string()
        .regex(/^\d+(\.\d+)?$/, 'must be a plain decimal string such as "5"')
        .optional()
        .describe(
          'New max USD per USDC payment / escrowed job budget as a plain decimal string (e.g. "5"). Must be <= the current limit.',
        ),
      max_outflow_per_tx_usd: z
        .string()
        .regex(/^\d+(\.\d+)?$/, 'must be a plain decimal string such as "100"')
        .nullable()
        .optional()
        .describe(
          'New max USD per ordinary outflow (transfer, swap input, deposit, GMX collateral, batch, A2A payment) as a plain ' +
            'decimal string (e.g. "100"), or null to block those outflows. Must be <= the current limit; it cannot be set ' +
            'while not configured (the operator configures it).',
        ),
      allowed_tokens: z
        .array(z.string())
        .optional()
        .describe(
          'Replacement token whitelist. Must be a subset of the current whitelist; adding new tokens or clearing a non-empty whitelist requires the operator.',
        ),
      allowed_contracts: z
        .array(z.string())
        .optional()
        .describe(
          'Replacement contract whitelist. Must be a subset of the current whitelist; adding new contracts or clearing a non-empty whitelist requires the operator.',
        ),
      allowed_recipients: z
        .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte hex address'))
        .optional()
        .describe(
          'Replacement recipient whitelist (addresses that may receive value from you). Must be a subset of the current list; adding recipients or clearing a non-empty list requires the operator.',
        ),
      reason: z
        .string()
        .max(500)
        .describe('Justification for the change — sent to the backend and written to its policy audit log; does not gate the write.'),
    }),
    handler: async (input: {
      max_value_per_tx_eth?: string;
      max_value_per_tx_usd?: string;
      max_outflow_per_tx_usd?: string | null;
      allowed_tokens?: string[];
      allowed_contracts?: string[];
      allowed_recipients?: string[];
      reason: string;
    }) => {
      // Get current agent ID first
      const me = await api.get<{ id: string }>('/v1/agents/me');

      const result = await api.patch(`/v1/agents/${me.id}/policy`, {
        maxValuePerTxEth: input.max_value_per_tx_eth,
        maxValuePerTxUsd: input.max_value_per_tx_usd,
        // null is sent as null (block outflows); undefined is dropped by JSON (unchanged).
        maxOutflowPerTxUsd: input.max_outflow_per_tx_usd,
        allowedTokens: input.allowed_tokens,
        allowedContracts: input.allowed_contracts,
        allowedRecipients: input.allowed_recipients,
        reason: input.reason,
      });

      return {
        success: true,
        updatedPolicy: result,
        audit: `Policy updated by agent. Reason: ${input.reason}`,
      };
    },
  },

  {
    name: 'set_my_manifest',
    description:
      'Sets the agent\'s service manifest. Use this to broadcast your capabilities to other agents ' +
      '(e.g., "I provide risk analysis", "I offer liquidity data"). The manifest should be a structured JSON ' +
      'describing your services and their pricing/parameters.',
    inputSchema: z.object({
      manifest: z.record(z.any()).describe('JSON object describing provided services, tools, and pricing.'),
    }),
    handler: async (input: { manifest: Record<string, any> }) => {
      const result = await api.patch('/v1/agents/me/manifest', {
        manifest: input.manifest,
      });
      return result;
    },
  },

  {
    name: 'get_agent_manifest',
    description:
      'Fetches the service manifest of another agent by their ID. Use this to understand what ' +
      'services another agent provides before attempting a payment or collaboration.',
    inputSchema: z.object({
      agent_id: agentIdSchema('The ID of the agent to query.'),
    }),
    handler: async (input: { agent_id: string }) => {
      const result = await api.get(`/v1/agents/${input.agent_id}/manifest`);
      return result;
    },
  },

  {
    name: 'get_agent_trust_report',
    description:
      'Fetches the reputation and trust metrics of another agent. Use this to evaluate a peer\'s ' +
      'reliability (transaction count, age, reputation score) before collaborating.',
    inputSchema: z.object({
      agent_id: agentIdSchema('The ID of the agent to evaluate.'),
    }),
    handler: async (input: { agent_id: string }) => {
      const result = await api.get(`/v1/agents/${input.agent_id}/trust-report`);
      return result;
    },
  },

  {
    name: 'sign_handshake',
    description:
      'Signs an AgentFi handshake with your agent wallet, to prove your identity to another agent or to sign a ' +
      'service agreement. The wallet signs the EIP-712 envelope AgentFiHandshake{agent, message, issuedAt} (domain ' +
      '"AgentFi Handshake" v1) — never your text as raw bytes, so a handshake cannot be reused as a signature for ' +
      'anything else. Send the peer the returned message, issuedAt, signature and address: they need all four to ' +
      'verify (verify_handshake). typedData is the full envelope for any EIP-712 verifier.',
    inputSchema: z.object({
      message: z.string().min(1).max(4096).describe('The statement or agreement text to sign (max 4096 characters).'),
    }),
    handler: async (input: { message: string }) => {
      const result = await api.post('/v1/agents/me/sign-handshake', {
        message: input.message,
      });
      return result;
    },
  },

  {
    name: 'verify_handshake',
    description:
      'Verifies a handshake another agent produced with sign_handshake: checks that `address` signed the AgentFi ' +
      'envelope for exactly this message and issued_at (ECDSA for a wallet key, EIP-1271 for a smart-contract ' +
      'account). Returns { valid, address, verifiedVia }. A plain personal_sign of the message is NOT accepted. ' +
      'Check issued_at yourself if you need a fresh handshake.',
    inputSchema: z.object({
      message: z.string().min(1).max(4096).describe('The message the peer signed, exactly as returned by sign_handshake.'),
      issued_at: z
        .number()
        .int()
        .nonnegative()
        .describe('The issuedAt (unix seconds) returned with the peer\'s signature.'),
      signature: z
        .string()
        .regex(/^0x[0-9a-fA-F]+$/, 'must be a 0x hex signature')
        .describe('The signature hex string provided by the peer.'),
      address: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x address')
        .describe('The address the peer signed with (the `address` returned by its sign_handshake).'),
    }),
    handler: async (input: { message: string; issued_at: number; signature: string; address: string }) => {
      const result = await api.post('/v1/agents/verify-handshake', {
        message: input.message,
        issuedAt: input.issued_at,
        signature: input.signature,
        address: input.address,
      });
      return result;
    },
  },

  {
    name: 'post_job',
    description:
      'Hires another agent: posts a job (service request) for a service from its manifest. Omit reward_amount for a ' +
      'free job; a paid job needs reward_amount AND chain_id (there is no default chain) and pays in USDC unless you ' +
      'set reward_token (new jobs are USDC-only). ' +
      'On an escrow-enabled chain (e.g. Base Sepolia, 84532) the budget is escrowed on-chain from YOUR wallet ' +
      '(ERC-8183) and progress shows in escrow.onChainStatus (read it with get_job); the provider can accept only ' +
      'once it is FUNDED. When the provider completes, the evaluator settles: the provider is paid from the escrow ' +
      'and ERC-8004 reputation is written on-chain, unless you contest_job the deliverable first (it is then held for an ' +
      'operator decision: pay the provider or refund you). Your operator policy applies to the budget (USDC counted at ' +
      '1 USD: per-transaction cap, daily volume, token allowlist, the provider as an allowed payee, cooldown); a refusal ' +
      'is POLICY_VIOLATION with `rule`. ESCROW_CONFIG_UNVERIFIED (503) means the backend cannot verify the escrow ' +
      'contracts on that chain right now (e.g. its RPC is down): nothing was reserved; retry after retryAfterSeconds. ' +
      'Optionally sign the payload with sign_handshake first.',
    inputSchema: z.object({
      provider_id: agentIdSchema('The ID of the agent you are hiring.'),
      payload: z.record(z.any()).describe('The task details (e.g., input data, command).'),
      reward_amount: z
        .string()
        .regex(/^\d+(\.\d+)?$/, 'must be a plain decimal amount such as "1.5"')
        .optional()
        .describe('Amount you pay on completion, as a plain decimal (e.g. "1.5" USDC). Omit for a free job.'),
      chain_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Chain the reward is paid on; REQUIRED with reward_amount (e.g. 84532 Base Sepolia, 8453 Base). No default.',
        ),
      reward_token: z
        .string()
        .min(1)
        .optional()
        .describe('Reward token (default "USDC"). Escrow-enabled chains accept only USDC (ERC8183_USDC_ONLY).'),
      signature: z.string().optional().describe('Your signature of the payload (use sign_handshake).'),
    }),
    handler: async (input: {
      provider_id: string;
      payload: Record<string, any>;
      reward_amount?: string;
      chain_id?: number;
      reward_token?: string;
      signature?: string;
    }) => {
      const paid = input.reward_amount !== undefined;
      // X3a: refuse before the API is called. The backend used to default a
      // reward to Ethereum mainnet / ETH; it now refuses too, but an agent
      // should never get that far without naming the chain it pays on.
      if (paid && input.chain_id === undefined) {
        throw invalidInput(
          'chain_id',
          'required when reward_amount is set: name the chain the reward is paid on (e.g. 84532 for Base Sepolia, ' +
            '8453 for Base). There is no default chain.',
        );
      }
      if (!paid && (input.chain_id !== undefined || input.reward_token !== undefined)) {
        throw invalidInput(
          'reward_amount',
          'required when chain_id or reward_token is set: pass reward_amount for a paid job, or omit chain_id and ' +
            'reward_token for a free job.',
        );
      }
      const body: CreateJobRequest = {
        providerId: input.provider_id,
        payload: input.payload,
        ...(paid
          ? {
              reward: {
                amount: input.reward_amount as string,
                token: input.reward_token ?? DEFAULT_REWARD_TOKEN,
                chainId: input.chain_id as number,
              },
            }
          : {}),
        ...(input.signature !== undefined ? { signature: input.signature } : {}),
      };
      return api.post<Job>('/v1/jobs', body);
    },
  },

  {
    name: 'get_job',
    description:
      'Reads one job you posted or were hired for: status, payload, result and, for an escrowed job, the `escrow` ' +
      'object (onChainStatus CREATING → OPEN → BUDGET_SET → APPROVED → FUNDED → SUBMITTED → SETTLING → COMPLETED or ' +
      'REJECTED; CONTESTED while a contest waits for the operator; EXPIRED / FAILED; plus settleTxHash, feedbackStatus, ' +
      'contestedAt, resolution, escrowError). `escrow` is null for ' +
      'free and non-escrow jobs. Poll it to follow funding and settlement.',
    inputSchema: z.object({
      job_id: jobIdSchema('The ID of the job.'),
    }),
    handler: async (input: { job_id: string }) => api.get<Job>(`/v1/jobs/${input.job_id}`),
  },

  {
    name: 'check_outbox',
    description:
      'Lists the jobs you posted as requester (all statuses, newest first), each with its provider and, for an ' +
      'escrowed job, the `escrow` object. Use it to follow your paid jobs from funding to settlement; get_job reads one.',
    inputSchema: z.object({}),
    handler: async () => api.get<{ jobs: Job[] }>('/v1/jobs/outbox'),
  },

  {
    name: 'check_inbox',
    description:
      'Lists the jobs assigned to you as provider (all statuses, newest first), each with its requester and, for an ' +
      'escrowed job, the `escrow` object. Accept an escrowed job only once escrow.onChainStatus is FUNDED (the budget ' +
      'is locked on-chain); after you complete it you are paid when the evaluator settles (status COMPLETED).',
    inputSchema: z.object({}),
    handler: async () => api.get<{ jobs: Job[] }>('/v1/jobs/inbox'),
  },

  {
    name: 'update_job_status',
    description:
      'Moves a job you are part of to a new status. Provider: ACCEPTED (from PENDING), then COMPLETED with `result`, ' +
      'or FAILED; requester or provider: CANCELLED. On an escrowed job ACCEPTED is refused (409 ESCROW_NOT_FUNDED) ' +
      'until escrow.onChainStatus is FUNDED; COMPLETED moves the job to PAYMENT_PENDING and your wallet submits a hash ' +
      'of `result` on-chain (sent automatically later if your ERC-8004 identity is still being bound, ' +
      'escrow.deferredSubmitAt); payment arrives when the evaluator settles. CANCELLED / FAILED refund the requester. ' +
      'On an escrowed job COMPLETED / CANCELLED / FAILED answer ESCROW_CONFIG_UNVERIFIED (503) while the backend cannot ' +
      'verify the escrow contracts (nothing changed; retry after retryAfterSeconds).',
    inputSchema: z.object({
      job_id: jobIdSchema('The ID of the job to update.'),
      status: z.enum(['ACCEPTED', 'COMPLETED', 'FAILED', 'CANCELLED']).describe('The new status.'),
      result: z.record(z.any()).optional().describe('The output or proof of work (if completed).'),
    }),
    handler: async (input: {
      job_id: string;
      status: 'ACCEPTED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
      result?: Record<string, any>;
    }) => {
      const result = await api.patch<Job>(`/v1/jobs/${input.job_id}`, {
        status: input.status,
        result: input.result,
      });
      return result;
    },
  },

  {
    name: 'contest_job',
    description:
      'Disputes the deliverable of an escrowed job you posted (requester only) before the evaluator settles it. ' +
      'Allowed only while the job is PAYMENT_PENDING with escrow.onChainStatus SUBMITTED; once settlement has started, ' +
      'or from escrow.expiresAt minus the expiry margin (a few minutes) on, it is refused (409 CONTEST_NOT_ALLOWED). ' +
      'A contest does not refund automatically: the job is held for an operator ' +
      'decision (escrow.onChainStatus CONTESTED), who either pays the provider or refunds your budget in full, and only ' +
      'an explicit operator quality verdict records a negative ERC-8004 rating; unresolved at escrow.expiresAt, the ' +
      'budget is refunded without any rating. Cannot be withdrawn — read the result with get_job first.',
    inputSchema: z.object({
      job_id: jobIdSchema('The ID of the job you posted.'),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe('Why you reject the deliverable (max 500 characters); stored with the job.'),
    }),
    handler: async (input: { job_id: string; reason?: string }) =>
      api.post<Job>(`/v1/jobs/${input.job_id}/contest`, input.reason !== undefined ? { reason: input.reason } : {}),
  },

  {
    name: 'pay_for_resource',
    description:
      'Pays for an HTTP 402 (x402) resource — an API call, a dataset, a quote — while working on a job you ' +
      'ACCEPTED as provider, and returns the resource response. This SPENDS YOUR OWN USDC: the backend signs a ' +
      "USDC authorization with your wallet, capped by the job's remaining reward budget (reward minus everything " +
      'already paid or pending on that job) and by `max_amount` when you pass one. A price above the cap is refused ' +
      'BEFORE anything is signed (BUDGET_EXCEEDED, with `price` and `remaining`). Your operator policy applies too, ' +
      'also before signing (POLICY_VIOLATION with `rule`): the per-transaction limit read in USD for USDC, the daily ' +
      'volume, the token allowlist and, when set, the contract allowlist as the list of payees. Only USDC on the ' +
      "job's chain is accepted (UNSUPPORTED_ASSET otherwise). Idempotent per `payment_id`: calling again with the " +
      'same id returns the recorded payment instead of paying twice — always reuse the id when retrying; a ' +
      'concurrent call with the same id gets PAYMENT_IN_PROGRESS. A PAYMENT_OUTCOME_UNKNOWN result means a signed ' +
      'authorization reached the server but no settlement was confirmed: do NOT retry with a new id; the amount ' +
      'stays reserved against the job until an operator reconciles it. A PAYMENT_REFUSED result means the server ' +
      'refused the signed authorization but still holds it until it expires (at most 10 minutes, `countedUntil`): ' +
      'the amount stays counted until then and any new payment to that payee on the job is refused ' +
      '(OUTSTANDING_AUTHORIZATION) — retry after `countedUntil`.',
    inputSchema: z.object({
      job_id: jobIdSchema('The ID of the ACCEPTED job whose budget pays for the resource (you must be its provider).'),
      url: z.string().url().describe('Absolute http(s) URL of the 402 resource.'),
      method: z.enum(['GET', 'POST']).optional().describe('HTTP method (default GET).'),
      body: z.record(z.any()).optional().describe('JSON body for POST requests.'),
      max_amount: z
        .string()
        .regex(/^\d+(\.\d{1,6})?$/, 'must be a plain USDC amount such as "0.50"')
        .optional()
        .describe(
          'Your own cap for this payment in USDC (e.g. "0.50"). The lower of this and the remaining job budget applies.',
        ),
      payment_id: z
        .string()
        .regex(/^[A-Za-z0-9_-]{16,128}$/, 'must be 16-128 chars of [A-Za-z0-9_-]')
        .optional()
        .describe('Idempotency key (16-128 chars of [A-Za-z0-9_-]). Generated when omitted; reuse it on retries.'),
    }),
    handler: async (input: {
      job_id: string;
      url: string;
      method?: 'GET' | 'POST';
      body?: Record<string, any>;
      max_amount?: string;
      payment_id?: string;
    }) => {
      try {
        return await api.post<PayResourceResponse>(`/v1/jobs/${input.job_id}/pay-resource`, {
          url: input.url,
          method: input.method ?? 'GET',
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.max_amount !== undefined ? { maxAmount: input.max_amount } : {}),
          ...(input.payment_id !== undefined ? { paymentId: input.payment_id } : {}),
        });
      } catch (err) {
        // Typed refusals keep their structure (price, remaining, paymentId,
        // the ledger row) so the agent can decide what to do next.
        if (err instanceof ApiError && err.code && PAY_RESOURCE_STRUCTURED_CODES.has(err.code)) {
          return { paid: false, httpStatus: err.status, ...err.body };
        }
        throw err;
      }
    },
  },
];
